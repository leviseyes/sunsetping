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

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((block) => JSON.parse(block[1]));
}

function jsonLd(html) {
  const page = jsonLdBlocks(html).find((block) => block["@type"] === "WebPage");
  assert.ok(page, "WebPage JSON-LD");
  return page;
}

function decodeText(value) {
  return String(value)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cityQa(html) {
  const section = html.match(/<section class="city-qa"[\s\S]*?<\/section>/);
  assert.ok(section, "quick answers section");
  return [...section[0].matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((pair) => ({
    q: decodeText(pair[1]),
    a: decodeText(pair[2]),
  }));
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
    assert.match(html, /property="og:title" content="Sunset time today in Austin: 6:59 PM · tonight 10\/10 · SunsetPing"/);
    assert.match(html, /name="twitter:title" content="Sunset time today in Austin: 6:59 PM · tonight 10\/10 · SunsetPing"/);
    assert.match(html, /property="og:image" content="https:\/\/sunsetping.com\/og\/austin.png\?v=2"/);
    assert.match(html, /name="description" content="[^"]*Sunset time today in Austin is 6:59 PM CDT[^"]*10\/10/);
    assert.match(html, /<h1>Will tonight&#39;s sunset be good in Austin\?<\/h1>/);
    assert.match(html, /<p class="city-score"><strong>10\/10<\/strong>/);
    assert.match(html, /Sunset 6:59 PM CDT\./);
    assert.match(html, /fetch\("\/api\/score\?q="/);
    assert.match(html, /id="signup"/);
    assert.match(html, /Know when the light will be good before you drive out/);
    assert.match(html, /action="\/api\/subscribe"/);
    assert.match(html, /class="signup-sticky"/);
    assert.match(html, /class="footer-signup"/);
    assert.match(html, /name="location" value="Austin, Texas"/);
    assert.match(html, /Mount Bonnell/);
    const pairs = cityQa(html);
    assert.deepEqual(pairs.map((pair) => pair.q), [
      "What time is sunset in Austin today?",
      "When is golden hour in Austin tonight?",
      "Will the sunset be good in Austin tonight?",
      "Where is the best place to watch the sunset in Austin?",
    ]);
    assert.equal(pairs[0].a, "Sunset in Austin today (Thursday, October 15) is at 6:59 PM CDT.");
    assert.equal(pairs[1].a, "Golden hour in Austin tonight runs 5:59-6:59 PM and blue hour ends 7:39 PM.");
    assert.equal(pairs[2].a, "Tonight's SunsetPing score is 10/10: Don't miss it. The score uses cloud layers, humidity, and visibility. 8 or above means don't miss it.");
    assert.equal(pairs[3].a, "People watch the sunset in Austin from Mount Bonnell, 360 Bridge overlook, and Lady Bird Lake.");
    const blocks = jsonLdBlocks(html);
    const faq = blocks.find((block) => block["@type"] === "FAQPage");
    assert.ok(faq);
    assert.equal(faq.mainEntity.length, pairs.length);
    for (const pair of pairs) {
      const entry = faq.mainEntity.find((item) => item.name === pair.q);
      assert.equal(entry.acceptedAnswer.text, pair.a);
    }
    const crumbs = blocks.find((block) => block["@type"] === "BreadcrumbList");
    assert.deepEqual(crumbs.itemListElement.map((item) => item.name), ["Home", "Sunset cities", "Austin"]);
    assert.deepEqual(crumbs.itemListElement.map((item) => item.item), [
      "https://sunsetping.com/",
      "https://sunsetping.com/sunset",
      "https://sunsetping.com/sunset/austin",
    ]);
    assert.deepEqual(crumbs.itemListElement.map((item) => item.position), [1, 2, 3]);
    const ld = jsonLd(html);
    assert.equal(ld["@type"], "WebPage");
    assert.equal(ld.dateModified, "2026-10-15");
    assert.equal(ld.about["@type"], "Place");
    assert.equal(ld.about.name, "Austin, Texas");
    assert.equal(ld.isPartOf["@type"], "WebSite");
    assert.match(ld.description, /Golden hour runs 5:59-6:59 PM and blue hour ends 7:39 PM/);
    assert.match(ld.description, /10\/10/);
    assert.match(ld.name, /Sunset time today in Austin/);
    assert.match(html, /name="description" content="[^"]*Sunset times for the next 7 days are listed on this page/);
    const week = html.match(/<section class="week-times"[\s\S]*?<\/section>/);
    assert.ok(week, "week sunset table");
    assert.match(week[0], /Sunset times this week in Austin/);
    assert.match(week[0], /Local time \(CDT, America\/Chicago\)/);
    assert.match(week[0], /Golden hour starts 60 minutes before sunset/);
    assert.match(week[0], /href="#signup">Get free sunset and golden-hour alerts/);
    assert.doesNotMatch(week[0], /\/pro/);
    assert.doesNotMatch(week[0], /\/10/);
    assert.doesNotMatch(week[0], /Don't miss it|Worth stepping outside|Probably skip/);
    const rows = [...week[0].matchAll(/<tr><td><time datetime="([^"]+)">([^<]+)<\/time><\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><\/tr>/g)];
    assert.deepEqual(rows.map((row) => [row[1], row[2], row[3], row[4]]), [
      ["2026-10-15", "Thu, Oct 15", "6:59 PM CDT", "5:59 PM CDT"],
      ["2026-10-16", "Fri, Oct 16", "6:58 PM CDT", "5:58 PM CDT"],
      ["2026-10-17", "Sat, Oct 17", "6:57 PM CDT", "5:57 PM CDT"],
      ["2026-10-18", "Sun, Oct 18", "6:56 PM CDT", "5:56 PM CDT"],
      ["2026-10-19", "Mon, Oct 19", "6:55 PM CDT", "5:55 PM CDT"],
      ["2026-10-20", "Tue, Oct 20", "6:54 PM CDT", "5:54 PM CDT"],
      ["2026-10-21", "Wed, Oct 21", "6:53 PM CDT", "5:53 PM CDT"],
    ]);
    const list = blocks.find((block) => block["@type"] === "ItemList");
    assert.equal(list.name, "Sunset times this week in Austin");
    assert.equal(list.numberOfItems, 7);
    assert.equal(list.itemListElement.length, 7);
    assert.equal(list.itemListElement[0].name, "Thursday, October 15");
    assert.equal(list.itemListElement[0].description, "Sunset 6:59 PM CDT. Golden hour starts 5:59 PM CDT.");
    assert.equal(list.itemListElement[6].position, 7);
    assert.doesNotMatch(JSON.stringify(list), /\/10|score/i);

    const timePage = await worker.fetch(new Request("https://sunsetping.com/sunset-time/austin"), testEnv(createDb()));
    assert.equal(timePage.status, 200);
    const timeHtml = await timePage.text();
    assert.match(timeHtml, /<h1>What time is sunset today in Austin\?<\/h1>/);
    assert.match(timeHtml, /rel="canonical" href="https:\/\/sunsetping.com\/sunset-time\/austin"/);
    assert.match(timeHtml, /<title>Sunset Time Today in Austin: 6:59 PM \(10\/10\) · SunsetPing<\/title>/);
    assert.match(timeHtml, /property="og:title" content="Sunset Time Today in Austin: 6:59 PM \(10\/10\) · SunsetPing"/);
    assert.match(timeHtml, /property="og:image" content="https:\/\/sunsetping.com\/og\/austin.png\?v=2"/);
    assert.match(timeHtml, /Sunset times this week in Austin/);
    assert.match(timeHtml, /datetime="2026-10-21"/);
    assert.match(timeHtml, /Sunset times for the next 7 days are listed on this page/);
    assert.match(timeHtml, /id="signup"/);
    assert.match(timeHtml, /action="\/api\/subscribe"/);
    assert.match(timeHtml, /name="location" value="Austin, Texas"/);
    assert.match(timeHtml, /Know when the light will be good before you drive out/);
    const timeList = jsonLdBlocks(timeHtml).find((block) => block["@type"] === "ItemList");
    assert.equal(timeList.itemListElement.length, 7);
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
    assert.doesNotMatch(html, /Sunset times this week/);
    assert.doesNotMatch(html, /id="sunset-week"/);
    assert.doesNotMatch(html, /What time is sunset in Austin today/);
    assert.doesNotMatch(html, /When is golden hour in Austin tonight/);
    assert.doesNotMatch(html, /Will the sunset be good in Austin tonight/);
    const pairs = cityQa(html);
    assert.deepEqual(pairs.map((pair) => pair.q), ["Where is the best place to watch the sunset in Austin?"]);
    assert.equal(pairs[0].a, "People watch the sunset in Austin from Mount Bonnell, 360 Bridge overlook, and Lady Bird Lake.");
    const blocks = jsonLdBlocks(html);
    const faq = blocks.find((block) => block["@type"] === "FAQPage");
    assert.equal(faq.mainEntity.length, 1);
    assert.equal(faq.mainEntity[0].name, pairs[0].q);
    assert.equal(faq.mainEntity[0].acceptedAnswer.text, pairs[0].a);
    assert.ok(blocks.some((block) => block["@type"] === "BreadcrumbList"));
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
