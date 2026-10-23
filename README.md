# SunsetPing

SunsetPing scores tonight's sunset from 1 to 10 for a city and can email a same-day alert. The site is a Cloudflare Worker (`src/worker.js`) with static files in `public/` and a D1 database bound as `DB`.

City pages (`/sunset/<city>`) include tonight's sunset time, golden hour, and score in the first HTML response. The browser still refreshes that block from `GET /api/score`. A failed or timed-out forecast falls back to the static city page and stays HTTP 200. Rendered city pages are cached for 25 minutes (`Cache-Control: max-age=1500, s-maxage=1500` and the Workers Cache API).

```bash
npm test
npm run dev
```

## First-party counts

Page views and signup steps are counted in D1. The browser sends a same-origin beacon (`POST /api/t`). There are no cookies, no third-party scripts, and no stored IP addresses, email addresses, or user ids.

Apply migration `0006` before those writes succeed. From the repo:

```bash
npx wrangler@3 d1 migrations apply sunsetping --remote
```

The same SQL file can be applied on its own:

```bash
npx wrangler@3 d1 execute sunsetping --remote --file=migrations/0006_analytics.sql
```

`GET /api/stats` uses the newsletter cron secret (`CRON_SECRET`). `days` defaults to 7 and is capped at 60. Dates are America/Los_Angeles.

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" "https://sunsetping.com/api/stats?days=7"
```

The JSON has `totals` (one row per day, with a count for each event), `paths` (pageviews, form views, submits, `signup_ok`, and `conversion` = signup_ok / pageviews), `forms` (views, focuses, submits, and signups by placement), and `referrers` (hosts ranked by pageviews, with embed views alongside).

`/widget` is the install page for the forecast card. `/embed/<city>` is the framed card and is not in the sitemap.

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
