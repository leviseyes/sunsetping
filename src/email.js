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

/**
 * HTML email in the same shape as email_template.py.
 * `when` is "tonight" | "tomorrow" | "sunrise".
 * Pass unsubscribeUrl to replace the {{unsubscribe_url}} placeholder.
 */
export function renderEmail(r, { unsubscribeUrl = "{{unsubscribe_url}}", when = "tonight", ranking = null } = {}) {
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
  return `<!doctype html><html><body style="margin:0;background:#fff7ed;font-family:Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
<tr><td style="background:linear-gradient(180deg,#312e81,#db2777 55%,#f97316);padding:36px 28px;color:#fff;text-align:center">
<div style="font-size:14px;letter-spacing:2px;opacity:.85">SUNSETPING · ${e.date.toUpperCase()}</div>
<div style="font-size:72px;font-weight:800;line-height:1.1;margin-top:10px">${e.score}<span style="font-size:32px;opacity:.8">/10</span></div>
<div style="font-size:20px;font-weight:600">${e.verdict}</div></td></tr>
<tr><td style="padding:28px">
<p style="font-size:18px;color:#1f2937;margin:0 0 8px">${sentence}</p>
<p style="font-size:16px;color:#4b5563;margin:0 0 20px">${e.reason}</p>
${viewingLine(r.viewing)}
${rankingBlock(ranking)}
<p style="font-size:14px;color:#6b7280;margin:12px 0 0">${tip}</p>
</td></tr><tr><td style="padding:16px 28px;background:#fafafa;font-size:12px;color:#9ca3af;text-align:center">
You're getting this because you signed up at sunsetping.com · <a href="${safeUrl}" style="color:#9ca3af">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>`;
}

export function emailSubject(r, when = "tonight") {
  if (when === "sunrise") return `Sunrise in ${r.location}: ${r.score}/10`;
  if (when === "tomorrow") return `Tomorrow's sunset in ${r.location}: ${r.score}/10`;
  return `Tonight's sunset in ${r.location}: ${r.score}/10`;
}
