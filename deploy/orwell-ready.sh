#!/usr/bin/env bash
#
# orwell-ready.sh (B72/ops A8) — READINESS, not just liveness: a green run means a player can
# actually sit down and play. Checks: the engine answers, the front-end answers, and an LLM is
# genuinely configured (the front-end reports at least one usable model).
#
# Exit 0 = ready · 1 = not ready (each failing check is named).
set -uo pipefail

# Pick up ORWELL_PORT/ORWELL_ENGINE_PORT/ORWELL_ENGINE_MCP_URL from data/.env when the caller
# hasn't already exported them (orwell-menu.sh invokes this script bare, with no env sourcing —
# DEPLOY-7: a stock install was reported "NOT READY" for a fully healthy front-end because this
# script's bare fallback (8000) never matched the real default (8080) and nothing read .env).
if [[ -z "${ORWELL_PORT:-}" || -z "${ORWELL_ENGINE_PORT:-}" || -z "${ORWELL_ENGINE_MCP_URL:-}" ]]; then
  ENV_FILE="${ORWELL_HOME:-/opt/orwell}/data/.env"
  [[ -f "$ENV_FILE" ]] || ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data/.env"
  if [[ -f "$ENV_FILE" ]]; then
    env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }
    : "${ORWELL_PORT:=$(env_get ORWELL_PORT)}"
    : "${ORWELL_ENGINE_PORT:=$(env_get ORWELL_ENGINE_PORT)}"
    : "${ORWELL_ENGINE_MCP_URL:=$(env_get ORWELL_ENGINE_MCP_URL)}"
  fi
fi

ENGINE="${ORWELL_ENGINE_MCP_URL:-http://127.0.0.1:${ORWELL_ENGINE_PORT:-8765}}"
FE="http://127.0.0.1:${ORWELL_PORT:-8080}"
# Colour auto-disables off a TTY / under NO_COLOR / TERM=dumb (the verdict words READY / NOT READY
# are never wrapped — only the leading glyph carries colour — so anything reading them stays safe).
if [[ -t 1 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then
  R_BOLD=$'\e[1m'; R_DIM=$'\e[2m'; R_RED=$'\e[31m'; R_GRN=$'\e[32m'; R_OFF=$'\e[0m'
else
  R_BOLD=""; R_DIM=""; R_RED=""; R_GRN=""; R_OFF=""
fi
fails=0
ok()   { echo "  ${R_GRN}✓${R_OFF} $*"; }
bad()  { echo "  ${R_RED}✗${R_OFF} NOT READY — $*"; fails=$((fails + 1)); }

echo "${R_BOLD}orwell readiness${R_OFF} ${R_DIM}— a green run means a player can sit down and play${R_OFF}"

curl -fsS --max-time 5 "${ENGINE%/}/health" >/dev/null 2>&1 \
  && ok "engine reachable (${ENGINE})" || bad "engine unreachable (${ENGINE})"

curl -fsS --max-time 5 "${FE}/openapi.json" >/dev/null 2>&1 \
  && ok "front-end up (${FE})" || bad "front-end down (${FE})"

# LLM configured: the FE's model listing must expose at least one ONLINE model. The route shape
# is {items:[{models:[...], offline}]} (the onboarding gate uses the same probe).
# /api/models is behind the login wall whenever auth is on (the stock install), so an anonymous call
# gets 401 — that is "cannot look", not "no LLM". Credentials, in order: an API token in
# ORWELL_READY_TOKEN (a Bearer "ody_..." token minted under Settings -> API tokens); with
# AUTH_ENABLED=false no credentials are needed. With auth on and no token the check is reported as
# SKIPPED (neither a pass nor a failure) and says how to enable it.
READY_TOKEN="${ORWELL_READY_TOKEN:-}"
auth_args=()
[[ -z "$READY_TOKEN" ]] || auth_args=(-H "Authorization: Bearer ${READY_TOKEN}")
models_body="$(mktemp "${TMPDIR:-/tmp}/orwell-ready-models.XXXXXX")"
trap 'rm -f "$models_body"' EXIT
models_code="$(curl -sS --max-time 10 -o "$models_body" -w '%{http_code}' ${auth_args[@]+"${auth_args[@]}"} "${FE}/api/models" 2>/dev/null || true)"
if [[ "$models_code" == "401" || "$models_code" == "403" ]]; then
  echo "  - LLM check skipped — login required; set ORWELL_READY_TOKEN=<API token> to verify an LLM is online"
elif [[ "$models_code" == "200" ]] && python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
items = d.get('items') or []
usable = any((i.get('models') and not i.get('offline')) for i in items if isinstance(i, dict))
sys.exit(0 if usable else 1)
" "$models_body" 2>/dev/null; then
  ok "an LLM is configured and online"
else
  bad "no usable LLM (configure under Settings -> Services/AI, or set LLM_HOSTS/OPENAI_API_KEY in data/.env)"
fi

echo
if [[ "$fails" -eq 0 ]]; then
  echo "${R_GRN}${R_BOLD}READY${R_OFF}"; exit 0
else
  echo "${R_RED}${R_BOLD}NOT READY (${fails})${R_OFF}"; exit 1
fi
