import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CITIES } from "../src/cities.js";
import worker from "../src/worker.js";
import { MOSH_BONUS } from "../src/signup.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

function jsonLdBlocks(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((block) => JSON.parse(block[1]));
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

function forecastFor(city, { timezone, latitude, longitude, sunset }) {
  let calls = 0;
  const impl = async (url) => {
    calls += 1;
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return Response.json(geocodeBody({
        name: city.city,
        admin1: city.region,
        latitude,
        longitude,
        timezone,
      }));
    }
    if (u.includes("api.open-meteo.com")) {
      return Response.json(flatForecast([day(sunset, PERFECT)], timezone));
    }
    throw new Error("unexpected fetch " + u);
  };
  return { impl, calls: () => calls };
}

const WASHINGTON = {
  slug: "washington-dc",
  timezone: "America/New_York",
  latitude: 38.9072,
  longitude: -77.0369,
  sunset: "2026-10-14T18:42",
  phrase: "Golden Hour Today in Washington: 5:42\u20136:42 PM EDT",
  blue: "Blue hour in Washington today (Wednesday, October 14) is 6:42\u20137:22 PM EDT.",
  golden: "Evening golden hour in Washington today (Wednesday, October 14) is 5:42\u20136:42 PM EDT.",
  score: "Tonight's sunset score in Washington is 10/10: Don't miss it. High, scattered clouds to catch the color.",
  firstGolden: "5:42\u20136:42 PM EDT",
  firstSunset: "6:42 PM EDT",
};

const SEATTLE = {
  slug: "seattle",
  timezone: "America/Los_Angeles",
  latitude: 47.6062,
  longitude: -122.3321,
  sunset: "2026-10-14T19:05",
  phrase: "Golden Hour Today in Seattle: 6:05\u20137:05 PM PDT",
  blue: "Blue hour in Seattle today (Wednesday, October 14) is 7:05\u20137:45 PM PDT.",
  golden: "Evening golden hour in Seattle today (Wednesday, October 14) is 6:05\u20137:05 PM PDT.",
  score: "Tonight's sunset score in Seattle is 10/10: Don't miss it. High, scattered clouds to catch the color.",
  firstGolden: "6:05\u20137:05 PM PDT",
  firstSunset: "7:05 PM PDT",
};

function assertGoldenPage(html, city, spec) {
  assert.match(html, new RegExp(`<title>${spec.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · SunsetPing</title>`));
  assert.match(html, new RegExp(`<h1>${spec.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</h1>`));
  assert.match(html, new RegExp(`rel="canonical" href="https://sunsetping.com/golden-hour/${city.slug}"`));
  assert.match(html, new RegExp(`property="og:image" content="https://sunsetping.com/og/${city.slug}.png\\?v=3"`));
  assert.doesNotMatch(html, /(property|name)="(og|twitter):[^"]*" content="[^"]*\d+\/10/);
  assert.match(html, /property="og:title"/);
  assert.match(html, /name="description"/);
  assert.match(html, /Golden hour for the next 7 days is listed on this page/);
  assert.match(html, new RegExp(spec.golden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, new RegExp(spec.blue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, /<p class="city-score"><strong>10\/10<\/strong>/);
  assert.match(html, /High, scattered clouds to catch the color/);
  assert.match(html, new RegExp(city.spots[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, new RegExp(city.tip.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(html, new RegExp(`href="/sunset/${city.slug}"`));
  assert.match(html, new RegExp(`href="/sunset-time/${city.slug}"`));
  assert.match(html, /id="signup"/);
  assert.match(html, /action="\/api\/subscribe"/);
  assert.match(html, /name="great_only"/);
  assert.match(html, /Only email me on great nights \(8\+\)/);
  assert.match(html, /class="perk-list"/);
  assert.match(html, /8\+ only alerts/);
  assert.match(html, new RegExp(`name="location" value="${city.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  const week = html.match(/<section class="week-times"[\s\S]*?<\/section>/);
  assert.ok(week, "golden hour week table");
  assert.match(week[0], new RegExp(`Golden hour this week in ${city.city}`));
  assert.match(week[0], /<th scope="col">Date<\/th><th scope="col">Golden hour<\/th><th scope="col">Sunset<\/th>/);
  const rows = [...week[0].matchAll(/<tr><td><time datetime="([^"]+)">([^<]+)<\/time><\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><\/tr>/g)];
  assert.equal(rows.length, 7);
  assert.equal(rows[0][1], "2026-10-14");
  assert.equal(rows[0][3], spec.firstGolden);
  assert.equal(rows[0][4], spec.firstSunset);
  assert.doesNotMatch(week[0], /\/10/);
  const pairs = cityQa(html);
  assert.deepEqual(pairs.map((pair) => pair.q), [
    `When is golden hour today in ${city.city}?`,
    `When is blue hour today in ${city.city}?`,
    `Is tonight a good sunset for photos in ${city.city}?`,
    `Where to shoot golden hour in ${city.city}?`,
  ]);
  assert.equal(pairs[0].a, spec.golden);
  assert.equal(pairs[1].a, spec.blue);
  assert.equal(pairs[2].a, spec.score);
  assert.match(pairs[3].a, new RegExp(city.spots[0]));
  assert.match(pairs[3].a, new RegExp(city.tip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const blocks = jsonLdBlocks(html);
  const faq = blocks.find((block) => block["@type"] === "FAQPage");
  assert.ok(faq);
  assert.equal(faq.mainEntity.length, pairs.length);
  for (const pair of pairs) {
    const entry = faq.mainEntity.find((item) => item.name === pair.q);
    assert.equal(entry.acceptedAnswer.text, pair.a);
  }
  const crumbs = blocks.find((block) => block["@type"] === "BreadcrumbList");
  assert.deepEqual(crumbs.itemListElement.map((item) => item.name), ["Home", "Golden hour", city.city]);
  assert.deepEqual(crumbs.itemListElement.map((item) => item.item), [
    "https://sunsetping.com/",
    "https://sunsetping.com/golden-hour",
    `https://sunsetping.com/golden-hour/${city.slug}`,
  ]);
  assert.deepEqual(crumbs.itemListElement.map((item) => item.position), [1, 2, 3]);
}

test("golden-hour pages render tonight's light, JSON-LD, and the signup form", async () => {
  const washington = CITIES.find((city) => city.slug === WASHINGTON.slug);
  const seattle = CITIES.find((city) => city.slug === SEATTLE.slug);
  const dcForecast = forecastFor(washington, WASHINGTON);
  await withFetch(dcForecast.impl, async () => {
    const env = testEnv(createDb(), { MOSH_PDF_URL: "https://cdn.example/mosh.pdf" });
    dcForecast.calls();
    const before = dcForecast.calls();
    const timePage = await worker.fetch(new Request("https://sunsetping.com/sunset-time/washington-dc"), env);
    const timeCalls = dcForecast.calls() - before;
    const goldenStart = dcForecast.calls();
    const page = await worker.fetch(new Request("https://sunsetping.com/golden-hour/washington-dc"), env);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(page.headers.get("cache-control"), /s-maxage=1500/);
    assert.equal(dcForecast.calls() - goldenStart, timeCalls);
    const html = await page.text();
    assertGoldenPage(html, washington, WASHINGTON);
    assert.match(html, /data-mosh-bonus/);
    assert.match(html, new RegExp(MOSH_BONUS.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const timeHtml = await timePage.text();
    assert.match(timeHtml, /href="\/golden-hour\/washington-dc"/);
    const sunset = await worker.fetch(new Request("https://sunsetping.com/sunset/washington-dc"), env);
    assert.match(await sunset.text(), /href="\/golden-hour\/washington-dc"/);
  });

  const seaForecast = forecastFor(seattle, SEATTLE);
  await withFetch(seaForecast.impl, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/golden-hour/seattle"), testEnv(createDb()));
    assert.equal(page.status, 200);
    const html = await page.text();
    assertGoldenPage(html, seattle, SEATTLE);
    assert.doesNotMatch(html, /data-mosh-bonus/);
    assert.doesNotMatch(html, /MOSH Planner/);
    assert.match(html, /name="great_only"/);
  });
});

test("a golden-hour page stays 200 when the forecast fails", async () => {
  await withFetch(async () => {
    throw new Error("open-meteo down");
  }, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/golden-hour/seattle"), testEnv(createDb()));
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control"), /max-age=60/);
    assert.doesNotMatch(page.headers.get("cache-control") || "", /s-maxage/);
    const html = await page.text();
    assert.match(html, /<h1>Golden Hour Today in Seattle<\/h1>/);
    assert.match(html, /<title>Golden Hour Today in Seattle · SunsetPing<\/title>/);
    assert.match(html, /Checking tonight's sky in Seattle/);
    assert.match(html, /Kerry Park/);
    assert.match(html, /id="signup"/);
    assert.match(html, /action="\/api\/subscribe"/);
    assert.match(html, /href="\/sunset\/seattle"/);
    assert.match(html, /href="\/sunset-time\/seattle"/);
    assert.doesNotMatch(html, /When is golden hour today in Seattle/);
    assert.doesNotMatch(html, /When is blue hour today in Seattle/);
    assert.doesNotMatch(html, /Is tonight a good sunset for photos in Seattle/);
    const pairs = cityQa(html);
    assert.deepEqual(pairs.map((pair) => pair.q), ["Where to shoot golden hour in Seattle?"]);
    const faq = jsonLdBlocks(html).find((block) => block["@type"] === "FAQPage");
    assert.equal(faq.mainEntity.length, 1);
    assert.equal(faq.mainEntity[0].acceptedAnswer.text, pairs[0].a);
  });
});

test("golden-hour index lists every city and unknown slugs are 404", async () => {
  const index = await worker.fetch(new Request("https://sunsetping.com/golden-hour"), testEnv(createDb()));
  assert.equal(index.status, 200);
  const html = await index.text();
  assert.match(html, /rel="canonical" href="https:\/\/sunsetping.com\/golden-hour"/);
  assert.equal(html.match(/href="\/golden-hour\//g).length, CITIES.length);
  for (const city of CITIES) assert.match(html, new RegExp(`href="/golden-hour/${city.slug}"`));
  const crumbs = jsonLdBlocks(html).find((block) => block["@type"] === "BreadcrumbList");
  assert.deepEqual(crumbs.itemListElement.map((item) => item.name), ["Home", "Golden hour"]);
  assert.deepEqual(crumbs.itemListElement.map((item) => item.item), [
    "https://sunsetping.com/",
    "https://sunsetping.com/golden-hour",
  ]);
  const missing = await worker.fetch(new Request("https://sunsetping.com/golden-hour/not-a-city"), testEnv(createDb()));
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No city page/);
});

test("sitemap and llms.txt include golden hour", async () => {
  const res = await worker.fetch(new Request("https://sunsetping.com/sitemap.xml"), testEnv(createDb()));
  const xml = await res.text();
  assert.match(xml, /<loc>https:\/\/sunsetping.com\/golden-hour<\/loc>/);
  for (const city of CITIES) {
    assert.match(xml, new RegExp(`<loc>https://sunsetping.com/golden-hour/${city.slug}</loc>`));
  }
  const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.match(llms, /## Golden hour/);
  assert.match(llms, /https:\/\/sunsetping.com\/golden-hour\/<city-slug>/);
  assert.match(llms, /https:\/\/sunsetping.com\/golden-hour\)/);
});
