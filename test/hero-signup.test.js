import assert from "node:assert/strict";
import test from "node:test";
import { CITIES } from "../src/cities.js";
import worker from "../src/worker.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

function austinForecast() {
  return async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) {
      return Response.json(geocodeBody({
        name: "Austin",
        admin1: "Texas",
        latitude: 30.27,
        longitude: -97.74,
        timezone: "America/Chicago",
      }));
    }
    if (u.includes("api.open-meteo.com")) {
      return Response.json(flatForecast([day("2026-10-15T18:59", PERFECT)], "America/Chicago"));
    }
    throw new Error("unexpected fetch " + u);
  };
}

function heroForm(html) {
  const start = html.indexOf('class="stack hero-signup-form"');
  assert.ok(start > 0, "hero signup form");
  const end = html.indexOf("</form>", start);
  return html.slice(start, end);
}

function assertHero(html, { weekId, city }) {
  const form = heroForm(html);
  assert.match(form, /data-signup/);
  assert.match(form, /action="\/api\/subscribe"/);
  assert.match(form, /id="hero-email"/);
  assert.match(form, /type="email" name="email"/);
  assert.match(form, new RegExp(`type="hidden" name="location" value="${city.query}"`));
  assert.doesNotMatch(form, /id="hero-location"/);
  assert.match(form, /type="hidden" name="tz"/);
  assert.match(form, /name="great_only" value="1"/);
  assert.match(form, /Only email me on great nights \(8\+\)/);
  assert.match(form, new RegExp(`Email me when ${city.city}&#39;s sunset is worth it`));
  assert.equal((html.match(/id="hero-email"/g) || []).length, 1);
  assert.equal((html.match(/id="city-signup-email"/g) || []).length, 1);
  assert.equal((html.match(/id="footer-email"/g) || []).length, 1);
  assert.equal((html.match(/id="sticky-email"/g) || []).length, 1);
  assert.match(html, /id="signup"/);
  assert.match(html, /class="signup-sticky"/);
  assert.match(html, /class="footer-signup"/);
  assert.match(html, /<a href="\/tonight">See tonight's best sunsets across the US<\/a>/);
  const h1 = html.indexOf("<h1>");
  const hero = html.indexOf('id="hero-email"');
  const week = html.indexOf(`id="${weekId}"`);
  const lower = html.indexOf('id="city-signup-email"');
  assert.ok(h1 >= 0 && hero > h1, "hero form sits under the title");
  assert.ok(week > hero, "hero form sits above the week table");
  assert.ok(lower > week, "the lower signup form stays below the week table");
  const sample = html.match(/<p class="sample-alert">([\s\S]*?)<\/p>/);
  assert.ok(sample, "sample alert");
  assert.match(sample[1], new RegExp(`Sample alert: (?:&quot;|")${city.city} tonight: 10/10`));
  assert.match(sample[1], /Sunset 6:59 PM, golden hour starts 5:59 PM/);
}

test("city pages put a prefilled signup form under the score and above the week table", async () => {
  const city = CITIES.find((entry) => entry.slug === "austin");
  await withFetch(austinForecast(), async () => {
    const env = testEnv(createDb());
    const pages = [
      ["/sunset/austin", "sunset-week"],
      ["/sunset-time/austin", "sunset-week"],
      ["/golden-hour/austin", "golden-week"],
    ];
    for (const [path, weekId] of pages) {
      const res = await worker.fetch(new Request(`https://sunsetping.com${path}`), env);
      assert.equal(res.status, 200, path);
      assertHero(await res.text(), { weekId, city });
    }
  });
});

test("a city page keeps the hero form when the forecast fails, with an example alert", async () => {
  await withFetch(async () => {
    throw new Error("open-meteo down");
  }, async () => {
    const env = testEnv(createDb());
    for (const path of ["/sunset/austin", "/sunset-time/austin", "/golden-hour/austin"]) {
      const res = await worker.fetch(new Request(`https://sunsetping.com${path}`), env);
      assert.equal(res.status, 200, path);
      const html = await res.text();
      const form = heroForm(html);
      assert.match(form, /type="hidden" name="location" value="Austin, Texas"/);
      assert.match(form, /id="hero-email"/);
      assert.match(form, /name="great_only"/);
      assert.match(html, /id="city-signup-email"/);
      const sample = html.match(/<p class="sample-alert">([\s\S]*?)<\/p>/)[1];
      assert.match(sample, /Sample alert \(example\)/);
      assert.match(sample, /Austin tonight: 8\/10, high clouds to catch the color/);
      assert.match(sample, /The email includes the local sunset and golden hour/);
      assert.doesNotMatch(sample, /\d{1,2}:\d{2}/);
      assert.ok(html.indexOf('id="hero-email"') < html.indexOf('id="city-signup-email"'));
    }
  });
});
