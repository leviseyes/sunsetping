import { changeCityUrl } from "./geo-default.js";
import { renderWelcomeEmail, welcomeSubject } from "./email.js";
import { forecastUrl } from "./openmeteo.js";
import { scoreForecastDay, withZoneAbbrev } from "./scoring.js";
import { downloadLinks } from "./signup.js";
import { sendEmail } from "./sender.js";

/** Post-signup forecast budget. A miss just omits tonight's score. */
export const FORECAST_BUDGET_MS = 2500;
const WELCOME_KIND = "welcome";
const WELCOME_LOCAL_DATE = "welcome";

function siteBase(env) {
  return (env?.PUBLIC_BASE_URL || "https://sunsetping.com").replace(/\/$/, "");
}

function presentScore(scored) {
  const pub = withZoneAbbrev(scored);
  if (!pub || pub.score == null) return null;
  return {
    score: pub.score,
    verdict: pub.verdict,
    sunset: pub.sunset,
    tz: pub.tz || "",
    date: pub.date,
    reason: pub.reason,
  };
}

export async function loadTonight(place, fetchImpl = fetch, budgetMs = FORECAST_BUDGET_MS) {
  if (place?.latitude == null || place?.longitude == null) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await fetchImpl(forecastUrl(place.latitude, place.longitude, 1), {
      headers: { accept: "application/json", "user-agent": "SunsetPing/1.0 (sunsetping.com)" },
      signal: controller.signal,
    });
    if (!res?.ok) return null;
    const data = await res.json();
    const scored = scoreForecastDay(data, 0, {
      location: place.name,
      lat: place.latitude,
      lon: place.longitude,
      timezone: place.timezone,
    });
    return presentScore(scored);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function claimWelcome(db, subscriberId) {
  try {
    await db.prepare("INSERT INTO alert_sends (subscriber_id, kind, local_date) VALUES (?1, ?2, ?3)")
      .bind(subscriberId, WELCOME_KIND, WELCOME_LOCAL_DATE)
      .run();
    return true;
  } catch (err) {
    if (/unique/i.test(String(err?.message || err))) return false;
    throw err;
  }
}

/**
 * One welcome per subscriber. Claim the alert_sends row first so a second
 * attempt (replay, double submit) cannot send again. Never throws.
 */
export async function deliverWelcome({ env, subscriber, tonight = null, fetchImpl = fetch } = {}) {
  try {
    if (!subscriber?.id || !subscriber.email) return { ok: false, skipped: "missing" };
    const claimed = await claimWelcome(env.DB, subscriber.id);
    if (!claimed) return { ok: true, skipped: "deduped" };
    const base = siteBase(env);
    const html = renderWelcomeEmail({
      location: subscriber.location,
      tonight,
      unsubscribeUrl: `${base}/api/unsubscribe?token=${subscriber.unsubscribe_token}`,
      changeCityUrl: changeCityUrl(base, subscriber.unsubscribe_token),
      downloads: downloadLinks(env),
    });
    return await sendEmail({
      to: subscriber.email,
      subject: welcomeSubject(subscriber.location),
      html,
      env,
      fetchImpl,
    });
  } catch (err) {
    console.log(JSON.stringify({ event: "welcome_error", message: String(err?.message || err) }));
    return { ok: false, sent: false };
  }
}
