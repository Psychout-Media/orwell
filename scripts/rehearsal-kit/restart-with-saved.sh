#!/usr/bin/env bash
# usage: restart-with-saved.sh <SAVED_DIR>  - stop the freshly staged engine+FE of the current run, restore a saved engine-data/ and frontend/data/ into it, start both again (same env as stage2.sh).
set -euo pipefail
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
SAVED=$1; RUN=$(cat $RIG_RUN_PTR)
kill $(cat $RUN/engine.pid) $(cat $RUN/fe.pid) 2>/dev/null || true; sleep 2
rm -rf $RUN/engine-data $WT/frontend/data
cp -a $SAVED/engine-data $RUN/engine-data; cp -a $SAVED/fedata $WT/frontend/data
python3 - <<PY
import json
p="$WT/frontend/data/settings.json"
d=json.load(open(p)); d["image_gen_enabled"]=False; json.dump(d,open(p,"w"),indent=2)
PY
( cd $WT; set -a; . /home/ryne/.config/orwell/secrets.env; set +a; unset OPENROUTER_API_KEY
  . deploy/orwell-env-defaults.sh
  eval "$(orwell_optin_env_defaults $RUN/engine-data | sed 's/^/export /')"
  export ORWELL_ENGINE_PORT=$RIG_ENGINE_PORT ORWELL_DATA_DIR=$RUN/engine-data/saves ORWELL_ENGINE_TOKEN=rehlocal ORWELL_ENGINE_ADMIN_TOKEN=rehadminlocal
  export ORWELL_EMBEDDINGS=fastembed ORWELL_EMBED_CACHE=/home/ryne/orwell/.orwell-data/models
  nohup node dist/main.js > $RUN/engine.log 2>&1 & echo $! > $RUN/engine.pid
  cd frontend
  [ "$RIG_SLOT" = 1 ] || export PYTHONDONTWRITEBYTECODE=1
  export AUTH_ENABLED=false ORWELL_ENGINE_MCP_URL=$RIG_ENGINE_URL ORWELL_ENGINE_TOKEN=rehlocal ORWELL_GAME_BUILD=1
  nohup .venv/bin/python3 -m uvicorn app:app --host 127.0.0.1 --port $RIG_FE_PORT > $RUN/fe.log 2>&1 & echo $! > $RUN/fe.pid )
for i in $(seq 1 40); do curl -s -o /dev/null --max-time 10 $RIG_BASE/api/orwell/status && break; sleep 2; done
echo restarted
