import json, os
from scoring import score_location
from email_template import render_email
os.makedirs("out", exist_ok=True)
for city in ["Los Angeles", "Seattle", "Miami", "Denver"]:
    r = score_location(city)
    print(f"{r['location']}: Tonight's sunset: {r['score']}/10, {r['verdict'].lower()} at {r['sunset']} {r['tz']}. {r['reason']}  {json.dumps(r['details'])}")
    open(f"out/email_{city.replace(' ','_').lower()}.html", "w").write(render_email(r))
