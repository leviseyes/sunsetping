/**
 * SunsetPing scoring engine. Uses Open-Meteo (free, no key).
 *
 * Heuristics (averaged over the hour before -> hour after sunset), starting from 5.
 * Kept in lockstep with scoring.py (that file's code, not only the comment):
 * - Mid+high cloud ("canvas", max of mid/high): 20-60% => +3 (sweet spot),
 *   10 <= canvas < 20 or 60 < canvas <= 80 => +1.5,
 *   <10 => 0 (clear: pleasant but plain), >80 => -1 (overcast).
 * - Low cloud (blocks horizon): >60% => -3, >30% => -1.5, <15% => +1.
 * - Precipitation: >0.5mm/h => -3, >0.1 => -1.5.
 * - Humidity: <60% => +0.5 (crisp colours), >85% => -1 (haze).
 * - Visibility: >20km => +0.5, <8km => -1.
 * Clear sky (canvas<10%) is capped at 6. Clamped to 1-10.
 * Scores landing on .5 use Python 3 round() (half to even).
 *
 * Viewing window (not in scoring.py; derived from the local sunset clock):
 * golden hour starts 60 minutes before sunset and ends at sunset.
 * Blue hour ends 40 minutes after sunset, a mid-latitude stand-in for the
 * sun sitting about 6° below the horizon.
 */

export const GOLDEN_HOUR_MINUTES = 60;
export const BLUE_HOUR_MINUTES = 40;

/** Python 3 round() for finite numbers: halves go to the nearest even integer. */
export function roundHalfEven(n) {
  const sign = n < 0 ? -1 : 1;
  const x = Math.abs(n);
  const floor = Math.floor(x);
  const frac = x - floor;
  let rounded;
  if (Math.abs(frac - 0.5) < 1e-8) rounded = floor % 2 === 0 ? floor : floor + 1;
  else rounded = Math.round(x);
  return sign * rounded;
}

export function roundTo(n, digits) {
  const p = 10 ** digits;
  return roundHalfEven(n * p) / p;
}

function valueOrZero(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return 0;
  return n;
}

export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

/** Parse a timezone-less ISO local time as a comparable millisecond clock. */
export function parseWall(iso) {
  return Date.parse(`${iso}Z`);
}

export function addMinutesToIso(iso, minutes) {
  const t = parseWall(iso) + minutes * 60000;
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function formatClock(iso) {
  const time = iso.split("T")[1] || "00:00";
  let [h, m] = time.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
}

export function formatLongDate(iso) {
  const [y, m, d] = iso.split("T")[0].split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(dt);
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(dt);
  return `${weekday}, ${month} ${d}`;
}

export function hoursNear(timesMs, targetMs) {
  const idx = [];
  for (let i = 0; i < timesMs.length; i++) {
    if (Math.abs(timesMs[i] - targetMs) <= 3600 * 1000) idx.push(i);
  }
  if (idx.length) return idx;
  let best = 0;
  let bestAbs = Infinity;
  for (let i = 0; i < timesMs.length; i++) {
    const d = Math.abs(timesMs[i] - targetMs);
    if (d < bestAbs) {
      bestAbs = d;
      best = i;
    }
  }
  return timesMs.length ? [best] : [];
}

export function verdictFor(score) {
  if (score >= 8) return "Don't miss it";
  if (score >= 6) return "Worth stepping outside";
  if (score >= 4) return "Maybe a quick peek";
  return "Probably skip tonight";
}

/**
 * Apply the documented adjustments to already-averaged inputs.
 * `visKm` is visibility in kilometres. Returns the unrounded working score too.
 */
export function adjustScore({ low, mid, high, humidity, visKm, precipMm }) {
  const canvas = Math.max(mid, high);
  let s = 5;
  const why = [];
  if (canvas >= 20 && canvas <= 60) {
    s += 3;
    why.push("high, scattered clouds to catch the color");
  } else if ((canvas >= 10 && canvas < 20) || (canvas > 60 && canvas <= 80)) {
    s += 1.5;
    why.push("some clouds up high for color");
  } else if (canvas > 80) {
    s -= 1;
    why.push("a thick cloud deck overhead");
  } else {
    why.push("clear skies, pretty but simple");
  }
  if (low > 60) {
    s -= 3;
    why.push("low clouds blocking the horizon");
  } else if (low > 30) {
    s -= 1.5;
    why.push("some low clouds near the horizon");
  } else if (low < 15) {
    s += 1;
  }
  if (precipMm > 0.5) {
    s -= 3;
    why.push("rain likely");
  } else if (precipMm > 0.1) {
    s -= 1.5;
    why.push("a chance of showers");
  }
  if (humidity < 60) s += 0.5;
  else if (humidity > 85) {
    s -= 1;
    why.push("hazy, humid air");
  }
  if (visKm > 20) s += 0.5;
  else if (visKm < 8) s -= 1;
  if (canvas < 10) s = Math.min(s, 6);
  const score = roundHalfEven(Math.max(1, Math.min(10, s)));
  const reason = why[0][0].toUpperCase() + why[0].slice(1) + (why.length > 1 ? ", " + why.slice(1).join(", ") : "") + ".";
  return { score, working: s, canvas, verdict: verdictFor(score), reason };
}

export function viewingWindow(sunsetIso) {
  const goldenHourStart = addMinutesToIso(sunsetIso, -GOLDEN_HOUR_MINUTES);
  const blueHourEnd = addMinutesToIso(sunsetIso, BLUE_HOUR_MINUTES);
  const sunset = formatClock(sunsetIso);
  return {
    goldenHourStart: formatClock(goldenHourStart),
    goldenHourEnd: sunset,
    sunset,
    blueHourEnd: formatClock(blueHourEnd),
  };
}

function toneLow(low) {
  if (low < 15) return "good";
  if (low <= 30) return "ok";
  if (low <= 60) return "poor";
  return "bad";
}
function labelLow(low) {
  if (low < 15) return "Open horizon";
  if (low <= 30) return "Mostly open";
  if (low <= 60) return "Some horizon cloud";
  return "Horizon blocked";
}
function toneLayer(pct) {
  if (pct > 80) return "bad";
  if (pct >= 20 && pct <= 60) return "great";
  if ((pct >= 10 && pct < 20) || (pct > 60 && pct <= 80)) return "ok";
  return "ok";
}
function labelLayer(pct) {
  if (pct < 10) return "Almost clear";
  if (pct < 20) return "Thin veil";
  if (pct <= 60) return "Scattered canvas";
  if (pct <= 80) return "Heavy layer";
  return "Overcast deck";
}
function toneHumidity(h) {
  if (h < 60) return "good";
  if (h <= 85) return "ok";
  return "bad";
}
function labelHumidity(h) {
  if (h < 60) return "Crisp air";
  if (h <= 85) return "Typical moisture";
  return "Humid haze";
}
function toneVisibility(km) {
  if (km > 20) return "good";
  if (km >= 8) return "ok";
  return "bad";
}
function labelVisibility(km) {
  if (km > 20) return "Crisp and far";
  if (km >= 8) return "Fair";
  return "Hazy";
}

export function colorChance({ low, mid, high, humidity, visKm }) {
  const canvas = Math.max(mid, high);
  let summary = "Moderate color chance";
  if (canvas > 80 || low > 60) summary = "Low color chance";
  else if (canvas < 10) summary = "Soft color, clear sky";
  else if (canvas >= 20 && canvas <= 60 && low <= 30 && humidity <= 85 && visKm >= 8) summary = "High color chance";
  return {
    summary,
    low: { percent: roundHalfEven(low), label: labelLow(low), tone: toneLow(low) },
    mid: { percent: roundHalfEven(mid), label: labelLayer(mid), tone: toneLayer(mid) },
    high: { percent: roundHalfEven(high), label: labelLayer(high), tone: toneLayer(high) },
    humidity: { percent: roundHalfEven(humidity), label: labelHumidity(humidity), tone: toneHumidity(humidity) },
    visibility: { km: roundTo(visKm, 1), label: labelVisibility(visKm), tone: toneVisibility(visKm) },
  };
}

function series(hourly, key) {
  const arr = hourly[key];
  if (!Array.isArray(arr)) {
    const err = new Error("Forecast is missing cloud and humidity data.");
    err.status = 502;
    throw err;
  }
  return arr;
}

/** Score one sunset (or sunrise) timestamp against an Open-Meteo hourly block. */
export function scoreAt(forecast, eventIso, meta) {
  const hourly = forecast.hourly || {};
  const times = series(hourly, "time").map(parseWall);
  const target = parseWall(eventIso);
  const idx = hoursNear(times, target);
  if (!idx.length) {
    const err = new Error("Forecast did not include hours around sunset.");
    err.status = 502;
    throw err;
  }
  const avg = (key, scale = 1) => mean(idx.map((i) => valueOrZero(series(hourly, key)[i]))) / scale;
  const low = avg("cloud_cover_low");
  const mid = avg("cloud_cover_mid");
  const high = avg("cloud_cover_high");
  const humidity = avg("relative_humidity_2m");
  const visKm = avg("visibility", 1000);
  const precipMm = avg("precipitation");
  const adjusted = adjustScore({ low, mid, high, humidity, visKm, precipMm });
  const timezone = forecast.timezone || meta.timezone || null;
  return {
    location: meta.location,
    lat: meta.lat,
    lon: meta.lon,
    score: adjusted.score,
    verdict: adjusted.verdict,
    reason: adjusted.reason,
    sunset: formatClock(eventIso),
    sunsetIso: eventIso,
    tz: meta.tz || null,
    timezone,
    date: formatLongDate(eventIso),
    viewing: viewingWindow(eventIso),
    colorChance: colorChance({ low, mid, high, humidity, visKm }),
    details: {
      low: roundHalfEven(low),
      mid: roundHalfEven(mid),
      high: roundHalfEven(high),
      humidity: roundHalfEven(humidity),
      visibility_km: roundTo(visKm, 1),
      precip_mm: roundTo(precipMm, 2),
    },
  };
}

export function scoreForecastDay(forecast, dayIndex, meta) {
  const sunsetIso = forecast.daily?.sunset?.[dayIndex];
  if (!sunsetIso) return null;
  const scored = scoreAt(forecast, sunsetIso, meta);
  const sunriseIso = forecast.daily?.sunrise?.[dayIndex] || null;
  scored.sunriseIso = sunriseIso;
  if (sunriseIso) {
    const rise = scoreAt(forecast, sunriseIso, meta);
    scored.sunrise = {
      time: rise.sunset,
      iso: sunriseIso,
      score: rise.score,
      verdict: rise.verdict,
      reason: rise.reason,
      date: rise.date,
    };
  } else {
    scored.sunrise = null;
  }
  return scored;
}

const PUBLIC_OMIT = new Set(["sunsetIso", "sunriseIso", "sunrise"]);

export function publicScore(scored) {
  const out = {};
  for (const [k, v] of Object.entries(scored)) {
    if (!PUBLIC_OMIT.has(k)) out[k] = v;
  }
  return out;
}

export function rankScores(scores) {
  return [...scores]
    .filter((s) => s && Number.isFinite(s.score))
    .sort((a, b) => b.score - a.score || String(a.location).localeCompare(String(b.location)))
    .map((s, i) => ({ rank: i + 1, ...publicScore(s) }));
}

/** Wall-clock ISO in an IANA zone → UTC Date. */
export function zonedWallToUtc(iso, timeZone) {
  if (!timeZone) return new Date(parseWall(iso));
  const [date, time] = iso.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm, ss] = (time || "00:00:00").split(":").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0);
  const offsetAt = (ms) => wallAsUtc(new Date(ms), timeZone) - ms;
  let result = utcGuess - offsetAt(utcGuess);
  result = utcGuess - offsetAt(result);
  return new Date(result);
}

export function wallParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
  };
}

function wallAsUtc(date, timeZone) {
  const p = wallParts(date, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
}

export function tzAbbrev(timeZone, utcDate) {
  if (!timeZone) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(utcDate);
    return parts.find((p) => p.type === "timeZoneName")?.value || timeZone;
  } catch {
    return timeZone;
  }
}
