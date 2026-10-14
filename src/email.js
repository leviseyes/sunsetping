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
${viewingLine(r.viewing)}
${rankingBlock(ranking)}
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
