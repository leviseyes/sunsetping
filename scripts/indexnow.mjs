#!/usr/bin/env node
/**
 * Submit every URL in the live sitemap to IndexNow.
 *
 *   node scripts/indexnow.mjs
 *   node scripts/indexnow.mjs https://sunsetping.com/sitemap.xml
 *
 * Do not run this from CI. It notifies IndexNow engines (Bing and others)
 * about the public site. Run it by hand after a deploy when the sitemap changes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INDEXNOW = "https://api.indexnow.org/indexnow";
const DEFAULT_SITEMAP = "https://sunsetping.com/sitemap.xml";

export function loadIndexNowKey(publicDir) {
  const names = readdirSync(publicDir).filter((name) => /^[A-Za-z0-9-]{8,128}\.txt$/.test(name));
  for (const name of names) {
    const key = name.slice(0, -4);
    const body = readFileSync(join(publicDir, name), "utf8").trim();
    if (body === key) return { key, filename: name };
  }
  throw new Error(`No IndexNow key file in ${publicDir}. Expected public/<key>.txt whose contents are the key.`);
}

export function urlsFromSitemap(xml) {
  const urls = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  for (const match of xml.matchAll(re)) urls.push(match[1]);
  return urls;
}

export function indexNowPayload(urlList, key) {
  if (!urlList.length) throw new Error("Sitemap had no <loc> URLs.");
  const host = new URL(urlList[0]).host;
  const sameHost = urlList.filter((href) => {
    try {
      return new URL(href).host === host;
    } catch {
      return false;
    }
  });
  if (!sameHost.length) throw new Error("Sitemap URLs did not share a host.");
  return {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList: sameHost,
  };
}

async function main() {
  const sitemapUrl = process.argv[2] || process.env.INDEXNOW_SITEMAP || DEFAULT_SITEMAP;
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
  const { key, filename } = loadIndexNowKey(publicDir);
  const res = await fetch(sitemapUrl, { headers: { accept: "application/xml,text/xml" } });
  if (!res.ok) {
    console.error(`Sitemap ${sitemapUrl} returned HTTP ${res.status}`);
    process.exit(1);
  }
  const payload = indexNowPayload(urlsFromSitemap(await res.text()), key);
  const submitted = await fetch(INDEXNOW, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const text = await submitted.text();
  console.log(`IndexNow ${payload.host}: ${payload.urlList.length} URLs from ${sitemapUrl} using ${filename} → HTTP ${submitted.status}`);
  if (text) console.log(text);
  if (!submitted.ok && submitted.status !== 202) process.exit(1);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
