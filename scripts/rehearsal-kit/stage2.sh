#!/usr/bin/env bash
# usage: stage.sh  — checkout current origin/main in the rehearsal worktree, FRESH data dirs, build, start engine+FE+daemon.
# Key handling: DeepSeek key is read from ~/.config/orwell/secrets.env ONLY inside this script's own subshells;
# never echoed/logged/written. OpenRouter key is unset (images are OFF). Fresh FE data => FE seeds the DeepSeek endpoint.
set -euo pipefail
KIT=$(cd "$(dirname "$0")" && pwd); . "$KIT/slot.sh"   # RIG_SLOT (default 1) decides every port and path; see slot.sh
[ "$RIG_SLOT" = 1 ] || { if ss -ltn | grep -qE ":$RIG_ENGINE_PORT\b|:$RIG_FE_PORT\b"; then echo "FATAL: ports $RIG_ENGINE_PORT/$RIG_FE_PORT are busy - another run holds rig slot $RIG_SLOT; not staging" >&2; exit 1; fi; }
git -C /home/ryne/orwell fetch -q origin
rig_ensure_worktree || exit 1
git -C $WT checkout -q -f --detach origin/${STAGE_REF:-main}
MAIN_SHA=$(git -C $WT rev-parse HEAD)
for BR in ${MERGE_BRANCHES:-}; do   # extra origin branches (local-only merges, never pushed)
  git -C $WT fetch -q origin $BR; git -C $WT merge -q --no-edit FETCH_HEAD >/dev/null || { echo "FATAL: merging branch $BR conflicted - aborting the stage (no silent partial stack)" >&2; git -C $WT merge --abort 2>/dev/null; exit 1; }; echo "merged branch $BR $(git -C $WT rev-parse FETCH_HEAD)" >> /tmp/claude-1000/stage-merges.txt
done
if [ -n "${MERGE_PR:-}" ]; then   # local-only merge of an in-flight PR head (never pushed)
  git -C $WT fetch -q origin pull/$MERGE_PR/head && git -C $WT merge -q --no-edit FETCH_HEAD >/dev/null
  PR_SHA=$(git -C $WT rev-parse FETCH_HEAD)
fi
RUN=$RIG_PLAYTEST_DIR/${RIG_RUN_PREFIX}$(date +%Y%m%d-%H%M); mkdir -p $RUN/shots $RUN/engine-data/saves
echo $RUN > $RIG_RUN_PTR
{ echo "main=$MAIN_SHA"; echo "merged-pr=${MERGE_PR:-none} head=${PR_SHA:-none}"; git -C $WT log -1 --format='staged-head=%H' ; } > $RUN/main-sha.txt
rm -rf $WT/frontend/data; (cd $WT && npm run build --silent >/dev/null 2>&1)
for f in t.sh p.sh last.sh daemon.py env.sh check6.sh pr.sh slot.sh; do cp $KIT/$f $RUN/$f; done; rig_write_slot_env $RUN
sed -i "s#\$WT#$WT#g" $RUN/last.sh; chmod +x $RUN/*.sh
( cd $WT; set -a; . /home/ryne/.config/orwell/secrets.env; set +a; unset OPENROUTER_API_KEY
  . deploy/orwell-env-defaults.sh
  eval "$(orwell_optin_env_defaults $RUN/engine-data | sed 's/^/export /')"
  export ORWELL_ENGINE_PORT=$RIG_ENGINE_PORT ORWELL_DATA_DIR=$RUN/engine-data/saves ORWELL_ENGINE_TOKEN=rehlocal ORWELL_ENGINE_ADMIN_TOKEN=rehadminlocal
  export ORWELL_EMBEDDINGS=fastembed ORWELL_EMBED_CACHE=/home/ryne/orwell/.orwell-data/models
  nohup node dist/main.js > $RUN/engine.log 2>&1 & echo $! > $RUN/engine.pid
  cd frontend
  [ "$RIG_SLOT" = 1 ] || export PYTHONDONTWRITEBYTECODE=1   # a shared venv is never written to
  export AUTH_ENABLED=false ORWELL_ENGINE_MCP_URL=$RIG_ENGINE_URL ORWELL_ENGINE_TOKEN=rehlocal ORWELL_GAME_BUILD=1
  nohup .venv/bin/python3 -m uvicorn app:app --host 127.0.0.1 --port $RIG_FE_PORT > $RUN/fe.log 2>&1 & echo $! > $RUN/fe.pid )
for i in $(seq 1 40); do curl -s -o /dev/null --max-time 10 $RIG_BASE/api/orwell/status && break; sleep 2; done
( cd $WT; . deploy/orwell-env-defaults.sh; orwell_optin_env_defaults $RUN/engine-data ) | grep -E '^ORWELL_' | grep -viE 'KEY|TOKEN|SECRET' > $RUN/env.txt
curl -s $RIG_BASE/api/default-chat | python3 -c "import json,sys; d=json.load(sys.stdin); d.pop('api_key',None); print(json.dumps({k:v for k,v in d.items() if 'key' not in k.lower()}))" > $RUN/default-chat.json
curl -s -H "x-orwell-token: rehlocal" $RIG_ENGINE_URL/health | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('flags',d), indent=1))" > $RUN/flags.json 2>/dev/null || true
echo "RUN=$RUN"; cat $RUN/default-chat.json $RUN/main-sha.txt
echo "Next: set image_gen_enabled=false in $WT/frontend/data/settings.json (verify), then: nohup python3 $RUN/daemon.py $RUN > $RUN/daemon.log 2>&1 & echo \$! > $RUN/daemon.pid"
