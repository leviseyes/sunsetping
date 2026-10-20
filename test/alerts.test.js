import assert from "node:assert/strict";
import test from "node:test";
import { isLocalClockDue, isWithinWindow, planSubscriberAlerts, runAlerts } from "../src/alerts.js";
import { emailSubject, renderEmail } from "../src/email.js";
import { sendEmail } from "../src/sender.js";
import { CLEAR, PERFECT, createDb, day, flatForecast, testEnv } from "./fixtures.js";

const TOKEN = "cd".repeat(32);

function home(score, extra = {}) {
  return {
    location: "Denver, Colorado",
    lat: 39.74,
    lon: -104.98,
    score,
    verdict: score >= 8 ? "Don't miss it" : "Worth stepping outside",
    reason: "High, scattered clouds to catch the color.",
    sunset: "6:42 PM",
    sunsetIso: "2026-10-14T18:42",
    timezone: "America/Denver",
    date: "Wednesday, October 14",
    viewing: { goldenHourStart: "5:42 PM", goldenHourEnd: "6:42 PM", sunset: "6:42 PM", blueHourEnd: "7:22 PM" },
    sunrise: { time: "7:10 AM", iso: "2026-10-14T07:10", score: 7, verdict: "Worth stepping outside", reason: "Some clouds up high for color.", date: "Wednesday, October 14" },
    ...extra,
  };
}

const tomorrow = home(9, { sunsetIso: "2026-10-15T18:42", date: "Thursday, October 15", sunset: "6:42 PM" });
const sunsetDue = new Date("2026-10-14T21:50:00.000Z");
const sunriseDue = new Date("2026-10-14T12:10:00.000Z");
const dayBeforeDue = new Date("2026-10-14T22:05:00.000Z");

function sub(overrides = {}) {
  return {
    id: 1,
    email: "ada@sunset.test",
    plan: "free",
    score_threshold: null,
    sunrise_alerts: 0,
    day_before: 0,
    lead_minutes: 180,
    unsubscribe_token: TOKEN,
    ...overrides,
  };
}

test("alert window and the 4pm day-before clock", () => {
  const target = Date.parse("2026-10-14T21:42:00.000Z");
  assert.equal(isWithinWindow(Date.parse("2026-10-14T21:42:00.000Z"), target), true);
  assert.equal(isWithinWindow(Date.parse("2026-10-14T22:01:00.000Z"), target), true);
  assert.equal(isWithinWindow(Date.parse("2026-10-14T22:02:00.000Z"), target), false);
  assert.equal(isWithinWindow(Date.parse("2026-10-14T21:41:00.000Z"), target), false);
  assert.equal(isLocalClockDue(dayBeforeDue, "America/Denver", 16, 0), true);
  assert.equal(isLocalClockDue(new Date("2026-10-14T22:25:00.000Z"), "America/Denver", 16, 0), false);
});

test("alert flags work for every subscriber, and defaults stay same-day only", () => {
  const sent = new Set();
  const plain = sub();
  const due = planSubscriberAlerts({ subscriber: plain, home: home(4), tomorrow, now: sunsetDue, sentKeys: sent });
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, "sunset");
  assert.equal(due[0].skip, undefined);
  assert.equal(planSubscriberAlerts({ subscriber: plain, home: home(8), tomorrow, now: sunriseDue, sentKeys: sent }).length, 0);
  assert.equal(planSubscriberAlerts({ subscriber: plain, home: home(8), tomorrow, now: dayBeforeDue, sentKeys: sent }).length, 0);

  const free = sub({ sunrise_alerts: 1, day_before: 1, score_threshold: 9 });
  const quietRise = planSubscriberAlerts({ subscriber: free, home: home(8), tomorrow, now: sunriseDue, sentKeys: sent });
  assert.equal(quietRise[0].skip, "threshold");
  const quietTonight = planSubscriberAlerts({ subscriber: free, home: home(4), tomorrow, now: sunsetDue, sentKeys: new Set() });
  assert.equal(quietTonight[0].skip, "threshold");
  const aheadOk = planSubscriberAlerts({ subscriber: free, home: home(8), tomorrow, now: dayBeforeDue, sentKeys: new Set() });
  assert.equal(aheadOk[0].kind, "day_before");
  assert.equal(aheadOk[0].when, "tomorrow");
});

test("Pro threshold, sunrise, day-before, and dedupe", () => {
  const pro = sub({ plan: "pro", score_threshold: 8, sunrise_alerts: 1, day_before: 1 });
  const quiet = planSubscriberAlerts({ subscriber: pro, home: home(7), tomorrow, now: sunsetDue, sentKeys: new Set() });
  assert.equal(quiet[0].skip, "threshold");
  const loud = planSubscriberAlerts({ subscriber: pro, home: home(8), tomorrow, now: sunsetDue, sentKeys: new Set() });
  assert.equal(loud[0].when, "tonight");
  const again = planSubscriberAlerts({ subscriber: pro, home: home(8), tomorrow, now: sunsetDue, sentKeys: new Set(["sunset:2026-10-14"]) });
  assert.equal(again.length, 0);
  const riseHome = home(8);
  riseHome.sunrise = { ...riseHome.sunrise, score: 8 };
  const rise = planSubscriberAlerts({ subscriber: pro, home: riseHome, tomorrow, now: sunriseDue, sentKeys: new Set() });
  assert.equal(rise.length, 1);
  assert.equal(rise[0].kind, "sunrise");
  assert.equal(rise[0].score.sunset, "7:10 AM");
  const quietRise = planSubscriberAlerts({ subscriber: pro, home: home(8), tomorrow, now: sunriseDue, sentKeys: new Set() });
  assert.equal(quietRise[0].skip, "threshold");
  const ahead = planSubscriberAlerts({ subscriber: pro, home: home(8), tomorrow: home(6, { sunsetIso: "2026-10-15T18:42" }), now: dayBeforeDue, sentKeys: new Set() });
  assert.equal(ahead[0].skip, "threshold");
  const aheadOk = planSubscriberAlerts({ subscriber: pro, home: home(8), tomorrow, now: dayBeforeDue, sentKeys: new Set() });
  assert.equal(aheadOk[0].kind, "day_before");
  assert.equal(aheadOk[0].when, "tomorrow");
});

test("email template includes the score, window, ranking, and unsubscribe link", () => {
  const html = renderEmail(home(8), {
    ranking: [
      { location: "Moab, Utah", score: 9, verdict: "Don't miss it" },
      { location: "Denver <script>", score: 8, verdict: "Don't miss it" },
    ],
    unsubscribeUrl: "https://sunsetping.com/api/unsubscribe?token=" + TOKEN,
  });
  assert.match(html, /SUNSETPING/);
  assert.match(html, /8<span/);
  assert.match(html, /Don&#39;t miss it/);
  assert.match(html, /6:42 PM/);
  assert.match(html, /golden hour 5:42 PM/);
  assert.match(html, /blue hour until 7:22 PM/);
  assert.match(html, /Best of your spots tonight/);
  assert.match(html, /Moab, Utah/);
  assert.match(html, /Denver &lt;script&gt;/);
  assert.match(html, new RegExp(`unsubscribe\\?token=${TOKEN}`));
  assert.equal(emailSubject(home(8), "tomorrow"), "Tomorrow's sunset in Denver, Colorado: 8/10");
  const untouched = renderEmail(home(4));
  assert.match(untouched, /\{\{unsubscribe_url\}\}/);
  assert.match(untouched, /#64748b/);
});

test("sender logs and does not call Resend without a key", async () => {
  let called = false;
  const result = await sendEmail({
    to: "ada@sunset.test",
    subject: "Tonight",
    html: "<p>hi</p>",
    env: {},
    fetchImpl: async () => {
      called = true;
      return Response.json({});
    },
  });
  assert.equal(called, false);
  assert.deepEqual(result, { ok: true, sent: false, mode: "noop" });
});

test("sender can target Resend when a key is set, without a real delivery", async () => {
  let seen;
  const result = await sendEmail({
    to: "ada@sunset.test",
    subject: "Tonight",
    html: "<p>hi</p>",
    env: { RESEND_API_KEY: "re_test_dummy" },
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init };
      return Response.json({ id: "fake_not_sent" });
    },
  });
  assert.equal(result.sent, true);
  assert.equal(seen.url, "https://api.resend.com/emails");
  assert.equal(seen.init.headers.authorization, "Bearer re_test_dummy");
  const payload = JSON.parse(seen.init.body);
  assert.deepEqual(payload.to, ["ada@sunset.test"]);
  assert.equal(payload.subject, "Tonight");
});

test("cron builds a due email and records a noop send", async () => {
  const db = createDb({
    subscribers: [{
      id: 7,
      email: "ada@sunset.test",
      location: "Denver, Colorado",
      lat: 39.74,
      lon: -104.98,
      tz: null,
      plan: "pro",
      score_threshold: null,
      sunrise_alerts: 0,
      day_before: 0,
      lead_minutes: 180,
      unsubscribe_token: TOKEN,
      status: "active",
    }],
    saved: [{ id: 3, subscriber_id: 7, label: "Key West, Florida", lat: 24.55, lon: -81.78, tz: null }],
  });
  const seen = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("api.resend.com")) throw new Error("refusing to send");
    const lat = Number(new URL(u).searchParams.get("latitude"));
    const weather = lat < 30 ? PERFECT : CLEAR;
    return Response.json(flatForecast([day("2026-10-14T18:42", weather), day("2026-10-15T18:42", weather)]));
  };
  const summary = await runAlerts(testEnv(db), sunsetDue, { fetchImpl });
  assert.equal(summary.noop, 1);
  assert.equal(summary.sent, 0);
  assert.equal(seen.some((u) => u.includes("resend")), false);
  assert.equal(db.state.sends.length, 1);
  assert.equal(db.state.sends[0].kind, "sunset");
  assert.equal(db.state.sends[0].local_date, "2026-10-14");
  const again = await runAlerts(testEnv(db), sunsetDue, { fetchImpl });
  assert.equal(again.noop, 0);
  assert.equal(db.state.sends.length, 1);
});

test("cron ranks saved spots in the email and skips under the threshold", async () => {
  const db = createDb({
    subscribers: [{
      id: 7,
      email: "ada@sunset.test",
      location: "Denver, Colorado",
      lat: 39.74,
      lon: -104.98,
      plan: "pro",
      score_threshold: null,
      sunrise_alerts: 0,
      day_before: 0,
      lead_minutes: 180,
      unsubscribe_token: TOKEN,
      status: "active",
    }],
    saved: [{ id: 3, subscriber_id: 7, label: "Key West, Florida", lat: 24.55, lon: -81.78 }],
  });
  const messages = [];
  const fetchImpl = async (url) => {
    const lat = Number(new URL(String(url)).searchParams.get("latitude"));
    const weather = lat < 30 ? PERFECT : CLEAR;
    return Response.json(flatForecast([day("2026-10-14T18:42", weather), day("2026-10-15T18:42", weather)]));
  };
  await runAlerts(testEnv(db), sunsetDue, {
    fetchImpl,
    send: async (msg) => {
      messages.push(msg);
      return { ok: true, sent: false, mode: "noop" };
    },
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0].subject, /Denver, Colorado: 6\/10/);
  assert.match(messages[0].html, /Best of your spots tonight/);
  assert.match(messages[0].html, /Key West, Florida/);
  assert.match(messages[0].html, new RegExp(TOKEN));

  db.state.sends.length = 0;
  db.state.subscribers[0].score_threshold = 8;
  messages.length = 0;
  const summary = await runAlerts(testEnv(db), sunsetDue, { fetchImpl, send: async (msg) => { messages.push(msg); return { ok: true, sent: false, mode: "noop" }; } });
  assert.equal(messages.length, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(db.state.sends[0].kind, "sunset");
});

test("Pro sunrise and day-before alerts are the only ones at those clocks", async () => {
  const base = {
    id: 4,
    email: "ada@sunset.test",
    location: "Denver, Colorado",
    lat: 39.74,
    lon: -104.98,
    plan: "pro",
    score_threshold: null,
    sunrise_alerts: 1,
    day_before: 1,
    lead_minutes: 180,
    unsubscribe_token: TOKEN,
    status: "active",
  };
  const forecast = flatForecast([day("2026-10-14T18:42", PERFECT), day("2026-10-15T18:42", PERFECT)]);
  const fetchImpl = async () => Response.json(forecast);
  const riseDb = createDb({ subscribers: [{ ...base }] });
  const rise = [];
  await runAlerts(testEnv(riseDb), sunriseDue, { fetchImpl, send: async (msg) => { rise.push(msg); return { ok: true, sent: false, mode: "noop" }; } });
  assert.equal(rise.length, 1);
  assert.match(rise[0].subject, /^Sunrise in Denver/);
  assert.equal(riseDb.state.sends[0].kind, "sunrise");

  const aheadDb = createDb({ subscribers: [{ ...base, sunrise_alerts: 0 }] });
  const ahead = [];
  await runAlerts(testEnv(aheadDb), dayBeforeDue, { fetchImpl, send: async (msg) => { ahead.push(msg); return { ok: true, sent: false, mode: "noop" }; } });
  assert.equal(ahead.length, 1);
  assert.match(ahead[0].subject, /^Tomorrow's sunset/);
  assert.equal(aheadDb.state.sends[0].kind, "day_before");
  assert.equal(aheadDb.state.sends[0].local_date, "2026-10-15");
});
