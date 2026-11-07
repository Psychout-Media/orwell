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

# ORW-229: a fingerprint of THIS updater's own text, taken before the fetch below replaces the file on disk. It
# is part of the install record, so a change to HOW this script installs (flags, steps) forces one full
# reinstall. Unreadable (e.g. run as `bash -c "..."`) => a value that never matches, i.e. always the full install.
__UPDATER_FP=""
if [[ -r "${BASH_SOURCE[0]:-}" ]]; then
  __UPDATER_FP="$( { sha256sum < "${BASH_SOURCE[0]}" || shasum -a 256 < "${BASH_SOURCE[0]}"; } 2>/dev/null | cut -d' ' -f1 || true)"
fi
[[ -n "$__UPDATER_FP" ]] || __UPDATER_FP="unknown-$$-${RANDOM}"

APP_DIR_EXPLICIT="${APP_DIR:-}"     # honor an explicit override; otherwise auto-detect below
BRANCH="${BRANCH:-main}"
# B71/ops A4 — pin + rollback:
#   REF=<sha|tag>          update to a PINNED ref (a tag, a full SHA, or an abbreviated SHA) instead of
#                          the branch tip
#   orwell-update.sh --rollback   return to the previous build (SHA + dist) recorded by the last update
#
# A failed update leaves a RUNNABLE app: on ANY failure once the update has begun (fetch, npm, pip, env
# reconcile, unit reconcile) the previous SHA, its engine + front-end dependencies and its dist are
# restored, and the restored build is verified to start BEFORE "reverted" is printed or recorded. If the
# revert itself fails the script says so plainly. Exit codes: 0 ok · 1 failed, previous build in place
# (restored + verified, or never touched) · 3 failed AND the revert failed (the box may not start) ·
# 75 another update already holds the lock.
# The rollback pair (data/.update-prev + dist.prev) moves together, only when an update fully succeeds.
# One shared flock (/run/orwell-update.lock) keeps the web Update, Update+Reset and a manual run from
# working in the same tree at once.
# A4/ruling #17 — private-repo token (one-time setup / annual rotation for an EXISTING install):
#   orwell-update.sh --set-token  prompt for (or take GIT_TOKEN=) the deploy PAT, persist it into
#                                 data/.env, and wire the git credential helper — then exit.
#   orwell-update.sh --no-restart do the full update but SKIP the final `systemctl restart` — used
#                                 by the composed Update + Reset tier (orwell-update-reset.sh) so the
#                                 OOBE reset that follows owns the single final restart.
REF="${REF:-}"
ROLLBACK=0; SET_TOKEN=0; NO_RESTART=0
# ORW-206 — live-game guard: before the build/restart the updater DEFERS while a player has chatted in the
# last ORWELL_UPDATE_IDLE_MINUTES (default 15), polling until idle, then runs by itself; it gives up waiting
# after ORWELL_UPDATE_MAX_DEFER_MINUTES (default 240). `--force` (or ORWELL_UPDATE_FORCE=1) skips the check.
# Status: /run/orwell/update-deferred (root-owned; also the web Update page via update-status.json; also shown by `orwell-doctor.sh --status`). See deploy/orwell-live-game.sh.
FORCE=0; [[ "${ORWELL_UPDATE_FORCE:-}" == "1" ]] && FORCE=1
# --no-restart: do the full update (pull → rebuild → refresh deps → reconcile units) but SKIP the
# final `systemctl restart`. Added for the composed Update + Reset tier (orwell-update-reset.sh),
# which runs the update with restart suppressed and lets the OOBE reset perform the SINGLE final
# restart. Additive guard only — it never changes what the update builds. Accepted in any position.
for __a in "$@"; do
  case "$__a" in
    --rollback)   ROLLBACK=1 ;;
    --set-token)  SET_TOKEN=1 ;;
    --no-restart) NO_RESTART=1 ;;
    --force)      FORCE=1 ;;
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

# ── live-game guard lib (ORW-206). Missing ⇒ the check is simply skipped (fail open: an update must never
# be blocked by its own guard). Searched like the libs above, so the pushed /tmp copy finds it too.
for __lg in "${__here}/orwell-live-game.sh" /opt/orwell/deploy/orwell-live-game.sh /opt/bbai/deploy/orwell-live-game.sh; do
  if [[ -n "${__lg:-}" && -r "$__lg" ]]; then . "$__lg"; break; fi
done

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

# REF reaches `git fetch` (and, over the host→container bridge, a quoted shell string): accept only what a
# tag / SHA / ref name can contain and never a leading "-" (option injection).
if [[ -n "$REF" && ! "$REF" =~ ^[A-Za-z0-9_][A-Za-z0-9._/@+-]*$ ]]; then
  echo "ERROR: REF='${REF}' is not a valid tag or commit SHA." >&2
  exit 1
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
    # The token file must not outlive this run on ANY exit (a failed push, Ctrl-C, set -e): EXIT trap.
    TMP_TOKEN="$(mktemp /tmp/orwell-token-XXXXXX)"
    trap 'rm -f "$TMP_TOKEN"' EXIT
    trap 'exit 130' INT TERM
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
  [[ $FORCE -eq 1 ]] && FWD_FLAG="${FWD_FLAG:+$FWD_FLAG }--force"
  # Live-game guard tunables ride along (digits only, so nothing can inject into the quoted string).
  FWD_LG=""
  for __k in ORWELL_UPDATE_IDLE_MINUTES ORWELL_UPDATE_MAX_DEFER_MINUTES ORWELL_UPDATE_DEFER_POLL_SECONDS; do
    [[ "${!__k:-}" =~ ^[0-9]+$ ]] && FWD_LG="${FWD_LG} ${__k}='${!__k}'"
  done
  FWD_ENV="export ${APP_DIR_EXPLICIT:+APP_DIR='${APP_DIR_EXPLICIT}' }BRANCH='${BRANCH}' REF='${REF}'${FWD_LG};"
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

# ORW-229: onnxruntime-node's postinstall downloads its GPU (CUDA / TensorRT) execution providers from nuget on
# every `npm ci` (about 45 s of a 55 s install on the dev box). The engine never loads them: fastembed runs
# onnxruntime on the CPU, and the CPU runtime ships inside the npm package. So every npm ci / npm install this
# script runs (build, build-tools restore, revert, rollback) skips that download; an operator's explicit value
# still wins. Proven on the dev box: after a clean `npm ci` with the skip the engine boots with fastembed and
# `orwell-doctor.sh --status` reports `embeddings: provider=fastembed, degraded=false`. (Same in orwell-install.sh.)
export ONNXRUNTIME_NODE_INSTALL="${ONNXRUNTIME_NODE_INSTALL:-skip}"

# ── ORW-206: don't restart the app in the middle of a live game. Runs BEFORE the update lock on purpose:
# a deferred run holds nothing, so `--force`, --rollback and a manual run are never blocked behind it.
# Only a plain update is guarded: --rollback / --set-token are operator actions, and --no-restart is the
# composed Update + Reset tier (an explicit wipe whose reset owns the restart).
# The web Update page polls data/ops/update-status.json: tell it we are DEFERRED (not hung), via the same
# safe ops-progress writer the update itself uses.
update_defer_notify() {
  if [[ -z "${__UD_PROGRESS:-}" ]]; then
    __UD_PROGRESS=1; export ORWELL_OPS_DIR="${APP_DIR%/}/data/ops"; ops_progress_init "update" 5
  fi
  ops_progress_step 0 "$1"
}
update_defer_cancelled() { [[ -n "${__UD_PROGRESS:-}" ]] && ops_progress_fail "update deferral was cancelled before it started" || true; }
if [[ $ROLLBACK -eq 0 && $SET_TOKEN -eq 0 && $NO_RESTART -eq 0 ]] && type update_wait_for_idle_game >/dev/null 2>&1; then
  update_wait_for_idle_game "${ORWELL_FE_DATA_DIR:-${APP_DIR}/frontend/data}/app.db" "${APP_DIR%/}/data/ops" "$FORCE" "${APP_DIR}/data/.env"
fi

# ── ONE shared lock for every run in this tree: the web Update, Update + Reset, a manual update,
# --rollback and --set-token (all write the checkout, node_modules, dist and data/.env). It is a
# DIFFERENT file from the per-unit locks in deploy/systemd/orwell-ops-*.service (those only dedupe
# repeat triggers of ONE unit — each takes its own /run/orwell-ops-<unit>.lock on fd 9 and then execs
# THIS script), so there is no lock-order cycle with them. flock is per open-file-description: a child
# that re-opened the file would block on its parent's lock. So orwell-update-reset.sh — which holds this
# lock across BOTH its phases and runs this script as a child — hands the open fd down via
# ORWELL_UPDATE_LOCK_FD, and an inherited fd is honoured only when it really is this lock file (a stale
# exported variable cannot bypass the lock). Non-blocking by design: a second run refuses (75) rather
# than queueing a redundant build; it never touches the running run's ops status. Released when the
# process exits (the fd dies with it). orwell-update-reset.sh takes the same file — keep them in sync.
UPDATE_LOCK="${ORWELL_UPDATE_LOCK:-/run/orwell-update.lock}"
acquire_update_lock() {
  local held="${ORWELL_UPDATE_LOCK_FD:-}"
  if [[ "$held" =~ ^[0-9]+$ && /proc/self/fd/$held -ef "$UPDATE_LOCK" ]]; then
    # Same file is not enough: an open-but-UNLOCKED descriptor must not bypass serialization. Re-locking
    # the same open file description (the parent's) succeeds; anyone else's lock makes this fail.
    if flock -n "$held" 2>/dev/null; then return 0; fi
    echo "ERROR: the inherited update-lock fd ${held} does not hold ${UPDATE_LOCK} (another run owns it)." >&2
    exit 75
  fi
  command -v flock >/dev/null 2>&1 || { echo "ERROR: flock (util-linux) is required to serialize updates." >&2; exit 1; }
  exec {ORWELL_UPDATE_LOCK_FD}>>"$UPDATE_LOCK" \
    || { echo "ERROR: cannot open the update lock ${UPDATE_LOCK}." >&2; exit 1; }
  if ! flock -n "$ORWELL_UPDATE_LOCK_FD"; then
    echo "ERROR: another orwell update / rollback / Update + Reset is already running in this tree (lock ${UPDATE_LOCK})." >&2
    echo "       Refusing to run two at once. Watch it with: tail -f ${APP_DIR}/data/ops-update.log — then retry." >&2
    exit 75
  fi
  export ORWELL_UPDATE_LOCK_FD
}
acquire_update_lock

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
PREV_DIST="${APP_DIR}/dist.prev"              # the last good build output — stamped with PREV_FILE's SHA
STAGED_DIST="${APP_DIR}/dist.staging"         # the RUNNING build, held aside while an update is in flight
DIST_STAMP=".orwell-build-sha"                # inside dist.prev / dist.staging: the SHA that build came from
DEPS_STAMP="${APP_DIR}/dist/.orwell-deps-stamp"   # ORW-229: what the last FULLY successful update installed (see below)
PLAY_DIR="${APP_DIR}/frontend/web"            # ORW-229: the React /play app (absent on commits that predate it)
PLAY_DIST="${PLAY_DIR}/dist"                  # what the front end serves at /play
PLAY_NEXT="${PLAY_DIR}/dist.next"             # a finished build waiting for the commit point
PLAY_PREV="${PLAY_DIR}/dist.prev"             # the build it replaced (reused by --rollback / an update back)
PLAY_STAMP=".orwell-web-inputs"               # inside a /play build: the fingerprint of the inputs it was built from
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
  # This path runs as root, so a freshly created/renamed data/.env would be root-owned and the
  # unprivileged service could no longer read its own config. Keep the owner/group of the existing
  # file (or, for a first token, of the data dir the installer chowned to the service user).
  OWNER_REF="$ENV_FILE"; [[ -e "$OWNER_REF" ]] || OWNER_REF="${APP_DIR}/data"
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  # Rotate in place: drop any previous GIT_TOKEN line, then append the new one. The temp file holds
  # the token, so it is removed on any exit.
  TMP_ENV="$(mktemp "${APP_DIR}/data/.env.XXXXXX")"
  trap 'rm -f "$TMP_ENV"' EXIT
  trap 'exit 130' INT TERM
  grep -v '^GIT_TOKEN=' "$ENV_FILE" > "$TMP_ENV" || true
  printf 'GIT_TOKEN=%s\n' "$TOKEN" >> "$TMP_ENV"
  chmod 600 "$TMP_ENV"
  chown --reference="$OWNER_REF" "$TMP_ENV" 2>/dev/null || true
  mv "$TMP_ENV" "$ENV_FILE"
  trap - EXIT
  wire_credential_helper
  echo "==> deploy token saved to ${ENV_FILE} and git credential helper wired."
  echo "    Rotation: re-run 'orwell-update.sh --set-token' (fine-grained PATs cap at one year)."
  exit 0
fi

wire_credential_helper

# ── Update / rollback safety net ───────────────────────────────────────────────────────────────
# An update dirties three things; each step sets its flag BEFORE it runs, so a revert only redoes what
# the failed run could have damaged. (A fetch that failed on a network blip must not trigger an
# `npm ci` that needs the same network and deletes node_modules for nothing.)
ENGINE_DIRTY=0   # `npm ci` deletes node_modules first
FE_DIRTY=0       # pip install into frontend/.venv
DIST_DIRTY=0     # `npm run build` rewrites dist/
HOST_TOUCHED=0   # the host reconcile (units, log policy, login panel) started — it is NOT undone by a revert

install_frontend_deps() {   # cwd = frontend/
  # Pinned lockfile first (audit E83): updates re-install exactly what CI tested, never a blind
  # re-resolution of unpinned ranges.
  if [[ -f requirements.lock.txt ]]; then
    ./.venv/bin/pip install -q -r requirements.lock.txt
  else
    ./.venv/bin/pip install -q -r requirements.txt
  fi
}

# Sets TARGET to what to reset to. `git fetch origin <tag>` lands the ref in FETCH_HEAD ONLY (no local
# tag is created), so the old `git reset --hard <tag>` exited 128 — resolve what was fetched to a commit
# SHA and reset to that. Annotated tags peel to their commit; a full SHA is fetched directly. An
# abbreviated SHA (or a SHA the server will not serve unadvertised) is resolved after fetching tags +
# branches — and, because this checkout is shallow (--depth 1, like the branch fetch), after deepening
# to the full history if it is older than the shallow tip. The PREVIOUS commit stays available for
# --rollback via the refs/orwell/update-prev pin written by commit_rollback_pair.
fetch_target() {
  if [[ -n "$REF" ]]; then
    TARGET=""
    if git -C "$APP_DIR" fetch --depth 1 origin "$REF"; then
      TARGET="$(git -C "$APP_DIR" rev-parse --verify --quiet 'FETCH_HEAD^{commit}' || true)"
    else
      echo "==> '${REF}' is not an advertised tag/branch — fetching tags + branches to resolve it as a commit"
      git -C "$APP_DIR" fetch --tags origin
      TARGET="$(git -C "$APP_DIR" rev-parse --verify --quiet "${REF}^{commit}" || true)"
      if [[ -z "$TARGET" && "$(git -C "$APP_DIR" rev-parse --is-shallow-repository)" == "true" ]]; then
        echo "==> not in the shallow checkout — fetching the full history to resolve it"
        git -C "$APP_DIR" fetch --unshallow --tags origin
        TARGET="$(git -C "$APP_DIR" rev-parse --verify --quiet "${REF}^{commit}" || true)"
      fi
    fi
    if [[ -z "$TARGET" ]]; then
      echo "ERROR: REF='${REF}' does not resolve to a commit on origin (tag, full SHA, or abbreviated SHA expected)." >&2
      return 1
    fi
    echo "==> REF ${REF} -> ${TARGET}"
  else
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    TARGET="origin/${BRANCH}"
  fi
}

# Every build is stamped (dist/.orwell-build-sha) with the SHA it was built from: written after a good
# build, and removed BEFORE one starts so a partial dist is never stamped.
stamp_dist() { git -C "$APP_DIR" rev-parse HEAD > "${APP_DIR}/dist/${DIST_STAMP}"; }

# Hold the RUNNING build aside for this attempt. It is the only copy a failed update can restore, and it
# never touches dist.prev — the rollback pair is replaced only when an update fully succeeds
# (commit_rollback_pair), so a failed attempt cannot pair an older SHA with a newer build. The stamp
# is kept only if it proves this build came from the SHA being left (HEAD); a build with no stamp, or
# another SHA's, is still restorable on failure but is never trusted as a rollback target.
snapshot_running_dist() {
  rm -rf "$STAGED_DIST"
  [[ -d "${APP_DIR}/dist" ]] || return 0
  cp -a "${APP_DIR}/dist" "$STAGED_DIST"
  if [[ "$(cat "${STAGED_DIST}/${DIST_STAMP}" 2>/dev/null || true)" != "$PREV_SHA" ]]; then
    rm -f "${STAGED_DIST}/${DIST_STAMP}"
  fi
}

# ── ORW-229 — fast updates: skip the reinstalls and rebuilds a commit does not need ────────────────────
# Measured on the production box: every update ran `npm ci` (35-50 s, once 2 min) and `pip install`
# (several seconds), although the lockfiles almost never change. The deps stamp (DEPS_STAMP, beside the
# build stamp in the root-owned dist/) records, for the last update that FULLY succeeded:
#   engine_inputs / engine_deps / frontend_inputs — what each step consumed at that commit: the git object
#       ids of the tracked files it reads, plus the tool versions;
#   engine_tree / engine_dist / frontend_tree — what the step LEFT on disk: npm's own hidden lockfile
#       (node_modules/.package-lock.json, rewritten by every npm ci / install / prune), the bytes of the
#       engine build, and the venv's installed-distribution list.
# A step is skipped only when BOTH match: the target commit feeds it exactly the same inputs AND the tree
# on disk is byte-for-byte the one that update left (a manual npm/pip run, a re-run installer or a
# half-finished install all change the witness). The stamp is read and DELETED before this run touches
# anything (and by --rollback) and written again only after the commit point, so a missing stamp — the
# first run with this updater, a fresh install, or a previous update / rollback that failed, was reverted
# or was interrupted — always means the full reinstall, exactly as before. It is only believed when it, and
# the trees it vouches for, belong to the account running this updater and nobody else can write them.
DEPS_STAMP_TEXT=""
ENGINE_INPUTS_FP=""; ENGINE_DEPS_FP=""; FRONTEND_DEPS_FP=""
PLAY_TMP=""                                   # the /play temp build dir while one exists (removed on every exit path)

_fp_sum() { { sha256sum 2>/dev/null || shasum -a 256 2>/dev/null; } | cut -d' ' -f1; }
# Both the same KNOWN value ("" / "none" = could not be computed, never a match).
_same() { [[ -n "$1" && "$1" != none && "$1" == "$2" ]]; }
# A key of the stamp this run read at its start (hex digests / SHAs only; anything else reads as "").
stamp_get() { sed -n "s/^${1}=\([0-9a-f]\{40,64\}\)\$/\1/p" <<<"$DEPS_STAMP_TEXT" | tail -n1; }
# Owned by the account running this updater (root in production) and not group/other-writable, so no other
# account — e.g. the service user, on a box whose code tree predates the root-owned layout — can have planted
# or edited it. The ownership pass later in this run fixes such a tree; until then the stamp is not believed.
_owned_by_us() {
  local st
  [[ -e "$1" && ! -L "$1" ]] || return 1
  st="$(stat -c '%u %a' -- "$1" 2>/dev/null)" || return 1
  [[ "${st%% *}" == "$(id -u)" ]] && (( (8#${st##* } & 8#022) == 0 ))
}
read_deps_stamp() {
  local p
  for p in "$DEPS_STAMP" "${APP_DIR}/dist" "${APP_DIR}/node_modules" "${APP_DIR}/frontend/.venv"; do
    _owned_by_us "$p" || return 0
  done
  if [[ -f "$DEPS_STAMP" ]]; then head -c 4096 "$DEPS_STAMP" || true; fi
  return 0
}

# Engine inputs: every tracked top-level entry at HEAD EXCEPT the ones that never reach dist/ or
# node_modules (the Python front end, deploy scripts, docs, tests, BDD steps, CI + agent config, root
# *.md). Deny by default: a new top-level file or dir counts as an input until it is listed here. Plus
# node + npm: a node upgrade changes the native addons `npm ci` would fetch.
_ENGINE_NOT_INPUTS='^(frontend|deploy|docs|tests|features|[.]github|[.]claude)$|[.]md$'
engine_inputs_fp() {
  local tree; tree="$(git -C "$APP_DIR" ls-tree HEAD 2>/dev/null)" || { echo none; return 0; }
  { node -v || true; npm -v || true; awk -F'\t' -v re="$_ENGINE_NOT_INPUTS" '$2 !~ re' <<<"$tree"; } 2>/dev/null | _fp_sum
}
# What `npm ci` itself consumes, plus this updater's own text (how it installs).
# The npm environment and config that change what an install produces: npm_config_* / NPM_CONFIG_* (registry,
# omit/include, ignore-scripts, ...), ONNXRUNTIME_NODE_INSTALL*, NODE_ENV, and the user + global npmrc files.
# Only ever hashed (an npmrc or an npm_config_ value can hold a registry token). Computed once per run.
_NPM_ENV_FP=""
npm_env_fp() {
  local f
  if [[ -z "$_NPM_ENV_FP" ]]; then
    _NPM_ENV_FP="$( {
      env | LC_ALL=C grep -E '^(npm_config_|NPM_CONFIG_|ONNXRUNTIME_NODE_INSTALL|NODE_ENV=)' | LC_ALL=C sort || true
      for f in "${HOME:-/root}/.npmrc" "$(npm config get globalconfig 2>/dev/null || true)"; do
        if [[ -n "$f" && -f "$f" ]]; then printf 'npmrc %s %s\n' "$f" "$(_fp_sum < "$f")"; fi
      done
    } 2>/dev/null | _fp_sum )"
  fi
  printf '%s' "$_NPM_ENV_FP"
}
engine_deps_fp() {
  local tree; tree="$(git -C "$APP_DIR" ls-tree HEAD -- package.json package-lock.json npm-shrinkwrap.json patches .npmrc 2>/dev/null)" || { echo none; return 0; }
  { node -v || true; npm -v || true; printf 'updater=%s\nnpmenv=%s\n%s\n' "$__UPDATER_FP" "$(npm_env_fp)" "$tree"; } 2>/dev/null | _fp_sum
}
# What install_frontend_deps consumes, plus the venv's interpreter and this updater's own text.
frontend_deps_fp() {
  local tree; tree="$(git -C "$APP_DIR" ls-tree HEAD -- frontend/requirements.lock.txt frontend/requirements.txt 2>/dev/null)" || { echo none; return 0; }
  { "${APP_DIR}/frontend/.venv/bin/python" -V || true; printf 'updater=%s\n%s\n' "$__UPDATER_FP" "$tree"; } 2>/dev/null | _fp_sum
}
# What the /play build consumes: all of frontend/web (lockfile, src, config) and frontend/static/js (the
# classic markdown module /play imports through its `@classic` alias), plus node + npm and this updater's text.
play_inputs_fp() {
  local tree; tree="$(git -C "$APP_DIR" ls-tree HEAD -- frontend/web frontend/static/js 2>/dev/null)" || { echo none; return 0; }
  { node -v || true; npm -v || true; printf 'updater=%s\nnpmenv=%s\n%s\n' "$__UPDATER_FP" "$(npm_env_fp)" "$tree"; } 2>/dev/null | _fp_sum
}
# Every entry under a tree: directories by name, files and links by name + size + mtime (+ link target), so a file
# edited in place shows even when npm's / pip's own records stay the same. Bytecode caches are not package content.
_tree_listing() {
  find "$1" -xdev -name __pycache__ -prune -o -type d -printf 'd %P\n' -o ! -name '*.pyc' -printf '%y %P %s %T@ %l\n' 2>/dev/null \
    | LC_ALL=C sort
}
engine_tree_witness() {   # npm's hidden lockfile (rewritten by every npm ci / install / prune) + the whole tree
  local d="${APP_DIR}/node_modules"
  if [[ -f "${d}/.package-lock.json" && ! -L "${d}/.package-lock.json" ]]; then
    { _fp_sum < "${d}/.package-lock.json"; _tree_listing "$d"; } | _fp_sum
  else
    echo none
  fi
}
dist_witness() {
  local d="${APP_DIR}/dist"
  if [[ -f "${d}/main.js" && -f "${d}/embedWorker.js" ]]; then cat "${d}/main.js" "${d}/embedWorker.js" | _fp_sum; else echo none; fi
}
frontend_tree_witness() {   # the venv's site-packages: installed distributions and every package file
  local sp
  for sp in "${APP_DIR}/frontend/.venv/lib"/python*/site-packages; do
    [[ -d "$sp" ]] || continue
    _tree_listing "$sp" | _fp_sum
    return 0
  done
  echo none
}

# What the engine step has to do for HEAD. Prints <plan>:<why>:
#   reuse  nothing dist/ or node_modules depends on changed — keep both, no npm at all;
#   chain  the dependencies did not change (node_modules is exactly the pruned runtime tree the last update
#          left), only the code did — put back just the build tools `npm prune` removed, from the local npm
#          cache, instead of a full `npm ci` that deletes and re-downloads everything;
#   full   anything else — the full `npm ci`, as before.
engine_plan() {
  if [[ -z "$DEPS_STAMP_TEXT" ]]; then
    echo "full:no record of a completed update (the first run with this updater, or the last update / rollback did not finish)"; return 0
  fi
  if ! _same "$(stamp_get engine_tree)" "$(engine_tree_witness)"; then echo "full:node_modules is not the tree the last successful update left"; return 0; fi
  if ! _same "$(stamp_get engine_deps)" "$ENGINE_DEPS_FP"; then echo "full:package.json, package-lock.json, patches/ or the node / npm version changed"; return 0; fi
  if _same "$(stamp_get engine_inputs)" "$ENGINE_INPUTS_FP" && _same "$(stamp_get engine_dist)" "$(dist_witness)"; then echo "reuse:"; return 0; fi
  echo "chain:"
}
frontend_deps_unchanged() {
  [[ -n "$DEPS_STAMP_TEXT" ]] && _same "$(stamp_get frontend_inputs)" "$FRONTEND_DEPS_FP" \
    && _same "$(stamp_get frontend_tree)" "$(frontend_tree_witness)"
}
# Written only after the commit point. The input fingerprints are the ones this run planned with; the
# witnesses are taken now, from what the run leaves behind.
write_deps_stamp() {
  local tmp
  [[ -d "${APP_DIR}/dist" && ! -L "${APP_DIR}/dist" ]] || return 1
  tmp="$(mktemp "${APP_DIR}/dist/.orwell-deps-stamp.XXXXXX")" || return 1
  if printf 'sha=%s\nengine_inputs=%s\nengine_deps=%s\nengine_tree=%s\nengine_dist=%s\nfrontend_inputs=%s\nfrontend_tree=%s\n' \
       "$(git -C "$APP_DIR" rev-parse HEAD)" "${ENGINE_INPUTS_FP:-none}" "${ENGINE_DEPS_FP:-none}" \
       "$(engine_tree_witness)" "$(dist_witness)" "${FRONTEND_DEPS_FP:-none}" "$(frontend_tree_witness)" > "$tmp" \
     && chmod 644 "$tmp" && mv -f "$tmp" "$DEPS_STAMP"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# ── ORW-229 — the React /play app (frontend/web; the front end serves frontend/web/dist at /play) ───────
# Built only when the target commit has frontend/web/package.json, and NON-FATALLY: a failed build logs a
# warning and the update carries on — the classic UI is the game, and /play keeps its current build (or its
# "not built yet" 503 page if it never had one). Skipped when nothing it is built from changed. It builds a
# clean export of the commit in a temp dir, so the live dist/ is never emptied or half-written while vite
# runs; the finished build waits in dist.next and goes live only after the commit point (swap_play_app),
# so a failed or reverted update never changes what /play serves. Each build carries the fingerprint of its
# inputs (PLAY_STAMP).
play_build_fp() {   # the inputs fingerprint a /play build dir was made from; "" unless it is a complete build
  [[ -f "${1}/index.html" && -f "${1}/${PLAY_STAMP}" && ! -L "${1}/${PLAY_STAMP}" ]] || return 0
  head -c 64 "${1}/${PLAY_STAMP}" | tr -cd '0-9a-f'
}
# Copy a finished /play build to dist.next. dist.next must not exist when the copy starts (removed, then
# checked), so a leftover — or anything planted there — is never merged into or nested under. A build is plain
# files and directories only: one with a symlink, device or FIFO in it is refused, and the copy belongs to root
# like the rest of the code tree (the build account's ownership is not kept).
_stage_play_build() {
  rm -rf "$PLAY_NEXT"
  [[ ! -e "$PLAY_NEXT" && ! -L "$PLAY_NEXT" ]] || return 1
  if [[ -n "$(find "$1" ! -type f ! -type d -print -quit 2>/dev/null)" ]]; then
    echo "WARN: the /play build contains something other than files and directories — refusing it"
    return 1
  fi
  cp -RT --preserve=mode,timestamps "$1" "$PLAY_NEXT" && return 0
  rm -rf "$PLAY_NEXT"
  return 1
}
# Who runs the /play build: never root. Building /play runs its dependencies' code (tsc, vite, plugins), so as root
# it runs as an unprivileged account (ORWELL_PLAY_BUILD_USER, default `nobody`) that can neither write the code tree
# nor read the service user's data/.env, in a clean environment (nothing of this script's environment reaches it),
# with its own npm cache (ORWELL_PLAY_NPM_CACHE). Root takes the output back before reading it, so nothing the build
# left running can change it afterwards. If privileges cannot be dropped, /play is not built at all.
ORWELL_PLAY_BUILD_USER="${ORWELL_PLAY_BUILD_USER:-nobody}"
ORWELL_PLAY_NPM_CACHE="${ORWELL_PLAY_NPM_CACHE:-/var/cache/orwell/play-npm}"
_PLAY_BUILD_CMD='cd "$1" && npm ci --prefer-offline --ignore-scripts --no-audit --no-fund && npm run build'
_play_run_build() {   # $1 = the exported frontend/web dir, inside $PLAY_TMP
  local u="$ORWELL_PLAY_BUILD_USER" g rc=0
  if [[ "$(id -u)" -ne 0 ]]; then
    bash -c "$_PLAY_BUILD_CMD" _ "$1"
    return
  fi
  if ! command -v runuser >/dev/null 2>&1 || ! id "$u" >/dev/null 2>&1 || [[ "$u" == root ]]; then
    echo "WARN: no way to drop privileges for the /play build (runuser or the '${u}' account is missing) — not building it as root"
    return 1
  fi
  g="$(id -gn "$u" 2>/dev/null)" || return 1
  install -d -m 755 "${ORWELL_PLAY_NPM_CACHE%/*}" && install -d -m 700 -o "$u" -g "$g" "$ORWELL_PLAY_NPM_CACHE" || return 1
  chown -R "${u}:${g}" "$PLAY_TMP" || return 1
  runuser -u "$u" -- env -i PATH="$PATH" HOME="$PLAY_TMP" LANG=C.UTF-8 npm_config_cache="$ORWELL_PLAY_NPM_CACHE" \
    npm_config_update_notifier=false ONNXRUNTIME_NODE_INSTALL="${ONNXRUNTIME_NODE_INSTALL:-skip}" \
    bash -c "$_PLAY_BUILD_CMD" _ "$1" || rc=$?
  chown -R -h root:root "$PLAY_TMP" || return 1
  return "$rc"
}
build_play_app() {
  local fp out
  rm -rf "$PLAY_NEXT"
  [[ -f "${PLAY_DIR}/package.json" ]] || return 0
  fp="$(play_inputs_fp)"
  if _same "$(play_build_fp "$PLAY_DIST")" "$fp"; then
    echo "==> /play unchanged since its last build (frontend/web + frontend/static/js) — not rebuilding it"
    return 0
  fi
  if _same "$(play_build_fp "$PLAY_PREV")" "$fp" && _stage_play_build "$PLAY_PREV"; then
    echo "==> /play: reusing the previous build of these exact inputs"
    return 0
  fi
  echo "==> building /play (frontend/web) in a temp dir — a failure here does NOT fail the update"
  if ! PLAY_TMP="$(mktemp -d "${TMPDIR:-/tmp}/orwell-play-build.XXXXXX")"; then
    PLAY_TMP=""
    echo "WARN: /play was NOT built (no temp dir) — it keeps its current build"
    return 0
  fi
  out="${PLAY_TMP}/frontend/web"
  # --ignore-scripts: building /play needs no package install script, so none of its dependencies' scripts run.
  # The build itself (the commit's own `npm run build`) runs unprivileged — see _play_run_build.
  if git -C "$APP_DIR" archive --format=tar HEAD frontend/web frontend/static/js | tar -x --no-same-owner -C "$PLAY_TMP" \
     && _play_run_build "$out" \
     && [[ -f "${out}/dist/index.html" ]] \
     && printf '%s\n' "$fp" > "${out}/dist/${PLAY_STAMP}" \
     && _stage_play_build "${out}/dist"; then
    echo "==> /play built — it goes live when the update commits"
  else
    rm -rf "$PLAY_NEXT"
    echo "WARN: the /play build FAILED (see above) — the update continues; /play keeps its current build (or its 503 'not built yet' page). The classic UI is unaffected."
  fi
  rm -rf "$PLAY_TMP"
  PLAY_TMP=""
  return 0
}
# Put the staged /play build live: two renames on one filesystem (dist -> dist.prev, dist.next -> dist), so
# /play keeps answering from the old build right up to the swap. Never fails the update.
swap_play_app() {
  [[ -d "$PLAY_NEXT" ]] || return 0
  rm -rf "$PLAY_PREV"
  if [[ -e "$PLAY_DIST" || -L "$PLAY_DIST" ]] && ! mv -T "$PLAY_DIST" "$PLAY_PREV"; then
    echo "WARN: could not move the current /play build aside — it stays live (the new build is left in ${PLAY_NEXT})"
    return 0
  fi
  if mv -T "$PLAY_NEXT" "$PLAY_DIST"; then
    echo "==> /play: the new build is live (the previous one is kept as ${PLAY_PREV})"
  else
    echo "WARN: could not put the new /play build live — putting the previous one back"
    if [[ -d "$PLAY_PREV" ]]; then mv -T "$PLAY_PREV" "$PLAY_DIST" || true; fi
  fi
  return 0
}
# --rollback: /play follows only when a build of that commit's inputs is still on disk (offline, no rebuild).
play_follow_rollback() {
  local fp
  [[ -f "${PLAY_DIR}/package.json" ]] || return 0
  fp="$(play_inputs_fp)"
  if _same "$(play_build_fp "$PLAY_DIST")" "$fp"; then return 0; fi
  if _same "$(play_build_fp "$PLAY_PREV")" "$fp" && _stage_play_build "$PLAY_PREV"; then
    swap_play_app
    return 0
  fi
  echo "NOTE: no /play build of this commit is on disk — /play keeps its current build until the next update rebuilds it."
}

# Put the tree back on $1: reset git, reinstall the engine + front-end dependencies a failed run could
# have damaged, and restore dist from the copy $2 (empty/absent ⇒ rebuild from source). Every step is
# `|| return 1` — callers use it inside `if`, where `set -e` is suspended.
restore_build() {
  local sha="$1" dist_src="${2:-}" rebuild=0
  git -C "$APP_DIR" reset --hard "$sha" || return 1
  if [[ "$DIST_DIRTY" -eq 1 && ! -d "$dist_src" ]]; then rebuild=1; fi
  if [[ "$rebuild" -eq 1 ]]; then
    # No copy of that build: rebuild it (needs the dev chain, then prune like the update does).
    ( cd "$APP_DIR" && npm ci --prefer-offline && npm run build ) || return 1
    stamp_dist || return 1
    ( cd "$APP_DIR" && npm prune --omit=dev ) || echo "WARN: npm prune --omit=dev failed (dev deps remain; harmless)"
  elif [[ "$ENGINE_DIRTY" -eq 1 ]]; then
    # dist is restored from its copy below, so only the RUNTIME tree is needed (what prune leaves).
    # --prefer-offline: the cache this box filled when it installed these exact pins can serve a revert
    # even if the registry is what just failed.
    ( cd "$APP_DIR" && npm ci --omit=dev --prefer-offline ) || return 1
  fi
  if [[ "$DIST_DIRTY" -eq 1 && "$rebuild" -eq 0 ]]; then
    rm -rf "${APP_DIR}/dist" || return 1
    cp -a "$dist_src" "${APP_DIR}/dist" || return 1   # keeps its stamp (if it had a trustworthy one)
  fi
  if [[ "$FE_DIRTY" -eq 1 ]]; then
    ( cd "${APP_DIR}/frontend" && install_frontend_deps ) || return 1
  fi
  return 0
}

# "Reverted" / "rollback complete" are only printed after THIS passes. It never touches the live save
# or the running services: every runtime dependency in package.json must be installed, the engine boots
# (as the current user, WITHOUT data/.env) on a free loopback port with a throwaway save dir (default
# deterministic embeddings, no model fetch) and must answer /health, and the front-end venv must import
# its web stack. It does not start the real front-end app (that would open the live app.db).
verify_runnable() {
  echo "==> verifying the restored build can start (runtime deps + throwaway engine boot + front-end import check)"
  local fe="${APP_DIR}/frontend" port tmp pid rc=1 i
  if [[ ! -f "${APP_DIR}/dist/main.js" ]]; then
    echo "  verify: ${APP_DIR}/dist/main.js is missing" >&2; return 1
  fi
  if ! ( cd "$APP_DIR" && node -e 'const fs = require("fs"); const m = Object.keys(require("./package.json").dependencies || {}).filter((p) => !fs.existsSync("node_modules/" + p + "/package.json")); if (m.length) { console.error("not installed: " + m.join(", ")); process.exit(1); }' ); then
    echo "  verify: node_modules is missing runtime dependencies" >&2; return 1
  fi
  if [[ ! -x "${fe}/.venv/bin/uvicorn" ]] || ! "${fe}/.venv/bin/python" -c 'import uvicorn, fastapi' >/dev/null 2>&1; then
    echo "  verify: the front-end virtualenv cannot import uvicorn/fastapi" >&2; return 1
  fi
  port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])' 2>/dev/null)" || port=""
  [[ -n "$port" ]] || { echo "  verify: could not pick a free loopback port" >&2; return 1; }
  tmp="$(mktemp -d)" || return 1
  mkdir -p "${tmp}/save"
  (
    # a stray engine must never be able to hold the update lock
    if [[ -n "${ORWELL_UPDATE_LOCK_FD:-}" ]]; then exec {ORWELL_UPDATE_LOCK_FD}>&-; fi
    cd "$APP_DIR" || exit 1
    exec env -u ORWELL_EMBEDDINGS ORWELL_ENGINE_PORT="$port" ORWELL_DATA_DIR="${tmp}/save" \
      ORWELL_ENGINE_HOST=127.0.0.1 node dist/main.js
  ) >"${tmp}/engine.log" 2>&1 &
  pid=$!
  for ((i = 0; i < 120; i++)); do
    if curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null | grep -q '"ok":true'; then rc=0; break; fi
    kill -0 "$pid" 2>/dev/null || break      # it died: no point polling
    sleep 0.25
  done
  kill "$pid" 2>/dev/null || true
  for ((i = 0; i < 20; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  kill -9 "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if [[ "$rc" -ne 0 ]]; then
    echo "  verify: the engine did not become healthy on :${port}; its output:" >&2
    tail -n 20 "${tmp}/engine.log" >&2 || true
  fi
  rm -rf "$tmp"
  return "$rc"
}

# The rollback pair — data/.update-prev (SHA) + dist.prev (that SHA's build, stamped) — is replaced ONLY
# here, once an update has fully succeeded, and the two move together. A failed attempt never reaches
# this, so the pair stays an older, mutually consistent one. Re-running at the SAME commit keeps the
# existing pair (overwriting it would make --rollback a no-op onto the version already running).
commit_rollback_pair() {
  if [[ "$(git -C "$APP_DIR" rev-parse HEAD)" == "$PREV_SHA" ]]; then
    echo "==> already on ${PREV_SHA}: keeping the existing rollback target"
    rm -rf "$STAGED_DIST"
    return 0
  fi
  mkdir -p "${APP_DIR}/data"
  # Pin the previous commit: the next --depth 1 fetch / git gc would otherwise leave it reachable only
  # through the reflog, and --rollback must not need the network just to find it.
  # The pin, .update-prev and dist.prev change as ONE unit: if any step fails, the old pin is put back so
  # the surviving (old) pair still has its commit protected from gc.
  local tmp="" old_pin   # mktemp (O_EXCL, unpredictable): data/ is writable by the unprivileged service user
  old_pin="$(git -C "$APP_DIR" rev-parse -q --verify refs/orwell/update-prev 2>/dev/null || true)"
  if ! {
    git -C "$APP_DIR" update-ref refs/orwell/update-prev "$PREV_SHA" &&
    tmp="$(mktemp "${PREV_FILE}.XXXXXX")" &&
    printf '%s' "$PREV_SHA" > "$tmp" &&
    chmod 644 "$tmp" &&
    rm -rf "$PREV_DIST" &&
    { [[ ! -d "$STAGED_DIST" ]] || mv "$STAGED_DIST" "$PREV_DIST"; } &&
    mv -f "$tmp" "$PREV_FILE"
  }; then
    [[ -n "$tmp" ]] && rm -f "$tmp"
    if [[ -n "$old_pin" ]]; then git -C "$APP_DIR" update-ref refs/orwell/update-prev "$old_pin" 2>/dev/null || true
    else git -C "$APP_DIR" update-ref -d refs/orwell/update-prev 2>/dev/null || true; fi
    echo "ERROR: could not replace the rollback pair; the previous pair (and its commit pin) is kept." >&2
    return 1
  fi
}

# A failure anywhere after the update armed itself: put the previous SHA, its dependencies and its dist
# back, verify the result starts, and ONLY THEN say "reverted". Returns 1 (restored + verified) or 3
# (the revert itself failed — said plainly, never as a success).
revert_failed_update() {
  local rc="$1"
  set +e
  # A half-finished revert is worse than a finished one: ignore Ctrl-C / stop / hangup, and a closed log
  # pipe (`orwell-update.sh | tee log` whose reader died) — SIGPIPE must not kill it between `npm ci`
  # having deleted node_modules and the restore.
  trap '' INT TERM HUP PIPE
  # …and a dead pipe also makes git/npm FAIL when they write to it, so probe stdout/stderr (a blank line
  # is harmless) and re-point a dead one at the ops log, which is also where the web run's output lands.
  local ops_log="${APP_DIR}/data/ops-update.log"
  if ! { printf '\n'; } 2>/dev/null; then { exec >>"$ops_log"; } 2>/dev/null || exec >/dev/null; fi
  if ! { printf '\n' >&2; } 2>/dev/null; then { exec 2>>"$ops_log"; } 2>/dev/null || exec 2>/dev/null; fi
  echo "ERROR: update FAILED during ${PHASE} (exit ${rc}) — restoring ${PREV_SHA}; services were NOT restarted." >&2
  # ORW-229: a /play build staged by this run never goes live (the live /play was not touched), and a build
  # interrupted mid-way leaves no temp dir behind.
  rm -rf "$PLAY_NEXT"
  if [[ -n "${PLAY_TMP:-}" ]]; then rm -rf "$PLAY_TMP"; fi
  if [[ "$ENGINE_DIRTY$FE_DIRTY$DIST_DIRTY" == "000" && "$(git -C "$APP_DIR" rev-parse HEAD)" == "$PREV_SHA" ]]; then
    # Failed before anything was touched (e.g. the fetch): there is nothing to restore, and booting a
    # second engine beside the live one could only add a false alarm.
    rm -rf "$STAGED_DIST"
    echo "==> nothing had been changed yet (${PREV_SHA} is still checked out, dependencies and build untouched); services were NOT restarted."
    ops_progress_fail "update failed during ${PHASE} — nothing had been changed (previous build untouched), services NOT restarted"
    return 1
  fi
  if restore_build "$PREV_SHA" "$STAGED_DIST" && verify_runnable; then
    rm -rf "$STAGED_DIST"
    echo "==> reverted to ${PREV_SHA}: its dependencies and build are restored and verified to start; services were NOT restarted."
    if [[ "$HOST_TOUCHED" -eq 1 ]]; then
      echo "NOTE: unit files / log policy installed from the new checkout before the failure are NOT reverted (they are idempotent; the next update re-applies them)." >&2
    fi
    ops_progress_fail "update failed during ${PHASE} — reverted to ${PREV_SHA} (restored build verified to start), services NOT restarted"
    echo "Hint: retry with REF=<known-good sha|tag>, or run 'orwell-update.sh --rollback' later." >&2
    return 1
  fi
  echo "ERROR: the revert FAILED — ${PREV_SHA}'s dependencies/build could NOT be restored and verified; the app may not start." >&2
  echo "       Fix the cause above, then recover with: REF=<known-good sha|tag> bash ${APP_DIR}/deploy/orwell-update.sh" >&2
  if [[ -d "$STAGED_DIST" ]]; then
    # a recovery run starts by clearing dist.staging, so keep this copy of the last-running build under its own name
    rm -rf "${STAGED_DIST}.failed"
    mv "$STAGED_DIST" "${STAGED_DIST}.failed" \
      && echo "       The build that was running when this update began is kept at ${STAGED_DIST}.failed." >&2
  fi
  ops_progress_fail "update failed during ${PHASE} AND the revert FAILED — the app may not start; recover with REF=<known-good sha|tag> orwell-update.sh (see ops-update.log)"
  return 3
}

on_update_exit() {
  local rc=$? rrc=0
  trap - EXIT
  [[ "$rc" -ne 0 ]] || return 0
  if [[ "$UPDATE_ARMED" -eq 1 ]]; then
    revert_failed_update "$rc" || rrc=$?
    exit "$rrc"
  fi
  ops_progress_fail "update exited with code $rc — see ops-update.log"
}

# ── Rollback (B71/ops A4): return to the recorded previous SHA + ITS build, then restart. ─────
# The SHA is only paired with a dist stamped as built from that SHA (commit_rollback_pair writes both
# together); a dist.prev that does not match — or predates the stamp — is NOT trusted, the build is
# redone from source instead. Dependencies are reinstalled for that SHA (a lockfile may differ), and
# "rollback complete" is printed only after the restored build is verified to start.
if [[ "$ROLLBACK" -eq 1 ]]; then
  [[ -f "$PREV_FILE" ]] || { echo "ERROR: no previous update recorded (${PREV_FILE} missing) — nothing to roll back to." >&2; exit 1; }
  RB_SHA="$(cat "$PREV_FILE")"
  [[ "$RB_SHA" =~ ^[0-9a-fA-F]{7,64}$ ]] \
    || { echo "ERROR: ${PREV_FILE} does not hold a commit SHA — refusing to roll back." >&2; exit 1; }
  echo "==> rolling back to ${RB_SHA}"
  if ! git -C "$APP_DIR" cat-file -e "${RB_SHA}^{commit}" 2>/dev/null; then
    echo "==> ${RB_SHA} is not in the local checkout — fetching it from origin"
    git -C "$APP_DIR" fetch --depth 1 origin "$RB_SHA" \
      || { echo "ERROR: ${RB_SHA} is neither in the local checkout nor fetchable from origin — cannot roll back." >&2; exit 1; }
  fi
  RB_DIST=""
  if [[ -d "$PREV_DIST" ]]; then
    if [[ "$(cat "${PREV_DIST}/${DIST_STAMP}" 2>/dev/null || true)" == "$RB_SHA" ]]; then
      RB_DIST="$PREV_DIST"
    else
      echo "NOTE: ${PREV_DIST} is not stamped as built from ${RB_SHA} — NOT using it; rebuilding from source instead."
    fi
  fi
  # Reinstall dependencies only if that SHA's lockfiles differ from what is installed now: `npm ci`
  # deletes node_modules first, and a rollback is exactly what you run when things are already wrong
  # (possibly with the registry down). Same locks ⇒ the installed tree is already the right one.
  CUR_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
  git -C "$APP_DIR" diff --quiet "$CUR_SHA" "$RB_SHA" -- package-lock.json || ENGINE_DIRTY=1
  git -C "$APP_DIR" diff --quiet "$CUR_SHA" "$RB_SHA" -- frontend/requirements.lock.txt frontend/requirements.txt || FE_DIRTY=1
  DIST_DIRTY=1
  echo "==> restoring ${RB_SHA}: build$([[ $ENGINE_DIRTY -eq 1 ]] && echo ' + engine dependencies')$([[ $FE_DIRTY -eq 1 ]] && echo ' + front-end dependencies')"
  # ORW-229: a rollback changes what is installed, so the next update must not trust the record of the last
  # one — it reinstalls in full (and records a fresh stamp).
  rm -f "$DEPS_STAMP"
  if restore_build "$RB_SHA" "$RB_DIST" && verify_runnable; then
    play_follow_rollback || true
    systemctl restart "$ENGINE_SVC" "$FRONTEND_SVC"
    echo "==> rollback complete (now on ${RB_SHA}; the restored build was verified to start)."
    exit 0
  fi
  echo "ERROR: ROLLBACK FAILED — ${RB_SHA} could not be restored and verified; the app may not start." >&2
  echo "       Services were NOT restarted. Fix the cause above and re-run --rollback, or: REF=<known-good sha|tag> bash ${APP_DIR}/deploy/orwell-update.sh" >&2
  exit 3
fi

# ── ops-progress lane: publish a live timeline for THIS update; the trap surfaces a failure ──
# (fetching → rebuilding → refreshing deps → restarting → updated). data/ops/update-status.json
# is where the web tier reads it. Any non-zero exit before the commit point below trips the EXIT trap,
# which restores the previous SHA + dependencies + dist, verifies them, and records the outcome.
export ORWELL_OPS_DIR="${APP_DIR%/}/data/ops"
ops_progress_init "update" 5
UPDATE_ARMED=0; PHASE="starting"
trap on_update_exit EXIT
trap 'exit 130' INT; trap 'exit 143' TERM; trap 'exit 129' HUP   # route signals through the EXIT trap

echo "==> updating orwell in ${APP_DIR} (save in ${APP_DIR}/data is preserved)"
PREV_SHA="$(git -C "$APP_DIR" rev-parse HEAD)"
# ORW-229: take the record of the last successful update, then delete it BEFORE anything changes (and before
# the snapshot below, so no copy of dist/ carries it): if this run does not reach its commit point, the next
# one finds no stamp and reinstalls in full.
DEPS_STAMP_TEXT="$(read_deps_stamp)"
rm -f "$DEPS_STAMP"
# Hold the running build aside so a failed update can restore it untouched. dist.prev + data/.update-prev
# (the --rollback pair) are NOT touched until the update fully succeeds — see commit_rollback_pair.
snapshot_running_dist
UPDATE_ARMED=1

# Fetch + check out the TARGET (a pinned REF wins over the branch tip).
PHASE="fetching the target"
ops_progress_step 1 "fetching latest code"
fetch_target
git -C "$APP_DIR" reset --hard "$TARGET"
ENGINE_INPUTS_FP="$(engine_inputs_fp)"; ENGINE_DEPS_FP="$(engine_deps_fp)"; FRONTEND_DEPS_FP="$(frontend_deps_fp)"

# Build BEFORE committing to the swap (B71/ops A4): a failed build must leave the services on the
# PREVIOUS checkout + build — never a new tree with a stale dist, never a restart into a broken build.
# `npm ci` deletes node_modules first, so a failure here (or later) restores the previous dependencies
# too — see revert_failed_update.
echo "==> rebuild engine (the update commits only if everything below succeeds)"
PHASE="the engine build"
ops_progress_step 2 "rebuilding engine"
cd "$APP_DIR"
ENGINE_PLAN="$(engine_plan)"
case "${ENGINE_PLAN%%:*}" in
  reuse)
    # ORW-229: dist/ and node_modules are exactly what this commit would build, so neither is touched; dist/ is
    # only re-stamped as this commit's build (DIST_DIRTY: a later failure puts the old stamp back).
    echo "==> engine unchanged since the last successful update — keeping its node_modules and build (no npm ci, no rebuild)"
    DIST_DIRTY=1
    stamp_dist
    ;;
  chain)
    # ORW-229: node_modules is the pruned runtime tree of this exact lockfile; `npm install` only adds back
    # the build tools (esbuild, …) from the local cache. --no-save: it never rewrites package*.json.
    echo "==> engine dependencies unchanged — restoring only the build tools the last update pruned (npm install from the local cache), not a full npm ci"
    ENGINE_DIRTY=1
    if ! npm install --include=dev --no-save --prefer-offline --no-audit --no-fund; then
      echo "WARN: restoring the build tools failed — falling back to a clean npm ci"
      npm ci
    fi
    ;;
  *)
    echo "==> full engine install (npm ci): ${ENGINE_PLAN#*:}"
    ENGINE_DIRTY=1
    npm ci
    ;;
esac
if [[ "${ENGINE_PLAN%%:*}" != reuse ]]; then
  DIST_DIRTY=1
  rm -f "${APP_DIR}/dist/${DIST_STAMP}"   # a partial dist must never carry a stamp
  npm run build
  stamp_dist

  # Production hardening: the host runs the BUNDLED engine (dist/main.js + the 3 pinned native deps),
  # so once the build above is done it needs only the RUNTIME tree. Drop the dev/build chain
  # (esbuild, vitest, cucumber, …) so the deployed box doesn't carry its advisories (npm audit: all
  # dev-chain — see README "Dependency advisories"). Non-fatal; the next update re-installs it to build.
  npm prune --omit=dev || echo "WARN: npm prune --omit=dev failed (dev deps remain; harmless)"
fi

# ORW-229: the React /play app — non-fatal by construction (see build_play_app); goes live after the commit point.
PHASE="the /play build (non-fatal)"
build_play_app || true
PHASE="the engine build"

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

# The inherited MCP-server rows the game build drops (issue #636): a browser / playwright server, or the RAG /
# Memory / Email built-ins. A fixed clause of this script (never data), shared by both cleanup paths below.
_CRUFT_MCP_WHERE="lower(name) LIKE '%browser%' OR lower(name) LIKE '%playwright%' OR lower(command) LIKE '%playwright%' OR lower(args) LIKE '%@playwright/mcp%' OR lower(name) IN ('memory','rag','email') OR lower(id) IN ('memory','rag','email','builtin_browser')"
# The production box has python3 but NO sqlite3 command-line tool, so a CLI-only cleanup never ran there (the
# ORW-233 gap). This uses python3's built-in sqlite3 module instead: the existing DB only (mode=rw never creates
# one), a 2 s busy timeout, one transaction, an isolated interpreter (-I). Exit codes: 0 = printed the number of
# rows removed (nothing printed: no mcp_servers table) · 5 = no sqlite3 module · anything else = not written.
_CRUFT_MCP_PY='
import sys
try:
    import sqlite3
    from urllib.parse import quote
except ImportError:
    sys.exit(5)
try:
    con = sqlite3.connect("file:" + quote(sys.argv[1]) + "?mode=rw", uri=True, timeout=2)
    try:
        if con.execute("SELECT 1 FROM sqlite_master WHERE type=? AND name=?", ("table", "mcp_servers")).fetchone() is None:
            sys.exit(0)
        with con:
            removed = con.execute("DELETE FROM mcp_servers WHERE " + sys.argv[2]).rowcount
    finally:
        con.close()
except sqlite3.Error as e:
    sys.stderr.write("%s\n" % e)
    sys.exit(3)
print(removed)
'
# Run it as the service user, NEVER as root (root-owned -journal/-wal sidecars break the FE). As root with no
# way to drop privileges it does not write at all (4). 5 = python3 or its sqlite3 module is missing.
_svc_cleanup_mcp_rows_py() {
  local db="$1" u="${SVC_USER:-orwell}"
  command -v python3 >/dev/null 2>&1 || return 5
  local -a runner=()
  if [[ "$(id -u)" -eq 0 ]]; then
    if command -v runuser >/dev/null 2>&1 && id "$u" >/dev/null 2>&1 && [[ "$u" != root ]]; then
      runner=(runuser -u "$u" --)
    else
      return 4
    fi
  fi
  # `cd /`: the service user may not be able to enter the directory the updater was started in.
  ( cd / && timeout 20 "${runner[@]}" python3 -I -c "$_CRUFT_MCP_PY" "$db" "$_CRUFT_MCP_WHERE" )
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
PHASE="the data/.env reconcile"
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
PHASE="the front-end dependency install"
ops_progress_step 3 "refreshing front-end deps"
cd "${APP_DIR}/frontend"
if frontend_deps_unchanged; then
  # ORW-229: same lockfile + interpreter as the last successful update, and the venv still holds exactly
  # what it installed — `pip install` would be a slow no-op.
  echo "==> front-end dependencies unchanged since the last successful update — skipping pip install"
else
  FE_DIRTY=1
  install_frontend_deps
fi

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
  #    operator added by hand. Guarded: skip if there's no db or no table; never fails the update.
  # FINDING #3 — every write here runs as the service user, never as root: as ROOT while the FE is up,
  # even a SELECT can create/checkpoint root-owned app.db-wal/-shm sidecars that then make the
  # unprivileged FE hit "readonly database" / "database is locked"; the DELETE is the same hazard.
  # Running as the DB's owner keeps every sidecar owned by that user. python3's sqlite3 module first
  # (the production box has no sqlite3 CLI); the CLI path only on a box without python3.
  local db="${ORWELL_FE_DATA_DIR:-${APP_DIR}/frontend/data}/app.db"   # the FE store (frontend/data), not engine data/
  local removed="" rc=0
  if [[ -f "$db" ]]; then
    removed="$(_svc_cleanup_mcp_rows_py "$db" 2>/dev/null)" || rc=$?
    if (( rc == 5 )); then
      if command -v sqlite3 >/dev/null 2>&1 \
         && _svc_sqlite3 "$db" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_servers' LIMIT 1;" 2>/dev/null | grep -q 1; then
        local before after
        before="$(_svc_sqlite3 "$db" "SELECT count(*) FROM mcp_servers;" 2>/dev/null || echo 0)"
        _svc_sqlite3 "$db" "DELETE FROM mcp_servers WHERE ${_CRUFT_MCP_WHERE};" 2>/dev/null || true
        after="$(_svc_sqlite3 "$db" "SELECT count(*) FROM mcp_servers;" 2>/dev/null || echo 0)"
        if [[ "$before" =~ ^[0-9]+$ && "$after" =~ ^[0-9]+$ ]] && (( before > after )); then
          removed=$(( before - after ))
        fi
      fi
      rc=0
    fi
    if (( rc == 0 )) && [[ "$removed" =~ ^[0-9]+$ ]] && (( removed > 0 )); then
      echo "    removed ${removed} inherited MCP-server config row(s) from app.db"
    elif (( rc != 0 && rc != 4 )); then
      echo "    note: could not clean inherited MCP-server rows from app.db this time (busy or unreadable); the next update retries"
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

PHASE="the host reconcile (ownership, login panel, systemd units)"
HOST_TOUCHED=1
# ── FINDING #3 — settle OWNERSHIP after the root-run build (git reset, npm ci/build/prune, pip, the
# embedding prefetch and the app.db cruft-cleanup above all ran as root). Same model as
# orwell-install.sh's ownership(); on a box installed before it, this run also MIGRATES the old
# orwell-owned code tree back to root. Runs BEFORE the restart so the services boot able to write.
# Layout-agnostic + best-effort (a missing service user just skips it, with a warning); idempotent.
# ── Ownership model (least privilege) ──────────────────────────────────────────────────────────
# The CODE tree (the checkout, deploy/, dist/, node_modules, frontend/.venv, …) stays ROOT-owned and
# is never group/world-writable: the root-run ops units (orwell-ops-*.service) execute scripts out
# of deploy/, and the app units are sandboxed read-only outside their ReadWritePaths, so the service
# user has no need to write code — and must not be able to, or a compromised service could edit
# what root runs next. Only the dirs the services legitimately write are handed to it: data/ (or a
# custom DATA_DIR), frontend/data, backups/ (orwell-backup.service runs as the service user) and
# .orwell-data (the engine's default save dir when ORWELL_DATA_DIR is unset — legacy/dev layouts).
# KEEP THIS FUNCTION BYTE-IDENTICAL in orwell-install.sh and orwell-update.sh (a test pins it).
orwell_apply_ownership() {   # $1 app dir · $2 service user · $3 service group · $4… extra writable dirs
  local app="${1%/}" user="$2" group="$3" d; shift 3
  local -a rw=("${app}/data" "${app}/frontend/data" "${app}/backups" "${app}/.orwell-data")
  for d in "$@"; do rw+=("${d%/}"); done
  local -a prune=()
  for d in "${rw[@]}"; do prune+=(-path "$d" -o); done
  # 1. Everything outside the writable dirs: root:root, and no group/other write bit left behind by
  #    a previous orwell-owned install (a root-owned but world-writable file is not root-owned in
  #    any way that matters). -h / ! -type l: act on a symlink itself, never on its target.
  find "$app" -xdev \( "${prune[@]}" -false \) -prune -o \
    -exec chown -h root:root {} + \( -type l -o -exec chmod go-w,a+rX {} + \) || return 1
  # 2. The writable dirs: the service user, recursively (chown -R does not follow symlinks). A
  #    symlinked dir is left alone — never chowned through to wherever it points.
  for d in "${rw[@]}"; do
    [[ -d "$d" ]] || continue
    if [[ -L "$d" ]]; then echo "WARN: ${d} is a symlink — leaving its ownership alone" >&2; continue; fi
    chown -R -h "$user":"$group" "$d" || return 1
  done
}

if [[ "$(id -u)" -eq 0 ]]; then
  if id "$SVC_USER" >/dev/null 2>&1; then
    echo "==> settling ownership: code tree root-owned; ${SVC_USER}:${SVC_GROUP} owns data/, frontend/data, backups/"
    # Called directly (no `||`): inside an `||` list set -e is off for the whole function, so a failed
    # code-tree chown/chmod could be masked by a later successful one and the update would carry on with
    # service-writable scripts that root runs. An ownership failure aborts the update instead.
    if ! orwell_apply_ownership "$APP_DIR" "$SVC_USER" "$SVC_GROUP" "${DATA_DIR:-${APP_DIR}/data}"; then
      echo "ERROR: the ownership pass FAILED — refusing to continue with a code tree the service user may still write. Check ${APP_DIR} (chown/chmod errors above) and re-run." >&2
      exit 1
    fi
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
  if id -u orwell >/dev/null 2>&1; then chown -h orwell:orwell "${APP_DIR}/backups"; fi
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
  if id -u orwell >/dev/null 2>&1; then chown -h orwell:orwell "${APP_DIR}/data/ops"; fi
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
  if id -u orwell >/dev/null 2>&1; then chown -h orwell:orwell "${APP_DIR}/data/ops"; fi
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
  if id -u orwell >/dev/null 2>&1; then chown -h orwell:orwell "${APP_DIR}/data/ops"; fi
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
  if id -u orwell >/dev/null 2>&1; then chown -h orwell:orwell "${APP_DIR}/data/ops"; fi
  touch "${APP_DIR}/data/ops-tls.log"
  chmod 644 "${APP_DIR}/data/ops-tls.log"
  OPS_TLS_READY=1
fi
systemctl daemon-reload
# STALE-FLAG GUARD: a path unit (PathExists=) fires the moment it starts if its flag is already on disk.
# A flag dropped while a watcher was stopped would therefore run — for a reset, WIPE — at the first
# `enable --now` / `restart` below, at a time nobody chose. An active watcher consumes a flag within
# seconds (its ExecStartPre removes it), so a destructive flag still present after 2 minutes is stale:
# clear it BEFORE the watchers are (re)started. `rm -rf` so a directory planted at the flag path goes too.
# A flag is only pruned while ITS lane's service is not running: during a long Update + Reset run (this very
# script is its child) a follow-up request queued meanwhile is legitimate, however old it is by now.
if [[ "$APP_DIR" == "/opt/orwell" && -d "${APP_DIR}/data/ops" ]]; then
  for _lane in factory-reset update-reset; do
    if ! systemctl is-active --quiet "orwell-ops-${_lane}.service" 2>/dev/null; then
      find "${APP_DIR}/data/ops" -maxdepth 1 -name "${_lane}-requested" \
        -mmin +2 -exec rm -rf --one-file-system -- {} + 2>/dev/null || true
    fi
  done
fi
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

# ── COMMIT POINT — everything that can fail (build, deps, reconcile) has succeeded: record the
# rollback pair (previous SHA + its stamped dist) together, then disarm the revert. The restart below is
# deliberately OUTSIDE the revert: by here the new build is fully in place, and a unit that fails to
# restart is a service problem a code revert would not fix.
PHASE="recording the rollback pair"
commit_rollback_pair
UPDATE_ARMED=0

# ORW-229: the update has committed — record what it installed (so the next update can skip what did not
# change), and put a freshly built /play live. Neither can fail the update.
PHASE="recording the install stamp + the /play swap (non-fatal)"
write_deps_stamp || echo "WARN: could not write ${DEPS_STAMP} — the next update reinstalls in full (harmless)"
swap_play_app || true

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
