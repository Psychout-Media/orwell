#!/usr/bin/env bash
# usage: last.sh [N]  — print the last N persisted assistant messages in full (from the FE DB)
. "$(dirname "$(readlink -f "$0")")/slot.sh"
python3 - "${1:-1}" <<'P'
import sqlite3,sys
import os
c=sqlite3.connect('file:'+os.environ['WT']+'/frontend/data/app.db?mode=ro',uri=True)
rows=c.execute("select seq,role,content from chat_messages order by seq desc limit 40").fetchall()
out=[r for r in rows if r[1]=='assistant' and (r[2] or '').strip()][:int(sys.argv[1])]
for s,r,t in reversed(out): print(f"[seq {s}]\n{t}\n")
P
