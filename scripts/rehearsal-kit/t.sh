#!/usr/bin/env bash
# usage: t.sh N 'text' ['{"pick":[0],"text":".."}'] ; writes req, waits for resp N, prints compact result
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
RUN=$(cat $RIG_RUN_PTR); N=$1; T=$2; C=${3:-null}
python3 - "$RUN" "$N" "$T" "$C" <<'P'
import json,sys
run,n,t,c=sys.argv[1:5]
json.dump({"n":int(n),"text":t or None,"card":json.loads(c)},open(f"{run}/req.json","w"))
P
for i in $(seq 1 130); do sleep 3; python3 - "$RUN" "$N" <<'P' && exit 0
import json,sys
try: r=json.load(open(f"{sys.argv[1]}/resp.json"))
except Exception: sys.exit(1)
if r["n"]!=int(sys.argv[2]): sys.exit(1)
s=r["status"]
print(f"[t{r['n']} {r['secs']}s week={s.get('week')} phase={s.get('phase')} hoh={(s.get('hoh') or {}).get('name') if isinstance(s.get('hoh'),dict) else s.get('hoh')} noms={[ (x.get('name') if isinstance(x,dict) else x) for x in s.get('nominees',[])]} pending={s.get('pending') if not isinstance(s.get('pending'),dict) else s['pending'].get('kind')} think={r['thinkSeen']}]")
for b in r["bubbles"]: print("GM>", b[:1800])
if r["card"]: print("CARD>", json.dumps(r["card"]))
P
done; echo TIMEOUT; exit 1
