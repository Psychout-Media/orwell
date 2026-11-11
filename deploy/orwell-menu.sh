#!/usr/bin/env bash
#
# deploy/orwell-menu.sh — the Orwell control panel: a whiptail menu over the maintenance
# scripts (update, doctor, backup, restore, game / factory reset, readiness). orwell-install.sh
# installs a `/usr/local/bin/orwell` launcher that execs this file, and the login health panel
# advertises it — so an operator inside the container can just type `orwell`.
#
# It DISPATCHES to the existing deploy/*.sh scripts (the single source of truth for every
# operation), collecting intent via dialogs and then passing their non-interactive flags
# (--yes, --rollback, --set-token, REF=, GIT_TOKEN=, …). Nothing here re-implements their logic.
#
# Off a TTY (or with --help) it prints the actions and exits 0 — so CI and automation never
# block on a dialog. Direct subcommands bypass the menu entirely (handy for scripting / tests):
#
#   orwell update | doctor | backup | restore | ready
#   orwell update-reset --yes                          (update, THEN OOBE reset; --yes required off the menu)
#   orwell reset-game --yes | reset-factory --yes      (destructive: --yes required off the menu)
#
# This panel is container-oriented (it runs the scripts in place). On a Proxmox HOST it prints
# how to reach the LXC instead — the individual scripts keep their own host→container bridges.
set -uo pipefail

# ── Shared whiptail helpers (checkout copy first, then any installed copy) ───────────────────────
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo /opt/orwell/deploy)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -r "$__lib" ]]; then . "$__lib"; break; fi
done
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }   # fallback: no TUI ⇒ plain paths
# Presentation-helper fallbacks: a box updated before this change runs an installed orwell-tui.sh
# that predates the ow_* helpers — define minimal no-frills versions so the panel never errors on
# a missing function (the helpers only print; they never change behaviour or exit codes).
type ow_logo    >/dev/null 2>&1 || ow_logo()    { :; }
type ow_section >/dev/null 2>&1 || ow_section() { echo "── $1 ──"; }
type ow_rule    >/dev/null 2>&1 || ow_rule()    { [[ -n "${1:-}" ]] && echo "── $1 ──" || echo "──"; }
type ow_step    >/dev/null 2>&1 || ow_step()    { echo "  > $*"; }
type ow_ok      >/dev/null 2>&1 || ow_ok()      { echo "  + $*"; }
type ow_fail    >/dev/null 2>&1 || ow_fail()    { echo "  x $*"; }
type ow_info    >/dev/null 2>&1 || ow_info()    { echo "  $*"; }
ORWELL_TUI_TITLE="Orwell — control panel"

msg() { echo -e "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
orwell — control panel for a deployed Orwell instance.

Interactive (on a TTY with whiptail): run with no arguments for the menu.

Non-interactive subcommands:
  orwell update                  pull + rebuild + restart (the save is preserved)
  orwell doctor [--fix|--status|--bounce]
                                 diagnose and (by default) repair the services
  orwell backup                  snapshot engine + front-end data to <app>/backups
  orwell restore [FILE]          restore a backup (newest if FILE is omitted)
  orwell ready                   readiness check (engine + front-end + an LLM)
  orwell change-port <port>      change the UI port (handles to/from :80 — the cap drop-in)
  orwell https [--mode local|--disable] [...]   local HTTPS (trusted on the LAN, no browser warning)
  orwell update-reset --yes      update (pull + rebuild) THEN OOBE reset, KEEP the API-key/LLM config
  orwell reset-game --yes        new season — clears games, keeps accounts + config
  orwell reset-oobe --yes        OOBE reset — back to first-run, KEEP the API-key/LLM config
  orwell reset-factory --yes     factory reset — back to first-run OOBE, KEEP the API-key/LLM config
  orwell --help                  this help
EOF
}

# First real install (a git checkout), legacy /opt/bbai aware — same probe as the other scripts.
find_app() {
  local d
  for d in "${APP_DIR:-}" /opt/orwell /opt/bbai; do
    [[ -n "$d" && -d "$d/.git" ]] && { echo "$d"; return 0; }
  done
  return 1
}

# ── Early exits that need no install: --help, and "no subcommand off a TTY" ─────────────────────
case "${1:-}" in -h|--help|help) usage; exit 0 ;; esac
if [[ $# -eq 0 ]] && ! tui_active; then usage; exit 0; fi

# ── Resolve the install (the scripts we dispatch to live beside this one) ────────────────────────
APP_DIR="$(find_app || true)"
if [[ -z "$APP_DIR" ]]; then
  if command -v pct >/dev/null 2>&1; then
    cat >&2 <<'EOF'
Orwell runs INSIDE the LXC, not on the Proxmox host. Enter the container, then run the panel:
    pct enter <ctid>      # then, inside: orwell
A single action can also be run from the host checkout (it bridges into the LXC itself), e.g.:
    bash deploy/orwell-doctor.sh --status
    bash deploy/orwell-update.sh
EOF
    exit 1
  fi
  die "no Orwell install found (looked for /opt/orwell, /opt/bbai). Set APP_DIR=<dir> if elsewhere."
fi
DEPLOY_DIR="$__here"
[[ -r "${DEPLOY_DIR}/orwell-doctor.sh" ]] || DEPLOY_DIR="${APP_DIR}/deploy"

# Run a maintenance script with LIVE output (transparency for multi-minute ops), then — on a TTY
# — pause so the operator can read it before the menu repaints.
run() {
  local title="$1"; shift
  tui_active && { command -v clear >/dev/null 2>&1 && clear || true; }
  ow_section "$title"
  # ORW-241 (audit item 28): never echo a secret. The deploy-token action passes it as GIT_TOKEN=<value> on this command line, so the displayed copy masks any NAME=value argument whose name looks secret.
  local shown=() a
  for a in "$@"; do
    case "$a" in
      *TOKEN=*|*PASSWORD=*|*SECRET=*|*API_KEY=*|*PAT=*) shown+=("${a%%=*}=***") ;;
      *) shown+=("$a") ;;
    esac
  done
  ow_step "${shown[*]}"; echo
  "$@"; local rc=$?
  echo
  [[ $rc -eq 0 ]] && ow_ok "${title}: done." || ow_fail "${title}: exited ${rc} (see output above)."
  tui_active && { read -rsn1 -p "Press any key to return to the menu… " _ || true; echo; }
  return $rc
}

# ── Actions ─────────────────────────────────────────────────────────────────────────────────────
do_update() {
  if ! tui_active; then run "Update" bash "${DEPLOY_DIR}/orwell-update.sh"; return $?; fi
  local act ref tok
  wt_menu act "Update / maintenance:" \
    tip      "Update to the latest build (branch tip)" \
    ref      "Update to a pinned commit or tag…" \
    rollback "Roll back to the previous build" \
    token    "Set / rotate the deploy token…" \
    back     "← Back" || return 0
  case "$act" in
    tip)      run "Update" bash "${DEPLOY_DIR}/orwell-update.sh" ;;
    ref)      ref=""; wt_input ref "Commit SHA or tag to deploy:" "" || return 0
              [[ -n "$ref" ]] || { wt_msgbox "No ref entered — nothing changed."; return 0; }
              run "Update → ${ref}" env REF="$ref" bash "${DEPLOY_DIR}/orwell-update.sh" ;;
    rollback) wt_yesno "Roll back to the previously-installed build?\n\nRestores the last good commit + build recorded by the most recent update." --defaultno || return 0
              run "Rollback" bash "${DEPLOY_DIR}/orwell-update.sh" --rollback ;;
    token)    tok=""; wt_password tok "Deploy token (fine-grained PAT, Contents: Read-only on the repo).\nLeave blank to cancel:" || return 0
              [[ -n "$tok" ]] || { wt_msgbox "No token entered — unchanged."; return 0; }
              run "Set deploy token" env GIT_TOKEN="$tok" bash "${DEPLOY_DIR}/orwell-update.sh" --set-token ;;
  esac
}

do_update_reset() {
  # The combined middle tier: update (pull + rebuild) THEN OOBE reset, keeping the API-key/LLM
  # config. Dispatches to orwell-update-reset.sh (which composes the two existing scripts and is
  # fail-closed); nothing here re-implements its logic.
  if ! tui_active; then
    [[ "${1:-}" == "--yes" ]] || die "update-reset is destructive — pass --yes to run it non-interactively."
    run "Update + Reset (keep API keys)" bash "${DEPLOY_DIR}/orwell-update-reset.sh" --yes; return $?
  fi
  wt_confirm_phrase "RESET" "UPDATE + RESET — pull latest, rebuild, THEN reset to first-run OOBE, KEEPING your API keys.\n\nPhase 1 UPDATES: git pull → rebuild the engine → refresh front-end deps (no restart yet).\nPhase 2 RESETS to OOBE: PERMANENTLY DELETES all games AND the front-end store (accounts, sessions, settings, MCP configs, uploads).\n\nPRESERVED: your LLM / image provider config + the keys that decrypt them, and data/.env.\n\nIf the update fails, the reset does NOT run — nothing is wiped. The next visit starts at first-run OOBE on the freshly-pulled build, with an LLM already configured." \
    || { wt_msgbox "Cancelled — nothing was changed."; return 0; }
  run "Update + Reset (keep API keys)" bash "${DEPLOY_DIR}/orwell-update-reset.sh" --yes
}

do_doctor() {
  if ! tui_active; then run "Doctor" bash "${DEPLOY_DIR}/orwell-doctor.sh" "${1:---fix}"; return $?; fi
  local mode
  wt_menu mode "Doctor — diagnose & repair:" \
    --fix    "Diagnose, then fix anything unhealthy (default)" \
    --status "Diagnose only — no restarts" \
    --bounce "Force-restart the engine + front-end" \
    back     "← Back" || return 0
  [[ "$mode" == back ]] && return 0
  run "Doctor ${mode}" bash "${DEPLOY_DIR}/orwell-doctor.sh" "$mode"
}

do_backup() { run "Backup" bash "${DEPLOY_DIR}/orwell-backup.sh"; }
do_ready()  { run "Readiness" bash "${DEPLOY_DIR}/orwell-ready.sh"; }

do_change_port() {
  # Change the front-end UI port (ORWELL_PORT), reconciling the privileged-port (<1024)
  # CAP_NET_BIND_SERVICE drop-in. Dispatches to orwell-change-port.sh; nothing re-implemented here.
  if ! tui_active; then
    [[ -n "${1:-}" ]] || die "change-port needs a port: orwell change-port <port> [--yes|--no-restart|--dry-run]"
    run "Change UI port → $1" bash "${DEPLOY_DIR}/orwell-change-port.sh" "$@"; return $?
  fi
  local cur port
  cur="$(sed -n 's/^ORWELL_PORT=//p' "${APP_DIR}/data/.env" 2>/dev/null | tail -n1)"; cur="${cur:-8080}"
  port=""
  wt_input port "Change the front-end (UI) port.\n\nCurrent: ${cur}\n\nEnter the new port (1–65535; 80 = standard HTTP). Moving to/from a privileged port (<1024) is handled automatically." "$cur" || return 0
  [[ -n "$port" ]] || { wt_msgbox "No port entered — unchanged."; return 0; }
  run "Change UI port → ${port}" bash "${DEPLOY_DIR}/orwell-change-port.sh" "$port" --yes
}

do_https() {
  # Local HTTPS: stand up the Caddy TLS terminator in front of the front-end, driven by the tunable
  # ORWELL_TLS_* variables in data/.env. Dispatches to orwell-https.sh (the single apply engine);
  # nothing re-implemented here. Off a TTY it forwards flags straight through.
  if ! tui_active; then
    run "Local HTTPS" bash "${DEPLOY_DIR}/orwell-https.sh" "$@"; return $?
  fi
  local cur
  cur="$(sed -n 's/^ORWELL_TLS_MODE=//p' "${APP_DIR}/data/.env" 2>/dev/null | tail -n1)"; cur="${cur:-off}"
  # The script owns the rich interactive flow (mode, local names, optional domain + DNS token); just
  # launch it interactively so its whiptail prompts run.
  run "Local HTTPS" bash "${DEPLOY_DIR}/orwell-https.sh"
}

do_restore() {
  local dir="${APP_DIR}/backups" sel f; local -a list args
  if ! tui_active; then
    sel="${1:-$(ls -1t "${dir}"/orwell-backup-*.tar.gz 2>/dev/null | head -1)}"
    [[ -n "${sel:-}" ]] || die "no backups found in ${dir} (run 'orwell backup' first, or pass a file)."
    run "Restore" bash "${DEPLOY_DIR}/orwell-restore.sh" "$sel"; return $?
  fi
  mapfile -t list < <(ls -1t "${dir}"/orwell-backup-*.tar.gz 2>/dev/null)
  [[ ${#list[@]} -gt 0 ]] || { wt_msgbox "No backups found in:\n${dir}\n\nCreate one first (Backup)."; return 0; }
  args=(); for f in "${list[@]}"; do args+=("$f" "$(date -r "$f" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '')"); done
  wt_menu sel "Choose a backup to restore:" "${args[@]}" || return 0
  wt_yesno "Restore from:\n${sel}\n\nThis STOPS the services and OVERWRITES the current engine + front-end data with the backup, then restarts." --defaultno || return 0
  run "Restore" bash "${DEPLOY_DIR}/orwell-restore.sh" "$sel"
}

do_reset_game() {
  if ! tui_active; then
    [[ "${1:-}" == "--yes" ]] || die "reset-game is destructive — pass --yes to run it non-interactively."
    run "Game reset" bash "${DEPLOY_DIR}/orwell-game-reset.sh" --yes; return $?
  fi
  wt_confirm_phrase "RESET" "NEW SEASON — game reset.\n\nPERMANENTLY DELETES every game sandbox (all saves, souls, and the hidden Vault layer).\n\nPRESERVED: all accounts, sessions, settings, and the LLM configuration.\n\nThe next visit starts a brand-new game at the casting interview." \
    || { wt_msgbox "Cancelled — nothing was changed."; return 0; }
  run "Game reset" bash "${DEPLOY_DIR}/orwell-game-reset.sh" --yes
}

do_reset_oobe() {
  if ! tui_active; then
    [[ "${1:-}" == "--yes" ]] || die "reset-oobe is destructive — pass --yes to run it non-interactively."
    run "OOBE reset (keep API keys)" bash "${DEPLOY_DIR}/orwell-oobe-reset.sh" --yes; return $?
  fi
  wt_confirm_phrase "RESET" "OOBE RESET — back to first-run onboarding, KEEPING your API keys.\n\nPERMANENTLY DELETES all games AND the front-end store (accounts, sessions, settings, MCP configs, uploads).\n\nPRESERVED: your LLM / image provider config + the keys that decrypt them, and data/.env.\n\nThe next visit starts at first-run OOBE — with an LLM already configured." \
    || { wt_msgbox "Cancelled — nothing was changed."; return 0; }
  run "OOBE reset (keep API keys)" bash "${DEPLOY_DIR}/orwell-oobe-reset.sh" --yes
}

do_reset_factory() {
  if ! tui_active; then
    [[ "${1:-}" == "--yes" ]] || die "reset-factory is destructive — pass --yes to run it non-interactively."
    run "Factory reset" bash "${DEPLOY_DIR}/orwell-factory-reset.sh" --yes; return $?
  fi
  wt_confirm_phrase "RESET" "FACTORY RESET — back to first-run onboarding, KEEPING your API keys.\n\nPERMANENTLY DELETES all games AND the entire front-end store (accounts, sessions, settings, MCP configs, uploads, and EVERY cast portrait / avatar / headshot).\n\nPRESERVED: your API keys + provider endpoint (+ data/.env). The SELECTED MODELS reset to the OOB defaults (glm-5.2 narrator, qwen3.6-flash utility, gemini-3.1-flash-image portraits).\n\nThe next visit starts at first-run OOBE — with an LLM already configured." \
    || { wt_msgbox "Cancelled — nothing was changed."; return 0; }
  run "Factory reset" bash "${DEPLOY_DIR}/orwell-factory-reset.sh" --yes
}

# ── Direct subcommands (bypass the menu) ────────────────────────────────────────────────────────
case "${1:-}" in
  update)        shift; do_update "$@";        exit $? ;;
  update-reset)  shift; do_update_reset "$@";  exit $? ;;
  doctor)        shift; do_doctor "$@";        exit $? ;;
  backup)               do_backup;             exit $? ;;
  restore)       shift; do_restore "$@";       exit $? ;;
  ready)                do_ready;              exit $? ;;
  change-port)   shift; do_change_port "$@";   exit $? ;;
  https)         shift; do_https "$@";         exit $? ;;
  reset-game)    shift; do_reset_game "$@";    exit $? ;;
  reset-oobe)    shift; do_reset_oobe "$@";    exit $? ;;
  reset-factory) shift; do_reset_factory "$@"; exit $? ;;
  "")            : ;;  # no subcommand → fall through to the interactive menu
  *)             usage; die "unknown command: $1" ;;
esac

# ── Interactive menu loop ───────────────────────────────────────────────────────────────────────
# A one-time logo splash on the terminal before the first dialog draws (whiptail's boxed widgets
# can't render the wordmark themselves). Cleared away by the menu; cheap and TTY-only.
if [[ -t 1 ]]; then
  command -v clear >/dev/null 2>&1 && clear || true
  ow_logo "control panel  ·  ${APP_DIR}@$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
  sleep 1 2>/dev/null || true
fi
while :; do
  choice=""
  wt_menu choice "$(printf 'Orwell @ %s  (%s)\n\nChoose an action:' \
        "$APP_DIR" "$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')")" \
    update        "Update / rollback / deploy token" \
    update-reset  "Update + Reset (update, then OOBE; KEEP API keys)" \
    doctor        "Diagnose & repair the services" \
    ready         "Readiness check (engine + FE + LLM)" \
    change-port   "Change the UI port (to/from :80)" \
    https         "Local HTTPS (trusted on the LAN, no warning)" \
    backup        "Back up game + user data" \
    restore       "Restore from a backup" \
    reset-game    "New season (keeps accounts + config)" \
    reset-oobe    "OOBE reset (back to OOBE, KEEP API keys)" \
    reset-factory "Factory reset (back to OOBE, KEEP API keys + models)" \
    quit          "Quit" \
    || break
  case "$choice" in
    update)        do_update ;;
    update-reset)  do_update_reset ;;
    doctor)        do_doctor ;;
    ready)         do_ready ;;
    change-port)   do_change_port ;;
    https)         do_https ;;
    backup)        do_backup ;;
    restore)       do_restore ;;
    reset-game)    do_reset_game ;;
    reset-oobe)    do_reset_oobe ;;
    reset-factory) do_reset_factory ;;
    quit|"")       break ;;
  esac
done
command -v clear >/dev/null 2>&1 && clear || true
exit 0
