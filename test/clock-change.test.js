import assert from "node:assert/strict";
import test from "node:test";
import { clockChangeInWeek, clockChangeQa } from "../src/growth.js";
import { weekSunsetTimes, weekSunriseTimes } from "../src/sun.js";

const city = { city: "Denver" };

test("detects fall-back inside the week and builds sunset, golden, sunrise answers", () => {
  const week = weekSunsetTimes({ lat: 39.74, lon: -104.99, timeZone: "America/Denver", startDate: "2026-10-31" });
  const change = clockChangeInWeek(week);
  assert.ok(change);
  assert.equal(change.fallBack, true);
  assert.equal(change.before.tz, "MDT");
  assert.equal(change.after.tz, "MST");
  const sunset = clockChangeQa(city, week, "sunset");
  assert.match(sunset.q, /daylight saving time change the sunset time in Denver/);
  assert.match(sunset.a, /clocks fall back one hour/);
  assert.match(sunset.a, /MDT on Saturday, October 31 and .* MST on Sunday, November 1/);
  assert.match(clockChangeQa(city, week, "golden").a, /golden hour starts/);
  const rise = weekSunriseTimes({ lat: 39.74, lon: -104.99, timeZone: "America/Denver", startDate: "2026-10-31" });
  assert.match(clockChangeQa(city, rise, "sunrise").a, /sunrise is .* MDT .* MST/);
});

test("no clock-change answer when the week has no DST flip or the zone has no DST", () => {
  const plain = weekSunsetTimes({ lat: 39.74, lon: -104.99, timeZone: "America/Denver", startDate: "2026-11-10" });
  assert.equal(clockChangeInWeek(plain), null);
  assert.equal(clockChangeQa(city, plain), null);
  const phoenix = weekSunsetTimes({ lat: 34.87, lon: -111.76, timeZone: "America/Phoenix", startDate: "2026-10-31" });
  assert.equal(clockChangeInWeek(phoenix), null);
  assert.equal(clockChangeInWeek(null), null);
});

test("spring forward is worded correctly", () => {
  const week = weekSunsetTimes({ lat: 39.74, lon: -104.99, timeZone: "America/Denver", startDate: "2027-03-12" });
  const qa = clockChangeQa(city, week);
  assert.ok(qa);
  assert.match(qa.a, /Daylight saving time starts .* spring forward/);
});
