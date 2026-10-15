import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import worker from "../src/worker.js";
import { createDb, testEnv } from "./fixtures.js";

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
