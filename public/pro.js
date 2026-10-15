function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function loadOutlook(q) {
  const mount = document.getElementById("outlook");
  mount.innerHTML = `<p class="section-lead">Checking the week in ${esc(q)}…</p>`;
  const res = await fetch(`/api/outlook?q=${encodeURIComponent(q)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    mount.innerHTML = `<p class="error-banner">${esc(data.error || "Could not load the outlook.")}</p>`;
    return;
  }
  mount.innerHTML = data.days.map((day) => `<article class="day"><span>${esc(day.date.replace(/,?\s*\d{4}$/, "").replace(/^(\w+),\s*/, "$1 · "))}</span><b>${esc(day.score)}</b><span>${esc(day.sunset)}</span><span>${esc(day.verdict)}</span></article>`).join("");
}

async function loadRanking() {
  const mount = document.getElementById("ranking");
  const params = new URLSearchParams();
  for (const spot of ["Sedona", "Key West", "Cannon Beach"]) params.append("spot", spot);
  const res = await fetch(`/api/best-spot?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    mount.innerHTML = `<p class="error-banner">${esc(data.error || "Could not rank those spots.")}</p>`;
    return;
  }
  mount.innerHTML = data.ranking.map((spot) => `<article class="spot${spot.rank === 1 ? " best" : ""}"><span>${spot.rank === 1 ? "Best tonight" : `No. ${spot.rank}`}</span><b>${esc(spot.score)}/10</b><span>${esc(spot.location)}</span><span>${esc(spot.sunset)} · ${esc(spot.verdict)}</span></article>`).join("");
}

function knownEmail() {
  return [...document.querySelectorAll('input[type="email"]')].map((el) => el.value.trim()).find(Boolean) || "";
}

function prefillCheckoutLinks() {
  const email = knownEmail();
  document.querySelectorAll('a[href*="/api/checkout"]').forEach((link) => {
    const url = new URL(link.href, location.origin);
    if (email) url.searchParams.set("email", email);
    else url.searchParams.delete("email");
    link.href = `${url.pathname}${url.search}`;
  });
}

document.addEventListener("input", (event) => {
  if (event.target?.type === "email") prefillCheckoutLinks();
});
document.querySelectorAll('a[href*="/api/checkout"]').forEach((link) => {
  link.addEventListener("click", prefillCheckoutLinks);
});

document.getElementById("outlook-form")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = new FormData(event.target).get("q").trim();
  if (q) loadOutlook(q);
});

async function postForm(form, url, mountId, extra) {
  const body = Object.fromEntries(new FormData(form));
  if (extra) Object.assign(body, extra(body));
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  document.getElementById(mountId).textContent = data.error || (res.ok ? "Saved." : "Could not save that.");
}

document.getElementById("save-spot")?.addEventListener("submit", (event) => {
  event.preventDefault();
  postForm(event.target, "/api/locations", "save-msg");
});

document.getElementById("settings")?.addEventListener("submit", (event) => {
  event.preventDefault();
  postForm(event.target, "/api/settings", "settings-msg", (body) => ({
    sunriseAlerts: Boolean(body.sunriseAlerts),
    dayBefore: Boolean(body.dayBefore),
    scoreThreshold: body.scoreThreshold === "" ? null : Number(body.scoreThreshold),
  }));
});

loadOutlook("Sedona");
loadRanking();
