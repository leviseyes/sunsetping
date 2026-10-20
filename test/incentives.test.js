import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runAlerts } from "../src/alerts.js";
import { renderWelcomeEmail } from "../src/email.js";
import { runWeeklyNewsletter } from "../src/newsletter.js";
import { eveningAltitudeUtc, eveningLightPlan } from "../src/solar.js";
import { CHEAT_SHEET_PATH, MOSH_BONUS, SIGNUP_HEADLINE, downloadLinks } from "../src/signup.js";
import { deliverWelcome } from "../src/welcome.js";
import worker from "../src/worker.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

const TOKEN = "ab".repeat(32);

function readPublic(name) {
  return readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");
}

test("evening light plan is astronomical and ordered", () => {
  const equinox = eveningAltitudeUtc({ lat: 0, lon: 0, year: 2026, month: 3, day: 20, altitudeDeg: -0.833 });
  const minutes = equinox.getUTCHours() * 60 + equinox.getUTCMinutes();
  assert.ok(Math.abs(minutes - 18 * 60) < 20, equinox.toISOString());
  const plan = eveningLightPlan({ lat: 39.74, lon: -104.98, date: "2026-10-14", timeZone: "America/Denver" });
  assert.match(plan.goldenHourStart, /^\d{1,2}:\d{2} [AP]M$/);
  assert.match(plan.sunset, /^\d{1,2}:\d{2} [AP]M$/);
  assert.match(plan.blueHourStart, /^\d{1,2}:\d{2} [AP]M$/);
  assert.match(plan.blueHourEnd, /^\d{1,2}:\d{2} [AP]M$/);
  assert.equal(eveningLightPlan({ lat: 80, lon: 0, date: "2026-12-21", timeZone: "UTC" }), null);
});

test("MOSH bonus is omitted when MOSH_PDF_URL is empty", () => {
  assert.deepEqual(downloadLinks({}).map((item) => item.label), ["Download the sunset shooting cheat sheet"]);
  const links = downloadLinks({ MOSH_PDF_URL: "/downloads/mosh-planner.pdf", PUBLIC_BASE_URL: "https://sunsetping.com" });
  assert.equal(links[1].href, "https://sunsetping.com/downloads/mosh-planner.pdf");
  assert.equal(links[2].href, "https://moshplanner.com");
  assert.equal(downloadLinks({ MOSH_PDF_URL: "   " }).length, 1);
});

test("signup stores an 8+ threshold and allows email without a city", async () => {
  const db = createDb();
  const env = testEnv(db, { MOSH_PDF_URL: "https://cdn.example/mosh.pdf" });
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) return Response.json(geocodeBody());
    if (u.includes("api.open-meteo.com")) return Response.json(flatForecast([day("2026-10-14T18:42", PERFECT)]));
    if (u.includes("api.resend.com")) return Response.json({ id: "email_1" });
    throw new Error(u);
  }, async () => {
    const pending = [];
    const res = await worker.fetch(new Request("https://sunsetping.com/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: "ada@sunset.test", location: "Denver", great_only: "1" }),
    }), env, { waitUntil(p) { pending.push(p); } });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(db.state.subscribers[0].score_threshold, 8);
    assert.match(body.offerHtml, /Download the sunset shooting cheat sheet/);
    assert.match(body.offerHtml, /https:\/\/cdn\.example\/mosh\.pdf/);
    assert.match(body.offerHtml, /moshplanner\.com/);
    await Promise.all(pending);

    const bare = await worker.fetch(new Request("https://sunsetping.com/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email: "new@sunset.test" }),
    }), testEnv(createDb()), { waitUntil() {} });
    const created = await bare.json();
    assert.equal(bare.status, 200);
    assert.equal(created.location, "");
    assert.match(created.offerHtml, /Add a city whenever you like/);
    assert.doesNotMatch(created.offerHtml, /MOSH Planner/);
  });
});

test("welcome email includes the cheat sheet and the MOSH link when configured", async () => {
  const db = createDb();
  const env = testEnv(db, { RESEND_API_KEY: "re_test", MOSH_PDF_URL: "/downloads/mosh-planner.pdf" });
  const sent = [];
  const result = await deliverWelcome({
    env,
    subscriber: { id: 3, email: "ada@sunset.test", location: "Moab, Utah", unsubscribe_token: TOKEN },
    tonight: null,
    fetchImpl: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return Response.json({ id: "email_1" });
    },
  });
  assert.equal(result.sent, true);
  assert.match(sent[0].html, new RegExp(CHEAT_SHEET_PATH.replace(/\//g, "\\/")));
  assert.match(sent[0].html, /https:\/\/sunsetping\.com\/downloads\/mosh-planner\.pdf/);
  assert.match(sent[0].html, /https:\/\/moshplanner\.com/);
  const hidden = renderWelcomeEmail({
    location: "Moab, Utah",
    yearlyUrl: "https://sunsetping.com/api/checkout?plan=yearly",
    monthlyUrl: "https://sunsetping.com/api/checkout?plan=monthly",
    unsubscribeUrl: "https://sunsetping.com/api/unsubscribe?token=" + TOKEN,
    downloads: downloadLinks({}),
  });
  assert.match(hidden, /sunset-cheat-sheet\.pdf/);
  assert.doesNotMatch(hidden, /moshplanner\.com/);
});

test("public city pages keep tonight's score and only clock times for the week", async () => {
  const forecast = flatForecast([
    day("2026-10-14T18:42", PERFECT),
    day("2026-10-15T18:05", PERFECT),
  ]);
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) return Response.json(geocodeBody({ name: "Sedona", admin1: "Arizona", latitude: 34.87, longitude: -111.76, timezone: "America/Phoenix" }));
    if (u.includes("api.open-meteo.com")) return Response.json(forecast);
    throw new Error(u);
  }, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/sunset/sedona"), testEnv(createDb()));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /\/10/);
    assert.match(html, new RegExp(SIGNUP_HEADLINE));
    assert.match(html, /Get the 7-day sunset quality outlook free by email/);
    assert.match(html, /Only email me on great nights \(8\+\)/);
    assert.match(html, /name="great_only"/);
    assert.match(html, /class="perk-list"/);
    assert.match(html, /8\+ only alerts/);
    assert.match(html, /Golden hour and blue hour times/);
    assert.match(html, /name="location" value="Sedona, Arizona"/);
    assert.doesNotMatch(html, /data-mosh-bonus/);
    assert.doesNotMatch(html, /data-mosh-perk/);
    assert.doesNotMatch(html, /MOSH Planner/);
    const table = html.match(/<div class="week-table"><table>[\s\S]*?<\/table>/)[0];
    assert.match(table, /Sunset/);
    assert.doesNotMatch(table, /\/10/);
    assert.doesNotMatch(table, /Don't miss it/);
    const timePage = await worker.fetch(new Request("https://sunsetping.com/sunset-time/sedona"), testEnv(createDb()));
    const timeHtml = await timePage.text();
    assert.match(timeHtml, /class="week-table"/);
    assert.match(timeHtml, /name="great_only"/);
    assert.match(timeHtml, /class="perk-list"/);
    assert.doesNotMatch(timeHtml, /data-mosh-bonus/);
    assert.doesNotMatch(timeHtml, /MOSH Planner/);
  });
});

test("checkout never redirects to Stripe", async () => {
  const env = testEnv(createDb(), {
    STRIPE_SECRET_KEY: "rk_test_should_not_be_used",
    STRIPE_PAYMENT_LINK_MONTHLY: "https://buy.stripe.com/test_placeholder",
    STRIPE_PAYMENT_LINK_YEARLY: "https://buy.stripe.com/test_placeholder",
  });
  let called = false;
  await withFetch(async () => {
    called = true;
    return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test" });
  }, async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly&email=ada@sunset.test&confirm=1", {
      headers: {
        "user-agent": "Mozilla/5.0",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
      },
    }), env);
    assert.equal(res.status, 302);
    const loc = res.headers.get("location") || "";
    assert.match(loc, /\/#signup$/);
    assert.doesNotMatch(loc, /stripe/i);
  });
  assert.equal(called, false);
});

test("share page keeps the score public and offers signup", async () => {
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) return Response.json(geocodeBody());
    if (u.includes("api.open-meteo.com")) return Response.json(flatForecast([day("2026-10-14T18:42", PERFECT)]));
    throw new Error(u);
  }, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/s/Denver"), testEnv(createDb(), { MOSH_PDF_URL: "/downloads/mosh-planner.pdf" }));
    const html = await page.text();
    assert.match(html, /\/10/);
    assert.match(html, /data-signup/);
    assert.match(html, new RegExp(MOSH_BONUS));
    assert.match(html, /Know when the light will be good before you drive out/);
  });
});

test("perks endpoint, photo page, cheat sheet, and early-access column", async () => {
  const empty = await worker.fetch(new Request("https://sunsetping.com/api/perks"), testEnv(createDb()));
  assert.equal((await empty.json()).moshPdfUrl, "");
  const set = await worker.fetch(new Request("https://sunsetping.com/api/perks"), testEnv(createDb(), { MOSH_PDF_URL: "/downloads/mosh-planner.pdf" }));
  assert.equal((await set.json()).moshPdfUrl, "/downloads/mosh-planner.pdf");
  const photo = await worker.fetch(new Request("https://sunsetping.com/photo-of-the-month"), testEnv(createDb()));
  assert.equal(await photo.text(), "/photo-of-the-month.html");
  const file = readPublic("photo-of-the-month.html");
  assert.match(file, /@MosheLevis/);
  assert.match(file, /reply to any SunsetPing email/i);
  assert.match(file, /Only email me on great nights \(8\+\)/);
  const pdf = readFileSync(new URL("../public/downloads/sunset-cheat-sheet.pdf", import.meta.url));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(pdf.toString("latin1"), /\/Count 2/);
  assert.match(pdf.toString("latin1"), /30 to 70 percent/);
  assert.match(readFileSync(new URL("../migrations/0005_early_access.sql", import.meta.url), "utf8"), /early_access INTEGER NOT NULL DEFAULT 1/);
  for (const name of ["index.html", "faq.html", "photo-of-the-month.html"]) {
    const html = readPublic(name);
    assert.match(html, new RegExp(SIGNUP_HEADLINE));
    assert.match(html, /great_only/);
    assert.match(html, /class="perk-list"/);
    assert.doesNotMatch(html, /data-mosh-bonus/);
    assert.doesNotMatch(html, /data-mosh-perk/);
    assert.doesNotMatch(html, /MOSH Planner/);
    assert.doesNotMatch(html, /\$3\.99/);
    assert.doesNotMatch(html, /\/api\/checkout/);
  }
  const moshPdf = readFileSync(new URL("../public/downloads/mosh-planner.pdf", import.meta.url));
  assert.equal(moshPdf.subarray(0, 5).toString(), "%PDF-");
  assert.equal(readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8").match(/MOSH_PDF_URL = "(.*)"/)[1], "/downloads/mosh-planner.pdf");
});

test("daily and weekly emails include the 7-day quality outlook for active subscribers", async () => {
  const db = createDb({
    subscribers: [{
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
      unsubscribe_token: TOKEN,
      status: "active",
    }],
  });
  const messages = [];
  const fetchImpl = async () => Response.json(flatForecast([
    day("2026-10-14T18:42", PERFECT),
    day("2026-10-15T18:05", PERFECT),
  ]));
  await runAlerts(testEnv(db), new Date("2026-10-14T21:50:00.000Z"), {
    fetchImpl,
    send: async (msg) => {
      messages.push(msg);
      return { ok: true, sent: false, mode: "noop" };
    },
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0].html, /Your 7-day sunset quality outlook/);
  assert.match(messages[0].html, /10\/10/);
  assert.match(messages[0].html, /Light plan/);
  assert.match(messages[0].html, /golden hour \d{1,2}:\d{2} [AP]M/);
  assert.match(messages[0].html, /blue hour \d{1,2}:\d{2} [AP]M/);

  const weekly = [];
  const weekDb = createDb({
    subscribers: [{
      id: 9,
      email: "ada@sunset.test",
      location: "Denver, Colorado",
      lat: 39.74,
      lon: -104.98,
      plan: "free",
      status: "active",
      unsubscribe_token: TOKEN,
    }],
  });
  await runWeeklyNewsletter(testEnv(weekDb), {
    highlights: [{ location: "Moab", night: "Friday", score: 8, verdict: "Don't miss it", blurb: "Red rock." }],
    tip: "Face west.",
    issueDate: "2026-10-12",
  }, new Date("2026-10-15T15:30:00.000Z"), {
    forecastFetch: fetchImpl,
    send: async (msg) => {
      weekly.push(msg);
      return { ok: true, sent: true, mode: "resend" };
    },
  });
  assert.equal(weekly.length, 1);
  assert.match(weekly[0].html, /Your 7-day sunset quality outlook/);
  assert.match(weekly[0].html, /Photo of the month/);
  assert.match(weekly[0].html, /@MosheLevis/);
});
