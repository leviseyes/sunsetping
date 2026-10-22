const GEO = "https://geocoding-api.open-meteo.com/v1/search";
const REVERSE = "https://geocoding-api.open-meteo.com/v1/reverse";
const FORECAST = "https://api.open-meteo.com/v1/forecast";
const HOURLY = "cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility,precipitation";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "SunsetPing/1.0 (sunsetping.com)" },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new HttpError(502, "Sunset forecast is temporarily unavailable.");
  }
  if (!res.ok) {
    const err = new HttpError(502, "Sunset forecast is temporarily unavailable.");
    err.upstream = res.status;
    throw err;
  }
  try {
    return await res.json();
  } catch {
    throw new HttpError(502, "Sunset forecast is temporarily unavailable.");
  }
}

function placeFromGeocode(hit) {
  const region = hit.admin1 || hit.country || "";
  const name = region ? `${hit.name}, ${region}` : hit.name;
  return {
    latitude: hit.latitude,
    longitude: hit.longitude,
    name,
    timezone: hit.timezone || null,
  };
}

async function searchName(q, fetchImpl) {
  const url = `${GEO}?count=1&name=${encodeURIComponent(q)}`;
  const data = await getJson(url, fetchImpl);
  const hit = data.results && data.results[0];
  return hit ? placeFromGeocode(hit) : null;
}

async function geocodeZip(zip, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`https://api.zippopotam.us/us/${zip}`, {
      headers: { accept: "application/json", "user-agent": "SunsetPing/1.0 (sunsetping.com)" },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const p = data?.places?.[0];
  if (!p) return null;
  return {
    latitude: Number(p.latitude),
    longitude: Number(p.longitude),
    name: `${p["place name"]}, ${p.state || p["state abbreviation"] || "US"}`,
    timezone: null,
  };
}

export async function geocode(q, fetchImpl = fetch) {
  const query = String(q || "").trim();
  if (/^\d{5}(?:-\d{4})?$/.test(query)) {
    const zip = await geocodeZip(query.slice(0, 5), fetchImpl);
    if (zip && Number.isFinite(zip.latitude)) return zip;
  }
  const direct = await searchName(query, fetchImpl);
  if (direct) return direct;
  if (query.includes(",")) {
    const first = query.split(",")[0].trim();
    if (first && first !== query) return searchName(first, fetchImpl);
  }
  return null;
}

async function reverseName(lat, lon, fetchImpl) {
  try {
    const data = await getJson(`${REVERSE}?latitude=${lat}&longitude=${lon}&count=1`, fetchImpl);
    const hit = data.results && data.results[0];
    return hit ? placeFromGeocode(hit).name : null;
  } catch {
    return null;
  }
}

export async function resolvePlace(input, fetchImpl = fetch) {
  if (input && input.lat != null && input.lon != null && `${input.lat}` !== "" && `${input.lon}` !== "") {
    const lat = Number(input.lat);
    const lon = Number(input.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new HttpError(400, "Latitude must be between -90 and 90 and longitude between -180 and 180.");
    }
    const named = input.name && String(input.name).trim();
    const name = named || (await reverseName(lat, lon, fetchImpl)) || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
    return { latitude: lat, longitude: lon, name, timezone: null };
  }
  const q = String(input?.q || "").trim();
  if (q.length < 2) throw new HttpError(400, "Enter a city or ZIP code.");
  if (q.length > 100) throw new HttpError(400, "That location name is too long.");
  const place = await geocode(q, fetchImpl);
  if (!place) throw new HttpError(404, `Location not found: ${q}`);
  return place;
}

export function forecastUrl(lat, lon, days) {
  return forecastPointsUrl([{ lat, lon }], days);
}

/** Open-Meteo accepts comma-separated latitude and longitude lists and returns one object per point, in order. */
export function forecastPointsUrl(points, days) {
  const u = new URL(FORECAST);
  u.searchParams.set("latitude", points.map((p) => p.lat).join(","));
  u.searchParams.set("longitude", points.map((p) => p.lon).join(","));
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("forecast_days", String(days));
  u.searchParams.set("daily", "sunset,sunrise");
  u.searchParams.set("hourly", HOURLY);
  return u.toString();
}

function usableForecast(data) {
  return Boolean(data?.daily?.sunset && data?.hourly?.time);
}

export async function fetchForecast(lat, lon, days, fetchImpl = fetch) {
  const data = await getJson(forecastUrl(lat, lon, days), fetchImpl);
  if (!usableForecast(data)) {
    throw new HttpError(502, "Sunset forecast is temporarily unavailable.");
  }
  return data;
}

/**
 * One forecast request for many coordinates.
 * A single location comes back as an object; several come back as an array in request order.
 * Entries that lack sunset or hourly data are null so the caller can skip those cities.
 */
export async function fetchForecastMany(points, days, fetchImpl = fetch) {
  if (!points.length) return [];
  const data = await getJson(forecastPointsUrl(points, days), fetchImpl);
  const list = Array.isArray(data) ? data : [data];
  return points.map((_, i) => (usableForecast(list[i]) ? list[i] : null));
}
