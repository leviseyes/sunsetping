import { cityBySlug } from "./cities.js";
import { authorizeCron } from "./newsletter.js";

/** Beacon events the browser may send to POST /api/t. */
export const TRACK_EVENTS = ["pageview", "form_view", "form_focus", "form_submit"];

/** Events stored in analytics_daily. signup_ok and embed_view are server-side only. */
export const ANALYTICS_EVENTS = [...TRACK_EVENTS, "signup_ok", "embed_view"];

const EXACT_PATHS = new Set([
  "/",
  "/tonight",
  "/faq",
  "/photo-of-the-month",
  "/sunset",
  "/sunset-time",
  "/golden-hour",
  "/widget",
]);

const HTML_ALIASES = {
  "/index.html": "/",
  "/faq.html": "/faq",
  "/photo-of-the-month.html": "/photo-of-the-month",
};

const CITY_PREFIXES = ["/sunset/", "/sunset-time/", "/golden-hour/", "/embed/"];

/**
 * Bots and non-browser clients. "bot" already covers Googlebot and friends.
 * The list is intentionally broad: a missed human is better than counting a crawler.
 */
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|python|curl|wget|httpclient|go-http|java|okhttp|axios|node-fetch|ips-agent|semrush|ahrefs|bingpreview|gptbot|claude|perplexity|bytespider|scrapy|phantom|selenium|puppeteer|playwright|httpie|libwww|petalbot|applebot|embedly|slackbot|discordbot|telegrambot|whatsapp|linkedinbot|twitterbot|redditbot|ia_archiver|chatgpt|anthropic|ccbot|amazonbot|duckduckbot|yandex|baiduspider|sogou|mj12bot|dotbot|rogerbot|seznambot|screaming frog|uptimerobot|pingdom|headlesschrome/i;

const OWN_HOSTS = new Set(["sunsetping.com", "www.sunsetping.com"]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function pacificDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function addDaysIso(iso, delta) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

export function isBotUa(ua) {
  const raw = String(ua ?? "").trim();
  if (!raw) return true;
  return BOT_UA.test(raw);
}

/** When Sec-Fetch-Site is present it must be same-origin. Absent is allowed. */
export function allowsTrackSite(header) {
  if (header == null || header === "") return true;
  return String(header).toLowerCase() === "same-origin";
}

export function normalizeForm(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.length > 32) return "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(raw)) return "";
  return raw;
}

/**
 * Collapse a path to the public route set. Anything else, including search
 * queries on /s/, becomes a fixed bucket so the table cannot grow with URLs.
 */
export function normalizeAnalyticsPath(raw) {
  let path = String(raw ?? "").trim();
  if (!path || path.length > 200) return "/other";
  if (/^https?:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      const host = url.hostname.toLowerCase();
      if (host && !OWN_HOSTS.has(host)) return "/other";
      path = url.pathname || "/";
    } catch {
      return "/other";
    }
  }
  path = path.split("?")[0].split("#")[0];
  if (!path.startsWith("/")) return "/other";
  try {
    path = decodeURIComponent(path);
  } catch {
    return "/other";
  }
  path = path.toLowerCase();
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!path.startsWith("/") || path.length > 100) return "/other";
  if (HTML_ALIASES[path]) path = HTML_ALIASES[path];
  if (EXACT_PATHS.has(path)) return path;
  if (path.startsWith("/s/")) return "/s/*";
  for (const prefix of CITY_PREFIXES) {
    if (!path.startsWith(prefix)) continue;
    const slug = path.slice(prefix.length);
    if (!slug || slug.includes("/") || !cityBySlug(slug)) return "/other";
    return prefix + slug;
  }
  return "/other";
}

export function normalizeReferrerHost(value, ownHost = "") {
  let raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw.length > 200) return "";
  let host = raw;
  if (raw.includes("://") || raw.includes("/") || raw.includes("?") || raw.includes("#") || raw.includes(":")) {
    try {
      const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
      host = url.hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  host = host.replace(/\.+$/, "");
  if (!host || host.length > 60) return "";
  if (!/^[a-z0-9.-]+$/.test(host)) return "";
  if (host.startsWith(".") || host.startsWith("-") || host.endsWith(".") || host.endsWith("-") || host.includes("..")) return "";
  const owns = new Set(OWN_HOSTS);
  const extra = String(ownHost || "").trim().toLowerCase().replace(/:\d+$/, "");
  if (extra) owns.add(extra);
  if (owns.has(host)) return "";
  return host;
}

export function referrerFromRequest(req) {
  let own = "";
  try {
    own = new URL(req.url).hostname;
  } catch {
    own = "";
  }
  return normalizeReferrerHost(req.headers?.get("referer") || req.headers?.get("referrer") || "", own);
}

/**
 * signup_path / signup_form from a subscribe body. Missing is null.
 * Oversized or nonsense values are ignored (null), not stored.
 */
export function signupAttribution(body) {
  const result = { path: null, form: null };
  if (!body || typeof body !== "object") return result;
  const pathRaw = body.signup_path;
  if (typeof pathRaw === "string" && pathRaw.trim() && pathRaw.length <= 200 && pathRaw.trim().startsWith("/")) {
    result.path = normalizeAnalyticsPath(pathRaw);
  }
  const formRaw = body.signup_form;
  if (typeof formRaw === "string" && formRaw.trim() && formRaw.length <= 32) {
    const form = normalizeForm(formRaw);
    if (form) result.form = form;
  }
  return result;
}

export function statsDays(value) {
  if (value == null || value === "") return 7;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 7;
  return Math.min(60, n);
}

export async function recordAnalytics(env, { event, path, form = "", referrer = "" } = {}, now = new Date()) {
  if (!ANALYTICS_EVENTS.includes(event)) return;
  if (!env?.DB?.prepare) return;
  const day = pacificDay(now);
  const safePath = normalizeAnalyticsPath(path);
  const safeForm = normalizeForm(form);
  const safeRef = normalizeReferrerHost(referrer);
  await env.DB.prepare(
    `INSERT INTO analytics_daily (day, path, event, form, referrer_host, count)
     VALUES (?1, ?2, ?3, ?4, ?5, 1)
     ON CONFLICT(day, path, event, form, referrer_host) DO UPDATE SET count = count + 1`
  ).bind(day, safePath, event, safeForm, safeRef).run();
}

function emptyEvents() {
  return { pageview: 0, form_view: 0, form_focus: 0, form_submit: 0, signup_ok: 0, embed_view: 0 };
}

export function summarizeAnalytics(rows, { from, to, days }) {
  const byDay = new Map();
  for (let i = 0; ; i++) {
    const day = addDaysIso(from, i);
    byDay.set(day, emptyEvents());
    if (day === to) break;
    if (i > 70) break;
  }
  const paths = new Map();
  const forms = new Map();
  const referrers = new Map();
  for (const row of rows || []) {
    const count = Number(row.count) || 0;
    if (count <= 0) continue;
    const event = row.event;
    if (!ANALYTICS_EVENTS.includes(event)) continue;
    const dayBucket = byDay.get(row.day);
    if (dayBucket) dayBucket[event] += count;
    if (event === "pageview" || event === "form_view" || event === "form_submit" || event === "signup_ok") {
      const bucket = paths.get(row.path) || { path: row.path, pageviews: 0, form_views: 0, submits: 0, signup_ok: 0 };
      if (event === "pageview") bucket.pageviews += count;
      else if (event === "form_view") bucket.form_views += count;
      else if (event === "form_submit") bucket.submits += count;
      else bucket.signup_ok += count;
      paths.set(row.path, bucket);
    }
    if (row.form && (event === "form_view" || event === "form_focus" || event === "form_submit" || event === "signup_ok")) {
      const bucket = forms.get(row.form) || { form: row.form, views: 0, focuses: 0, submits: 0, signup_ok: 0 };
      if (event === "form_view") bucket.views += count;
      else if (event === "form_focus") bucket.focuses += count;
      else if (event === "form_submit") bucket.submits += count;
      else bucket.signup_ok += count;
      forms.set(row.form, bucket);
    }
    if (row.referrer_host && (event === "pageview" || event === "embed_view")) {
      const bucket = referrers.get(row.referrer_host) || { host: row.referrer_host, pageviews: 0, embed_views: 0 };
      if (event === "pageview") bucket.pageviews += count;
      else bucket.embed_views += count;
      referrers.set(row.referrer_host, bucket);
    }
  }
  const pathRows = [...paths.values()].map((row) => ({
    ...row,
    conversion: row.pageviews ? Number((row.signup_ok / row.pageviews).toFixed(4)) : 0,
  })).sort((a, b) => b.pageviews - a.pageviews || b.signup_ok - a.signup_ok || a.path.localeCompare(b.path));
  const formRows = [...forms.values()].sort((a, b) => b.views - a.views || b.submits - a.submits || a.form.localeCompare(b.form));
  const referrerRows = [...referrers.values()]
    .sort((a, b) => b.pageviews - a.pageviews || b.embed_views - a.embed_views || a.host.localeCompare(b.host))
    .slice(0, 20);
  const totals = [...byDay.entries()].map(([day, events]) => ({ day, ...events }));
  return { days, from, to, totals, paths: pathRows, forms: formRows, referrers: referrerRows };
}

async function readAnalytics(env, from, to) {
  const queried = await env.DB.prepare(
    "SELECT day, path, event, form, referrer_host, count FROM analytics_daily WHERE day >= ?1 AND day <= ?2"
  ).bind(from, to).all();
  return queried?.results || [];
}

export async function handleStats(req, env, url) {
  if (req.method !== "GET") return json({ error: "GET only" }, 405);
  if (!authorizeCron(req, env)) return json({ error: "Unauthorized" }, 401);
  const days = statsDays(url.searchParams.get("days"));
  const to = pacificDay();
  const from = addDaysIso(to, -(days - 1));
  try {
    const rows = await readAnalytics(env, from, to);
    return json(summarizeAnalytics(rows, { from, to, days }));
  } catch (err) {
    console.log(JSON.stringify({ event: "analytics_read_failed", message: String(err?.message || err) }));
    return json({ error: "Stats are temporarily unavailable." }, 502);
  }
}

/**
 * Read and validate the beacon before any response is returned.
 * The Workers runtime locks the request body once the response is sent, so
 * this must not run inside ctx.waitUntil.
 */
async function readTrack(req) {
  if (req.method !== "POST") return null;
  if (isBotUa(req.headers.get("user-agent"))) return null;
  if (!allowsTrackSite(req.headers.get("sec-fetch-site"))) return null;
  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > 1024) return null;
  const raw = await req.text();
  if (raw.length > 1024) return null;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const event = String(body.e || "").trim().toLowerCase();
  if (!TRACK_EVENTS.includes(event)) return null;
  let own = "";
  try {
    own = new URL(req.url).hostname;
  } catch {
    own = "";
  }
  return {
    event,
    path: body.p,
    form: body.f,
    referrer: normalizeReferrerHost(body.r, own),
  };
}

/** POST /api/t. Always 204. Only the D1 write is deferred. */
export async function handleTrack(req, env, ctx) {
  let fields = null;
  try {
    fields = await readTrack(req);
  } catch (err) {
    console.log(JSON.stringify({ event: "analytics_write_failed", message: String(err?.message || err) }));
    return new Response(null, { status: 204 });
  }
  if (fields) {
    const task = recordAnalytics(env, fields).catch((err) => {
      console.log(JSON.stringify({ event: "analytics_write_failed", message: String(err?.message || err) }));
    });
    if (typeof ctx?.waitUntil === "function") ctx.waitUntil(task);
    else await task;
  }
  return new Response(null, { status: 204 });
}

export async function recordServerEvent(env, ctx, fields) {
  const task = recordAnalytics(env, fields).catch((err) => {
    console.log(JSON.stringify({ event: "analytics_write_failed", message: String(err?.message || err) }));
  });
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(task);
  else await task;
}
