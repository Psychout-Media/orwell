#!/usr/bin/env bash
#
# orwell — update. Pulls, rebuilds the engine, refreshes front-end deps, and restarts services.
# It NEVER touches <app>/data, so the save (state + souls) is preserved (ties to #7).
#
# Run it EITHER on the Proxmox host (it locates the orwell LXC and updates INSIDE it) OR directly
# inside the container. On the host it mirrors deploy/orwell.sh's pct bridge; the app and its git
# checkout live in the LXC, never on the host (where there is no git / no app dir).
#
# Legacy-aware: a container provisioned BEFORE the bbai -> orwell rename (app in /opt/bbai with
# bbai-* services) is updated in place — the engine and front-end still honor the deprecated BBAI_*
# env, so its existing data/.env keeps working untouched.
set -euo pipefail

APP_DIR_EXPLICIT="${APP_DIR:-}"     # honor an explicit override; otherwise auto-detect below
BRANCH="${BRANCH:-main}"
# B71/ops A4 — pin + rollback:
#   REF=<sha|tag>          update to a PINNED ref instead of the branch tip
#   orwell-update.sh --rollback   return to the previous build (SHA + dist) recorded by the last update
# A4/ruling #17 — private-repo token (one-time setup / annual rotation for an EXISTING install):
#   orwell-update.sh --set-token  prompt for (or take GIT_TOKEN=) the deploy PAT, persist it into
#                                 data/.env, and wire the git credential helper — then exit.
#   orwell-update.sh --no-restart do the full update but SKIP the final `systemctl restart` — used
#                                 by the composed Update + Reset tier (orwell-update-reset.sh) so the
#                                 OOBE reset that follows owns the single final restart.
REF="${REF:-}"
ROLLBACK=0; SET_TOKEN=0; NO_RESTART=0
# --no-restart: do the full update (pull → rebuild → refresh deps → reconcile units) but SKIP the
# final `systemctl restart`. Added for the composed Update + Reset tier (orwell-update-reset.sh),
# which runs the update with restart suppressed and lets the OOBE reset perform the SINGLE final
# restart. Additive guard only — it never changes what the update builds. Accepted in any position.
for __a in "$@"; do
  case "$__a" in
    --rollback)   ROLLBACK=1 ;;
    --set-token)  SET_TOKEN=1 ;;
    --no-restart) NO_RESTART=1 ;;
  esac
done
CT_HOSTNAME_SET="${CT_HOSTNAME:+1}"   # explicit override disables the legacy-name fallback
CT_HOSTNAME="${CT_HOSTNAME:-orwell}"

# ── Optional whiptail TUI (deploy/orwell-tui.sh) ───────────────────────────────────────────────
# Used for the action menu + token entry when run on a TTY with whiptail present. Absent (e.g.
# the /tmp copy this script pushes into the container, which runs over pct exec with no PTY) →
# tui_active is false and the plain-text prompts below run unchanged. The lib is searched beside
# this file first, then the installed checkout, so even the pushed copy finds it.
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -n "${__lib:-}" && -r "$__lib" ]]; then . "$__lib"; break; fi
done
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }

# ── ops-progress lane: step-by-step progress to data/ops/<action>-status.json (sourced helper) ──
# Lets the admin health page render a live timeline for THIS update (fetching → rebuilding →
# refreshing deps → restarting → updated). Best-effort; missing helper ⇒ no-op stubs. The
# in-container run is the one that does the work, so the steps fire there (the host bridge exits).
for __pf in "${__here}/orwell-ops-progress.sh" /opt/orwell/deploy/orwell-ops-progress.sh /opt/bbai/deploy/orwell-ops-progress.sh; do
  if [[ -n "${__pf:-}" && -r "$__pf" ]]; then . "$__pf"; break; fi
done
type ops_progress_init >/dev/null 2>&1 || { ops_progress_init() { :; }; ops_progress_step() { :; }; ops_progress_done() { :; }; ops_progress_fail() { :; }; }

# Interactive front door: with no action chosen and a TTY, offer the same actions as the flags.
# Automation (flags / env / no TTY) is completely unaffected — this block is skipped entirely.
if [[ $ROLLBACK -eq 0 && $SET_TOKEN -eq 0 && -z "${REF:-}" && $# -eq 0 ]] && tui_active; then
  ORWELL_TUI_TITLE="Orwell — update"
  __act=""
  wt_menu __act "Update / maintenance for this Orwell install:" \
    tip      "Update to the latest build (branch tip)" \
    ref      "Update to a pinned commit or tag…" \
    rollback "Roll back to the previous build" \
    token    "Set / rotate the deploy token…" \
    || { echo "cancelled."; exit 0; }
  case "$__act" in
    ref)      wt_input REF "Commit SHA or tag to deploy:" "" || { echo "cancelled."; exit 0; } ;;
    rollback) ROLLBACK=1 ;;
    token)    SET_TOKEN=1 ;;
  esac
fi

# First install dir found here: an explicit override, then the current path, then the legacy one.
find_app() {
  local d
  for d in "${APP_DIR_EXPLICIT:-}" /opt/orwell /opt/bbai; do
    [[ -n "$d" && -d "$d/.git" ]] && { printf '%s' "$d"; return 0; }
  done
  return 1
}

# ── Host → container bridge ────────────────────────────────────────────────────────────────────
# On a Proxmox host (pct present) the app lives inside the LXC, not here — so locate the orwell
# container and re-run this update inside it, exactly as deploy/orwell.sh runs the installer.
# Inside the container pct does not exist (and the app dir does), so this block is skipped and the
# update runs directly. Override the target with CTID=<id> or CT_HOSTNAME=<name>.
if command -v pct >/dev/null 2>&1 && ! find_app >/dev/null 2>&1; then
  CTID="${CTID:-$(pct list 2>/dev/null | awk -v n="$CT_HOSTNAME" 'NR>1 && $NF==n {print $1}' || true)}"
  # Legacy-aware: a pre-rename box may still run an LXC literally named "bbai".
  [[ -n "$CTID" || -n "$CT_HOSTNAME_SET" ]] || CTID="$(pct list 2>/dev/null | awk 'NR>1 && $NF=="bbai" {print $1}' || true)"
  [[ -n "$CTID" ]] || { echo "ERROR: no orwell LXC found (hostname '${CT_HOSTNAME}' or legacy 'bbai'). Set CTID=<id> and retry." >&2; exit 1; }
  [[ "$(printf '%s' "$CTID" | wc -w)" -eq 1 ]] || { echo "ERROR: multiple containers named '${CT_HOSTNAME}' (${CTID//$'\n'/ }). Set CTID=<id>." >&2; exit 1; }
  [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] || { echo "ERROR: LXC ${CTID} is not running — start it first: pct start ${CTID}" >&2; exit 1; }

  echo "==> orwell lives in LXC ${CTID}; updating inside the container"
  # --set-token: capture the token on the host (prompt if interactive), then forward it via a
  # pushed root-only file — never on a pct exec command line (host ps) and never in a URL.
  if [[ $SET_TOKEN -eq 1 ]]; then
    if [[ -z "${GIT_TOKEN:-}" ]]; then
      if tui_active; then
        wt_password GIT_TOKEN "Deploy token (fine-grained PAT, Contents: Read-only on the repo):" || { echo "cancelled."; exit 0; }
      elif [[ -t 0 ]]; then
        read -rs -p "Deploy token (fine-grained PAT, Contents: Read-only on the repo): " GIT_TOKEN; echo
      fi
    fi
    [[ -n "${GIT_TOKEN:-}" ]] || { echo "ERROR: --set-token needs GIT_TOKEN=<pat> (or a TTY to prompt)." >&2; exit 1; }
    TMP_TOKEN="$(mktemp /tmp/orwell-token-XXXXXX)"
    chmod 600 "$TMP_TOKEN"
    printf 'GIT_TOKEN=%s\n' "$GIT_TOKEN" > "$TMP_TOKEN"
    pct push "$CTID" "$TMP_TOKEN" /tmp/orwell-token --perms 0600
    rm -f "$TMP_TOKEN"
  fi
  # LOCAL-COPY bridge (A4/ruling #17 — closes audit E84): never curl a branch tip from GitHub.
  # Run from a file → push THAT file; run via `bash -c "$(...)"` → push the running text
  # (BASH_EXECUTION_STRING); otherwise run the container's own checked-out copy (its first act
  # is `git pull`, so the staleness window is one update cycle — the E84 integrity shape).
  FWD_FLAG=""; [[ $ROLLBACK -eq 1 ]] && FWD_FLAG="--rollback"; [[ $SET_TOKEN -eq 1 ]] && FWD_FLAG="--set-token"
  [[ $NO_RESTART -eq 1 ]] && FWD_FLAG="${FWD_FLAG:+$FWD_FLAG }--no-restart"
  FWD_ENV="export ${APP_DIR_EXPLICIT:+APP_DIR='${APP_DIR_EXPLICIT}' }BRANCH='${BRANCH}' REF='${REF}';"
  if [[ -n "${BASH_SOURCE[0]:-}" && -r "${BASH_SOURCE[0]:-}" ]]; then
    TMP_UPDATE="$(mktemp /tmp/orwell-update-XXXXXX.sh)"
    cp "${BASH_SOURCE[0]}" "$TMP_UPDATE"
    pct push "$CTID" "$TMP_UPDATE" /tmp/orwell-update.sh
    rm -f "$TMP_UPDATE"
    pct exec "$CTID" -- bash -c "${FWD_ENV} bash /tmp/orwell-update.sh ${FWD_FLAG}"
  elif [[ -n "${BASH_EXECUTION_STRING:-}" ]]; then
    TMP_UPDATE="$(mktemp /tmp/orwell-update-XXXXXX.sh)"
    printf '%s\n' "$BASH_EXECUTION_STRING" > "$TMP_UPDATE"
    pct push "$CTID" "$TMP_UPDATE" /tmp/orwell-update.sh
    rm -f "$TMP_UPDATE"
    pct exec "$CTID" -- bash -c "${FWD_ENV} bash /tmp/orwell-update.sh ${FWD_FLAG}"
  else
    pct exec "$CTID" -- bash -c "${FWD_ENV} for d in \"\${APP_DIR:-}\" /opt/orwell /opt/bbai; do
        [ -n \"\$d\" ] && [ -f \"\$d/deploy/orwell-update.sh\" ] && exec bash \"\$d/deploy/orwell-update.sh\" ${FWD_FLAG}
      done; echo 'ERROR: no in-container deploy/orwell-update.sh found' >&2; exit 1"
  fi
  exit 0
fi

# ── In-container (or direct) update ────────────────────────────────────────────────────────────
APP_DIR="$(find_app || true)"; APP_DIR="${APP_DIR:-/opt/orwell}"

# Service names follow the install: prefer orwell-*, fall back to the legacy bbai-* units when
# that's what is registered (a container provisioned before the rename).
unit_exists() { systemctl list-unit-files "$1" 2>/dev/null | grep -q "$1"; }
if unit_exists orwell-engine.service; then
  ENGINE_SVC="orwell-engine"; FRONTEND_SVC="orwell-frontend"
elif unit_exists bbai-engine.service; then
  ENGINE_SVC="bbai-engine"; FRONTEND_SVC="bbai-frontend"
else
  ENGINE_SVC="orwell-engine"; FRONTEND_SVC="orwell-frontend"
fi

PREV_FILE="${APP_DIR}/data/.update-prev"      # the last good SHA (data/ survives updates)
PREV_DIST="${APP_DIR}/dist.prev"              # the last good build output
ENV_FILE="${APP_DIR}/data/.env"

# Wire git to read GIT_TOKEN from data/.env at use time (A4/ruling #17). Idempotent; also the
# self-heal for installs that predate the private flip: once the token line exists, every
# `git fetch/pull` in this script just works — no re-prompt, no token in any URL/.git/config.
wire_credential_helper() {
  grep -qs '^GIT_TOKEN=' "$ENV_FILE" || return 0
  git config --system credential.helper \
    '!f(){ echo username=x-access-token; echo "password=$(sed -n s/^GIT_TOKEN=//p '"${APP_DIR}"'/data/.env)"; };f'
}

# F4 self-heal (hit on a real box, 2026-06-11): the installer chowns the checkout to the
# `orwell` user while this script runs git as ROOT — git >=2.35 refuses every fetch/reset with
# "dubious ownership" unless the path is marked safe. The fixed installer wires this at install
# time; the updater wires it too, BEFORE its first git call, so every box installed before the
# fix heals on its next update. (A box already wedged needs the one manual bootstrap —
# `git config --system --add safe.directory <APP_DIR>` — to fetch THIS version; never again
# after that.) Idempotent: added once.
wire_safe_directory() {
  git config --system --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
    || git config --system --add safe.directory "$APP_DIR"
}
wire_safe_directory

# ── --set-token (A4): persist/rotate the deploy PAT, wire the helper, exit. ───────────────────
if [[ "$SET_TOKEN" -eq 1 ]]; then
  TOKEN="${GIT_TOKEN:-}"
  if [[ -z "$TOKEN" && -r /tmp/orwell-token ]]; then
    TOKEN="$(sed -n 's/^GIT_TOKEN=//p' /tmp/orwell-token | tail -1)"
    rm -f /tmp/orwell-token
  fi
  if [[ -z "$TOKEN" ]]; then
    if tui_active; then
      wt_password TOKEN "Deploy token (fine-grained PAT, Contents: Read-only on the repo):" || { echo "cancelled."; exit 0; }
    elif [[ -t 0 ]]; then
      read -rs -p "Deploy token (fine-grained PAT, Contents: Read-only on the repo): " TOKEN; echo
    fi
  fi
  [[ -n "$TOKEN" ]] || { echo "ERROR: --set-token needs GIT_TOKEN=<pat> (or a TTY to prompt)." >&2; exit 1; }
  mkdir -p "${APP_DIR}/data"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  # Rotate in place: drop any previous GIT_TOKEN line, then append the new one.
  TMP_ENV="$(mktemp "${APP_DIR}/data/.env.XXXXXX")"
  grep -v '^GIT_TOKEN=' "$ENV_FILE" > "$TMP_ENV" || true
  printf 'GIT_TOKEN=%s\n' "$TOKEN" >> "$TMP_ENV"
  chmod 600 "$TMP_ENV"
  mv "$TMP_ENV" "$ENV_FILE"
  wire_credential_helper
  echo "==> deploy token saved to ${ENV_FILE} and git credential helper wired."
  echo "    Rotation: re-run 'orwell-update.sh --set-token' (fine-grained PATs cap at one year)."
  exit 0
fi

wire_credential_helper

# ── Rollback (B71/ops A4): return to the recorded previous SHA + its dist, then restart. ──────
if [[ "$ROLLBACK" -eq 1 ]]; then
  [[ -f "$PREV_FILE" ]] || { echo "ERROR: no previous update recorded (${PREV_FILE} missing) — nothing to roll back to." >&2; exit 1; }
  PREV_SHA="$(cat "$PREV_FILE")"
  echo "==> rolling back to ${PREV_SHA}"
  git -C "$APP_DIR" reset --hard "$PREV_SHA"
  if [[ -d "$PREV_DIST" ]]; then
    rm -rf "${APP_DIR}/dist"
    cp -a "$PREV_DIST" "${APP_DIR}/dist"
  else
    ( cd "$APP_DIR" && npm ci && npm run build )
  fi
  systemctl restart "$ENGINE_SVC" "$FRONTEND_SVC"
  echo "==> rollback complete (now on ${PREV_SHA})."
  exit 0
fi

# ── ops-progress lane: publish a live timeline for THIS update; the trap surfaces a failure ──
# (fetching → rebuilding → refreshing deps → restarting → updated). data/ops/update-status.json
# is where the web tier reads it; any non-zero exit below trips the trap and records "FAILED: …".
export ORWELL_OPS_DIR="${APP_DIR%/}/data/ops"
ops_progress_init "update" 5
trap 'rc=$?; if [[ "$rc" -ne 0 ]]; then ops_progress_fail "update exited with code $rc — see ops-update.log"; fi' EXIT

echo "==> updating orwell in ${APP_DIR} (save in ${APP_DIR}/data is preserved)"
PREV_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
# Keep the running build so a failed update (or a later --rollback) can restore it untouched.
if [[ -d "${APP_DIR}/dist" ]]; then
  rm -rf "$PREV_DIST"
  cp -a "${APP_DIR}/dist" "$PREV_DIST"
fi

# Fetch + check out the TARGET (a pinned REF wins over the branch tip).
ops_progress_step 1 "fetching latest code"
if [[ -n "$REF" ]]; then
  git -C "$APP_DIR" fetch origin "$REF" || git -C "$APP_DIR" fetch --tags origin
  TARGET="$REF"
else
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  TARGET="origin/${BRANCH}"
fi
git -C "$APP_DIR" reset --hard "$TARGET"

# Build BEFORE committing to the swap (B71/ops A4): a failed build must leave the services on the
# PREVIOUS checkout + build — never a new tree with a stale dist, never a restart into a broken build.
echo "==> rebuild engine (the update commits only if this succeeds)"
ops_progress_step 2 "rebuilding engine"
cd "$APP_DIR"
if ! (npm ci && npm run build); then
  echo "ERROR: build FAILED on ${TARGET} — reverting to ${PREV_SHA}; services were NOT restarted." >&2
  ops_progress_fail "build failed on ${TARGET} — reverted to ${PREV_SHA}, services NOT restarted"
  trap - EXIT  # the explicit fail above is the final status; don't let the EXIT trap re-stamp it
  git -C "$APP_DIR" reset --hard "$PREV_SHA"
  if [[ -d "$PREV_DIST" ]]; then rm -rf "${APP_DIR}/dist"; cp -a "$PREV_DIST" "${APP_DIR}/dist"; fi
  echo "Hint: retry with REF=<known-good sha|tag>, or run 'orwell-update.sh --rollback' later." >&2
  exit 1
fi

# Production hardening: the host runs the BUNDLED engine (dist/main.js + the 3 pinned native deps),
# so once the build above is done it needs only the RUNTIME tree. Drop the dev/build chain
# (esbuild, vitest, cucumber, …) so the deployed box doesn't carry its advisories (npm audit: all
# dev-chain — see README "Dependency advisories"). Non-fatal; the next update re-installs it to build.
npm prune --omit=dev || echo "WARN: npm prune --omit=dev failed (dev deps remain; harmless)"

# ── FINDING #4 — record the rollback breadcrumb HERE, right after the engine build succeeds and
# BEFORE the FE dep-install + the unit reconcile below (both run under bare `set -e`, and both can
# fail). PREV_SHA + PREV_DIST are the verified-good prior build — the build guard above already
# reverted on a build failure — so this is the earliest safe rollback point. Recording it here means
# a later pip/reconcile failure still leaves an ACCURATE `--rollback` target (the immediately-prior
# build) instead of a STALE SHA carried over from an older update. Moving it earlier is safe: PREV_FILE
# only records WHERE to roll back to; nothing in this run consumes it. (data/ survives updates.)
mkdir -p "${APP_DIR}/data"
printf '%s' "$PREV_SHA" > "$PREV_FILE"

# ── FINDING #3 — resolve the service USER/GROUP (mirrors orwell-oobe-reset.sh's resolution, ~L368):
# needed both to drop privileges for the sqlite cruft-cleanup below AND to restore ownership after the
# root-run build/dep/prefetch/cleanup steps. Prefer an explicit override, then the unit's own User=,
# then the conventional `orwell`. Layout-agnostic on purpose — a legacy bbai box's files must also be
# left readable by its unprivileged service.
SVC_USER="${ORWELL_SERVICE_USER:-}"
[[ -n "$SVC_USER" ]] || SVC_USER="$(systemctl show -p User --value "$FRONTEND_SVC" 2>/dev/null || true)"
[[ -n "$SVC_USER" ]] || SVC_USER="$(systemctl show -p User --value "$ENGINE_SVC" 2>/dev/null || true)"
[[ -n "$SVC_USER" ]] || SVC_USER="orwell"
SVC_GROUP="$SVC_USER"
if id "$SVC_USER" >/dev/null 2>&1; then
  SVC_GROUP="$(id -gn "$SVC_USER" 2>/dev/null || printf '%s' "$SVC_USER")"
fi

# Run sqlite3 as the service USER, never as root: a root-run write against data/app.db while the FE is
# up leaves root-owned app.db-wal/-shm sidecars that make the unprivileged FE hit "readonly database" /
# "database is locked". Drop privileges with runuser when we are root and the user resolves; otherwise
# (already unprivileged, or no runuser) run in-process. The service user owns the DB in normal
# operation, and the chown below re-affirms it.
_svc_sqlite3() {
  if [[ "$(id -u)" -eq 0 ]] && command -v runuser >/dev/null 2>&1 && id "${SVC_USER:-orwell}" >/dev/null 2>&1; then
    runuser -u "${SVC_USER:-orwell}" -- sqlite3 "$@"
  else
    sqlite3 "$@"
  fi
}

# ── data/.env reconcile: opt-in feature flags + the two security keys install.sh writes that the
#    updater used to miss (ROOT CAUSE of "a built feature / admin is silently OFF on an old box") ───────
# orwell-install.sh writes a set of deploy defaults into data/.env, but the updater reconciled NONE of
# them — a box provisioned before any given key was added never got it. Backfill them idempotently,
# add-if-absent + never-clobber, in ONE atomic rewrite (same mktemp idiom as --set-token; existing
# content + ordering preserved, new keys append at the end). Three categories:
#   1. the opt-in FEATURE flags — from the SAME shared source install writes from
#      (deploy/orwell-env-defaults.sh) so install + update cannot drift. Missing ORWELL_EMBEDDINGS is the
#      one that got noticed (⇒ DEGRADED deterministic semantic recall — ROOT CAUSE A).
#   2. ORWELL_ENGINE_MULTIUSER=1 — unset ⇒ the engine routes a missing x-orwell-user header to a shared
#      "default" sandbox (weakened cross-user isolation, feature 0021). Default 1, matching install.
#   3. ORWELL_ENGINE_ADMIN_TOKEN — MINTED fresh when absent (never copied from ORWELL_ENGINE_TOKEN: one
#      bearer must not grant both any-user impersonation AND God Mode — audit E27). A box missing it has
#      admin/God-Mode fail-closed-disabled; minting restores it, using install.sh's exact openssl idiom.
# Runs BEFORE the model prefetch below so ORWELL_EMBED_CACHE is settled and the prefetch warms the EXACT
# dir the engine reads. A box with no data/.env is skipped (the systemd EnvironmentFile is optional `-`).
# Prefer the freshly-pulled lib in the checkout; fall back to this script's own dir (the pushed /tmp copy
# carries only the updater, so the checkout copy is the real one).
ENV_DEFAULTS_LIB="${APP_DIR}/deploy/orwell-env-defaults.sh"
[[ -r "$ENV_DEFAULTS_LIB" ]] || ENV_DEFAULTS_LIB="${__here}/orwell-env-defaults.sh"
if [[ -f "$ENV_FILE" && -r "$ENV_DEFAULTS_LIB" ]]; then
  . "$ENV_DEFAULTS_LIB"
  RECON_TMP="$(mktemp "${APP_DIR}/data/.env.optin.XXXXXX")"
  cat "$ENV_FILE" > "$RECON_TMP"                 # preserve all existing content + ordering
  recon_added=""
  # Append KEY=VALUE only when KEY is genuinely ABSENT — idempotent (a re-run is a no-op) and it never
  # clobbers an operator's own value (or an intentional `KEY=0` opt-out). The `if grep` keeps grep's
  # no-match exit off `set -e`.
  _env_add_if_absent() {   # $1=key  $2=value
    if grep -qs "^${1}=" "$ENV_FILE"; then return 0; fi
    printf '%s=%s\n' "$1" "$2" >> "$RECON_TMP"
    recon_added="${recon_added} ${1}"
  }
  # 1. opt-in feature flags (shared single source) — pass the box's data dir so ORWELL_EMBED_CACHE
  #    resolves to <data>/models (== the prefetch --cache-dir resolved below).
  while IFS='=' read -r _key _val; do
    [[ -n "$_key" ]] || continue
    _env_add_if_absent "$_key" "$_val"
  done < <(orwell_optin_env_defaults "${APP_DIR}/data")
  # 2. multi-user identity (cross-user isolation)
  _env_add_if_absent "ORWELL_ENGINE_MULTIUSER" "1"
  # 3. admin/God-Mode secret — MINTED (not defaulted/copied) only when absent, install.sh's exact idiom.
  if ! grep -qs '^ORWELL_ENGINE_ADMIN_TOKEN=' "$ENV_FILE"; then
    _admin_secret="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    printf 'ORWELL_ENGINE_ADMIN_TOKEN=%s\n' "$_admin_secret" >> "$RECON_TMP"
    recon_added="${recon_added} ORWELL_ENGINE_ADMIN_TOKEN(minted)"
  fi
  if [[ -n "$recon_added" ]]; then
    chmod --reference="$ENV_FILE" "$RECON_TMP" 2>/dev/null || chmod 600 "$RECON_TMP"
    mv "$RECON_TMP" "$ENV_FILE"
    echo "==> reconciled data/.env — added keys the install predated:${recon_added}"
    case " $recon_added " in
      *" ORWELL_EMBEDDINGS "*) echo "    (incl. ORWELL_EMBEDDINGS=fastembed — real semantic recall re-armed; prefetched below into the engine's cache dir, so the next boot is offline + non-degraded)" ;;
    esac
  else
    rm -f "$RECON_TMP"      # every key already present ⇒ a true no-op (idempotent re-run)
  fi
fi

# Resolve the embedding-model cache dir the ENGINE will actually read, so the prefetch below warms the
# SAME dir. A box installed with a custom DATA_DIR pins ORWELL_EMBED_CACHE off it — hardcoding
# ${APP_DIR}/data/models would prefetch to the wrong dir and the engine would still see an empty cache
# and re-download / degrade. Priority: the (now-reconciled) ORWELL_EMBED_CACHE in data/.env → the box's
# data dir (ORWELL_DATA_DIR minus its /saves leaf) + /models → ${APP_DIR}/data/models.
EMBED_CACHE_DIR=""
if [[ -f "$ENV_FILE" ]]; then
  EMBED_CACHE_DIR="$(sed -n 's/^ORWELL_EMBED_CACHE=//p' "$ENV_FILE" | tail -n1)"
  if [[ -z "$EMBED_CACHE_DIR" ]]; then
    _box_saves="$(sed -n 's/^ORWELL_DATA_DIR=//p' "$ENV_FILE" | tail -n1)"
    [[ -n "$_box_saves" ]] && EMBED_CACHE_DIR="${_box_saves%/saves}/models"
  fi
fi
EMBED_CACHE_DIR="${EMBED_CACHE_DIR:-${APP_DIR}/data/models}"

# Prefetch the pinned embedding model cache (ADR 0004 / E86a) — FIRST-CLASS on every update, not just
# fresh installs (ROOT CAUSE B of "semantic recall silently degraded on an old box"): a box provisioned
# before the fastembed default has its model cache EMPTY, so even once ORWELL_EMBEDDINGS is backfilled
# above the engine's boot warm-up would need the network and quietly fall back. Prefetching here (into
# the resolved $EMBED_CACHE_DIR, identical to orwell-install.sh's prefetch_model) makes that cache
# offline-capable, so the next boot uses real embeddings. A no-op when already cached; non-fatal on
# failure (the engine still boots + retries at boot).
echo "==> embedding model prefetch into ${EMBED_CACHE_DIR} (no-op when cached)"
# A11: onnxruntime logs a harmless `pthread_setaffinity_np … error code: 22` (twice) inside an LXC
# restricted cpuset — the thread pool just runs unpinned (inference unaffected; fastembed-js doesn't
# expose ORT's intraOpNumThreads to silence it at the source). Filter that one benign stderr line so
# the update output doesn't look alarming; every other message still surfaces. The trailing `|| true`
# is load-bearing: `grep -v` exits 1 when it filters out ALL input (the affinity warning is often the
# only stderr a successful prefetch emits), so its no-match status must never read as a failure.
#
# We CAPTURE the combined output and CLASSIFY the failure class per the owner no-silent-failure ruling
# (2026-07-14): a genuine warm-up CRASH (the #1590 tar-import class) is a REAL defect that degrades
# EVERY boot and must be shown RED; a plain model-download failure stays a benign WARN (the engine
# retries at boot). Non-fatal either way — an update must not brick the box on embeddings.
# shellcheck source=deploy/smoke_embeddings.sh
. "${APP_DIR}/deploy/smoke_embeddings.sh"
_pf_log="$(mktemp)"; _pf_rc=0
if node "${APP_DIR}/dist/embedWorker.js" --prefetch --cache-dir "$EMBED_CACHE_DIR" >"$_pf_log" 2>&1; then :; else _pf_rc=$?; fi
grep -vE 'pthread_setaffinity_np.*error code: 22' "$_pf_log" >&2 || true
if [[ "$_pf_rc" -ne 0 ]]; then
  if [[ "$(classify_prefetch_outcome "$_pf_rc" "$(cat "$_pf_log")")" == "import-fail" ]]; then
    echo "!! REAL FAILURE (embeddings): fastembed CRASHED on import/warm-up — NOT a download problem." >&2
    echo "   Semantic recall will run DEGRADED (deterministic) on EVERY boot until this is fixed. This is a" >&2
    echo "   build/dependency defect (e.g. the tar@7 ESM regression, #1590), not a transient. Reproduce with:" >&2
    echo "     node ${APP_DIR}/dist/embedWorker.js --prefetch --cache-dir ${EMBED_CACHE_DIR}" >&2
  else
    echo "WARN: embedding model prefetch FAILED — semantic recall will run DEGRADED (deterministic"
    echo "      fallback) until the model is cached. The engine retries the prefetch at boot; if it keeps"
    echo "      failing, check the engine boot log (journalctl -u ${ENGINE_SVC}) for the real ONNX/RAM/download error."
  fi
fi
rm -f "$_pf_log"

echo "==> refresh front-end deps"
ops_progress_step 3 "refreshing front-end deps"
cd "${APP_DIR}/frontend"
# Pinned lockfile first (audit E83): updates re-install exactly what CI tested, never a blind
# re-resolution of unpinned ranges.
if [[ -f requirements.lock.txt ]]; then
  ./.venv/bin/pip install -q -r requirements.lock.txt
else
  ./.venv/bin/pip install -q -r requirements.txt
fi

# (The rollback breadcrumb PREV_FILE was recorded right after the engine build succeeded, above —
#  FINDING #4 — so a pip/reconcile failure here still leaves an accurate `--rollback` target.)

# ── Issue #636 — converge an existing box to the lean game build ───────────────────────────────
# The FE is vendored from a larger workspace whose browser (Playwright NPX), ChromaDB RAG
# ToolIndex, and RAG/Memory/Email built-in MCP servers have NO role in the Big Brother game.
# The new code stops STARTING them in the game build, but a box updated from an older build may
# still carry their leftovers (a warmed npx cache, an admin-added MCP-server DB row, a stale
# CHROMADB_HOST). Clean those up so the updated box converges to the lean game build.
#
# Conservative + fail-soft by construction: every step only touches what genuinely exists, only
# under the game build, and NEVER fails the update (each guarded; the function always returns 0).
# Runs in-container after the deps refresh, before the restart, so the restart boots clean.
game_build_on() {
  # Mirror src.settings.game_build_enabled(): default ON; OFF only on an explicit falsey value.
  local raw
  raw="$(sed -n 's/^ORWELL_GAME_BUILD=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
  [[ -n "$raw" ]] || raw="$(sed -n 's/^BBAI_GAME_BUILD=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
  case "$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    0|false|no|off|n) return 1 ;;   # full workspace — leave everything in place
    *)                return 0 ;;   # unset/anything else ⇒ game build (the product default)
  esac
}

cleanup_inherited_cruft() {
  # Full workspace keeps everything inherited — nothing to clean.
  game_build_on || { echo "==> full-workspace build: leaving inherited subsystems in place"; return 0; }

  echo "==> game build: cleaning inherited-workspace cruft (browser MCP / ChromaDB / RAG-Memory-Email)"

  # 1) Drop the @playwright/mcp npx cache entry if it was ever warmed. `npm cache npx ls/rm` is the
  #    documented way; older npm lacks the `npx` subcommand, so fall back to pruning the on-disk
  #    _npx cache dir. Both are best-effort and a miss is a no-op.
  if command -v npm >/dev/null 2>&1; then
    if npm cache npx ls >/dev/null 2>&1; then
      npm cache npx rm "$(npm cache npx ls 2>/dev/null | awk '/@playwright\/mcp/{print $1}')" >/dev/null 2>&1 \
        || npm cache npx rm '@playwright/mcp' >/dev/null 2>&1 || true
    fi
  fi
  local npx_cache="${HOME:-/root}/.npm/_npx"
  if [[ -d "$npx_cache" ]]; then
    # Each entry is a hashed dir; only remove ones that actually pulled @playwright/mcp.
    while IFS= read -r d; do
      [[ -n "$d" ]] && rm -rf "$d" && echo "    removed npx cache entry: $d"
    done < <(grep -rls '@playwright/mcp' "$npx_cache" 2>/dev/null \
               | sed 's#/[^/]*$##' | sort -u || true)
  fi

  # 2) Drop any admin-added MCP-server DB rows referencing browser/playwright/memory/rag/email.
  #    Built-in servers are NOT persisted (registered at boot), so this only ever touches a row an
  #    operator added by hand. Guarded: skip silently if there's no sqlite3, no db, or no table.
  # FINDING #3 — every sqlite3 here goes through _svc_sqlite3 (drop privileges to the service user).
  # As ROOT while the FE is up, even a SELECT can create/checkpoint root-owned app.db-wal/-shm
  # sidecars that then make the unprivileged FE hit "readonly database" / "database is locked"; the
  # DELETE is the same hazard. Running as the DB's owner keeps every sidecar owned by that user.
  local db="${APP_DIR}/data/app.db"
  if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$db" ]]; then
    if _svc_sqlite3 "$db" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_servers' LIMIT 1;" 2>/dev/null | grep -q 1; then
      local pat="'%browser%' OR lower(name) LIKE '%playwright%' OR lower(command) LIKE '%playwright%' OR lower(args) LIKE '%@playwright/mcp%' OR lower(name) IN ('memory','rag','email') OR lower(id) IN ('memory','rag','email','builtin_browser')"
      local before after
      before="$(_svc_sqlite3 "$db" "SELECT count(*) FROM mcp_servers;" 2>/dev/null || echo 0)"
      _svc_sqlite3 "$db" "DELETE FROM mcp_servers WHERE lower(name) LIKE ${pat};" 2>/dev/null || true
      after="$(_svc_sqlite3 "$db" "SELECT count(*) FROM mcp_servers;" 2>/dev/null || echo 0)"
      if [[ "$before" =~ ^[0-9]+$ && "$after" =~ ^[0-9]+$ ]] && (( before > after )); then
        echo "    removed $(( before - after )) inherited MCP-server config row(s) from app.db"
      fi
    fi
  fi

  # 3) Neutralize a stale CHROMADB_HOST/CHROMADB_PORT in data/.env: under the game build the RAG
  #    ToolIndex is no longer wired, and a leftover CHROMADB_HOST would re-arm it. Comment the
  #    line(s) out rather than delete, so flipping back to the full workspace is a one-line edit.
  if [[ -f "$ENV_FILE" ]] && grep -qE '^[[:space:]]*CHROMADB_(HOST|PORT)=' "$ENV_FILE" 2>/dev/null; then
    local tmp_env
    tmp_env="$(mktemp "${APP_DIR}/data/.env.cruft.XXXXXX")"
    sed -E 's/^([[:space:]]*CHROMADB_(HOST|PORT)=)/# disabled by orwell-update (game build, issue #636): \1/' \
      "$ENV_FILE" > "$tmp_env" 2>/dev/null && {
        chmod --reference="$ENV_FILE" "$tmp_env" 2>/dev/null || chmod 600 "$tmp_env"
        mv "$tmp_env" "$ENV_FILE"
        echo "    neutralized stale CHROMADB_HOST/PORT in data/.env (game build does not use RAG)"
      } || rm -f "$tmp_env"
  fi

  return 0
}
cleanup_inherited_cruft || true

# ── FINDING #3 — restore data-dir + app-dir OWNERSHIP to the service user. Everything above ran as
# root (git reset, npm ci/build/prune, pip install, the embedding prefetch, the app.db cruft-cleanup),
# so freshly-written files (dist/, frontend/.venv, models/, app.db + its sidecars) are now root-owned —
# and the E85-hardened orwell-* services run UNPRIVILEGED, so a root-owned store makes the engine/FE
# fail to read or write and the UI "refuses to connect". Mirrors orwell-install.sh's ownership() (its
# `chown -R orwell:orwell "${APP_DIR}" "${DATA_DIR}"`) and orwell-oobe-reset.sh's post-scrub restore.
# Runs BEFORE the restart so the services boot able to write. Layout-agnostic + best-effort (a missing
# service user just skips it, with a warning); idempotent (re-chowning already-correct files is a no-op).
if [[ "$(id -u)" -eq 0 ]]; then
  if id "$SVC_USER" >/dev/null 2>&1; then
    echo "==> restoring ownership to ${SVC_USER}:${SVC_GROUP} (root-run build/deps/cleanup left files root-owned)"
    chown -R "$SVC_USER":"$SVC_GROUP" "$APP_DIR" "${APP_DIR}/data" 2>/dev/null || true
  else
    echo "WARN: service user '${SVC_USER}' not found — skipping ownership restore (set ORWELL_SERVICE_USER)"
  fi
fi


# Login health panel (ruling #21, 2026-06-11): greet interactive container shells with live
# health instead of a bare prompt. Time-bounded probes; guarded; can never block a login.
install -m 0755 "${APP_DIR}/deploy/orwell-login-panel.sh" /usr/local/bin/orwell-panel
if ! grep -qs 'orwell-panel' /etc/bash.bashrc; then
  cat >> /etc/bash.bashrc <<'PANEL'

# orwell login health panel (interactive shells only; guarded; never blocks)
case $- in *i*) [ -z "${ORWELL_PANEL_SHOWN:-}" ] && export ORWELL_PANEL_SHOWN=1 && /usr/local/bin/orwell-panel 2>/dev/null || true ;; esac
PANEL
fi

# Control-panel launcher: `orwell` opens the whiptail maintenance menu (deploy/orwell-menu.sh).
# Installed here too so a box provisioned before the menu existed gains it on its next update.
cat > /usr/local/bin/orwell <<LAUNCH
#!/usr/bin/env bash
exec bash "${APP_DIR}/deploy/orwell-menu.sh" "\$@"
LAUNCH
chmod 0755 /usr/local/bin/orwell

# `pct enter` minimal login shells omit /usr/local/bin from PATH, so `orwell` isn't found.
# Drop an idempotent profile.d snippet that ensures it's on PATH for login shells.
if [ ! -f /etc/profile.d/orwell-path.sh ]; then
  cat > /etc/profile.d/orwell-path.sh <<'PATHSH'
# orwell: ensure /usr/local/bin is on PATH (pct enter minimal login shells omit it)
case ":${PATH}:" in *:/usr/local/bin:*) ;; *) PATH="/usr/local/bin:${PATH}" ;; esac
PATHSH
  chmod 0644 /etc/profile.d/orwell-path.sh
fi

# Privileged UI port (<1024): reconcile the CAP_NET_BIND_SERVICE drop-in against the CURRENT
# ORWELL_PORT in data/.env (mirrors orwell-install.sh — the install may predate this fix, or the
# operator may have changed the port since). The hardened unit (E85) drops all capabilities, so
# without this a non-root uvicorn can never bind a port below 1024 and the FE crash-loops.
UI_PORT="$(sed -n 's/^ORWELL_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
UI_PORT="${UI_PORT:-8080}"
FRONTEND_DROPIN="/etc/systemd/system/${FRONTEND_SVC}.service.d/10-privileged-port.conf"
if [[ "$UI_PORT" =~ ^[0-9]+$ ]] && (( UI_PORT < 1024 )); then
  echo "==> ORWELL_PORT=${UI_PORT} is privileged (<1024): ensuring CAP_NET_BIND_SERVICE (drop-in)"
  mkdir -p "${FRONTEND_DROPIN%/*}"
  cat > "$FRONTEND_DROPIN" <<EOF
# Written by orwell-update.sh: ORWELL_PORT=${UI_PORT} is a privileged port (<1024).
# The base unit's empty CapabilityBoundingSet= is the audited default (E85); this grants the
# single capability a non-root bind below 1024 requires. Removed when the port moves >=1024.
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
EOF
else
  rm -f "$FRONTEND_DROPIN"
fi

# ── FINDING #1 — reconcile the long-running service unit CONTENT + host log policy (mirrors
# orwell-install.sh's systemd_services() + log_management(), which run on EVERY install). The updater
# historically installed only the G19b ops-trigger units below and NEVER these — so a box provisioned
# before the backup timer or the DEPLOY-13/14 log policy existed got NO scheduled backups and NO log
# rotation, a silent slow disk-fill. Re-install them here, idempotently. Gated on the modern
# /opt/orwell layout — the SAME guard the ops-unit reconcile below uses — because the shipped units and
# logrotate config hard-code /opt/orwell; aiming them at a pre-rename /opt/bbai tree would be worse than
# absent, so a legacy box instead gets ONE warning that it is not fully reconciled.
BACKUP_TIMER_READY=0
if [[ "$APP_DIR" == "/opt/orwell" ]]; then
  # (a) Service + backup unit content — the exact `install -m 644` set from systemd_services() (no
  #     substitutions, same as install copies them). The engine/frontend units are picked up by the
  #     daemon-reload + the existing final restart below; the backup TIMER is enabled + restarted after
  #     the daemon-reload (see below), mirroring systemd_services().
  echo "==> reconciling engine/frontend/backup unit content from the checkout"
  # orwell-backup.service sandboxes with ReadWritePaths=/opt/orwell/backups; systemd fails the unit with
  # 226/NAMESPACE when that path is missing. install creates it, but a box provisioned before the backup
  # timer existed (reconciled only by this updater) never got it — so the nightly backup failed forever.
  # Mirrors orwell-install.sh (DEPLOY-9); idempotent. The unit's ExecStartPre= re-creates it if removed.
  mkdir -p "${APP_DIR}/backups"
  if id -u orwell >/dev/null 2>&1; then chown orwell:orwell "${APP_DIR}/backups"; fi
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-engine.service"   /etc/systemd/system/orwell-engine.service
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-frontend.service" /etc/systemd/system/orwell-frontend.service
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-backup.service"   /etc/systemd/system/orwell-backup.service
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-backup.timer"     /etc/systemd/system/orwell-backup.timer
  BACKUP_TIMER_READY=1

  # (b) Host log policy — the shipped logrotate config + a journald SystemMaxUse cap (mirrors
  #     log_management()). A box installed before DEPLOY-13/14 has neither → the five ops-*.log files
  #     and the two services' journals grow unbounded on the same disk. `install -m 644` overwrites the
  #     logrotate config idempotently; the journald drop-in is a full-file REWRITE (never an append), so
  #     a re-run is a no-op. SystemMaxUse is overridable via ORWELL_JOURNAL_MAX_USE, same as install.
  install -m 644 "${APP_DIR}/deploy/logrotate/orwell" /etc/logrotate.d/orwell
  ORWELL_JOURNAL_CAP="${ORWELL_JOURNAL_MAX_USE:-300M}"
  mkdir -p /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/orwell.conf <<EOF
# Written by orwell-update.sh (DEPLOY-14, mirrors orwell-install.sh's log_management): cap persistent
# journal storage so orwell-engine / orwell-frontend's continuous logging can't slow-burn toward disk
# exhaustion on a small LXC disk. Override by editing this file and: systemctl restart systemd-journald
[Journal]
SystemMaxUse=${ORWELL_JOURNAL_CAP}
EOF
  systemctl restart systemd-journald 2>/dev/null || true
else
  # Legacy /opt/bbai box: ONE warning (the shipped units + logrotate config hard-code /opt/orwell).
  echo "WARN: app dir is ${APP_DIR} — the shipped systemd/logrotate units hard-code /opt/orwell, so the"
  echo "      engine/frontend/backup unit content, host log rotation, and the journald cap are NOT"
  echo "      reconciled on this legacy box. It is not fully converged to a fresh install (no scheduled"
  echo "      backups, no log rotation) and should be rebuilt on the current layout (deploy/orwell.sh)."
fi

# G19b — the web-triggered-update seam: reconcile the ops trigger units from the fresh checkout
# (mirrors the drop-in reconcile above — the install may predate G19b, and the units must track
# the repo). The E85-hardened FE (User=orwell, no systemctl) requests an update by dropping the
# flag data/ops/update-requested; the root-side path unit consumes it and runs THIS script,
# output appended to data/ops-update.log — the data/*.log surface the admin status page tails
# live (G1b). Root-by-design: the WHY lives in the unit files' own comments. Legacy /opt/bbai
# boxes are skipped — the units hard-code the modern /opt/orwell layout, and units pointing at
# a pre-rename tree would be worse than absent.
OPS_UNITS_READY=0
if [[ "$APP_DIR" == "/opt/orwell" && -f "${APP_DIR}/deploy/systemd/orwell-ops-update.path" ]]; then
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-update.path"    /etc/systemd/system/orwell-ops-update.path
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-update.service" /etc/systemd/system/orwell-ops-update.service
  # OPS-RUN FIX (ops-run lane): also (re)install the FACTORY-RESET watcher units here. They are why
  # the admin "Factory Reset (OOBE)" button silently no-op'd: the feature shipped in the repo but a
  # box installed before it (and never re-provisioned) never had these units — so the FE fell back
  # to a detached Popen run as the unprivileged `orwell` user, which the script's root-guard aborts
  # before scrubbing anything. Installing them on EVERY update means deploying the update is what
  # wires the watcher up on existing boxes. Reconcile only when the units exist in the checkout.
  if [[ -f "${APP_DIR}/deploy/systemd/orwell-ops-factory-reset.path" ]]; then
    install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-factory-reset.path"    /etc/systemd/system/orwell-ops-factory-reset.path
    install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-factory-reset.service" /etc/systemd/system/orwell-ops-factory-reset.service
    touch "${APP_DIR}/data/ops-factory-reset.log"
    chmod 644 "${APP_DIR}/data/ops-factory-reset.log"
  fi
  # The flag dir is orwell-OWNED (the web tier writes the flag; root consumes it; the flag's
  # content is ignored — existence only) and the live log exists ahead of the first run,
  # FE-readable (the status page tails it). The log is touched, never truncated by a re-run.
  install -d -m 750 "${APP_DIR}/data/ops"
  if id -u orwell >/dev/null 2>&1; then chown orwell:orwell "${APP_DIR}/data/ops"; fi
  touch "${APP_DIR}/data/ops-update.log"
  chmod 644 "${APP_DIR}/data/ops-update.log"
  OPS_UNITS_READY=1
fi
# Combined Update + Reset trigger (admin "Update + Reset" button): reconcile its units too so a box
# installed before this tier gains the seam on its next update. Same G19b shape — the web tier
# drops data/ops/update-reset-requested, the root path unit runs orwell-update-reset.sh --yes,
# output appended to data/ops-update-reset.log (the status page tails it live).
OPS_UPDATE_RESET_READY=0
if [[ "$APP_DIR" == "/opt/orwell" && -f "${APP_DIR}/deploy/systemd/orwell-ops-update-reset.path" ]]; then
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-update-reset.path"    /etc/systemd/system/orwell-ops-update-reset.path
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-update-reset.service" /etc/systemd/system/orwell-ops-update-reset.service
  install -d -m 750 "${APP_DIR}/data/ops"
  if id -u orwell >/dev/null 2>&1; then chown orwell:orwell "${APP_DIR}/data/ops"; fi
  touch "${APP_DIR}/data/ops-update-reset.log"
  chmod 644 "${APP_DIR}/data/ops-update-reset.log"
  OPS_UPDATE_RESET_READY=1
fi
# Public-deployment trigger (admin "Connect to the internet" wizard, feature 0068): reconcile its
# units too so a box installed before this feature gains the seam on its next update. Same G19b
# shape — the web tier drops data/ops/public-deployment-requested, the root path unit runs
# orwell-ops-public-deployment.sh, output appended to data/ops-public-deployment.log.
OPS_PUBLIC_DEPLOYMENT_READY=0
if [[ "$APP_DIR" == "/opt/orwell" && -f "${APP_DIR}/deploy/systemd/orwell-ops-public-deployment.path" ]]; then
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-public-deployment.path"    /etc/systemd/system/orwell-ops-public-deployment.path
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-public-deployment.service" /etc/systemd/system/orwell-ops-public-deployment.service
  install -d -m 750 "${APP_DIR}/data/ops"
  if id -u orwell >/dev/null 2>&1; then chown orwell:orwell "${APP_DIR}/data/ops"; fi
  touch "${APP_DIR}/data/ops-public-deployment.log"
  chmod 644 "${APP_DIR}/data/ops-public-deployment.log"
  OPS_PUBLIC_DEPLOYMENT_READY=1
fi
# Local-HTTPS trigger (admin "Local HTTPS" card, feature 0074 / ADR 0014): reconcile its units too so
# a box installed before this feature gains the seam on its next update. Same G19b shape — the web tier
# drops data/ops/tls-requested, the root path unit runs orwell-ops-tls.sh, output appended to
# data/ops-tls.log.
OPS_TLS_READY=0
if [[ "$APP_DIR" == "/opt/orwell" && -f "${APP_DIR}/deploy/systemd/orwell-ops-tls.path" ]]; then
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-tls.path"    /etc/systemd/system/orwell-ops-tls.path
  install -m 644 "${APP_DIR}/deploy/systemd/orwell-ops-tls.service" /etc/systemd/system/orwell-ops-tls.service
  install -d -m 750 "${APP_DIR}/data/ops"
  if id -u orwell >/dev/null 2>&1; then chown orwell:orwell "${APP_DIR}/data/ops"; fi
  touch "${APP_DIR}/data/ops-tls.log"
  chmod 644 "${APP_DIR}/data/ops-tls.log"
  OPS_TLS_READY=1
fi
systemctl daemon-reload
if [[ "$OPS_UNITS_READY" -eq 1 ]]; then
  # The ops TRIGGER is the path unit (its service is started by the watcher, never enabled).
  # `enable --now` no-ops when already running; the restart re-arms it with any fresh unit
  # config — restarting the PATH unit never touches a run already in flight (separate unit).
  systemctl enable --now orwell-ops-update.path
  systemctl restart orwell-ops-update.path
  # OPS-RUN FIX (ops-run lane): arm the factory-reset watcher too, so the admin OOBE button works.
  if [[ -f /etc/systemd/system/orwell-ops-factory-reset.path ]]; then
    systemctl enable --now orwell-ops-factory-reset.path
    systemctl restart orwell-ops-factory-reset.path
  fi
fi
if [[ "$OPS_UPDATE_RESET_READY" -eq 1 ]]; then
  systemctl enable --now orwell-ops-update-reset.path
  systemctl restart orwell-ops-update-reset.path
fi
if [[ "$OPS_PUBLIC_DEPLOYMENT_READY" -eq 1 ]]; then
  systemctl enable --now orwell-ops-public-deployment.path
  systemctl restart orwell-ops-public-deployment.path
fi
if [[ "$OPS_TLS_READY" -eq 1 ]]; then
  systemctl enable --now orwell-ops-tls.path
  systemctl restart orwell-ops-tls.path
fi
# FINDING #1 — arm the scheduled-backup timer now that daemon-reload has picked up the freshly
# reconciled unit (mirrors systemd_services()): enable the TIMER (never the .service — no [Install]).
# `enable --now` no-ops when already running; the restart just resets its next-fire countdown and
# does NOT run an out-of-schedule backup, so a re-run never triggers an extra snapshot. (The
# engine/frontend units are handled by the existing final restart below.)
if [[ "$BACKUP_TIMER_READY" -eq 1 ]]; then
  systemctl enable --now orwell-backup.timer
  systemctl restart orwell-backup.timer
fi

# ops-progress lane: terminal OK. Clear the trap before the success write so the EXIT trap can't
# re-stamp it. (The FE restart below can kill this very process if it is the FE — but the updater
# runs detached / under the root ops watcher, not under the FE unit, so it survives to here.)
if [[ "$NO_RESTART" -eq 1 ]]; then
  # --no-restart: the composed Update + Reset tier owns the SINGLE final restart, so the OOBE reset
  # that runs next will publish its own restart/OOBE-ready progress. Mark the update phase done.
  echo "==> --no-restart: build is in place but services were NOT restarted (the caller restarts)."
  trap - EXIT
  ops_progress_done "updated — handing off to the reset for the final restart"
else
  echo "==> restart services (${ENGINE_SVC}, ${FRONTEND_SVC})"
  ops_progress_step 4 "restarting services"
  systemctl restart "$ENGINE_SVC" "$FRONTEND_SVC"
  trap - EXIT
  ops_progress_done "updated — services restarting"
fi
echo "==> update complete ($(git -C "$APP_DIR" rev-parse --short HEAD)); previous build kept for --rollback."
