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
res.append(("plain chat = -5 each", all(ok(i, 5) for i in plain if i in deltas and deltas[i] is not None), [ (i, deltas.get(i)) for i in plain if deltas.get(i) != 5 ]))
res.append(("move (7) bills once, -5", ok(7, 5), deltas.get(7)))
res.append(("hang-out (9) moved the clock", (deltas.get(9) or 0) >= 5, deltas.get(9)))
res.append(("message right after hang-out (10) = -5, NOT 0", ok(10, 5), deltas.get(10)))
res.append(("deal offer (11) = -5", ok(11, 5), deltas.get(11)))
res.append(("nothing due early", all(not d for d, m in zip(due, mu) if m is not None and m > 0), None))
fe = f"{run}/fe.log" if len(sys.argv) < 3 else sys.argv[2]
try: n409 = len(re.findall(r"stale-beat", open(fe, errors="replace").read()))
except Exception: n409 = None
res.append(("no stale-beat 409", n409 == 0, n409))
print()
for name, passed, detail in res:
    print(("PASS" if passed else "FAIL"), "-", name, "" if passed or detail in (None, []) else f"(detail: {detail})")
