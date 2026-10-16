# SunsetPing

SunsetPing scores tonight's sunset from 1 to 10 for a city and can email a same-day alert. The site is a Cloudflare Worker (`src/worker.js`) with static files in `public/` and a D1 database bound as `DB`.

City pages (`/sunset/<city>`) include tonight's sunset time, golden hour, and score in the first HTML response. The browser still refreshes that block from `GET /api/score`. A failed or timed-out forecast falls back to the static city page and stays HTTP 200. Rendered city pages are cached for 25 minutes (`Cache-Control: max-age=1500, s-maxage=1500` and the Workers Cache API).

```bash
npm test
npm run dev
```

## IndexNow

After a deploy, submit the sitemap to IndexNow (Bing and other participating engines) by hand:

```bash
node scripts/indexnow.mjs
```

That reads the live sitemap at `https://sunsetping.com/sitemap.xml` and POSTs every URL to `https://api.indexnow.org/indexnow`. The ownership key is the file `public/153dcc22c64f3ab8f33344b87648eff4.txt`, served at `https://sunsetping.com/153dcc22c64f3ab8f33344b87648eff4.txt`.

To submit a different sitemap (for example a preview), pass the URL:

```bash
node scripts/indexnow.mjs https://example.com/sitemap.xml
```

Do not run this from CI, and do not point it at production on every commit. Run it once after you deploy changes that should be recrawled.
