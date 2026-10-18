/**
 * Top-level navigation check for GET /api/checkout.
 *
 * A request is not a real navigation when Sec-Fetch-Mode is present and not
 * "navigate", or Sec-Fetch-Dest is present and not "document".
 *
 * Modern Chromium (Chrome/ or Edg/ major >= 90) and Firefox (Firefox/ major >= 90)
 * always send Sec-Fetch-Mode and Accept-Language on a link click. CriOS and EdgiOS
 * are iOS WebKit, not that Chromium, so they are not held to those headers.
 * Safari, other WebKit, curl, and unknown clients keep the direct session.
 *
 * confirm=1 is the interstitial's own submit. The caller skips this check for it.
 */

const IOS_WEBKIT = /(?:CriOS|EdgiOS)\//i;

function majorVersion(ua, token) {
  const match = String(ua || "").match(new RegExp(`(?:^|[^A-Za-z])${token}/(\\d+)`));
  return match ? Number(match[1]) : null;
}

export function claimsModernChromiumOrFirefox(ua) {
  const raw = String(ua || "");
  if (IOS_WEBKIT.test(raw)) return false;
  const chrome = majorVersion(raw, "Chrome");
  const edge = majorVersion(raw, "Edg");
  const firefox = majorVersion(raw, "Firefox");
  return (chrome != null && chrome >= 90) || (edge != null && edge >= 90) || (firefox != null && firefox >= 90);
}

export function isRealCheckoutNavigation(req) {
  const mode = req.headers.get("sec-fetch-mode");
  const dest = req.headers.get("sec-fetch-dest");
  if (mode != null && mode.toLowerCase() !== "navigate") return false;
  if (dest != null && dest.toLowerCase() !== "document") return false;
  if (!claimsModernChromiumOrFirefox(req.headers.get("user-agent"))) return true;
  if (mode == null) return false;
  if (!req.headers.has("accept-language")) return false;
  return true;
}

export function checkoutSessionIdSuffix(sessionUrl) {
  try {
    const parts = new URL(String(sessionUrl)).pathname.split("/").filter(Boolean);
    const id = parts.find((part) => /^cs_[A-Za-z0-9_]+$/.test(part));
    return id ? id.slice(-10) : null;
  } catch {
    return null;
  }
}

function clip(value, max) {
  if (value == null) return null;
  const text = String(value).slice(0, max);
  return text === "" ? null : text;
}

function refererHost(req) {
  const raw = req.headers.get("referer");
  if (!raw) return null;
  try {
    return new URL(raw).hostname.slice(0, 253) || null;
  } catch {
    return null;
  }
}

function cfDiagnostics(req) {
  const cf = req?.cf || {};
  let asn = null;
  if (Number.isInteger(cf.asn)) asn = cf.asn;
  else if (typeof cf.asn === "string" && /^\d+$/.test(cf.asn)) asn = Number(cf.asn);
  return {
    country: clip(cf.country, 8),
    asn,
    asOrg: clip(cf.asOrganization, 100),
  };
}

const INSERT_ATTEMPT = `INSERT INTO checkout_attempts (
  plan, outcome, confirm, ua, sec_fetch_mode, sec_fetch_site, sec_fetch_user, sec_fetch_dest,
  has_accept_language, referer_host, country, asn, as_org, session_id_suffix
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`;

async function recordCheckoutAttempt(env, req, { plan, outcome, confirm, sessionUrl }) {
  if (!env?.DB || typeof env.DB.prepare !== "function") return;
  const cf = cfDiagnostics(req);
  const header = (name) => (req.headers.has(name) ? clip(req.headers.get(name), 120) : null);
  await env.DB.prepare(INSERT_ATTEMPT).bind(
    plan === "yearly" ? "yearly" : plan === "monthly" ? "monthly" : clip(plan, 32),
    clip(outcome, 32),
    confirm ? 1 : 0,
    clip(req.headers.get("user-agent"), 300),
    header("sec-fetch-mode"),
    header("sec-fetch-site"),
    header("sec-fetch-user"),
    header("sec-fetch-dest"),
    req.headers.has("accept-language") ? 1 : 0,
    refererHost(req),
    cf.country,
    cf.asn,
    cf.asOrg,
    sessionUrl ? checkoutSessionIdSuffix(sessionUrl) : null,
  ).run();
}

/** Never throws and never blocks the checkout response. */
export function logCheckoutAttempt(ctx, env, req, fields) {
  const task = recordCheckoutAttempt(env, req, fields).catch((err) => {
    console.log(JSON.stringify({ event: "checkout_attempt_log_failed", message: String(err?.message || err) }));
  });
  try {
    if (typeof ctx?.waitUntil === "function") ctx.waitUntil(task);
  } catch (err) {
    console.log(JSON.stringify({ event: "checkout_attempt_log_failed", message: String(err?.message || err) }));
  }
}
