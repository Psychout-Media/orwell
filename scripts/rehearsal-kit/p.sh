#!/usr/bin/env bash
# usage: p.sh N 'text' ['{"pick":[0],"text":".."}']  — quiet turn: engine status line + last persisted assistant msg (700 chars)
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
RUN=$(cat $RIG_RUN_PTR)
$RUN/t.sh "$@" >/dev/null 2>&1
python3 - "$RUN" <<'P'
import json,sys
r=json.load(open(sys.argv[1]+"/resp.json")); s=r["status"]
pend=s.get("pending"); pend=pend.get("kind") if isinstance(pend,dict) else pend
nm=[(x.get('name') if isinstance(x,dict) else x) for x in s.get('nominees',[])]
hoh=(s.get('hoh') or {}); hoh=hoh.get('name') if isinstance(hoh,dict) else hoh
v=s.get('veto') or {}
print(f"[t{r['n']} {r['secs']}s ENGINE week={s.get('week')} phase={s.get('phase')} hoh={hoh} noms={nm} vetoHolder={(v.get('holder') or {}).get('name') if isinstance(v.get('holder'),dict) else v.get('holder')} pending={pend}]")
if r.get("card"): print("CARD>", r["card"]["title"], r["card"]["opts"][:6])
print("CHYRON-DOM>", [c[:90] for c in (r.get("chyron_dom") or [])][-6:], "| ann events:", sum(len(e["n"]) for e in (r.get("ann_events") or [])))
P
$RUN/last.sh 1 | cut -c1-700
