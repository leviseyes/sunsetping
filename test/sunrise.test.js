import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";
import { CITIES } from "../src/cities.js";
import { weekSunriseTimes, sunriseUtc } from "../src/sun.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((b) => JSON.parse(b[1]));
}

function seattleFetch() {
  return async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return Response.json(geocodeBody({ name: "Seattle", admin1: "Washington", latitude: 47.6062, longitude: -122.3321, timezone: "America/Los_Angeles" }));
    }
    if (u.includes("api.open-meteo.com")) {
      return Response.json(flatForecast([day("2026-10-14T18:22", PERFECT, "2026-10-14T07:31")], "America/Los_Angeles"));
    }
    throw new Error("unexpected fetch " + u);
  };
}

test("sunriseUtc is before noon and matches a known Seattle sunrise within a few minutes", () => {
  const utc = sunriseUtc(2026, 10, 14, 47.6062, -122.3321);
  // Seattle Oct 14 2026 sunrise is about 7:30 AM PDT = 14:30 UTC.
  const minutes = utc.getUTCHours() * 60 + utc.getUTCMinutes();
  assert.ok(Math.abs(minutes - (14 * 60 + 30)) <= 4, `got ${utc.toISOString()}`);
});

test("weekSunriseTimes returns 7 rows with golden and blue hour", () => {
  const week = weekSunriseTimes({ lat: 47.6062, lon: -122.3321, timeZone: "America/Los_Angeles", startDate: "2026-10-14", forecastSunriseIso: "2026-10-14T07:31" });
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].sunrise, "7:31 AM");
  assert.equal(week.days[0].goldenHourEnd, "8:31 AM");
  assert.equal(week.days[0].blueHourStart, "6:51 AM");
  assert.equal(week.days[0].tz, "PDT");
  assert.equal(weekSunriseTimes({ lat: 99, lon: 0, timeZone: "UTC", startDate: "2026-10-14" }), null);
});

test("/sunrise/seattle renders sunrise time, FAQ, week, one signup form", async () => {
  await withFetch(seattleFetch(), async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/sunrise/seattle"), testEnv(createDb()));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Sunrise Time Today in Seattle: 7:31 AM PDT · SunsetPing<\/title>/);
    assert.match(html, /<link rel="canonical" href="https:\/\/sunsetping.com\/sunrise\/seattle">/);
    assert.match(html, /Morning golden hour in Seattle today \(Wednesday, October 14\) is 7:31\u20138:31 AM PDT\./);
    assert.match(html, /Morning blue hour in Seattle today \(Wednesday, October 14\) is 6:51\u20137:31 AM PDT/);
    assert.match(html, /Sunrise times this week in Seattle/);
    assert.equal((html.match(/data-signup/g) || []).length, 1);
    assert.match(html, /name="signup_path" value="\/sunrise\/seattle"/);
    const types = jsonLdBlocks(html).map((b) => b["@type"]);
    for (const t of ["WebPage", "FAQPage", "BreadcrumbList", "ItemList"]) assert.ok(types.includes(t), t);
    const faq = jsonLdBlocks(html).find((b) => b["@type"] === "FAQPage");
    assert.equal(faq.mainEntity[0].name, "What time is sunrise today in Seattle?");
    assert.match(html, /href="\/sunset\/seattle"/);
  });
});

test("/sunrise/<unknown> is 404 and /sunrise index lists every city", async () => {
  const env = testEnv(createDb());
  const missing = await worker.fetch(new Request("https://sunsetping.com/sunrise/nowhere"), env);
  assert.equal(missing.status, 404);
  const index = await worker.fetch(new Request("https://sunsetping.com/sunrise"), env);
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.equal((html.match(/href="\/sunrise\/[a-z0-9-]+"/g) || []).length, CITIES.length);
});

test("sitemap lists sunrise index and city pages", async () => {
  const res = await worker.fetch(new Request("https://sunsetping.com/sitemap.xml"), testEnv(createDb()));
  const xml = await res.text();
  assert.match(xml, /<loc>https:\/\/sunsetping.com\/sunrise<\/loc>/);
  assert.equal((xml.match(/\/sunrise\/[a-z0-9-]+<\/loc>/g) || []).length, CITIES.length);
});

test("sunrise page falls back gracefully when the forecast fails", async () => {
  await withFetch(async () => { throw new Error("down"); }, async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/sunrise/seattle"), testEnv(createDb()));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Sunrise Time Today in Seattle/);
    assert.match(html, /data-signup/);
  });
});
