import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { renderEmail, renderWelcomeEmail, renderNewsletter } from "../src/email.js";

const tonight = { score: 7, verdict: "Worth stepping outside", sunset: "5:56 PM", tz: "PDT", reason: "High clouds.", date: "Thursday, October 29" };

function assertFluid(html, label) {
  assert.ok(!/<table width="520"/.test(html), `${label}: card must not be a fixed 520px table`);
  assert.match(html, /max-width:520px;width:100%/, `${label}: fluid card`);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, `${label}: viewport`);
  assert.match(html, /@media only screen and \(max-width:540px\)/, `${label}: phone padding`);
  assert.match(html, /class="sp-pad"/, `${label}: padded cells`);
}

test("welcome email is fluid on phones", () => {
  assertFluid(renderWelcomeEmail({ location: "Seattle, Washington", tonight, unsubscribeUrl: "https://x/u", changeCityUrl: "https://x/c" }), "welcome");
});

test("alert email is fluid on phones", () => {
  const r = { location: "Seattle", score: 7, verdict: "Worth stepping outside", sunset: "5:56 PM", tz: "PDT", reason: "High clouds.", date: "Thursday, October 29", golden: "4:56 PM", viewing: null };
  assertFluid(renderEmail(r, { unsubscribeUrl: "https://x/u" }), "alert");
});

test("newsletter email is fluid on phones", () => {
  assertFluid(renderNewsletter({ headline: "This week", days: [] }, { unsubscribeUrl: "https://x/u" }), "newsletter");
});

test("home: tonight link sits below the lookup form, mobile hero card is not a pill", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const form = html.indexOf('id="geo"');
  const link = html.indexOf('<a href="/tonight">See tonight');
  assert.ok(form > 0 && link > form, "tonight link after lookup form");
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.stage \.hero-signup \.signup \{ border-radius: 22px; padding: 8px; \}/);
  assert.match(css, /\.hero-copy \{ padding-bottom: 92px; \}/);
});
