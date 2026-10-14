/**
 * Pluggable mail sender.
 * With no RESEND_API_KEY this logs the message and does not contact any provider.
 * A key opts in to Resend (https://api.resend.com/emails). Tests and local dev leave it unset.
 */
export async function sendEmail({ to, subject, html, env = {}, fetchImpl = fetch }) {
  const key = env.RESEND_API_KEY;
  if (!key) {
    console.log(JSON.stringify({ event: "email_noop", to, subject, bytes: html?.length || 0 }));
    return { ok: true, sent: false, mode: "noop" };
  }
  const from = env.EMAIL_FROM || "SunsetPing <alerts@sunsetping.com>";
  let res;
  try {
    res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
  } catch (err) {
    console.log(JSON.stringify({ event: "email_resend_error", message: String(err?.message || err) }));
    return { ok: false, sent: false, mode: "resend" };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.log(JSON.stringify({ event: "email_resend_error", status: res.status, detail: detail.slice(0, 300) }));
    return { ok: false, sent: false, mode: "resend", status: res.status };
  }
  return { ok: true, sent: true, mode: "resend" };
}
