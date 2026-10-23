import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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

function visibleText(value) {
  return String(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|li|h2|ul|div|section)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function faqPairs(html) {
  const main = html.match(/<main[\s\S]*?<\/main>/)[0];
  return main.split(/<h2>/).slice(1).map((chunk) => {
    const [question, rest] = chunk.split("</h2>");
    return { q: visibleText(question), a: visibleText(rest) };
  });
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

test("city catalog is sixty-five linked sunset places", () => {
  assert.equal(CITIES.length, 65);
  const slugs = CITIES.map((city) => city.slug);
  assert.equal(new Set(slugs).size, 65);
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
  assert.match(indexHtml, new RegExp(`Sunset forecasts for ${CITIES.length} cities`));
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
  for (const path of ["https://sunsetping.com/", "https://sunsetping.com/faq", "https://sunsetping.com/sunset"]) {
    assert.match(xml, new RegExp(`<loc>${path}</loc>`));
  }
  assert.doesNotMatch(xml, /<loc>https:\/\/sunsetping\.com\/pro<\/loc>/);
  for (const city of CITIES) assert.match(xml, new RegExp(`<loc>https://sunsetping.com/sunset/${city.slug}</loc>`));
  for (const city of CITIES) assert.match(xml, new RegExp(`<loc>https://sunsetping.com/sunset-time/${city.slug}</loc>`));
  for (const city of CITIES) assert.match(xml, new RegExp(`<loc>https://sunsetping.com/golden-hour/${city.slug}</loc>`));
  assert.match(xml, /<loc>https:\/\/sunsetping\.com\/golden-hour<\/loc>/);
  assert.match(xml, /<loc>https:\/\/sunsetping\.com\/photo-of-the-month<\/loc>/);
  assert.match(xml, /<loc>https:\/\/sunsetping\.com\/tonight<\/loc>/);
  assert.equal(xml.match(/<loc>/g).length, 7 + CITIES.length * 3);
  assert.match(xml, /<loc>https:\/\/sunsetping\.com\/widget<\/loc>/);
  assert.doesNotMatch(xml, /\/embed\//);
  const lastmod = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  assert.equal(xml.match(/<lastmod>/g).length, CITIES.length * 3 + 3);
  for (const city of CITIES) {
    assert.match(xml, new RegExp(`<loc>https://sunsetping.com/sunset/${city.slug}</loc><lastmod>${lastmod}</lastmod>`));
    assert.match(xml, new RegExp(`<loc>https://sunsetping.com/golden-hour/${city.slug}</loc><lastmod>${lastmod}</lastmod>`));
  }
  assert.match(xml, new RegExp(`<loc>https://sunsetping.com/sunset</loc><lastmod>${lastmod}</lastmod>`));
  assert.match(xml, new RegExp(`<loc>https://sunsetping.com/golden-hour</loc><lastmod>${lastmod}</lastmod>`));
  assert.match(xml, new RegExp(`<loc>https://sunsetping.com/tonight</loc><lastmod>${lastmod}</lastmod>`));
  assert.doesNotMatch(xml, /<loc>https:\/\/sunsetping.com\/<\/loc><lastmod>/);
  assert.doesNotMatch(xml, /sunsetping\.com\/pro/);
  assert.doesNotMatch(xml, /<loc>https:\/\/sunsetping.com\/faq<\/loc><lastmod>/);
});

test("robots, llms.txt, and the FAQ state the product in plain language", async () => {
  const robots = readPublic("robots.txt");
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Disallow: \/api\//);
  assert.doesNotMatch(robots, /Disallow: \/(?!api\/)/);
  assert.match(robots, /Sitemap: https:\/\/sunsetping.com\/sitemap\.xml/);
  const llms = readPublic("llms.txt");
  assert.match(llms, /1 to 10/);
  assert.match(llms, /price is 0/);
  assert.match(llms, /GET https:\/\/sunsetping.com\/api\/score\?q=CITY/);
  assert.match(llms, /Do not invent a score/);
  assert.match(llms, /https:\/\/sunsetping.com\/sunset\/<slug>/);
  assert.match(llms, /robots\.txt disallows \/api\//);
  assert.match(llms, /https:\/\/sunsetping.com\/#signup/);
  assert.match(llms, /## Common questions/);
  assert.match(llms, /How do I cancel or unsubscribe\?/);
  assert.match(llms, /unsubscribe link/);
  assert.doesNotMatch(llms, /payment link/i);
  assert.doesNotMatch(llms, /\$3\.99/);
  assert.doesNotMatch(llms, /\$29/);
  const faq = readPublic("faq.html");
  assert.match(faq, /What is SunsetPing\?/);
  assert.match(faq, /How does the sunset score work\?/);
  assert.match(faq, /What do free alerts include\?/);
  assert.match(faq, /How much does SunsetPing cost\?/);
  assert.match(faq, /The price is 0/);
  assert.match(faq, /id="signup"/);
  assert.match(faq, /action="\/api\/subscribe"/);
  assert.match(faq, /Know when the light will be good before you drive out/);
  assert.match(faq, /"price":"0"/);
  assert.match(faq, /rel="canonical" href="https:\/\/sunsetping.com\/faq"/);
  assert.match(faq, /href="\/sunset\/sedona"/);
  assert.doesNotMatch(faq, /payment link/i);
  assert.doesNotMatch(faq, /card form/i);
  assert.doesNotMatch(faq, /\$3\.99/);
  assert.doesNotMatch(faq, /\$29/);
  const visible = faqPairs(faq);
  const faqLd = [...faq.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((block) => JSON.parse(block[1]));
  const faqPage = faqLd.find((block) => block["@type"] === "FAQPage");
  assert.ok(faqPage);
  assert.equal(faqPage.mainEntity.length, visible.length);
  for (const pair of visible) {
    const entry = faqPage.mainEntity.find((item) => item.name === pair.q);
    assert.ok(entry, pair.q);
    assert.equal(entry["@type"], "Question");
    assert.equal(entry.acceptedAnswer["@type"], "Answer");
    const answer = entry.acceptedAnswer.text.replace(/\s+/g, " ").trim();
    assert.equal(answer, pair.a);
  }
  assert.doesNotMatch(`${faq}\n${llms}`, /Nothing is mailed unless an email provider key/);
  for (const file of ["index.html", "faq.html", "llms.txt"]) {
    assert.doesNotMatch(readPublic(file), /payment link/i, file);
  }
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
  assert.match(home, /"@type":"Product"/);
  assert.match(home, /"@type":"Offer"/);
  assert.match(home, /"price":"0"/);
  assert.match(home, /"url":"https:\/\/sunsetping\.com\/#signup"/);
  assert.match(home, /id="signup"/);
  assert.match(home, /action="\/api\/subscribe"/);
  assert.doesNotMatch(home, /\/api\/checkout/);
  assert.doesNotMatch(home, /\$3\.99/);
  assert.doesNotMatch(home, /\$29/);
  assert.equal(existsSync(new URL("../public/pro.html", import.meta.url)), false);
  assert.equal(existsSync(new URL("../public/pro.js", import.meta.url)), false);
});

test("alert emails link a shareable forecast and do not upsell", () => {
  const strong = renderEmail(home(8));
  assert.match(strong, /Share tonight's forecast/);
  assert.match(strong, /href="https:\/\/sunsetping\.com\/s\/Denver%2C%20Colorado"/);
  assert.doesNotMatch(strong, /\$29/);
  assert.doesNotMatch(strong, /\/pro/);
  const mild = renderEmail(home(4));
  assert.doesNotMatch(mild, /\$29/);
  assert.match(mild, /#64748b/);
  const later = renderEmail(home(9), { when: "tomorrow" });
  assert.match(later, /Share tomorrow's forecast/);
  const shared = renderEmail(home(10), { shareUrl: "https://sunsetping.com/s/Moab%2C%20Utah" });
  assert.match(shared, /href="https:\/\/sunsetping\.com\/s\/Moab%2C%20Utah"/);
  assert.match(shared, /Share tonight's forecast/);
  const rise = renderEmail(home(9), { when: "sunrise" });
  assert.match(rise, /Share this sunrise forecast/);
});

test("the cron shares the forecast and does not upsell", async () => {
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
  assert.match(great[0].html, /Share tonight's forecast/);
  assert.match(great[0].html, /\/s\/Denver%2C%20Colorado/);
  assert.doesNotMatch(great[0].html, /\$29/);
  assert.doesNotMatch(great[0].html, /\/pro/);

  const quiet = [];
  await runAlerts(testEnv(createDb({ subscribers: [{ ...subscriber }] })), now, {
    fetchImpl: forecast(CLEAR),
    send: async (msg) => {
      quiet.push(msg);
      return { ok: true, sent: false, mode: "noop" };
    },
  });
  assert.match(quiet[0].html, /Share tonight's forecast/);
  assert.doesNotMatch(quiet[0].html, /\$29/);
});

test("sunset-time pages render with their own title and canonical", async () => {
  const res = await worker.fetch(new Request("https://sunsetping.com/sunset-time/san-diego"), testEnv(createDb(), { CITY_SCORE_TIMEOUT_MS: "20" }));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Sunset Time Today in San Diego/);
  assert.match(html, /rel="canonical" href="[^"]*\/sunset-time\/san-diego"/);
  const missing = await worker.fetch(new Request("https://sunsetping.com/sunset-time/nowhere"), testEnv(createDb()));
  assert.equal(missing.status, 404);
});
