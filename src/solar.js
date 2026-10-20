/**
 * Evening sun times from the sunrise equation (Meeus / Wikipedia).
 * Golden hour starts near +6°. Sunset is the upper limb at −0.83°.
 * Blue hour runs from about −4° to −8°.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function julianDayUtc(year, month, day) {
  return Date.UTC(year, month - 1, day) / 86400000 + 2440587.5;
}

/** UTC instant when the sun is at `altitudeDeg` while setting. Null near the poles. */
export function eveningAltitudeUtc({ lat, lon, year, month, day, altitudeDeg }) {
  if (![lat, lon, year, month, day, altitudeDeg].every((n) => Number.isFinite(Number(n)))) return null;
  const Jdate = julianDayUtc(year, month, day);
  const n = Math.round(Jdate - 2451545.0 + 0.0008);
  const Jstar = n - lon / 360;
  const Mdeg = (357.5291 + 0.98560028 * Jstar) % 360;
  const Mr = Mdeg * D2R;
  const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  const lambda = (Mdeg + C + 180 + 102.9372) % 360;
  const lambdaR = lambda * D2R;
  const Jtransit = 2451545.0 + Jstar + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lambdaR);
  const delta = Math.asin(Math.sin(lambdaR) * Math.sin(23.4397 * D2R));
  const latR = lat * D2R;
  const altR = altitudeDeg * D2R;
  const cosOmega = (Math.sin(altR) - Math.sin(latR) * Math.sin(delta)) / (Math.cos(latR) * Math.cos(delta));
  if (!Number.isFinite(cosOmega) || cosOmega < -1 || cosOmega > 1) return null;
  const omega = Math.acos(cosOmega) * R2D;
  const Jset = Jtransit + omega / 360;
  return new Date((Jset - 2440587.5) * 86400000);
}

export function formatZonedClock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || "UTC",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === "hour")?.value || "";
  const minute = parts.find((p) => p.type === "minute")?.value || "00";
  const dayPeriod = (parts.find((p) => p.type === "dayPeriod")?.value || "").toUpperCase();
  if (!hour || !dayPeriod) return "";
  return `${hour}:${minute} ${dayPeriod}`;
}

/**
 * Golden-hour start, sunset, and blue-hour start/end for one spot.
 * `date` is the local civil day, YYYY-MM-DD.
 */
export function eveningLightPlan({ lat, lon, date, timeZone = "UTC" }) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const args = { lat: Number(lat), lon: Number(lon), year, month, day };
  const golden = eveningAltitudeUtc({ ...args, altitudeDeg: 6 });
  const sunset = eveningAltitudeUtc({ ...args, altitudeDeg: -0.833 });
  const blueStart = eveningAltitudeUtc({ ...args, altitudeDeg: -4 });
  const blueEnd = eveningAltitudeUtc({ ...args, altitudeDeg: -8 });
  if (!golden || !sunset || !blueStart || !blueEnd) return null;
  if (!(golden < sunset && sunset < blueStart && blueStart < blueEnd)) return null;
  const clock = (value) => formatZonedClock(value, timeZone);
  const plan = {
    goldenHourStart: clock(golden),
    sunset: clock(sunset),
    blueHourStart: clock(blueStart),
    blueHourEnd: clock(blueEnd),
  };
  if (Object.values(plan).some((value) => !value)) return null;
  return plan;
}
