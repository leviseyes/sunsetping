const resultEl = document.getElementById("result");
const lookup = document.getElementById("lookup");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function factor(name, value, label, tone, width) {
  const w = Math.max(0, Math.min(100, Number(width) || 0));
  return `<li><span class="k">${esc(name)}</span><span class="bar" aria-hidden="true"><i class="tone-${esc(tone)}" style="width:${w}%"></i></span><span class="v">${esc(value)}</span><span class="lab">${esc(label)}</span></li>`;
}

function cardHtml(score) {
  const share = `${location.origin}/s/${encodeURIComponent(score.location)}`;
  const c = score.colorChance || {};
  const v = score.viewing || {};
  const bucket = score.score >= 8 ? "hot" : score.score >= 6 ? "good" : score.score >= 4 ? "mid" : "low";
  const vis = c.visibility?.km ?? "";
  const pct = Number(score.score) * 10;
  return `<article class="result" data-result>
<header class="result-top"><div><p class="eyebrow">Tonight · ${esc(score.date)}</p><h2>${esc(score.location)}</h2></div>
<p class="pill score-${bucket}">${esc(score.verdict)}</p></header>
<div class="result-main"><div class="gauge" style="--score:${pct}" role="img" aria-label="Score ${esc(score.score)} out of 10">
<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="gauge-track" cx="60" cy="60" r="52"></circle><circle class="gauge-value" cx="60" cy="60" r="52"></circle></svg>
<div class="gauge-label"><strong>${esc(score.score)}</strong><span>/10</span></div></div>
<div><p class="sunset-line">Sun sets at <b>${esc(score.sunset)}</b> ${score.tz ? `<span class="tz">${esc(score.tz)}</span>` : ""}</p>
<p class="reason">${esc(score.reason)}</p></div></div>
<ol class="window">
<li><span>Golden hour start</span><b>${esc(v.goldenHourStart)}</b></li>
<li><span>Golden hour end</span><b>${esc(v.goldenHourEnd)}</b></li>
<li><span>Sunset</span><b>${esc(v.sunset)}</b></li>
<li><span>Blue hour end</span><b>${esc(v.blueHourEnd)}</b></li>
</ol>
<div class="chance"><h3>Color chance <em>${esc(c.summary || "")}</em></h3><ul>
${factor("Low cloud", `${c.low?.percent ?? "–"}%`, c.low?.label, c.low?.tone, c.low?.percent)}
${factor("Mid cloud", `${c.mid?.percent ?? "–"}%`, c.mid?.label, c.mid?.tone, c.mid?.percent)}
${factor("High cloud", `${c.high?.percent ?? "–"}%`, c.high?.label, c.high?.tone, c.high?.percent)}
${factor("Humidity", `${c.humidity?.percent ?? "–"}%`, c.humidity?.label, c.humidity?.tone, c.humidity?.percent)}
${factor("Visibility", `${vis} km`, c.visibility?.label, c.visibility?.tone, Math.round(Math.min(100, (Number(vis) / 30) * 100)))}
</ul></div>
<p class="share-row"><a class="share-url" href="${esc(share)}">${esc(share.replace(/^https?:\/\//, ""))}</a></p>
<button type="button" class="btn" id="copy-share">Copy share link</button>
</article>`;
}

async function showScore(url) {
  resultEl.hidden = false;
  resultEl.innerHTML = `<p class="status">Checking the clouds…</p>`;
  try {
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "We couldn't score that place.");
    resultEl.innerHTML = cardHtml(data);
    const share = `${location.origin}/s/${encodeURIComponent(data.location)}`;
    document.getElementById("copy-share").addEventListener("click", async () => {
      const btn = document.getElementById("copy-share");
      try {
        if (navigator.share) {
          await navigator.share({ title: `Tonight's sunset in ${data.location}: ${data.score}/10`, text: data.reason, url: share });
          return;
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
      try {
        await navigator.clipboard.writeText(share);
        btn.textContent = "Link copied";
      } catch {
        btn.textContent = "Copy the link above";
      }
    });
    resultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    resultEl.innerHTML = `<p class="error-banner">${esc(err.message || "Something went wrong.")}</p>`;
  }
}

lookup?.addEventListener("submit", (event) => {
  event.preventDefault();
  const q = new FormData(lookup).get("q").trim();
  if (q.length < 2) return;
  showScore(`/api/score?q=${encodeURIComponent(q)}`);
});

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

function showSignupError(form, message) {
  let note = form.querySelector(".error-banner");
  if (!note) {
    note = document.createElement("p");
    note.className = "error-banner";
    form.append(note);
  }
  note.textContent = message;
}

async function submitSignup(form) {
  const button = form.querySelector('button[type="submit"]');
  const label = button?.textContent || "";
  form.querySelector(".error-banner")?.remove();
  if (button) {
    button.disabled = true;
    button.textContent = "Sending…";
  }
  try {
    const body = Object.fromEntries(new FormData(form));
    const res = await fetch("/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Could not subscribe.");
    const host = form.closest("[data-welcome-host]") || form.closest(".signup-block") || form;
    host.classList.remove("panel");
    host.innerHTML = data.offerHtml || "";
    const heading = host.querySelector("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
    host.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
    showSignupError(form, err.message || "Could not subscribe.");
  }
}

document.querySelectorAll("form[data-signup]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitSignup(form);
  });
});

document.getElementById("geo")?.addEventListener("click", () => {
  if (!navigator.geolocation) {
    resultEl.innerHTML = `<p class="error-banner">This browser can't share a location. Type a city instead.</p>`;
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => showScore(`/api/score?lat=${encodeURIComponent(pos.coords.latitude)}&lon=${encodeURIComponent(pos.coords.longitude)}`),
    () => {
      resultEl.innerHTML = `<p class="error-banner">Location permission was blocked. Type a city instead.</p>`;
    }
  );
});
