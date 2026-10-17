import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { welcomePage } from "../src/pages.js";
import worker from "../src/worker.js";
import { CLEAR, PERFECT, WASHED, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

const TOKEN = "ab".repeat(32);

function forecastFor(weather, sunsets = ["2026-10-14T18:42"]) {
  return flatForecast(sunsets.map((sunset, i) => day(sunset, weather, sunset.slice(0, 10) + "T07:10")));
}

function openMeteo({ forecast, geocode, zip, failForecast = false }) {
  return async (url) => {
    const u = String(url);
    if (u.includes("zippopotam")) {
      if (!zip) return new Response("missing", { status: 404 });
      return Response.json(zip);
    }
    if (u.includes("/reverse")) return Response.json(geocode || geocodeBody({ name: "Santa Fe", admin1: "New Mexico", latitude: 35.68, longitude: -105.94 }));
    if (u.includes("geocoding-api")) return Response.json(geocode || geocodeBody());
    if (u.includes("api.open-meteo.com")) {
      if (failForecast) return new Response("nope", { status: 500 });
      const lat = Number(new URL(u).searchParams.get("latitude"));
      const body = typeof forecast === "function" ? forecast(lat) : forecast;
      return Response.json(body);
    }
    throw new Error("unexpected fetch " + u);
  };
}

const week = () => {
  const sunsets = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.UTC(2026, 9, 14 + i));
    const date = d.toISOString().slice(0, 10);
    sunsets.push(`${date}T${i === 1 ? "18:05" : "18:42"}`);
  }
  return flatForecast(sunsets.map((sunset) => day(sunset, PERFECT)));
};

test("GET /api/score returns the score, viewing window, and color chance", async () => {
  await withFetch(openMeteo({ forecast: forecastFor(PERFECT) }), async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/api/score?q=Denver"), testEnv(createDb()));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control"), /max-age=600/);
    const body = await res.json();
    assert.equal(body.location, "Denver, Colorado");
    assert.equal(body.score, 10);
    assert.equal(body.verdict, "Don't miss it");
    assert.equal(body.reason, "High, scattered clouds to catch the color.");
    assert.equal(body.sunset, "6:42 PM");
    assert.equal(body.tz, "MDT");
    assert.equal(body.date, "Wednesday, October 14");
    assert.deepEqual(body.viewing, {
      goldenHourStart: "5:42 PM",
      goldenHourEnd: "6:42 PM",
      sunset: "6:42 PM",
      blueHourEnd: "7:22 PM",
    });
    assert.equal(body.colorChance.summary, "High color chance");
    assert.equal(body.colorChance.low.label, "Open horizon");
    assert.equal(body.colorChance.mid.percent, 40);
    assert.equal(body.colorChance.high.percent, 25);
    assert.equal(body.colorChance.humidity.label, "Crisp air");
    assert.equal(body.colorChance.visibility.km, 25);
    assert.equal(body.details.precip_mm, 0);
    assert.equal(body.sunsetIso, undefined);
  });
});

test("GET /api/score accepts lat/lon and ZIP codes", async () => {
  await withFetch(openMeteo({
    forecast: forecastFor(PERFECT),
    zip: { places: [{ "place name": "Denver", state: "Colorado", latitude: "39.75", longitude: "-104.99" }] },
  }), async () => {
    const byZip = await worker.fetch(new Request("https://sunsetping.com/api/score?q=80202"), testEnv(createDb()));
    assert.equal(byZip.status, 200);
    assert.equal((await byZip.json()).location, "Denver, Colorado");
    const byCoord = await worker.fetch(new Request("https://sunsetping.com/api/score?lat=35.68&lon=-105.94"), testEnv(createDb()));
    const coord = await byCoord.json();
    assert.equal(coord.location, "Santa Fe, New Mexico");
    assert.equal(coord.lat, 35.68);
    assert.equal(coord.lon, -105.94);
  });
});

test("score rejects a missing or unknown place and a failed forecast", async () => {
  const env = testEnv(createDb());
  const missing = await worker.fetch(new Request("https://sunsetping.com/api/score"), env);
  assert.equal(missing.status, 400);
  await withFetch(openMeteo({ forecast: forecastFor(PERFECT), geocode: { results: [] } }), async () => {
    const unknown = await worker.fetch(new Request("https://sunsetping.com/api/score?q=Atlantis"), env);
    assert.equal(unknown.status, 404);
  });
  await withFetch(openMeteo({ forecast: forecastFor(PERFECT), failForecast: true }), async () => {
    const down = await worker.fetch(new Request("https://sunsetping.com/api/score?q=Denver"), env);
    assert.equal(down.status, 502);
  });
  const bad = await worker.fetch(new Request("https://sunsetping.com/api/score?lat=120&lon=10"), env);
  assert.equal(bad.status, 400);
});

test("GET /api/outlook returns seven sunsets", async () => {
  await withFetch(openMeteo({ forecast: week() }), async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/api/outlook?q=Sedona"), testEnv(createDb()));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.feature, "7-day outlook");
    assert.equal(body.days.length, 7);
    assert.equal(body.days[0].score, 10);
    assert.equal(body.days[0].sunset, "6:42 PM");
    assert.equal(body.days[1].sunset, "6:05 PM");
    assert.match(body.days[1].date, /October 15/);
    assert.ok(body.days[3].viewing.blueHourEnd);
    assert.ok(body.days[3].colorChance.low);
  });
});

test("best-spot ranks places and keeps the winner first", async () => {
  const forecast = (lat) => forecastFor(lat < 30 ? PERFECT : WASHED);
  await withFetch(openMeteo({
    forecast,
    geocode: null,
  }), async () => {
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes("name=Key%20West") || u.includes("name=Key+West")) return Response.json(geocodeBody({ name: "Key West", admin1: "Florida", latitude: 24.55, longitude: -81.78 }));
      if (u.includes("name=Denver")) return Response.json(geocodeBody());
      if (u.includes("api.open-meteo.com")) {
        const lat = Number(new URL(u).searchParams.get("latitude"));
        return Response.json(forecast(lat));
      }
      throw new Error(u);
    };
    const res = await worker.fetch(new Request("https://sunsetping.com/api/best-spot?spot=Key%20West&spot=Denver"), testEnv(createDb()));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ranking.length, 2);
    assert.equal(body.best.location, "Key West, Florida");
    assert.equal(body.best.score, 10);
    assert.equal(body.ranking[0].rank, 1);
    assert.equal(body.ranking[1].location, "Denver, Colorado");
    assert.equal(body.ranking[1].score, 1);
  });
});

test("share pages carry Open Graph tags and /lookup redirects", async () => {
  await withFetch(openMeteo({ forecast: forecastFor(PERFECT) }), async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/s/Denver"), testEnv(createDb()));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /property="og:title" content="Tonight&#39;s sunset in Denver, Colorado: 10\/10 — Don&#39;t miss it"/);
    assert.match(html, /property="og:image"/);
    assert.match(html, /twitter:card" content="summary_large_image"/);
    assert.match(html, /Golden hour start/);
    assert.match(html, /Blue hour end/);
    assert.match(html, /High color chance/);
    const og = await worker.fetch(new Request("https://sunsetping.com/api/og.svg?score=10&location=Denver&verdict=Don't%20miss%20it&sunset=6:42%20PM"), testEnv(createDb()));
    assert.match(og.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await og.text(), /<svg/);
    const jump = await worker.fetch(new Request("https://sunsetping.com/lookup?q=Denver"), testEnv(createDb()));
    assert.equal(jump.status, 302);
    assert.equal(new URL(jump.headers.get("location")).pathname, "/s/Denver");
  });
});

test("checkout explains that nothing was charged until Stripe is configured", async () => {
  const env = testEnv(createDb());
  const open = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly"), env);
  const html = await open.text();
  assert.equal(open.status, 200);
  assert.match(html, /No charge was made/);
  assert.match(html, /Pro monthly/);
  assert.doesNotMatch(html, /STRIPE_PAYMENT_LINK/);
  assert.doesNotMatch(html, /placeholder/i);
  assert.doesNotMatch(html, /card number/i);
  const yearly = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly"), env);
  const yearlyHtml = await yearly.text();
  assert.match(yearlyHtml, /Pro yearly/);
  assert.doesNotMatch(yearlyHtml, /STRIPE_PAYMENT_LINK/);
  const unsafe = testEnv(createDb(), { STRIPE_PAYMENT_LINK_MONTHLY: "http://buy.stripe.com/not-https" });
  const blocked = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly"), unsafe);
  assert.equal(blocked.status, 200);
  const ready = testEnv(createDb(), { STRIPE_PAYMENT_LINK: "https://buy.stripe.com/test_placeholder" });
  const go = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly"), ready);
  assert.equal(go.status, 302);
  assert.equal(go.headers.get("location"), "https://buy.stripe.com/test_placeholder");
});

test("subscribe, unsubscribe, saved spots, and Pro settings", async () => {
  const db = createDb();
  const env = testEnv(db);
  await withFetch(openMeteo({ forecast: forecastFor(PERFECT) }), async () => {
    const bad = await worker.fetch(new Request("https://sunsetping.com/api/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nope", location: "Denver" }) }), env);
    assert.equal(bad.status, 400);
    const ok = await worker.fetch(new Request("https://sunsetping.com/api/subscribe", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: "Ada@Sunset.test", location: "Denver" }) }), env);
    assert.equal((await ok.json()).ok, true);
    const row = db.state.subscribers[0];
    assert.equal(row.email, "ada@sunset.test");
    assert.equal(row.plan, "free");
    assert.equal(row.location, "Denver, Colorado");

    const denied = await worker.fetch(new Request("https://sunsetping.com/api/locations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: row.email, location: "Moab" }) }), env);
    assert.equal(denied.status, 403);

    row.plan = "pro";
    for (let i = 0; i < 10; i++) {
      const saved = await worker.fetch(new Request("https://sunsetping.com/api/locations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: row.email, location: "Moab" }) }), env);
      assert.equal(saved.status, 201, await saved.clone().text());
    }
    const overflow = await worker.fetch(new Request("https://sunsetping.com/api/locations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: row.email, location: "Moab" }) }), env);
    assert.equal(overflow.status, 409);

    const settings = await worker.fetch(new Request("https://sunsetping.com/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: row.email, scoreThreshold: 8, sunriseAlerts: true, dayBefore: true, leadMinutes: 120 }) }), env);
    const account = await settings.json();
    assert.equal(settings.status, 200);
    assert.equal(account.scoreThreshold, 8);
    assert.equal(account.sunriseAlerts, true);
    assert.equal(account.dayBefore, true);
    assert.equal(account.leadMinutes, 120);
    assert.equal(account.spots.length, 10);

    row.plan = "free";
    const freeSettings = await worker.fetch(new Request("https://sunsetping.com/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: row.email, scoreThreshold: 9 }) }), env);
    assert.equal(freeSettings.status, 403);
    row.plan = "pro";

    const bye = await worker.fetch(new Request(`https://sunsetping.com/api/unsubscribe?token=${row.unsubscribe_token}`), env);
    assert.match(await bye.text(), /Unsubscribed/);
    assert.equal(row.status, "unsubscribed");
  });
});

test("best-spot for an account requires Pro", async () => {
  const db = createDb({
    subscribers: [{ id: 1, email: "a@b.co", location: "Denver, Colorado", lat: 39.7, lon: -104.9, tz: "America/Denver", plan: "free", score_threshold: null, sunrise_alerts: 0, day_before: 0, lead_minutes: 180, unsubscribe_token: TOKEN, status: "active" }],
  });
  const res = await worker.fetch(new Request("https://sunsetping.com/api/best-spot?email=a@b.co"), testEnv(db));
  assert.equal(res.status, 403);
});

test("scheduled hook and pro page asset are wired", async () => {
  const db = createDb();
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.now() }, testEnv(db), { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  const pro = await worker.fetch(new Request("https://sunsetping.com/pro"), testEnv(db));
  assert.equal(await pro.text(), "/pro.html");
});

test("served pages do not show payment placeholder notes", async () => {
  const files = ["../index.html", "../public/index.html", "../public/pro.html", "../public/faq.html"];
  const pages = files.map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
  const monthly = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly"), testEnv(createDb()));
  const yearly = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly"), testEnv(createDb()));
  pages.push(await monthly.text(), await yearly.text());
  pages.push(await welcomePage({ location: "Denver, Colorado", email: "ada@sunset.test" }).text());
  for (const html of pages) {
    assert.doesNotMatch(html, /STRIPE_PAYMENT_LINK/);
    assert.doesNotMatch(html, /payment placeholder/i);
    assert.doesNotMatch(html, /checkout placeholder/i);
    assert.doesNotMatch(html, /<p class="note">[^<]*placeholder/i);
  }
});

test("homepage and pro page describe the free and paid split", () => {
  const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const pro = readFileSync(new URL("../public/pro.html", import.meta.url), "utf8");
  assert.match(home, /Check tonight's sunset/);
  assert.match(home, /id="pricing"/);
  assert.match(home, /\$3\.99/);
  assert.match(home, /\$29/);
  assert.match(home, /Secure checkout by Stripe\./);
  assert.match(pro, /7-day/);
  assert.match(pro, /Sunrise/);
  assert.match(pro, /score is at least N|Score threshold/);
  assert.match(pro, /Best spot tonight/);
  const migration = readFileSync(new URL("../migrations/0002_pro.sql", import.meta.url), "utf8");
  for (const column of ["plan", "score_threshold", "sunrise_alerts", "day_before", "saved_locations", "alert_sends"]) {
    assert.match(migration, new RegExp(column));
  }
});
