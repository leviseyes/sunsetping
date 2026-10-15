import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { INDEXNOW_KEY } from "../src/indexnow.js";
import { cityMetaDescription, cityPageTitle, compactClockRange, tonightSentence } from "../src/growth.js";
import worker from "../src/worker.js";
import { indexNowPayload, loadIndexNowKey, urlsFromSitemap } from "../scripts/indexnow.mjs";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function jsonLd(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  return JSON.parse(blocks[0][1]);
}

function austinForecast() {
  let calls = 0;
  const impl = async (url) => {
    calls += 1;
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return Response.json(geocodeBody({
        name: "Austin",
        admin1: "Texas",
        latitude: 30.27,
        longitude: -97.74,
        timezone: "America/Chicago",
      }));
    }
    if (u.includes("api.open-meteo.com")) {
      return Response.json(flatForecast([day("2026-10-15T18:59", PERFECT)], "America/Chicago"));
    }
    throw new Error("unexpected fetch " + u);
  };
  return { impl, calls: () => calls };
}

function memoryCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const hit = store.get(req.url);
      if (!hit) return undefined;
      return new Response(hit.body, { status: hit.status, headers: new Headers(hit.headers) });
    },
    async put(req, res) {
      store.set(req.url, { body: await res.text(), status: res.status, headers: [...res.headers] });
    },
  };
}

test("tonight's sentence states the sunset time, golden hour, and score", () => {
  assert.equal(compactClockRange("5:59 PM", "6:59 PM"), "5:59-6:59 PM");
  assert.equal(compactClockRange("11:40 AM", "12:40 PM"), "11:40 AM-12:40 PM");
  const score = {
    date: "Thursday, October 15",
    sunset: "6:59 PM",
    tz: "CDT",
    score: 6,
    verdict: "Worth stepping outside",
    viewing: { goldenHourStart: "5:59 PM", goldenHourEnd: "6:59 PM", blueHourEnd: "7:39 PM" },
  };
  assert.equal(
    tonightSentence("Austin", score),
    "Sunset in Austin today (Thursday, October 15) is at 6:59 PM CDT. Golden hour runs 5:59-6:59 PM and blue hour ends 7:39 PM. Tonight's SunsetPing score is 6/10: Worth stepping outside.",
  );
  assert.equal(cityPageTitle("Austin", score), "Sunset time today in Austin: 6:59 PM · tonight 6/10 · SunsetPing");
  assert.match(cityMetaDescription("Austin", score), /Sunset time today in Austin/);
  assert.match(cityMetaDescription("Austin", score), /6\/10/);
});

test("a city page includes tonight's forecast in the initial HTML", async () => {
  const forecast = austinForecast();
  await withFetch(forecast.impl, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/sunset/austin"), testEnv(createDb()));
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("cache-control"), /s-maxage=1500/);
    assert.match(page.headers.get("cache-control"), /max-age=1500/);
    const html = await page.text();
    const api = await worker.fetch(new Request("https://sunsetping.com/api/score?q=Austin%2C%20Texas"), testEnv(createDb()));
    const data = await api.json();
    assert.equal(data.sunset, "6:59 PM");
    assert.equal(data.tz, "CDT");
    assert.equal(data.date, "Thursday, October 15");
    assert.equal(data.score, 10);
    assert.equal(data.viewing.goldenHourStart, "5:59 PM");
    assert.equal(data.viewing.blueHourEnd, "7:39 PM");
    assert.ok(html.includes(esc(tonightSentence("Austin", data))));
    assert.match(html, /<title>Sunset time today in Austin: 6:59 PM · tonight 10\/10 · SunsetPing<\/title>/);
    assert.match(html, /name="description" content="[^"]*Sunset time today in Austin is 6:59 PM CDT[^"]*10\/10/);
    assert.match(html, /<h1>Will tonight&#39;s sunset be good in Austin\?<\/h1>/);
    assert.match(html, /<p class="city-score"><strong>10\/10<\/strong>/);
    assert.match(html, /Sunset 6:59 PM CDT\./);
    assert.match(html, /fetch\("\/api\/score\?q="/);
    assert.match(html, /action="\/api\/subscribe"/);
    assert.match(html, /name="location" value="Austin, Texas"/);
    assert.match(html, /Mount Bonnell/);
    const ld = jsonLd(html);
    assert.equal(ld["@type"], "WebPage");
    assert.equal(ld.dateModified, "2026-10-15");
    assert.equal(ld.about["@type"], "Place");
    assert.equal(ld.about.name, "Austin, Texas");
    assert.equal(ld.isPartOf["@type"], "WebSite");
    assert.match(ld.description, /Golden hour runs 5:59-6:59 PM and blue hour ends 7:39 PM/);
    assert.match(ld.description, /10\/10/);
    assert.match(ld.name, /Sunset time today in Austin/);
  });
});

test("a city page stays 200 with the static shell when the forecast fails or times out", async () => {
  const env = testEnv(createDb());
  await withFetch(async () => {
    throw new Error("open-meteo down");
  }, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/sunset/austin"), env);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Checking tonight's sky in Austin/);
    assert.match(html, /<title>Will tonight&#39;s sunset be good in Austin\? · SunsetPing<\/title>/);
    assert.match(html, /Mount Bonnell/);
    assert.match(html, /action="\/api\/subscribe"/);
    assert.doesNotMatch(html, /Tonight&#39;s SunsetPing score is/);
    assert.match(page.headers.get("cache-control"), /max-age=60/);
    assert.doesNotMatch(page.headers.get("cache-control") || "", /s-maxage/);
    const ld = jsonLd(html);
    assert.equal(ld["@type"], "WebPage");
    assert.equal(ld.about["@type"], "Place");
    assert.equal(ld.about.name, "Austin, Texas");
    assert.equal(ld.dateModified, undefined);
    assert.doesNotMatch(ld.description, /\/10/);
  });

  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) return Response.json(geocodeBody({ name: "Austin", admin1: "Texas", timezone: "America/Chicago" }));
    return new Response("nope", { status: 500 });
  }, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/sunset/austin"), env);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Checking tonight's sky in Austin/);
  });

  const slow = testEnv(createDb(), { CITY_SCORE_TIMEOUT_MS: 40 });
  await withFetch((url, init) => new Promise((resolve, reject) => {
    const signal = init?.signal;
    const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  }), async () => {
    const started = Date.now();
    const page = await worker.fetch(new Request("https://sunsetping.com/sunset/austin"), slow);
    assert.equal(page.status, 200);
    assert.ok(Date.now() - started < 3000, "forecast timeout should not hang the city page");
    assert.match(await page.text(), /Checking tonight's sky in Austin/);
  });
});

test("a rendered city page is reused from the Workers cache", async () => {
  const forecast = austinForecast();
  const cache = memoryCache();
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  try {
    await withFetch(forecast.impl, async () => {
      const first = await worker.fetch(new Request("https://www.sunsetping.com/sunset/austin?utm=newsletter"), testEnv(createDb()));
      assert.equal(first.status, 200);
      assert.match(await first.text(), /6:59 PM CDT/);
      assert.equal(cache.store.size, 1);
      const calls = forecast.calls();
      const second = await worker.fetch(new Request("https://www.sunsetping.com/sunset/Austin"), testEnv(createDb()));
      assert.equal(second.status, 200);
      assert.match(await second.text(), /Sunset time today in Austin: 6:59 PM/);
      assert.equal(forecast.calls(), calls);
    });
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});

test("a failed forecast is not cached over the next successful render", async () => {
  const cache = memoryCache();
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  const env = testEnv(createDb());
  try {
    await withFetch(async () => {
      throw new Error("offline");
    }, async () => {
      const missed = await worker.fetch(new Request("https://sunsetping.com/sunset/austin"), env);
      assert.equal(missed.status, 200);
      assert.match(await missed.text(), /Checking tonight's sky in Austin/);
      assert.equal(cache.store.size, 0);
    });
    const forecast = austinForecast();
    await withFetch(forecast.impl, async () => {
      const live = await worker.fetch(new Request("https://sunsetping.com/sunset/austin"), env);
      assert.match(await live.text(), /6:59 PM CDT/);
      assert.equal(cache.store.size, 1);
    });
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});

test("IndexNow key file is served at the site root and matches the submit payload", async () => {
  const res = await worker.fetch(new Request(`https://sunsetping.com/${INDEXNOW_KEY}.txt`), testEnv(createDb()));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  assert.equal(await res.text(), INDEXNOW_KEY);
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");
  const found = loadIndexNowKey(publicDir);
  assert.equal(found.key, INDEXNOW_KEY);
  assert.equal(readFileSync(join(publicDir, found.filename), "utf8").trim(), INDEXNOW_KEY);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://sunsetping.com/</loc></url>
  <url><loc>https://sunsetping.com/sunset/austin</loc><lastmod>2026-10-15</lastmod></url>
</urlset>`;
  const payload = indexNowPayload(urlsFromSitemap(xml), found.key);
  assert.equal(payload.host, "sunsetping.com");
  assert.equal(payload.key, INDEXNOW_KEY);
  assert.equal(payload.keyLocation, `https://sunsetping.com/${INDEXNOW_KEY}.txt`);
  assert.deepEqual(payload.urlList, ["https://sunsetping.com/", "https://sunsetping.com/sunset/austin"]);
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../scripts/indexnow.mjs"), "utf8");
  assert.match(script, /https:\/\/api\.indexnow\.org\/indexnow/);
  assert.match(script, /Do not run this from CI/);
});
