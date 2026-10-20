import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CITIES } from "../src/cities.js";
import { OG_CARD_CACHE, OG_CARD_VERSION } from "../src/growth.js";
import { recompressPng } from "../scripts/build-og-cards.mjs";
import { cardModel, cityBrandCardNode, renderCityBrandPng, renderScorePng, scoreCardSvg } from "../src/og-card.js";
import worker from "../src/worker.js";
import { createDb, testEnv, withFetch } from "./fixtures.js";

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
      store.set(req.url, { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] });
    },
  };
}

test("the score card names the city, the score, and SunsetPing", () => {
  const model = cardModel({ city: "Austin", score: 10, verdict: "Don't miss it", sunset: "6:59 PM" });
  assert.equal(model.number, "10");
  assert.match(model.line, /Don't miss it/);
  assert.match(model.line, /6:59 PM/);
  const svg = scoreCardSvg({ city: "Austin", score: 10, verdict: "Don't miss it", sunset: "6:59 PM" });
  assert.match(svg, /SUNSETPING/);
  assert.match(svg, /Austin/);
  assert.match(svg, />10/);
  assert.match(scoreCardSvg({ city: "Austin" }), /–/);
});

test("the prebuilt brand card keeps the sunset frame and names the city", () => {
  const node = cityBrandCardNode("Sedona");
  const json = JSON.stringify(node);
  assert.match(json, /SUNSETPING/);
  assert.match(json, /sunsetping\.com/);
  assert.match(json, /Sedona/);
  assert.match(json, /Tonight's sunset score/);
  assert.match(json, /#1c1612/);
  assert.match(json, /#7a3418/);
  assert.match(json, /#e8a15a/);
  assert.match(json, /1200px/);
  assert.match(json, /630px/);
  assert.doesNotMatch(json, /\/10/);
});

test("satori and resvg render a PNG score card", async () => {
  const { readFileSync } = await import("node:fs");
  const png = await renderScorePng({
    city: "Sedona",
    score: 8,
    verdict: "Don't miss it",
    sunset: "5:52 PM",
  }, {
    yogaWasm: readFileSync(new URL("../node_modules/yoga-wasm-web/dist/yoga.wasm", import.meta.url)),
    resvgWasm: readFileSync(new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url)),
    regular: readFileSync(new URL("../src/fonts/InstrumentSans-Regular.ttf", import.meta.url)),
    semibold: readFileSync(new URL("../src/fonts/InstrumentSans-Semibold.ttf", import.meta.url)),
  });
  assert.ok(png.byteLength > 5000);
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
});

test("city pages and the homepage point at the score card", async () => {
  const home = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const root = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const html of [home, root]) {
    assert.match(html, new RegExp(`property="og:image" content="https://sunsetping.com/og/sedona.png\\?v=${OG_CARD_VERSION}"`));
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, new RegExp(`name="twitter:image" content="https://sunsetping.com/og/sedona.png\\?v=${OG_CARD_VERSION}"`));
  }
  await withFetch(async () => {
    throw new Error("offline");
  }, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/sunset/sedona"), testEnv(createDb()));
    const html = await page.text();
    assert.match(html, new RegExp(`property="og:image" content="https://sunsetping.com/og/sedona.png\\?v=${OG_CARD_VERSION}"`));
    assert.match(html, /property="og:image:type" content="image\/png"/);
    const timePage = await worker.fetch(new Request("https://sunsetping.com/sunset-time/sedona"), testEnv(createDb()));
    const timeHtml = await timePage.text();
    assert.match(timeHtml, new RegExp(`property="og:image" content="https://sunsetping.com/og/sedona.png\\?v=${OG_CARD_VERSION}"`));
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, new RegExp(`name="twitter:image" content="https://sunsetping.com/og/sedona.png\\?v=${OG_CARD_VERSION}"`));
    assert.match(html, /id="share-score">Share tonight's score/);
    assert.match(html, /data-copy-link>Copy link/);
    assert.match(html, /twitter\.com\/intent\/tweet/);
    assert.match(html, /Post on X/);
    assert.match(html, /navigator\.share/);
  });
});

function assertPng1200x630(bytes) {
  assert.equal(bytes[0], 0x89);
  assert.equal(bytes[1], 0x50);
  assert.equal(bytes[2], 0x4e);
  assert.equal(bytes[3], 0x47);
  assert.equal(Buffer.from(bytes.subarray(12, 16)).toString("ascii"), "IHDR");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(16), 1200);
  assert.equal(view.getUint32(20), 630);
}

function diskAssets() {
  return {
    async fetch(req) {
      const pathname = new URL(req.url).pathname;
      try {
        const body = readFileSync(new URL(`../public${pathname}`, import.meta.url));
        return new Response(body, { headers: { "content-type": "image/png", etag: '"og"' } });
      } catch {
        return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
      }
    },
  };
}

const ogModules = {
  yogaWasm: readFileSync(new URL("../node_modules/yoga-wasm-web/dist/yoga.wasm", import.meta.url)),
  resvgWasm: readFileSync(new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url)),
  regular: readFileSync(new URL("../src/fonts/InstrumentSans-Regular.ttf", import.meta.url)),
  semibold: readFileSync(new URL("../src/fonts/InstrumentSans-Semibold.ttf", import.meta.url)),
};

test("prebuilt OG cards match the score-free brand render", async () => {
  for (const city of CITIES) {
    const png = recompressPng(await renderCityBrandPng(city.city, ogModules));
    const file = readFileSync(new URL(`../public/og/${city.slug}.png`, import.meta.url));
    assert.equal(Buffer.compare(Buffer.from(png), file), 0, `${city.slug}.png is not the score-free brand card`);
  }
  const saltLake = JSON.stringify(cityBrandCardNode("Salt Lake City"));
  assert.match(saltLake, /Salt Lake City/);
  assert.match(saltLake, /Tonight's sunset score/);
  assert.match(saltLake, /SUNSETPING/);
  assert.match(saltLake, /sunsetping\.com/);
  assert.doesNotMatch(saltLake, /\/10/);
});

test("/og/<city>.png is a prebuilt 1200x630 PNG and an unknown city is a 404", async () => {
  const growth = readFileSync(new URL("../src/growth.js", import.meta.url), "utf8");
  assert.doesNotMatch(growth, /from ["']\.\/og-card\.js["']/);
  assert.doesNotMatch(growth, /from ["']\.\/og-engine\.js["']/);
  assert.doesNotMatch(growth, /renderOgResponse|renderScorePng|renderCityBrandPng/);

  for (const city of CITIES) {
    const file = readFileSync(new URL(`../public/og/${city.slug}.png`, import.meta.url));
    assertPng1200x630(file);
    assert.ok(file.byteLength > 5000, city.slug);
  }
  const sedona = readFileSync(new URL("../public/og/sedona.png", import.meta.url));
  const austinFile = readFileSync(new URL("../public/og/austin.png", import.meta.url));
  assert.notEqual(Buffer.compare(sedona, austinFile), 0);

  const missing = await worker.fetch(new Request("https://sunsetping.com/og/not-a-city.png"), testEnv(createDb()));
  assert.equal(missing.status, 404);

  const cache = memoryCache();
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  try {
    await withFetch(async () => {
      throw new Error("og image must not fetch a forecast");
    }, async () => {
      const env = testEnv(createDb(), { ASSETS: diskAssets() });
      const first = await worker.fetch(new Request("https://www.sunsetping.com/og/Austin.png?utm=1"), env);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("content-type"), "image/png");
      assert.equal(first.headers.get("cache-control"), OG_CARD_CACHE);
      assert.equal(first.headers.get("etag"), '"og"');
      const bytes = new Uint8Array(await first.arrayBuffer());
      assertPng1200x630(bytes);
      assert.equal(Buffer.compare(Buffer.from(bytes), austinFile), 0);
      assert.equal(cache.store.size, 0);

      for (const slug of ["sedona", "zion", "yosemite", "boston"]) {
        const res = await worker.fetch(new Request(`https://sunsetping.com/og/${slug}.png`), env);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get("content-type"), "image/png");
        const body = Buffer.from(await res.arrayBuffer());
        const expected = readFileSync(new URL(`../public/og/${slug}.png`, import.meta.url));
        assert.equal(Buffer.compare(body, expected), 0);
        assertPng1200x630(body);
      }

      const missingAsset = await worker.fetch(
        new Request("https://sunsetping.com/og/sedona.png"),
        testEnv(createDb(), { ASSETS: { async fetch() { return new Response("missing", { status: 404 }); } } }),
      );
      assert.equal(missingAsset.status, 404);
      assert.match(missingAsset.headers.get("content-type") || "", /text\/html/);
    });
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});
