function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const SHELL_HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,560;9..144,700&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">`;

function nav(active) {
  return `<header class="nav"><a class="logo" href="/">SunsetPing</a>
<nav><a href="/#check">Tonight</a><a href="/#pricing">Pricing</a><a href="/pro"${active === "pro" ? ' aria-current="page"' : ""}>Pro</a></nav></header>`;
}

export function simplePage(title, message, status = 200) {
  const html = `<!doctype html><html lang="en"><head>${SHELL_HEAD}<title>${esc(title)}</title></head>
<body class="subpage"><div class="wrap narrow">
${nav()}
<main class="panel"><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a class="btn" href="/">Back to SunsetPing</a></p></main>
</div></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function factorRow(name, value, label, tone, width) {
  const w = Math.max(0, Math.min(100, width));
  return `<li><span class="k">${esc(name)}</span><span class="bar" aria-hidden="true"><i class="tone-${esc(tone)}" style="width:${w}%"></i></span><span class="v">${esc(value)}</span><span class="lab">${esc(label)}</span></li>`;
}

export function scoreCardHtml(score, { sharePath = "" } = {}) {
  const c = score.colorChance || {};
  const v = score.viewing || {};
  const visKm = c.visibility?.km ?? "";
  const visWidth = Math.round(Math.min(100, (Number(visKm) / 30) * 100));
  return `<article class="result">
<header class="result-top"><div><p class="eyebrow">Tonight · ${esc(score.date)}</p><h2>${esc(score.location)}</h2></div>
<p class="pill score-${Number(score.score) >= 8 ? "hot" : Number(score.score) >= 6 ? "good" : Number(score.score) >= 4 ? "mid" : "low"}">${esc(score.verdict)}</p></header>
<div class="result-main"><div class="dial" style="--p:${Number(score.score) * 10}"><div class="dial-hole"><strong>${esc(score.score)}</strong><span>/10</span></div></div>
<div><p class="sunset-line">Sun sets at <b>${esc(score.sunset)}</b> ${score.tz ? `<span class="tz">${esc(score.tz)}</span>` : ""}</p>
<p class="reason">${esc(score.reason)}</p></div></div>
<ol class="window">
<li><span>Golden hour start</span><b>${esc(v.goldenHourStart)}</b></li>
<li><span>Golden hour end</span><b>${esc(v.goldenHourEnd)}</b></li>
<li><span>Sunset</span><b>${esc(v.sunset)}</b></li>
<li><span>Blue hour end</span><b>${esc(v.blueHourEnd)}</b></li>
</ol>
<div class="chance"><h3>Color chance <em>${esc(c.summary || "")}</em></h3><ul>
${factorRow("Low cloud", `${c.low?.percent ?? "–"}%`, c.low?.label, c.low?.tone, c.low?.percent)}
${factorRow("Mid cloud", `${c.mid?.percent ?? "–"}%`, c.mid?.label, c.mid?.tone, c.mid?.percent)}
${factorRow("High cloud", `${c.high?.percent ?? "–"}%`, c.high?.label, c.high?.tone, c.high?.percent)}
${factorRow("Humidity", `${c.humidity?.percent ?? "–"}%`, c.humidity?.label, c.humidity?.tone, c.humidity?.percent)}
${factorRow("Visibility", `${visKm} km`, c.visibility?.label, c.visibility?.tone, visWidth)}
</ul></div>
${sharePath ? `<p class="share-row"><a class="share-url" href="${esc(sharePath)}">${esc(sharePath.replace(/^https?:\/\//, ""))}</a></p>` : ""}
</article>`;
}

export function sharePage({ score, canonical, image }) {
  const title = `Tonight's sunset in ${score.location}: ${score.score}/10 — ${score.verdict}`;
  const description = `${score.reason} Sunset at ${score.sunset}${score.tz ? " " + score.tz : ""}.`;
  const html = `<!doctype html><html lang="en"><head>${SHELL_HEAD}
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SunsetPing">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:type" content="image/svg+xml">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
</head><body>
<div class="hero hero-short"><div class="sun"></div><div class="wrap">
${nav()}
<p class="kicker">Shared sunset</p>
<h1>Tonight in ${esc(score.location.split(",")[0])}.</h1>
<div class="result-slot">${scoreCardHtml(score, { sharePath: canonical })}</div>
<p class="hero-links"><a class="btn" href="/#check">Check another place</a> <a class="btn ghost" href="/pro">See Pro</a></p>
</div></div></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600" },
  });
}

export function ogSvg({ score = "–", location = "Tonight's sunset", verdict = "SunsetPing", sunset = "", date = "" }) {
  const s = esc(String(score).slice(0, 3));
  const loc = esc(String(location).slice(0, 60));
  const ver = esc(String(verdict).slice(0, 40));
  const time = esc(String(sunset).slice(0, 20));
  const day = esc(String(date).slice(0, 40));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#1e1b4b"/><stop offset="48%" stop-color="#9d174d"/><stop offset="100%" stop-color="#f97316"/>
</linearGradient></defs>
<rect width="1200" height="630" fill="url(#sky)"/>
<circle cx="980" cy="560" r="210" fill="#fde68a"/>
<circle cx="980" cy="560" r="150" fill="#fb923c" opacity="0.85"/>
<text x="72" y="92" fill="#fff" font-family="Georgia, 'Times New Roman', serif" font-size="28" letter-spacing="6">SUNSETPING</text>
<text x="72" y="150" fill="#ffe4c4" font-family="Helvetica, Arial, sans-serif" font-size="28">${day}</text>
<text x="72" y="330" fill="#fff" font-family="Georgia, 'Times New Roman', serif" font-size="168" font-weight="700">${s}</text>
<text x="300" y="330" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="42" opacity="0.9">/10</text>
<text x="72" y="400" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="40" font-weight="700">${ver}</text>
<text x="72" y="470" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="36">${loc}</text>
<text x="72" y="530" fill="#fff7ed" font-family="Helvetica, Arial, sans-serif" font-size="30">${time ? `Sunset ${time}` : ""}</text>
</svg>`;
  return new Response(svg, {
    headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=600" },
  });
}

export function checkoutPlaceholder({ plan, envName }) {
  const label = plan === "yearly" ? "Pro yearly ($29/year)" : "Pro monthly ($3.99/month)";
  const html = `<!doctype html><html lang="en"><head>${SHELL_HEAD}<title>Checkout placeholder · SunsetPing</title>
<meta name="robots" content="noindex"></head>
<body class="subpage"><div class="wrap narrow">
${nav("pro")}
<main class="panel">
<p class="eyebrow">Payment placeholder</p>
<h1>No charge was made.</h1>
<p>SunsetPing Pro checkout is a Stripe Payment Link, and it is not configured in this environment. Nothing was billed and no card form is shown here.</p>
<p>When you are ready, set <code>${esc(envName)}</code> to your Stripe Payment Link URL. The ${esc(label)} button will redirect there. Until then this page is the entire checkout.</p>
<p><a class="btn" href="/pro">Back to Pro</a></p>
</main></div></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
