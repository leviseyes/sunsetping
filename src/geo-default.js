import { CITIES, cityBySlug } from "./cities.js";

/** Used when there is no city in the form and no Cloudflare location. */
export const DEFAULT_CITY_SLUG = "los-angeles";

function num(value) {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

function clean(value, max = 60) {
  return String(value ?? "").replace(/[\r\n<>]+/g, " ").trim().slice(0, max);
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearestCity(lat, lon) {
  let best = null;
  let bestKm = Infinity;
  for (const city of CITIES) {
    const km = distanceKm(lat, lon, city.lat, city.lon);
    if (km < bestKm) { best = city; bestKm = km; }
  }
  return best;
}

function catalogPlace(city, source) {
  return { name: `${city.city}, ${city.region}`, latitude: city.lat, longitude: city.lon, timezone: city.timezone, source };
}

/**
 * A place for a signup that sent no city. Order: the visitor's Cloudflare city
 * (name + coordinates + timezone), then the nearest catalog city to the
 * Cloudflare coordinates, then the default city. Always returns a place.
 */
export function defaultPlaceFromCf(cf) {
  const lat = num(cf?.latitude);
  const lon = num(cf?.longitude);
  const hasCoords = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  const city = clean(cf?.city);
  const tz = clean(cf?.timezone, 64);
  if (hasCoords && city && tz) {
    const country = clean(cf?.country, 8).toUpperCase();
    const region = country === "US" ? clean(cf?.region) : (clean(cf?.region) || country);
    const tail = country && country !== "US" ? [region, country].filter(Boolean).join(", ") : region;
    return { name: tail ? `${city}, ${tail}` : city, latitude: lat, longitude: lon, timezone: tz, source: "cf" };
  }
  if (hasCoords) return catalogPlace(nearestCity(lat, lon), "nearest");
  return catalogPlace(cityBySlug(DEFAULT_CITY_SLUG) || CITIES[0], "default");
}

export function changeCityUrl(base, token) {
  return `${String(base).replace(/\/$/, "")}/city?token=${encodeURIComponent(token || "")}`;
}
