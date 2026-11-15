#!/usr/bin/env bash
# usage: last.sh [N]  — print the last N persisted assistant messages in full (from the FE DB)
. "$(dirname "$(readlink -f "$0")")/slot.sh"
python3 - "${1:-1}" <<'P'
import sqlite3,sys
import os
c=sqlite3.connect('file:'+os.environ['WT']+'/frontend/data/app.db?mode=ro',uri=True)
n=int(sys.argv[1])
sid=c.execute("select session_id from chat_messages order by seq desc limit 1").fetchone()   # seq is monotonic only within a session: read the newest session's rows
out=c.execute("select seq,role,content from chat_messages where role='assistant' and trim(coalesce(content,''))<>'' and session_id=? order by seq desc limit ?",(sid[0] if sid else None,n)).fetchall()
for s,r,t in reversed(out): print(f"[seq {s}]\n{t}\n")
P
