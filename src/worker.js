import { emailProblem } from "./email-quality.js";
import { changeCityUrl, defaultPlaceFromCf } from "./geo-default.js";
import { queryForCatalogSlug } from "./cities.js";
import { rankScores, scoreForecastDay, withZoneAbbrev } from "./scoring.js";
import { fetchForecast, HttpError, resolvePlace } from "./openmeteo.js";
import { MAX_SPOTS, runAlerts } from "./alerts.js";
import { authorizeCron, issueError, prepareIssue, runWeeklyNewsletter } from "./newsletter.js";
import { ogSvg, sharePage, simplePage, welcomeOfferHtml, welcomePage } from "./pages.js";
import { deliverWelcome, loadTonight } from "./welcome.js";
import { stripeWebhook } from "./stripe.js";
import { growthRoute, tonightApi } from "./growth.js";
import { downloadLinks, moshPdfUrl, wantsGreatNights } from "./signup.js";
import { handleStats, handleTrack, recordServerEvent, referrerFromRequest, signupAttribution } from "./analytics.js";

const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function wantsJson(req) {
  const ct = req.headers.get("content-type") || "";
  return ct.includes("json") || (req.headers.get("accept") || "").includes("json");
}

async function readBody(req) {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("json")) return req.json().catch(() => ({}));
  const form = await req.formData().catch(() => new FormData());
  return Object.fromEntries(form);
}

function publicDay(scored) {
  return withZoneAbbrev(scored);
}

async function scoreQuery(input, days, fetchImpl) {
  const place = await resolvePlace(input, fetchImpl);
  const forecast = await fetchForecast(place.latitude, place.longitude, days, fetchImpl);
  const meta = { location: place.name, lat: place.latitude, lon: place.longitude, timezone: place.timezone };
  const scored = [];
  for (let i = 0; i < days; i++) {
    const day = scoreForecastDay(forecast, i, meta);
    if (day) scored.push(day);
  }
  if (!scored.length) throw new HttpError(502, "Sunset forecast is temporarily unavailable.");
  return { place, days: scored };
}

function inputFromUrl(url) {
  const lat = url.searchParams.get("lat") ?? url.searchParams.get("latitude");
  const lon = url.searchParams.get("lon") ?? url.searchParams.get("longitude");
  if (lat != null && lon != null && lat !== "" && lon !== "") return { lat, lon };
  return { q: url.searchParams.get("q") || "" };
}

async function subscribe(req, env, ctx) {
  const body = await readBody(req);
  const asJson = wantsJson(req);
  const fail = (message, status = 400) => (asJson ? json({ ok: false, error: message }, status) : simplePage("Hmm…", message, status));
  const email = String(body.email || "").trim().toLowerCase();
  const location = String(body.location || "").trim().slice(0, 100);
  const threshold = wantsGreatNights(body.great_only) ? 8 : null;
  if (!EMAIL_RE.test(email) || email.length > 254) return fail("Please enter a valid email.");
  const junk = emailProblem(email);
  if (junk) return fail(junk);
  if (location.length === 1) return fail("Please enter a city or ZIP code, or leave it blank.");
  let place = null;
  if (location.length >= 2) {
    try {
      place = await resolvePlace({ q: location });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return fail("We couldn't find that location. Try a city name.");
      return fail("We couldn't look up that location. Try again.", 502);
    }
  }
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const attribution = signupAttribution(body);
  const prior = await env.DB.prepare(
    "SELECT id, location, lat, lon, tz FROM subscribers WHERE email = ?1"
  ).bind(email).first();
  const isNew = !prior;
  // One-field forms send no city. Use the visitor's Cloudflare location so
  // alerts start right away (the welcome email links to "change your city").
  if (!place && !(prior && prior.lat != null && prior.lon != null)) {
    place = defaultPlaceFromCf(req.cf);
  }
  const stored = {
    location: place ? place.name : (prior?.location || ""),
    lat: place ? place.latitude : (prior?.lat ?? null),
    lon: place ? place.longitude : (prior?.lon ?? null),
    tz: place ? (place.timezone || body.tz || null) : (prior?.tz || body.tz || null),
  };
  await saveSubscriber(env, {
    email,
    location: stored.location,
    lat: stored.lat,
    lon: stored.lon,
    tz: stored.tz,
    token,
    threshold,
    signupPath: attribution.path,
    signupForm: attribution.form,
  });
  const row = await env.DB.prepare(
    "SELECT id, email, location, unsubscribe_token FROM subscribers WHERE email = ?1"
  ).bind(email).first();
  const tonight = place ? await loadTonight(place) : null;
  const downloads = downloadLinks(env);
  const offer = { location: stored.location, email, tonight, downloads };
  if (isNew && row?.id) {
    const task = deliverWelcome({ env, subscriber: { ...row, location: stored.location }, tonight });
    if (typeof ctx?.waitUntil === "function") ctx.waitUntil(task);
    else await task;
  }
  await recordServerEvent(env, ctx, {
    event: "signup_ok",
    path: attribution.path || "/other",
    form: attribution.form || "",
    referrer: referrerFromRequest(req),
  });
  if (asJson) return json({ ok: true, location: stored.location, tonight, downloads, offerHtml: welcomeOfferHtml(offer) });
  return welcomePage(offer);
}

async function saveSubscriber(env, row) {
  const withAttribution = `INSERT INTO subscribers (email, location, lat, lon, tz, unsubscribe_token, status, score_threshold, signup_path, signup_form) VALUES (?1,?2,?3,?4,?5,?6,'active',?7,?8,?9)
     ON CONFLICT(email) DO UPDATE SET location=?2, lat=?3, lon=?4, tz=?5, status='active', score_threshold=?7`;
  const legacy = `INSERT INTO subscribers (email, location, lat, lon, tz, unsubscribe_token, status, score_threshold) VALUES (?1,?2,?3,?4,?5,?6,'active',?7)
     ON CONFLICT(email) DO UPDATE SET location=?2, lat=?3, lon=?4, tz=?5, status='active', score_threshold=?7`;
  try {
    await env.DB.prepare(withAttribution).bind(
      row.email, row.location, row.lat, row.lon, row.tz, row.token, row.threshold, row.signupPath, row.signupForm,
    ).run();
  } catch (err) {
    if (!/no such column/i.test(String(err?.message || err))) throw err;
    await env.DB.prepare(legacy).bind(
      row.email, row.location, row.lat, row.lon, row.tz, row.token, row.threshold,
    ).run();
  }
}

const TOKEN_RE = /^[a-f0-9]{64}$/;

function cityFormPage({ token, current = "", message = "", status = 200 }) {
  const e = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Change your city · SunsetPing</title><link rel="stylesheet" href="/styles.css"></head>
<body class="gate"><main class="gate-card">
<a class="logo" href="/">SunsetPing</a>
<h1>Change your city</h1>
${current ? `<p>Alerts are going to <b>${e(current)}</b>.</p>` : ""}${message ? `<p>${e(message)}</p>` : ""}
<form class="stack" action="/api/city" method="post">
<input type="hidden" name="token" value="${e(token)}">
<label class="sr-only" for="city-location">City or ZIP</label>
<input id="city-location" type="text" name="location" placeholder="City or ZIP" required minlength="2" maxlength="100" autocomplete="address-level2">
<button class="btn" type="submit">Use this city</button>
</form>
</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function cityPage(url, env) {
  const token = url.searchParams.get("token") || "";
  if (!TOKEN_RE.test(token)) return simplePage("Invalid link", "That link isn't valid.", 400);
  const row = await env.DB.prepare("SELECT id, location FROM subscribers WHERE unsubscribe_token = ?1").bind(token).first();
  if (!row) return simplePage("Not found", "We couldn't find that subscription.", 404);
  return cityFormPage({ token, current: row.location });
}

async function changeCity(req, env) {
  const body = await readBody(req);
  const asJson = wantsJson(req);
  const token = String(body.token || "");
  const location = String(body.location || "").trim().slice(0, 100);
  const fail = (message, status = 400) => (asJson ? json({ ok: false, error: message }, status) : cityFormPage({ token, message, status }));
  if (!TOKEN_RE.test(token)) return asJson ? json({ ok: false, error: "Invalid link." }, 400) : simplePage("Invalid link", "That link isn't valid.", 400);
  if (location.length < 2) return fail("Please enter a city or ZIP code.");
  let place;
  try {
    place = await resolvePlace({ q: queryForCatalogSlug(location) });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return fail("We couldn't find that location. Try a city name.");
    return fail("We couldn't look up that location. Try again.", 502);
  }
  const r = await env.DB.prepare("UPDATE subscribers SET location = ?1, lat = ?2, lon = ?3, tz = ?4 WHERE unsubscribe_token = ?5")
    .bind(place.name, place.latitude, place.longitude, place.timezone || null, token).run();
  if (!r.meta?.changes) return asJson ? json({ ok: false, error: "Not found." }, 404) : simplePage("Not found", "We couldn't find that subscription.", 404);
  if (asJson) return json({ ok: true, location: place.name });
  return simplePage("City updated", `Your sunset alerts now go to ${place.name}.`);
}

async function unsubscribe(url, env) {
  const t = url.searchParams.get("token") || "";
  if (!/^[a-f0-9]{64}$/.test(t)) return simplePage("Invalid link", "That unsubscribe link isn't valid.", 400);
  const r = await env.DB.prepare("UPDATE subscribers SET status='unsubscribed' WHERE unsubscribe_token=?1").bind(t).run();
  return r.meta?.changes ? simplePage("Unsubscribed", "You won't get any more SunsetPing emails.") : simplePage("Not found", "That link has already been used or doesn't exist.", 404);
}

async function findSubscriber(env, email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(normalized)) throw new HttpError(400, "Please enter a valid email.");
  const row = await env.DB.prepare(
    "SELECT id, email, location, lat, lon, tz, plan, score_threshold, sunrise_alerts, day_before, lead_minutes, status FROM subscribers WHERE email = ?1"
  ).bind(normalized).first();
  if (!row || row.status !== "active") throw new HttpError(404, "Subscribe first, then you can save spots and alert settings.");
  return row;
}

function accountPayload(row, spots) {
  return {
    email: row.email,
    plan: row.plan === "pro" ? "pro" : "free",
    location: row.location,
    lat: row.lat,
    lon: row.lon,
    scoreThreshold: row.score_threshold == null ? null : Number(row.score_threshold),
    sunriseAlerts: Boolean(Number(row.sunrise_alerts)),
    dayBefore: Boolean(Number(row.day_before)),
    leadMinutes: Number(row.lead_minutes) || 180,
    limit: MAX_SPOTS,
    spots: (spots || []).map((s) => ({ id: s.id, label: s.label, lat: s.lat, lon: s.lon, tz: s.tz })),
  };
}

async function listSpots(env, subscriberId) {
  const rows = await env.DB.prepare("SELECT id, label, lat, lon, tz FROM saved_locations WHERE subscriber_id = ?1 ORDER BY id").bind(subscriberId).all();
  return rows.results || [];
}

async function rankInputs(spots) {
  if (!Array.isArray(spots) || spots.length < 1 || spots.length > MAX_SPOTS) {
    throw new HttpError(400, "Rank between 1 and 10 spots.");
  }
  const scored = [];
  const errors = [];
  for (const spot of spots) {
    try {
      const input = spot?.q ? { q: spot.q } : { lat: spot?.lat, lon: spot?.lon, name: spot?.name };
      const result = await scoreQuery(input, 1);
      scored.push(result.days[0]);
    } catch (err) {
      errors.push({ spot, error: err.message || "Could not score that spot." });
    }
  }
  if (!scored.length) throw new HttpError(404, "None of those spots could be scored.");
  const ranking = rankScores(scored);
  return { best: ranking[0], ranking, errors, feature: "best-spot-tonight" };
}

async function handleApi(req, url, env, ctx) {
  if (url.pathname === "/api/stripe/webhook") return stripeWebhook(req, env);
  if (url.pathname === "/api/t") return handleTrack(req, env, ctx);
  if (url.pathname === "/api/stats") return handleStats(req, env, url);

  if (url.pathname === "/api/tonight") {
    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    return tonightApi(env, { ctx, requestUrl: url });
  }

  if (url.pathname === "/api/score") {
    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    const input = inputFromUrl(url);
    if (typeof input.q === "string") input.q = queryForCatalogSlug(input.q);
    const result = await scoreQuery(input, 1);
    return json(publicDay(result.days[0]), 200, { "cache-control": "public, max-age=600" });
  }

  if (url.pathname === "/api/outlook") {
    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    const result = await scoreQuery(inputFromUrl(url), 7);
    return json({
      feature: "7-day outlook",
      location: result.place.name,
      lat: result.place.latitude,
      lon: result.place.longitude,
      timezone: result.days[0].timezone,
      days: result.days.map(publicDay),
    }, 200, { "cache-control": "public, max-age=600" });
  }

  if (url.pathname === "/api/perks") {
    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    return json({
      moshPdfUrl: moshPdfUrl(env),
      cheatSheetUrl: "/downloads/sunset-cheat-sheet.pdf",
    });
  }

  if (url.pathname === "/api/best-spot") {
    if (req.method === "POST") {
      const body = await readBody(req);
      return json(await rankInputs(body.spots));
    }
    if (req.method !== "GET") return json({ error: "GET or POST" }, 405);
    const email = url.searchParams.get("email");
    if (email) {
      const row = await findSubscriber(env, email);
      const saved = await listSpots(env, row.id);
      const spots = [{ lat: row.lat, lon: row.lon, name: row.location }, ...saved.map((s) => ({ lat: s.lat, lon: s.lon, name: s.label }))].slice(0, MAX_SPOTS);
      return json(await rankInputs(spots));
    }
    const names = url.searchParams.getAll("spot").filter(Boolean);
    if (!names.length) return json({ error: "Pass spot parameters or an email." }, 400);
    return json(await rankInputs(names.map((q) => ({ q }))));
  }

  if (url.pathname === "/api/subscribe") {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    return subscribe(req, env, ctx);
  }
  if (url.pathname === "/api/unsubscribe") return unsubscribe(url, env);
  if (url.pathname === "/api/city") {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    return changeCity(req, env);
  }

  // Editorial issue. Not on the 15-minute alert cron — that job has no copy to send.
  // Deduped per subscriber for the issue week via alert_sends (kind newsletter).
  if (url.pathname === "/api/cron/newsletter") {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if (!authorizeCron(req, env)) return json({ error: "Unauthorized" }, 401);
    const now = new Date();
    const issue = prepareIssue(await readBody(req), now);
    const error = issueError(issue);
    if (error) return json({ error }, 400);
    const summary = await runWeeklyNewsletter(env, issue, now);
    return json({ ok: true, issueDate: issue.issueDate, ...summary });
  }

  if (url.pathname === "/api/account") {
    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    const row = await findSubscriber(env, url.searchParams.get("email"));
    return json(accountPayload(row, await listSpots(env, row.id)));
  }

  if (url.pathname === "/api/locations") {
    if (req.method === "GET") {
      const row = await findSubscriber(env, url.searchParams.get("email"));
      return json(accountPayload(row, await listSpots(env, row.id)));
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const row = await findSubscriber(env, body.email);
      const existing = await listSpots(env, row.id);
      if (existing.length >= MAX_SPOTS) throw new HttpError(409, "You can save up to 10 spots.");
      const place = await resolvePlace(body.lat != null && body.lon != null && body.lat !== "" ? { lat: body.lat, lon: body.lon, name: body.label || body.location } : { q: body.location || body.q });
      await env.DB.prepare("INSERT INTO saved_locations (subscriber_id, label, lat, lon, tz) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(row.id, place.name, place.latitude, place.longitude, place.timezone).run();
      const spots = await listSpots(env, row.id);
      return json({ ok: true, ...accountPayload(row, spots) }, 201);
    }
    if (req.method === "DELETE") {
      const body = await readBody(req);
      const row = await findSubscriber(env, body.email);
      const id = Number(body.id);
      if (!Number.isInteger(id)) throw new HttpError(400, "Missing spot id.");
      const result = await env.DB.prepare("DELETE FROM saved_locations WHERE id = ?1 AND subscriber_id = ?2").bind(id, row.id).run();
      if (!result.meta?.changes) throw new HttpError(404, "That spot is not on your list.");
      return json({ ok: true, ...accountPayload(row, await listSpots(env, row.id)) });
    }
    return json({ error: "GET, POST, or DELETE" }, 405);
  }

  if (url.pathname === "/api/settings") {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const body = await readBody(req);
    const row = await findSubscriber(env, body.email);
    let threshold = row.score_threshold;
    let sunrise = Number(row.sunrise_alerts) ? 1 : 0;
    let dayBefore = Number(row.day_before) ? 1 : 0;
    let lead = Number(row.lead_minutes) || 180;
    const touched = ["scoreThreshold", "sunriseAlerts", "dayBefore", "leadMinutes"].some((k) => k in body);
    if (!touched) throw new HttpError(400, "Nothing to update.");
    if ("scoreThreshold" in body) {
      if (body.scoreThreshold == null || body.scoreThreshold === "") threshold = null;
      else {
        const n = Number(body.scoreThreshold);
        if (!Number.isInteger(n) || n < 1 || n > 10) throw new HttpError(400, "Score threshold must be a whole number from 1 to 10, or empty to alert every day.");
        threshold = n;
      }
    }
    if ("sunriseAlerts" in body) sunrise = body.sunriseAlerts ? 1 : 0;
    if ("dayBefore" in body) dayBefore = body.dayBefore ? 1 : 0;
    if ("leadMinutes" in body) {
      const n = Number(body.leadMinutes);
      if (!Number.isInteger(n) || n < 60 || n > 360) throw new HttpError(400, "Alert lead time must be between 60 and 360 minutes.");
      lead = n;
    }
    await env.DB.prepare("UPDATE subscribers SET score_threshold = ?1, sunrise_alerts = ?2, day_before = ?3, lead_minutes = ?4 WHERE id = ?5")
      .bind(threshold, sunrise, dayBefore, lead, row.id).run();
    const updated = { ...row, score_threshold: threshold, sunrise_alerts: sunrise, day_before: dayBefore, lead_minutes: lead };
    return json({ ok: true, ...accountPayload(updated, await listSpots(env, row.id)) });
  }

  if (url.pathname === "/api/checkout") {
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "GET only" }, 405);
    return Response.redirect(new URL("/#signup", url), 302);
  }

  if (url.pathname === "/api/og.svg") {
    return ogSvg({
      score: url.searchParams.get("score") || "–",
      location: url.searchParams.get("location") || "Tonight's sunset",
      verdict: url.searchParams.get("verdict") || "SunsetPing",
      sunset: url.searchParams.get("sunset") || "",
      date: url.searchParams.get("date") || "",
    });
  }

  return null;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/city" || url.pathname === "/city/") return cityPage(url, env);
      if (url.pathname === "/lookup") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return Response.redirect(new URL("/", url), 302);
        return Response.redirect(new URL(`/s/${encodeURIComponent(q)}`, url), 302);
      }
      if (url.pathname === "/pro" || url.pathname === "/pro/" || url.pathname === "/pro.html") {
        return Response.redirect(new URL("/#signup", url), 301);
      }
      if (url.pathname === "/photo-of-the-month" || url.pathname === "/photo-of-the-month/") {
        const assetUrl = new URL(req.url);
        assetUrl.pathname = "/photo-of-the-month.html";
        return env.ASSETS.fetch(new Request(assetUrl, req));
      }
      if (url.pathname === "/faq" || url.pathname === "/faq/") {
        const assetUrl = new URL(req.url);
        assetUrl.pathname = "/faq.html";
        return env.ASSETS.fetch(new Request(assetUrl, req));
      }
      const growth = await growthRoute(url, env, ctx, { request: req });
      if (growth) return growth;
      if (url.pathname.startsWith("/api/")) {
        const handled = await handleApi(req, url, env, ctx);
        if (handled) return handled;
        return json({ error: "Not found" }, 404);
      }
      if (url.pathname.startsWith("/s/")) {
        const q = decodeURIComponent(url.pathname.slice(3)).trim();
        if (!q) return simplePage("Missing place", "Add a city or ZIP to the link.", 400);
        const result = await scoreQuery({ q }, 1);
        const day = publicDay(result.days[0]);
        const canonical = new URL(`/s/${encodeURIComponent(day.location)}`, url.origin).toString();
        // Score-free image: unfurlers cache cards for days, so never bake the score in.
        const image = new URL("/images/hero-sunset.jpg", url.origin);
        return sharePage({ score: day, canonical, image: image.toString(), showMosh: Boolean(moshPdfUrl(env)) });
      }
      return env.ASSETS.fetch(req);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : Number.isInteger(err?.status) ? err.status : 0;
      const cityPath = url.pathname.replace(/\/$/, "") || "/";
      if (cityPath.startsWith("/sunset/") || cityPath.startsWith("/golden-hour/") || cityPath.startsWith("/sunrise/")) {
        console.log(JSON.stringify({ event: "city_page_error", path: url.pathname, message: String(err?.message || err) }));
        try {
          const fallback = await growthRoute(url, env, ctx, { skipScore: true, request: req });
          if (fallback) return fallback;
        } catch (inner) {
          console.log(JSON.stringify({ event: "city_page_fallback_error", path: url.pathname, message: String(inner?.message || inner) }));
        }
        const label = cityPath.startsWith("/golden-hour/") ? "Golden hour" : cityPath.startsWith("/sunrise/") ? "Sunrise" : "Tonight's sunset";
        return simplePage(label, "The forecast will be back shortly.", 200);
      }
      if (status) {
        if (url.pathname.startsWith("/api/")) return json({ error: err.message }, status);
        return simplePage("Hmm…", err.message, status);
      }
      console.log(JSON.stringify({ event: "request_error", path: url.pathname, message: String(err?.message || err) }));
      if (url.pathname.startsWith("/api/")) return json({ error: "Sunset forecast is temporarily unavailable." }, 502);
      return simplePage("Hmm…", "Sunset forecast is temporarily unavailable.", 502);
    }
  },

  async scheduled(event, env, ctx) {
    // Daily alerts only. The weekly newsletter is POST /api/cron/newsletter.
    const now = new Date(event?.scheduledTime || Date.now());
    ctx.waitUntil(runAlerts(env, now));
  },
};
