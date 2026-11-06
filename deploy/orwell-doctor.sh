#!/usr/bin/env bash
#
# deploy/orwell-doctor.sh — diagnose and (by default) FIX a deployed Orwell instance.
#
# Inside the container:
#   bash deploy/orwell-doctor.sh             # diagnose; restart whatever is unhealthy; verify
#   bash deploy/orwell-doctor.sh --status    # diagnose only — no restarts
#   bash deploy/orwell-doctor.sh --bounce    # unconditional restart of engine + front-end; verify
#
# From the PROXMOX HOST (same bridge as orwell-update.sh / orwell-factory-reset.sh — it
# locates the orwell LXC by hostname "orwell", override with CTID=<id> / CT_HOSTNAME=<name>,
# and re-runs itself inside, forwarding the flag). Run a LOCAL copy — the repo is private and
# no script fetches branch tips from GitHub (A4/ruling #17):
#   bash /opt/orwell/deploy/orwell-doctor.sh            # or any local checkout's copy
#   bash deploy/orwell-doctor.sh --status
#   CTID=112 bash deploy/orwell-doctor.sh --bounce
#
# For the systemd install (orwell-install.sh): units orwell-engine / orwell-frontend
# (legacy bbai-* detected automatically), app in /opt/orwell or legacy /opt/bbai
# (override: ORWELL_HOME), config in <app>/data/.env. Exit 0 = healthy at the end;
# non-zero = still broken (the script prints the failing unit's recent journal so you
# can see why).
#
# What "healthy" means here, end to end:
#   1. both units active;
#   2. the engine answers /health on its loopback port;
#   3. the engine actually SERVES tools (a getGameState probe answers — "no active game"
#      for a probe user is the expected healthy reply);
#   4. the front-end answers /api/orwell/health and reports engine:true — i.e. the two
#      tiers agree (catches a wrong ORWELL_ENGINE_MCP_URL even when both processes run).
set -uo pipefail

MODE="${1:---fix}"
BRANCH="${BRANCH:-main}"
CT_HOSTNAME_SET="${CT_HOSTNAME:+1}"   # explicit override disables the legacy-name fallback
CT_HOSTNAME="${CT_HOSTNAME:-orwell}"
die() { echo "ERROR: $*" >&2; exit 1; }

# ── Optional whiptail TUI (deploy/orwell-tui.sh) — see orwell-update.sh for the rationale. When
# absent / off a TTY (e.g. the pushed copy run over pct exec) tui_active is false and the flag
# below stands. The lib is searched beside this file first, then the installed checkout. ────────
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -n "${__lib:-}" && -r "$__lib" ]]; then . "$__lib"; break; fi
done
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }

# Interactive mode picker: no flag + a TTY → choose status/fix/bounce. Flags/automation unchanged.
if [[ $# -eq 0 ]] && tui_active; then
  ORWELL_TUI_TITLE="Orwell — doctor"
  wt_menu MODE "Doctor — diagnose & repair:" \
    --fix    "Diagnose, then fix anything unhealthy (default)" \
    --status "Diagnose only — no restarts" \
    --bounce "Force-restart the engine + front-end" \
    || { echo "cancelled."; exit 0; }
fi

# First REAL install found: an explicit override, then the current path, then the legacy one.
# The marker is the git checkout (`<app>/.git`), exactly like orwell-update.sh /
# orwell-factory-reset.sh — a bare directory is NOT an install (a leftover empty /opt/orwell
# on the Proxmox host must not stop the bridge; that bug ran the doctor on the host itself).
find_app() {
  local d
  for d in "${ORWELL_HOME:-}" "${APP_DIR:-}" /opt/orwell /opt/bbai; do
    [[ -n "$d" && -d "$d/.git" ]] && { echo "$d"; return 0; }
  done
  return 1
}

# ── Host → container bridge ─────────────────────────────────────────────────────────────
# On a Proxmox host (pct present, no app dir) locate the orwell LXC and re-run this script
# inside it, forwarding the mode flag. Same pattern as orwell-factory-reset.sh. When run
# from a local file, push THAT file (no network, no branch drift); when run via
# `bash -c "$(curl ...)"` there is no file, so fetch the script from ${BRANCH}.
if command -v pct >/dev/null 2>&1 && ! find_app >/dev/null 2>&1; then
  CTID="${CTID:-$(pct list 2>/dev/null | awk -v n="$CT_HOSTNAME" 'NR>1 && $NF==n {print $1}' || true)}"
  # Legacy-aware: a pre-rename box may still run an LXC literally named "bbai".
  [[ -n "$CTID" || -n "$CT_HOSTNAME_SET" ]] || CTID="$(pct list 2>/dev/null | awk 'NR>1 && $NF=="bbai" {print $1}' || true)"
  [[ -n "$CTID" ]] || die "no orwell LXC found (hostname '${CT_HOSTNAME}' or legacy 'bbai'). Set CTID=<id> and retry."
  [[ "$(printf '%s' "$CTID" | wc -w)" -eq 1 ]] || die "multiple containers named '${CT_HOSTNAME}' (${CTID//$'\n'/ }). Set CTID=<id>."
  [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] || die "LXC ${CTID} is not running — start it first: pct start ${CTID}"

  echo "==> orwell lives in LXC ${CTID}; running the doctor inside the container"
  TMP_DOC="$(mktemp /tmp/orwell-doctor-XXXXXX.sh)"
  if [[ -n "${BASH_SOURCE[0]:-}" && -r "${BASH_SOURCE[0]:-}" ]]; then
    cp "${BASH_SOURCE[0]}" "$TMP_DOC"          # ran from a file → push that exact file
  elif [[ -n "${BASH_EXECUTION_STRING:-}" ]]; then
    # Ran via `bash -c "$(curl ...)"`: there is no file, but bash holds the full script text in
    # BASH_EXECUTION_STRING — push exactly what is running (branch-accurate, no re-fetch; a
    # re-fetch from ${BRANCH} 404s when testing a branch that main doesn't have yet).
    printf '%s\n' "$BASH_EXECUTION_STRING" > "$TMP_DOC"
  else
    # Last resort (e.g. `curl | bash`): run the container's own CHECKED-OUT copy — never a raw
    # branch-tip fetch from GitHub (A4/ruling #17 — closes audit E84; works on a private repo).
    rm -f "$TMP_DOC"
    pct exec "$CTID" -- bash -c "for d in /opt/orwell /opt/bbai; do
        [ -f \"\$d/deploy/orwell-doctor.sh\" ] && exec bash \"\$d/deploy/orwell-doctor.sh\" '$MODE'
      done; echo 'ERROR: no in-container deploy/orwell-doctor.sh found' >&2; exit 1"
    exit $?
  fi
  pct push "$CTID" "$TMP_DOC" /tmp/orwell-doctor.sh || die "pct push into LXC ${CTID} failed"
  rm -f "$TMP_DOC"
  pct exec "$CTID" -- bash /tmp/orwell-doctor.sh "$MODE"
  exit $?
fi

APP_DIR="$(find_app || echo "${ORWELL_HOME:-/opt/orwell}")"
ENV_FILE="${APP_DIR}/data/.env"

fails=0
pass() { echo "  ok   — $*"; }
warn() { echo "  warn — $*"; }
fail() { echo "  FAIL — $*"; fails=$((fails + 1)); }
info() { echo "  info — $*"; }

# ---- service names (legacy-aware): detect by unit-file EXISTENCE (`systemctl cat`), not by
# parsing `list-unit-files` output — the grep form missed legacy bbai-* units in the field and
# the doctor then diagnosed/bounced unit names that don't exist on the box.
unit_exists() { systemctl cat "$1" >/dev/null 2>&1; }
UNITS_MISSING=0
if unit_exists bbai-engine.service; then
  ENGINE_SVC="bbai-engine"; FRONTEND_SVC="bbai-frontend"
elif unit_exists orwell-engine.service; then
  ENGINE_SVC="orwell-engine"; FRONTEND_SVC="orwell-frontend"
else
  ENGINE_SVC="orwell-engine"; FRONTEND_SVC="orwell-frontend"
  UNITS_MISSING=1
fi

# ---- config ---------------------------------------------------------------------------
# Read a key with its legacy BBAI_* fallback (pre-rename installs keep their old .env keys —
# the engine and front-end honor them, so the doctor must too).
env_get() { # ORWELL-key  BBAI-key
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  [[ -z "$v" && -n "${2:-}" ]] && v="$(grep -E "^$2=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  printf '%s' "$v"
}

ENGINE_PORT="8765"; FE_PORT=""; MCP_URL=""
if [[ -f "$ENV_FILE" ]]; then
  pass "config: ${ENV_FILE}"
  ENGINE_PORT="$(env_get ORWELL_ENGINE_PORT BBAI_ENGINE_PORT)"
  FE_PORT="$(env_get ORWELL_PORT BBAI_PORT)"
  MCP_URL="$(env_get ORWELL_ENGINE_MCP_URL BBAI_ENGINE_MCP_URL)"
  # The installer mints ORWELL_ENGINE_TOKEN on every deploy, and the engine then
  # demands it on every tool route (only /health is exempt). The tool probe below
  # MUST present it or a perfectly healthy engine answers 401 — a false FAIL. Fall
  # back to the admin token (admin ⊇ player privilege) when only that is set.
  # SEC-21: keep the RAW per-key values too (before the fallback merge below) so
  # token_security_check can tell "admin unset" / "admin == player" apart from a
  # merely-successful probe.
  ENGINE_TOKEN_RAW="$(env_get ORWELL_ENGINE_TOKEN BBAI_ENGINE_TOKEN)"
  ENGINE_ADMIN_TOKEN_RAW="$(env_get ORWELL_ENGINE_ADMIN_TOKEN BBAI_ENGINE_ADMIN_TOKEN)"
  ENGINE_TOKEN="$ENGINE_TOKEN_RAW"
  [[ -z "$ENGINE_TOKEN" ]] && ENGINE_TOKEN="$ENGINE_ADMIN_TOKEN_RAW"
  ENGINE_PORT="${ENGINE_PORT:-8765}"
else
  warn "config: ${ENV_FILE} not found (using defaults; set ORWELL_HOME if installed elsewhere)"
fi
ENGINE_BASE="http://127.0.0.1:${ENGINE_PORT}"
[[ -n "$FE_PORT" ]] && FE_BASE="http://127.0.0.1:${FE_PORT}" || FE_BASE=""

# The classic silent misconfig: the front-end pointed at a port the engine doesn't listen on.
if [[ -n "$MCP_URL" ]] && ! grep -q ":${ENGINE_PORT}" <<<"$MCP_URL"; then
  fail "ORWELL_ENGINE_MCP_URL (${MCP_URL}) does not match ORWELL_ENGINE_PORT (${ENGINE_PORT}) — fix ${ENV_FILE}"
fi

# ---- probes ---------------------------------------------------------------------------
unit_active() { systemctl is-active --quiet "$1" 2>/dev/null; }

engine_http_ok() { curl -fsS -m 3 "${ENGINE_BASE}/health" 2>/dev/null | grep -q '"ok":true'; }

# DEPLOY-12 (B2): print a one-line summary of the live behavioral-fidelity flags off /health's `flags`
# block (grep/sed only — no jq dependency). Prints an `info` line naming the ON layers, or "(engine
# predates the flags field)" on an older build. Never fails the run — diagnostics only.
behavioral_flags_line() {
  local body on
  body="$(curl -fsS -m 3 "${ENGINE_BASE}/health" 2>/dev/null)" || return 0
  # Isolate the "flags":{…} object, then list the keys whose value is true.
  local flags; flags="$(printf '%s' "$body" | sed -n 's/.*"flags":{\([^}]*\)}.*/\1/p')"
  [[ -z "$flags" ]] && { info "behavioral flags: (engine predates the /health flags field)"; return 0; }
  on="$(printf '%s' "$flags" | tr ',' '\n' | sed -n 's/"\([a-zA-Z]*\)":true/\1/p' | paste -sd' ' -)"
  [[ -z "$on" ]] && on="(none — all default OFF)"
  info "behavioral flags ON: ${on}"
}

# DEPLOY-11: /health already reports `embeddings: { provider, degraded }` (fastembed vs. the
# deterministic fallback) — the engine "logs loudly" on a cold-boot fallback, but nothing
# surfaced it to an operator who isn't tailing stdout at that exact moment. Same isolate-the-
# object-then-grep-a-key style as behavioral_flags_line above (no jq dependency). Never fails
# the run — a degraded embedder means "recall got dumber," not "the game is broken."
embeddings_check() {
  local body emb_obj provider degraded configured
  body="$(curl -fsS -m 3 "${ENGINE_BASE}/health" 2>/dev/null)" || return 0
  emb_obj="$(printf '%s' "$body" | sed -n 's/.*"embeddings":{\([^}]*\)}.*/\1/p')"
  [[ -z "$emb_obj" ]] && { info "embeddings: (engine predates the /health embeddings field)"; return 0; }
  provider="$(printf '%s' "$emb_obj" | sed -n 's/.*"provider":"\([^"]*\)".*/\1/p')"
  degraded="$(printf '%s' "$emb_obj" | sed -n 's/.*"degraded":\(true\|false\).*/\1/p')"
  configured="$(env_get ORWELL_EMBEDDINGS)"
  if [[ "$degraded" == "true" ]]; then
    warn "embeddings DEGRADED (provider=${provider:-unknown}) — semantic recall silently fell back to the deterministic fake; check the engine's boot log for a fastembed/ONNX load failure"
  elif [[ "$configured" == "fastembed" && -n "$provider" && "$provider" != "fastembed" ]]; then
    warn "ORWELL_EMBEDDINGS=fastembed is set but the running engine reports provider=${provider} — check the engine boot log"
  else
    pass "embeddings: provider=${provider:-unknown}, degraded=${degraded:-false}"
  fi
}

# DEPLOY-10: nothing anywhere warned about disk pressure on the (12 GB default) LXC disk — it
# accumulates saves, generated portraits, the fastembed model cache, and (per DEPLOY-9/13/14)
# backups/logs. A plain `df`-based threshold check, same pass/warn idiom as everything else here.
DISK_WARN_PCT="${ORWELL_DISK_WARN_PCT:-85}"
disk_space_check() {
  local pct
  pct="$(df -P "$APP_DIR" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
  if [[ -z "$pct" ]]; then
    info "disk usage: could not stat ${APP_DIR} (df unavailable?)"
    return 0
  fi
  if [[ "$pct" -ge "$DISK_WARN_PCT" ]] 2>/dev/null; then
    warn "disk usage ${pct}% at ${APP_DIR} (warn threshold ${DISK_WARN_PCT}%) — saves, portraits, the fastembed cache, backups, and logs all live here; free space or grow the disk"
  else
    pass "disk usage ${pct}% at ${APP_DIR} (warn threshold ${DISK_WARN_PCT}%)"
  fi
}

# DEPLOY-17: the deploy PAT (A4/ruling #17) is a fine-grained token capped at ONE YEAR — its
# expiry is mentioned once, in orwell-update.sh's rotation echo, and never re-checked. An expired
# token breaks the web-triggered auto-update path (orwell-ops-update.service) silently — it just
# appends an auth error to data/ops-update.log with no other signal. Reuse the git credential
# helper orwell.sh already installed (`git config --system credential.helper`) via a lightweight
# `git ls-remote`; only meaningful when a token-based (private-repo) install is in play.
git_remote_check() {
  command -v git >/dev/null 2>&1 || return 0
  # `-e`, not `-d`: a plain checkout's .git is a directory, but a git WORKTREE's .git is a file
  # (a gitdir pointer) — either is a valid repo for `git ls-remote`.
  [[ -e "${APP_DIR}/.git" ]] || return 0
  grep -qs '^GIT_TOKEN=' "$ENV_FILE" 2>/dev/null || { info "git remote auth: no GIT_TOKEN configured — skipping (public/local checkout)"; return 0; }
  local out rc
  out="$(cd "${APP_DIR}" 2>/dev/null && timeout 10 git ls-remote --exit-code origin HEAD 2>&1)"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    pass "git remote auth (deploy PAT still valid)"
  elif grep -Eiq 'authentication|401|403|invalid[- ]?(credentials|token)|could not read (username|password)|terminal prompts disabled|access denied' <<<"$out"; then
    warn "git remote auth FAILED (PAT-expiry-shaped error) — the web-triggered auto-update path is likely broken; rotate with: bash ${APP_DIR}/deploy/orwell-update.sh --set-token"
  else
    info "git remote check: could not reach origin (network issue, not necessarily auth) — $(printf '%s' "$out" | head -1)"
  fi
}

# A reachable engine must SERVE tools. For a probe user the healthy reply is the structured
# "no active game" refusal (404) — connection-refused/timeouts mean down.
engine_serves_tools() {
  local out
  out="$(curl -s -m 5 -X POST "${ENGINE_BASE}/player/call" \
          -H 'content-type: application/json' -H 'X-Orwell-User: __doctor__' \
          ${ENGINE_TOKEN:+-H "x-orwell-token: ${ENGINE_TOKEN}"} \
          -d '{"name":"getGameState","args":{}}' 2>/dev/null)" || return 1
  # A configured-but-unpresented token answers 401 "unauthorized"; surface that
  # distinctly so a token mismatch never masquerades as a dead engine.
  if grep -Eq '"error":"unauthorized"' <<<"$out"; then
    warn "engine tool probe got 401 — ORWELL_ENGINE_TOKEN in ${ENV_FILE} may not match the running engine"
    return 1
  fi
  grep -Eq '"result"|no active game' <<<"$out"
}

# SEC-21: the engine's admin/God-Mode channel (audit E27, SEC-5 in the security lane) MUST use a
# secret DISTINCT from the player token — since the SEC-5 fix, an engine started with the player
# token set but no admin token now DISABLES the admin channel outright (503) rather than falling
# back to the player token, so this is a "will admin access work at all" check, not just a
# best-practice nag. The official installer (orwell-install.sh) mints both correctly; this catches
# a hand-deployed box (copied .env, docker run, etc.) that never got the memo.
token_security_check() {
  [[ -f "$ENV_FILE" ]] || return 0
  if [[ -n "$ENGINE_TOKEN_RAW" && -z "$ENGINE_ADMIN_TOKEN_RAW" ]]; then
    warn "ORWELL_ENGINE_ADMIN_TOKEN is not set while ORWELL_ENGINE_TOKEN is — the engine DISABLES the admin/God-Mode channel entirely (SEC-5 fail-closed) until you set a distinct ORWELL_ENGINE_ADMIN_TOKEN in ${ENV_FILE}"
  elif [[ -n "$ENGINE_TOKEN_RAW" && -n "$ENGINE_ADMIN_TOKEN_RAW" && "$ENGINE_TOKEN_RAW" == "$ENGINE_ADMIN_TOKEN_RAW" ]]; then
    warn "ORWELL_ENGINE_ADMIN_TOKEN equals ORWELL_ENGINE_TOKEN in ${ENV_FILE} — mint a DISTINCT admin secret so the player token can't reach producerVault / God Mode"
  elif [[ -n "$ENGINE_TOKEN_RAW" && -n "$ENGINE_ADMIN_TOKEN_RAW" ]]; then
    pass "engine admin/player tokens are set and distinct"
  else
    info "engine tokens not set (ORWELL_ENGINE_TOKEN/ORWELL_ENGINE_ADMIN_TOKEN) — trusted-loopback-only posture"
  fi
}

# The HTTP status of the FE health probe ("000" = no answer at all). Any real status — even a
# 401 from an auth-gated build — proves the front-end PROCESS is up and serving.
fe_http_code() { curl -s -m 5 -o /dev/null -w '%{http_code}' "${FE_BASE}/api/orwell/health" 2>/dev/null; }

fe_http_ok() {
  [[ -n "$FE_BASE" ]] || return 1
  local c; c="$(fe_http_code)"
  [[ -n "$c" && "$c" != "000" ]]
}

fe_sees_engine() {
  [[ -n "$FE_BASE" ]] && curl -fsS -m 5 "${FE_BASE}/api/orwell/health" 2>/dev/null | grep -q '"engine":\s*true'
}

# 401 means an OLDER build still auth-gates the health probe (current main exempts it): the FE is
# up, it just won't tell a cookie-less curl about the engine — we verified the engine directly.
fe_auth_gated() { [[ "$(fe_http_code)" == "401" ]]; }

wait_for() { # label  probe-fn  tries
  local label="$1" probe="$2" tries="${3:-30}"
  for _ in $(seq 1 "$tries"); do
    if "$probe"; then pass "$label"; return 0; fi
    sleep 0.5
  done
  fail "$label"
  return 1
}

# A11 [LOW · Noise]: onnxruntime (fastembed) logs a HARMLESS
# `pthread_setaffinity_np … error code: 22` (twice, at thread-pool creation) inside an LXC
# whose cgroup cpuset doesn't grant the host CPU indexes ORT tries to pin — threads run
# unpinned, inference is unaffected. fastembed-js doesn't expose ORT's intraOpNumThreads, so
# the mitigation is to IGNORE it here: drop only that exact benign line from the failure tail
# (and note how many were hidden) so it never masquerades as the crash reason. Genuine
# diagnostics — every other line — pass through untouched.
ORT_AFFINITY_NOISE='pthread_setaffinity_np.*error code: 22'

journal_tail() {
  echo "---- last 25 journal lines: $1 ----"
  local raw
  raw="$(journalctl -u "$1" -n 25 --no-pager 2>/dev/null)" || { echo "(journalctl unavailable — run as root?)"; echo "-----------------------------------"; return 0; }
  local hidden
  hidden="$(grep -Ec "$ORT_AFFINITY_NOISE" <<<"$raw" || true)"
  grep -Ev "$ORT_AFFINITY_NOISE" <<<"$raw"
  [[ "${hidden:-0}" -gt 0 ]] && echo "(+${hidden} harmless onnxruntime cpuset line(s) hidden — see README, A11)"
  echo "-----------------------------------"
}

# ORW-206: an update held back because a game is live (orwell-update.sh writes data/ops/update-deferred
# while it waits; it proceeds by itself once the game is idle, or at the max-defer limit).
update_deferred_check() {
  local f="${APP_DIR}/data/ops/update-deferred"
  [[ -f "$f" && ! -L "$f" ]] || return 0
  warn "an update is DEFERRED (a game is live) — it runs on its own once the game is idle: $(tr '\n' ' ' < "$f" | sed 's/ *$//')"
  info "to run it now (cuts any live game): bash ${APP_DIR}/deploy/orwell-update.sh --force"
}

diagnose() {
  echo "==> diagnose (engine=${ENGINE_SVC} :${ENGINE_PORT}, frontend=${FRONTEND_SVC}${FE_PORT:+ :${FE_PORT}})"
  if [[ "$UNITS_MISSING" == 1 ]]; then
    fail "no engine unit installed (neither orwell-engine nor bbai-engine has a unit file)"
  else
    unit_active "$ENGINE_SVC"   && pass "unit active: ${ENGINE_SVC}"   || fail "unit active: ${ENGINE_SVC}"
    unit_active "$FRONTEND_SVC" && pass "unit active: ${FRONTEND_SVC}" || fail "unit active: ${FRONTEND_SVC}"
  fi
  [[ -f "${APP_DIR}/dist/main.js" ]] && pass "build artifact: dist/main.js" || fail "build artifact missing — run: bash ${APP_DIR}/deploy/orwell-update.sh"
  update_deferred_check
  token_security_check
  engine_http_ok       && pass "engine /health answers"        || fail "engine /health answers (${ENGINE_BASE}/health)"
  # DEPLOY-12 (B2): report which opt-in "living house" behavioral-fidelity layers are live, so an
  # operator can answer "is the house actually alive on my box?" without grepping data/.env. Best-effort
  # info line off the /health `flags` block; a build predating the field simply prints nothing.
  behavioral_flags_line
  # DEPLOY-11: surface a silent fastembed→deterministic degradation.
  embeddings_check
  engine_serves_tools  && pass "engine serves player tools"    || fail "engine serves player tools"
  # An engine that ANSWERS while its unit is inactive/missing is running OUTSIDE systemd (a stray
  # manual process). Restarting the unit would fight it for the port — name the situation instead.
  if engine_http_ok && { [[ "$UNITS_MISSING" == 1 ]] || ! unit_active "$ENGINE_SVC"; }; then
    warn "an engine answers on :${ENGINE_PORT} but not under ${ENGINE_SVC} — a stray process? (pct/ssh in and check: pgrep -af 'dist/main.js')"
  fi
  if [[ -n "$FE_BASE" ]]; then
    fe_http_ok       && pass "front-end answers /api/orwell/health" || fail "front-end answers /api/orwell/health (${FE_BASE})"
    if fe_sees_engine; then
      pass "front-end sees the engine (engine:true)"
    elif fe_auth_gated; then
      warn "health probe is auth-gated on this build (401) — front-end is UP; update the instance to expose the unauthenticated probe"
    else
      fail "front-end CANNOT see the engine — check ORWELL_ENGINE_MCP_URL in ${ENV_FILE}"
    fi
  else
    warn "ORWELL_PORT/BBAI_PORT not set in ${ENV_FILE} — skipping front-end probes"
  fi
  # DEPLOY-10: disk pressure on the (often 12 GB default) LXC disk.
  disk_space_check
  # DEPLOY-17: catch a PAT-expiry-shaped auth failure before the update path breaks silently.
  git_remote_check
  systemd_security_floor
}

# ---- systemd hardening floor (audit E85) -------------------------------------------------
# `systemd-analyze security` scores a unit's sandbox 0 (tight) … 10 (wide open). The deploy
# units ship hardened (deploy/systemd/*.service); a score drifting above the floor means a
# unit lost its hardening (e.g. hand-edited on the box). Warn-level: scores vary slightly by
# systemd version, and an old build must not read as "broken" for this alone.
SECURITY_FLOOR="${ORWELL_SECURITY_FLOOR:-7.0}"
systemd_security_floor() {
  command -v systemd-analyze >/dev/null 2>&1 || return 0
  [[ "$UNITS_MISSING" == 1 ]] && return 0
  local svc score
  for svc in "$ENGINE_SVC" "$FRONTEND_SVC"; do
    unit_active "$svc" || continue   # scoring needs a running unit
    score="$(systemd-analyze security "${svc}.service" 2>/dev/null \
      | sed -n 's/.*Overall exposure level[^0-9]*\([0-9.]*\).*/\1/p' | head -1)"
    [[ -n "$score" ]] || continue
    if awk -v s="$score" -v f="$SECURITY_FLOOR" 'BEGIN{exit !(s<=f)}'; then
      pass "systemd hardening: ${svc} exposure ${score} (floor ${SECURITY_FLOOR})"
    else
      warn "systemd hardening: ${svc} exposure ${score} ABOVE floor ${SECURITY_FLOOR} — unit lost its sandboxing? (systemd-analyze security ${svc})"
    fi
  done
}

bounce() {
  if [[ $EUID -ne 0 ]]; then
    echo "Restarting services needs root. Re-run:  sudo bash $0 ${MODE}"
    exit 2
  fi
  # If the unit doesn't exist on THIS machine, restarting (and waiting) is meaningless: either
  # orwell isn't installed here, or you are on the Proxmox host and the app lives in the LXC.
  if ! systemctl cat "$ENGINE_SVC" >/dev/null 2>&1; then
    fail "unit ${ENGINE_SVC} is not installed on this machine"
    echo "  -> If orwell runs in an LXC: run this script on the Proxmox host (it bridges via pct;"
    echo "     set CTID=<id> if the container is not named '${CT_HOSTNAME}')."
    echo "  -> If this IS the right machine: install first — bash deploy/orwell-install.sh"
    return 1
  fi
  echo "==> bounce: engine first, then front-end (front-end depends on the engine)"
  systemctl restart "$ENGINE_SVC"
  wait_for "engine healthy after restart" engine_http_ok 40 || { journal_tail "$ENGINE_SVC"; return 1; }
  wait_for "engine serves tools after restart" engine_serves_tools 20 || { journal_tail "$ENGINE_SVC"; return 1; }
  systemctl restart "$FRONTEND_SVC"
  if [[ -n "$FE_BASE" ]]; then
    wait_for "front-end healthy after restart" fe_http_ok 40 || { journal_tail "$FRONTEND_SVC"; return 1; }
    if fe_auth_gated; then
      warn "health probe auth-gated on this build (401) — front-end is up; the engine was verified directly"
    else
      wait_for "front-end sees the engine" fe_sees_engine 20 || { journal_tail "$FRONTEND_SVC"; journal_tail "$ENGINE_SVC"; return 1; }
    fi
  fi
  return 0
}

# ---- main ------------------------------------------------------------------------------
case "$MODE" in
  --status)
    diagnose
    ;;
  --bounce)
    diagnose
    fails=0  # the pre-bounce picture is informational; the verdict is post-bounce health
    bounce || true
    ;;
  --fix|*)
    diagnose
    if [[ $fails -gt 0 ]]; then
      echo "==> ${fails} problem(s) found — bouncing"
      fails=0
      bounce || true
    else
      echo "==> everything healthy — nothing to fix (use --bounce to force a restart)"
    fi
    ;;
esac

echo
if [[ $fails -eq 0 ]]; then
  echo "VERDICT: healthy."
else
  echo "VERDICT: still broken (${fails} failing check(s) — journals above)."
  echo "Next steps:"
  echo "  journalctl -u ${ENGINE_SVC} -n 100 --no-pager     # engine crash reason"
  echo "  journalctl -u ${FRONTEND_SVC} -n 100 --no-pager   # front-end crash reason"
  echo "  bash ${APP_DIR}/deploy/orwell-update.sh            # rebuild + restart from git"
fi
exit "$fails"
