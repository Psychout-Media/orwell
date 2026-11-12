#!/usr/bin/env bash
# run_mirror_gate.sh — stand up the REAL stack (engine + deterministic fake model + front-end + a
# STARTED game) and run the two-window live-parity gate (mirror_live_parity.mjs) end to end.
#
# Model-independent: uses fake_model_server.mjs (deterministic streamed echo) so the gate needs NO
# API key and is reproducible/CI-fast. Proves the F5 "realtime two-window mirror parity" invariant
# (ADR 0012 §3.3 / refactor-roadmap R0). Exits non-zero when the windows diverge during streaming.
#
#   bash docs/audits/playtest-harness/run_mirror_gate.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HARNESS="$ROOT/docs/audits/playtest-harness"
SANDBOX="${MIRROR_SANDBOX:-$ROOT/.audit-telemetry}"
LOGS="$SANDBOX/logs"; mkdir -p "$LOGS"
ENGINE_PORT=8765; FE_PORT=7000; FAKE_PORT=8011
ADMIN_USER=admin; ADMIN_PW="mirror-gate-pw"   # stable throwaway local admin (never committed)
FE_DATA="$ROOT/frontend/data"                 # the dir the app actually reads (auth.json is hardcoded data/auth.json)
LIVE="${MIRROR_LIVE:-}"                        # MIRROR_LIVE=1 → real OpenRouter model (env ORWELL_TEST_OPENROUTER_KEY); else the deterministic fake
TOOLTURN="${MIRROR_TOOLTURN:-}"                 # MIRROR_TOOLTURN=1 → the tool-rich multi-round settled-parity gate (fake_model_server FAKE_SCRIPT=toolturn)
# Browser location — overridable so the same driver runs under CI (or any box) without editing it.
# Defaults match this sandbox's provisioning (global npm playwright + chromium under /opt/pw-browsers);
# a caller (e.g. the CI job) can point these elsewhere. Leave PW_CHROMIUM empty to let playwright
# auto-resolve the browser from PLAYWRIGHT_BROWSERS_PATH.
# This sandbox pre-provisions chromium at /opt/pw-browsers; a clean CI runner has none there and uses
# playwright's default cache (~/.cache/ms-playwright). Respect a caller override; else use the sandbox
# path ONLY if it exists; else leave unset so playwright auto-resolves its own installed chromium.
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d /opt/pw-browsers ]; then
  export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
fi
# PW_CHROMIUM: explicit binary for chromium.launch({executablePath}). Use a caller override; else the
# sandbox binary if it really exists; else empty → the harness passes undefined and playwright
# auto-resolves the browser it installed in step 0 (below).
if [ -z "${PW_CHROMIUM+x}" ]; then
  if [ -x /opt/pw-browsers/chromium ]; then PW_CHROMIUM=/opt/pw-browsers/chromium; else PW_CHROMIUM=""; fi
fi
export PW_CHROMIUM
export BASE_URL="http://127.0.0.1:$FE_PORT"; export ENGINE_URL="http://127.0.0.1:$ENGINE_PORT"

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done
  pkill -f 'fake_model_server.mjs' 2>/dev/null
  pkill -f "uvicorn app:app --host 127.0.0.1 --port $FE_PORT" 2>/dev/null
  pkill -f 'dist/main.js' 2>/dev/null
  return 0
}
trap cleanup EXIT
# defensive: clear strays from a prior aborted run before we bind the ports
pkill -9 -f 'fake_model_server.mjs' 2>/dev/null; pkill -9 -f "uvicorn app:app --host 127.0.0.1 --port $FE_PORT" 2>/dev/null; pkill -9 -f 'dist/main.js' 2>/dev/null; sleep 1 || true
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
wait_http() { local url="$1" name="$2" n=0; until curl -sf -o /dev/null --max-time 3 "$url"; do n=$((n+1)); [ $n -ge 40 ] && { echo "!! $name never came up ($url)"; return 1; }; sleep 1; done; echo "ok: $name"; }

# 0) playwright resolvable for the harness's `import 'playwright'`. First the JS DRIVER, then (0c) a
#    browser binary. Driver resolution order, most-portable first, so the SAME gate runs on this sandbox
#    AND a clean CI runner: (a) already resolvable? done. (b) a GLOBAL npm playwright to symlink in.
#    (c) neither — install it locally, no-save (the DRIVER download skips the browser; 0c fetches that).
#    package.json intentionally does NOT carry playwright (it's not a runtime/engine dep); this keeps the
#    gate self-contained regardless of host.
PW_VER="${MIRROR_PW_VERSION:-1.56.1}"   # match the chromium provisioned under $PLAYWRIGHT_BROWSERS_PATH
say "0) ensure playwright resolvable for the harness"
mkdir -p "$ROOT/node_modules"
pw_ok() { node -e "import('playwright').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; }
if ! pw_ok; then
  PW_GLOBAL="$(npm root -g 2>/dev/null || true)"
  if [ -n "$PW_GLOBAL" ] && [ -d "$PW_GLOBAL/playwright" ]; then
    ln -sfn "$PW_GLOBAL/playwright" "$ROOT/node_modules/playwright"
    [ -d "$PW_GLOBAL/playwright-core" ] && ln -sfn "$PW_GLOBAL/playwright-core" "$ROOT/node_modules/playwright-core" 2>/dev/null || true
  fi
fi
if ! pw_ok; then
  say "0b) no resolvable playwright (no global) — installing locally (no-save, browser download skipped)"
  ( cd "$ROOT" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save --no-audit --no-fund "playwright@$PW_VER" >"$LOGS/pw-install.log" 2>&1 ) \
    || { echo "!! playwright install failed"; tail -30 "$LOGS/pw-install.log" 2>/dev/null; exit 1; }
fi
node -e "import('playwright').then(()=>console.log('playwright import ok')).catch(e=>{console.error(e);process.exit(1)})" || exit 1

# 0c) a chromium binary to launch. Trust an explicit, existing PW_CHROMIUM (the sandbox path); else the
#     node driver installs ITS OWN revision-matched chromium (into $PLAYWRIGHT_BROWSERS_PATH or the
#     default ~/.cache/ms-playwright cache) and we auto-resolve it. On CI /opt/pw-browsers is absent, so
#     PW_CHROMIUM is empty here and this is the path that runs; it's idempotent (skips if already present).
if [ -n "$PW_CHROMIUM" ] && [ -x "$PW_CHROMIUM" ]; then
  echo "chromium: $PW_CHROMIUM (pre-provisioned)"
else
  say "0c) install the node driver's chromium (auto-resolve)"
  ( cd "$ROOT" && npx --yes playwright install chromium >"$LOGS/pw-browser.log" 2>&1 ) \
    || { echo "!! chromium install failed"; tail -30 "$LOGS/pw-browser.log" 2>/dev/null; exit 1; }
  export PW_CHROMIUM=""   # empty → mirror_live_parity.mjs launches with executablePath undefined (auto-resolve)
fi

# 0d) WebSocket library for the uvicorn upgrade (WS Phase-1 turn-on gate readiness).
#     The WS transport rides FastAPI/Starlette's native WebSocket, which needs a WS library under
#     uvicorn (`uvicorn[standard]` / `websockets` / `wsproto`). The FE `requirements.txt` currently
#     pins PLAIN `uvicorn`, so a clean venv answers the `/api/ws/session` upgrade with a 404 ("No
#     supported WebSocket library detected") — the client then correctly engages its PERMANENT SSE
#     fallback (§6), and the WS-mode leg of this gate can prove nothing. Ensure one is present so WS
#     mode is actually exercised — self-contained, exactly like the playwright bootstrap above. The
#     gate's transport selection is CLIENT-side (the per-leg init script / server-injected flag pinned
#     OFF at the FE boot below); this step only lets the force-ON path connect.
say "0d) ensure a WebSocket library for the uvicorn WS upgrade (FE venv)"
if "$ROOT/frontend/.venv/bin/python" -c "import websockets" >/dev/null 2>&1 \
   || "$ROOT/frontend/.venv/bin/python" -c "import wsproto" >/dev/null 2>&1; then
  echo "ws library: already present"
else
  "$ROOT/frontend/.venv/bin/pip" install --disable-pip-version-check -q websockets >"$LOGS/ws-lib-install.log" 2>&1 \
    && echo "ws library: installed websockets" \
    || { echo "!! websockets install failed — the WS-mode leg will fall back to SSE"; tail -20 "$LOGS/ws-lib-install.log" 2>/dev/null; }
fi

# secrets file the rig reads for admin login (gitignored — see .gitignore add).
printf 'ADMIN_USER=%s\nADMIN_PW=%s\n' "$ADMIN_USER" "$ADMIN_PW" > "$HARNESS/.secrets.env"

# 1) engine
say "1) engine :$ENGINE_PORT"
rm -rf "$SANDBOX/engine-data"; mkdir -p "$SANDBOX/engine-data"
# TUN-10 (deploy-parity, docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md): boot
# with the SAME opt-in behavioral flags the real deploy ships, single-sourced from
# deploy/orwell-env-defaults.sh (never a hand-typed copy that can drift). These flags are all
# calibration-neutral / own-isolated-rng by design (Vault-only content, no relationship-edge fold,
# never touch the seeded comp/vote spine — see the source comments in orwell-env-defaults.sh), so
# turning them on does not threaten this gate's actual invariant: window B mirrors window A's LIVE
# render of the SAME session, not a fixed golden transcript. ORWELL_EMBEDDINGS/_EMBED_CACHE stay
# unset (unchanged — the deterministic-fallback embeddings path this gate has always used) and
# ORWELL_DEAL_DEPTH stays off (pending its live-loop reconciliation, same carve-out as the README).
. "$ROOT/deploy/orwell-env-defaults.sh"
mapfile -t MIRROR_FLAGS < <(orwell_optin_env_defaults "$SANDBOX/engine-data" \
  | grep -Ev '^ORWELL_EMBED(DINGS|_CACHE)=|^ORWELL_DEAL_DEPTH=')
( cd "$ROOT" && exec env ORWELL_ENGINE_PORT=$ENGINE_PORT ORWELL_DATA_DIR="$SANDBOX/engine-data" \
    "${MIRROR_FLAGS[@]}" node dist/main.js >"$LOGS/engine.log" 2>&1 ) & PIDS+=($!)
wait_http "$ENGINE_URL/health" engine || { tail -20 "$LOGS/engine.log"; exit 1; }

# 2) model: the deterministic fake (default) OR a real provider for the live pre-merge pass
if [ -z "$LIVE" ]; then
  # FAKE_TOKEN_DELAY_MS spaces the streamed tokens so A's stream has a DETERMINISTIC wall-clock WIDTH
  # (default 300ms/token → a ~7-9s narration stream). A zero-width burst stream is impossible for a
  # second window to mirror LIVE on a contended host — the F5 flake root cause — so the live-parity
  # gate widens it; it changes PACING only, never the bytes (two windows still receive identical
  # deltas). Override with MIRROR_TOKEN_DELAY_MS. The toolturn/HUD gates don't need it (0 there).
  FAKE_TOKEN_DELAY_MS_DEFAULT=300
  [ -n "$TOOLTURN" ] && FAKE_TOKEN_DELAY_MS_DEFAULT=0
  TOKEN_DELAY="${MIRROR_TOKEN_DELAY_MS:-$FAKE_TOKEN_DELAY_MS_DEFAULT}"
  say "2) fake model :$FAKE_PORT${TOOLTURN:+ (FAKE_SCRIPT=toolturn)} (token-delay ${TOKEN_DELAY}ms)"
  ( FAKE_MODEL_PORT=$FAKE_PORT FAKE_SCRIPT="${TOOLTURN:+toolturn}" FAKE_TOKEN_DELAY_MS="$TOKEN_DELAY" \
      exec node "$HARNESS/fake_model_server.mjs" >"$LOGS/fake.log" 2>&1 ) & PIDS+=($!)
  wait_http "http://127.0.0.1:$FAKE_PORT/v1/models" fake-model || { tail "$LOGS/fake.log"; exit 1; }
else
  say "2) LIVE model (real provider; fake skipped)"
  [ -n "${ORWELL_TEST_OPENROUTER_KEY:-}" ] || { echo "!! MIRROR_LIVE=1 needs ORWELL_TEST_OPENROUTER_KEY in the env (runtime-only)"; exit 1; }
fi

# 3) front-end (auth ON + admin account → endpoints get owner=admin, dodging the owner-NULL 400 trap)
say "3) front-end :$FE_PORT"
# clean slate: a stale admin/session/endpoint from a prior run breaks login or canonical binding.
rm -f "$FE_DATA/auth.json" "$FE_DATA/sessions.json" "$FE_DATA/app.db" "$FE_DATA/settings.json"; mkdir -p "$FE_DATA"
( cd "$ROOT/frontend" && ORWELL_ADMIN_USER=$ADMIN_USER ORWELL_ADMIN_PASSWORD="$ADMIN_PW" \
    ORWELL_SKIP_ADMIN_PROMPT=1 ORWELL_SKIP_RUN_HINT=1 ORWELL_DATA_DIR="$FE_DATA" \
    .venv/bin/python setup.py >"$LOGS/fe-setup.log" 2>&1 )
# Pin the deterministic-floor enrichment policy (like the golden driver): this gate seeds a game
# against a FAKE model that wires no per-class enrichment provider, so the runtime `strict` default
# would (correctly) refuse game creation and the mirror could never start. "Floor for tests, loud
# for production" — the SERVER/product default stays strict; only this automated gate opts to soft.
# ORW-44 S4b2: the game build is WebSocket-only (the ORWELL_WS_TRANSPORT rollback flag is gone), so every leg below runs the WS transport.
# DETERMINISTIC-CONTENT pins for the transport-parity gate: this gate proves two windows RENDER the
# same stream (a transport invariant), so the CONTENT must be deterministic — any per-turn variance
# reads as a false "windows diverge". `ENRICHMENT_POLICY=soft` pins the legacy fold shapes; the
# overseer (0080) + faithfulness (0081) dials default `active` since 2026-07-13, and active mode
# injects nondeterministic mid-stream content (deterministic corrections / a judge reframe) that trips
# the mid-stream snapshot — so pin BOTH off here (the live-harness-nightly covers active-mode parity
# against the real model, where window B always replays window A's actual stream).
( cd "$ROOT/frontend" && ORWELL_GAME_BUILD=1 AUTH_ENABLED=true LOCALHOST_BYPASS=false \
    ORWELL_ENRICHMENT_POLICY=soft \
    ORWELL_OVERSEER_MODE=off ORWELL_FAITHFULNESS_MODE=off \
    ORWELL_ENGINE_MCP_URL="$ENGINE_URL" ORWELL_DATA_DIR="$FE_DATA" \
    exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port $FE_PORT >"$LOGS/fe.log" 2>&1 ) & PIDS+=($!)
wait_http "$BASE_URL/login" frontend || { tail -30 "$LOGS/fe.log"; exit 1; }

# 4) admin login + point the default model at the fake server (or the real provider when LIVE)
if [ -z "$LIVE" ]; then
  EP_NAME=Fake;       EP_BASE="http://127.0.0.1:$FAKE_PORT/v1";   EP_KEY=fake-key;                        EP_MODEL="fake/echo-stream"
else
  EP_NAME=OpenRouter; EP_BASE="https://openrouter.ai/api/v1";     EP_KEY="$ORWELL_TEST_OPENROUTER_KEY";    EP_MODEL="${MIRROR_LIVE_MODEL:-deepseek/deepseek-v4-pro}"
fi
say "4) configure model → $EP_NAME ($EP_MODEL)"
CK="$SANDBOX/cookies.txt"
curl -s -c "$CK" -X POST "$BASE_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PW\"}" -o "$LOGS/login.json"
EP=$(curl -s -b "$CK" -X POST "$BASE_URL/api/model-endpoints" \
  -F "name=$EP_NAME" -F "base_url=$EP_BASE" -F "api_key=$EP_KEY" \
  -F "endpoint_kind=api" -F "model_type=llm" -F "require_models=true" | tee "$LOGS/endpoint.json" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).id||'')}catch(_){console.log('')}})")
echo "endpoint id: ${EP:-<none>}"
curl -s -b "$CK" -X POST "$BASE_URL/api/auth/settings" -H 'Content-Type: application/json' \
  -d "{\"default_endpoint_id\":\"$EP\",\"default_model\":\"$EP_MODEL\",\"default_model_fallbacks\":[]}" -o "$LOGS/settings.json"
curl -s -b "$CK" "$BASE_URL/api/default-chat" -o "$LOGS/default-chat.json"; echo "default-chat: $(cat "$LOGS/default-chat.json")"

# 5) seed a STARTED season (debug door) so canonical keying engages and B mirrors live
say "5) seed started game"
curl -s -b "$CK" -X POST "$BASE_URL/api/orwell/new-game" -H 'Content-Type: application/json' \
  -d '{"playerName":"Avery Quinn","archetype":"social","strategyStyle":"social","seed":51000,"confirm":true}' -o "$LOGS/new-game.json"
echo "new-game: $(head -c 200 "$LOGS/new-game.json")"
curl -s -b "$CK" "$BASE_URL/api/orwell/state" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('started=',j.started,'house=',(j.house||[]).length,'beat=',j.beatSeq)}catch(e){console.log('state parse err')}})"

# 6) run the gate — MIRROR_HUD=1 selects the HUD-parity gate (F5 status/gadget half, 0064 §B/D);
#    MIRROR_TOOLTURN=1 selects the tool-rich multi-round settled-parity gate (H1/H2 — needs the
#    fake model booted with FAKE_SCRIPT=toolturn, step 2 above); default is the chat-render
#    live-parity gate (F5 chat-render half, R2 / ADR 0015).
if [ -n "${MIRROR_HUD:-}" ]; then
  run_hud_parity() {  # $1 = mode label · $2 = MIRROR_WS_TRANSPORT value
    say "6) MIRROR HUD-PARITY GATE (F5 status/gadget half · 0064 §B/D) — $1 transport"
    ( cd "$ROOT" && MIRROR_HUD=1 MIRROR_WS_TRANSPORT="$2" exec node "$HARNESS/mirror_hud_parity.mjs" )
    local rc=$?
    echo ""; echo "[$1] gate exit: $rc (0=PASS · 1=FAIL · 2=precondition unmet)"
    return $rc
  }
  run_hud_parity ws 1; GATE=$?
elif [ -n "$TOOLTURN" ]; then
  # The tool-rich multi-round settled-parity gate, under BOTH transports (#1087 — the WS
  # rebind→ring-replay churn regression failed exactly this gate while the single-round live gate
  # stayed green). WebSocket only (ORW-44 S4b2; formerly: MIRROR_WS_TRANSPORT unset ⇒
  # both legs; =0/1 ⇒ pin one (the CI matrix legs). Each leg gets a DISTINCT turn text: the fake
  # toolturn model's reply derives deterministically from the prompt, so re-sending the same turn on
  # the accumulated session would make the gate's own duplicate-text check flag the two identical,
  # legitimate replies as a dup.
  run_toolturn() {  # $1 = mode label · $2 = MIRROR_WS_TRANSPORT value
    say "6) MIRROR TOOL-TURN (multi-round) PARITY GATE — $1 transport (H1/H2 — dedup/orphan across a tool-rich turn)"
    local turn="${MIRROR_TURN:-(I glance around the room, curious who is nearby — $1 pass.)}"
    ( cd "$ROOT" && MIRROR_WS_TRANSPORT="$2" MIRROR_TURN="$turn" \
        exec node "$HARNESS/mirror_toolturn_parity.mjs" )
    local rc=$?
    echo ""; echo "[$1] gate exit: $rc  (0=PASS no dup/orphan across two windows on a tool-rich turn · 1=FAIL · 2=precondition unmet)"
    return $rc
  }
  run_toolturn ws 1; GATE=$?
else
  # WS Phase-1 turn-on gate (protocol spec §6/§7 case f · ADR 0017 §Phasing): the F5 two-window
  # live-parity invariant must hold under BOTH transports — the WebSocket (the production default
  # since 2026-07-10) AND the permanent SSE/poll fallback (the rollback path — it must stay proven).
  # ORW-44 S4b2: the F5 two-window live-parity invariant runs under the WebSocket transport, the only game-build transport (the SSE/poll fallback legs were removed).
  run_live_parity() {  # $1 = mode label · $2 = MIRROR_WS_TRANSPORT value
    say "6) MIRROR LIVE-PARITY GATE — $1 transport"
    ( cd "$ROOT" && MIRROR_WS_TRANSPORT="$2" exec node "$HARNESS/mirror_live_parity.mjs" )
    local rc=$?
    echo ""; echo "[$1] gate exit: $rc  (0=PASS windows mirror live · 1=FAIL diverge · 2=precondition unmet)"
    return $rc
  }
  run_live_parity ws 1; GATE=$?
fi
exit $GATE
