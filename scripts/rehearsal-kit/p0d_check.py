#!/usr/bin/env python3
"""P0d checker (READ-ONLY): reads RUN/a9.log written by a9drive.py and prints the per-message minutesUntil series and a PASS/FAIL table.
  python3 p0d_check.py RUN_DIR [FE_LOG]    (FE_LOG defaults to RUN/fe.log; used only to count stale-beat 409s)
Line numbers refer to script-p0d.txt data lines (1-based): 9 = the hang-out, 10 = the message right after it."""
import json, sys, re
run = sys.argv[1].rstrip("/")
import os
OFFSET = int(os.environ.get("P0D_OFFSET", "0"))  # rows before the first P0d line (casting + premiere "next"s)
rows = []
for l in open(f"{run}/a9.log"):
    l = l.strip()
    if l.startswith("{"):
        try: rows.append(json.loads(l))
        except Exception: pass
starts = [k for k, r in enumerate(rows) if r.get("i") == 1]   # a9drive appends: a rerun begins a new block at i == 1; only the LAST invocation is checked
if starts: rows = rows[starts[-1]:]
pre = rows[:OFFSET]
rows = rows[OFFSET:]
mu = [((r.get("ds") or {}).get("minutesUntil")) for r in rows]
due = [((r.get("ds") or {}).get("due")) for r in rows]
print("i  minutesUntil  delta  due  msg")
prev = ((pre[-1].get("ds") or {}).get("minutesUntil")) if pre else None
deltas = {}
for i, r in enumerate(rows, 1):
    m = mu[i-1]
    d = None if (prev is None or m is None) else prev - m
    deltas[i] = d
    print(f"{i:<2} {str(m):<13} {str(d):<6} {str(due[i-1]):<5} {r.get('msg','')[:45]}")
    if m is not None: prev = m
plain = [1, 2, 3, 4, 5, 6, 8, 12, 13, 14, 15]
def ok(i, want): return deltas.get(i) == want
res = []
res.append(("plain chat = -5 each", all(ok(i, 5) for i in plain), [ (i, deltas.get(i)) for i in plain if deltas.get(i) != 5 ]))   # every expected row, with a real delta: a missing or null one fails
res.append(("move (7) bills once, -5", ok(7, 5), deltas.get(7)))
res.append(("hang-out (9) moved the clock", (deltas.get(9) or 0) >= 5 or mu[8:9] == [0], deltas.get(9)))   # reaching the scheduled event (minutesUntil 0) is also a move
res.append(("message right after hang-out (10) = -5, NOT 0", ok(10, 5) or (mu[8:9] == [0] and mu[9:10] == [0]), deltas.get(10)))   # once line 9 reached the event the clamped minutesUntil cannot fall further
res.append(("deal offer (11) = -5", ok(11, 5), deltas.get(11)))
res.append(("nothing due early", all(d is False for d, m in zip(due, mu) if m is not None and m > 0), None))   # a missing `due` is failed telemetry, not "not due"
fe = f"{run}/fe.log" if len(sys.argv) < 3 else sys.argv[2]
def stale_beat_verdict(log_text, handful=5):
    """The card's rule (ORW-506): zero stale-beat 409s passes; a handful passes only when EVERY one was reconciled by the front end (a 'reconciled a stale-beat 409' line each) - an unreconciled one can lose a reply."""
    reconciled = len(re.findall(r"reconciled a stale-beat 409", log_text))
    total = len(re.findall(r"stale-beat", log_text))
    raw = max(total - reconciled, 0)   # every reconcile line itself mentions stale-beat once
    return (raw == 0 and reconciled <= handful), {"409s": raw, "reconciled": reconciled}
try: ok409, n409 = stale_beat_verdict(open(fe, errors="replace").read())
except Exception: ok409, n409 = False, None
res.append(("no unreconciled stale-beat 409 (a handful reconciled is fine)", ok409, n409))
print()
for name, passed, detail in res:
    print(("PASS" if passed else "FAIL"), "-", name, "" if passed or detail in (None, []) else f"(detail: {detail})")
