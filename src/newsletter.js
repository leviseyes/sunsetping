import { normalizeNewsletter, newsletterSubject, renderNewsletter } from "./email.js";
import { sendEmail } from "./sender.js";
import { wallParts } from "./scoring.js";

/** Issue weeks are dated in Pacific time, where Thursday morning is the send window. */
export const NEWSLETTER_TZ = "America/Los_Angeles";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n) {
  return String(n).padStart(2, "0");
}

function localDateISO(now, timeZone) {
  const parts = wallParts(now, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Monday (YYYY-MM-DD) of the civil week that contains `isoDate`. */
export function mondayOf(isoDate) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  const weekday = utc.getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  utc.setUTCDate(utc.getUTCDate() + delta);
  return utc.toISOString().slice(0, 10);
}

export function issueWeekMonday(now = new Date(), timeZone = NEWSLETTER_TZ) {
  return mondayOf(localDateISO(now, timeZone));
}

export function weekRangeLabel(mondayIso) {
  const [y, m, d] = mondayIso.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 6));
  const sm = MONTHS[start.getUTCMonth()];
  const em = MONTHS[end.getUTCMonth()];
  if (start.getUTCFullYear() === end.getUTCFullYear() && sm === em) return `${sm} ${start.getUTCDate()}–${end.getUTCDate()}`;
  return `${sm} ${start.getUTCDate()}–${em} ${end.getUTCDate()}`;
}

/**
 * Fill the stable issue date and header range.
 * `issueDate` defaults to the Monday of the current week in America/Los_Angeles.
 * A caller can pin another YYYY-MM-DD (for example the Thursday send date);
 * that value is the alert_sends local_date, so the same value will not send twice.
 */
export function prepareIssue(content = {}, now = new Date()) {
  const issue = normalizeNewsletter(content);
  const issueDate = issue.issueDate || issueWeekMonday(now);
  return {
    ...issue,
    issueDate,
    range: issue.range || weekRangeLabel(mondayOf(issueDate)),
  };
}

export function issueError(issue) {
  const lead = issue?.highlights?.[0];
  if (!lead?.location) return "Add at least one outlook highlight with a location.";
  if (!issue.tip) return "Add a short tip.";
  return "";
}

export function newsletterFrom(env = {}) {
  return env.NEWSLETTER_FROM || env.EMAIL_FROM || "SunsetPing <alerts@sunsetping.com>";
}

export function authorizeCron(req, env) {
  const secret = env?.CRON_SECRET;
  if (!secret || typeof secret !== "string") return false;
  const header = req.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return mismatch === 0;
}

async function recordSend(db, subscriberId, localDate) {
  try {
    await db.prepare("INSERT INTO alert_sends (subscriber_id, kind, local_date) VALUES (?1, ?2, ?3)").bind(subscriberId, "newsletter", localDate).run();
  } catch (err) {
    if (!/unique/i.test(String(err?.message || err))) throw err;
  }
}

/**
 * Email every active subscriber one weekly issue.
 * Deduped with alert_sends kind "newsletter" and local_date = the issue date.
 * Without RESEND_API_KEY, sendEmail noops and the row is still recorded.
 */
export async function runWeeklyNewsletter(env, content = {}, now = new Date(), deps = {}) {
  const issue = prepareIssue(content, now);
  const summary = { considered: 0, sent: 0, noop: 0, skipped: 0, errors: 0 };
  const problem = issueError(issue);
  if (problem) {
    console.log(JSON.stringify({ event: "newsletter_rejected", message: problem }));
    summary.errors = 1;
    return summary;
  }
  const fetchImpl = deps.fetchImpl || fetch;
  const from = newsletterFrom(env);
  const send = deps.send || ((msg) => sendEmail({ ...msg, from, env, fetchImpl }));
  const db = env.DB;
  const base = (env.PUBLIC_BASE_URL || "https://sunsetping.com").replace(/\/$/, "");
  let listed;
  try {
    listed = await db.prepare(
      "SELECT id, email, plan, status, unsubscribe_token FROM subscribers WHERE status = 'active'"
    ).all();
  } catch (err) {
    summary.errors = 1;
    console.log(JSON.stringify({ event: "newsletter_error", message: String(err?.message || err) }));
    return summary;
  }
  for (const sub of listed.results || []) {
    summary.considered++;
    if (sub.status && sub.status !== "active") {
      summary.skipped++;
      continue;
    }
    try {
      const prior = await db.prepare("SELECT kind, local_date FROM alert_sends WHERE subscriber_id = ?1").bind(sub.id).all();
      const sentKeys = new Set((prior.results || []).map((row) => `${row.kind}:${row.local_date}`));
      if (sentKeys.has(`newsletter:${issue.issueDate}`)) {
        summary.skipped++;
        continue;
      }
      const plan = sub.plan === "pro" ? "pro" : "free";
      const html = renderNewsletter(issue, {
        plan,
        unsubscribeUrl: `${base}/api/unsubscribe?token=${sub.unsubscribe_token}`,
      });
      const result = await send({ to: sub.email, subject: newsletterSubject(issue), html, from });
      if (!result?.ok) {
        summary.errors++;
        continue;
      }
      await recordSend(db, sub.id, issue.issueDate);
      if (result.sent) summary.sent++;
      else summary.noop++;
    } catch (err) {
      summary.errors++;
      console.log(JSON.stringify({ event: "newsletter_error", email: sub.email, message: String(err?.message || err) }));
    }
  }
  console.log(JSON.stringify({ event: "newsletter_done", issueDate: issue.issueDate, ...summary }));
  return summary;
}
