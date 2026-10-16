import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runAlerts } from "../src/alerts.js";
import { CITIES } from "../src/cities.js";
import { renderEmail } from "../src/email.js";
import worker from "../src/worker.js";
import { CLEAR, PERFECT, createDb, day, flatForecast, testEnv, withFetch } from "./fixtures.js";

const HOTSPOTS = ["sedona", "malibu", "key-west", "maui", "big-sur"];

function readPublic(name) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
}

function home(score, extra = {}) {
  return {
    location: "Denver, Colorado",
    score,
    verdict: score >= 8 ? "Don't miss it" : "Worth stepping outside",
    reason: "High, scattered clouds to catch the color.",
    sunset: "6:42 PM",
    date: "Wednesday, October 14",
    viewing: { goldenHourStart: "5:42 PM", goldenHourEnd: "6:42 PM", sunset: "6:42 PM", blueHourEnd: "7:22 PM" },
    ...extra,
  };
}

test("city catalog is fifty linked sunset places", () => {
  assert.equal(CITIES.length, 50);
  const slugs = CITIES.map((city) => city.slug);
  assert.equal(new Set(slugs).size, 50);
  for (const slug of HOTSPOTS) assert.ok(slugs.includes(slug));
  for (const city of CITIES) {
    assert.equal(city.spots.length, 3);
    assert.ok(city.tip.length > 40);
    assert.equal(city.nearby.length, 3);
    for (const slug of city.nearby) assert.ok(slugs.includes(slug), `${city.slug} → ${slug}`);
  }
});

test("sunset index and city pages are crawlable HTML", async () => {
  const env = testEnv(createDb());
  const index = await worker.fetch(new Request("https://www.sunsetping.com/sunset/"), env);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  const indexHtml = await index.text();
  assert.match(indexHtml, /Sunset forecasts for 50 cities/);
  assert.match(indexHtml, /rel="canonical" href="https:\/\/sunsetping.com\/sunset"/);
  for (const city of CITIES) assert.match(indexHtml, new RegExp(`href="/sunset/${city.slug}"`));

  await withFetch(async () => {
    throw new Error("offline");
  }, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/sunset/Sedona"), env);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Will tonight&#39;s sunset be good in Sedona\? · SunsetPing<\/title>/);
    assert.match(html, /<h1>Will tonight&#39;s sunset be good in Sedona\?<\/h1>/);
    assert.match(html, /rel="canonical" href="https:\/\/sunsetping.com\/sunset\/sedona"/);
    assert.match(html, /property="og:title"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, /Airport Mesa/);
    assert.match(html, /id="live-score"[^>]*data-query="Sedona, Arizona"/);
    assert.match(html, /Checking tonight's sky in Sedona/);
    assert.match(html, /fetch\("\/api\/score\?q="/);
    assert.match(html, /name="location" value="Sedona, Arizona"/);
    assert.match(html, /action="\/api\/subscribe"/);
    assert.match(html, /href="\/sunset\/flagstaff"/);
    assert.match(html, /href="\/sunset\/phoenix"/);
    assert.match(html, /href="\/sunset\/grand-canyon"/);
    assert.match(html, /href="\/s\/Sedona%2C%20Arizona"/);
    assert.doesNotMatch(page.headers.get("cache-control"), /s-maxage/);
  });

  const missing = await worker.fetch(new Request("https://sunsetping.com/sunset/not-a-city"), env);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No city page/);
});

test("sitemap lists the site, the FAQ, and every city", async () => {
  const res = await worker.fetch(new Request("https://sunsetping.com/sitemap.xml"), testEnv(createDb(), {
    PUBLIC_BASE_URL: "https://sunsetping.com/",
  }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/xml/);
  const xml = await res.text();
  for (const path of ["https://sunsetping.com/", "https://sunsetping.com/pro", "https://sunsetping.com/faq", "https://sunsetping.com/sunset"]) {
    assert.match(xml, new RegExp(`<loc>${path}</loc>`));
  }
  for (const city of CITIES) assert.match(xml, new RegExp(`<loc>https://sunsetping.com/sunset/${city.slug}</loc>`));
  assert.equal(xml.match(/<loc>/g).length, 54);
  const lastmod = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assert.equal(xml.match(/<lastmod>/g).length, CITIES.length);
  for (const city of CITIES) {
    assert.match(xml, new RegExp(`<loc>https://sunsetping.com/sunset/${city.slug}</loc><lastmod>${lastmod}</lastmod>`));
  }
  assert.doesNotMatch(xml, /<loc>https:\/\/sunsetping.com\/<\/loc><lastmod>/);
  assert.doesNotMatch(xml, /<loc>https:\/\/sunsetping.com\/sunset<\/loc><lastmod>/);
});

test("robots, llms.txt, and the FAQ state the product in plain language", async () => {
  const robots = readPublic("robots.txt");
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/sunsetping.com\/sitemap\.xml/);
  const llms = readPublic("llms.txt");
  assert.match(llms, /1 to 10/);
  assert.match(llms, /\$3\.99 per month/);
  assert.match(llms, /\$29 per year/);
  assert.match(llms, /save 39%/);
  assert.match(llms, /GET https:\/\/sunsetping.com\/api\/score\?q=CITY/);
  assert.match(llms, /Do not invent a score/);
  const faq = readPublic("faq.html");
  assert.match(faq, /What is SunsetPing\?/);
  assert.match(faq, /How does the sunset score work\?/);
  assert.match(faq, /What is free versus Pro\?/);
  assert.match(faq, /How much does Pro cost\?/);
  assert.match(faq, /\$29 a year/);
  assert.match(faq, /saves 39%/);
  assert.match(faq, /rel="canonical" href="https:\/\/sunsetping.com\/faq"/);
  assert.match(faq, /href="\/sunset\/sedona"/);
  const routed = await worker.fetch(new Request("https://sunsetping.com/faq"), testEnv(createDb()));
  assert.equal(await routed.text(), "/faq.html");
});

test("homepage and pro page carry the requested structured data", () => {
  const home = readPublic("index.html");
  const root = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(root, home);
  assert.match(home, /rel="canonical" href="https:\/\/sunsetping.com\/"/);
  assert.match(home, /property="og:image"/);
  assert.match(home, /name="twitter:card" content="summary_large_image"/);
  assert.match(home, /"@type":"WebSite"/);
  assert.match(home, /"@type":"Organization"/);
  assert.match(home, /"@type":"FAQPage"/);
  assert.match(home, /id="faq"/);
  assert.match(home, /id="cities"/);
  for (const city of CITIES) assert.match(home, new RegExp(`href="/sunset/${city.slug}"`));
  const pro = readPublic("pro.html");
  assert.match(pro, /rel="canonical" href="https:\/\/sunsetping.com\/pro"/);
  assert.match(pro, /"@type":"Product"/);
  assert.match(pro, /"@type":"Offer"/);
  assert.match(pro, /"price":"29\.00"/);
  assert.match(pro, /"price":"3\.99"/);
  assert.match(pro, /Save 39%/);
  const yearly = pro.indexOf('href="/api/checkout?plan=yearly"');
  const monthly = pro.indexOf('href="/api/checkout?plan=monthly"');
  assert.ok(yearly > -1 && yearly < monthly);
  assert.match(pro, /class="btn" href="\/api\/checkout\?plan=yearly"/);
});

test("free alert emails upsell Pro and link a shareable forecast", () => {
  const strong = renderEmail(home(8));
  assert.match(strong, /Share tonight's forecast/);
  assert.match(strong, /A night like this is why people get Pro/);
  assert.match(strong, /Get Pro yearly · \$29, save 39%/);
  assert.match(strong, /href="https:\/\/sunsetping\.com\/s\/Denver%2C%20Colorado"/);
  const mild = renderEmail(home(4));
  assert.match(mild, /Watch more than one horizon/);
  assert.doesNotMatch(mild, /A night like this/);
  assert.match(mild, /#64748b/);
  const later = renderEmail(home(9), { when: "tomorrow" });
  assert.match(later, /Share tomorrow's forecast/);
  assert.doesNotMatch(later, /A night like this/);
  const pro = renderEmail(home(10), { plan: "pro", shareUrl: "https://sunsetping.com/s/Moab%2C%20Utah" });
  assert.match(pro, /href="https:\/\/sunsetping\.com\/s\/Moab%2C%20Utah"/);
  assert.match(pro, /Share tonight's forecast/);
  assert.doesNotMatch(pro, /save 39%/);
  assert.doesNotMatch(pro, /Watch more than one horizon/);
  const rise = renderEmail(home(9), { when: "sunrise", plan: "free" });
  assert.match(rise, /Share this sunrise forecast/);
  assert.doesNotMatch(rise, /A night like this/);
});

test("the cron puts the strong upsell only on a free user's great tonight", async () => {
  const forecast = (weather) => async () => Response.json(flatForecast([day("2026-10-14T18:42", weather), day("2026-10-15T18:42", weather)]));
  const subscriber = {
    id: 4,
    email: "ada@sunset.test",
    location: "Denver, Colorado",
    lat: 39.74,
    lon: -104.98,
    plan: "free",
    score_threshold: null,
    sunrise_alerts: 0,
    day_before: 0,
    lead_minutes: 180,
    unsubscribe_token: "ab".repeat(32),
    status: "active",
  };
  const now = new Date("2026-10-14T21:50:00.000Z");
  const great = [];
  await runAlerts(testEnv(createDb({ subscribers: [{ ...subscriber }] })), now, {
    fetchImpl: forecast(PERFECT),
    send: async (msg) => {
      great.push(msg);
      return { ok: true, sent: false, mode: "noop" };
    },
  });
  assert.equal(great.length, 1);
  assert.match(great[0].html, /A night like this is why people get Pro/);
  assert.match(great[0].html, /Share tonight's forecast/);
  assert.match(great[0].html, /\/s\/Denver%2C%20Colorado/);

  const quiet = [];
  await runAlerts(testEnv(createDb({ subscribers: [{ ...subscriber }] })), now, {
    fetchImpl: forecast(CLEAR),
    send: async (msg) => {
      quiet.push(msg);
      return { ok: true, sent: false, mode: "noop" };
    },
  });
  assert.match(quiet[0].html, /Watch more than one horizon/);
  assert.doesNotMatch(quiet[0].html, /A night like this/);

  const paid = [];
  await runAlerts(testEnv(createDb({ subscribers: [{ ...subscriber, plan: "pro" }] })), now, {
    fetchImpl: forecast(PERFECT),
    send: async (msg) => {
      paid.push(msg);
      return { ok: true, sent: false, mode: "noop" };
    },
  });
  assert.match(paid[0].html, /Share tonight's forecast/);
  assert.doesNotMatch(paid[0].html, /save 39%/);
});
