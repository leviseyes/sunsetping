import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  adjustScore,
  formatClock,
  roundHalfEven,
  scoreAt,
  tzAbbrev,
  viewingWindow,
  zonedWallToUtc,
} from "../src/scoring.js";

test("half-even rounding matches Python 3", () => {
  assert.equal(roundHalfEven(8.5), 8);
  assert.equal(roundHalfEven(7.5), 8);
  assert.equal(roundHalfEven(6.5), 6);
  assert.equal(roundHalfEven(1.5), 2);
  assert.equal(roundHalfEven(9.4), 9);
  assert.notEqual(roundHalfEven(8.5), Math.round(8.5));
});

test("viewing window is golden hour, sunset, and blue hour", () => {
  const window = viewingWindow("2026-10-14T18:42");
  assert.deepEqual(window, {
    goldenHourStart: "5:42 PM",
    goldenHourEnd: "6:42 PM",
    sunset: "6:42 PM",
    blueHourEnd: "7:22 PM",
  });
  const midnight = viewingWindow("2026-10-15T00:10");
  assert.equal(midnight.goldenHourStart, "11:10 PM");
  assert.equal(midnight.sunset, "12:10 AM");
  assert.equal(midnight.blueHourEnd, "12:50 AM");
  assert.equal(formatClock("2026-10-14T00:00"), "12:00 AM");
  assert.equal(formatClock("2026-10-14T12:00"), "12:00 PM");
});

test("Denver wall time converts to UTC and MDT", () => {
  const utc = zonedWallToUtc("2026-10-14T18:42", "America/Denver");
  assert.equal(utc.toISOString(), "2026-10-15T00:42:00.000Z");
  assert.equal(tzAbbrev("America/Denver", utc), "MDT");
});

test("hour window averages only the hour before through the hour after sunset", () => {
  const forecast = {
    timezone: "America/Denver",
    hourly: {
      time: ["2026-10-14T17:00", "2026-10-14T18:00", "2026-10-14T19:00", "2026-10-14T20:00"],
      cloud_cover_low: [0, 10, 30, 100],
      cloud_cover_mid: [40, 40, 40, 40],
      cloud_cover_high: [0, 0, 0, 0],
      relative_humidity_2m: [70, 70, 70, 70],
      visibility: [15000, 15000, 15000, 15000],
      precipitation: [0, 0, 0, 0],
    },
  };
  const scored = scoreAt(forecast, "2026-10-14T18:42", { location: "Denver, Colorado", lat: 39.7, lon: -105 });
  assert.equal(scored.details.low, 20);
  assert.equal(scored.score, 8);
  assert.equal(scored.verdict, "Don't miss it");
});

test("falls back to the closest hour when none sit inside the window", () => {
  const forecast = {
    timezone: "UTC",
    hourly: {
      time: ["2026-10-14T10:00"],
      cloud_cover_low: [70],
      cloud_cover_mid: [90],
      cloud_cover_high: [10],
      relative_humidity_2m: [90],
      visibility: [5000],
      precipitation: [1],
    },
  };
  const scored = scoreAt(forecast, "2026-10-14T18:42", { location: "Nowhere", lat: 0, lon: 0 });
  assert.equal(scored.details.low, 70);
  assert.equal(scored.score, 1);
  assert.equal(scored.verdict, "Probably skip tonight");
});

test("adjustments, reasons, and clear-sky cap match scoring.py", () => {
  const lows = [0, 10, 14, 15, 30, 31, 60, 61];
  const mids = [0, 9, 10, 19, 20, 60, 61, 80, 81];
  const highs = [0, 40];
  const hums = [59, 60, 85, 86];
  const viss = [7, 8, 20, 21];
  const rains = [0, 0.1, 0.11, 0.5, 0.51];
  const cases = [];
  for (const low of lows) for (const mid of mids) for (const high of highs) for (const humidity of hums) for (const visKm of viss) for (const precipMm of rains) {
    cases.push({ low, mid, high, humidity, visKm, precipMm });
  }
  const py = spawnSync("python3", ["-c", PYTHON], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  assert.equal(py.status, 0, py.stderr);
  const expected = JSON.parse(py.stdout);
  assert.equal(expected.length, cases.length);
  for (let i = 0; i < cases.length; i++) {
    const got = adjustScore(cases[i]);
    assert.equal(got.score, expected[i].score, JSON.stringify(cases[i]));
    assert.equal(got.verdict, expected[i].verdict, JSON.stringify(cases[i]));
    assert.equal(got.reason, expected[i].reason, JSON.stringify(cases[i]));
  }
});

test("hourly averaging matches the Python loop, including missing values", () => {
  const fixture = {
    sunset: "2026-10-14T18:42",
    time: ["2026-10-14T17:00", "2026-10-14T18:00", "2026-10-14T19:00", "2026-10-14T20:00"],
    low: [0, 12, null, 90],
    mid: [10, 30, 50, 0],
    high: [5, null, 20, 80],
    humidity: [40, 55, 70, 95],
    visibility: [30000, 22000, 0, 1000],
    precipitation: [0, 0.2, null, 2],
  };
  const py = spawnSync("python3", ["-c", PYTHON_HOURLY], { input: JSON.stringify(fixture), encoding: "utf8" });
  assert.equal(py.status, 0, py.stderr);
  const expected = JSON.parse(py.stdout);
  const scored = scoreAt({
    timezone: "America/Denver",
    hourly: {
      time: fixture.time,
      cloud_cover_low: fixture.low,
      cloud_cover_mid: fixture.mid,
      cloud_cover_high: fixture.high,
      relative_humidity_2m: fixture.humidity,
      visibility: fixture.visibility,
      precipitation: fixture.precipitation,
    },
  }, fixture.sunset, { location: "Denver, Colorado", lat: 1, lon: 2 });
  assert.equal(scored.score, expected.score);
  assert.equal(scored.verdict, expected.verdict);
  assert.equal(scored.reason, expected.reason);
  assert.deepEqual(scored.details, expected.details);
});

const PYTHON = `
import json, sys
from statistics import mean
cases = json.load(sys.stdin)
out = []
for c in cases:
    low, mid, high = c["low"], c["mid"], c["high"]
    hum, vis, rain = c["humidity"], c["visKm"], c["precipMm"]
    canvas = max(mid, high); s = 5.0; why = []
    if 20 <= canvas <= 60: s += 3; why.append("high, scattered clouds to catch the color")
    elif 10 <= canvas < 20 or 60 < canvas <= 80: s += 1.5; why.append("some clouds up high for color")
    elif canvas > 80: s -= 1; why.append("a thick cloud deck overhead")
    else: why.append("clear skies, pretty but simple")
    if low > 60: s -= 3; why.append("low clouds blocking the horizon")
    elif low > 30: s -= 1.5; why.append("some low clouds near the horizon")
    elif low < 15: s += 1
    if rain > 0.5: s -= 3; why.append("rain likely")
    elif rain > 0.1: s -= 1.5; why.append("a chance of showers")
    if hum < 60: s += 0.5
    elif hum > 85: s -= 1; why.append("hazy, humid air")
    if vis > 20: s += 0.5
    elif vis < 8: s -= 1
    if canvas < 10: s = min(s, 6)
    score = int(round(max(1, min(10, s))))
    verdict = ("Don't miss it" if score >= 8 else "Worth stepping outside" if score >= 6 else "Maybe a quick peek" if score >= 4 else "Probably skip tonight")
    reason = why[0][0].upper() + why[0][1:] + (", " + ", ".join(why[1:]) if len(why) > 1 else "") + "."
    out.append({"score": score, "verdict": verdict, "reason": reason})
print(json.dumps(out))
`;

const PYTHON_HOURLY = `
import json, sys, datetime as dt
from statistics import mean
f = json.load(sys.stdin)
sunset = dt.datetime.fromisoformat(f["sunset"])
times = [dt.datetime.fromisoformat(t) for t in f["time"]]
idx = [i for i, t in enumerate(times) if abs((t - sunset).total_seconds()) <= 3600] or [min(range(len(times)), key=lambda i: abs(times[i]-sunset))]
def avg(key, scale=1):
    return mean((f[key][i] or 0) for i in idx) / scale
low, mid, high = avg("low"), avg("mid"), avg("high")
hum, vis, rain = avg("humidity"), avg("visibility", 1000), avg("precipitation")
canvas = max(mid, high); s = 5.0; why = []
if 20 <= canvas <= 60: s += 3; why.append("high, scattered clouds to catch the color")
elif 10 <= canvas < 20 or 60 < canvas <= 80: s += 1.5; why.append("some clouds up high for color")
elif canvas > 80: s -= 1; why.append("a thick cloud deck overhead")
else: why.append("clear skies, pretty but simple")
if low > 60: s -= 3; why.append("low clouds blocking the horizon")
elif low > 30: s -= 1.5; why.append("some low clouds near the horizon")
elif low < 15: s += 1
if rain > 0.5: s -= 3; why.append("rain likely")
elif rain > 0.1: s -= 1.5; why.append("a chance of showers")
if hum < 60: s += 0.5
elif hum > 85: s -= 1; why.append("hazy, humid air")
if vis > 20: s += 0.5
elif vis < 8: s -= 1
if canvas < 10: s = min(s, 6)
score = int(round(max(1, min(10, s))))
verdict = ("Don't miss it" if score >= 8 else "Worth stepping outside" if score >= 6 else "Maybe a quick peek" if score >= 4 else "Probably skip tonight")
reason = why[0][0].upper() + why[0][1:] + (", " + ", ".join(why[1:]) if len(why) > 1 else "") + "."
print(json.dumps({
  "score": score, "verdict": verdict, "reason": reason,
  "details": {"low": round(low), "mid": round(mid), "high": round(high), "humidity": round(hum), "visibility_km": round(vis, 1), "precip_mm": round(rain, 2)}
}))
`;
