#!/usr/bin/env node
/**
 * Print a sample weekly issue to stdout.
 * The subject line goes to stderr so the HTML stays clean.
 *   node scripts/preview-newsletter.mjs
 *   node scripts/preview-newsletter.mjs --pro
 */
import { newsletterSubject, renderNewsletter } from "../src/email.js";

const content = {
  range: "Oct 12–18",
  highlights: [
    {
      location: "Sedona, Arizona",
      night: "Saturday, October 17",
      score: 9,
      verdict: "Don't miss it",
      blurb: "High clouds after a clear afternoon — the color should hold past sunset.",
    },
    {
      location: "San Diego, California",
      night: "Sunday, October 18",
      score: 7,
      verdict: "Worth stepping outside",
      blurb: "A thinner marine layer than usual, so the horizon stays open.",
    },
  ],
  tip: "On a phone, tap the sky to lock exposure about a minute before the sun drops, then brighten the foreground a little.",
  feature: "Weekly notes are new. The first live issue waits on a format check.",
};

const plan = process.argv.includes("--pro") ? "pro" : "free";
console.error(newsletterSubject(content));
console.log(renderNewsletter(content, {
  plan,
  unsubscribeUrl: "https://sunsetping.com/api/unsubscribe?token=preview",
}));
