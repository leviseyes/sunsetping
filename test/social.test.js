import test from "node:test";
import assert from "node:assert/strict";
import { socialText, hasScore } from "../src/social.js";

test("socialText strips scores from link-preview text", () => {
  const cases = [
    ["Sunset time today in Denver: 6:11 PM · tonight 10/10 · SunsetPing", "Sunset time today in Denver: 6:11 PM · SunsetPing"],
    ["Sunset Time Today in Denver: 6:11 PM (10/10) · SunsetPing", "Sunset Time Today in Denver: 6:11 PM · SunsetPing"],
    ["Sunset time today in Denver is 6:11 PM MDT. Tonight's SunsetPing score is 10/10: Don't miss it. Sunset times for the next 7 days are listed on this page.",
     "Sunset time today in Denver is 6:11 PM MDT. Sunset times for the next 7 days are listed on this page."],
    ["A 1–10 score for tonight's sky", "A 1–10 score for tonight's sky"],
  ];
  for (const [input, want] of cases) {
    assert.equal(socialText(input), want);
    assert.equal(hasScore(socialText(input)), false);
  }
});
