import { isBotUa, recordServerEvent, referrerFromRequest } from "./analytics.js";
import { CITIES, cityBySlug, nearbyCities } from "./cities.js";
import { INDEXNOW_KEY } from "./indexnow.js";
import { fetchForecast, resolvePlace } from "./openmeteo.js";
import { simplePage } from "./pages.js";
import { socialText } from "./social.js";
import { formatClock, scoreForecastDay, tzAbbrev, wallParts, withZoneAbbrev } from "./scoring.js";
import { sunsetUtc, weekSunsetTimes } from "./sun.js";
import { OUTLOOK_CTA, greatNightsField, moshPdfUrl, perkListHtml } from "./signup.js";
import { citiesWithCoords, rankTonight } from "./tonight.js";

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
export const OG_CARD_VERSION = "3";
/**
 * Bump when rendered city HTML changes so a deploy misses the edge cache.
 * Separate from OG_CARD_VERSION so score-card image URLs stay on the same picture.
 */
export const CITY_HTML_CACHE_VERSION = "5";
/** Edge cache for /tonight. 25 minutes, same window as a city page. */
export const TONIGHT_CACHE_SECONDS = 1500;
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
<meta property="og:title" content="${esc(socialText(title))}">
<meta property="og:description" content="${esc(socialText(description))}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(ogImage)}">
${imageMeta}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(socialText(title))}">
<meta name="twitter:description" content="${esc(socialText(description))}">
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

function signupFields({ id, location = "", button = "Get free alerts", form = "", path = "" }) {
  return `<label class="sr-only" for="${id}-email">Email</label>
<input id="${id}-email" type="email" name="email" placeholder="you@email.com" required autocomplete="email" aria-label="Email">
${locationField(location, id)}
<input type="hidden" name="tz">
<input type="hidden" name="signup_path" value="${esc(path)}">
<input type="hidden" name="signup_form" value="${esc(form)}">
${greatNightsField()}
<button class="btn" type="submit">${esc(button)}</button>`;
}

/** Real tonight numbers when the page already has them. Otherwise a labeled example with no clock times. */
function sampleAlertText(cityName, score) {
  const sunset = score?.sunset;
  const value = score?.score;
  if (sunset && value != null && value !== "") {
    const why = String(score.reason || "the sky is worth a look").replace(/\.$/, "");
    const golden = score.viewing?.goldenHourStart || score.goldenHourStart;
    const goldenText = golden ? `, golden hour starts ${golden}` : "";
    return `Sample alert: "${cityName} tonight: ${value}/10, ${why}. Sunset ${sunset}${goldenText}."`;
  }
  return `Sample alert (example): "${cityName} tonight: 8/10, high clouds to catch the color. The email includes the local sunset and golden hour."`;
}

/** One email field + button. The city comes from the page (hidden) or, when absent, from the visitor's location server-side. */
function quickFields({ id, location = "", button = "Email me good sunsets", form = "", path = "" }) {
  const loc = location ? `<input type="hidden" name="location" value="${esc(location)}">` : "";
  return `<label class="sr-only" for="${id}-email">Email</label>
<input id="${id}-email" type="email" name="email" placeholder="Your email" required autocomplete="email" inputmode="email" aria-label="Email">
${loc}<input type="hidden" name="tz">
<input type="hidden" name="signup_path" value="${esc(path)}">
<input type="hidden" name="signup_form" value="${esc(form)}">
<button class="btn" type="submit">${esc(button)}</button>`;
}

function heroSignup({ id = "hero", location = "", button, sample, form = "hero", path = "", showMosh = false }) {
  return `<section class="hero-signup-city hero-quick" id="signup" data-welcome-host>
<form class="signup hero-signup-form hero-quick-form" action="/api/subscribe" method="post" data-signup data-form="${esc(form)}">
${quickFields({ id, location, button, form, path })}
</form>
<p class="hero-quick-perks">100% free · 8+ night alerts · 7-day outlook · ${showMosh ? "cheat sheet + MOSH Planner PDF" : "free shooting cheat sheet"} · unsubscribe anytime</p>
<p class="sample-alert">${esc(sample)}</p>
</section>`;
}

const TONIGHT_LINK = `<p class="tonight-cross"><a href="/tonight">See tonight's best sunsets across the US</a></p>`;

/** Quiet one-field signup for pages without a hero form. No perk list, no banner. */
function inlineSignup(location = "", showMosh = false, path = "", form = "inline") {
  const place = location ? String(location).split(",")[0] : "";
  return `<section class="signup-quiet" id="signup" data-welcome-host>
<p class="signup-quiet-copy">Free sunset alerts${place ? ` for ${esc(place)}` : ""}, only on good nights${showMosh ? ", plus the MOSH Planner PDF" : ""}.</p>
<form class="signup hero-quick-form" action="/api/subscribe" method="post" data-signup data-form="${esc(form)}">
${quickFields({ id: "city-signup", location, button: "Email me good sunsets", form, path })}
</form>
</section>`;
}

/** Removed: one signup prompt per screen. Kept as a no-op so callers stay simple. */
function stickySignup() {
  return "";
}

function footer(location = "", showMosh = false, options = {}) {
  const extra = options.extra || "";
  return `<footer class="site-footer">
<p class="footer-links">© 2026 SunsetPing · <a href="/tonight">Best sunsets tonight</a> · <a href="/sunset">Sunset cities</a> · <a href="/faq">FAQ</a> · <a href="/photo-of-the-month">Photo of the month</a> · <a href="/#signup">Get free alerts</a>${extra ? ` · ${extra}` : ""}</p></footer>`;
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

function describeWithWeek(description, week, weekSentence = "Sunset times for the next 7 days are listed on this page.") {
  const alert = " Free sunset and golden-hour quality alerts for landscape photographers.";
  if (!week?.days?.length) return `${description}${alert}`;
  return `${description} ${weekSentence}${alert}`;
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
<p class="lede">Each page has tonight's score, the sunset time, a few places people stand, and a free alert prefilled with that city. <a href="/tonight">See tonight's best sunsets across the US</a>.</p>
<nav class="city-list" aria-label="Sunset cities">${cards}</nav>
${inlineSignup("", Boolean(moshPdfUrl(env)), "/sunset")}
</main>${footer("", Boolean(moshPdfUrl(env)), { path: "/sunset" })}${stickySignup("", Boolean(moshPdfUrl(env)), "/sunset")}<script src="/app.js" defer></script></body></html>`;
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

function quickAnswersHtml(city, qa, heading) {
  if (!qa.length) return "";
  const title = heading || `Sunset in ${city.city} — quick answers`;
  const body = qa.map((item) => `<h3>${esc(item.q)}</h3><p>${esc(item.a)}</p>`).join("");
  return `<section class="city-qa" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${body}</section>`;
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

/** "5:42 PM" + "6:42 PM" → "5:42–6:42 PM". Same meridian rule as compactClockRange. */
function enDashRange(start, end) {
  return compactClockRange(start, end).replace("-", "\u2013");
}

function goldenHourPhrase(city, score) {
  const viewing = score?.viewing || {};
  if (!viewing.goldenHourStart || !viewing.goldenHourEnd) return `Golden Hour Today in ${city.city}`;
  const tz = score.tz ? ` ${score.tz}` : "";
  return `Golden Hour Today in ${city.city}: ${enDashRange(viewing.goldenHourStart, viewing.goldenHourEnd)}${tz}`;
}

/** Visible Q&A for a golden-hour page. Time and score answers are omitted when the forecast failed. */
function goldenQuickAnswers(city, score) {
  const name = city.city;
  const qa = [];
  const viewing = score?.viewing || {};
  const tz = score?.tz ? ` ${score.tz}` : "";
  const when = score?.date ? ` today (${score.date})` : " today";
  if (viewing.goldenHourStart && viewing.goldenHourEnd) {
    qa.push({
      q: `When is golden hour today in ${name}?`,
      a: `Evening golden hour in ${name}${when} is ${enDashRange(viewing.goldenHourStart, viewing.goldenHourEnd)}${tz}.`,
    });
    if (viewing.blueHourEnd) {
      qa.push({
        q: `When is blue hour today in ${name}?`,
        a: `Blue hour in ${name}${when} is ${enDashRange(viewing.goldenHourEnd, viewing.blueHourEnd)}${tz}.`,
      });
    }
  }
  if (score?.score != null && score.score !== "" && score?.verdict) {
    const reason = score.reason ? ` ${score.reason}` : "";
    qa.push({
      q: `Is tonight a good sunset for photos in ${name}?`,
      a: `Tonight's sunset score in ${name} is ${score.score}/10: ${score.verdict}.${reason}`,
    });
  }
  if (Array.isArray(city.spots) && city.spots.length) {
    const tip = city.tip ? ` ${city.tip}` : "";
    qa.push({
      q: `Where to shoot golden hour in ${name}?`,
      a: `Top photo spots in ${name}: ${joinSpots(city.spots)}.${tip}`,
    });
  }
  return qa;
}

function goldenDescription(city, score) {
  const viewing = score?.viewing || {};
  if (viewing.goldenHourStart && viewing.goldenHourEnd && score?.score != null && score.score !== "") {
    const tz = score.tz ? ` ${score.tz}` : "";
    const verdict = score.verdict ? `: ${score.verdict}` : "";
    return `Golden hour today in ${city.city} is ${enDashRange(viewing.goldenHourStart, viewing.goldenHourEnd)}${tz}. Tonight's sunset score is ${score.score}/10${verdict}.`;
  }
  return `Golden hour today in ${city.city}, ${city.region}. Evening golden hour and blue hour, tonight's sunset score, and where to shoot.`;
}

function goldenCrumbJsonLd(base, city) {
  const itemListElement = [
    { "@type": "ListItem", position: 1, name: "Home", item: `${base}/` },
    { "@type": "ListItem", position: 2, name: "Golden hour", item: `${base}/golden-hour` },
  ];
  if (city) {
    itemListElement.push({ "@type": "ListItem", position: 3, name: city.city, item: `${base}/golden-hour/${city.slug}` });
  }
  return { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement };
}

function relatedCityLinks(city, variant) {
  const sunset = `<a href="/sunset/${esc(city.slug)}">Will tonight's sunset be good in ${esc(city.city)}?</a>`;
  const time = `<a href="/sunset-time/${esc(city.slug)}">Sunset time today in ${esc(city.city)}</a>`;
  const golden = `<a href="/golden-hour/${esc(city.slug)}">Golden hour today in ${esc(city.city)}</a>`;
  if (variant === "golden") return `${sunset} ${time}`;
  if (variant === "time") return `${sunset} ${golden}`;
  return `${time} ${golden}`;
}

function goldenFactsHtml(city, score, qa) {
  if (!score) {
    return `<section class="city-live" aria-live="polite">
<p class="status">Checking tonight's sky in ${esc(city.city)}…</p>
</section>`;
  }
  const golden = qa.find((item) => item.q.startsWith("When is golden hour"));
  const blue = qa.find((item) => item.q.startsWith("When is blue hour"));
  return `<section class="city-live" aria-live="polite">
${golden ? `<p class="city-fact">${esc(golden.a)}</p>` : ""}
${blue ? `<p>${esc(blue.a)}</p>` : ""}
<p class="city-score"><strong>${esc(score.score)}/10</strong> ${esc(score.verdict || "")}</p>
<p>${esc(score.reason || "")}</p>
</section>`;
}

function goldenWeekHtml(city, week) {
  if (!week?.days?.length) return "";
  const where = week.sameTz ? `${week.sameTz}, ${week.timeZone}` : week.timeZone;
  const rows = week.days.map((day) => {
    const range = enDashRange(day.goldenHourStart, day.sunset);
    return `<tr><td><time datetime="${esc(day.date)}">${esc(day.shortLabel)}</time></td><td>${esc(range)} ${esc(day.tz)}</td><td>${esc(day.sunset)} ${esc(day.tz)}</td></tr>`;
  }).join("");
  return `<section class="week-times" id="golden-week" aria-labelledby="golden-week-title">
<h2 id="golden-week-title">Golden hour this week in ${esc(city.city)}</h2>
<p class="week-note">Local time (${esc(where)}). Golden hour ends at sunset.</p>
<div class="week-table"><table>
<thead><tr><th scope="col">Date</th><th scope="col">Golden hour</th><th scope="col">Sunset</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
<p class="week-cta">${esc(OUTLOOK_CTA)}. <a href="#signup">Get free sunset and golden-hour alerts</a>.</p>
</section>`;
}

function goldenHtml(env, city, score) {
  const base = origin(env);
  const canonical = `${base}/golden-hour/${city.slug}`;
  const phrase = goldenHourPhrase(city, score);
  const description = goldenDescription(city, score);
  const nearby = nearbyCities(city).map((other) =>
    `<a href="/golden-hour/${esc(other.slug)}">${esc(other.city)}</a>`
  ).join("");
  const spots = city.spots.map((spot) => `<li>${esc(spot)}</li>`).join("");
  const qa = goldenQuickAnswers(city, score);
  const week = score?.week?.days?.length ? score.week : null;
  const described = describeWithWeek(description, week, "Golden hour for the next 7 days is listed on this page.");
  const pageLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: phrase,
    url: canonical,
    description: described,
    isPartOf: { "@type": "WebSite", name: "SunsetPing", url: `${base}/` },
    about: { "@type": "Place", name: `${city.city}, ${city.region}` },
  };
  if (score?.dateModified && /^\d{4}-\d{2}-\d{2}$/.test(score.dateModified)) pageLd.dateModified = score.dateModified;
  return `<!doctype html><html lang="en"><head>${head({
    title: `${phrase} · SunsetPing`,
    description: described,
    canonical,
    image: `${base}/og/${city.slug}.png?v=${OG_CARD_VERSION}`,
    jsonLd: [
      pageLd,
      qa.length ? faqPageJsonLd(qa) : null,
      goldenCrumbJsonLd(base, city),
    ],
  })}</head>
<body><main class="wrap doc">
${topbar()}
<p class="kicker">${esc(city.region)}</p>
<h1>${esc(phrase)}</h1>
<p class="lede">${esc(city.tip)}</p>
${goldenFactsHtml(city, score, qa)}
${heroSignup({
  showMosh: Boolean(moshPdfUrl(env)),
  location: city.query,
  button: `Email me when ${city.city}'s sunset is worth it`,
  sample: sampleAlertText(city.city, score),
  path: `/golden-hour/${city.slug}`,
})}
${TONIGHT_LINK}
${goldenWeekHtml(city, week)}
${quickAnswersHtml(city, qa, `Golden hour in ${city.city} — quick answers`)}
<div class="tips">
<section>
<h2>Where to shoot golden hour in ${esc(city.city)}</h2>
<ul>${spots}</ul>
</section>
</div>
<nav class="nearby" aria-label="Nearby cities"><span>Nearby</span> ${nearby} <a href="/golden-hour">All cities</a></nav>
<p>${relatedCityLinks(city, "golden")}</p>
</main>${footer(city.query, Boolean(moshPdfUrl(env)), { path: `/golden-hour/${city.slug}` })}${stickySignup(city.query, Boolean(moshPdfUrl(env)), `/golden-hour/${city.slug}`)}<script src="/app.js" defer></script></body></html>`;
}

export function goldenHourIndex(env) {
  const base = origin(env);
  const canonical = `${base}/golden-hour`;
  const title = `Golden hour times for ${CITIES.length} cities`;
  const description = "Evening golden hour and blue hour for Sedona, Malibu, Key West, Maui, Big Sur, and other cities landscape photographers shoot.";
  const cards = [...CITIES].sort((a, b) => a.city.localeCompare(b.city)).map((city) =>
    `<a href="/golden-hour/${esc(city.slug)}"><strong>${esc(city.city)}</strong><span>${esc(city.region)}</span></a>`
  ).join("");
  const html = `<!doctype html><html lang="en"><head>${head({
    title: `${title} · SunsetPing`,
    description,
    canonical,
    jsonLd: goldenCrumbJsonLd(base, null),
  })}</head>
<body><main class="wrap doc">
${topbar()}
<p class="kicker">Golden hour</p>
<h1>Golden hour today, for ${CITIES.length} cities</h1>
<p class="lede">Each page has tonight's golden hour and blue hour, the sunset score, a week of golden-hour times, and places to stand. <a href="/tonight">See tonight's best sunsets across the US</a>.</p>
<nav class="city-list" aria-label="Golden hour cities">${cards}</nav>
${inlineSignup("", Boolean(moshPdfUrl(env)), "/golden-hour")}
</main>${footer("", Boolean(moshPdfUrl(env)), { path: "/golden-hour" })}${stickySignup("", Boolean(moshPdfUrl(env)), "/golden-hour")}<script src="/app.js" defer></script></body></html>`;
  return htmlResponse(html);
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
  const pagePath = isTime ? `/sunset-time/${city.slug}` : `/sunset/${city.slug}`;
  const embedLink = isTime ? "" : `<p><a href="/widget?city=${esc(city.slug)}">Add this forecast to your site</a></p>`;
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
${heroSignup({
  showMosh: Boolean(moshPdfUrl(env)),
  location: city.query,
  button: `Email me when ${city.city}'s sunset is worth it`,
  sample: sampleAlertText(city.city, score),
  path: pagePath,
})}
${TONIGHT_LINK}
${weekTimesHtml(city, week)}
${quickAnswersHtml(city, qa)}
<div class="tips">
<section>
<h2>Where people stand</h2>
<ul>${spots}</ul>
<p><a href="/s/${esc(encodeURIComponent(city.query))}">Share tonight's forecast for ${esc(city.city)}</a></p>
${embedLink}
<div class="share-score" data-share-url="${esc(canonical)}" data-share-title="${esc(question)}" data-share-text="${esc(shareText)}">
<button type="button" class="btn" id="share-score">Share tonight's score</button>
<p class="share-fallbacks" hidden>
<button type="button" data-copy-link>Copy link</button>
<a href="${esc(shareHref)}" target="_blank" rel="noopener">Post on X</a>
</p>
</div>
</section>
</div>
<nav class="nearby" aria-label="Nearby cities"><span>Nearby</span> ${nearby} <a href="/sunset">All cities</a></nav>
<p>${relatedCityLinks(city, isTime ? "time" : "")}</p>
</main>${footer(city.query, Boolean(moshPdfUrl(env)), { path: pagePath })}${stickySignup(city.query, Boolean(moshPdfUrl(env)), pagePath)}<script src="/app.js" defer></script>${SCORE_SCRIPT}</body></html>`;
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
  if (variant === "time") key.pathname = `/sunset-time/${slug}`;
  else if (variant === "golden") key.pathname = `/golden-hour/${slug}`;
  else key.pathname = `/sunset/${slug}`;
  key.search = `?og=${OG_CARD_VERSION}&html=${CITY_HTML_CACHE_VERSION}`; // new markup or card version => fresh cache entry on deploy
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
    const html = options.variant === "golden" ? goldenHtml(env, city, score) : cityHtml(env, city, score, options.variant);
    const response = cityResponse(html, score);
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
    const html = options.variant === "golden" ? goldenHtml(env, city, null) : cityHtml(env, city, null, options.variant);
    return cityResponse(html, null);
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
  const urls = [
    "/",
    "/faq",
    "/photo-of-the-month",
    "/sunset",
    "/golden-hour",
    "/tonight",
    "/widget",
    ...CITIES.map((city) => `/sunset/${city.slug}`),
    ...CITIES.map((city) => `/sunset-time/${city.slug}`),
    ...CITIES.map((city) => `/golden-hour/${city.slug}`),
  ];
  const body = urls.map((path) => {
    const loc = `${base}${path}`;
    const dated = path === "/sunset" || path === "/golden-hour" || path === "/tonight" || path.startsWith("/sunset/") || path.startsWith("/sunset-time/") || path.startsWith("/golden-hour/");
    if (dated) return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`;
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

/** US Pacific calendar date, so "tonight" stays today through the evening. */
export function usTonightLabel(now = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);
}

function tonightCacheRequest(requestUrl, kind) {
  const key = new URL(requestUrl instanceof URL ? requestUrl.href : String(requestUrl));
  key.pathname = kind === "json" ? "/api/tonight" : "/tonight";
  key.search = `?html=${CITY_HTML_CACHE_VERSION}`;
  key.hash = "";
  return new Request(key.toString(), { method: "GET" });
}

function tonightListHtml(ranking) {
  if (!ranking.length) {
    const cards = [...CITIES].sort((a, b) => a.city.localeCompare(b.city)).map((city) =>
      `<a href="/sunset/${esc(city.slug)}"><strong>${esc(city.city)}</strong><span>${esc(city.region)}</span></a>`
    ).join("");
    return `<p class="lede">Tonight's scores didn't load. The city pages are still there, and the free alert works either way.</p>
<nav class="city-list" aria-label="Sunset cities">${cards}</nav>`;
  }
  const expected = citiesWithCoords().length;
  const note = ranking.length < expected
    ? `<p class="week-note">Showing ${ranking.length} of ${expected} cities. The others didn't return a forecast.</p>`
    : "";
  const items = ranking.map((row) => {
    const tz = row.tz ? ` ${esc(row.tz)}` : "";
    return `<li>
<a href="/sunset/${esc(row.slug)}">
<span class="tonight-rank">${esc(row.rank)}</span>
<span class="tonight-place"><strong>${esc(row.city)}</strong><span>${esc(row.region)}</span></span>
<span class="tonight-score">${esc(row.score)}/10</span>
<span class="tonight-verdict">${esc(row.verdict)}</span>
<span class="tonight-time">Sunset ${esc(row.sunset)}${tz}</span>
</a>
</li>`;
  }).join("");
  return `${note}<ol class="tonight-list">${items}</ol>`;
}

function tonightSample(ranking) {
  const top = ranking[0];
  if (!top) return sampleAlertText("Seattle", null);
  return sampleAlertText(top.city, top);
}

function tonightJsonLd(base, date, ranking) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `Best sunsets tonight in the US (${date})`,
    numberOfItems: ranking.length,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    itemListElement: ranking.map((row) => ({
      "@type": "ListItem",
      position: row.rank,
      name: `${row.city}, ${row.region}`,
      url: `${base}/sunset/${row.slug}`,
      description: `${row.score}/10, ${row.verdict}. Sunset ${row.sunset}${row.tz ? ` ${row.tz}` : ""}.`,
    })),
  };
}

function tonightHtml(env, ranking) {
  const base = origin(env);
  const canonical = `${base}/tonight`;
  const date = usTonightLabel();
  const title = `Best Sunsets Tonight in the US (${date}) | SunsetPing`;
  const description = `Tonight's best sunsets across ${CITIES.length} US cities landscape photographers shoot. Local sunset time, verdict, and a link to each city forecast. Free email alerts.`;
  const showMosh = Boolean(moshPdfUrl(env));
  const pageLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    url: canonical,
    description,
    isPartOf: { "@type": "WebSite", name: "SunsetPing", url: `${base}/` },
  };
  return `<!doctype html><html lang="en"><head>${head({
    title,
    description,
    canonical,
    jsonLd: [pageLd, tonightJsonLd(base, date, ranking)],
  })}</head>
<body><main class="wrap doc">
${topbar()}
<p class="kicker">United States</p>
<h1>Best sunsets tonight in the US</h1>
<p class="lede">${esc(date)}. ${CITIES.length} cities, ranked by tonight's sunset score. The same scorer as the city pages.</p>
${heroSignup({
  showMosh: Boolean(moshPdfUrl(env)),
  id: "hero",
  button: "Email me when a sunset is worth it",
  sample: tonightSample(ranking),
  path: "/tonight",
})}
${tonightListHtml(ranking)}
</main>${footer("", showMosh, { path: "/tonight", extra: `<a href="/widget">Add this forecast to your site</a>` })}${stickySignup("", showMosh, "/tonight")}<script src="/app.js" defer></script></body></html>`;
}

function tonightCacheControl(ranking) {
  return ranking.length
    ? `public, max-age=${TONIGHT_CACHE_SECONDS}, s-maxage=${TONIGHT_CACHE_SECONDS}`
    : FALLBACK_CACHE;
}

async function cachedTonight(kind, options, build) {
  const cache = edgeCache();
  const cacheKey = options.requestUrl ? tonightCacheRequest(options.requestUrl, kind) : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }
  const ranking = await rankTonight();
  const response = build(ranking);
  if (ranking.length && cache && cacheKey) {
    try {
      await remember(options.ctx, cache.put(cacheKey, response.clone()));
    } catch (err) {
      console.log(JSON.stringify({ event: "tonight_cache_put_failed", message: String(err?.message || err) }));
    }
  }
  return response;
}

export async function tonightPage(env, options = {}) {
  try {
    return await cachedTonight("html", options, (ranking) => htmlResponse(tonightHtml(env, ranking), 200, tonightCacheControl(ranking)));
  } catch (err) {
    console.log(JSON.stringify({ event: "tonight_page_failed", message: String(err?.message || err) }));
    return htmlResponse(tonightHtml(env, []), 200, FALLBACK_CACHE);
  }
}

export async function tonightApi(env, options = {}) {
  try {
    return await cachedTonight("json", options, (ranking) => {
      const body = { date: usTonightLabel(), ranking };
      if (!ranking.length) body.error = "Tonight's ranking is temporarily unavailable.";
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": tonightCacheControl(ranking),
        },
      });
    });
  } catch (err) {
    console.log(JSON.stringify({ event: "tonight_api_failed", message: String(err?.message || err) }));
    return new Response(JSON.stringify({
      date: usTonightLabel(),
      ranking: [],
      error: "Tonight's ranking is temporarily unavailable.",
    }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": FALLBACK_CACHE },
    });
  }
}

export function embedTheme(value) {
  return String(value || "").toLowerCase() === "dark" ? "dark" : "light";
}

/** Civil sunset for the catalog city when the forecast is down. */
export function solarSunset(city, now = new Date()) {
  try {
    const today = wallParts(now, city.timezone);
    const utc = sunsetUtc(today.year, today.month, today.day, city.lat, city.lon);
    if (!utc) return null;
    const local = wallParts(utc, city.timezone);
    const pad = (n) => String(n).padStart(2, "0");
    const iso = `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`;
    return { sunset: formatClock(iso), tz: tzAbbrev(city.timezone, utc) };
  } catch {
    return null;
  }
}

/** Tiny framed card. Inline CSS, no script, followed link back to the city page. */
export function embedDocument({ city, theme = "light", score = null }) {
  const dark = theme === "dark";
  const clock = score?.sunset || "";
  const zone = score?.tz || "";
  const hasScore = score && score.score != null && score.score !== "";
  const scoreHtml = hasScore
    ? `<p class="score">${esc(score.score)}<span>/10</span></p><p class="label">${esc(score.verdict || "")}</p>`
    : "";
  const timeHtml = clock
    ? `<p class="time">Sunset ${esc(clock)}${zone ? ` ${esc(zone)}` : ""}</p>`
    : `<p class="time">Sunset time will be back shortly.</p>`;
  const href = `${SITE}/sunset/${city.slug}?ref=embed`;
  return `<!doctype html><html lang="en"${dark ? ` class="dark"` : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Tonight's sunset in ${esc(city.city)} · SunsetPing</title><style>body{margin:0;font:14px/1.3 system-ui,sans-serif;background:#fffcf8;color:#1c1612}html.dark body{background:#211712;color:#fff8f2}.card{padding:10px 12px}.kicker{margin:0;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#6f655d}h1{margin:2px 0 4px;font-size:18px;line-height:1.1}.score{margin:0;font-size:26px;font-weight:700}.score span{font-size:14px;font-weight:500;color:#6f655d}.label,.time,.credit{margin:2px 0}a{color:#c4541a}html.dark .kicker,html.dark .score span,html.dark .label,html.dark .time{color:#d9cfc6}html.dark a{color:#f0c27a}</style></head><body><article class="card"><p class="kicker">Tonight</p><h1>${esc(city.city)}</h1>${scoreHtml}${timeHtml}<p class="credit"><a href="${href}" target="_blank" rel="noopener">Sunset forecast by SunsetPing</a></p></article></body></html>`;
}

/** Browser max-age matches the edge so an iframe does not keep a score for hours. */
const EMBED_CACHE_CONTROL = `public, max-age=${CITY_PAGE_CACHE_SECONDS}, s-maxage=${CITY_PAGE_CACHE_SECONDS}`;

function embedResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": EMBED_CACHE_CONTROL,
      "x-robots-tag": "noindex",
      "content-security-policy": "frame-ancestors *",
    },
  });
}

function stampEmbedCache(response) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", EMBED_CACHE_CONTROL);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("x-robots-tag", "noindex");
  headers.set("content-security-policy", "frame-ancestors *");
  return new Response(response.body, { status: response.status, headers });
}

function embedCacheRequest(requestUrl, slug, theme) {
  const key = new URL(requestUrl instanceof URL ? requestUrl.href : String(requestUrl));
  key.pathname = `/embed/${slug}`;
  key.search = `?theme=${theme}&html=${CITY_HTML_CACHE_VERSION}`;
  key.hash = "";
  return new Request(key.toString(), { method: "GET" });
}

async function scoreCatalogCity(city, env) {
  const ms = scoreTimeoutMs(env);
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
  const job = (async () => {
    const forecast = await fetchForecast(city.lat, city.lon, 1, fetchImpl);
    return withZoneAbbrev(scoreForecastDay(forecast, 0, {
      location: `${city.city}, ${city.region}`,
      lat: city.lat,
      lon: city.lon,
      timezone: city.timezone,
    }));
  })();
  job.catch(() => {});
  try {
    return await Promise.race([job, limit]);
  } finally {
    clearTimeout(timer);
    clearTimeout(timeout);
    controller.abort();
  }
}

function embedFallbackScore(city) {
  const solar = solarSunset(city);
  if (!solar) return null;
  return { sunset: solar.sunset, tz: solar.tz };
}

async function noteEmbedView(env, ctx, request, slug) {
  if (request?.method && request.method !== "GET") return;
  if (isBotUa(request?.headers?.get("user-agent"))) return;
  await recordServerEvent(env, ctx, {
    event: "embed_view",
    path: `/embed/${slug}`,
    form: "",
    referrer: request ? referrerFromRequest(request) : "",
  });
}

export async function embedPage(env, slug, options = {}) {
  const city = cityBySlug(slug);
  if (!city) return simplePage("No sunset widget", "That city isn't in the guide.", 404);
  const theme = embedTheme(options.theme);
  try {
    await noteEmbedView(env, options.ctx, options.request, city.slug);
  } catch (err) {
    console.log(JSON.stringify({ event: "embed_analytics_failed", slug: city.slug, message: String(err?.message || err) }));
  }
  try {
    const cache = edgeCache();
    const cacheKey = options.requestUrl ? embedCacheRequest(options.requestUrl, city.slug, theme) : null;
    if (cache && cacheKey) {
      const hit = await cache.match(cacheKey).catch(() => null);
      if (hit) return stampEmbedCache(hit);
    }
    let score = null;
    try {
      score = await scoreCatalogCity(city, env);
    } catch (err) {
      console.log(JSON.stringify({ event: "embed_score_fallback", slug: city.slug, message: String(err?.message || err) }));
      score = null;
    }
    const shown = score || embedFallbackScore(city);
    const html = embedDocument({ city, theme, score: shown });
    const response = embedResponse(html);
    if (score && cache && cacheKey) {
      try {
        await remember(options.ctx, cache.put(cacheKey, response.clone()));
      } catch (err) {
        console.log(JSON.stringify({ event: "embed_cache_put_failed", message: String(err?.message || err) }));
      }
    }
    return response;
  } catch (err) {
    console.log(JSON.stringify({ event: "embed_failed", slug: city.slug, message: String(err?.message || err) }));
    return embedResponse(embedDocument({ city, theme, score: embedFallbackScore(city) }));
  }
}

const EMBED_SNIPPET = (slug) => `<iframe src="${SITE}/embed/${slug}" width="320" height="140" style="border:0" loading="lazy" title="Tonight's sunset forecast"></iframe>`;

export function widgetPage(env, url) {
  const base = origin(env);
  const requested = String(url?.searchParams?.get("city") || "").toLowerCase();
  const selected = cityBySlug(requested) || cityBySlug("sedona") || CITIES[0];
  const canonical = `${base}/widget`;
  const title = "Free sunset forecast widget for your photography website";
  const description = "Embed tonight's sunset score on your photography site. A small card with the score, sunset time, and a link back to the SunsetPing forecast. Free.";
  const options = [...CITIES].sort((a, b) => a.city.localeCompare(b.city)).map((city) =>
    `<option value="${esc(city.slug)}"${city.slug === selected.slug ? " selected" : ""}>${esc(city.city)}, ${esc(city.region)}</option>`
  ).join("");
  const snippet = EMBED_SNIPPET(selected.slug);
  const showMosh = Boolean(moshPdfUrl(env));
  const html = `<!doctype html><html lang="en"><head>${head({ title: `${title} · SunsetPing`, description, canonical })}</head>
<body><main class="wrap doc">
${topbar()}
<p class="kicker">For photography sites</p>
<h1>${esc(title)}</h1>
<p class="lede">Paste a card onto your site. It shows the city, tonight's score out of 10, the sunset time, and a link to the full forecast. The card is free, has no cookies, and does not need JavaScript.</p>
<p>Pick a city. The preview and the snippet update together. Add <code>?theme=dark</code> or <code>?theme=light</code> on the embed URL if you want a specific look.</p>
<form id="widget-picker" class="stack" action="/widget" method="get">
<label for="widget-city">City</label>
<select id="widget-city" name="city">${options}</select>
<button class="btn" type="submit">Show this city</button>
</form>
<iframe id="widget-preview" src="${SITE}/embed/${esc(selected.slug)}" width="320" height="140" style="border:0" loading="lazy" title="Tonight's sunset forecast"></iframe>
<label for="widget-snippet">Embed code</label>
<textarea id="widget-snippet" class="widget-snippet" readonly rows="3">${esc(snippet)}</textarea>
${inlineSignup("", showMosh, "/widget", "widget")}
</main>${footer("", showMosh, { path: "/widget" })}${stickySignup("", showMosh, "/widget")}<script src="/app.js" defer></script></body></html>`;
  return htmlResponse(html);
}

export async function growthRoute(url, env, ctx, options = {}) {
  const path = url.pathname.replace(/\/$/, "") || "/";
  const ogMatch = path.match(/^\/og\/([^/]+)\.png$/i);
  if (ogMatch) return cityOg(env, decodeURIComponent(ogMatch[1]), ctx);
  if (path === `/${INDEXNOW_KEY}.txt`) return indexNowKeyResponse();
  if (path === "/sitemap.xml") return sitemapXml(env);
  if (path === "/widget") return widgetPage(env, url);
  if (path === "/embed") return simplePage("No sunset widget", "That city isn't in the guide.", 404);
  if (path.startsWith("/embed/")) {
    const slug = decodeURIComponent(path.slice("/embed/".length)).toLowerCase();
    if (!slug || slug.includes("/")) return simplePage("No sunset widget", "That city isn't in the guide.", 404);
    return embedPage(env, slug, {
      ctx,
      request: options.request,
      requestUrl: url,
      theme: url.searchParams.get("theme"),
    });
  }
  if (path === "/tonight") return tonightPage(env, { ctx, requestUrl: url });
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
  if (path === "/golden-hour") return goldenHourIndex(env);
  if (path.startsWith("/golden-hour/")) {
    const slug = decodeURIComponent(path.slice("/golden-hour/".length));
    if (!slug || slug.includes("/")) return simplePage("No city page", "That sunset city isn't in the guide. Try the city index.", 404);
    return sunsetCity(env, slug, { ctx, requestUrl: url, skipScore: options.skipScore === true, variant: "golden" });
  }
  return null;
}
