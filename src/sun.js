/**
 * Civil sunset times for a latitude and longitude.
 *
 * Zenith 90.833° (refraction plus the sun's radius), using the standard
 * Julian-cycle sunset formula. Accurate to a couple of minutes. City pages
 * snap the week to tonight's forecast sunset when that snap is within a few
 * minutes, so the table matches the clock already on the page. No weather
 * fetch: the 7-day quality outlook stays a Pro feature.
 */

import { addMinutesToIso, formatClock, formatLongDate, tzAbbrev, wallParts, zonedWallToUtc } from "./scoring.js";

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440587.5;
const J2000 = 2451545;
const OBLIQUITY = 23.4397 * RAD;
const SUNSET_ALTITUDE = -0.833 * RAD;
const SHORT_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Forecast clocks and this formula agree within a couple of minutes. */
const SNAP_MS = 5 * 60 * 1000;

function toDays(date) {
  return date.getTime() / DAY_MS + J1970 - J2000;
}

function fromDays(days) {
  return new Date((days + J2000 - J1970) * DAY_MS);
}

function sunPosition(days) {
  const meanAnomaly = (357.5291 + 0.98560028 * days) * RAD;
  const center = (1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly)) * RAD;
  const ecliptic = meanAnomaly + center + 102.9372 * RAD + Math.PI;
  return {
    meanAnomaly,
    ecliptic,
    declination: Math.asin(Math.sin(ecliptic) * Math.sin(OBLIQUITY)),
  };
}

function sunsetHourAngle(latRad, declination) {
  const cosH = (Math.sin(SUNSET_ALTITUDE) - Math.sin(latRad) * Math.sin(declination)) / (Math.cos(latRad) * Math.cos(declination));
  if (cosH < -1 || cosH > 1) return null;
  return Math.acos(cosH);
}

function julianCycle(days, lonWest) {
  return Math.round(days - 0.0009 - lonWest / (2 * Math.PI));
}

function approxTransit(hourAngle, lonWest, cycle) {
  return 0.0009 + (hourAngle + lonWest) / (2 * Math.PI) + cycle;
}

function solarTransit(approx, meanAnomaly, ecliptic) {
  return approx + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * ecliptic);
}

/** UTC instant of civil sunset on a calendar date. Null inside the polar day or night. */
export function sunsetUtc(year, month, day, lat, lon) {
  const anchor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const lonWest = -lon * RAD;
  const latRad = lat * RAD;
  const cycle = julianCycle(toDays(anchor), lonWest);
  const noon = sunPosition(approxTransit(0, lonWest, cycle));
  let angle = sunsetHourAngle(latRad, noon.declination);
  if (angle == null) return null;
  const nearer = sunPosition(approxTransit(angle, lonWest, cycle));
  angle = sunsetHourAngle(latRad, nearer.declination);
  if (angle == null) return null;
  return fromDays(solarTransit(approxTransit(angle, lonWest, cycle), nearer.meanAnomaly, nearer.ecliptic));
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function shortLabel(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${SHORT_WEEKDAY[weekday]}, ${SHORT_MONTH[m - 1]} ${d}`;
}

function wallIso(utcDate, timeZone) {
  const p = wallParts(utcDate, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function roundMinute(date) {
  return new Date(Math.round(date.getTime() / 60000) * 60000);
}

/**
 * Next `days` civil sunsets in `timeZone`, starting on `startDate` (YYYY-MM-DD).
 * `forecastSunsetIso` is tonight's local sunset from the forecast already fetched
 * for the page. When it is within a few minutes, the whole week shifts to it.
 */
export function weekSunsetTimes({ lat, lon, timeZone, startDate, forecastSunsetIso, days = 7 } = {}) {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  if (!timeZone || !/^\d{4}-\d{2}-\d{2}$/.test(startDate || "")) return null;
  if (!Number.isInteger(days) || days < 1 || days > 14) return null;
  try {
    const instants = [];
    for (let i = 0; i < days; i++) {
      const date = addDays(startDate, i);
      const [y, m, d] = date.split("-").map(Number);
      const utc = sunsetUtc(y, m, d, latitude, longitude);
      if (!utc) return null;
      instants.push(utc);
    }
    if (forecastSunsetIso && String(forecastSunsetIso).slice(0, 10) === startDate) {
      const forecastMs = zonedWallToUtc(forecastSunsetIso, timeZone).getTime();
      const delta = forecastMs - instants[0].getTime();
      if (Number.isFinite(delta) && Math.abs(delta) <= SNAP_MS) {
        for (let i = 0; i < instants.length; i++) instants[i] = new Date(instants[i].getTime() + delta);
      } else if (Number.isFinite(forecastMs)) {
        instants[0] = new Date(forecastMs);
      }
    }
    const rows = [];
    for (let i = 0; i < instants.length; i++) {
      const utc = roundMinute(instants[i]);
      const date = addDays(startDate, i);
      const local = wallIso(utc, timeZone);
      if (local.slice(0, 10) !== date) return null;
      const golden = addMinutesToIso(local, -60);
      rows.push({
        date,
        label: formatLongDate(local),
        shortLabel: shortLabel(date),
        sunset: formatClock(local),
        goldenHourStart: formatClock(golden),
        tz: tzAbbrev(timeZone, utc),
      });
    }
    const sameTz = rows.every((row) => row.tz === rows[0].tz) ? rows[0].tz : null;
    return { timeZone, sameTz, days: rows };
  } catch {
    return null;
  }
}
