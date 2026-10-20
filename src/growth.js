import { CITIES, cityBySlug, nearbyCities } from "./cities.js";
import { INDEXNOW_KEY } from "./indexnow.js";
import { fetchForecast, resolvePlace } from "./openmeteo.js";
import { simplePage } from "./pages.js";
import { scoreForecastDay, withZoneAbbrev } from "./scoring.js";
import { weekSunsetTimes } from "./sun.js";
import { OUTLOOK_CTA, greatNightsField, moshPdfUrl, perkListHtml } from "./signup.js";

const SITE = "https://sunsetping.com";
const OG_IMAGE = `${SITE}/images/hero-sunset.jpg`;
/** Edge cache for a rendered city forecast. 25 minutes is inside the 20–30 minute window. */
export const CITY_PAGE_CACHE_SECONDS = 1500;
/**
 * Prebuilt /og/<slug>.png cards. A day is long enough for link crawlers and
 * short enough that a regenerated card replaces it after the next deploy.
 */
export const OG_CARD_CACHE = "public, max-age=86400, s-maxage=86400";
/**
 * Bump when public/og/*.png changes. X caches the image by URL, so a card
 * unfurled earlier stays on the old picture until this query string changes.
 */
export const OG_CARD_VERSION = "2";
const CITY_SCORE_TIMEOUT_MS = 8000;
const FALLBACK_CACHE = "public, max-age=60";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function origin(env) {
  return (env?.PUBLIC_BASE_URL || SITE).replace(/\/$/, "");
}

function jsonLdMarkup(jsonLd) {
  const blocks = Array.isArray(jsonLd) ? jsonLd : jsonLd ? [jsonLd] : [];
  return blocks.filter(Boolean).map((block) =>
    `<script type="application/ld+json">${JSON.stringify(block).replace(/</g, "\\u003c")}</script>`
  ).join("");
}

function head({ title, description, canonical, jsonLd, image }) {
  const ld = jsonLdMarkup(jsonLd);
  const ogImage = image || OG_IMAGE;
  const imageMeta = image
    ? `<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">`
    : "";
  return `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SunsetPing">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(ogImage)}">
${imageMeta}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">${ld}`;
}

const SIGNUP_HEADLINE = "Know when the light will be good before you drive out.";

function topbar() {
  return `<header class="topbar"><a class="logo" href="/">SunsetPing</a>
<nav><a href="/sunset">Cities</a><a href="/#check">Tonight</a><a href="/photo-of-the-month">Photo</a><a href="/#signup">Free alerts</a></nav></header>`;
}

function locationField(location, id) {
  if (location) return `<input type="hidden" name="location" value="${esc(location)}">`;
  return `<label class="sr-only" for="${id}-location">City or ZIP, optional</label><input id="${id}-location" type="text" name="location" placeholder="City or ZIP (optional)" maxlength="100" aria-label="City or ZIP, optional" autocomplete="address-level2">`;
}

function signupFields({ id, location = "", button = "Get free alerts" }) {
  return `<label class="sr-only" for="${id}-email">Email</label>
<input id="${id}-email" type="email" name="email" placeholder="you@email.com" required autocomplete="email" aria-label="Email">
${locationField(location, id)}
<input type="hidden" name="tz">
${greatNightsField()}
<button class="btn" type="submit">${esc(button)}</button>`;
}

function inlineSignup(location = "", showMosh = false) {
  const place = location ? String(location).split(",")[0] : "";
  return `<section class="panel signup-block" id="signup" data-welcome-host>
<h2>${esc(SIGNUP_HEADLINE)}</h2>
<p class="lede">${esc(OUTLOOK_CTA)}</p>
${perkListHtml(showMosh)}
<form class="stack" action="/api/subscribe" method="post" data-signup>
${signupFields({ id: "city-signup", location, button: place ? `Alert me in ${place}` : "Get free alerts" })}
</form>
</section>`;
}

function stickySignup(location = "", showMosh = false) {
  return `<aside class="signup-sticky" data-welcome-host>
<p class="signup-sticky-copy">${esc(SIGNUP_HEADLINE)}</p>
${perkListHtml(showMosh)}
<form class="signup-sticky-form" action="/api/subscribe" method="post" data-signup>
${signupFields({ id: "sticky", location })}
</form>
</aside>`;
}

function footer(location = "", showMosh = false) {
  return `<footer class="site-footer"><form class="footer-signup" action="/api/subscribe" method="post" data-signup>
<p>Free sunset alerts</p>
${perkListHtml(showMosh)}
${signupFields({ id: "footer", location, button: "Email me" })}
</form>
<p class="footer-links">© 2026 SunsetPing · <a href="/sunset">Sunset cities</a> · <a href="/faq">FAQ</a> · <a href="/photo-of-the-month">Photo of the month</a> · <a href="/#signup">Get free alerts</a></p></footer>`;
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

function describeWithWeek(description, week) {
  const alert = " Free sunset and golden-hour quality alerts for landscape photographers.";
  if (!week?.days?.length) return `${description}${alert}`;
  return `${description} Sunset times for the next 7 days are listed on this page.${alert}`;
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
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.querySelectorAll('input[name="tz"]').forEach(function (zone) { zone.value = tz; });
  } catch (err) {}
  var share = document.querySelector("[data-share-url]");
  var shareButton = document.getElementById("share-score");
  if (share && shareButton) {
    var fallbacks = share.querySelector(".share-fallbacks");
    shareButton.addEventListener("click", function () {
      var payload = {
        title: share.getAttribute("data-share-title") || document.title,
        text: share.getAttribute("data-share-text") || "",
        url: share.getAttribute("data-share-url") || location.href,
      };
      function showFallbacks() { if (fallbacks) fallbacks.hidden = false; }
      if (navigator.share) {
        navigator.share(payload).catch(function (err) {
          if (err && err.name === "AbortError") return;
          showFallbacks();
        });
      } else {
        showFallbacks();
      }
    });
    var copy = share.querySelector("[data-copy-link]");
    if (copy) {
      copy.addEventListener("click", function () {
        var url = share.getAttribute("data-share-url") || location.href;
        var done = function () { copy.textContent = "Link copied"; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(function () { window.prompt("Copy this link", url); });
        } else {
          window.prompt("Copy this link", url);
        }
      });
    }
  }
})();
</script>`;

export function sunsetIndex(env) {
  const base = origin(env);
  const canonical = `${base}/sunset`;
  const title = `Sunset forecasts for ${CITIES.length} cities`;
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
${inlineSignup("", Boolean(moshPdfUrl(env)))}
</main>${footer("", Boolean(moshPdfUrl(env)))}${stickySignup("", Boolean(moshPdfUrl(env)))}<script src="/app.js" defer></script></body></html>`;
  return htmlResponse(html);
}

function joinSpots(spots) {
  if (spots.length <= 1) return spots[0] || "";
  if (spots.length === 2) return `${spots[0]} and ${spots[1]}`;
  return `${spots.slice(0, -1).join(", ")}, and ${spots[spots.length - 1]}`;
}

const SCORE_WORKS = "The score uses cloud layers, humidity, and visibility. 8 or above means don't miss it.";

/** Visible Q&A for a city page. Time and score answers are omitted when the forecast failed. */
export function cityQuickAnswers(city, score) {
  const name = city.city;
  const qa = [];
  if (score?.sunset && score?.date) {
    const tz = score.tz ? ` ${score.tz}` : "";
    qa.push({
      q: `What time is sunset in ${name} today?`,
      a: `Sunset in ${name} today (${score.date}) is at ${score.sunset}${tz}.`,
    });
    const viewing = score.viewing || {};
    if (viewing.goldenHourStart && viewing.goldenHourEnd) {
      let golden = `Golden hour in ${name} tonight runs ${compactClockRange(viewing.goldenHourStart, viewing.goldenHourEnd)}`;
      golden += viewing.blueHourEnd ? ` and blue hour ends ${viewing.blueHourEnd}.` : ".";
      qa.push({ q: `When is golden hour in ${name} tonight?`, a: golden });
    }
    if (score.score != null && score.score !== "" && score.verdict) {
      qa.push({
        q: `Will the sunset be good in ${name} tonight?`,
        a: `Tonight's SunsetPing score is ${score.score}/10: ${score.verdict}. ${SCORE_WORKS}`,
      });
    }
  }
  if (Array.isArray(city.spots) && city.spots.length) {
    qa.push({
      q: `Where is the best place to watch the sunset in ${name}?`,
      a: `People watch the sunset in ${name} from ${joinSpots(city.spots)}.`,
    });
  }
  return qa;
}

function faqPageJsonLd(qa) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: qa.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}

function breadcrumbJsonLd(base, city) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${base}/` },
      { "@type": "ListItem", position: 2, name: "Sunset cities", item: `${base}/sunset` },
      { "@type": "ListItem", position: 3, name: city.city, item: `${base}/sunset/${city.slug}` },
    ],
  };
}

function quickAnswersHtml(city, qa) {
  if (!qa.length) return "";
  const body = qa.map((item) => `<h3>${esc(item.q)}</h3><p>${esc(item.a)}</p>`).join("");
  return `<section class="city-qa" aria-label="${esc(`Sunset in ${city.city} — quick answers`)}"><h2>Sunset in ${esc(city.city)} — quick answers</h2>${body}</section>`;
}

function weekJsonLd(city, week) {
  if (!week?.days?.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Sunset times this week in ${city.city}`,
    numberOfItems: week.days.length,
    itemListOrder: "https://schema.org/ItemListOrderAscending",
    itemListElement: week.days.map((day, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: day.label,
      description: `Sunset ${day.sunset} ${day.tz}. Golden hour starts ${day.goldenHourStart} ${day.tz}.`,
    })),
  };
}

function weekTimesHtml(city, week) {
  if (!week?.days?.length) return "";
  const where = week.sameTz ? `${week.sameTz}, ${week.timeZone}` : week.timeZone;
  const rows = week.days.map((day) =>
    `<tr><td><time datetime="${esc(day.date)}">${esc(day.shortLabel)}</time></td><td>${esc(day.sunset)} ${esc(day.tz)}</td><td>${esc(day.goldenHourStart)} ${esc(day.tz)}</td></tr>`
  ).join("");
  return `<section class="week-times" id="sunset-week" aria-labelledby="sunset-week-title">
<h2 id="sunset-week-title">Sunset times this week in ${esc(city.city)}</h2>
<p class="week-note">Local time (${esc(where)}). Golden hour starts 60 minutes before sunset.</p>
<div class="week-table"><table>
<thead><tr><th scope="col">Date</th><th scope="col">Sunset</th><th scope="col">Golden hour starts</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="week-cta">${esc(OUTLOOK_CTA)}. <a href="#signup">Get free sunset and golden-hour alerts</a>.</p>
</section>`;
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

function cityHtml(env, city, score, variant = "") {
  const base = origin(env);
  const isTime = variant === "time";
  const canonical = isTime ? `${base}/sunset-time/${city.slug}` : `${base}/sunset/${city.slug}`;
  const question = isTime ? `What time is sunset today in ${city.city}?` : `Will tonight's sunset be good in ${city.city}?`;
  const description = isTime
    ? (score ? `Sunset time today in ${city.city}: ${score.sunset}${score.tz ? " " + score.tz : ""}. Tonight's sunset quality score is ${score.score}/10. Best spots and a free daily alert.` : `Sunset time today in ${city.city}, ${city.region}, plus tonight's sunset quality score, best spots and a free daily alert.`)
    : score
    ? cityMetaDescription(city.city, score)
    : `Tonight's sunset score for ${city.city}, ${city.region}. Sunset time, where to stand (${city.spots[0]}), and a free alert.`;
  const nearby = nearbyCities(city).map((other) =>
    `<a href="/sunset/${esc(other.slug)}">${esc(other.city)}</a>`
  ).join("");
  const spots = city.spots.map((spot) => `<li>${esc(spot)}</li>`).join("");
  const shareText = score
    ? `Tonight's sunset in ${city.city}: ${score.score}/10`
    : `Tonight's sunset in ${city.city}`;
  const shareHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(canonical)}`;
  const qa = cityQuickAnswers(city, score);
  const week = score?.week?.days?.length ? score.week : null;
  const described = describeWithWeek(description, week);
  return `<!doctype html><html lang="en"><head>${head({
    title: isTime ? (score ? `Sunset Time Today in ${city.city}: ${score.sunset} (${score.score}/10) · SunsetPing` : `Sunset Time Today in ${city.city} · SunsetPing`) : score ? cityPageTitle(city.city, score) : `${question} · SunsetPing`,
    description: described,
    canonical,
    image: `${base}/og/${city.slug}.png?v=${OG_CARD_VERSION}`,
    jsonLd: [
      cityJsonLd({ base, canonical, city, score, description }),
      qa.length ? faqPageJsonLd(qa) : null,
      breadcrumbJsonLd(base, city),
      weekJsonLd(city, week),
    ],
  })}</head>
<body><main class="wrap doc">
${topbar()}
<p class="kicker">${esc(city.region)}</p>
<h1>${esc(question)}</h1>
<p class="lede">${esc(city.tip)}</p>
${liveScoreHtml(city, score)}
${weekTimesHtml(city, week)}
${quickAnswersHtml(city, qa)}
<div class="tips">
<section>
<h2>Where people stand</h2>
<ul>${spots}</ul>
<p><a href="/s/${esc(encodeURIComponent(city.query))}">Share tonight's forecast for ${esc(city.city)}</a></p>
<div class="share-score" data-share-url="${esc(canonical)}" data-share-title="${esc(question)}" data-share-text="${esc(shareText)}">
<button type="button" class="btn" id="share-score">Share tonight's score</button>
<p class="share-fallbacks" hidden>
<button type="button" data-copy-link>Copy link</button>
<a href="${esc(shareHref)}" target="_blank" rel="noopener">Post on X</a>
</p>
</div>
</section>
${inlineSignup(city.query, Boolean(moshPdfUrl(env)))}
</div>
<nav class="nearby" aria-label="Nearby cities"><span>Nearby</span> ${nearby} <a href="/sunset">All cities</a></nav>
<p>${isTime ? `<a href="/sunset/${esc(city.slug)}">Will tonight's sunset be good in ${esc(city.city)}?</a>` : `<a href="/sunset-time/${esc(city.slug)}">Sunset time today in ${esc(city.city)}</a>`}</p>
</main>${footer(city.query, Boolean(moshPdfUrl(env)))}${stickySignup(city.query, Boolean(moshPdfUrl(env)))}<script src="/app.js" defer></script>${SCORE_SCRIPT}</body></html>`;
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

function cityCacheRequest(requestUrl, slug, variant = "") {
  const key = new URL(requestUrl instanceof URL ? requestUrl.href : String(requestUrl));
  key.pathname = variant === "time" ? `/sunset-time/${slug}` : `/sunset/${slug}`;
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
  const withDate = /^\d{4}-\d{2}-\d{2}$/.test(dateModified) ? { ...presented, dateModified } : presented;
  const week = weekSunsetTimes({
    lat: scored.lat,
    lon: scored.lon,
    timeZone: scored.timezone,
    startDate: dateModified,
    forecastSunsetIso: scored.sunsetIso,
  });
  return week ? { ...withDate, week } : withDate;
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
    const cacheKey = options.requestUrl ? cityCacheRequest(options.requestUrl, city.slug, options.variant) : null;
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
    const response = cityResponse(cityHtml(env, city, score, options.variant), score);
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
    return cityResponse(cityHtml(env, city, null, options.variant), null);
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
  const urls = ["/", "/faq", "/photo-of-the-month", "/sunset", ...CITIES.map((city) => `/sunset/${city.slug}`), ...CITIES.map((city) => `/sunset-time/${city.slug}`)];
  const body = urls.map((path) => {
    const loc = `${base}${path}`;
    if (path === "/sunset" || path.startsWith("/sunset/") || path.startsWith("/sunset-time/")) return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
    return `  <url><loc>${loc}</loc></url>`;
  }).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

export async function cityOg(env, slug) {
  const city = cityBySlug(String(slug || "").toLowerCase());
  if (!city) return simplePage("No score card", "That sunset city isn't in the guide. Try the city index.", 404);
  // Serve the prebuilt card. satori + yoga + resvg on this request exceeds the
  // Workers Free 10ms CPU limit (outcome exceededCpu, error 1102) on a cold isolate.
  const assetUrl = new URL(`/og/${city.slug}.png`, SITE);
  try {
    const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
    if (asset?.ok) {
      const headers = new Headers();
      headers.set("content-type", "image/png");
      headers.set("cache-control", OG_CARD_CACHE);
      const etag = asset.headers.get("etag");
      if (etag) headers.set("etag", etag);
      return new Response(asset.body, { status: 200, headers });
    }
    console.log(JSON.stringify({ event: "og_asset_missing", slug: city.slug, status: asset?.status || 0 }));
  } catch (err) {
    console.log(JSON.stringify({ event: "og_asset_failed", slug: city.slug, message: String(err?.message || err) }));
  }
  return simplePage("No score card", "That sunset score card isn't available.", 404);
}

export async function growthRoute(url, env, ctx, options = {}) {
  const path = url.pathname.replace(/\/$/, "") || "/";
  const ogMatch = path.match(/^\/og\/([^/]+)\.png$/i);
  if (ogMatch) return cityOg(env, decodeURIComponent(ogMatch[1]), ctx);
  if (path === `/${INDEXNOW_KEY}.txt`) return indexNowKeyResponse();
  if (path === "/sitemap.xml") return sitemapXml(env);
  if (path === "/sunset") return sunsetIndex(env);
  if (path.startsWith("/sunset/")) {
    const slug = decodeURIComponent(path.slice("/sunset/".length));
    if (!slug || slug.includes("/")) return simplePage("No city page", "That sunset city isn't in the guide. Try the city index.", 404);
    return sunsetCity(env, slug, { ctx, requestUrl: url, skipScore: options.skipScore === true });
  }
  if (path.startsWith("/sunset-time/")) {
    const slug = decodeURIComponent(path.slice("/sunset-time/".length));
    if (!slug || slug.includes("/")) return simplePage("No city page", "That sunset city isn't in the guide. Try the city index.", 404);
    return sunsetCity(env, slug, { ctx, requestUrl: url, skipScore: options.skipScore === true, variant: "time" });
  }
  return null;
}
