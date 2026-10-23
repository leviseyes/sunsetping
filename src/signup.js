export const SIGNUP_HEADLINE = "Know when the light will be good before you drive out";
export const MOSH_BONUS = "Free bonus: get the MOSH Planner PDF when you sign up.";
export const CHEAT_SHEET_PATH = "/downloads/sunset-cheat-sheet.pdf";
export const MOSH_SITE = "https://moshplanner.com";
export const OUTLOOK_CTA = "Get the 7-day sunset quality outlook free by email";
export const EARLY_ACCESS = "Subscribers get first access to upcoming aurora & fog alerts";
export const GREAT_NIGHTS = "Only email me on great nights (8+)";

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function moshPdfUrl(env) {
  return String(env?.MOSH_PDF_URL ?? "").trim();
}

export function absoluteUrl(env, pathOrUrl) {
  const raw = String(pathOrUrl || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const base = String(env?.PUBLIC_BASE_URL || "https://sunsetping.com").replace(/\/$/, "");
  return base + (raw.startsWith("/") ? raw : `/${raw}`);
}

/** Cheat sheet always. MOSH Planner and moshplanner.com only when MOSH_PDF_URL is set. */
export function downloadLinks(env) {
  const links = [{ href: absoluteUrl(env, CHEAT_SHEET_PATH), label: "Download the sunset shooting cheat sheet" }];
  const mosh = absoluteUrl(env, moshPdfUrl(env));
  if (mosh) {
    links.push({ href: mosh, label: "Download the MOSH Planner PDF" });
    links.push({ href: MOSH_SITE, label: "moshplanner.com" });
  }
  return links;
}

export function perkLines(showMosh) {
  return [
    "7-day sunset quality outlook, free by email",
    "8+ only alerts. Never waste a drive.",
    "Golden hour and blue hour times in every alert",
    showMosh ? "Sunset cheat sheet and the MOSH Planner PDF" : "Sunset shooting cheat sheet",
    "Photo of the month: reply with your best sunset shot",
    EARLY_ACCESS,
  ];
}

export function perkListHtml(showMosh) {
  const items = perkLines(showMosh).map((text, index) => {
    const attr = showMosh && index === 3 ? " data-mosh-perk" : "";
    return `<li${attr}>${esc(text)}</li>`;
  }).join("");
  const bonus = showMosh ? `<p class="bonus" data-mosh-bonus>${esc(MOSH_BONUS)}</p>` : "";
  return `<ul class="perk-list">${items}</ul>${bonus}`;
}

export function greatNightsField() {
  return `<label class="check"><input type="checkbox" name="great_only" value="1"> ${esc(GREAT_NIGHTS)}</label>`;
}

export function wantsGreatNights(value) {
  return value === true || value === 1 || value === "1" || value === "on" || value === "true";
}

/** Short signup: email, optional city, 8+ checkbox, and the free-perk list. */
export function signupBlock({
  idPrefix = "signup",
  location = "",
  button = "Get free alerts",
  showMosh = false,
  headline = SIGNUP_HEADLINE,
  lead = "",
  formClass = "stack signup",
  formName = "share",
  path = "",
} = {}) {
  const perks = perkLines(showMosh).map((text, index) => {
    const attr = showMosh && index === 3 ? " data-mosh-perk" : "";
    return `<li${attr}>${esc(text)}</li>`;
  }).join("");
  const bonus = showMosh ? `<p class="bonus" data-mosh-bonus>${esc(MOSH_BONUS)}</p>` : "";
  const leadHtml = lead ? `<p class="lede">${esc(lead)}</p>` : "";
  const loc = location ? ` value="${esc(location)}"` : "";
  const prefix = esc(idPrefix);
  return `<h2>${esc(headline)}</h2>
${leadHtml}<ul class="perk-list">${perks}</ul>
${bonus}<form class="${esc(formClass)}" action="/api/subscribe" method="post" data-signup data-form="${esc(formName)}">
<label class="sr-only" for="${prefix}-email">Email</label>
<input id="${prefix}-email" type="email" name="email" placeholder="you@email.com" required autocomplete="email" aria-label="Email">
<label class="sr-only" for="${prefix}-location">City or ZIP, optional</label>
<input id="${prefix}-location" type="text" name="location"${loc} placeholder="City or ZIP (optional)" maxlength="100" aria-label="City or ZIP, optional">
<input type="hidden" name="tz">
<input type="hidden" name="signup_path" value="${esc(path)}">
<input type="hidden" name="signup_form" value="${esc(formName)}">
<label class="check"><input type="checkbox" name="great_only" value="1"> ${esc(GREAT_NIGHTS)}</label>
<button class="btn" type="submit">${esc(button)}</button>
</form>`;
}
