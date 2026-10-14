from html import escape
def render_email(r):
    c = "#f97316" if r["score"] >= 6 else "#64748b"
    e = {k: escape(str(v)) for k, v in r.items() if k != "details"}
    return f"""<!doctype html><html><body style="margin:0;background:#fff7ed;font-family:Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)">
<tr><td style="background:linear-gradient(180deg,#312e81,#db2777 55%,#f97316);padding:36px 28px;color:#fff;text-align:center">
<div style="font-size:14px;letter-spacing:2px;opacity:.85">SUNSETPING · {e['date'].upper()}</div>
<div style="font-size:72px;font-weight:800;line-height:1.1;margin-top:10px">{e['score']}<span style="font-size:32px;opacity:.8">/10</span></div>
<div style="font-size:20px;font-weight:600">{e['verdict']}</div></td></tr>
<tr><td style="padding:28px">
<p style="font-size:18px;color:#1f2937;margin:0 0 8px">Tonight's sunset in <b>{e['location']}</b> is at <b style="color:{c}">{e['sunset']}</b>.</p>
<p style="font-size:16px;color:#4b5563;margin:0 0 20px">{e['reason']}</p>
<p style="font-size:14px;color:#6b7280;margin:0">Tip: the best color usually shows up 5–15 minutes <i>after</i> the sun drops.</p>
</td></tr><tr><td style="padding:16px 28px;background:#fafafa;font-size:12px;color:#9ca3af;text-align:center">
You're getting this because you signed up at sunsetping.com · <a href="{{{{unsubscribe_url}}}}" style="color:#9ca3af">Unsubscribe</a></td></tr>
</table></td></tr></table></body></html>"""
