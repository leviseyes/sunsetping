import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CHECKOUT_PLAN_LABEL } from "../src/pages.js";
import { CHECKOUT_PRICES, CHECKOUT_SUCCESS_URL } from "../src/stripe.js";
import worker from "../src/worker.js";
import { createDb, testEnv, withFetch } from "./fixtures.js";

const SECRET = "whsec_test_secret";
const LINK = "https://buy.stripe.com/test_placeholder";

async function sign(payload, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { header: `t=${timestamp},v1=${hex}`, timestamp };
}

function post(body, header, env) {
  return worker.fetch(new Request("https://sunsetping.com/api/stripe/webhook", {
    method: "POST",
    headers: header ? { "stripe-signature": header, "content-type": "application/json" } : { "content-type": "application/json" },
    body,
  }), env);
}

function checkoutEvent(id, email, extra = {}) {
  return {
    id,
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_123",
        subscription: "sub_123",
        customer_details: { email },
        payment_status: "paid",
        metadata: { plan: "pro_monthly" },
        ...extra,
      },
    },
  };
}

test("webhook verifies the Stripe signature and activates Pro", async () => {
  const db = createDb({
    subscribers: [{
      id: 7,
      email: "ada@sunset.test",
      location: "Denver, Colorado",
      lat: 39.7,
      lon: -104.9,
      tz: "America/Denver",
      plan: "free",
      status: "active",
      unsubscribe_token: "ab".repeat(32),
      score_threshold: null,
      sunrise_alerts: 0,
      day_before: 0,
      lead_minutes: 180,
    }],
  });
  const env = testEnv(db, { STRIPE_WEBHOOK_SECRET: SECRET });
  const event = checkoutEvent("evt_paid", "Ada@Sunset.test");
  const body = JSON.stringify(event);
  const { header } = await sign(body);
  const res = await post(body, header, env);
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.received, true);
  assert.equal(payload.created, false);
  assert.equal(payload.email, "ada@sunset.test");
  const row = db.state.subscribers[0];
  assert.equal(row.plan, "pro");
  assert.equal(row.location, "Denver, Colorado");
  assert.equal(row.stripe_customer_id, "cus_123");
  assert.equal(row.stripe_subscription_id, "sub_123");

  const again = await post(body, header, env);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).duplicate, true);
  assert.equal(db.state.stripeEvents.length, 1);
  assert.equal(db.state.subscribers.length, 1);
});

test("webhook creates a subscriber when the email is new", async () => {
  const db = createDb();
  const env = testEnv(db, { STRIPE_WEBHOOK_SECRET: SECRET });
  const body = JSON.stringify(checkoutEvent("evt_new", "new@sunset.test"));
  const { header } = await sign(body);
  const res = await post(body, header, env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).created, true);
  const row = db.state.subscribers[0];
  assert.equal(row.email, "new@sunset.test");
  assert.equal(row.plan, "pro");
  assert.equal(row.location, "Add a location");
  assert.equal(row.lat, null);
  assert.equal(row.unsubscribe_token.length, 64);
});

test("webhook rejects a bad signature, a stale timestamp, and a missing secret", async () => {
  const db = createDb();
  const body = JSON.stringify(checkoutEvent("evt_bad", "ada@sunset.test"));
  const { header } = await sign(body);
  const tampered = await post(body.replace("ada@sunset.test", "other@sunset.test"), header, testEnv(db, { STRIPE_WEBHOOK_SECRET: SECRET }));
  assert.equal(tampered.status, 400);
  assert.match(await tampered.text(), /Invalid signature/);
  const staleStamp = Math.floor(Date.now() / 1000) - 301;
  const stale = await sign(body, SECRET, staleStamp);
  const old = await post(body, stale.header, testEnv(db, { STRIPE_WEBHOOK_SECRET: SECRET }));
  assert.equal(old.status, 400);
  const open = await post(body, header, testEnv(db));
  assert.equal(open.status, 500);
  assert.match(await open.text(), /not configured/);
  const get = await worker.fetch(new Request("https://sunsetping.com/api/stripe/webhook"), testEnv(db, { STRIPE_WEBHOOK_SECRET: SECRET }));
  assert.equal(get.status, 405);
  assert.equal(db.state.subscribers.length, 0);
  assert.equal(db.state.stripeEvents.length, 0);
});

test("subscription updates downgrade canceled or unpaid plans and keep past_due", async () => {
  const db = createDb({
    subscribers: [{
      id: 3,
      email: "ada@sunset.test",
      location: "Denver, Colorado",
      plan: "pro",
      status: "active",
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_123",
      unsubscribe_token: "cd".repeat(32),
    }],
  });
  const env = testEnv(db, { STRIPE_WEBHOOK_SECRET: SECRET });
  async function send(id, type, status) {
    const event = { id, type, data: { object: { id: "sub_123", customer: "cus_123", status } } };
    const body = JSON.stringify(event);
    const { header } = await sign(body);
    const res = await post(body, header, env);
    assert.equal(res.status, 200);
    return res.json();
  }
  await send("evt_past_due", "customer.subscription.updated", "past_due");
  assert.equal(db.state.subscribers[0].plan, "pro");
  await send("evt_unpaid", "customer.subscription.updated", "unpaid");
  assert.equal(db.state.subscribers[0].plan, "free");
  db.state.subscribers[0].plan = "pro";
  await send("evt_deleted", "customer.subscription.deleted", "canceled");
  assert.equal(db.state.subscribers[0].plan, "free");
  await send("evt_active", "customer.subscription.updated", "active");
  assert.equal(db.state.subscribers[0].plan, "pro");
});

test("a failed invoice is logged and does not change the plan", async () => {
  const db = createDb({
    subscribers: [{ id: 3, email: "ada@sunset.test", location: "Denver, Colorado", plan: "pro", status: "active", stripe_customer_id: "cus_123", stripe_subscription_id: "sub_123", unsubscribe_token: "cd".repeat(32) }],
  });
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    const event = { id: "evt_invoice", type: "invoice.payment_failed", data: { object: { customer: "cus_123", subscription: "sub_123", customer_email: "ada@sunset.test" } } };
    const body = JSON.stringify(event);
    const { header } = await sign(body);
    const res = await post(body, header, testEnv(db, { STRIPE_WEBHOOK_SECRET: SECRET }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).logged, true);
  } finally {
    console.log = orig;
  }
  assert.equal(db.state.subscribers[0].plan, "pro");
  assert.match(logs.join("\n"), /invoice_payment_failed/);
  assert.match(logs.join("\n"), /ada@sunset.test/);
});

test("an unpaid checkout does not grant Pro", async () => {
  const db = createDb();
  const body = JSON.stringify(checkoutEvent("evt_unpaid_checkout", "ada@sunset.test", { payment_status: "unpaid" }));
  const { header } = await sign(body);
  const res = await post(body, header, testEnv(db, { STRIPE_WEBHOOK_SECRET: SECRET }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ignored, "unpaid");
  assert.equal(db.state.subscribers.length, 0);
  assert.equal(db.state.stripeEvents.length, 1);
});

test("checkout.session.completed matches customer_email and customer_details.email", async () => {
  const subscriber = {
    id: 7,
    email: "ada@sunset.test",
    location: "Denver, Colorado",
    plan: "free",
    status: "active",
    unsubscribe_token: "ab".repeat(32),
  };
  const fromDetails = createDb({ subscribers: [{ ...subscriber }] });
  const detailsBody = JSON.stringify(checkoutEvent("evt_details", "ada@sunset.test", {
    customer_email: "other@sunset.test",
  }));
  const detailsSigned = await sign(detailsBody);
  const details = await post(detailsBody, detailsSigned.header, testEnv(fromDetails, { STRIPE_WEBHOOK_SECRET: SECRET }));
  assert.equal(details.status, 200);
  assert.equal((await details.json()).email, "ada@sunset.test");
  assert.equal(fromDetails.state.subscribers[0].plan, "pro");
  assert.equal(fromDetails.state.subscribers.length, 1);

  const fromEmail = createDb({ subscribers: [{ ...subscriber, plan: "free" }] });
  const emailBody = JSON.stringify(checkoutEvent("evt_customer_email", "ignored@sunset.test", {
    customer_details: null,
    customer_email: "Ada@Sunset.test",
  }));
  const emailSigned = await sign(emailBody);
  const emailed = await post(emailBody, emailSigned.header, testEnv(fromEmail, { STRIPE_WEBHOOK_SECRET: SECRET }));
  assert.equal(emailed.status, 200);
  assert.equal((await emailed.json()).email, "ada@sunset.test");
  assert.equal(fromEmail.state.subscribers[0].plan, "pro");
});

test("checkout redirects add prefilled_email when the address is known", async () => {
  const env = testEnv(createDb(), { STRIPE_PAYMENT_LINK_MONTHLY: LINK, STRIPE_PAYMENT_LINK_YEARLY: LINK });
  const go = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly&email=Ada@Sunset.test"), env);
  assert.equal(go.status, 302);
  const loc = new URL(go.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, LINK);
  assert.equal(loc.searchParams.get("prefilled_email"), "ada@sunset.test");
  const plain = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly&email=not-an-email"), env);
  assert.equal(plain.headers.get("location"), LINK);
  const home = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const pro = readFileSync(new URL("../public/pro.js", import.meta.url), "utf8");
  assert.match(home, /searchParams\.set\("email"/);
  assert.match(pro, /searchParams\.set\("email"/);
  const migration = readFileSync(new URL("../migrations/0003_stripe.sql", import.meta.url), "utf8");
  for (const name of ["stripe_customer_id", "stripe_subscription_id", "stripe_events"]) {
    assert.match(migration, new RegExp(name));
  }
});

test("a secret key opens a Checkout Session and a Stripe error falls back to the Payment Link", async () => {
  const KEY = "rk_test_checkout_sessions_only";
  const session = "https://checkout.stripe.com/c/pay/cs_test_sunset";
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ id: "cs_test_sunset", url: session });
  }, async () => {
    const env = testEnv(createDb(), { STRIPE_SECRET_KEY: KEY, STRIPE_PAYMENT_LINK_YEARLY: LINK });
    const res = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly&email=Ada@Sunset.test", {
      headers: { referer: "https://www.sunsetping.com/sunset/sedona?q=1" },
    }), env);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), session);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.headers["content-type"], "application/x-www-form-urlencoded");
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(form.get("mode"), "subscription");
  assert.equal(form.get("line_items[0][price]"), CHECKOUT_PRICES.yearly);
  assert.equal(form.get("line_items[0][quantity]"), "1");
  assert.equal(form.get("customer_email"), "ada@sunset.test");
  assert.equal(form.get("success_url"), CHECKOUT_SUCCESS_URL);
  assert.equal(form.get("cancel_url"), "https://sunsetping.com/sunset/sedona?q=1&canceled=1");
  assert.equal(form.get("allow_promotion_codes"), "true");

  calls.length = 0;
  await withFetch(async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ url: session });
  }, async () => {
    const env = testEnv(createDb(), { STRIPE_SECRET_KEY: KEY });
    const monthly = await worker.fetch(new Request("https://evil.example/api/checkout?plan=monthly&email=not-an-email", {
      headers: { referer: "https://evil.example/phish" },
    }), env);
    assert.equal(monthly.status, 303);
    assert.equal(monthly.headers.get("location"), session);
  });
  const monthlyForm = new URLSearchParams(calls[0].init.body);
  assert.equal(monthlyForm.get("line_items[0][price]"), CHECKOUT_PRICES.monthly);
  assert.equal(monthlyForm.get("customer_email"), null);
  assert.equal(monthlyForm.get("cancel_url"), "https://sunsetping.com/pro?canceled=1");
  assert.equal(monthlyForm.get("success_url"), "https://sunsetping.com/pro?welcome=1");

  await withFetch(async () => new Response("nope", { status: 500 }), async () => {
    const env = testEnv(createDb(), { STRIPE_SECRET_KEY: KEY, STRIPE_PAYMENT_LINK_MONTHLY: LINK });
    const fallback = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly&email=ada@sunset.test"), env);
    assert.equal(fallback.status, 302);
    const loc = new URL(fallback.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, LINK);
    assert.equal(loc.searchParams.get("prefilled_email"), "ada@sunset.test");
    const placeholder = await worker.fetch(
      new Request("https://sunsetping.com/api/checkout?plan=yearly"),
      testEnv(createDb(), { STRIPE_SECRET_KEY: KEY }),
    );
    assert.equal(placeholder.status, 200);
    assert.match(await placeholder.text(), /No charge was made/);
  });

  const pro = readFileSync(new URL("../public/pro.js", import.meta.url), "utf8");
  assert.match(pro, /No worries\. Nothing was charged\./);

  const callsForBots = [];
  await withFetch(async (url) => {
    callsForBots.push(String(url));
    return Response.json({ id: "cs_test_bot", url: session });
  }, async () => {
    const botEnv = testEnv(createDb(), { STRIPE_SECRET_KEY: KEY, STRIPE_PAYMENT_LINK_MONTHLY: LINK });
    const crawlers = [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      "facebookexternalhit/1.1",
      "Slackbot-LinkExpanding 1.0",
      "Twitterbot/1.0",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "WhatsApp/2.23.20.0 A",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36",
      "ExampleCrawler/1.0",
      "ExampleSpider/1.0",
      "LinkPreview/1.0",
      "bot/1.0",
    ];
    for (const ua of crawlers) {
      const bot = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
        headers: { "user-agent": ua },
      }), botEnv);
      assert.equal(bot.status, 302, ua);
      assert.equal(new URL(bot.headers.get("location")).pathname, "/pro", ua);
    }
    const browserUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const prefetch = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": browserUa, "sec-purpose": "prefetch" },
    }), botEnv);
    assert.equal(prefetch.status, 302);
    assert.equal(new URL(prefetch.headers.get("location")).pathname, "/pro");
    const purpose = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": browserUa, purpose: "prefetch" },
    }), botEnv);
    assert.equal(purpose.status, 302);
    assert.equal(callsForBots.length, 0, callsForBots.join("\n"));

    const realNav = {
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "accept-language": "en-US,en;q=0.9",
    };
    const browser = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": browserUa, ...realNav },
    }), botEnv);
    assert.equal(browser.status, 303);
    assert.equal(browser.headers.get("location"), session);
    const curl = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": "curl/8.7.1" },
    }), botEnv);
    assert.equal(curl.status, 303);
    assert.equal(curl.headers.get("location"), session);
    const phone = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: {
        "user-agent": "Mozilla/5.0 (Linux; Android 11; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
        ...realNav,
      },
    }), botEnv);
    assert.equal(phone.status, 303);
    assert.equal(phone.headers.get("location"), session);
    const anonymous = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly"), botEnv);
    assert.equal(anonymous.status, 303);
    assert.equal(anonymous.headers.get("location"), session);
    const inApp = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/2.23.20.0" },
    }), botEnv);
    assert.equal(inApp.status, 303);
    assert.equal(inApp.headers.get("location"), session);
  });
  assert.equal(callsForBots.length, 5);
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /STRIPE_SECRET_KEY/);
  assert.match(toml, /wrangler secret put/);
});

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const NAV = {
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  "accept-language": "en-US,en;q=0.9",
};
const SESSION = "https://checkout.stripe.com/c/pay/cs_test_abcdef1234";

function sessionFetch() {
  return async () => Response.json({ id: "cs_test_abcdef1234", url: SESSION });
}

test("checkout opens a Stripe session only for a real top-level navigation", async () => {
  const calls = [];
  const env = () => testEnv(createDb(), { STRIPE_SECRET_KEY: "rk_test_nav", STRIPE_PAYMENT_LINK_MONTHLY: LINK });
  await withFetch(async (url) => {
    calls.push(String(url));
    return Response.json({ id: "cs_test_abcdef1234", url: SESSION });
  }, async () => {
    const ready = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": CHROME, ...NAV },
    }), env());
    assert.equal(ready.status, 303);
    assert.equal(ready.headers.get("location"), SESSION);
    assert.equal(calls.length, 1);

    const bare = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": CHROME },
    }), env());
    assert.equal(bare.status, 200);
    assert.match(bare.headers.get("content-type"), /text\/html/);
    assert.equal(bare.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.match(bare.headers.get("cache-control"), /private/);
    assert.match(bare.headers.get("cache-control"), /no-store/);
    const bareHtml = await bare.text();
    assert.match(bareHtml, /Continue to secure checkout/);
    assert.ok(bareHtml.includes(CHECKOUT_PLAN_LABEL.yearly));
    assert.match(bareHtml, /<form method="GET" action="\/api\/checkout">/);
    assert.match(bareHtml, /name="plan" value="yearly"/);
    assert.match(bareHtml, /name="confirm" value="1"/);
    assert.match(bareHtml, /href="\/pro"/);
    assert.doesNotMatch(bareHtml, /<script/i);
    assert.doesNotMatch(bareHtml, /payment link/i);
    assert.equal(calls.length, 1);

    const noCors = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": CHROME, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "document", "accept-language": "en" },
    }), env());
    assert.equal(noCors.status, 200);
    assert.match(await noCors.text(), /Continue to secure checkout/);
    assert.equal(calls.length, 1);

    const noLang = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": CHROME, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" },
    }), env());
    assert.equal(noLang.status, 200);
    assert.ok((await noLang.text()).includes(CHECKOUT_PLAN_LABEL.monthly));
    assert.equal(calls.length, 1);

    const confirmed = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly&confirm=1", {
      headers: { "user-agent": CHROME },
    }), env());
    assert.equal(confirmed.status, 303);
    assert.equal(confirmed.headers.get("location"), SESSION);
    assert.equal(calls.length, 2);

    const safari = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15" },
    }), env());
    assert.equal(safari.status, 303);
    assert.equal(safari.headers.get("location"), SESSION);

    const crios = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1" },
    }), env());
    assert.equal(crios.status, 303);
    assert.equal(crios.headers.get("location"), SESSION);

    const curl = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": "curl/8.6.0" },
    }), env());
    assert.equal(curl.status, 303);
    assert.equal(curl.headers.get("location"), SESSION);

    const bot = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly&confirm=1", {
      headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", ...NAV },
    }), env());
    assert.equal(bot.status, 302);
    assert.equal(new URL(bot.headers.get("location")).pathname, "/pro");

    const prefetch = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly&confirm=1", {
      headers: { "user-agent": CHROME, "sec-purpose": "prefetch", ...NAV },
    }), env());
    assert.equal(prefetch.status, 302);
    assert.equal(new URL(prefetch.headers.get("location")).pathname, "/pro");
    assert.equal(calls.length, 5);
  });
});

test("ips-agent never opens a Stripe Checkout Session, and normal browsers still do", async () => {
  const KEY = "rk_test_ips_agent";
  const session = "https://checkout.stripe.com/c/pay/cs_test_ips_agent";
  const calls = [];
  const db = createDb();
  const env = testEnv(db, { STRIPE_SECRET_KEY: KEY, STRIPE_PAYMENT_LINK_MONTHLY: LINK, STRIPE_PAYMENT_LINK_YEARLY: LINK });
  const ips = "Mozilla/5.0 (compatible; ips-agent)";
  const nav = {
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
    "accept-language": "en-US,en;q=0.9",
  };
  await withFetch(async (url) => {
    calls.push(String(url));
    return Response.json({ id: "cs_test_ips_agent", url: session });
  }, async () => {
    for (const plan of ["monthly", "yearly"]) {
      const open = await worker.fetch(new Request(`https://sunsetping.com/api/checkout?plan=${plan}`, {
        headers: { "user-agent": ips },
      }), env);
      assert.equal(open.status, 302, plan);
      assert.equal(new URL(open.headers.get("location")).pathname, "/pro", plan);
      const confirmed = await worker.fetch(new Request(`https://sunsetping.com/api/checkout?plan=${plan}&confirm=1`, {
        headers: { "user-agent": ips, ...nav },
      }), env);
      assert.equal(confirmed.status, 302, `${plan} confirm`);
      assert.equal(new URL(confirmed.headers.get("location")).pathname, "/pro");
    }
    const sibling = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ExampleMonitor/1.0)" },
    }), env);
    assert.equal(sibling.status, 302);
    assert.equal(new URL(sibling.headers.get("location")).pathname, "/pro");
    assert.equal(calls.length, 0);

    const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const chromeHeld = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": chrome },
    }), env);
    assert.equal(chromeHeld.status, 200);
    assert.match(await chromeHeld.text(), /Continue to secure checkout/);
    const chromeGo = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly&confirm=1", {
      headers: { "user-agent": chrome },
    }), env);
    assert.equal(chromeGo.status, 303);
    assert.equal(chromeGo.headers.get("location"), session);
    const chromeNav = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": chrome, ...nav },
    }), env);
    assert.equal(chromeNav.status, 303);

    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";
    const safariGo = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": safari },
    }), env);
    assert.equal(safariGo.status, 303);
    const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    const iphoneGo = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": iphone },
    }), env);
    assert.equal(iphoneGo.status, 303);

    const firefox = "Mozilla/5.0 (Android 14; Mobile; rv:126.0) Gecko/126.0 Firefox/126.0";
    const firefoxHeld = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": firefox },
    }), env);
    assert.equal(firefoxHeld.status, 200);
    assert.match(await firefoxHeld.text(), /Continue to secure checkout/);
    const firefoxGo = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly&confirm=1", {
      headers: { "user-agent": firefox },
    }), env);
    assert.equal(firefoxGo.status, 303);

    const edge = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    const edgeHeld = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": edge },
    }), env);
    assert.equal(edgeHeld.status, 200);
    const edgeGo = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": edge, ...nav },
    }), env);
    assert.equal(edgeGo.status, 303);
    const edgios = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/120.0.2210.150 Version/17.0 Mobile/15E148 Safari/604.1";
    const edgiosGo = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": edgios },
    }), env);
    assert.equal(edgiosGo.status, 303);
  });
  assert.equal(calls.length, 7);
  const crawlerRows = db.state.checkoutAttempts.filter((row) => row.ua === ips || row.ua.startsWith("Mozilla/5.0 (compatible; ExampleMonitor"));
  assert.equal(crawlerRows.length, 5);
  for (const row of crawlerRows) {
    assert.equal(row.outcome, "crawler_redirect");
    assert.equal(row.session_id_suffix, null);
  }
  assert.equal(crawlerRows.filter((row) => row.plan === "monthly" && row.confirm === 0 && row.ua === ips).length, 1);
  assert.equal(crawlerRows.filter((row) => row.plan === "yearly" && row.confirm === 1 && row.ua === ips).length, 1);
});

test("checkout interstitial escapes the email and does not include it when absent", async () => {
  const env = testEnv(createDb(), { STRIPE_SECRET_KEY: "rk_test_nav" });
  await withFetch(async () => {
    throw new Error("stripe should not be called");
  }, async () => {
    const nasty = `ada@sunset.test"><script>alert(1)</script>`;
    const res = await worker.fetch(new Request(`https://sunsetping.com/api/checkout?plan=monthly&email=${encodeURIComponent(nasty)}`, {
      headers: { "user-agent": CHROME },
    }), env);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /name="email" value="ada@sunset\.test&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.equal((html.match(/<form/g) || []).length, 1);
    const plain = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly", {
      headers: { "user-agent": CHROME, "sec-fetch-mode": "cors" },
    }), env);
    assert.doesNotMatch(await plain.text(), /name="email"/);
  });
});

test("checkout attempt logging records the outcome and survives a database error", async () => {
  const migration = readFileSync(new URL("../migrations/0004_checkout_attempts.sql", import.meta.url), "utf8");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  for (const sql of [migration, schema]) {
    const table = sql.match(/CREATE TABLE IF NOT EXISTS checkout_attempts \([\s\S]*?\);/);
    assert.ok(table, sql.slice(0, 40));
    assert.doesNotMatch(table[0], /email/i);
    assert.doesNotMatch(table[0], /\bip\b/i);
    assert.match(table[0], /session_id_suffix/);
  }
  const db = createDb();
  const pending = [];
  const ctx = { waitUntil(task) { pending.push(task); } };
  const longUa = `${CHROME} ${"x".repeat(400)}`;
  const req = new Request("https://sunsetping.com/api/checkout?plan=yearly&email=secret-ada@sunset.test", {
    headers: {
      "user-agent": longUa,
      ...NAV,
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      referer: "https://www.sunsetping.com/pro?email=secret-ada@sunset.test",
    },
  });
  req.cf = { country: "US", asn: 13335, asOrganization: "A".repeat(180), ip: "203.0.113.50" };
  await withFetch(sessionFetch(), async () => {
    const res = await worker.fetch(req, testEnv(db, { STRIPE_SECRET_KEY: "rk_test_nav" }), ctx);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), SESSION);
  });
  await Promise.all(pending);
  assert.equal(db.state.checkoutAttempts.length, 1);
  const row = db.state.checkoutAttempts[0];
  assert.equal(row.outcome, "session");
  assert.equal(row.plan, "yearly");
  assert.equal(row.confirm, 0);
  assert.equal(row.session_id_suffix, "abcdef1234");
  assert.equal(row.country, "US");
  assert.equal(row.asn, 13335);
  assert.equal(row.as_org, "A".repeat(100));
  assert.equal(row.ua.length, 300);
  assert.equal(row.sec_fetch_mode, "navigate");
  assert.equal(row.sec_fetch_dest, "document");
  assert.equal(row.sec_fetch_site, "same-origin");
  assert.equal(row.sec_fetch_user, "?1");
  assert.equal(row.has_accept_language, 1);
  assert.equal(row.referer_host, "www.sunsetping.com");
  const blob = JSON.stringify(row);
  assert.doesNotMatch(blob, /secret-ada@sunset\.test/);
  assert.doesNotMatch(blob, /203\.0\.113\.50/);
  assert.equal(row.email, undefined);
  assert.equal(row.ip, undefined);

  const interstitialDb = createDb();
  await withFetch(async () => {
    throw new Error("stripe should not be called");
  }, async () => {
    const held = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": CHROME },
    }), testEnv(interstitialDb, { STRIPE_SECRET_KEY: "rk_test_nav" }));
    assert.equal(held.status, 200);
  });
  assert.equal(interstitialDb.state.checkoutAttempts[0].outcome, "interstitial");
  assert.equal(interstitialDb.state.checkoutAttempts[0].session_id_suffix, null);

  const broken = {
    prepare() {
      throw new Error("no such table: checkout_attempts");
    },
  };
  await withFetch(sessionFetch(), async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly", {
      headers: { "user-agent": CHROME, ...NAV },
    }), testEnv(createDb(), { STRIPE_SECRET_KEY: "rk_test_nav", DB: broken }));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), SESSION);
  });
  await new Promise((resolve) => setImmediate(resolve));
});
