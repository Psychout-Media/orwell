#!/usr/bin/env bash
# Stand up a throwaway stack (engine + deterministic fake model + front end with /play + a STARTED game
# bound to a chat session) on free ports, run a command against it, then stop only the processes it
# started. Same stack as docs/audits/playtest-harness/run_mirror_gate.sh.
#
#   bash frontend/web/scripts/run-smoke.sh                 # Playwright smoke
#   bash frontend/web/scripts/run-smoke.sh perf            # classic-vs-new perf comparison
#   bash frontend/web/scripts/run-smoke.sh up              # leave the stack running (prints its URL), for manual poking
#
# Prereqs (CI and the dev box do these first): root `npm ci && npm run build` (dist/main.js),
# frontend/.venv with requirements, `cd frontend/web && npm ci && npm run build`.
# Env: ENGINE_PORT FE_PORT FAKE_PORT (default 18765 17000 18011), FAKE_TOKEN_DELAY_MS, FAKE_REPLY_REPEAT,
#      STACK_DIR (default $ROOT/.audit-telemetry/play-stack), PW_CHROMIUM.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MODE="${1:-smoke}"
ENGINE_PORT="${ENGINE_PORT:-18765}"; FE_PORT="${FE_PORT:-17000}"; FAKE_PORT="${FAKE_PORT:-18011}"
S="${STACK_DIR:-$ROOT/.audit-telemetry/play-stack}"
ADMIN_USER=admin; ADMIN_PW="play-smoke-pw"      # throwaway local account on a throwaway data dir
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; return 0; }
[ "$MODE" = "up" ] || trap cleanup EXIT
say() { printf '\n== %s\n' "$*"; }
wait_http() { local n=0; until curl -sf -o /dev/null --max-time 3 "$1"; do n=$((n+1)); [ $n -ge 60 ] && { echo "!! $2 never came up"; return 1; }; sleep 1; done; }

rm -rf "$S"; mkdir -p "$S/logs" "$S/engine-data" "$S/fe-data"
. "$ROOT/deploy/orwell-env-defaults.sh"
mapfile -t FLAGS < <(orwell_optin_env_defaults "$S/engine-data" | grep -Ev '^ORWELL_EMBED(DINGS|_CACHE)=|^ORWELL_DEAL_DEPTH=')

say "engine :$ENGINE_PORT"
( cd "$ROOT" && exec env ORWELL_ENGINE_PORT=$ENGINE_PORT ORWELL_DATA_DIR="$S/engine-data" "${FLAGS[@]}" node dist/main.js >"$S/logs/engine.log" 2>&1 ) & PIDS+=($!)
wait_http "http://127.0.0.1:$ENGINE_PORT/health" engine || { tail -20 "$S/logs/engine.log"; exit 1; }

say "fake model :$FAKE_PORT"
( FAKE_MODEL_PORT=$FAKE_PORT FAKE_TOKEN_DELAY_MS="${FAKE_TOKEN_DELAY_MS:-60}" FAKE_REPLY_REPEAT="${FAKE_REPLY_REPEAT:-1}" \
    exec node "$ROOT/docs/audits/playtest-harness/fake_model_server.mjs" >"$S/logs/fake.log" 2>&1 ) & PIDS+=($!)
wait_http "http://127.0.0.1:$FAKE_PORT/v1/models" fake-model || exit 1

say "front end :$FE_PORT"
# auth.json/sessions/app.db live in frontend/data regardless of ORWELL_DATA_DIR (same as run_mirror_gate.sh):
# clear them so this throwaway admin account is the one that exists. These are runtime files, never committed.
mkdir -p "$ROOT/frontend/data"; rm -f "$ROOT/frontend/data/auth.json" "$ROOT/frontend/data/sessions.json" "$ROOT/frontend/data/app.db" "$ROOT/frontend/data/settings.json"
( cd "$ROOT/frontend" && ORWELL_ADMIN_USER=$ADMIN_USER ORWELL_ADMIN_PASSWORD="$ADMIN_PW" ORWELL_SKIP_ADMIN_PROMPT=1 \
    ORWELL_SKIP_RUN_HINT=1 ORWELL_DATA_DIR="$S/fe-data" .venv/bin/python setup.py >"$S/logs/setup.log" 2>&1 )
( cd "$ROOT/frontend" && exec env ORWELL_GAME_BUILD=1 AUTH_ENABLED=true LOCALHOST_BYPASS=false ORWELL_ENRICHMENT_POLICY=soft \
    ORWELL_OVERSEER_MODE=off ORWELL_FAITHFULNESS_MODE=off ORWELL_WS_TRANSPORT=0 \
    ORWELL_ENGINE_MCP_URL="http://127.0.0.1:$ENGINE_PORT" ORWELL_DATA_DIR="$S/fe-data" \
    .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "$FE_PORT" >"$S/logs/fe.log" 2>&1 ) & PIDS+=($!)
wait_http "http://127.0.0.1:$FE_PORT/login" frontend || { tail -30 "$S/logs/fe.log"; exit 1; }

say "seed: model endpoint, started game, bound chat session"
B="http://127.0.0.1:$FE_PORT"; CK="$S/cookies.txt"
curl -s -c "$CK" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\"}" -o /dev/null
EID=$(curl -s -b "$CK" -X POST "$B/api/model-endpoints" -F name=Fake -F "base_url=http://127.0.0.1:$FAKE_PORT/v1" -F api_key=fake-key \
  -F endpoint_kind=api -F model_type=llm -F require_models=true | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
[ -n "$EID" ] || { echo "!! no endpoint id"; exit 1; }
curl -s -b "$CK" -X POST "$B/api/auth/settings" -H 'Content-Type: application/json' \
  -d "{\"default_endpoint_id\":\"$EID\",\"default_model\":\"fake/echo-stream\",\"default_model_fallbacks\":[]}" -o /dev/null
curl -s -b "$CK" "$B/api/default-chat" -o /dev/null
curl -s -b "$CK" -X POST "$B/api/orwell/new-game" -H 'Content-Type: application/json' \
  -d '{"playerName":"Avery Quinn","archetype":"social","strategyStyle":"social","seed":51000,"confirm":true}' -o /dev/null
SID=$(curl -s -b "$CK" -X POST "$B/api/session" -F name=Game -F "endpoint_url=http://127.0.0.1:$FAKE_PORT/v1" -F model=fake/echo-stream \
  -F skip_validation=true -F "endpoint_id=$EID" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
[ -n "$SID" ] || { echo "!! no session id"; exit 1; }
curl -s -b "$CK" -X POST "$B/api/orwell/game-session" -H 'Content-Type: application/json' -d "{\"sessionId\":\"$SID\"}" -o /dev/null
echo "session $SID bound; /play at $B/play"

export PLAY_BASE_URL="$B" PLAY_USER="$ADMIN_USER" PLAY_PASSWORD="$ADMIN_PW"
cd "$ROOT/frontend/web"
case "$MODE" in
  up)    echo "stack left running (pids: ${PIDS[*]}); stop with: kill ${PIDS[*]}"; exit 0 ;;
  perf)  node scripts/perf-compare.mjs "${PERF_OUT:-$S/perf.json}" ${PERF_ARGS:-} ;;
  *)     npx playwright test ;;
esac
