import { fetchForecast } from "./openmeteo.js";
import { rankScores, scoreForecastDay, tzAbbrev, wallParts, zonedWallToUtc } from "./scoring.js";
import { eveningLightPlan } from "./solar.js";
import { emailSubject, renderEmail } from "./email.js";
import { sendEmail } from "./sender.js";

export const ALERT_WINDOW_MINUTES = 20;
export const DEFAULT_LEAD_MINUTES = 180;
export const SUNRISE_LEAD_MINUTES = 60;
export const DAY_BEFORE_HOUR = 16;
export const MAX_SPOTS = 10;

export function isWithinWindow(nowMs, targetMs, windowMinutes = ALERT_WINDOW_MINUTES) {
  return nowMs >= targetMs && nowMs < targetMs + windowMinutes * 60 * 1000;
}

export function isLocalClockDue(now, timeZone, hour, minute = 0, windowMinutes = ALERT_WINDOW_MINUTES) {
  if (!timeZone) return false;
  const parts = wallParts(now, timeZone);
  const nowMin = parts.hour * 60 + parts.minute;
  const target = hour * 60 + minute;
  return nowMin >= target && nowMin < target + windowMinutes;
}

export function localDateISO(now, timeZone) {
  const parts = wallParts(now, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function shiftDate(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function passesThreshold(subscriber, score) {
  if (subscriber.score_threshold == null || subscriber.score_threshold === "") return true;
  return score >= Number(subscriber.score_threshold);
}

function lightSpot(scored, timeZone) {
  if (!scored) return null;
  const date = String(scored.sunsetIso || "").slice(0, 10);
  const computed = scored.lat != null && scored.lon != null
    ? eveningLightPlan({
      lat: Number(scored.lat),
      lon: Number(scored.lon),
      date,
      timeZone: scored.timezone || timeZone || "UTC",
    })
    : null;
  const viewing = scored.viewing || {};
  const plan = computed || (viewing.goldenHourStart ? {
    goldenHourStart: viewing.goldenHourStart,
    sunset: viewing.sunset || scored.sunset,
    blueHourStart: viewing.goldenHourEnd || scored.sunset,
    blueHourEnd: viewing.blueHourEnd,
  } : null);
  if (!plan?.goldenHourStart || !plan.sunset || !plan.blueHourStart || !plan.blueHourEnd) return null;
  return { location: scored.location || "", ...plan };
}

function dedupeScores(scores) {
  const seen = new Set();
  const out = [];
  for (const s of scores) {
    if (s?.lat == null || s?.lon == null) continue;
    const key = `${Number(s.lat).toFixed(2)},${Number(s.lon).toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_SPOTS) break;
  }
  return out;
}

/**
 * Decide which alerts are due for one subscriber. Pure aside from the dates it is given.
 * `sentKeys` is a Set of `${kind}:${YYYY-MM-DD}`.
 * `spotScores` includes the home score plus any saved spots (already scored).
 */
export function planSubscriberAlerts({ subscriber, home, tomorrow = null, now, sentKeys, spotScores = [] }) {
  const actions = [];
  if (!home?.sunsetIso) return actions;
  const lead = Number(subscriber.lead_minutes) || DEFAULT_LEAD_MINUTES;
  const tz = home.timezone || subscriber.tz || null;
  const ranking = rankScores(dedupeScores(spotScores.length ? spotScores : [home]));

  const consider = ({ kind, localDate, when, score, targetMs, localDue = false }) => {
    const key = `${kind}:${localDate}`;
    if (sentKeys.has(key)) return;
    const due = localDue || isWithinWindow(now.getTime(), targetMs);
    if (!due) return;
    if (!passesThreshold(subscriber, score.score)) {
      actions.push({ kind, localDate, skip: "threshold", score: score.score });
      return;
    }
    actions.push({ kind, localDate, when, score, ranking: kind === "sunset" ? ranking : [] });
  };

  const sunsetUtc = zonedWallToUtc(home.sunsetIso, tz);
  consider({
    kind: "sunset",
    localDate: home.sunsetIso.slice(0, 10),
    when: "tonight",
    score: home,
    targetMs: sunsetUtc.getTime() - lead * 60000,
  });

  if (Number(subscriber.day_before) && tomorrow?.sunsetIso) {
    const tzTomorrow = tomorrow.timezone || tz;
    const targetDate = tomorrow.sunsetIso.slice(0, 10);
    const isTheDayBefore = Boolean(tzTomorrow) && localDateISO(now, tzTomorrow) === shiftDate(targetDate, -1);
    consider({
      kind: "day_before",
      localDate: targetDate,
      when: "tomorrow",
      score: tomorrow,
      localDue: isTheDayBefore && isLocalClockDue(now, tzTomorrow, DAY_BEFORE_HOUR, 0),
      targetMs: 0,
    });
  }

  if (Number(subscriber.sunrise_alerts) && home.sunrise?.iso) {
    const sunriseUtc = zonedWallToUtc(home.sunrise.iso, tz);
    consider({
      kind: "sunrise",
      localDate: home.sunrise.iso.slice(0, 10),
      when: "sunrise",
      score: {
        ...home,
        score: home.sunrise.score,
        verdict: home.sunrise.verdict,
        reason: home.sunrise.reason,
        sunset: home.sunrise.time,
        date: home.sunrise.date,
        viewing: null,
      },
      targetMs: sunriseUtc.getTime() - SUNRISE_LEAD_MINUTES * 60000,
    });
  }

  return actions;
}

async function recordSend(db, subscriberId, kind, localDate) {
  try {
    await db.prepare("INSERT INTO alert_sends (subscriber_id, kind, local_date) VALUES (?1, ?2, ?3)").bind(subscriberId, kind, localDate).run();
  } catch (err) {
    if (!/unique/i.test(String(err?.message || err))) throw err;
  }
}

function withTz(scored) {
  if (!scored || scored.tz || !scored.timezone || !scored.sunsetIso) return scored;
  const utc = zonedWallToUtc(scored.sunsetIso, scored.timezone);
  return { ...scored, tz: tzAbbrev(scored.timezone, utc) };
}

export async function runAlerts(env, now = new Date(), deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const send = deps.send || ((msg) => sendEmail({ ...msg, env, fetchImpl }));
  const db = env.DB;
  const base = (env.PUBLIC_BASE_URL || "https://sunsetping.com").replace(/\/$/, "");
  const listed = await db.prepare(
    `SELECT id, email, location, lat, lon, tz, plan, score_threshold, sunrise_alerts, day_before, lead_minutes, unsubscribe_token
     FROM subscribers WHERE status = 'active'`
  ).all();
  const summary = { considered: 0, sent: 0, noop: 0, skipped: 0, errors: 0 };
  for (const sub of listed.results || []) {
    summary.considered++;
    if (sub.lat == null || sub.lon == null) continue;
    try {
      const forecast = await fetchForecast(sub.lat, sub.lon, 7, fetchImpl);
      const meta = { location: sub.location, lat: sub.lat, lon: sub.lon };
      const scoredDays = [];
      for (let i = 0; i < 7; i++) {
        const day = withTz(scoreForecastDay(forecast, i, meta));
        if (day) scoredDays.push(day);
      }
      const home = scoredDays[0] || null;
      const tomorrow = scoredDays[1] || null;
      if (home && !home.tz && home.timezone) home.tz = tzAbbrev(home.timezone, zonedWallToUtc(home.sunsetIso, home.timezone));
      const outlook = scoredDays.map((day) => ({
        date: day.date,
        score: day.score,
        verdict: day.verdict,
        sunset: day.sunset,
      }));
      const spotScores = [];
      if (home) {
        spotScores.push(home);
        const saved = await db.prepare("SELECT id, label, lat, lon, tz FROM saved_locations WHERE subscriber_id = ?1").bind(sub.id).all();
        for (const spot of saved.results || []) {
          const spotForecast = await fetchForecast(spot.lat, spot.lon, 1, fetchImpl);
          const scored = withTz(scoreForecastDay(spotForecast, 0, { location: spot.label, lat: spot.lat, lon: spot.lon, tz: spot.tz }));
          if (scored) spotScores.push(scored);
        }
      }
      const prior = await db.prepare("SELECT kind, local_date FROM alert_sends WHERE subscriber_id = ?1").bind(sub.id).all();
      const sentKeys = new Set((prior.results || []).map((row) => `${row.kind}:${row.local_date}`));
      const actions = planSubscriberAlerts({ subscriber: sub, home, tomorrow, now, sentKeys, spotScores });
      for (const action of actions) {
        if (action.skip) {
          await recordSend(db, sub.id, action.kind, action.localDate);
          summary.skipped++;
          console.log(JSON.stringify({ event: "alert_skipped", reason: action.skip, email: sub.email, kind: action.kind, score: action.score }));
          continue;
        }
        const tz = home?.timezone || sub.tz || "UTC";
        const lightSources = spotScores.length ? spotScores : (home ? [home] : []);
        const html = renderEmail(action.score, {
          when: action.when,
          ranking: action.ranking,
          plan: sub.plan === "pro" ? "pro" : "free",
          shareUrl: `${base}/s/${encodeURIComponent(action.score.location)}`,
          unsubscribeUrl: `${base}/api/unsubscribe?token=${sub.unsubscribe_token}`,
          light: lightSources.map((spot) => lightSpot(spot, tz)).filter(Boolean),
          outlook,
        });
        const result = await send({ to: sub.email, subject: emailSubject(action.score, action.when), html });
        if (!result.ok) {
          summary.errors++;
          continue;
        }
        await recordSend(db, sub.id, action.kind, action.localDate);
        if (result.sent) summary.sent++;
        else summary.noop++;
      }
    } catch (err) {
      summary.errors++;
      console.log(JSON.stringify({ event: "alert_error", email: sub.email, message: String(err?.message || err) }));
    }
  }
  console.log(JSON.stringify({ event: "alerts_done", ...summary }));
  return summary;
}
