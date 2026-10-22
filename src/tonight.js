import { CITIES } from "./cities.js";
import { fetchForecastMany } from "./openmeteo.js";
import { scoreForecastDay, withZoneAbbrev } from "./scoring.js";

/**
 * Cities per Open-Meteo multi-location call.
 * 65 catalog cities are 3 requests, well under Cloudflare's 50-subrequest limit.
 */
export const TONIGHT_BATCH_SIZE = 25;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function citiesWithCoords(cities = CITIES) {
  return cities.filter((city) => Number.isFinite(city.lat) && Number.isFinite(city.lon) && city.timezone);
}

function scoreCity(city, forecast) {
  if (!forecast) return null;
  const scored = withZoneAbbrev(scoreForecastDay(forecast, 0, {
    location: city.query,
    lat: city.lat,
    lon: city.lon,
    timezone: city.timezone || forecast.timezone || null,
  }));
  if (!scored || !Number.isFinite(Number(scored.score))) return null;
  return {
    rank: 0,
    slug: city.slug,
    city: city.city,
    region: city.region,
    score: scored.score,
    verdict: scored.verdict || "",
    sunset: scored.sunset || "",
    tz: scored.tz || "",
    reason: scored.reason || "",
    goldenHourStart: scored.viewing?.goldenHourStart || "",
    date: scored.date || "",
  };
}

/**
 * Rank catalog cities by tonight's sunset score (forecast day 0, same scorer as /api/score).
 * A failed batch or a failed city is skipped. The returned list may be shorter than the catalog.
 */
export async function rankTonight(fetchImpl = fetch, cities = CITIES) {
  const ready = citiesWithCoords(cities);
  const rows = [];
  for (const batch of chunk(ready, TONIGHT_BATCH_SIZE)) {
    let forecasts = null;
    try {
      forecasts = await fetchForecastMany(
        batch.map((city) => ({ lat: city.lat, lon: city.lon })),
        1,
        fetchImpl,
      );
    } catch (err) {
      console.log(JSON.stringify({ event: "tonight_batch_failed", message: String(err?.message || err) }));
    }
    batch.forEach((city, i) => {
      try {
        const row = scoreCity(city, forecasts?.[i]);
        if (row) rows.push(row);
      } catch (err) {
        console.log(JSON.stringify({ event: "tonight_city_skipped", slug: city.slug, message: String(err?.message || err) }));
      }
    });
  }
  rows.sort((a, b) => b.score - a.score || a.city.localeCompare(b.city) || a.slug.localeCompare(b.slug));
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}
