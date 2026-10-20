/**
 * Prebuild public/og/<slug>.png brand cards.
 *
 * Request-time satori + yoga + resvg exceeds the Workers Free plan CPU limit
 * (10ms; outcome exceededCpu / error 1102). The worker serves these files
 * instead of rasterizing. Run after the card layout changes:
 *
 *   node scripts/build-og-cards.mjs
 */
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CITIES } from "../src/cities.js";
import { renderCityBrandPng } from "../src/og-card.js";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "..", "public", "og");

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** Re-deflate IDAT at zlib level 9. resvg's PNG is valid but much larger. */
export function recompressPng(png) {
  const buf = Buffer.from(png);
  if (buf.length < 8 || buf[0] !== 0x89) throw new Error("not a png");
  let offset = 8;
  const chunks = [];
  const idat = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IDAT") idat.push(data);
    else if (type !== "IEND") chunks.push(pngChunk(type, Buffer.from(data)));
    offset += 12 + len;
  }
  if (!idat.length) throw new Error("png missing IDAT");
  const compressed = deflateSync(inflateSync(Buffer.concat(idat)), { level: 9 });
  return Buffer.concat([
    buf.subarray(0, 8),
    ...chunks,
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const modules = {
  yogaWasm: readFileSync(new URL("../node_modules/yoga-wasm-web/dist/yoga.wasm", import.meta.url)),
  resvgWasm: readFileSync(new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url)),
  regular: readFileSync(new URL("../src/fonts/InstrumentSans-Regular.ttf", import.meta.url)),
  semibold: readFileSync(new URL("../src/fonts/InstrumentSans-Semibold.ttf", import.meta.url)),
};

function pngSize(png) {
  if (png.subarray(12, 16).toString("ascii") !== "IHDR") throw new Error("png missing IHDR");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

mkdirSync(outDir, { recursive: true });
let total = 0;
for (const city of CITIES) {
  const png = recompressPng(await renderCityBrandPng(city.city, modules));
  const size = pngSize(png);
  if (size.width !== 1200 || size.height !== 630) {
    throw new Error(`${city.slug} is ${size.width}x${size.height}`);
  }
  const file = join(outDir, `${city.slug}.png`);
  writeFileSync(file, png);
  total += png.length;
  console.log(`${city.slug}.png ${png.length}`);
}
console.log(`wrote ${CITIES.length} cards, ${total} bytes`);
