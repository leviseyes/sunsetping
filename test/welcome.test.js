import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deliverWelcome } from "../src/welcome.js";
import worker from "../src/worker.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

const TOKEN = "ab".repeat(32);
const EMAIL = "Ada@Sunset.test";
const ENCODED = "ada%40sunset.test";
const YEARLY = new RegExp(`/api/checkout\\?plan=yearly&(?:amp;)?email=${ENCODED}`);
const MONTHLY = new RegExp(`/api/checkout\\?plan=monthly&(?:amp;)?email=${ENCODED}`);

function forecastBody() {
  return flatForecast([day("2026-10-14T18:42", PERFECT)]);
}

function mockFetch({ failForecast = false, hangForecast = false, onEmail } = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes("api.resend.com")) {
      if (onEmail) return onEmail(url, init);
      return Response.json({ id: "email_1" });
    }
    if (u.includes("geocoding-api")) return Response.json(geocodeBody());
    if (u.includes("api.open-meteo.com")) {
      if (hangForecast) {
        return new Promise((resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          if (signal?.aborted) return abort();
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
      if (failForecast) return new Response("nope", { status: 500 });
      return Response.json(forecastBody());
    }
    throw new Error("unexpected fetch " + u);
  };
}

function formRequest(email, location) {
  return new Request("https://sunsetping.com/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, location }).toString(),
  });
}

function jsonRequest(email, location) {
  return new Request("https://sunsetping.com/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email, location }),
  });
}

test("HTML signup returns the Pro offer with both checkout links", async () => {
  const db = createDb();
  const env = testEnv(db, { RESEND_API_KEY: "re_test" });
  const sent = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p); } };
  await withFetch(mockFetch({
    onEmail: async (url, init) => {
      await gate;
      sent.push(JSON.parse(init.body));
      return Response.json({ id: "email_1" });
    },
  }), async () => {
    const res = await worker.fetch(formRequest(EMAIL, "Denver"), env, ctx);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.match(html, /name="robots" content="noindex"/);
    assert.match(html, /You're in\. We'll email you before sunset in Denver, Colorado\./);
    assert.match(html, /welcome-score">10<span>\/10<\/span>/);
    assert.match(html, /6:42 PM/);
    assert.match(html, YEARLY);
    assert.match(html, MONTHLY);
    assert.ok(html.indexOf("plan=yearly") < html.indexOf("plan=monthly"));
    assert.match(html, /\$2\.42\/mo, save 39%/);
    assert.match(html, /\$3\.99/);
    assert.match(html, /\$29/);
    assert.match(html, /No thanks, free is fine/);
    assert.match(html, /Great-sunsets-only/);
    assert.equal(sent.length, 0);
    release();
    await Promise.all(pending);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].subject, "You're in: sunset alerts for Denver, Colorado");
    assert.deepEqual(sent[0].to, ["ada@sunset.test"]);
    assert.match(sent[0].html, new RegExp(`https://sunsetping\\.com/api/unsubscribe\\?token=${db.state.subscribers[0].unsubscribe_token}`));
    assert.match(sent[0].html, new RegExp(`https://sunsetping\\.com/api/checkout\\?plan=yearly&amp;email=${ENCODED}`));
    assert.ok(sent[0].html.indexOf("plan=yearly") < sent[0].html.indexOf("plan=monthly"));
    assert.match(sent[0].html, />10<span[^>]*>\/10<\/span>/);
    assert.match(sent[0].html, /6:42 PM/);
    assert.equal(db.state.sends.filter((row) => row.kind === "welcome").length, 1);

    const again = await worker.fetch(formRequest(EMAIL, "Denver"), env, ctx);
    assert.equal(again.status, 200);
    assert.match(await again.text(), YEARLY);
    await Promise.all(pending);
    assert.equal(sent.length, 1);
    assert.equal(db.state.sends.filter((row) => row.kind === "welcome").length, 1);
  });
});

test("JSON signup stays compatible and includes the same offer", async () => {
  const db = createDb();
  const env = testEnv(db);
  const pending = [];
  await withFetch(mockFetch(), async () => {
    const res = await worker.fetch(jsonRequest(EMAIL, "Denver"), env, { waitUntil(p) { pending.push(p); } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.location, "Denver, Colorado");
    assert.equal(body.checkout.yearly, `/api/checkout?plan=yearly&email=${ENCODED}`);
    assert.equal(body.checkout.monthly, `/api/checkout?plan=monthly&email=${ENCODED}`);
    assert.equal(body.tonight.score, 10);
    assert.equal(body.tonight.sunset, "6:42 PM");
    assert.match(body.offerHtml, YEARLY);
    assert.match(body.offerHtml, MONTHLY);
    assert.match(body.offerHtml, /No thanks, free is fine/);
    await Promise.all(pending);
  });
});

test("welcome email sends once for a new subscriber and dedupes a second attempt", async () => {
  const db = createDb();
  const env = testEnv(db, { RESEND_API_KEY: "re_test" });
  const subscriber = {
    id: 7,
    email: "ada@sunset.test",
    location: "Denver, Colorado",
    unsubscribe_token: TOKEN,
  };
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return Response.json({ id: "email_1" });
  };
  const tonight = { score: 10, verdict: "Don't miss it", sunset: "6:42 PM", tz: "MDT", date: "Wednesday, October 14", reason: "High, scattered clouds to catch the color." };
  const first = await deliverWelcome({ env, subscriber, tonight, fetchImpl });
  const second = await deliverWelcome({ env, subscriber, tonight: null, fetchImpl });
  assert.equal(first.sent, true);
  assert.equal(second.skipped, "deduped");
  assert.equal(sent.length, 1);
  assert.match(sent[0].html, new RegExp(`unsubscribe\\?token=${TOKEN}`));
  assert.match(sent[0].html, /plan=yearly&amp;email=ada%40sunset\.test/);
  assert.match(sent[0].html, /\$2\.42\/mo, save 39%/);
  assert.equal(db.state.sends.filter((row) => row.kind === "welcome").length, 1);
});

test("a forecast failure, a sender failure, or a slow forecast does not fail signup", async () => {
  const failed = testEnv(createDb(), { RESEND_API_KEY: "re_test" });
  const pending = [];
  const ctx = { waitUntil(p) { pending.push(p); } };
  await withFetch(mockFetch({
    failForecast: true,
    onEmail: async () => {
      throw new Error("resend down");
    },
  }), async () => {
    const res = await worker.fetch(formRequest(EMAIL, "Denver"), failed, ctx);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /You're in\. We'll email you before sunset in Denver, Colorado\./);
    assert.doesNotMatch(html, /welcome-score/);
    assert.match(html, YEARLY);
    await Promise.all(pending);
  });

  const slow = testEnv(createDb());
  const started = Date.now();
  await withFetch(mockFetch({ hangForecast: true }), async () => {
    const res = await worker.fetch(jsonRequest("slow@sunset.test", "Denver"), slow, ctx);
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tonight, null);
    assert.ok(elapsed >= 2000, `forecast returned too fast (${elapsed}ms)`);
    assert.ok(elapsed < 5000, `forecast blocked signup (${elapsed}ms)`);
    await Promise.all(pending);
  });
});

test("invalid email is still a 400 for HTML and JSON", async () => {
  const env = testEnv(createDb());
  const html = await worker.fetch(formRequest("nope", "Denver"), env);
  assert.equal(html.status, 400);
  assert.doesNotMatch(await html.text(), /plan=yearly/);
  const json = await worker.fetch(jsonRequest("nope", "Denver"), env);
  assert.equal(json.status, 400);
  assert.equal((await json.json()).ok, false);
});

test("homepage and city pages render the signup offer from the JSON payload", () => {
  const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const root = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const growth = readFileSync(new URL("../src/growth.js", import.meta.url), "utf8");
  assert.equal(root, home);
  assert.match(home, /data-signup/);
  assert.match(home, /data-welcome-host/);
  assert.match(app, /form\[data-signup\]/);
  assert.match(app, /offerHtml/);
  assert.match(growth, /data-signup/);
  assert.match(growth, /src="\/app\.js"/);
  assert.match(growth, /action="\/api\/subscribe"/);
});
