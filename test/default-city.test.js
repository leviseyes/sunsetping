import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";
import { runAlerts } from "../src/alerts.js";
import { renderEmail, renderWelcomeEmail } from "../src/email.js";
import { defaultPlaceFromCf, nearestCity } from "../src/geo-default.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

const fetchOk = async (url) => {
  const u = String(url);
  if (u.includes("geocoding-api")) return Response.json(geocodeBody());
  if (u.includes("api.open-meteo.com")) return Response.json(flatForecast([day("2026-10-14T18:42", PERFECT)]));
  if (u.includes("api.resend.com")) return Response.json({ id: "email_1" });
  throw new Error(u);
};

function subscribeReq(body, cf) {
  const req = new Request("https://sunsetping.com/api/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (cf) Object.defineProperty(req, "cf", { value: cf });
  return req;
}

test("defaultPlaceFromCf uses the Cloudflare city, then nearest catalog city, then the default", () => {
  const cf = defaultPlaceFromCf({ city: "Boulder", region: "Colorado", country: "US", latitude: "40.01", longitude: "-105.27", timezone: "America/Denver" });
  assert.equal(cf.name, "Boulder, Colorado");
  assert.equal(cf.latitude, 40.01);
  assert.equal(cf.timezone, "America/Denver");
  const abroad = defaultPlaceFromCf({ city: "Lyon", region: "Auvergne-Rhone-Alpes", country: "FR", latitude: 45.76, longitude: 4.83, timezone: "Europe/Paris" });
  assert.equal(abroad.name, "Lyon, Auvergne-Rhone-Alpes, FR");
  const near = defaultPlaceFromCf({ latitude: 47.6, longitude: -122.3 });
  assert.equal(near.source, "nearest");
  assert.equal(near.name, `${nearestCity(47.6, -122.3).city}, ${nearestCity(47.6, -122.3).region}`);
  assert.equal(defaultPlaceFromCf(undefined).name, "Los Angeles, California");
  assert.equal(defaultPlaceFromCf({ latitude: 0, longitude: 0 }).source, "default");
});

test("one-field signup stores a city from request.cf and alerts can run for it", async () => {
  const db = createDb();
  const env = testEnv(db);
  await withFetch(fetchOk, async () => {
    const res = await worker.fetch(subscribeReq({ email: "ada@sunset.test" }, { city: "Boulder", region: "Colorado", country: "US", latitude: "40.01", longitude: "-105.27", timezone: "America/Denver" }), env, { waitUntil() {} });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.location, "Boulder, Colorado");
  });
  const sub = db.state.subscribers[0];
  assert.equal(sub.lat, 40.01);
  assert.equal(sub.lon, -105.27);
  assert.equal(sub.tz, "America/Denver");
  const sent = [];
  const summary = await runAlerts(env, new Date("2026-10-14T21:42:00Z"), { fetchImpl: fetchOk, send: async (m) => { sent.push(m); return { ok: true, sent: true }; } });
  assert.equal(summary.considered, 1);
  assert.equal(summary.errors, 0);
});

test("signup without a city keeps an existing subscriber's city", async () => {
  const db = createDb({ subscribers: [{ id: 1, email: "ada@sunset.test", location: "Moab, Utah", lat: 38.57, lon: -109.55, tz: "America/Denver", status: "active", unsubscribe_token: "cd".repeat(32) }] });
  await withFetch(fetchOk, async () => {
    const res = await worker.fetch(subscribeReq({ email: "ada@sunset.test" }, { city: "Boulder", latitude: 40, longitude: -105, timezone: "America/Denver" }), testEnv(db), { waitUntil() {} });
    assert.equal((await res.json()).location, "Moab, Utah");
  });
  assert.equal(db.state.subscribers[0].lat, 38.57);
});

test("change-city page and POST update the subscriber by token", async () => {
  const token = "ef".repeat(32);
  const db = createDb({ subscribers: [{ id: 1, email: "ada@sunset.test", location: "Los Angeles, California", lat: 34, lon: -118, tz: "America/Los_Angeles", status: "active", unsubscribe_token: token }] });
  const env = testEnv(db);
  const page = await worker.fetch(new Request(`https://sunsetping.com/city?token=${token}`), env, {});
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Change your city/);
  assert.match(html, /Los Angeles, California/);
  assert.equal((await worker.fetch(new Request("https://sunsetping.com/city?token=bad"), env, {})).status, 400);
  await withFetch(fetchOk, async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/api/city", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token, location: "Denver" }),
    }), env, {});
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
  });
  const row = db.state.subscribers[0];
  assert.notEqual(row.location, "Los Angeles, California");
  assert.equal(typeof row.lat, "number");
});

test("welcome and alert emails carry the change-city link", () => {
  const url = "https://sunsetping.com/city?token=abc";
  const welcome = renderWelcomeEmail({ location: "Boulder, Colorado", unsubscribeUrl: "u", changeCityUrl: url });
  assert.match(welcome, /Change it in one click/);
  assert.match(welcome, /city\?token=abc/);
  const alert = renderEmail({ location: "Boulder", score: 8, verdict: "Great", reason: "High clouds", sunset: "6:01 PM" }, { unsubscribeUrl: "u", changeCityUrl: url });
  assert.match(alert, /Change your city/);
});
