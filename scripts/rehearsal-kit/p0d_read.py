#!/usr/bin/env python3
"""P0d helper (READ-ONLY): print the clock facts after each message.
  python3 p0d_read.py BASE_URL [COOKIE_HEADER]        e.g.  python3 p0d_read.py http://<host> 'session=...'
Reads GET /api/orwell/state only. Prints: timeOfDay, daySchedule {next, phase, due, minutesUntil}, beatSeq if present.
The in-game clock is not shown as an hour; the signal is daySchedule.minutesUntil (minutes to the next scheduled event), which should drop by 5 per player message."""
import json, sys, urllib.request
base = sys.argv[1].rstrip("/")
req = urllib.request.Request(base + "/api/orwell/state", headers={"Cookie": sys.argv[2]} if len(sys.argv) > 2 else {})
st = json.load(urllib.request.urlopen(req, timeout=20))
tod = st.get("timeOfDay")   # ORW-768: the browser state is a closed shape; timeOfDay, daySchedule.{next,phase,due,minutesUntil} and beatSeq are on it (the wall test pins them)
ds = st.get("daySchedule") or {}
print(json.dumps({"timeOfDay": tod, "next": ds.get("next"), "phase": ds.get("phase"), "due": ds.get("due"), "minutesUntil": ds.get("minutesUntil"), "beatSeq": st.get("beatSeq")}))
