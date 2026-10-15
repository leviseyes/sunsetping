import { CITIES, cityBySlug, nearbyCities } from "./cities.js";
import { INDEXNOW_KEY } from "./indexnow.js";
import { fetchForecast, resolvePlace } from "./openmeteo.js";
import { simplePage } from "./pages.js";
import { scoreForecastDay, withZoneAbbrev } from "./scoring.js";

const SITE = "https://sunsetping.com";
const OG_IMAGE = `${SITE}/images/hero-sunset.jpg`;
/** Edge cache for a rendered city forecast. 25 minutes is inside the 20–30 minute window. */
export const CITY_PAGE_CACHE_SECONDS = 1500;
const CITY_SCORE_TIMEOUT_MS = 8000;
const FALLBACK_CACHE = "public, max-age=60";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function origin(env) {
  return (env?.PUBLIC_BASE_URL || SITE).replace(/\/$/, "");
}

function head({ title, description, canonical, jsonLd }) {
  const ld = jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : "";
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SunsetPing">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${OG_IMAGE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${OG_IMAGE}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">${ld}`;
}

function topbar() {
  return `<header class="topbar"><a class="logo" href="/">SunsetPing</a>
<nav><a href="/sunset">Cities</a><a href="/#pricing">Pricing</a><a href="/pro">Pro</a></nav></header>`;
}

function footer() {
  return `<footer>© 2026 SunsetPing · <a href="/sunset">Sunset cities</a> · <a href="/faq">FAQ</a> · <a href="/pro">Pro</a></footer>`;
}

function htmlResponse(html, status = 200, cacheControl = "public, max-age=3600") {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": cacheControl },
  });
}

/** "5:59 PM" + "6:59 PM" → "5:59-6:59 PM". Different meridians stay fully qualified. */
export function compactClockRange(start, end) {
  const startMer = String(start).slice(-2);
  const endMer = String(end).slice(-2);
  if ((startMer === "AM" || startMer === "PM") && startMer === endMer) {
    return `${String(start).slice(0, -3)}-${end}`;
  }
  return `${start}-${end}`;
}

export function tonightSentence(cityName, score) {
  const tz = score.tz ? ` ${score.tz}` : "";
  const viewing = score.viewing || {};
  let sentence = `Sunset in ${cityName} today (${score.date}) is at ${score.sunset}${tz}.`;
  if (viewing.goldenHourStart && viewing.goldenHourEnd) {
    sentence += ` Golden hour runs ${compactClockRange(viewing.goldenHourStart, viewing.goldenHourEnd)}`;
    sentence += viewing.blueHourEnd ? ` and blue hour ends ${viewing.blueHourEnd}.` : ".";
  }
  sentence += ` Tonight's SunsetPing score is ${score.score}/10: ${score.verdict}.`;
  return sentence;
}

export function cityPageTitle(cityName, score) {
  if (!score) return `Will tonight's sunset be good in ${cityName}? · SunsetPing`;
  return `Sunset time today in ${cityName}: ${score.sunset} · tonight ${score.score}/10 · SunsetPing`;
}

export function cityMetaDescription(cityName, score) {
  const tz = score.tz ? ` ${score.tz}` : "";
  return `Sunset time today in ${cityName} is ${score.sunset}${tz}. Tonight's SunsetPing score is ${score.score}/10: ${score.verdict}.`;
}

/** Calendar date used as sitemap <lastmod> for city pages. US Pacific, so it stays "today" through the evening. */
export function citySitemapLastmod(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const SCORE_SCRIPT = `<script>
(function () {
  var slot = document.getElementById("live-score");
  if (!slot) return;
  var q = slot.getAttribute("data-query") || "";
  var city = slot.getAttribute("data-city") || q.split(",")[0];
  function range(start, end) {
    var sm = String(start || "").slice(-2);
    var em = String(end || "").slice(-2);
    if ((sm === "AM" || sm === "PM") && sm === em) return String(start).slice(0, -3) + "-" + end;
    return start + "-" + end;
  }
  fetch("/api/score?q=" + encodeURIComponent(q)).then(function (res) {
    return res.json().then(function (data) { return { ok: res.ok, data: data }; });
  }).then(function (result) {
    if (!result.ok) throw new Error(result.data && result.data.error || "unavailable");
    var data = result.data;
    var viewing = data.viewing || {};
    var tz = data.tz ? " " + data.tz : "";
    var factText = "Sunset in " + city + " today (" + (data.date || "") + ") is at " + (data.sunset || "") + tz + ".";
    if (viewing.goldenHourStart && viewing.goldenHourEnd) {
      factText += " Golden hour runs " + range(viewing.goldenHourStart, viewing.goldenHourEnd);
      factText += viewing.blueHourEnd ? " and blue hour ends " + viewing.blueHourEnd + "." : ".";
    }
    factText += " Tonight's SunsetPing score is " + data.score + "/10: " + (data.verdict || "") + ".";
    slot.replaceChildren();
    var fact = document.createElement("p");
    fact.className = "city-fact";
    fact.textContent = factText;
    var score = document.createElement("p");
    score.className = "city-score";
    var strong = document.createElement("strong");
    strong.textContent = String(data.score) + "/10";
    score.append(strong, " ", data.verdict || "");
    var time = document.createElement("p");
    time.className = "lede";
    time.textContent = "Sunset " + (data.sunset || "") + tz + ".";
    var why = document.createElement("p");
    why.textContent = data.reason || "";
    slot.append(fact, score, time, why);
  }).catch(function () {
    var note = slot.querySelector(".status");
    if (note) note.textContent = "Tonight's score will show here as soon as the forecast responds.";
  });
  var zone = document.getElementById("tz");
  if (zone) {
    try { zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (err) {}
  }
})();
</script>`;

export function sunsetIndex(env) {
  const base = origin(env);
  const canonical = `${base}/sunset`;
  const title = "Sunset forecasts for 50 cities";
  const description = "Tonight's sunset score for Sedona, Malibu, Key West, Maui, Big Sur, and other cities people actually go to watch the sky.";
  const cards = [...CITIES].sort((a, b) => a.city.localeCompare(b.city)).map((city) =>
    `<a href="/sunset/${esc(city.slug)}"><strong>${esc(city.city)}</strong><span>${esc(city.region)}</span></a>`
  ).join("");
  const html = `<!doctype html><html lang="en"><head>${head({ title: `${title} · SunsetPing`, description, canonical })}</head>
<body><main class="wrap doc">
${topbar()}
<p class="kicker">City forecasts</p>
<h1>Will tonight's sunset be good where you're going?</h1>
<p class="lede">Each page has tonight's score, the sunset time, a few places people stand, and a free alert prefilled with that city.</p>
<nav class="city-list" aria-label="Sunset cities">${cards}</nav>
</main>${footer()}</body></html>`;
  return htmlResponse(html);
}

function cityJsonLd({ base, canonical, city, score, description }) {
  const question = `Will tonight's sunset be good in ${city.city}?`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: score ? `Sunset time today in ${city.city}: ${score.sunset} · tonight ${score.score}/10` : question,
    url: canonical,
    description: score ? tonightSentence(city.city, score) : description,
    isPartOf: { "@type": "WebSite", name: "SunsetPing", url: `${base}/` },
    about: { "@type": "Place", name: `${city.city}, ${city.region}` },
  };
  if (score?.dateModified && /^\d{4}-\d{2}-\d{2}$/.test(score.dateModified)) ld.dateModified = score.dateModified;
  return ld;
}

function liveScoreHtml(city, score) {
  const attrs = `id="live-score" class="city-live" data-query="${esc(city.query)}" data-city="${esc(city.city)}" aria-live="polite"`;
  if (!score) {
    return `<section ${attrs}>
<p class="status">Checking tonight's sky in ${esc(city.city)}…</p>
</section>`;
  }
  const tz = score.tz ? ` ${esc(score.tz)}` : "";
  return `<section ${attrs}>
<p class="city-fact">${esc(tonightSentence(city.city, score))}</p>
<p class="city-score"><strong>${esc(score.score)}/10</strong> ${esc(score.verdict)}</p>
<p class="lede">Sunset ${esc(score.sunset)}${tz}.</p>
<p>${esc(score.reason)}</p>
</section>`;
}

function cityHtml(env, city, score) {
  const base = origin(env);
  const canonical = `${base}/sunset/${city.slug}`;
  const question = `Will tonight's sunset be good in ${city.city}?`;
  const description = score
    ? cityMetaDescription(city.city, score)
    : `Tonight's sunset score for ${city.city}, ${city.region}. Sunset time, where to stand (${city.spots[0]}), and a free alert.`;
  const nearby = nearbyCities(city).map((other) =>
    `<a href="/sunset/${esc(other.slug)}">${esc(other.city)}</a>`
  ).join("");
  const spots = city.spots.map((spot) => `<li>${esc(spot)}</li>`).join("");
  return `<!doctype html><html lang="en"><head>${head({
    title: score ? cityPageTitle(city.city, score) : `${question} · SunsetPing`,
    description,
    canonical,
    jsonLd: cityJsonLd({ base, canonical, city, score, description }),
  })}</head>
<body><main class="wrap doc">
${topbar()}
<p class="kicker">${esc(city.region)}</p>
<h1>${esc(question)}</h1>
<p class="lede">${esc(city.tip)}</p>
${liveScoreHtml(city, score)}
<div class="tips">
<section>
<h2>Where people stand</h2>
<ul>${spots}</ul>
<p><a href="/s/${esc(encodeURIComponent(city.query))}">Share tonight's forecast for ${esc(city.city)}</a></p>
</section>
<section class="panel">
<h2>Free alert for ${esc(city.city)}</h2>
<p>One place, the same day, before the color fades. Unsubscribe any time.</p>
<form class="stack" action="/api/subscribe" method="post">
<label class="sr-only" for="email">Email</label>
<input id="email" type="email" name="email" placeholder="you@email.com" required autocomplete="email" aria-label="Email">
<label class="sr-only" for="location">City</label>
<input id="location" type="text" name="location" value="${esc(city.query)}" required maxlength="100" aria-label="City">
<input type="hidden" name="tz" id="tz">
<button class="btn" type="submit">Alert me in ${esc(city.city)}</button>
</form>
</section>
</div>
<nav class="nearby" aria-label="Nearby cities"><span>Nearby</span> ${nearby} <a href="/sunset">All cities</a></nav>
</main>${footer()}${SCORE_SCRIPT}</body></html>`;
}

function cityResponse(html, score) {
  const cacheControl = score
    ? `public, max-age=${CITY_PAGE_CACHE_SECONDS}, s-maxage=${CITY_PAGE_CACHE_SECONDS}`
    : FALLBACK_CACHE;
  return htmlResponse(html, 200, cacheControl);
}

function edgeCache() {
  try {
    const store = globalThis.caches;
    if (!store?.default?.match || !store?.default?.put) return null;
    return store.default;
  } catch {
    return null;
  }
}

function cityCacheRequest(requestUrl, slug) {
  const key = new URL(requestUrl instanceof URL ? requestUrl.href : String(requestUrl));
  key.pathname = `/sunset/${slug}`;
  key.search = "";
  key.hash = "";
  return new Request(key.toString(), { method: "GET" });
}

function anySignal(signals) {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function scoreTimeoutMs(env) {
  const n = Number(env?.CITY_SCORE_TIMEOUT_MS);
  if (Number.isFinite(n) && n >= 20 && n <= 15000) return n;
  return CITY_SCORE_TIMEOUT_MS;
}

async function loadTonight(query, fetchImpl) {
  const place = await resolvePlace({ q: query }, fetchImpl);
  const forecast = await fetchForecast(place.latitude, place.longitude, 1, fetchImpl);
  const scored = scoreForecastDay(forecast, 0, {
    location: place.name,
    lat: place.latitude,
    lon: place.longitude,
    timezone: place.timezone,
  });
  const presented = withZoneAbbrev(scored);
  if (!presented) return null;
  const dateModified = String(scored.sunsetIso || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(dateModified) ? { ...presented, dateModified } : presented;
}

async function loadTonightWithDeadline(query, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const fetchImpl = (url, init = {}) => {
    const signal = init?.signal ? anySignal([controller.signal, init.signal]) : controller.signal;
    return fetch(url, { ...init, signal });
  };
  let timeout;
  const limit = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Sunset forecast timed out.")), ms);
  });
  const forecast = loadTonight(query, fetchImpl);
  forecast.catch(() => {});
  try {
    return await Promise.race([forecast, limit]);
  } finally {
    clearTimeout(timer);
    clearTimeout(timeout);
    controller.abort();
  }
}

function remember(ctx, task) {
  const pending = Promise.resolve(task).catch((err) => {
    console.log(JSON.stringify({ event: "city_cache_put_failed", message: String(err?.message || err) }));
  });
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(pending);
  return pending;
}

export async function sunsetCity(env, slug, options = {}) {
  const city = cityBySlug(slug);
  if (!city) return simplePage("No city page", "That sunset city isn't in the guide. Try the city index.", 404);
  try {
    const cache = options.skipScore ? null : edgeCache();
    const cacheKey = options.requestUrl ? cityCacheRequest(options.requestUrl, city.slug) : null;
    if (cache && cacheKey) {
      const hit = await cache.match(cacheKey).catch(() => null);
      if (hit) return hit;
    }
    let score = null;
    if (!options.skipScore) {
      try {
        score = await loadTonightWithDeadline(city.query, scoreTimeoutMs(env));
      } catch (err) {
        console.log(JSON.stringify({ event: "city_score_fallback", slug: city.slug, message: String(err?.message || err) }));
        score = null;
      }
    }
    const response = cityResponse(cityHtml(env, city, score), score);
    if (score && cache && cacheKey) {
      try {
        await remember(options.ctx, cache.put(cacheKey, response.clone()));
      } catch (err) {
        console.log(JSON.stringify({ event: "city_cache_put_failed", message: String(err?.message || err) }));
      }
    }
    return response;
  } catch (err) {
    console.log(JSON.stringify({ event: "city_score_fallback", slug: city.slug, message: String(err?.message || err) }));
    return cityResponse(cityHtml(env, city, null), null);
  }
}

export function indexNowKeyResponse() {
  return new Response(INDEXNOW_KEY, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=86400",
    },
  });
}

export function sitemapXml(env) {
  const base = origin(env);
  const lastmod = citySitemapLastmod();
  const urls = ["/", "/pro", "/faq", "/sunset", ...CITIES.map((city) => `/sunset/${city.slug}`)];
  const body = urls.map((path) => {
    const loc = `${base}${path}`;
    if (path.startsWith("/sunset/")) return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
    return `  <url><loc>${loc}</loc></url>`;
  }).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

export async function growthRoute(url, env, ctx, options = {}) {
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (path === `/${INDEXNOW_KEY}.txt`) return indexNowKeyResponse();
  if (path === "/sitemap.xml") return sitemapXml(env);
  if (path === "/sunset") return sunsetIndex(env);
  if (path.startsWith("/sunset/")) {
    const slug = decodeURIComponent(path.slice("/sunset/".length));
    if (!slug || slug.includes("/")) return simplePage("No city page", "That sunset city isn't in the guide. Try the city index.", 404);
    return sunsetCity(env, slug, { ctx, requestUrl: url, skipScore: options.skipScore === true });
  }
  return null;
}
