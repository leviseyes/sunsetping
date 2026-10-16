import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cardModel, renderScorePng, scoreCardSvg } from "../src/og-card.js";
import worker from "../src/worker.js";
import { PERFECT, createDb, day, flatForecast, geocodeBody, testEnv, withFetch } from "./fixtures.js";

function austinForecast() {
  let calls = 0;
  const impl = async (url) => {
    calls += 1;
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
  return { impl, calls: () => calls };
}

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

function looksLikeImage(bytes, type) {
  if ((type || "").includes("image/png")) {
    assert.equal(bytes[0], 0x89);
    assert.equal(bytes[1], 0x50);
    assert.equal(bytes[2], 0x4e);
    assert.equal(bytes[3], 0x47);
    return;
  }
  const svg = new TextDecoder().decode(bytes);
  assert.match(svg, /<svg/);
  assert.match(svg, /SUNSETPING/);
  assert.match(svg, /Austin/);
  assert.match(svg, />10/);
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
    assert.match(html, /property="og:image" content="https:\/\/sunsetping.com\/og\/sedona.png"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, /name="twitter:image" content="https:\/\/sunsetping.com\/og\/sedona.png"/);
  }
  await withFetch(async () => {
    throw new Error("offline");
  }, async () => {
    const page = await worker.fetch(new Request("https://sunsetping.com/sunset/sedona"), testEnv(createDb()));
    const html = await page.text();
    assert.match(html, /property="og:image" content="https:\/\/sunsetping.com\/og\/sedona.png"/);
    assert.match(html, /property="og:image:type" content="image\/png"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.match(html, /name="twitter:image" content="https:\/\/sunsetping.com\/og\/sedona.png"/);
    assert.match(html, /id="share-score">Share tonight's score/);
    assert.match(html, /data-copy-link>Copy link/);
    assert.match(html, /twitter\.com\/intent\/tweet/);
    assert.match(html, /Post on X/);
    assert.match(html, /navigator\.share/);
  });
});

test("/og/<city>.png is a cached score card and an unknown city is a 404", async () => {
  const missing = await worker.fetch(new Request("https://sunsetping.com/og/not-a-city.png"), testEnv(createDb()));
  assert.equal(missing.status, 404);

  const forecast = austinForecast();
  const cache = memoryCache();
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  try {
    await withFetch(forecast.impl, async () => {
      const first = await worker.fetch(new Request("https://www.sunsetping.com/og/Austin.png?utm=1"), testEnv(createDb()));
      assert.equal(first.status, 200);
      assert.match(first.headers.get("cache-control"), /max-age=1800/);
      assert.match(first.headers.get("cache-control"), /s-maxage=1800/);
      const bytes = new Uint8Array(await first.arrayBuffer());
      looksLikeImage(bytes, first.headers.get("content-type"));
      assert.equal(cache.store.size, 1);
      const calls = forecast.calls();
      const second = await worker.fetch(new Request("https://sunsetping.com/og/austin.png"), testEnv(createDb()));
      assert.equal(second.status, 200);
      assert.equal(forecast.calls(), calls);
      looksLikeImage(new Uint8Array(await second.arrayBuffer()), second.headers.get("content-type"));
    });
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});

test("a score card without a forecast is not cached for half an hour", async () => {
  const cache = memoryCache();
  const previous = globalThis.caches;
  globalThis.caches = { default: cache };
  try {
    await withFetch(async () => {
      throw new Error("offline");
    }, async () => {
      const res = await worker.fetch(new Request("https://sunsetping.com/og/austin.png"), testEnv(createDb()));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("cache-control"), /max-age=60/);
      assert.doesNotMatch(res.headers.get("cache-control") || "", /s-maxage/);
      const type = res.headers.get("content-type") || "";
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (type.includes("svg")) {
        const svg = new TextDecoder().decode(bytes);
        assert.match(svg, /Austin/);
        assert.match(svg, /SUNSETPING/);
      } else {
        assert.equal(bytes[0], 0x89);
      }
      assert.equal(cache.store.size, 0);
    });
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});
