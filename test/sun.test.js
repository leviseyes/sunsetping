import assert from "node:assert/strict";
import test from "node:test";
import { sunsetUtc, weekSunsetTimes } from "../src/sun.js";

test("week sunset times snap to tonight's forecast and stay clock times only", () => {
  const week = weekSunsetTimes({
    lat: 30.27,
    lon: -97.74,
    timeZone: "America/Chicago",
    startDate: "2026-10-15",
    forecastSunsetIso: "2026-10-15T18:59",
  });
  assert.equal(week.timeZone, "America/Chicago");
  assert.equal(week.sameTz, "CDT");
  assert.deepEqual(week.days.map((day) => [day.date, day.shortLabel, day.label, day.sunset, day.goldenHourStart, day.tz]), [
    ["2026-10-15", "Thu, Oct 15", "Thursday, October 15", "6:59 PM", "5:59 PM", "CDT"],
    ["2026-10-16", "Fri, Oct 16", "Friday, October 16", "6:58 PM", "5:58 PM", "CDT"],
    ["2026-10-17", "Sat, Oct 17", "Saturday, October 17", "6:57 PM", "5:57 PM", "CDT"],
    ["2026-10-18", "Sun, Oct 18", "Sunday, October 18", "6:56 PM", "5:56 PM", "CDT"],
    ["2026-10-19", "Mon, Oct 19", "Monday, October 19", "6:55 PM", "5:55 PM", "CDT"],
    ["2026-10-20", "Tue, Oct 20", "Tuesday, October 20", "6:54 PM", "5:54 PM", "CDT"],
    ["2026-10-21", "Wed, Oct 21", "Wednesday, October 21", "6:53 PM", "5:53 PM", "CDT"],
  ]);
  for (const day of week.days) assert.equal("score" in day, false);
});

test("a daylight-saving week uses the civil time on each date", () => {
  const week = weekSunsetTimes({
    lat: 40.710335,
    lon: -73.99308,
    timeZone: "America/New_York",
    startDate: "2026-10-30",
  });
  assert.equal(week.sameTz, null);
  assert.equal(week.days[1].date, "2026-10-31");
  assert.equal(week.days[1].sunset, "5:55 PM");
  assert.equal(week.days[1].tz, "EDT");
  assert.equal(week.days[2].date, "2026-11-01");
  assert.equal(week.days[2].sunset, "4:54 PM");
  assert.equal(week.days[2].goldenHourStart, "3:54 PM");
  assert.equal(week.days[2].tz, "EST");
});

test("civil sunset stays within two minutes of Open-Meteo", () => {
  const samples = [
    { y: 2026, m: 11, d: 1, lat: 40.710335, lon: -73.99308, unix: 1793569937 },
    { y: 2025, m: 12, d: 21, lat: 47.627415, lon: -122.32291, unix: 1766362822 },
    { y: 2025, m: 6, d: 21, lat: 47.627415, lon: -122.32291, unix: 1750565451 },
  ];
  for (const sample of samples) {
    const utc = sunsetUtc(sample.y, sample.m, sample.d, sample.lat, sample.lon);
    const deltaMin = Math.abs(utc.getTime() - sample.unix * 1000) / 60000;
    assert.ok(deltaMin <= 2, `${sample.y}-${sample.m}-${sample.d} off by ${deltaMin} min`);
  }
  const honolulu = weekSunsetTimes({
    lat: 21.335676,
    lon: -157.88991,
    timeZone: "Pacific/Honolulu",
    startDate: "2026-10-20",
    days: 1,
  });
  assert.equal(honolulu.days[0].sunset, "6:04 PM");
  assert.equal(honolulu.days[0].tz, "HST");
  assert.equal(weekSunsetTimes({ lat: 40, lon: -74, timeZone: "Not/AZone", startDate: "2026-10-20" }), null);
  assert.equal(weekSunsetTimes({ lat: Number.NaN, lon: -74, timeZone: "America/New_York", startDate: "2026-10-20" }), null);
});
