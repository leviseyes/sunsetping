"""SunsetPing scoring engine. Uses Open-Meteo (free, no key).

Heuristics (averaged over the hour before -> hour after sunset), starting from 5:
- Mid+high cloud ("canvas", max of mid/high): 20-60% => +3 (sweet spot), 10-20 or 60-80 => +1.5,
  <10 => 0 (clear: pleasant but plain), >80 => -1 (overcast).
- Low cloud (blocks horizon): >60% => -3, 30-60% => -1.5, <15% => +1.
- Precipitation: >0.5mm/h => -3, >0.1 => -1.5 (some clearing showers can be fine but we keep it simple).
- Humidity: <60% => +0.5 (crisp colours), >85% => -1 (haze).
- Visibility: >20km => +0.5, <8km => -1.
Clear sky (canvas<10%) is capped at 6. Clamped to 1-10.
"""
from zoneinfo import ZoneInfo
import requests, datetime as dt
from statistics import mean

def geocode(q):
    r = requests.get("https://geocoding-api.open-meteo.com/v1/search",
                     params={"name": q, "count": 1}, timeout=15).json()
    if not r.get("results"):
        raise ValueError(f"Location not found: {q}")
    x = r["results"][0]
    return x["latitude"], x["longitude"], f'{x["name"]}, {x.get("admin1", x.get("country",""))}'

def score_location(q):
    lat, lon, name = geocode(q)
    d = requests.get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": lat, "longitude": lon, "timezone": "auto", "forecast_days": 1,
        "daily": "sunset",
        "hourly": "cloud_cover_low,cloud_cover_mid,cloud_cover_high,relative_humidity_2m,visibility,precipitation",
    }, timeout=15).json()
    sunset = dt.datetime.fromisoformat(d["daily"]["sunset"][0])
    h = d["hourly"]; times = [dt.datetime.fromisoformat(t) for t in h["time"]]
    idx = [i for i, t in enumerate(times) if abs((t - sunset).total_seconds()) <= 3600] or [min(range(len(times)), key=lambda i: abs(times[i]-sunset))]
    a = lambda k: mean(h[k][i] or 0 for i in idx)
    low, mid, high = a("cloud_cover_low"), a("cloud_cover_mid"), a("cloud_cover_high")
    hum, vis, rain = a("relative_humidity_2m"), a("visibility") / 1000, a("precipitation")
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
    if canvas < 10: s = min(s, 6)  # clear sky: decent, never epic
    score = int(round(max(1, min(10, s))))
    verdict = ("Don't miss it" if score >= 8 else "Worth stepping outside" if score >= 6
               else "Maybe a quick peek" if score >= 4 else "Probably skip tonight")
    reason = why[0][0].upper() + why[0][1:] + (", " + ", ".join(why[1:]) if len(why) > 1 else "") + "."
    return dict(location=name, score=score, verdict=verdict, reason=reason,
                sunset=sunset.strftime("%-I:%M %p"), tz=sunset.replace(tzinfo=ZoneInfo(d["timezone"])).tzname(),
                date=sunset.strftime("%A, %B %-d"),
                details=dict(low=round(low), mid=round(mid), high=round(high), humidity=round(hum), visibility_km=round(vis,1), precip_mm=round(rain,2)))
