#!/usr/bin/env bash
#
# orwell — Update + Reset (keep API keys). The combined middle tier of the three maintenance
# controls — Update · Update + Reset · Reset — for an operator who wants a freshly-pulled build
# AND a clean first-run box in one action: pull latest + rebuild (the Update) and THEN reset to
# exact OOBE while PRESERVING the API-key / LLM-provider config (the Reset).
#
# It COMPOSES the two existing scripts; it re-implements neither of their internals:
#   1. orwell-update.sh --no-restart   pull → rebuild engine → refresh FE deps → reconcile units,
#                                      but SKIP the final restart (so we end on ONE restart).
#   2. orwell-oobe-reset.sh --yes      stop services → preserve the API-key/LLM config → wipe to
#                                      first-run → restart (the single, final services restart).
#
# FAIL-CLOSED (the safety contract of a destructive combo):
#   • If the UPDATE phase fails, we DO NOT proceed to the wipe — NOTHING is removed. orwell-update.sh
#     restores the previous SHA + dependencies + build itself and verifies they start (exit 1); if even
#     that revert fails it exits 3 and we say so plainly — never "the box is on its previous build".
#   • ONE shared lock (/run/orwell-update.lock, the same file orwell-update.sh takes) is held across BOTH
#     phases, so a web Update or a manual update can't start between the update and the wipe, or run
#     while the OOBE reset is scrubbing. The update child is handed the open fd (ORWELL_UPDATE_LOCK_FD)
#     and recognises it as held — it must not re-lock the file (flock would block it on its own parent).
#   • If the OOBE-reset helper is missing or errors, the reset script itself removes NOTHING
#     (it aborts before scrubbing, leaving the config — and your API keys — intact).
#   • data/.env (ports, tokens, LLM keys) is NEVER touched, like every reset.
#
# Run on the Proxmox HOST or inside the container as root — same bridge as the other orwell-*.sh
# maintenance scripts (it locates the orwell LXC and re-runs itself inside it):
#   bash /path/to/orwell-update-reset.sh             # prompts to confirm (type RESET)
#   bash /path/to/orwell-update-reset.sh --yes       # no prompt (automation / the admin button)
#   bash /path/to/orwell-update-reset.sh --dry-run   # show what WOULD happen, change nothing
#   bash /path/to/orwell-update-reset.sh --no-restart # update + scrub but leave services down
#
# On the Proxmox host the script locates the orwell LXC (by hostname "orwell"; override with
# CTID=<id> or CT_HOSTNAME=<name>) and re-runs itself inside it.
#
# Paths/scripts are overridable via env for tests/dev: APP_DIR, ORWELL_UPDATE_SCRIPT,
# ORWELL_OOBE_RESET_SCRIPT (default to the deploy copies beside this file / in the checkout).
set -euo pipefail

BRANCH="${BRANCH:-main}"
CT_HOSTNAME_SET="${CT_HOSTNAME:+1}"   # explicit override disables the legacy-name fallback
CT_HOSTNAME="${CT_HOSTNAME:-orwell}"
APP_DIR_EXPLICIT="${APP_DIR:-}"

msg()  { echo -e "==> $*"; }
warn() { echo -e "WARN: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# ── Optional whiptail TUI (deploy/orwell-tui.sh) — see orwell-update.sh / orwell-oobe-reset.sh for
# the rationale. The destructive confirmation below uses it on a TTY; absent / off a TTY it falls
# back to the plain type-RESET prompt (a host→container `pct exec` run has no PTY → expects --yes).
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -n "${__lib:-}" && -r "$__lib" ]]; then . "$__lib"; break; fi
done
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }

# ── ops-progress lane: an UMBRELLA timeline for the combined run, on top of the per-phase progress
# the composed update/reset scripts publish (the admin health page renders whichever action it is
# watching). Best-effort; missing helper ⇒ no-op stubs. Steps fire on the in-container run.
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
    -h|--help)       sed -n '3,40p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# re-run this script inside it, forwarding all flags. Same pattern as orwell-oobe-reset.sh.
# Inside the container pct does not exist (and the app dir does), so this block is skipped.
if command -v pct >/dev/null 2>&1 && ! find_app >/dev/null 2>&1; then
  CTID="${CTID:-$(pct list 2>/dev/null | awk -v n="$CT_HOSTNAME" 'NR>1 && $NF==n {print $1}' || true)}"
  # Legacy-aware: a pre-rename box may still run an LXC literally named "bbai".
  [[ -n "$CTID" || -n "$CT_HOSTNAME_SET" ]] || CTID="$(pct list 2>/dev/null | awk 'NR>1 && $NF=="bbai" {print $1}' || true)"
  [[ -n "$CTID" ]] || die "no orwell LXC found (hostname '${CT_HOSTNAME}' or legacy 'bbai'). Set CTID=<id> and retry."
  [[ "$(printf '%s' "$CTID" | wc -w)" -eq 1 ]] || die "multiple containers named '${CT_HOSTNAME}' (${CTID//$'\n'/ }). Set CTID=<id>."
  [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] || die "LXC ${CTID} is not running — start it first: pct start ${CTID}"

  msg "orwell lives in LXC ${CTID}; running Update + Reset (keep API keys) inside the container"
  # LOCAL-COPY bridge (A4/ruling #17 — closes audit E84): never curl a branch tip from GitHub.
  # Run from a file → push THAT file; run via `bash -c "$(...)"` → push the running text;
  # otherwise run the container's own checked-out copy.
  if [[ -n "${BASH_SOURCE[0]:-}" && -r "${BASH_SOURCE[0]:-}" ]]; then
    TMP_UR="$(mktemp /tmp/orwell-update-reset-XXXXXX.sh)"
    cp "${BASH_SOURCE[0]}" "$TMP_UR"
    pct push "$CTID" "$TMP_UR" /tmp/orwell-update-reset.sh
    rm -f "$TMP_UR"
    pct exec "$CTID" -- bash -c "export BRANCH='${BRANCH}'; bash /tmp/orwell-update-reset.sh ${EXTRA_FLAGS[*]:-}"
  elif [[ -n "${BASH_EXECUTION_STRING:-}" ]]; then
    TMP_UR="$(mktemp /tmp/orwell-update-reset-XXXXXX.sh)"
    printf '%s\n' "$BASH_EXECUTION_STRING" > "$TMP_UR"
    pct push "$CTID" "$TMP_UR" /tmp/orwell-update-reset.sh
    rm -f "$TMP_UR"
    pct exec "$CTID" -- bash -c "export BRANCH='${BRANCH}'; bash /tmp/orwell-update-reset.sh ${EXTRA_FLAGS[*]:-}"
  else
    pct exec "$CTID" -- bash -c "export BRANCH='${BRANCH}'; for d in /opt/orwell /opt/bbai; do
        [ -f \"\$d/deploy/orwell-update-reset.sh\" ] && exec bash \"\$d/deploy/orwell-update-reset.sh\" ${EXTRA_FLAGS[*]:-}
      done; echo 'ERROR: no in-container deploy/orwell-update-reset.sh found' >&2; exit 1"
  fi
  exit 0
fi

# ── In-container (or direct) Update + Reset ────────────────────────────────────────────────────
APP_DIR="$(find_app || true)"; APP_DIR="${APP_DIR:-/opt/orwell}"
DEPLOY_DIR="${__here:-}"
[[ -n "$DEPLOY_DIR" && -r "${DEPLOY_DIR}/orwell-update.sh" ]] || DEPLOY_DIR="${APP_DIR}/deploy"

# The two composed scripts (overridable for tests/dev — never any user input interpolated).
UPDATE_SCRIPT="${ORWELL_UPDATE_SCRIPT:-${DEPLOY_DIR}/orwell-update.sh}"
RESET_SCRIPT="${ORWELL_OOBE_RESET_SCRIPT:-${DEPLOY_DIR}/orwell-oobe-reset.sh}"

# Fail-closed PRECONDITION: both phases must exist before we promise the operator anything. A
# missing reset helper especially must never let us run the update then leave the box half-done.
[[ -r "$UPDATE_SCRIPT" ]] || die "update phase script not found: ${UPDATE_SCRIPT}"
[[ -r "$RESET_SCRIPT"  ]] || die "reset phase script not found: ${RESET_SCRIPT} — refusing (NOTHING changed; your config is safe)."

# ── Confirmation (skipped by --yes / --dry-run) ───────────────────────────────────────────────
# Destructive (it wipes to OOBE) — demand a typed RESET, mirroring orwell-oobe-reset.sh.
if [[ "$DRY_RUN" -eq 0 && "$ASSUME_YES" -eq 0 ]]; then
  if tui_active; then
    ORWELL_TUI_TITLE="Orwell — Update + Reset (keep API keys)"
    wt_confirm_phrase "RESET" "UPDATE + RESET — pull latest, rebuild, THEN reset to first-run OOBE, KEEPING your API keys.

First it UPDATES: git pull → rebuild the engine → refresh front-end deps (no restart yet).
Then it RESETS to OOBE, PERMANENTLY DELETING all orwell game + user data:
  • every game sandbox (saves, souls, the hidden Vault layer)
  • the front-end store — ALL accounts, chats, sessions, memory, MCP server
    configs, uploads, portraits, and EVERY user setting

PRESERVED:
  • your LLM / image PROVIDERS + the keys that decrypt them, and the LLM-selection settings
  • the engine config data/.env

If the UPDATE fails, the RESET does NOT run — nothing is wiped. The next visit starts at
first-run onboarding (OOBE) — on the freshly-pulled build, with an LLM already configured." \
      || die "aborted — no changes made."
  else
    cat <<EOF
UPDATE + RESET (keep API keys). Two phases, fail-closed:
  1. UPDATE  — git pull → rebuild engine → refresh FE deps (no restart yet).
  2. RESET   — wipe to first-run OOBE, PRESERVING your LLM/provider config + data/.env.
If phase 1 fails, phase 2 does NOT run and NOTHING is wiped (your API keys are safe).
The next visit starts at first-run onboarding (OOBE), on the freshly-pulled build.
EOF
    read -r -p "Type 'RESET' to proceed: " ans
    [[ "$ans" == "RESET" ]] || die "aborted — no changes made."
  fi
fi

# ── Dry run: describe the composition, run NEITHER phase destructively ─────────────────────────
if [[ "$DRY_RUN" -eq 1 ]]; then
  reset_argv="--yes"; [[ "$RESTART" -eq 0 ]] && reset_argv="--yes --no-restart"
  msg "dry run — would, in order:"
  echo "  1. UPDATE: bash ${UPDATE_SCRIPT} --no-restart   (pull → rebuild → refresh FE deps, no restart)"
  echo "  2. RESET:  bash ${RESET_SCRIPT} ${reset_argv}   (wipe to OOBE, keep API keys, single final restart)"
  # Surface the reset's own dry-run for the preview (the update has no dry-run mode of its own).
  msg "reset phase dry-run preview:"
  bash "$RESET_SCRIPT" --dry-run || warn "reset dry-run preview returned non-zero"
  msg "dry run complete — nothing was updated or removed."
  exit 0
fi

# ── The shared lock with orwell-update.sh — taken AFTER the confirmation prompt and the dry-run exit, so
# neither a waiting prompt nor a preview ever blocks an update, and a refusal below changes nothing. It
# is a DIFFERENT file from the ops unit's own /run/orwell-ops-update-reset.lock (which only dedupes that
# unit's repeat triggers), so there is no lock-order cycle. Released when this process exits.
UPDATE_LOCK="${ORWELL_UPDATE_LOCK:-/run/orwell-update.lock}"
command -v flock >/dev/null 2>&1 || die "flock (util-linux) is required to serialize updates."
exec {ORWELL_UPDATE_LOCK_FD}>>"$UPDATE_LOCK" || die "cannot open the update lock ${UPDATE_LOCK}."
if ! flock -n "$ORWELL_UPDATE_LOCK_FD"; then
  echo "ERROR: another orwell update / rollback / Update + Reset is already running in this tree (lock ${UPDATE_LOCK})." >&2
  echo "       Refusing to run two at once. NOTHING was changed. Retry once it has finished." >&2
  exit 75
fi
export ORWELL_UPDATE_LOCK_FD

# ── ops-progress lane: umbrella timeline for the combined run; the trap surfaces a failure ──
export ORWELL_OPS_DIR="${APP_DIR%/}/data/ops"
ops_progress_init "update-reset" 2
trap 'rc=$?; if [[ "$rc" -ne 0 ]]; then ops_progress_fail "update+reset exited with code $rc — see ops-update-reset.log"; fi' EXIT

# ── Phase 1 — UPDATE (restart suppressed so the reset owns the single final restart) ───────────
# Fail-closed: if the update fails, orwell-update.sh has already restored the previous SHA + dependencies +
# build and verified them (exit 1), or reports that it could not (exit 3) — we ABORT here either way and
# never touch user data. Config stays intact. Only exit 1 lets us say "previous build"; 3 and anything
# unexpected (a signal, an exit before the update armed itself) are reported as unconfirmed.
msg "phase 1/2 — UPDATE (pull → rebuild → refresh FE deps; restart suppressed)"
ops_progress_step 1 "updating (pull → rebuild → refresh deps)"
update_rc=0
bash "$UPDATE_SCRIPT" --no-restart || update_rc=$?
if [[ "$update_rc" -ne 0 ]]; then
  trap - EXIT  # the explicit fail below is the final status
  case "$update_rc" in
    1)
      ops_progress_fail "the update phase failed — the box is on its previous build; nothing was wiped (your API keys are safe)"
      die "UPDATE failed — NOT proceeding to the reset. The box is on its previous build and NOTHING was wiped (your API keys are safe). Fix the update, then retry." ;;
    3)
      ops_progress_fail "the update phase failed AND its automatic revert failed — the box may not start; nothing was wiped (your API keys are safe)"
      die "UPDATE failed AND its automatic revert FAILED (see the log above) — the box may NOT be runnable. NOT proceeding to the reset; NOTHING was wiped (your data and API keys are untouched). Fix the cause, or recover with: REF=<known-good sha|tag> bash ${DEPLOY_DIR}/orwell-update.sh" ;;
    *)
      ops_progress_fail "the update phase exited with code ${update_rc} — its state is unconfirmed; nothing was wiped (your API keys are safe)"
      die "UPDATE exited with code ${update_rc} before it could confirm the box is on a working build — check it (see the log above). NOT proceeding to the reset; NOTHING was wiped (your data and API keys are untouched)." ;;
  esac
fi

# ── Phase 2 — RESET to OOBE (keep API keys), which performs the SINGLE final restart ───────────
# The reset stops the services, preserves the LLM/provider config (and aborts removing nothing if
# its helper is missing), scrubs to first-run, and restarts — unless --no-restart was requested,
# in which case it scrubs and leaves the services down for the operator to bring up.
RESET_FLAGS=(--yes); RESET_TAIL=" + final restart"
[[ "$RESTART" -eq 0 ]] && { RESET_FLAGS+=(--no-restart); RESET_TAIL=" (services left down)"; }
msg "phase 2/2 — RESET to OOBE (keep API keys)${RESET_TAIL}"
ops_progress_step 2 "resetting to OOBE (keep API keys) + final restart"
# The composed reset re-exports its own ORWELL_OPS_DIR, so it publishes its own factory-reset
# progress alongside this umbrella update-reset status — both readable by the status page.
bash "$RESET_SCRIPT" "${RESET_FLAGS[@]}" \
  || die "RESET phase failed. The update is already in place; re-run 'orwell reset-oobe' to complete the reset."

# ops-progress lane: terminal OK — clear the trap so its EXIT handler doesn't re-stamp a fail.
trap - EXIT
ops_progress_done "Update + Reset complete — OOBE ready on the fresh build"
msg "Update + Reset complete — freshly pulled build, back at first-run OOBE, with your LLM already configured."
