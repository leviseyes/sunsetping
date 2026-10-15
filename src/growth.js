import { CITIES, cityBySlug, nearbyCities } from "./cities.js";
import { simplePage } from "./pages.js";

const SITE = "https://sunsetping.com";
const OG_IMAGE = `${SITE}/images/hero-sunset.jpg`;

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

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

const SCORE_SCRIPT = `<script>
(function () {
  var slot = document.getElementById("live-score");
  if (!slot) return;
  var q = slot.getAttribute("data-query") || "";
  fetch("/api/score?q=" + encodeURIComponent(q)).then(function (res) {
    return res.json().then(function (data) { return { ok: res.ok, data: data }; });
  }).then(function (result) {
    if (!result.ok) throw new Error(result.data && result.data.error || "unavailable");
    var data = result.data;
    slot.replaceChildren();
    var score = document.createElement("p");
    score.className = "city-score";
    var strong = document.createElement("strong");
    strong.textContent = String(data.score) + "/10";
    score.append(strong, " ", data.verdict || "");
    var time = document.createElement("p");
    time.className = "lede";
    time.textContent = "Sunset " + (data.sunset || "") + (data.tz ? " " + data.tz : "") + ".";
    var why = document.createElement("p");
    why.textContent = data.reason || "";
    slot.append(score, time, why);
  }).catch(function () {
    var note = slot.querySelector(".status");
    if (note) note.textContent = "Tonight's score will show here as soon as the forecast responds.";
  });
  var tz = document.getElementById("tz");
  if (tz) {
    try { tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (err) {}
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

export function sunsetCity(env, slug) {
  const city = cityBySlug(slug);
  if (!city) return simplePage("No city page", "That sunset city isn't in the guide. Try the city index.", 404);
  const base = origin(env);
  const canonical = `${base}/sunset/${city.slug}`;
  const title = `Will tonight's sunset be good in ${city.city}?`;
  const description = `Tonight's sunset score for ${city.city}, ${city.region}. Sunset time, where to stand (${city.spots[0]}), and a free alert.`;
  const nearby = nearbyCities(city).map((other) =>
    `<a href="/sunset/${esc(other.slug)}">${esc(other.city)}</a>`
  ).join("");
  const spots = city.spots.map((spot) => `<li>${esc(spot)}</li>`).join("");
  const html = `<!doctype html><html lang="en"><head>${head({
    title: `${title} · SunsetPing`,
    description,
    canonical,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: title,
      url: canonical,
      description,
      isPartOf: { "@type": "WebSite", name: "SunsetPing", url: `${base}/` },
      about: { "@type": "Place", name: `${city.city}, ${city.region}` },
    },
  })}</head>
<body><main class="wrap doc">
${topbar()}
<p class="kicker">${esc(city.region)}</p>
<h1>${esc(title)}</h1>
<p class="lede">${esc(city.tip)}</p>
<section id="live-score" class="city-live" data-query="${esc(city.query)}" aria-live="polite">
<p class="status">Checking tonight's sky in ${esc(city.city)}…</p>
</section>
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
  return htmlResponse(html);
}

export function sitemapXml(env) {
  const base = origin(env);
  const urls = ["/", "/pro", "/faq", "/sunset", ...CITIES.map((city) => `/sunset/${city.slug}`)];
  const body = urls.map((path) => `  <url><loc>${base}${path}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

export function growthRoute(url, env) {
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (path === "/sitemap.xml") return sitemapXml(env);
  if (path === "/sunset") return sunsetIndex(env);
  if (path.startsWith("/sunset/")) {
    const slug = decodeURIComponent(path.slice("/sunset/".length));
    if (!slug || slug.includes("/")) return simplePage("No city page", "That sunset city isn't in the guide. Try the city index.", 404);
    return sunsetCity(env, slug);
  }
  return null;
}
