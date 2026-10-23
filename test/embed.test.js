import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CITIES, cityBySlug } from "../src/cities.js";
import { embedDocument } from "../src/growth.js";
import worker from "../src/worker.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function memoryCache() {
  const store = new Map();
  return {
    store,
    async match(req) {
      const hit = store.get(req.url);
      if (!hit) return undefined;
      return new Response(hit.body, { status: hit.status, headers: new Headers(hit.headers) });
    },
    async put(req, res) {
      store.set(req.url, { body: await res.text(), status: res.status, headers: [...res.headers] });
    },
  };
}

function forecastFor(timezone = "America/Phoenix") {
  return flatForecast([day("2026-10-14T18:42", PERFECT)], timezone);
}

function ctx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(p); } };
}

function assertSignupForms(html, label) {
  const tags = html.match(/<form\b[^>]*>/gi) || [];
  const signup = tags.filter((tag) => /\bdata-signup\b/.test(tag));
  assert.ok(signup.length > 0, `${label} has a signup form`);
  for (const tag of signup) assert.match(tag, /\bdata-form="[a-z0-9][a-z0-9-]*"/, `${label} ${tag}`);
}

test("the embed card is a small followed link with no script", () => {
  const city = cityBySlug("sedona");
  const html = embedDocument({
    city,
    theme: "dark",
    score: { score: 8, verdict: "Don't miss it", sunset: "6:12 PM", tz: "MST" },
  });
  assert.ok(Buffer.byteLength(html) < 6 * 1024, `embed is ${Buffer.byteLength(html)} bytes`);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /class="dark"/);
  assert.match(html, /<h1>Sedona<\/h1>/);
  assert.match(html, /8<span>\/10<\/span>/);
  assert.match(html, /Don&#39;t miss it/);
  assert.match(html, /Sunset 6:12 PM MST/);
  assert.match(html, /href="https:\/\/sunsetping\.com\/sunset\/sedona\?ref=embed" target="_blank" rel="noopener">Sunset forecast by SunsetPing<\/a>/);
  assert.doesNotMatch(html, /nofollow/);
  const light = embedDocument({ city, score: null });
  assert.doesNotMatch(light, /class="dark"/);
  assert.match(light, /Sunset time will be back shortly/);
});

test("GET /embed/<city> is frameable, noindex, and cached; unknown cities 404", async () => {
  let calls = 0;
  const cache = memoryCache();
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  const db = createDb();
  const env = testEnv(db);
  const context = ctx();
  try {
    await withFetch(async (url) => {
      const u = String(url);
      if (u.includes("geocoding-api") || u.includes("zippopotam")) throw new Error("embed geocoded " + u);
      if (!u.includes("api.open-meteo.com")) throw new Error(u);
      calls += 1;
      return Response.json(forecastFor());
    }, async () => {
      const res = await worker.fetch(new Request("https://sunsetping.com/embed/sedona?utm=1", {
        headers: { "user-agent": BROWSER, referer: "https://blog.example/photos/post" },
      }), env, context);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-frame-options"), null);
      assert.match(res.headers.get("content-security-policy") || "", /frame-ancestors \*/);
      assert.match(res.headers.get("x-robots-tag") || "", /noindex/i);
      assert.equal(res.headers.get("cache-control"), "public, max-age=1500, s-maxage=1500");
      const html = await res.text();
      assert.match(html, /<h1>Sedona<\/h1>/);
      assert.match(html, /10<span>\/10<\/span>/);
      assert.match(html, /Don&#39;t miss it/);
      assert.match(html, /Sunset 6:42 PM/);
      assert.match(html, /href="https:\/\/sunsetping\.com\/sunset\/sedona\?ref=embed" target="_blank" rel="noopener"/);
      assert.match(html, /Sunset forecast by SunsetPing/);
      assert.ok(Buffer.byteLength(html) < 6 * 1024);
      assert.equal(calls, 1);
      assert.equal(cache.store.size, 1);
      const stored = [...cache.store.values()][0];
      stored.headers = stored.headers.map(([name, value]) => (
        name.toLowerCase() === "cache-control" ? [name, "public, max-age=14400"] : [name, value]
      ));

      const again = await worker.fetch(new Request("https://sunsetping.com/embed/Sedona", {
        headers: { "user-agent": BROWSER, referer: "https://blog.example/other" },
      }), env, context);
      assert.equal(again.status, 200);
      assert.equal(again.headers.get("cache-control"), "public, max-age=1500, s-maxage=1500");
      assert.match(await again.text(), /Sedona/);
      assert.equal(calls, 1);

      const dark = await worker.fetch(new Request("https://sunsetping.com/embed/sedona?theme=dark", {
        headers: { "user-agent": BROWSER },
      }), env, context);
      assert.match(await dark.text(), /class="dark"/);
      assert.equal(calls, 2);

      const bot = await worker.fetch(new Request("https://sunsetping.com/embed/maui", {
        headers: { "user-agent": "curl/8.0", referer: "https://bot.example/" },
      }), env, context);
      assert.equal(bot.status, 200);
    });
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
  await Promise.all(context.pending);
  const views = db.state.analytics.filter((row) => row.event === "embed_view");
  assert.equal(views.find((row) => row.path === "/embed/sedona" && row.referrer_host === "blog.example")?.count, 2);
  assert.equal(views.some((row) => row.referrer_host === "bot.example"), false);
  assert.equal(views.some((row) => /post|other|utm/.test(JSON.stringify(row))), false);

  const missing = await worker.fetch(new Request("https://sunsetping.com/embed/not-a-city"), env);
  assert.equal(missing.status, 404);
  const nested = await worker.fetch(new Request("https://sunsetping.com/embed/sedona/extra"), env);
  assert.equal(nested.status, 404);
  const bare = await worker.fetch(new Request("https://sunsetping.com/embed"), env);
  assert.equal(bare.status, 404);
});

test("an embed still renders the city, sunset time, and backlink when the forecast fails", async () => {
  const cache = memoryCache();
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  try {
    await withFetch(async () => new Response("nope", { status: 500 }), async () => {
      const res = await worker.fetch(new Request("https://sunsetping.com/embed/sedona", {
        headers: { "user-agent": BROWSER },
      }), testEnv(createDb()));
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "public, max-age=1500, s-maxage=1500");
      assert.match(res.headers.get("x-robots-tag") || "", /noindex/);
      assert.match(res.headers.get("content-security-policy") || "", /frame-ancestors \*/);
      const html = await res.text();
      assert.match(html, /<h1>Sedona<\/h1>/);
      assert.match(html, /Sunset \d{1,2}:\d{2} (AM|PM)/);
      assert.match(html, /href="https:\/\/sunsetping\.com\/sunset\/sedona\?ref=embed"/);
      assert.doesNotMatch(html, /\/10/);
      assert.equal(cache.store.size, 0);
    });
    const slow = testEnv(createDb(), { CITY_SCORE_TIMEOUT_MS: 40 });
    await withFetch((url, init) => new Promise((resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }), async () => {
      const started = Date.now();
      const res = await worker.fetch(new Request("https://sunsetping.com/embed/maui"), slow);
      assert.equal(res.status, 200);
      assert.ok(Date.now() - started < 3000);
      assert.match(await res.text(), /<h1>Maui<\/h1>/);
    });
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});

test("embed analytics never fail the card", async () => {
  await withFetch(async (url) => {
    if (String(url).includes("api.open-meteo.com")) return Response.json(forecastFor());
    throw new Error(String(url));
  }, async () => {
    const res = await worker.fetch(new Request("https://sunsetping.com/embed/sedona", {
      headers: { "user-agent": BROWSER },
    }), {
      DB: { prepare() { throw new Error("d1 down"); } },
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Sedona/);
  });
});

test("/widget is an indexable install page and /embed is not in the sitemap", async () => {
  const env = testEnv(createDb(), { PUBLIC_BASE_URL: "https://sunsetping.com" });
  const page = await worker.fetch(new Request("https://sunsetping.com/widget"), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Free sunset forecast widget for your photography website/);
  assert.match(html, /rel="canonical" href="https:\/\/sunsetping\.com\/widget"/);
  assert.match(html, /name="description"/);
  assert.match(html, /data-signup data-form="widget"/);
  assert.match(html, /class="site-footer"/);
  assert.match(html, /<iframe id="widget-preview" src="https:\/\/sunsetping\.com\/embed\/sedona" width="320" height="140" style="border:0" loading="lazy" title="Tonight's sunset forecast"><\/iframe>/);
  assert.match(html, /https:\/\/sunsetping\.com\/embed\/sedona/);
  assert.match(html, /theme=dark/);
  for (const city of CITIES) assert.match(html, new RegExp(`value="${city.slug}"`));
  assertSignupForms(html, "widget");

  const austin = await worker.fetch(new Request("https://sunsetping.com/widget?city=austin"), env);
  const austinHtml = await austin.text();
  assert.match(austinHtml, /src="https:\/\/sunsetping\.com\/embed\/austin"/);
  assert.match(austinHtml, /value="austin" selected/);
  const unknown = await worker.fetch(new Request("https://sunsetping.com/widget?city=atlantis"), env);
  assert.match(await unknown.text(), /src="https:\/\/sunsetping\.com\/embed\/sedona"/);

  const sitemap = await worker.fetch(new Request("https://sunsetping.com/sitemap.xml"), env);
  const xml = await sitemap.text();
  assert.match(xml, /<loc>https:\/\/sunsetping\.com\/widget<\/loc>/);
  assert.doesNotMatch(xml, /<loc>[^<]*\/embed\//);
  const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
  assert.match(llms, /https:\/\/sunsetping\.com\/widget/);
  assert.match(llms, /https:\/\/sunsetping\.com\/embed\/<city-slug>/);

  const checkout = await worker.fetch(new Request("https://sunsetping.com/api/checkout?plan=yearly"), env);
  assert.equal(checkout.status, 302);
  assert.match(checkout.headers.get("location") || "", /\/#signup$/);
});

test("every signup form on city pages and static HTML has a placement", async () => {
  const files = [
    ["../index.html", "root index"],
    ["../public/index.html", "home"],
    ["../public/faq.html", "faq"],
    ["../public/photo-of-the-month.html", "photo"],
  ];
  for (const [file, label] of files) assertSignupForms(readFileSync(new URL(file, import.meta.url), "utf8"), label);
  const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const root = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.equal(root, home);
  assert.match(home, /data-form="home-top"/);
  assert.match(home, /data-form="home-mid"/);
  assert.match(home, /data-form="footer"/);
  assert.match(home, /data-form="sticky"/);
  assert.match(readFileSync(new URL("../public/faq.html", import.meta.url), "utf8"), /data-form="faq"/);
  assert.match(readFileSync(new URL("../public/photo-of-the-month.html", import.meta.url), "utf8"), /data-form="photo"/);

  await withFetch(async (url) => {
    const u = String(url);
    if (u.includes("geocoding-api")) return Response.json(geocodeBody({ name: "Austin", admin1: "Texas", timezone: "America/Chicago" }));
    if (u.includes("api.open-meteo.com")) return Response.json(flatForecast([day("2026-10-15T18:59", PERFECT)], "America/Chicago"));
    if (u.includes("zippopotam")) return new Response("missing", { status: 404 });
    throw new Error(u);
  }, async () => {
    const env = testEnv(createDb());
    for (const path of ["/sunset/austin", "/sunset-time/austin", "/golden-hour/austin", "/sunset", "/golden-hour", "/tonight", "/s/Austin"]) {
      const res = await worker.fetch(new Request(`https://sunsetping.com${path}`), env);
      assert.equal(res.status, 200, path);
      assertSignupForms(await res.text(), path);
    }
    const city = await worker.fetch(new Request("https://sunsetping.com/sunset/austin"), env);
    const cityHtml = await city.text();
    assert.match(cityHtml, /data-form="hero"/);
    assert.match(cityHtml, /data-form="inline"/);
    assert.match(cityHtml, /data-form="sticky"/);
    assert.match(cityHtml, /data-form="footer"/);
    assert.match(cityHtml, /href="\/widget\?city=austin">Add this forecast to your site<\/a>/);
    const tonight = await worker.fetch(new Request("https://sunsetping.com/tonight"), env);
    assert.match(await tonight.text(), /<a href="\/widget">Add this forecast to your site<\/a>/);
  });
});
