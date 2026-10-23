import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  allowsTrackSite,
  isBotUa,
  normalizeAnalyticsPath,
  normalizeForm,
  normalizeReferrerHost,
  signupAttribution,
} from "../src/analytics.js";
import worker from "../src/worker.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const SECRET = "test-cron-secret";

function ctx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(p); } };
}

async function flush(context) {
  await Promise.all(context.pending);
}

function trackRequest(body, headers = {}) {
  return new Request("https://sunsetping.com/api/t", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": BROWSER, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("path, form, referrer, and bot checks stay inside the public route set", () => {
  assert.equal(normalizeAnalyticsPath("/Sunset/Sedona?utm=1#hour"), "/sunset/sedona");
  assert.equal(normalizeAnalyticsPath("/sunset/not-a-city"), "/other");
  assert.equal(normalizeAnalyticsPath("/s/Denver, Colorado"), "/s/*");
  assert.equal(normalizeAnalyticsPath("/faq/"), "/faq");
  assert.equal(normalizeAnalyticsPath("/photo-of-the-month.html"), "/photo-of-the-month");
  assert.equal(normalizeAnalyticsPath("/index.html"), "/");
  assert.equal(normalizeAnalyticsPath("/widget"), "/widget");
  assert.equal(normalizeAnalyticsPath("/golden-hour/maui"), "/golden-hour/maui");
  assert.equal(normalizeAnalyticsPath("/sunset-time/austin"), "/sunset-time/austin");
  assert.equal(normalizeAnalyticsPath("/embed/sedona"), "/embed/sedona");
  assert.equal(normalizeAnalyticsPath("/embed/nope"), "/other");
  assert.equal(normalizeAnalyticsPath("https://sunsetping.com/tonight?x=1"), "/tonight");
  assert.equal(normalizeAnalyticsPath("https://evil.example/sunset/sedona"), "/other");
  assert.equal(normalizeAnalyticsPath("javascript:alert(1)"), "/other");
  assert.equal(normalizeAnalyticsPath(`/${"a".repeat(180)}`), "/other");
  assert.equal(normalizeForm("Hero"), "hero");
  assert.equal(normalizeForm("home-top"), "home-top");
  assert.equal(normalizeForm("hello there"), "");
  assert.equal(normalizeForm("x".repeat(40)), "");
  assert.equal(normalizeReferrerHost("https://Google.com/search?q=secret"), "google.com");
  assert.equal(normalizeReferrerHost("https://sunsetping.com/faq"), "");
  assert.equal(normalizeReferrerHost("https://www.sunsetping.com/"), "");
  assert.equal(normalizeReferrerHost("not a host!!"), "");
  assert.equal(normalizeReferrerHost("blog.example"), "blog.example");
  assert.equal(signupAttribution({}).path, null);
  assert.equal(signupAttribution({ signup_path: "/sunset/sedona", signup_form: "HERO" }).path, "/sunset/sedona");
  assert.equal(signupAttribution({ signup_path: "/sunset/sedona", signup_form: "HERO" }).form, "hero");
  assert.equal(signupAttribution({ signup_path: "nope", signup_form: "hello there" }).path, null);
  assert.equal(signupAttribution({ signup_form: "x".repeat(40) }).form, null);
  assert.equal(signupAttribution({ signup_path: `/${"a".repeat(250)}` }).path, null);
  assert.equal(isBotUa(""), true);
  assert.equal(isBotUa("curl/8.0"), true);
  assert.equal(isBotUa("Mozilla/5.0 (compatible; Googlebot/2.1)"), true);
  assert.equal(isBotUa("python-requests/2.31"), true);
  assert.equal(isBotUa(BROWSER), false);
  assert.equal(allowsTrackSite(null), true);
  assert.equal(allowsTrackSite("same-origin"), true);
  assert.equal(allowsTrackSite("cross-site"), false);
  assert.equal(allowsTrackSite("same-site"), false);
});

test("POST /api/t always returns 204 and only counts allowed human events", async () => {
  const db = createDb();
  const env = testEnv(db, { CRON_SECRET: SECRET });
  const context = ctx();
  const posts = [
    [{ e: "pageview", p: "/Sunset/Sedona?utm=1", f: "", r: "https://Google.com/search?q=secret" }, {}],
    [{ e: "pageview", p: "/sunset/sedona", f: "", r: "https://news.example/story" }, { "sec-fetch-site": "same-origin" }],
    [{ e: "form_view", p: "/sunset/sedona", f: "Hero", r: "" }, {}],
    [{ e: "form_focus", p: "/sunset/sedona", f: "hero", r: "" }, {}],
    [{ e: "form_submit", p: "/sunset/sedona", f: "hero", r: "" }, {}],
    [{ e: "pageview", p: "/s/Denver, Colorado", f: "", r: "https://sunsetping.com/faq" }, {}],
    [{ e: "pageview", p: "/sunset/not-a-city", f: "", r: "not a host!!" }, {}],
    [{ e: "click", p: "/", f: "", r: "" }, {}],
    [{ e: "signup_ok", p: "/", f: "hero", r: "" }, {}],
    [{ e: "pageview", p: "/", f: "", r: "" }, { "user-agent": "curl/8.4.0" }],
    [{ e: "pageview", p: "/", f: "", r: "" }, { "user-agent": "" }],
    [{ e: "pageview", p: "/faq", f: "", r: "" }, { "sec-fetch-site": "cross-site" }],
    [{ e: "pageview", p: "/tonight", f: "", r: "" }, { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.0)" }],
  ];
  for (const [body, headers] of posts) {
    const res = await worker.fetch(trackRequest(body, headers), env, context);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  }
  const huge = await worker.fetch(trackRequest({ e: "pageview", p: "/", f: "", r: "x".repeat(2000) }), env, context);
  assert.equal(huge.status, 204);
  const bad = await worker.fetch(trackRequest("{", {}), env, context);
  assert.equal(bad.status, 204);
  const get = await worker.fetch(new Request("https://sunsetping.com/api/t"), env, context);
  assert.equal(get.status, 204);
  await flush(context);

  const rows = db.state.analytics;
  const sedonaViews = rows.filter((row) => row.path === "/sunset/sedona" && row.event === "pageview");
  assert.equal(sedonaViews.reduce((sum, row) => sum + row.count, 0), 2);
  assert.ok(sedonaViews.some((row) => row.referrer_host === "google.com" && row.count === 1));
  assert.ok(sedonaViews.some((row) => row.referrer_host === "news.example" && row.count === 1));
  assert.equal(rows.find((row) => row.event === "form_view" && row.form === "hero")?.count, 1);
  assert.equal(rows.find((row) => row.event === "form_focus" && row.form === "hero")?.count, 1);
  assert.equal(rows.find((row) => row.event === "form_submit" && row.form === "hero")?.count, 1);
  assert.equal(rows.find((row) => row.path === "/s/*" && row.event === "pageview")?.referrer_host, "");
  assert.equal(rows.find((row) => row.path === "/other")?.referrer_host, "");
  assert.equal(rows.some((row) => row.event === "click" || row.event === "signup_ok"), false);
  assert.equal(rows.some((row) => row.path === "/faq" || row.path === "/tonight" || row.path === "/"), false);
  assert.equal(rows.some((row) => JSON.stringify(row).includes("secret")), false);

  const again = await worker.fetch(trackRequest({ e: "pageview", p: "/sunset/sedona", f: "", r: "https://news.example/story" }), env, context);
  assert.equal(again.status, 204);
  await flush(context);
  assert.equal(rows.find((row) => row.path === "/sunset/sedona" && row.referrer_host === "news.example").count, 2);

  const denied = await worker.fetch(new Request("https://sunsetping.com/api/stats"), env);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error, "Unauthorized");
  const wrong = await worker.fetch(new Request("https://sunsetping.com/api/stats?days=7", {
    headers: { authorization: "Bearer not-the-secret" },
  }), env);
  assert.equal(wrong.status, 401);
  const stats = await worker.fetch(new Request("https://sunsetping.com/api/stats", {
    headers: { authorization: `Bearer ${SECRET}` },
  }), env);
  assert.equal(stats.status, 200);
  const body = await stats.json();
  assert.equal(body.days, 7);
  assert.equal(body.totals.length, 7);
  assert.ok(body.from <= body.to);
  assert.equal(body.totals.reduce((sum, day) => sum + day.pageview, 0), 5);
  assert.equal(body.totals.reduce((sum, day) => sum + day.form_view, 0), 1);
  const path = body.paths.find((row) => row.path === "/sunset/sedona");
  assert.equal(path.pageviews, 3);
  assert.equal(path.form_views, 1);
  assert.equal(path.submits, 1);
  assert.equal(path.signup_ok, 0);
  assert.equal(path.conversion, 0);
  const form = body.forms.find((row) => row.form === "hero");
  assert.deepEqual({ views: form.views, focuses: form.focuses, submits: form.submits, signup_ok: form.signup_ok }, {
    views: 1, focuses: 1, submits: 1, signup_ok: 0,
  });
  assert.deepEqual(body.referrers.map((row) => row.host), ["news.example", "google.com"]);
  assert.equal(body.referrers[0].pageviews, 2);

  const wide = await worker.fetch(new Request("https://sunsetping.com/api/stats?days=100", {
    headers: { authorization: `Bearer ${SECRET}` },
  }), env);
  const wideBody = await wide.json();
  assert.equal(wideBody.days, 60);
  assert.equal(wideBody.totals.length, 60);
});

test("a D1 failure on /api/t still returns 204", async () => {
  const env = {
    DB: {
      prepare() {
        throw new Error("d1 down");
      },
    },
  };
  const res = await worker.fetch(trackRequest({ e: "pageview", p: "/", f: "", r: "" }), env);
  assert.equal(res.status, 204);
});

test("subscribe stores signup_path and signup_form when they are safe, and still works without them", async () => {
  const db = createDb();
  const env = testEnv(db, { CRON_SECRET: SECRET });
  const forecast = flatForecast([day("2026-10-14T18:42", PERFECT)]);
  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) return Response.json(geocodeBody());
    if (u.includes("api.open-meteo.com")) return Response.json(forecast);
    if (u.includes("zippopotam")) return new Response("missing", { status: 404 });
    throw new Error(u);
  }, async () => {
    const send = (email, extra) => worker.fetch(new Request("https://sunsetping.com/api/subscribe", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": BROWSER,
        referer: "https://photos.example/post",
      },
      body: JSON.stringify({ email, location: "Denver", ...extra }),
    }), env);
    const ok = await send("ada@sunset.test", { signup_path: "/sunset/Sedona?utm=1", signup_form: "Hero" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
    const ada = db.state.subscribers.find((row) => row.email === "ada@sunset.test");
    assert.equal(ada.signup_path, "/sunset/sedona");
    assert.equal(ada.signup_form, "hero");

    const plain = await send("bea@sunset.test", {});
    assert.equal(plain.status, 200);
    const bea = db.state.subscribers.find((row) => row.email === "bea@sunset.test");
    assert.equal(bea.signup_path, null);
    assert.equal(bea.signup_form, null);
    assert.equal(bea.location, "Denver, Colorado");

    const junk = await send("cy@sunset.test", { signup_path: "javascript:alert(1)", signup_form: "x".repeat(40) });
    assert.equal(junk.status, 200);
    const cy = db.state.subscribers.find((row) => row.email === "cy@sunset.test");
    assert.equal(cy.signup_path, null);
    assert.equal(cy.signup_form, null);

    const again = await send("ada@sunset.test", { signup_path: "/faq", signup_form: "footer" });
    assert.equal(again.status, 200);
    assert.equal(ada.signup_path, "/sunset/sedona");
    assert.equal(ada.signup_form, "hero");
  });

  const signupRows = db.state.analytics.filter((row) => row.event === "signup_ok");
  assert.equal(signupRows.find((row) => row.path === "/sunset/sedona" && row.form === "hero")?.count, 1);
  assert.ok(signupRows.some((row) => row.path === "/other" && row.form === ""));
  assert.equal(signupRows.some((row) => row.referrer_host === "photos.example"), true);

  const stats = await worker.fetch(new Request("https://sunsetping.com/api/stats?days=1", {
    headers: { authorization: `Bearer ${SECRET}` },
  }), env);
  const body = await stats.json();
  const path = body.paths.find((row) => row.path === "/sunset/sedona");
  assert.equal(path.signup_ok, 1);
  assert.equal(path.pageviews, 0);
  assert.equal(path.conversion, 0);
  assert.equal(body.forms.find((row) => row.form === "hero").signup_ok, 1);
});

test("the beacon script stays first-party", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /navigator\.sendBeacon\("\/api\/t", body\)/);
  assert.match(app, /keepalive:\s*true/);
  assert.match(app, /navigator\.webdriver/);
  assert.match(app, /visibilityState === "prerender"/);
  assert.match(app, /IntersectionObserver/);
  assert.match(app, /intersectionRatio < 0\.5/);
  assert.match(app, /e: "pageview"/);
  assert.match(app, /e: "form_view"/);
  assert.match(app, /e: "form_focus"/);
  assert.match(app, /e: "form_submit"/);
  assert.match(app, /signup_path/);
  assert.match(app, /signup_form/);
  assert.doesNotMatch(app, /localStorage/);
  assert.doesNotMatch(app, /document\.cookie/);
  assert.doesNotMatch(app, /https?:\/\/(?!sunsetping\.com)/);
  const migration = readFileSync(new URL("../migrations/0006_analytics.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS analytics_daily/);
  assert.match(migration, /PRIMARY KEY\(day, path, event, form, referrer_host\)/);
  assert.match(migration, /signup_path TEXT/);
  assert.match(migration, /signup_form TEXT/);
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  assert.match(schema, /analytics_daily/);
  assert.match(schema, /signup_path TEXT/);
  assert.match(schema, /signup_form TEXT/);
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /npx wrangler@3 d1 migrations apply sunsetping --remote/);
  assert.match(readme, /d1 execute sunsetping --remote --file=migrations\/0006_analytics\.sql/);
  assert.match(readme, /\/api\/stats\?days=7/);
  assert.match(readme, /CRON_SECRET/);
});
