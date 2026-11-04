#!/usr/bin/env bash
#
# orwell — OOBE reset (keep API keys). Returns the app to EXACT first-run onboarding while
# preserving ONLY the API-key / LLM-provider configuration, so the operator never has to
# re-enter their LLM setup. The SELECTED MODELS are reset to the OOB defaults (issue #860).
#
# This is the ONE implementation of every "back to OOBE" reset: orwell-factory-reset.sh is a thin
# wrapper that delegates here (same as the admin "Factory Reset (OOBE)" button), so the two cannot differ.
#
# Scrubs EVERYTHING a fresh install lacks: every per-user game sandbox (saves, souls, the
# hidden Vault layer), and the entire front-end store — ALL accounts, ALL chats/sessions,
# ALL memory, ALL MCP server configs, EVERY user setting, ALL uploads and portraits — then
# restarts so the next visit begins at first-run OOBE (account creation / casting).
#
# PRESERVED (this is the whole point — so an LLM is already wired after the reset):
#   • the configured LLM / image PROVIDERS (the model_endpoints table in the FE app.db) and the
#     default-ENDPOINT designation (default_endpoint_id — which provider, not which model),
#   • the encryption keys that decrypt them (data/.app_key, data/.key) and the legacy
#     data/api_keys.json — so after the reset an LLM is ALREADY configured.
#   • the engine config data/.env (ports, tokens, LLM keys — AND the public-deployment / SSL
#     profile written by the "Connect to the internet" wizard: ORWELL_PUBLIC, ALLOWED_HOSTS,
#     ALLOWED_ORIGINS, SECURE_COOKIES, AUTH_ENABLED, …) — NEVER touched, like every reset.
#   • the data/ops/ tree (the public-deployment apply record the admin page reads back, plus the
#     live ops trigger/status dir) — preserved below. The OS-level cloudflared tunnel/service is
#     never touched either. So a box that was made PUBLIC on the web STAYS public across the reset.
# RESET (not kept — issue #860): the SELECTED MODELS (default/utility/research/vision/image model
# and their fallbacks, plus the per-class endpoint picks) revert to the OOB defaults in
# frontend/src/settings.py, so a stale or placeholder pick can never ride across a reset.
# So after this reset the app sits at OOBE, but an LLM provider is already wired — and if the box
# was reachable on the internet, it still is.
#
# The selective FE-store surgery (export model_endpoints + the LLM settings, wipe the rest,
# rebuild) is done by the quarantined Python helper frontend/scripts/oobe_reset.py; this
# script orchestrates: stop services → preserve key FILES → run the helper → scrub the rest
# of the FE store + engine saves → restart.
#
# Run on the Proxmox HOST or inside the container as root:
#   bash /path/to/orwell-oobe-reset.sh             # prompts to confirm (type RESET)
#   bash /path/to/orwell-oobe-reset.sh --yes       # no prompt (automation)
#   bash /path/to/orwell-oobe-reset.sh --dry-run   # show what WOULD be removed
#   bash /path/to/orwell-oobe-reset.sh --no-restart # scrub but leave services down
#
# On the Proxmox host the script locates the orwell LXC (by hostname "orwell"; override with
# CTID=<id> or CT_HOSTNAME=<name>) and re-runs itself inside it — same bridge as the other
# orwell-*.sh maintenance scripts.
#
# Paths/services are overridable via env: APP_DIR, ORWELL_DATA_DIR, ORWELL_FE_DATA_DIR,
# ORWELL_ENGINE_SVC, ORWELL_FRONTEND_SVC (handy for a dev checkout).
set -euo pipefail

BRANCH="${BRANCH:-main}"
CT_HOSTNAME_SET="${CT_HOSTNAME:+1}"   # explicit override disables the legacy-name fallback
CT_HOSTNAME="${CT_HOSTNAME:-orwell}"
APP_DIR_EXPLICIT="${APP_DIR:-}"

msg()  { echo -e "==> $*"; }
warn() { echo -e "WARN: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# ── Optional whiptail TUI (deploy/orwell-tui.sh) — see orwell-update.sh for the rationale. The
# destructive confirmation below uses it on a TTY; absent / off a TTY it falls back to the plain
# type-RESET prompt (a host→container `pct exec` run has no PTY, so it expects --yes, as before).
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -n "${__lib:-}" && -r "$__lib" ]]; then . "$__lib"; break; fi
done
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }

# ── ops-progress lane: step-by-step progress to data/ops/<action>-status.json (sourced helper) ──
# Lets the admin health page render a live timeline for THIS reset (stopping → preserving keys →
# wiping → scrubbing → restarting → OOBE ready). Best-effort: if the helper is missing the no-op
# stubs keep the reset working unchanged. APP_DIR is resolved later (in-container); the helper
# re-reads it each call, and the web tier passes ORWELL_OPS_DIR explicitly when it needs to.
for __pf in "${__here}/orwell-ops-progress.sh" /opt/orwell/deploy/orwell-ops-progress.sh /opt/bbai/deploy/orwell-ops-progress.sh; do
  if [[ -n "${__pf:-}" && -r "$__pf" ]]; then . "$__pf"; break; fi
done
type ops_progress_init >/dev/null 2>&1 || { ops_progress_init() { :; }; ops_progress_step() { :; }; ops_progress_done() { :; }; ops_progress_fail() { :; }; }

# Collect flags so they can be forwarded to the in-container run.
ASSUME_YES=0; DRY_RUN=0; RESTART=1; EXTRA_FLAGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)        ASSUME_YES=1; EXTRA_FLAGS+=("--yes") ;;
    -n|--dry-run)    DRY_RUN=1;    EXTRA_FLAGS+=("--dry-run") ;;
    --no-restart)    RESTART=0;    EXTRA_FLAGS+=("--no-restart") ;;
    -h|--help)       sed -n '3,48p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# First install dir found: an explicit override, then the current path, then the legacy one.
find_app() {
  local d
  for d in "${APP_DIR_EXPLICIT:-}" /opt/orwell /opt/bbai; do
    [[ -n "$d" && -d "$d/.git" ]] && { printf '%s' "$d"; return 0; }
  done
  return 1
}

# ── Host → container bridge ────────────────────────────────────────────────────────────────────
# On a Proxmox host (pct present) the app lives inside the LXC — locate the orwell container and
# re-run this script inside it, forwarding all flags. Same pattern as orwell-factory-reset.sh.
# Inside the container pct does not exist (and the app dir does), so this block is skipped.
if command -v pct >/dev/null 2>&1 && ! find_app >/dev/null 2>&1; then
  CTID="${CTID:-$(pct list 2>/dev/null | awk -v n="$CT_HOSTNAME" 'NR>1 && $NF==n {print $1}' || true)}"
  # Legacy-aware: a pre-rename box may still run an LXC literally named "bbai".
  [[ -n "$CTID" || -n "$CT_HOSTNAME_SET" ]] || CTID="$(pct list 2>/dev/null | awk 'NR>1 && $NF=="bbai" {print $1}' || true)"
  [[ -n "$CTID" ]] || die "no orwell LXC found (hostname '${CT_HOSTNAME}' or legacy 'bbai'). Set CTID=<id> and retry."
  [[ "$(printf '%s' "$CTID" | wc -w)" -eq 1 ]] || die "multiple containers named '${CT_HOSTNAME}' (${CTID//$'\n'/ }). Set CTID=<id>."
  [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] || die "LXC ${CTID} is not running — start it first: pct start ${CTID}"

  msg "orwell lives in LXC ${CTID}; running OOBE reset (keep API keys) inside the container"
  # LOCAL-COPY bridge (A4/ruling #17 — closes audit E84): never curl a branch tip from GitHub.
  # Run from a file → push THAT file; run via `bash -c "$(...)"` → push the running text;
  # otherwise run the container's own checked-out copy.
  if [[ -n "${BASH_SOURCE[0]:-}" && -r "${BASH_SOURCE[0]:-}" ]]; then
    TMP_RESET="$(mktemp /tmp/orwell-oobe-reset-XXXXXX.sh)"
    cp "${BASH_SOURCE[0]}" "$TMP_RESET"
    pct push "$CTID" "$TMP_RESET" /tmp/orwell-oobe-reset.sh
    rm -f "$TMP_RESET"
    pct exec "$CTID" -- bash /tmp/orwell-oobe-reset.sh ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}
  elif [[ -n "${BASH_EXECUTION_STRING:-}" ]]; then
    TMP_RESET="$(mktemp /tmp/orwell-oobe-reset-XXXXXX.sh)"
    printf '%s\n' "$BASH_EXECUTION_STRING" > "$TMP_RESET"
    pct push "$CTID" "$TMP_RESET" /tmp/orwell-oobe-reset.sh
    rm -f "$TMP_RESET"
    pct exec "$CTID" -- bash /tmp/orwell-oobe-reset.sh ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}
  else
    pct exec "$CTID" -- bash -c "for d in /opt/orwell /opt/bbai; do
        [ -f \"\$d/deploy/orwell-oobe-reset.sh\" ] && exec bash \"\$d/deploy/orwell-oobe-reset.sh\" ${EXTRA_FLAGS[*]:-}
      done; echo 'ERROR: no in-container deploy/orwell-oobe-reset.sh found' >&2; exit 1"
  fi
  exit 0
fi

# ── In-container (or direct) reset ─────────────────────────────────────────────────────────────
APP_DIR="$(find_app || true)"; APP_DIR="${APP_DIR:-/opt/orwell}"

# CONFIG dir: where the engine's EnvironmentFile (.env) lives — we PRESERVE .env here.
CONFIG_DIR="${ORWELL_CONFIG_DIR:-${APP_DIR}/data}"
ENV_FILE="${CONFIG_DIR}/.env"
ENV_KEEP=".env"

# ENGINE SAVE dir: where the game actually persists (saves + the hidden Vault layer).
# Resolve exactly as the engine does (src/adapters/engine/FileSaveStore.ts): explicit env
# override, then .env, then the ./.orwell-data fallback — same three generations as
# orwell-factory-reset.sh.
env_val() { [[ -f "$ENV_FILE" ]] && grep -E "^[[:space:]]*${1}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^["'\'']//;s/["'\'']$//;s/\r$//'; }
ENGINE_SAVE_DIR="${ORWELL_DATA_DIR:-}"
[[ -n "$ENGINE_SAVE_DIR" ]] || ENGINE_SAVE_DIR="$(env_val ORWELL_DATA_DIR || true)"
[[ -n "$ENGINE_SAVE_DIR" ]] || ENGINE_SAVE_DIR="$(env_val BBAI_DATA_DIR || true)"
[[ -n "$ENGINE_SAVE_DIR" ]] || ENGINE_SAVE_DIR="${APP_DIR}/.orwell-data"
# A relative ORWELL_DATA_DIR (e.g. ./.orwell-data) resolves against the engine CWD = APP_DIR.
[[ "$ENGINE_SAVE_DIR" == /* ]] || ENGINE_SAVE_DIR="${APP_DIR%/}/${ENGINE_SAVE_DIR#./}"

FE_DIR="${ORWELL_FE_DIR:-${APP_DIR}/frontend}"
FE_DATA_DIR="${ORWELL_FE_DATA_DIR:-${FE_DIR}/data}"

# The keep-list: the FILES under the FE data dir to PRESERVE through the wipe. These are the
# encryption keys + the legacy key store — without them the (preserved) encrypted endpoint
# keys would be undecryptable. The model_endpoints rows + LLM settings are preserved by the
# Python helper (it reads them, then rebuilds app.db / settings.json), so app.db itself is
# NOT in this list — it gets rebuilt.
FE_KEEP_FILES=(".app_key" ".key" "api_keys.json")

# Service names follow the install: prefer orwell-*, fall back to legacy bbai-* units.
unit_exists() { systemctl list-unit-files "${1}.service" --no-legend 2>/dev/null | grep -q .; }
if [[ -z "${ORWELL_ENGINE_SVC:-}" ]]; then
  if unit_exists orwell-engine; then ENGINE_SVC="orwell-engine"; FRONTEND_SVC="orwell-frontend"
  elif unit_exists bbai-engine;  then ENGINE_SVC="bbai-engine";   FRONTEND_SVC="bbai-frontend"
  else                                ENGINE_SVC="orwell-engine"; FRONTEND_SVC="orwell-frontend"
  fi
else
  ENGINE_SVC="$ORWELL_ENGINE_SVC"
  FRONTEND_SVC="${ORWELL_FRONTEND_SVC:-orwell-frontend}"
fi

# ── Safety: never operate on an empty, root, or too-shallow path ──────────────────────────────
sanity_path() {
  local raw="$1" label="$2" p depth
  [[ -n "$raw" ]]     || die "${label} is empty — refusing to scrub."
  [[ "$raw" == /* ]]  || die "${label} must be absolute (got '${raw}')."
  [[ "$raw" != "/" ]] || die "${label} is '/' — refusing."
  p="${raw%/}"
  depth="$(awk -F/ '{print NF-1}' <<<"$p")"
  [[ "${depth}" -ge 2 ]] || die "${label} '${raw}' is too shallow — refusing (need e.g. /opt/orwell/...)."
}
sanity_path "$CONFIG_DIR"      "engine CONFIG_DIR"
sanity_path "$ENGINE_SAVE_DIR" "engine SAVE dir"
sanity_path "$FE_DATA_DIR"     "front-end FE_DATA_DIR"

# ── Environment detection ─────────────────────────────────────────────────────────────────────
have_systemd=0
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then have_systemd=1; fi
svc_exists() { systemctl list-unit-files "${1}.service" --no-legend 2>/dev/null | grep -q .; }

if [[ "$DRY_RUN" -eq 0 && "$(id -u)" -ne 0 ]]; then
  # Root is needed to remove data under /opt and to stop/start the systemd services — but NOT for a
  # self-contained run on non-/opt paths with no orwell-* units present (a CI/dev test). Gate on what
  # the run will actually touch, not merely on systemd being installed (CI runners have systemd).
  needs_root=0
  [[ "$CONFIG_DIR" == /opt/* || "$ENGINE_SAVE_DIR" == /opt/* || "$FE_DATA_DIR" == /opt/* ]] && needs_root=1
  if [[ "$have_systemd" -eq 1 ]] && { svc_exists "$ENGINE_SVC" || svc_exists "$FRONTEND_SVC"; }; then needs_root=1; fi
  if [[ "$needs_root" -eq 1 ]]; then
    die "run as root (sudo): needs to stop services and remove the game + user data under ${APP_DIR}."
  fi
fi

# Count sandboxes across BOTH the config dir (in case ORWELL_DATA_DIR=<app>/data) and the
# real engine save dir, so the confirmation prompt reflects what will actually be removed.
count_dirs() { [[ -d "$1" ]] && find "$1" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ' || echo 0; }
SANDBOXES="$(count_dirs "$ENGINE_SAVE_DIR")"
[[ "$ENGINE_SAVE_DIR" != "$CONFIG_DIR" ]] && SANDBOXES="$(( SANDBOXES + $(count_dirs "$CONFIG_DIR") ))"

# ── Confirmation (skipped by --yes / --dry-run) ───────────────────────────────────────────────
if [[ "$DRY_RUN" -eq 0 && "$ASSUME_YES" -eq 0 ]]; then
  if tui_active; then
    ORWELL_TUI_TITLE="Orwell — OOBE reset (keep API keys)"
    wt_confirm_phrase "RESET" "OOBE RESET — back to first-run onboarding, KEEPING your API keys.

PERMANENTLY DELETES all orwell game + user data:
  • ${SANDBOXES} game sandbox(es) under ${ENGINE_SAVE_DIR}/<user>/
    (saves, souls, the hidden Vault layer)
  • the front-end store ${FE_DATA_DIR}/ — ALL accounts, chats, sessions,
    memory, MCP server configs, uploads, portraits, and EVERY user setting

PRESERVED:
  • your LLM / image PROVIDERS + the keys that decrypt them
    (model_endpoints, .app_key, .key, api_keys.json) and the default-endpoint designation
  • the engine config ${CONFIG_DIR}/${ENV_KEEP}

RESET to the out-of-box defaults: the SELECTED MODELS (default, utility, research, vision, image).

The next visit starts at first-run onboarding (OOBE) — with an LLM already configured." \
      || die "aborted — no changes made."
  else
    cat <<EOF
This PERMANENTLY DELETES all orwell game + user data:
  • ${SANDBOXES} game sandbox(es)  under ${ENGINE_SAVE_DIR}/<user>/   (saves, souls, hidden Vault layer)
  • the front-end store            ${FE_DATA_DIR}/                    (ALL accounts, chats, sessions, memory,
                                                                       MCP configs, uploads, portraits, EVERY setting)
Preserved (so an LLM provider is already configured at OOBE):
  • your LLM / image providers + the keys that decrypt them (model_endpoints, .app_key, .key, api_keys.json)
  • the default-endpoint designation (which provider is the default — not which model)
  • the engine config            ${CONFIG_DIR}/${ENV_KEEP}
Reset to the out-of-box defaults (issue #860):
  • the SELECTED MODELS (default/utility/research/vision/image model + fallbacks, per-class endpoint picks)
The next visit will start at first-run onboarding (OOBE).
EOF
    read -r -p "Type 'RESET' to proceed: " ans
    [[ "$ans" == "RESET" ]] || die "aborted — no changes made."
  fi
fi

# ── ops-progress lane: publish a live timeline for a REAL run (skip dry-runs — nothing changes) ──
# The status file lives where the web tier reads it: <CONFIG_DIR>/ops/factory-reset-status.json
# (CONFIG_DIR is the engine data dir = where data/ops/ lives). A non-zero exit anywhere below
# trips the trap and records "FAILED: …" so the page surfaces the error instead of going silent.
OPS_PROGRESS=0
if [[ "$DRY_RUN" -eq 0 ]]; then
  export ORWELL_OPS_DIR="${CONFIG_DIR%/}/ops"
  OPS_PROGRESS=1
  ops_progress_init "factory-reset" 6
  trap 'rc=$?; if [[ "$OPS_PROGRESS" -eq 1 && "$rc" -ne 0 ]]; then ops_progress_fail "reset exited with code $rc — see ops-factory-reset.log"; fi' EXIT
fi
ops_step() { [[ "$OPS_PROGRESS" -eq 1 ]] && ops_progress_step "$1" "$2" || true; }

# An aborted reset (nothing wiped yet) must not leave the app down: bring the services back. Only
# called from the pre-wipe failure paths below, so --no-restart (which means "leave down AFTER a scrub")
# does not apply.
# Only units that were RUNNING before this reset stopped them are started again (a unit the operator
# had stopped stays stopped).
WAS_ACTIVE=()
abort_restart_services() {
  [[ "$have_systemd" -eq 1 ]] || return 0
  [[ ${#WAS_ACTIVE[@]} -gt 0 ]] || return 0
  msg "restarting services (the reset was aborted before the wipe)"
  local svc
  for svc in "${WAS_ACTIVE[@]}"; do
    systemctl start "$svc" || warn "could not restart ${svc} — start it by hand: systemctl start ${svc}"
  done
  return 0
}

# ── Helpers (dry-run aware) ───────────────────────────────────────────────────────────────────
do_rm()  { if [[ "$DRY_RUN" -eq 1 ]]; then echo "  would remove: $1"; else rm -rf -- "$1"; fi; }
do_svc() {
  if [[ "$DRY_RUN" -eq 1 ]]; then echo "  would: systemctl $1 $2"; else systemctl "$1" "$2" || warn "systemctl $1 $2 failed"; fi
}

# Is a given FE-store basename on the keep-list?
fe_kept() {
  local name="$1" k
  for k in "${FE_KEEP_FILES[@]}"; do [[ "$name" == "$k" ]] && return 0; done
  return 1
}

# ── 1. Stop the services so nothing writes while we scrub ─────────────────────────────────────
ops_step 1 "stopping services"
if [[ "$have_systemd" -eq 1 ]]; then
  msg "stopping services"
  for svc in "$ENGINE_SVC" "$FRONTEND_SVC"; do   # start order: engine first
    if [[ "$DRY_RUN" -eq 0 ]] && svc_exists "$svc" && systemctl is-active --quiet "$svc" 2>/dev/null; then WAS_ACTIVE+=("$svc"); fi
  done
  for svc in "$FRONTEND_SVC" "$ENGINE_SVC"; do svc_exists "$svc" && do_svc stop "$svc"; done
  if [[ "$DRY_RUN" -eq 0 ]]; then
    # Fail closed: a stop that failed (do_svc only warns) must not be followed by a wipe under a live service.
    for svc in "$FRONTEND_SVC" "$ENGINE_SVC"; do
      if svc_exists "$svc" && systemctl is-active --quiet "$svc" 2>/dev/null; then
        abort_restart_services
        die "${svc} is still running after 'systemctl stop' — the wipe was ABORTED before anything was removed (accounts, saves and uploads are intact)."
      fi
    done
  fi
else
  warn "systemctl not present — skipping service stop (dev mode). Stop the app yourself first."
fi

# ── 2. Preserve the API-key / LLM-provider config, then wipe the rest of the FE store ─────────
# The Python helper reads model_endpoints + the LLM-selection settings into memory and rebuilds
# app.db / settings.json carrying ONLY those — so we run it FIRST (while app.db still holds the
# providers), THEN remove every OTHER file in the FE store except the key-file keep-list and the
# rebuilt app.db / settings.json.
PYTHON_BIN="${ORWELL_PYTHON:-python3}"
OOBE_HELPER="${ORWELL_OOBE_HELPER:-${FE_DIR}/scripts/oobe_reset.py}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  msg "would preserve API keys/endpoints via ${OOBE_HELPER} (model_endpoints); model SELECTIONS reset to OOB defaults (#860)"
  msg "would keep FE files: ${FE_KEEP_FILES[*]} (+ rebuilt app.db / settings.json)"
  if [[ -d "$FE_DATA_DIR" ]]; then
    while IFS= read -r -d '' entry; do
      base="$(basename "$entry")"
      if fe_kept "$base" || [[ "$base" == "app.db" || "$base" == "settings.json" ]]; then
        echo "  would keep:   ${entry}"
      else
        echo "  would remove: ${entry}"
      fi
    done < <(find "$FE_DATA_DIR" -mindepth 1 -maxdepth 1 -print0)
  fi
else
  ops_step 2 "preserving API keys / LLM config"
  if [[ -f "$OOBE_HELPER" ]]; then
    msg "preserving LLM/provider config (model_endpoints + LLM settings) via the helper"
    # The helper honors DATA_DIR / DATABASE_URL; point it at the FE store explicitly so it
    # works regardless of CWD. A relative DATABASE_URL default already maps to <fe>/data/app.db.
    DATA_DIR="$FE_DATA_DIR" \
      DATABASE_URL="sqlite:///${FE_DATA_DIR%/}/app.db" \
      "$PYTHON_BIN" "$OOBE_HELPER" \
      || { abort_restart_services
           die "the OOBE preserve/rebuild helper failed — the wipe was ABORTED before anything else was removed (accounts, saves and uploads are intact). The helper replaces app.db atomically, so the provider config is intact too unless its own output above says otherwise. Fix Python deps and retry."; }
  else
    warn "OOBE helper ${OOBE_HELPER} not found — cannot preserve the provider config; ABORTING to avoid losing API keys."
    abort_restart_services
    die "expected ${OOBE_HELPER} — install the front-end Python deps and retry. (To also drop the API keys, remove frontend/data/.app_key, .key, api_keys.json and app.db by hand.)"
  fi

  # Now scrub every OTHER file in the FE store: keep the key files AND the just-rebuilt
  # app.db / settings.json; remove everything else (accounts/auth.json, sessions, uploads,
  # portraits, caches, …). This is what makes it OOBE.
  ops_step 3 "wiping front-end store (accounts, sessions, uploads)"
  msg "scrubbing front-end store ${FE_DATA_DIR} (keeping API-key config + rebuilt DB/settings)"
  if [[ -d "$FE_DATA_DIR" ]]; then
    while IFS= read -r -d '' entry; do
      base="$(basename "$entry")"
      if fe_kept "$base" || [[ "$base" == "app.db" || "$base" == "settings.json" ]]; then
        continue
      fi
      do_rm "$entry"
    done < <(find "$FE_DATA_DIR" -mindepth 1 -maxdepth 1 -print0)
  fi
  mkdir -p "$FE_DATA_DIR"
fi

# ── 3. Scrub the engine SAVE dir — the real per-user games (saves + hidden Vault layer) ───────
# KEEP .env, the model cache, AND data/ops/ — in case the save dir IS the config dir
# (ORWELL_DATA_DIR=<app>/data). data/ops/ holds the public-deployment apply record + the live ops
# trigger/status dir, so dropping it would forget the public deployment; step 3b makes the same
# exclusions when the two dirs differ.
ops_step 4 "scrubbing game sandboxes (saves, souls, Vault layer)"
msg "scrubbing engine saves in ${ENGINE_SAVE_DIR}"
if [[ -d "$ENGINE_SAVE_DIR" ]]; then
  while IFS= read -r -d '' entry; do do_rm "$entry"; done \
    < <(find "$ENGINE_SAVE_DIR" -mindepth 1 -maxdepth 1 ! -name "$ENV_KEEP" ! -name models ! -name ops -print0)
else
  warn "engine save dir ${ENGINE_SAVE_DIR} absent — nothing to scrub there"
fi

# ── 3b. Also scrub any sandboxes that landed in the CONFIG dir (covers ORWELL_DATA_DIR=<app>/data),
#        always KEEPING .env (the preserved config). Skipped when it's the same dir as step 3.
if [[ "$CONFIG_DIR" != "$ENGINE_SAVE_DIR" ]]; then
  msg "scrubbing config dir ${CONFIG_DIR} (keeping ${ENV_KEEP})"
  if [[ -d "$CONFIG_DIR" ]]; then
    # ops-progress lane: also KEEP the ops/ trigger dir — it holds the live progress status file
    # this very run is writing, and is the orwell-owned flag dir the root watcher relies on (a
    # fresh root-owned recreate would lock the non-root web tier out of the next trigger).
    while IFS= read -r -d '' entry; do do_rm "$entry"; done \
      < <(find "$CONFIG_DIR" -mindepth 1 -maxdepth 1 -type d ! -name models ! -name ops -print0)
  fi
fi

# ── 3c. Restore data-dir OWNERSHIP to the service user. This script needs root (to stop services
#        and scrub /opt), so the rebuilt app.db + recreated dirs are now root-owned — and the
#        hardened orwell-* services run UNPRIVILEGED, so they would fail to read/write their own
#        store and the UI would "refuse to connect" until ownership is handed back. Root-only,
#        best-effort; runs BEFORE the restart so the services boot able to write. Also re-homes
#        data/ops so the non-root web tier can still drop the next trigger flag.
if [[ "$DRY_RUN" -eq 0 && "$(id -u)" -eq 0 ]]; then
  SVC_USER="${ORWELL_SERVICE_USER:-}"
  [[ -n "$SVC_USER" ]] || SVC_USER="$(systemctl show -p User --value "$FRONTEND_SVC" 2>/dev/null || true)"
  [[ -n "$SVC_USER" ]] || SVC_USER="$(systemctl show -p User --value "$ENGINE_SVC" 2>/dev/null || true)"
  [[ -n "$SVC_USER" ]] || SVC_USER="orwell"
  if id "$SVC_USER" >/dev/null 2>&1; then
    SVC_GROUP="$(id -gn "$SVC_USER" 2>/dev/null || printf '%s' "$SVC_USER")"
    msg "restoring data-dir ownership to ${SVC_USER}:${SVC_GROUP} (root-run scrub left files root-owned)"
    for d in "$FE_DATA_DIR" "$ENGINE_SAVE_DIR" "$CONFIG_DIR"; do
      [[ -d "$d" ]] && chown -R "$SVC_USER":"$SVC_GROUP" "$d" 2>/dev/null || true
    done
  else
    warn "service user '${SVC_USER}' not found — skipping ownership restore (set ORWELL_SERVICE_USER)"
  fi
fi

# ── 4. Restart so the app re-initialises a fresh DB (init_db re-creates every other table)
#       and lands at OOBE — with the LLM already configured. ──────────────────────────────────
ops_step 5 "restarting services"
if [[ "$RESTART" -eq 1 && "$have_systemd" -eq 1 ]]; then
  msg "restarting services"
  START_FAILED=()
  STARTED=()
  for svc in "$ENGINE_SVC" "$FRONTEND_SVC"; do
    svc_exists "$svc" || continue
    do_svc start "$svc"
    STARTED+=("$svc")
  done
  if [[ "$DRY_RUN" -eq 0 ]]; then
    # `systemctl start` returns as soon as a Type=simple unit has forked, so a service that crashes on
    # boot still looks active for a moment: let them settle before judging.
    sleep "${ORWELL_START_SETTLE:-3}"
    for svc in ${STARTED[@]+"${STARTED[@]}"}; do
      systemctl is-active --quiet "$svc" || START_FAILED+=("$svc")
    done
  fi
  if [[ ${#START_FAILED[@]} -gt 0 ]]; then
    die "the data was reset, but ${START_FAILED[*]} did not come back up — check: journalctl -u ${START_FAILED[0]} -n 50; then: systemctl start ${START_FAILED[*]}"
  fi
elif [[ "$RESTART" -eq 0 ]]; then
  msg "left services stopped (--no-restart). Start them when ready."
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  msg "dry run complete — nothing was removed."
else
  # ops-progress lane: terminal OK. Clear the trap FIRST so the success write is not overwritten
  # by the EXIT trap (which would otherwise re-fire with rc=0 and is a no-op, but be explicit).
  trap - EXIT
  ops_progress_done "OOBE ready — open the UI to begin first-run onboarding"
  msg "OOBE reset complete. Open the UI: it begins at first-run onboarding — with your LLM already configured."
fi
