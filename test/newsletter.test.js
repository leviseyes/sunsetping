import assert from "node:assert/strict";
import test from "node:test";
import { newsletterSubject, renderNewsletter } from "../src/email.js";
import { issueWeekMonday, mondayOf, prepareIssue, runWeeklyNewsletter, weekRangeLabel } from "../src/newsletter.js";
import worker from "../src/worker.js";
import { createDb, testEnv } from "./fixtures.js";

const FREE_TOKEN = "ab".repeat(32);
const PRO_TOKEN = "cd".repeat(32);
const GONE_TOKEN = "ef".repeat(32);
const WHEN = new Date("2026-10-15T15:30:00.000Z");

const issue = {
  range: "Oct 12–18",
  highlights: [
    {
      location: "Sedona, Arizona",
      night: "Saturday, October 17",
      score: 9,
      verdict: "Don't miss it",
      blurb: "High clouds after a clear afternoon.",
    },
    {
      city: "San Diego <script>",
      bestNight: "Sunday",
      score: 7,
      verdict: "Worth stepping outside",
      blurb: "Open horizon.",
    },
  ],
  tip: "Lock exposure on the sky a minute before the sun drops.",
  feature: "Saved spots now sort themselves.",
};

function people() {
  return [
    { id: 1, email: "ada@sunset.test", plan: "free", status: "active", unsubscribe_token: FREE_TOKEN },
    { id: 2, email: "pro@sunset.test", plan: "pro", status: "active", unsubscribe_token: PRO_TOKEN },
    { id: 3, email: "gone@sunset.test", plan: "free", status: "unsubscribed", unsubscribe_token: GONE_TOKEN },
  ];
}

test("issue week is the Monday in America/Los_Angeles", () => {
  assert.equal(issueWeekMonday(WHEN), "2026-10-12");
  assert.equal(issueWeekMonday(new Date("2026-10-19T06:30:00.000Z")), "2026-10-12");
  assert.equal(issueWeekMonday(new Date("2026-10-19T07:30:00.000Z")), "2026-10-19");
  assert.equal(mondayOf("2026-10-15"), "2026-10-12");
  assert.equal(mondayOf("2026-12-28"), "2026-12-28");
  assert.equal(weekRangeLabel("2026-10-12"), "Oct 12–18");
  assert.equal(weekRangeLabel("2026-12-28"), "Dec 28–Jan 3");
  const prepared = prepareIssue({
    outlook: { city: "Moab", bestNight: "Friday", score: 8, verdict: "Don't miss it", blurb: "Red rock." },
    tip: "Face west.",
  }, WHEN);
  assert.equal(prepared.issueDate, "2026-10-12");
  assert.equal(prepared.range, "Oct 12–18");
  assert.equal(prepared.highlights[0].location, "Moab");
  assert.equal(prepared.highlights[0].night, "Friday");
  const pinned = prepareIssue({ ...issue, issueDate: "2026-10-15", range: "" }, WHEN);
  assert.equal(pinned.issueDate, "2026-10-15");
  assert.equal(pinned.range, "Oct 12–18");
});

test("newsletter template: free upsell, pro skip, unsubscribe, and optional feature", () => {
  const free = renderNewsletter(issue, {
    plan: "free",
    unsubscribeUrl: "https://sunsetping.com/api/unsubscribe?token=" + FREE_TOKEN,
  });
  assert.match(free, /SUNSETPING · WEEKLY · OCT 12–18/);
  assert.match(free, /This week's best sunset outlook/);
  assert.match(free, /9<span/);
  assert.match(free, /Don&#39;t miss it/);
  assert.match(free, /Best night in <b>Sedona, Arizona<\/b>/);
  assert.match(free, /Saturday, October 17/);
  assert.match(free, /High clouds after a clear afternoon\./);
  assert.match(free, /Also on the outlook/);
  assert.match(free, /San Diego &lt;script&gt;/);
  assert.match(free, /A short tip/);
  assert.match(free, /Lock exposure on the sky/);
  assert.match(free, /What's new/);
  assert.match(free, /Saved spots now sort themselves\./);
  assert.doesNotMatch(free, /sunsetping\.com\/pro/);
  assert.doesNotMatch(free, /\$3\.99/);
  assert.doesNotMatch(free, /\$29/);
  assert.match(free, new RegExp(`unsubscribe\\?token=${FREE_TOKEN}`));
  assert.match(free, /background:#f4efe8/);
  assert.match(free, /Georgia/);
  assert.equal(newsletterSubject(issue), "This week's sunset in Sedona, Arizona: 9/10 · Oct 12–18");

  const pro = renderNewsletter(issue, {
    plan: "pro",
    unsubscribeUrl: "https://sunsetping.com/api/unsubscribe?token=" + PRO_TOKEN,
  });
  assert.match(pro, new RegExp(`unsubscribe\\?token=${PRO_TOKEN}`));
  assert.doesNotMatch(pro, /sunsetping\.com\/pro/);
  assert.doesNotMatch(pro, /\$3\.99/);
  assert.doesNotMatch(pro, /\$29/);
  assert.doesNotMatch(pro, /Want the week ahead/);

  const quiet = renderNewsletter({ ...issue, feature: "  ", highlights: [issue.highlights[0]] });
  assert.doesNotMatch(quiet, /What's new/);
  assert.doesNotMatch(quiet, /Also on the outlook/);
  assert.match(quiet, /\{\{unsubscribe_url\}\}/);
});

test("send loop skips unsubscribed subscribers, dedupes, and noops without a Resend key", async () => {
  const db = createDb({ subscribers: people() });
  const env = testEnv(db);
  let fetched = false;
  const summary = await runWeeklyNewsletter(env, issue, WHEN, {
    fetchImpl: async () => {
      fetched = true;
      throw new Error("refusing to send");
    },
  });
  assert.equal(fetched, false);
  assert.deepEqual(summary, { considered: 2, sent: 0, noop: 2, skipped: 0, errors: 0 });
  assert.equal(db.state.sends.length, 2);
  assert.deepEqual(db.state.sends.map((row) => row.kind), ["newsletter", "newsletter"]);
  assert.deepEqual(db.state.sends.map((row) => row.local_date), ["2026-10-12", "2026-10-12"]);
  assert.equal(db.state.sends.some((row) => row.subscriber_id === 3), false);

  const again = await runWeeklyNewsletter(env, issue, WHEN);
  assert.deepEqual(again, { considered: 2, sent: 0, noop: 0, skipped: 2, errors: 0 });
  assert.equal(db.state.sends.length, 2);
});

test("free and pro copies differ, and a failed send can be retried", async () => {
  const db = createDb({ subscribers: people() });
  const messages = [];
  const failed = await runWeeklyNewsletter(testEnv(db), issue, WHEN, {
    send: async () => ({ ok: false, sent: false, mode: "resend" }),
  });
  assert.equal(failed.errors, 2);
  assert.equal(db.state.sends.length, 0);

  const summary = await runWeeklyNewsletter(testEnv(db), issue, WHEN, {
    send: async (msg) => {
      messages.push(msg);
      return { ok: true, sent: true, mode: "resend" };
    },
  });
  assert.equal(summary.sent, 2);
  assert.deepEqual(messages.map((msg) => msg.to).sort(), ["ada@sunset.test", "pro@sunset.test"]);
  const free = messages.find((msg) => msg.to === "ada@sunset.test");
  const pro = messages.find((msg) => msg.to === "pro@sunset.test");
  assert.match(free.html, new RegExp(FREE_TOKEN));
  assert.doesNotMatch(free.html, /\$3\.99/);
  assert.doesNotMatch(free.html, /\$29/);
  assert.match(pro.html, new RegExp(PRO_TOKEN));
  assert.doesNotMatch(pro.html, /sunsetping\.com\/pro/);
  assert.doesNotMatch(pro.html, new RegExp(GONE_TOKEN));
  assert.equal(free.subject, "This week's sunset in Sedona, Arizona: 9/10 · Oct 12–18");
});

test("newsletter From prefers NEWSLETTER_FROM, then EMAIL_FROM, then the alerts default", async () => {
  const content = { ...issue, issueDate: "2026-10-12" };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body).from);
    return Response.json({ id: "fake" });
  };
  const base = { subscribers: [people()[0]] };
  await runWeeklyNewsletter(testEnv(createDb(base), {
    RESEND_API_KEY: "re_test_dummy",
    NEWSLETTER_FROM: "SunsetPing <hello@sunsetping.com>",
    EMAIL_FROM: "SunsetPing <alerts@sunsetping.com>",
  }), content, WHEN, { fetchImpl });
  await runWeeklyNewsletter(testEnv(createDb(base), {
    RESEND_API_KEY: "re_test_dummy",
    EMAIL_FROM: "SunsetPing <ops@sunsetping.com>",
  }), content, WHEN, { fetchImpl });
  await runWeeklyNewsletter(testEnv(createDb(base), { RESEND_API_KEY: "re_test_dummy" }), content, WHEN, { fetchImpl });
  assert.deepEqual(seen, [
    "SunsetPing <hello@sunsetping.com>",
    "SunsetPing <ops@sunsetping.com>",
    "SunsetPing <alerts@sunsetping.com>",
  ]);
});

test("POST /api/cron/newsletter requires the bearer secret and does not double-send", async () => {
  const db = createDb({ subscribers: [people()[0]] });
  const env = testEnv(db, { CRON_SECRET: "test-cron-secret" });
  const url = "https://sunsetping.com/api/cron/newsletter";
  const denied = await worker.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify(issue),
  }), env);
  assert.equal(denied.status, 401);
  const open = await worker.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(issue),
  }), testEnv(db));
  assert.equal(open.status, 401);
  const get = await worker.fetch(new Request(url), env);
  assert.equal(get.status, 405);
  const bad = await worker.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-cron-secret" },
    body: JSON.stringify({ tip: "Look west." }),
  }), env);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /highlight/);
  assert.equal(db.state.sends.length, 0);

  const send = async (body) => worker.fetch(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-cron-secret" },
    body: JSON.stringify(body),
  }), env);
  const first = await send(issue);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.ok, true);
  assert.equal(body.issueDate, issueWeekMonday(new Date()));
  assert.equal(body.noop, 1);
  assert.equal(body.sent, 0);
  const second = await send(issue);
  const again = await second.json();
  assert.equal(again.skipped, 1);
  assert.equal(again.noop, 0);
  assert.equal(db.state.sends.length, 1);
  assert.equal(db.state.sends[0].kind, "newsletter");
});

test("the 15-minute alert cron does not send a newsletter", async () => {
  const db = createDb({ subscribers: [people()[0]] });
  const pending = [];
  await worker.scheduled({ scheduledTime: Date.parse("2026-10-15T15:30:00.000Z") }, testEnv(db), {
    waitUntil(p) { pending.push(p); },
  });
  await Promise.all(pending);
  assert.equal(db.state.sends.filter((row) => row.kind === "newsletter").length, 0);
});
