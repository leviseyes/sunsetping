function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function viewingLine(viewing) {
  if (!viewing) return "";
  const v = {
    goldenHourStart: escapeHtml(viewing.goldenHourStart),
    goldenHourEnd: escapeHtml(viewing.goldenHourEnd),
    sunset: escapeHtml(viewing.sunset),
    blueHourEnd: escapeHtml(viewing.blueHourEnd),
  };
  return `<p style="font-size:14px;color:#6b7280;margin:0 0 12px">Best window: golden hour ${v.goldenHourStart}–${v.goldenHourEnd}, sunset ${v.sunset}, blue hour until ${v.blueHourEnd}.</p>`;
}

function rankingBlock(ranking) {
  if (!ranking || ranking.length < 2) return "";
  const items = ranking
    .map((s) => `<li style="margin:0 0 4px"><b>${escapeHtml(s.location)}</b> — ${escapeHtml(s.score)}/10, ${escapeHtml(s.verdict)}</li>`)
    .join("");
  return `<p style="font-size:15px;color:#1f2937;margin:18px 0 8px"><b>Best of your spots tonight</b></p><ol style="margin:0 0 8px;padding-left:20px;color:#4b5563;font-size:15px">${items}</ol>`;
}

function lightBlock(spots) {
  if (!Array.isArray(spots) || !spots.length) return "";
  const items = spots.map((spot) => {
    const place = spot.location ? `<b>${escapeHtml(spot.location)}</b> — ` : "";
    return `<li style="margin:0 0 6px">${place}golden hour ${escapeHtml(spot.goldenHourStart)}, sunset ${escapeHtml(spot.sunset)}, blue hour ${escapeHtml(spot.blueHourStart)}–${escapeHtml(spot.blueHourEnd)}</li>`;
  }).join("");
  return `<p style="font-size:15px;color:#1f2937;margin:18px 0 8px"><b>Light plan</b></p><ul style="margin:0 0 8px;padding-left:20px;color:#4b5563;font-size:15px">${items}</ul>`;
}

export function qualityOutlookBlock(days) {
  if (!Array.isArray(days) || !days.length) return "";
  const items = days.map((day) => `<li style="margin:0 0 4px"><b>${escapeHtml(day.date)}</b> — ${escapeHtml(day.score)}/10, ${escapeHtml(day.verdict)}, sunset ${escapeHtml(day.sunset)}</li>`).join("");
  return `<p style="font-size:15px;color:#1f2937;margin:18px 0 8px"><b>Your 7-day sunset quality outlook</b></p><ol style="margin:0 0 8px;padding-left:20px;color:#4b5563;font-size:15px">${items}</ol>`;
}

function shareBlock(href, when) {
  const label = when === "sunrise" ? "Share this sunrise forecast" : when === "tomorrow" ? "Share tomorrow's forecast" : "Share tonight's forecast";
  return `<p style="font-size:15px;margin:12px 0 0"><a href="${escapeHtml(href)}" style="color:#c4541a">${label}</a></p>`;
}

/**
 * HTML email in the same shape as email_template.py.
 * `when` is "tonight" | "tomorrow" | "sunrise".
 * Pass unsubscribeUrl to replace the {{unsubscribe_url}} placeholder.
 */
export function renderEmail(r, { unsubscribeUrl = "{{unsubscribe_url}}", when = "tonight", ranking = null, shareUrl = "", light = null, outlook = null } = {}) {
  const c = r.score >= 6 ? "#f97316" : "#64748b";
  const e = {
    date: escapeHtml(r.date),
    score: escapeHtml(r.score),
    verdict: escapeHtml(r.verdict),
    location: escapeHtml(r.location),
    sunset: escapeHtml(r.sunset),
    reason: escapeHtml(r.reason),
  };
  const sentence =
    when === "sunrise"
      ? `Sunrise in <b>${e.location}</b> is at <b style="color:${c}">${e.sunset}</b>.`
      : when === "tomorrow"
        ? `Tomorrow's sunset in <b>${e.location}</b> is at <b style="color:${c}">${e.sunset}</b>.`
        : `Tonight's sunset in <b>${e.location}</b> is at <b style="color:${c}">${e.sunset}</b>.`;
  const tip =
    when === "sunrise"
      ? "The color often starts about 15 minutes <i>before</i> the sun clears the horizon."
      : "Tip: the best color usually shows up 5–15 minutes <i>after</i> the sun drops.";
  const safeUrl = escapeHtml(unsubscribeUrl);
  const share = shareUrl || `https://sunsetping.com/s/${encodeURIComponent(r.location)}`;
  const windowLine = Array.isArray(light) && light.length ? lightBlock(light) : viewingLine(r.viewing);
  const extra = shareBlock(share, when);
  return `<!doctype html><html><body style="margin:0;background:#f4efe8;font-family:Georgia,'Times New Roman',serif;color:#1c1612">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fffcf8;border-radius:28px;overflow:hidden">
<tr><td style="padding:36px 36px 8px;font-family:Helvetica,Arial,sans-serif">
<div style="font-size:12px;letter-spacing:3px;color:#6f655d">SUNSETPING · ${e.date.toUpperCase()}</div>
<div style="font-size:92px;line-height:.9;letter-spacing:-2px;margin:18px 0 6px;font-family:Georgia,'Times New Roman',serif">${e.score}<span style="font-size:28px;color:#6f655d;letter-spacing:0">/10</span></div>
<div style="height:8px;width:72px;border-radius:99px;background:${c};margin:10px 0 14px"></div>
<div style="font-size:22px;font-family:Georgia,'Times New Roman',serif">${e.verdict}</div></td></tr>
<tr><td style="padding:8px 36px 32px;font-family:Helvetica,Arial,sans-serif">
<p style="font-size:18px;color:#1c1612;margin:12px 0 8px;line-height:1.45">${sentence}</p>
<p style="font-size:16px;color:#6f655d;margin:0 0 18px;line-height:1.5">${e.reason}</p>
${windowLine}
${qualityOutlookBlock(outlook)}
${rankingBlock(ranking)}
${extra}
<p style="font-size:14px;color:#6f655d;margin:16px 0 0;line-height:1.5">${tip}</p>
</td></tr><tr><td style="padding:18px 36px 28px;background:#f7f1ea;font-size:12px;color:#a3988e;text-align:center;font-family:Helvetica,Arial,sans-serif">
You're getting this because you signed up at sunsetping.com · <a href="${safeUrl}" style="color:#c4541a">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

export function emailSubject(r, when = "tonight") {
  if (when === "sunrise") return `Sunrise in ${r.location}: ${r.score}/10`;
  if (when === "tomorrow") return `Tomorrow's sunset in ${r.location}: ${r.score}/10`;
  return `Tonight's sunset in ${r.location}: ${r.score}/10`;
}

export const FREE_PERKS = [
  "Up to 10 saved spots",
  "Sunrise alerts",
  "7-day outlook",
  "Day-before alerts",
  "Great-sunsets-only",
  "Best-spot ranking",
];

export function welcomeSubject(location) {
  const place = String(location || "your place").replace(/[\r\n]+/g, " ").slice(0, 80);
  return `You're in: sunset alerts for ${place}`;
}

/**
 * First-signup note. Same cream card as the daily alert.
 * Omit the score block when tonight is missing.
 */
export function renderWelcomeEmail({ location, tonight = null, unsubscribeUrl, downloads = [] }) {
  const place = escapeHtml(location);
  const safeUrl = escapeHtml(unsubscribeUrl);
  const hasScore = tonight && tonight.score != null && tonight.score !== "";
  const tone = hasScore && Number(tonight.score) >= 6 ? "#f97316" : "#64748b";
  const kicker = hasScore && tonight.date ? escapeHtml(String(tonight.date).toUpperCase()) : "WELCOME";
  const scoreBlock = hasScore
    ? `<div style="font-size:92px;line-height:.9;letter-spacing:-2px;margin:18px 0 6px;font-family:Georgia,'Times New Roman',serif">${escapeHtml(tonight.score)}<span style="font-size:28px;color:#6f655d;letter-spacing:0">/10</span></div>
<div style="height:8px;width:72px;border-radius:99px;background:${tone};margin:10px 0 14px"></div>
<div style="font-size:22px;font-family:Georgia,'Times New Roman',serif">${escapeHtml(tonight.verdict || "")}</div>`
    : `<div style="font-size:40px;line-height:1.05;margin:18px 0 0;font-family:Georgia,'Times New Roman',serif">You're in.</div>`;
  const tonightLine = hasScore
    ? `<p style="font-size:18px;color:#1c1612;margin:12px 0 8px;line-height:1.45">Tonight's sunset in <b>${place}</b> is at <b style="color:${tone}">${escapeHtml(tonight.sunset || "")}</b>${tonight.tz ? ` ${escapeHtml(tonight.tz)}` : ""}.</p>`
    : "";
  const reason = hasScore && tonight.reason
    ? `<p style="font-size:16px;color:#6f655d;margin:0 0 18px;line-height:1.5">${escapeHtml(tonight.reason)}</p>`
    : "";
  const perks = FREE_PERKS.map((line) => `<li style="margin:0 0 4px">${escapeHtml(line)}</li>`).join("");
  const placeName = String(location || "").trim();
  const intro = placeName
    ? `You're in. We'll email you before sunset in <b>${place}</b>.`
    : "You're in. Add a city whenever you like and we'll email you before sunset.";
  const downloadHtml = (downloads || []).map((item) => `<a href="${escapeHtml(item.href)}" style="color:#c4541a">${escapeHtml(item.label)}</a>`).join("<br>");
  const files = downloadHtml ? `<p style="font-size:15px;color:#1c1612;margin:16px 0 8px;line-height:1.55">${downloadHtml}</p>` : "";
  return `<!doctype html><html><body style="margin:0;background:#f4efe8;font-family:Georgia,'Times New Roman',serif;color:#1c1612">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fffcf8;border-radius:28px;overflow:hidden">
<tr><td style="padding:36px 36px 8px;font-family:Helvetica,Arial,sans-serif">
<div style="font-size:12px;letter-spacing:3px;color:#6f655d">SUNSETPING · ${kicker}</div>
${scoreBlock}</td></tr>
<tr><td style="padding:8px 36px 32px;font-family:Helvetica,Arial,sans-serif">
<p style="font-size:18px;color:#1c1612;margin:12px 0 8px;line-height:1.45">${intro}</p>
<p style="font-size:16px;color:#6f655d;margin:0 0 18px;line-height:1.5">Know when the light will be good before you drive out. The same-day note arrives about 3 hours before sunset.</p>
${files}
${tonightLine}${reason}
<p style="font-size:16px;color:#1c1612;margin:18px 0 8px;line-height:1.45"><b>Included free</b></p>
<ul style="margin:0 0 16px;padding-left:20px;color:#4b5563;font-size:15px">${perks}</ul>
<p style="font-size:14px;color:#6f655d;margin:12px 0 0;line-height:1.5">SunsetPing is free. Unsubscribe any time.</p>
</td></tr><tr><td style="padding:18px 36px 28px;background:#f7f1ea;font-size:12px;color:#a3988e;text-align:center;font-family:Helvetica,Arial,sans-serif">
You're getting this because you signed up at sunsetping.com · <a href="${safeUrl}" style="color:#c4541a">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Normalize an editorial issue. `highlights` or `outlook` may be one object or a list.
 * Location accepts `location` or `city`. Best night accepts `night` or `bestNight`.
 */
export function normalizeNewsletter(content = {}) {
  const raw = content?.highlights ?? content?.outlook ?? [];
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  const highlights = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const location = clean(item.location || item.city);
    const night = clean(item.night || item.bestNight || item.date);
    const score = item.score == null || item.score === "" ? null : Number(item.score);
    const verdict = clean(item.verdict);
    const blurb = clean(item.blurb || item.reason);
    if (!location && !night && !verdict && !blurb && score == null) continue;
    highlights.push({
      location,
      night,
      score: Number.isFinite(score) ? score : null,
      verdict,
      blurb,
    });
  }
  const issueDate = clean(content?.issueDate);
  return {
    range: clean(content?.range || content?.dateRange),
    highlights,
    tip: clean(content?.tip),
    feature: clean(content?.feature ?? content?.whatsNew),
    issueDate: /^\d{4}-\d{2}-\d{2}$/.test(issueDate) ? issueDate : "",
  };
}

function moreOutlook(rest) {
  if (!rest.length) return "";
  const items = rest
    .map((h) => {
      const meta = [h.night, h.score == null ? "" : `${h.score}/10`, h.verdict].filter(Boolean).map((part) => escapeHtml(part));
      const detail = h.blurb ? ` — ${escapeHtml(h.blurb)}` : "";
      const tail = meta.length ? ` — ${meta.join(", ")}` : "";
      return `<li style="margin:0 0 8px"><b>${escapeHtml(h.location)}</b>${tail}${detail}</li>`;
    })
    .join("");
  return `<p style="font-size:15px;color:#1f2937;margin:18px 0 8px"><b>Also on the outlook</b></p><ul style="margin:0 0 8px;padding-left:20px;color:#4b5563;font-size:15px">${items}</ul>`;
}

/**
 * Weekly issue, same cream card as the daily alert.
 * Pass unsubscribeUrl to replace the {{unsubscribe_url}} placeholder.
 */
export function renderNewsletter(input, { unsubscribeUrl = "{{unsubscribe_url}}", outlook = null } = {}) {
  const content = normalizeNewsletter(input);
  const lead = content.highlights[0] || { location: "", night: "", score: null, verdict: "", blurb: "" };
  const c = lead.score != null && lead.score >= 6 ? "#f97316" : "#64748b";
  const range = content.range ? ` · ${escapeHtml(content.range).toUpperCase()}` : "";
  const scoreBlock =
    lead.score == null
      ? ""
      : `<div style="font-size:92px;line-height:.9;letter-spacing:-2px;margin:18px 0 6px;font-family:Georgia,'Times New Roman',serif">${escapeHtml(lead.score)}<span style="font-size:28px;color:#6f655d;letter-spacing:0">/10</span></div>
<div style="height:8px;width:72px;border-radius:99px;background:${c};margin:10px 0 14px"></div>`;
  const verdict = lead.verdict ? `<div style="font-size:22px;font-family:Georgia,'Times New Roman',serif">${escapeHtml(lead.verdict)}</div>` : "";
  const where = lead.location
    ? lead.night
      ? `<p style="font-size:18px;color:#1c1612;margin:12px 0 8px;line-height:1.45">Best night in <b>${escapeHtml(lead.location)}</b>: <b style="color:${c}">${escapeHtml(lead.night)}</b>.</p>`
      : `<p style="font-size:18px;color:#1c1612;margin:12px 0 8px;line-height:1.45">This week's pick: <b>${escapeHtml(lead.location)}</b>.</p>`
    : "";
  const blurb = lead.blurb ? `<p style="font-size:16px;color:#6f655d;margin:0 0 18px;line-height:1.5">${escapeHtml(lead.blurb)}</p>` : "";
  const tip = content.tip
    ? `<p style="font-size:15px;color:#1c1612;margin:18px 0 8px"><b>A short tip</b></p><p style="font-size:14px;color:#6f655d;margin:0;line-height:1.5">${escapeHtml(content.tip)}</p>`
    : "";
  const feature = content.feature
    ? `<p style="font-size:15px;color:#1c1612;margin:18px 0 8px"><b>What's new</b></p><p style="font-size:16px;color:#6f655d;margin:0 0 8px;line-height:1.5">${escapeHtml(content.feature)}</p>`
    : "";
  const safeUrl = escapeHtml(unsubscribeUrl);
  return `<!doctype html><html><body style="margin:0;background:#f4efe8;font-family:Georgia,'Times New Roman',serif;color:#1c1612">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="520" cellpadding="0" cellspacing="0" style="background:#fffcf8;border-radius:28px;overflow:hidden">
<tr><td style="padding:36px 36px 8px;font-family:Helvetica,Arial,sans-serif">
<div style="font-size:12px;letter-spacing:3px;color:#6f655d">SUNSETPING · WEEKLY${range}</div>
<div style="font-size:28px;line-height:1.2;margin:18px 0 0;font-family:Georgia,'Times New Roman',serif">This week's best sunset outlook</div>
${scoreBlock}${verdict}</td></tr>
<tr><td style="padding:8px 36px 32px;font-family:Helvetica,Arial,sans-serif">
${where}${blurb}${moreOutlook(content.highlights.slice(1))}${qualityOutlookBlock(outlook)}${tip}${feature}
<p style="font-size:14px;color:#6f655d;margin:16px 0 0;line-height:1.5">Photo of the month: reply to any SunsetPing email with your best sunset shot. The winner is featured on the site and @MosheLevis on X.</p>
</td></tr><tr><td style="padding:18px 36px 28px;background:#f7f1ea;font-size:12px;color:#a3988e;text-align:center;font-family:Helvetica,Arial,sans-serif">
You're getting this because you signed up at sunsetping.com · <a href="${safeUrl}" style="color:#c4541a">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

export function newsletterSubject(input = {}) {
  const content = normalizeNewsletter(input);
  const lead = content.highlights[0];
  if (lead?.location && lead.score != null) {
    const base = `This week's sunset in ${lead.location}: ${lead.score}/10`;
    return content.range ? `${base} · ${content.range}` : base;
  }
  if (lead?.location) {
    const base = `This week's sunset in ${lead.location}`;
    return content.range ? `${base} · ${content.range}` : base;
  }
  return content.range ? `SunsetPing weekly · ${content.range}` : "SunsetPing weekly";
}
