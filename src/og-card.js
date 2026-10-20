import { init as initSatori } from "satori/wasm";
import satori from "satori/wasm";
import initYoga from "yoga-wasm-web";
import { Resvg, initWasm } from "@resvg/resvg-wasm";

export const OG_CACHE_SECONDS = 1800;
const WIDTH = 1200;
const HEIGHT = 630;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function cardModel({ city, score, verdict, sunset } = {}) {
  const number = score == null || score === "" ? "–" : String(score);
  const line = [verdict, sunset ? `sunset ${sunset}` : ""].filter(Boolean).join(" · ");
  return { city: String(city || "Tonight"), number, line };
}

function flex(style, children) {
  return { type: "div", props: { style: { display: "flex", ...style }, children } };
}

const CARD_FRAME = {
  width: `${WIDTH}px`,
  height: `${HEIGHT}px`,
  flexDirection: "column",
  justifyContent: "space-between",
  padding: "72px",
  backgroundImage: "linear-gradient(160deg, #1c1612 0%, #7a3418 46%, #e8a15a 100%)",
  color: "#fff",
  fontFamily: "Instrument Sans",
};

export function scoreCardNode(card) {
  const model = cardModel(card);
  return flex(CARD_FRAME, [
    flex({ fontSize: "32px", fontWeight: 600, letterSpacing: "0.22em" }, "SUNSETPING"),
    flex({ flexDirection: "column" }, [
      flex({ fontSize: "72px", fontWeight: 600 }, model.city),
      flex({ alignItems: "flex-end", marginTop: "8px" }, [
        flex({ fontSize: "188px", fontWeight: 600, lineHeight: 0.85 }, model.number),
        flex({ fontSize: "48px", marginBottom: "22px", marginLeft: "10px" }, "/10"),
      ]),
      flex({ fontSize: "36px", marginTop: "18px" }, model.line || "Tonight's sunset"),
    ]),
  ]);
}

/**
 * Static brand card for /og/<slug>.png. Same frame as the live score card.
 * The live number is left off so a prebuilt image never shows a stale score.
 */
export function cityBrandCardNode(city) {
  return flex(CARD_FRAME, [
    flex({ fontSize: "32px", fontWeight: 600, letterSpacing: "0.22em" }, "SUNSETPING"),
    flex({ flexDirection: "column" }, [
      flex({ fontSize: "108px", fontWeight: 600, lineHeight: 1.05 }, String(city || "Tonight")),
      flex({ fontSize: "36px", marginTop: "28px", color: "#fff7ed" }, "Tonight's sunset score"),
    ]),
  ]);
}

/** SVG used when the PNG rasterizer cannot start. The words stay as text. */
export function scoreCardSvg(card) {
  const model = cardModel(card);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#1c1612"/><stop offset="46%" stop-color="#7a3418"/><stop offset="100%" stop-color="#e8a15a"/>
</linearGradient></defs>
<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>
<text x="72" y="120" fill="#fff" font-family="Helvetica, Arial, sans-serif" font-size="32" font-weight="700" letter-spacing="8">SUNSETPING</text>
<text x="72" y="360" fill="#fff" font-family="Georgia, 'Times New Roman', serif" font-size="72">${esc(model.city)}</text>
<text x="72" y="530" fill="#fff" font-family="Georgia, 'Times New Roman', serif" font-size="140" font-weight="700">${esc(model.number)}<tspan font-size="42" font-weight="400">/10</tspan></text>
<text x="72" y="585" fill="#fff7ed" font-family="Helvetica, Arial, sans-serif" font-size="32">${esc(model.line || "Tonight's sunset")}</text>
</svg>`;
}

let engineReady;

async function startEngine(modules) {
  const yoga = await initYoga(modules.yogaWasm);
  initSatori(yoga);
  await initWasm(modules.resvgWasm);
}

async function rasterize(node, modules) {
  if (!engineReady) {
    engineReady = startEngine(modules).catch((err) => {
      engineReady = null;
      throw err;
    });
  }
  await engineReady;
  const svg = await satori(node, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [
      { name: "Instrument Sans", data: modules.regular, weight: 400, style: "normal" },
      { name: "Instrument Sans", data: modules.semibold, weight: 600, style: "normal" },
    ],
  });
  return new Resvg(svg).render().asPng();
}

export async function renderScorePng(card, modules) {
  return rasterize(scoreCardNode(card), modules);
}

export async function renderCityBrandPng(city, modules) {
  return rasterize(cityBrandCardNode(city), modules);
}

export async function renderOgResponse(card, { live = false } = {}) {
  const cacheControl = live
    ? `public, max-age=${OG_CACHE_SECONDS}, s-maxage=${OG_CACHE_SECONDS}`
    : "public, max-age=60";
  try {
    const modules = await import("./og-engine.js");
    const png = await renderScorePng(card, modules);
    return new Response(png, {
      headers: { "content-type": "image/png", "cache-control": cacheControl },
    });
  } catch (err) {
    console.log(JSON.stringify({ event: "og_png_fallback", city: card?.city, message: String(err?.message || err) }));
    return new Response(scoreCardSvg(card), {
      headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": cacheControl },
    });
  }
}
