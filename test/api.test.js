import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CITIES } from "../src/cities.js";
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

test("GET /api/score resolves every catalog city slug", async () => {
  let denverName = "";
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      const name = new URL(u).searchParams.get("name") || "";
      if (name === "Denver") {
        denverName = name;
        return Response.json(geocodeBody());
      }
      const city = CITIES.find((item) => item.query === name);
      if (!city) return Response.json({ results: [] });
      return Response.json(geocodeBody({
        name: city.city,
        admin1: city.region,
        latitude: 39.5,
        longitude: -104.9,
        timezone: "America/Denver",
      }));
    }
    if (u.includes("api.open-meteo.com")) return Response.json(forecastFor(PERFECT));
    if (u.includes("zippopotam")) return new Response("missing", { status: 404 });
    throw new Error("unexpected fetch " + u);
  }, async () => {
    const env = testEnv(createDb());
    const named = await worker.fetch(new Request("https://sunsetping.com/api/score?q=Denver"), env);
    assert.equal(named.status, 200);
    assert.equal(denverName, "Denver");
    assert.equal((await named.json()).location, "Denver, Colorado");
    const byCoord = await worker.fetch(new Request("https://sunsetping.com/api/score?lat=35.68&lon=-105.94"), env);
    assert.equal(byCoord.status, 200);

    for (const city of CITIES) {
      const res = await worker.fetch(new Request(`https://sunsetping.com/api/score?q=${encodeURIComponent(city.slug)}`), env);
      assert.equal(res.status, 200, city.slug);
      const body = await res.json();
      assert.equal(body.location, `${city.city}, ${city.region}`, city.slug);
      assert.equal(typeof body.score, "number", city.slug);
      assert.ok(body.viewing?.goldenHourStart, city.slug);
    }
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

test("checkout no longer returns a Stripe redirect", async () => {
  const env = testEnv(createDb(), {
    STRIPE_SECRET_KEY: "rk_test_should_not_be_used",
    STRIPE_PAYMENT_LINK: "https://buy.stripe.com/test_placeholder",
    STRIPE_PAYMENT_LINK_MONTHLY: "https://buy.stripe.com/test_placeholder",
    STRIPE_PAYMENT_LINK_YEARLY: "https://buy.stripe.com/test_placeholder",
  });
  let called = false;
  await withFetch(async () => {
    called = true;
    return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test" });
  }, async () => {
    for (const plan of ["monthly", "yearly"]) {
      const res = await worker.fetch(new Request(`https://sunsetping.com/api/checkout?plan=${plan}&email=ada@sunset.test&confirm=1`, {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
          "sec-fetch-user": "?1",
          "sec-fetch-site": "same-origin",
        },
      }), env);
      assert.equal(res.status, 302);
      const loc = res.headers.get("location") || "";
      assert.match(loc, /\/#signup$/);
      assert.doesNotMatch(loc, /stripe/i);
      assert.doesNotMatch(loc, /checkout\.stripe/i);
    }
    const pro = await worker.fetch(new Request("https://sunsetping.com/pro"), env);
    assert.equal(pro.status, 301);
    assert.match(pro.headers.get("location") || "", /\/#signup$/);
  });
  assert.equal(called, false);
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

    const freeSettings = await worker.fetch(new Request("https://sunsetping.com/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: row.email, scoreThreshold: 9 }) }), env);
    assert.equal(freeSettings.status, 200);
    assert.equal((await freeSettings.json()).scoreThreshold, 9);

    const bye = await worker.fetch(new Request(`https://sunsetping.com/api/unsubscribe?token=${row.unsubscribe_token}`), env);
    assert.match(await bye.text(), /Unsubscribed/);
    assert.equal(row.status, "unsubscribed");
  });
});

test("best-spot for a free subscriber ranks saved spots", async () => {
  const db = createDb({
    subscribers: [{ id: 1, email: "a@b.co", location: "Denver, Colorado", lat: 39.7, lon: -104.9, tz: "America/Denver", plan: "free", score_threshold: null, sunrise_alerts: 0, day_before: 0, lead_minutes: 180, unsubscribe_token: TOKEN, status: "active" }],
    saved: [{ id: 3, subscriber_id: 1, label: "Key West, Florida", lat: 24.55, lon: -81.78 }],
  });
  const forecast = (lat) => forecastFor(lat < 30 ? PERFECT : WASHED);
  await withFetch(openMeteo({ forecast }), async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/api/best-spot?email=a@b.co"), testEnv(db));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.best.location, "Key West, Florida");
    assert.equal(body.ranking[0].score, 10);
  });
});

test("scheduled hook runs and /pro redirects to signup", async () => {
  const db = createDb();
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.now() }, testEnv(db), { waitUntil(p) { pending.push(p); } });
  await Promise.all(pending);
  const pro = await worker.fetch(new Request("https://sunsetping.com/pro"), testEnv(db));
  assert.equal(pro.status, 301);
  assert.match(pro.headers.get("location") || "", /\/#signup$/);
});

test("served pages do not show payment placeholder notes", async () => {
  const files = ["../index.html", "../public/index.html", "../public/faq.html"];
  const pages = files.map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
  const monthly = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=monthly"), testEnv(createDb()));
  const yearly = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly"), testEnv(createDb()));
  assert.equal(monthly.status, 302);
  assert.equal(yearly.status, 302);
  assert.match(monthly.headers.get("location") || "", /\/#signup$/);
  assert.doesNotMatch(monthly.headers.get("location") || "", /stripe/i);
  pages.push(await welcomePage({ location: "Denver, Colorado", email: "ada@sunset.test" }).text());
  for (const html of pages) {
    assert.doesNotMatch(html, /STRIPE_PAYMENT_LINK/);
    assert.doesNotMatch(html, /payment placeholder/i);
    assert.doesNotMatch(html, /checkout placeholder/i);
    assert.doesNotMatch(html, /<p class="note">[^<]*placeholder/i);
    assert.doesNotMatch(html, /\$3\.99/);
    assert.doesNotMatch(html, /\$29/);
  }
});

test("homepage signup is the primary free offer", () => {
  const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(home, /Check tonight's sunset/);
  assert.match(home, /id="signup"/);
  assert.match(home, /Know when the light will be good before you drive out/);
  assert.match(home, /action="\/api\/subscribe"/);
  assert.match(home, /"price":"0"/);
  assert.doesNotMatch(home, /\$3\.99/);
  assert.doesNotMatch(home, /\/api\/checkout/);
  const migration = readFileSync(new URL("../migrations/0002_pro.sql", import.meta.url), "utf8");
  for (const column of ["plan", "score_threshold", "sunrise_alerts", "day_before", "saved_locations", "alert_sends"]) {
    assert.match(migration, new RegExp(column));
  }
});
