#!/usr/bin/env bash
# §6 N-5 transport checks. usage: check6.sh [label]  -> appends to $RUN/n5-checks.txt
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
RUN=$(cat $RIG_RUN_PTR); P=$RIG_ENGINE_PORT; F=$RIG_FE_PORT
{ echo "== $1 $(date +%T)"
echo "close-wait: $(ss -tn state close-wait "( dport = :$P or sport = :$P )" | tail -n +2 | wc -l)"
echo "cold status s: $(curl -s -o /dev/null -w '%{time_total}' http://127.0.0.1:$F/api/orwell/status)"
echo "page load s: $(curl -s -o /dev/null -w '%{time_total}' http://127.0.0.1:$F/)"
L=$WT/frontend/data/llm-io.jsonl
[ -f $L ] && python3 - $L <<'P'
import json,sys,collections
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
bad=[r for r in rows if r.get("ok") is False]
print(f"llm rows={len(rows)} failed={len(bad)} ({100*len(bad)/max(1,len(rows)):.1f}%)", dict(collections.Counter(r.get('kind') for r in bad)))
P
echo "host cooled: $(grep -c 'host cooled' $RUN/fe.log)  instant-503: $(grep -c 'unreachable (cooldown active)' $RUN/fe.log)"
python3 - <<'P'
import sqlite3
import os
c=sqlite3.connect('file:'+os.environ['WT']+'/frontend/data/app.db?mode=ro',uri=True)
print("interlude turns:",c.execute("select count(*) from chat_messages where role='assistant' and content like '%technical interlude%'").fetchone()[0])
P
} | tee -a $RUN/n5-checks.txt
