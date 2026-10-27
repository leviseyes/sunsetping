import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CITIES } from "../src/cities.js";
import { usTonightLabel } from "../src/growth.js";
import { citiesWithCoords, TONIGHT_BATCH_SIZE } from "../src/tonight.js";
import worker from "../src/worker.js";
import { CLEAR, PERFECT, WASHED, createDb, day, flatForecast, testEnv, withFetch } from "./fixtures.js";

const MID = { low: 10, mid: 15, high: 12, humidity: 70, visibility: 15000, precipitation: 0 };

function weatherFor(city) {
  if (city.slug === "sedona") return PERFECT;
  if (city.slug === "seattle") return CLEAR;
  if (city.slug === "malibu") return WASHED;
  return MID;
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

function forecastMock({ fail = "none" } = {}) {
  const urls = [];
  let calls = 0;
  const impl = async (url) => {
    calls += 1;
    const raw = String(url);
    if (raw.includes("geocoding-api") || raw.includes("zippopotam")) {
      throw new Error("tonight ranking geocoded a city: " + raw);
    }
    if (fail === "all") throw new Error("open-meteo down");
    const parsed = new URL(raw);
    const lats = parsed.searchParams.get("latitude").split(",").map(Number);
    assert.ok(lats.length > 1, "forecast call should batch coordinates");
    const first = CITIES.find((city) => Math.abs(city.lat - lats[0]) < 1e-4);
    assert.ok(first, "batch latitude is not in the catalog");
    const index = CITIES.findIndex((city) => city.slug === first.slug);
    if (fail === "partial" && index >= TONIGHT_BATCH_SIZE && index < TONIGHT_BATCH_SIZE * 2) {
      throw new Error("batch down");
    }
    urls.push(raw);
    const body = lats.map((lat) => {
      const city = CITIES.find((entry) => Math.abs(entry.lat - lat) < 1e-4);
      if (!city) throw new Error("unknown latitude " + lat);
      return flatForecast([day("2026-10-22T18:30", weatherFor(city))], city.timezone);
    });
    return Response.json(body);
  };
  return { impl, urls, calls: () => calls };
}

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((block) => JSON.parse(block[1]));
}

function decode(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function rankingRows(html) {
  const list = html.match(/<ol class="tonight-list">([\s\S]*?)<\/ol>/);
  assert.ok(list, "ranked list");
  return [...list[1].matchAll(/href="\/sunset\/([^"]+)"[\s\S]*?class="tonight-rank">(\d+)<\/span>[\s\S]*?<strong>([^<]+)<\/strong><span>([^<]+)<\/span>[\s\S]*?class="tonight-score">(\d+)\/10<\/span>[\s\S]*?class="tonight-verdict">([^<]+)<\/span>[\s\S]*?class="tonight-time">Sunset ([^<]+)<\/span>/g)].map((match) => ({
    slug: match[1],
    rank: Number(match[2]),
    city: decode(match[3]),
    region: decode(match[4]),
    score: Number(match[5]),
    verdict: decode(match[6]),
    sunset: decode(match[7]),
  }));
}

test("every catalog city has coordinates for the batched tonight forecast", () => {
  assert.equal(CITIES.length, 65);
  assert.equal(citiesWithCoords().length, 65);
  assert.equal(Math.ceil(CITIES.length / TONIGHT_BATCH_SIZE), 3);
  assert.ok(Math.ceil(CITIES.length / TONIGHT_BATCH_SIZE) <= 5);
  for (const city of CITIES) {
    assert.ok(city.lat > 18 && city.lat < 50, city.slug);
    assert.ok(city.lon < -65 && city.lon > -165, city.slug);
    assert.match(city.timezone, /^[A-Za-z]+\/[A-Za-z_]+$/);
  }
});

test("/tonight ranks all 65 cities in a handful of forecast requests", async () => {
  const forecast = forecastMock();
  const env = testEnv(createDb());
  await withFetch(forecast.impl, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/tonight"), env);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("cache-control"), /s-maxage=1500/);
    assert.equal(forecast.calls(), Math.ceil(CITIES.length / TONIGHT_BATCH_SIZE));
    assert.ok(forecast.calls() <= 5);
    const points = forecast.urls.flatMap((url) => new URL(url).searchParams.get("latitude").split(","));
    assert.equal(points.length, CITIES.length);
    const html = await page.text();
    const date = usTonightLabel();
    assert.match(html, new RegExp(`<title>Best Sunsets Tonight in the US \\(${date.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) \\| SunsetPing</title>`));
    assert.match(html, /name="description" content="[^"]*Tonight&#39;s best sunsets across 65 US cities/);
    assert.match(html, /rel="canonical" href="https:\/\/sunsetping.com\/tonight"/);
    assert.match(html, /property="og:image" content="https:\/\/sunsetping.com\/images\/hero-sunset.jpg"/);
    assert.match(html, /name="twitter:image" content="https:\/\/sunsetping.com\/images\/hero-sunset.jpg"/);
    assert.doesNotMatch(html, /(property|name)="(og|twitter):[^"]*" content="[^"]*\d+\/10/);
    const hero = html.indexOf('id="hero-email"');
    const listAt = html.indexOf('class="tonight-list"');
    const lower = html.indexOf('id="signup"');
    assert.ok(hero > 0 && hero < listAt && lower > 0 && lower < listAt, "one signup form, above the list");
    assert.match(html, /id="hero-email"/);

    assert.match(html, /type="hidden" name="tz"/);
    assert.match(html, /Email me when a sunset is worth it/);
    assert.match(html, /data-signup/);
    assert.match(html, /Sample alert: (?:&quot;|")Sedona tonight: 10\/10/);
    const rows = rankingRows(html);
    assert.equal(rows.length, 65);
    assert.deepEqual(rows.map((row) => row.rank), Array.from({ length: 65 }, (_, i) => i + 1));
    assert.equal(rows[0].slug, "sedona");
    assert.equal(rows[0].city, "Sedona");
    assert.equal(rows[0].region, "Arizona");
    assert.equal(rows[0].score, 10);
    assert.equal(rows[0].verdict, "Don't miss it");
    assert.match(rows[0].sunset, /6:30 PM/);
    assert.equal(rows.at(-1).slug, "malibu");
    assert.equal(rows.at(-1).score, 1);
    const seattle = rows.find((row) => row.slug === "seattle");
    assert.equal(seattle.score, 6);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].score <= rows[i - 1].score);
    const list = jsonLdBlocks(html).find((block) => block["@type"] === "ItemList");
    assert.equal(list.name, `Best sunsets tonight in the US (${date})`);
    assert.equal(list.numberOfItems, 65);
    assert.equal(list.itemListElement.length, 65);
    assert.equal(list.itemListElement[0].position, 1);
    assert.equal(list.itemListElement[0].url, "https://sunsetping.com/sunset/sedona");
    assert.equal(list.itemListElement[0].name, "Sedona, Arizona");
    assert.match(list.itemListElement[0].description, /10\/10/);
    const api = await worker.fetch(new Request("https://sunsetping.com/api/tonight"), env);
    assert.equal(api.status, 200);
    assert.match(api.headers.get("content-type"), /application\/json/);
    assert.match(api.headers.get("cache-control"), /s-maxage=1500/);
    const data = await api.json();
    assert.equal(data.date, date);
    assert.equal(data.ranking.length, 65);
    assert.deepEqual(data.ranking.map((row) => row.slug), rows.map((row) => row.slug));
    assert.deepEqual(data.ranking.map((row) => row.rank), rows.map((row) => row.rank));
    assert.equal(data.ranking[0].score, 10);
    assert.equal(data.ranking[0].verdict, "Don't miss it");
    assert.equal(forecast.calls(), Math.ceil(CITIES.length / TONIGHT_BATCH_SIZE) * 2);
  });
});

test("/tonight lists the cities that scored when one forecast batch fails", async () => {
  const forecast = forecastMock({ fail: "partial" });
  await withFetch(forecast.impl, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/tonight"), testEnv(createDb()));
    assert.equal(page.status, 200);
    assert.ok(forecast.calls() <= 5);
    assert.equal(forecast.calls(), Math.ceil(CITIES.length / TONIGHT_BATCH_SIZE));
    const html = await page.text();
    const dropped = CITIES.slice(TONIGHT_BATCH_SIZE, TONIGHT_BATCH_SIZE * 2);
    const rows = rankingRows(html);
    assert.equal(rows.length, CITIES.length - dropped.length);
    assert.match(html, new RegExp(`Showing ${rows.length} of ${CITIES.length} cities`));
    assert.match(html, /id="hero-email"/);
    assert.match(html, /data-signup/);
    for (const city of dropped) assert.equal(rows.some((row) => row.slug === city.slug), false, city.slug);
    assert.equal(rows.some((row) => row.slug === "sedona"), true);
    assert.equal(rows.some((row) => row.slug === "austin"), true);
    assert.match(page.headers.get("cache-control"), /s-maxage=1500/);
  });
});

test("/tonight stays a 200 signup page when every forecast fails", async () => {
  const forecast = forecastMock({ fail: "all" });
  await withFetch(forecast.impl, async () => {
    const env = testEnv(createDb());
    const page = await worker.fetch(new Request("https://sunsetping.com/tonight"), env);
    assert.equal(page.status, 200);
    assert.equal(forecast.calls(), Math.ceil(CITIES.length / TONIGHT_BATCH_SIZE));
    assert.ok(forecast.calls() <= 5);
    assert.doesNotMatch(page.headers.get("cache-control") || "", /s-maxage/);
    const html = await page.text();
    assert.match(html, /<h1>Best sunsets tonight in the US<\/h1>/);
    assert.match(html, /Tonight's scores didn't load/);
    assert.match(html, /id="hero-email"/);
    assert.match(html, /id="signup"/);
    assert.match(html, /Sample alert \(example\)/);
    assert.doesNotMatch(html, /class="tonight-list"/);
    for (const city of CITIES) assert.match(html, new RegExp(`href="/sunset/${city.slug}"`));
    const api = await worker.fetch(new Request("https://sunsetping.com/api/tonight"), env);
    assert.equal(api.status, 200);
    const data = await api.json();
    assert.deepEqual(data.ranking, []);
    assert.match(data.error, /temporarily unavailable/);
    assert.doesNotMatch(api.headers.get("cache-control") || "", /s-maxage/);
  });
});

test("a rendered /tonight page is reused from the Workers cache", async () => {
  const forecast = forecastMock();
  const cache = memoryCache();
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  try {
    await withFetch(forecast.impl, async () => {
      const env = testEnv(createDb());
      const first = await worker.fetch(new Request("https://sunsetping.com/tonight?utm=newsletter"), env);
      assert.equal(first.status, 200);
      assert.match(await first.text(), /Sedona/);
      assert.equal(forecast.calls(), 3);
      assert.equal(cache.store.size, 1);
      const second = await worker.fetch(new Request("https://sunsetping.com/tonight"), env);
      assert.equal(second.status, 200);
      assert.equal(forecast.calls(), 3);
      assert.match(await second.text(), /class="tonight-list"/);
    });
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});

test("/tonight is linked from the homepage, the city index, and the sitemap", async () => {
  const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const root = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(root, home);
  assert.match(home, /<a href="\/tonight">See tonight's best sunsets across the US<\/a>/);
  const index = await worker.fetch(new Request("https://sunsetping.com/sunset"), testEnv(createDb()));
  assert.match(await index.text(), /<a href="\/tonight">See tonight's best sunsets across the US<\/a>/);
  const res = await worker.fetch(new Request("https://sunsetping.com/sitemap.xml"), testEnv(createDb()));
  const xml = await res.text();
  const lastmod = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assert.match(xml, new RegExp(`<loc>https://sunsetping.com/tonight</loc><lastmod>${lastmod}</lastmod>`));
  const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.match(llms, /## Best sunsets tonight/);
  assert.match(llms, /https:\/\/sunsetping.com\/tonight/);
  assert.match(llms, /Do not invent a score/);
});

test("/tonight answers 'where is the best sunset tonight' with FAQPage JSON-LD from the same ranking", async () => {
  const forecast = forecastMock();
  const env = testEnv(createDb());
  await withFetch(forecast.impl, async () => {
    const html = await (await worker.fetch(new Request("https://sunsetping.com/tonight"), env)).text();
    const rows = rankingRows(html);
    const faq = jsonLdBlocks(html).find((block) => block["@type"] === "FAQPage");
    assert.ok(faq, "FAQPage JSON-LD");
    assert.equal(faq.mainEntity[0].name, "Where is the best sunset in the US tonight?");
    const answer = faq.mainEntity[0].acceptedAnswer.text;
    assert.match(answer, new RegExp(`${rows[0].score}/10`));
    assert.match(answer, /Sedona/);
    const listAt = html.indexOf('class="tonight-list"');
    const qaAt = html.indexOf('class="city-qa"');
    assert.ok(qaAt > listAt, "quick answers sit below the list");
    for (const item of faq.mainEntity) assert.ok(html.includes(`<h3>${item.name}</h3>`), "visible question " + item.name);
    assert.equal(html.indexOf('id="hero-email"', html.indexOf('id="hero-email"') + 1), -1, "no extra signup form");
  });
});

test("/tonight has no quick answers when scores fail", async () => {
  const forecast = forecastMock({ fail: "all" });
  const env = testEnv(createDb());
  await withFetch(forecast.impl, async () => {
    const html = await (await worker.fetch(new Request("https://sunsetping.com/tonight"), env)).text();
    assert.ok(!jsonLdBlocks(html).some((block) => block["@type"] === "FAQPage"));
    assert.doesNotMatch(html, /class="city-qa"/);
  });
});

test("llms.txt links every catalog city page and mentions both PDFs", () => {
  const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  for (const city of CITIES) {
    assert.ok(llms.includes(`https://sunsetping.com/sunset/${city.slug})`), city.slug);
    assert.ok(llms.includes(`https://sunsetping.com/sunset-time/${city.slug})`), city.slug);
    assert.ok(llms.includes(`https://sunsetping.com/golden-hour/${city.slug})`), city.slug);
  }
  assert.match(llms, /MOSH Planner PDF/);
  assert.match(llms, /cheat sheet PDF/);
  assert.match(llms, /## Sunset time today/);
});
