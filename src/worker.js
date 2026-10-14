const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const page = (title, msg, s = 200) => new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;background:linear-gradient(#7c3aed,#db2777,#f97316);color:#fff;min-height:100vh;margin:0;display:flex;align-items:center;justify-content:center;text-align:center"><div><h1>${title}</h1><p>${msg}</p><p><a style="color:#fff" href="/">Back to SunsetPing</a></p></div>`, { status: s, headers: { "content-type": "text/html" } });
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

async function subscribe(req, env) {
  const ct = req.headers.get("content-type") || "";
  const body = ct.includes("json") ? await req.json().catch(() => ({})) : Object.fromEntries(await req.formData().catch(() => new FormData()));
  const wantsJson = ct.includes("json") || (req.headers.get("accept") || "").includes("json");
  const fail = (m, s = 400) => wantsJson ? json({ ok: false, error: m }, s) : page("Hmm…", esc(m), s);
  const email = String(body.email || "").trim().toLowerCase();
  const location = String(body.location || "").trim().slice(0, 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) return fail("Please enter a valid email.");
  if (location.length < 2) return fail("Please enter a city or ZIP code.");
  const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(location)}`).then(r => r.json()).catch(() => ({}));
  const hit = g.results && g.results[0];
  if (!hit) return fail("We couldn't find that location. Try a city name.");
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const place = [hit.name, hit.admin1 || hit.country].filter(Boolean).join(", ");
  await env.DB.prepare(`INSERT INTO subscribers (email, location, lat, lon, tz, unsubscribe_token, status) VALUES (?1,?2,?3,?4,?5,?6,'active')
    ON CONFLICT(email) DO UPDATE SET location=?2, lat=?3, lon=?4, tz=?5, status='active'`)
    .bind(email, place, hit.latitude, hit.longitude, hit.timezone || body.tz || null, token).run();
  return wantsJson ? json({ ok: true, location: place }) : page("You're in! 🌅", `We'll email you before sunset in ${esc(place)}.`);
}

async function unsubscribe(url, env) {
  const t = url.searchParams.get("token") || "";
  if (!/^[a-f0-9]{64}$/.test(t)) return page("Invalid link", "That unsubscribe link isn't valid.", 400);
  const r = await env.DB.prepare("UPDATE subscribers SET status='unsubscribed' WHERE unsubscribe_token=?1").bind(t).run();
  return r.meta.changes ? page("Unsubscribed", "You won't get any more SunsetPing emails.") : page("Not found", "That link has already been used or doesn't exist.", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/subscribe") return req.method === "POST" ? subscribe(req, env) : json({ error: "POST only" }, 405);
    if (url.pathname === "/api/unsubscribe") return unsubscribe(url, env);
    return env.ASSETS.fetch(req);
  },
};
