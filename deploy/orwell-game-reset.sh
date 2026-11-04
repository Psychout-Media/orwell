#!/usr/bin/env bash
#
# orwell — game reset. Clears ALL game progression — every per-user engine sandbox
# (saves, souls, the hidden Vault layer, in-flight casting intake) — and NOTHING else.
#
# CONFIG IS PRESERVED, all of it: the engine data/.env (ports, tokens, LLM keys, AND the
# public-deployment / SSL profile — ORWELL_PUBLIC, ALLOWED_HOSTS/ORIGINS, SECURE_COOKIES, …),
# the data/ops/ public-deployment apply record, AND the entire front-end store (accounts,
# sessions, settings — including the LLM endpoint config). The OS-level cloudflared tunnel is
# untouched, so a box that was made PUBLIC on the web STAYS public. Players keep their logins and
# the box keeps its LLM + internet setup; the next visit simply starts a brand-new game at the
# casting interview. (Old chat transcripts are kept too — a fresh game session begins on the next
# visit. For a full wipe back to OOBE use orwell-factory-reset.sh.)
#
# Run on the Proxmox HOST or inside the container as root:
#   bash /path/to/orwell-game-reset.sh             # prompts to confirm
#   bash /path/to/orwell-game-reset.sh --yes       # no prompt (automation)
#   bash /path/to/orwell-game-reset.sh --dry-run   # show what WOULD be removed
#   bash /path/to/orwell-game-reset.sh --no-restart # scrub but leave services down
#
# On the Proxmox host the script locates the orwell LXC (by hostname "orwell"; override with
# CTID=<id> or CT_HOSTNAME=<name>) and re-runs itself inside it — same bridge as
# orwell-update.sh / orwell-factory-reset.sh.
#
# Paths/services are overridable via env: APP_DIR, ORWELL_DATA_DIR, ORWELL_ENGINE_SVC,
# ORWELL_FRONTEND_SVC (handy for a dev checkout).
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

# Collect flags so they can be forwarded to the in-container run.
ASSUME_YES=0; DRY_RUN=0; RESTART=1; EXTRA_FLAGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)        ASSUME_YES=1; EXTRA_FLAGS+=("--yes") ;;
    -n|--dry-run)    DRY_RUN=1;    EXTRA_FLAGS+=("--dry-run") ;;
    --no-restart)    RESTART=0;    EXTRA_FLAGS+=("--no-restart") ;;
    -h|--help)       sed -n '3,24p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
# re-run this script inside it, forwarding all flags. Same pattern as orwell-update.sh.
# Inside the container pct does not exist (and the app dir does), so this block is skipped.
if command -v pct >/dev/null 2>&1 && ! find_app >/dev/null 2>&1; then
  CTID="${CTID:-$(pct list 2>/dev/null | awk -v n="$CT_HOSTNAME" 'NR>1 && $NF==n {print $1}' || true)}"
  # Legacy-aware: a pre-rename box may still run an LXC literally named "bbai".
  [[ -n "$CTID" || -n "$CT_HOSTNAME_SET" ]] || CTID="$(pct list 2>/dev/null | awk 'NR>1 && $NF=="bbai" {print $1}' || true)"
  [[ -n "$CTID" ]] || die "no orwell LXC found (hostname '${CT_HOSTNAME}' or legacy 'bbai'). Set CTID=<id> and retry."
  [[ "$(printf '%s' "$CTID" | wc -w)" -eq 1 ]] || die "multiple containers named '${CT_HOSTNAME}' (${CTID//$'\n'/ }). Set CTID=<id>."
  [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] || die "LXC ${CTID} is not running — start it first: pct start ${CTID}"

  msg "orwell lives in LXC ${CTID}; running game reset inside the container"
  # LOCAL-COPY bridge (A4/ruling #17 — closes audit E84): never curl a branch tip from GitHub.
  # Run from a file → push THAT file; run via `bash -c "$(...)"` → push the running text;
  # otherwise run the container's own checked-out copy.
  if [[ -n "${BASH_SOURCE[0]:-}" && -r "${BASH_SOURCE[0]:-}" ]]; then
    TMP_RESET="$(mktemp /tmp/orwell-game-reset-XXXXXX.sh)"
    cp "${BASH_SOURCE[0]}" "$TMP_RESET"
    pct push "$CTID" "$TMP_RESET" /tmp/orwell-game-reset.sh
    rm -f "$TMP_RESET"
    pct exec "$CTID" -- bash /tmp/orwell-game-reset.sh ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}
  elif [[ -n "${BASH_EXECUTION_STRING:-}" ]]; then
    TMP_RESET="$(mktemp /tmp/orwell-game-reset-XXXXXX.sh)"
    printf '%s\n' "$BASH_EXECUTION_STRING" > "$TMP_RESET"
    pct push "$CTID" "$TMP_RESET" /tmp/orwell-game-reset.sh
    rm -f "$TMP_RESET"
    pct exec "$CTID" -- bash /tmp/orwell-game-reset.sh ${EXTRA_FLAGS[@]+"${EXTRA_FLAGS[@]}"}
  else
    pct exec "$CTID" -- bash -c "for d in /opt/orwell /opt/bbai; do
        [ -f \"\$d/deploy/orwell-game-reset.sh\" ] && exec bash \"\$d/deploy/orwell-game-reset.sh\" ${EXTRA_FLAGS[*]:-}
      done; echo 'ERROR: no in-container deploy/orwell-game-reset.sh found' >&2; exit 1"
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
# orwell-factory-reset.sh (modern installs set ORWELL_DATA_DIR=<app>/data/saves since B72;
# pre-B72 pointed it at <app>/data; ancient ones never set it).
env_val() { [[ -f "$ENV_FILE" ]] && grep -E "^[[:space:]]*${1}=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^["'\'']//;s/["'\'']$//;s/\r$//'; }
ENGINE_SAVE_DIR="${ORWELL_DATA_DIR:-}"
[[ -n "$ENGINE_SAVE_DIR" ]] || ENGINE_SAVE_DIR="$(env_val ORWELL_DATA_DIR || true)"
[[ -n "$ENGINE_SAVE_DIR" ]] || ENGINE_SAVE_DIR="$(env_val BBAI_DATA_DIR || true)"
[[ -n "$ENGINE_SAVE_DIR" ]] || ENGINE_SAVE_DIR="${APP_DIR}/.orwell-data"
# A relative ORWELL_DATA_DIR (e.g. ./.orwell-data) resolves against the engine CWD = APP_DIR.
[[ "$ENGINE_SAVE_DIR" == /* ]] || ENGINE_SAVE_DIR="${APP_DIR%/}/${ENGINE_SAVE_DIR#./}"

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

# ── Environment detection ─────────────────────────────────────────────────────────────────────
have_systemd=0
if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then have_systemd=1; fi
svc_exists() { systemctl list-unit-files "${1}.service" --no-legend 2>/dev/null | grep -q .; }

if [[ "$DRY_RUN" -eq 0 && "$(id -u)" -ne 0 ]]; then
  # Root is needed to remove data under /opt and to stop/start the systemd services — but NOT for a
  # self-contained run on non-/opt paths with no orwell-* units present (a CI/dev test). Gate on what
  # the run will actually touch, not merely on systemd being installed (CI runners have systemd).
  needs_root=0
  [[ "$CONFIG_DIR" == /opt/* || "$ENGINE_SAVE_DIR" == /opt/* ]] && needs_root=1
  if [[ "$have_systemd" -eq 1 ]] && { svc_exists "$ENGINE_SVC" || svc_exists "$FRONTEND_SVC"; }; then needs_root=1; fi
  if [[ "$needs_root" -eq 1 ]]; then
    die "run as root (sudo): needs to stop services and remove the game saves under ${APP_DIR}."
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
    ORWELL_TUI_TITLE="Orwell — game reset"
    wt_confirm_phrase "RESET" "NEW SEASON — game reset.

PERMANENTLY DELETES all game progression (every season, finished or live):
  • ${SANDBOXES} game sandbox(es) under ${ENGINE_SAVE_DIR}/<user>/
    (saves, souls, the hidden Vault layer)

PRESERVED (everything else):
  • ${CONFIG_DIR}/${ENV_KEEP} (ports, tokens, LLM keys)
  • the entire front-end store (accounts, sessions, settings)

The next visit starts a brand-new game at the casting interview." \
      || die "aborted — no changes made."
  else
    cat <<EOF
This PERMANENTLY DELETES all game progression (every season, finished or live):
  • ${SANDBOXES} game sandbox(es)  under ${ENGINE_SAVE_DIR}/<user>/   (saves, souls, hidden Vault layer)
Preserved (everything else):
  • ${CONFIG_DIR}/${ENV_KEEP}  (ports, tokens, LLM keys)
  • the entire front-end store  (accounts, sessions, settings — incl. LLM endpoint config)
The next visit starts a brand-new game at the casting interview.
EOF
    read -r -p "Type 'RESET' to proceed: " ans
    [[ "$ans" == "RESET" ]] || die "aborted — no changes made."
  fi
fi

# ── Helpers (dry-run aware) ───────────────────────────────────────────────────────────────────
do_rm()  { if [[ "$DRY_RUN" -eq 1 ]]; then echo "  would remove: $1"; else rm -rf -- "$1"; fi; }
do_svc() {
  if [[ "$DRY_RUN" -eq 1 ]]; then echo "  would: systemctl $1 $2"; else systemctl "$1" "$2" || warn "systemctl $1 $2 failed"; fi
}

# ── 1. Stop the services so nothing writes while we scrub ─────────────────────────────────────
if [[ "$have_systemd" -eq 1 ]]; then
  msg "stopping services"
  for svc in "$FRONTEND_SVC" "$ENGINE_SVC"; do svc_exists "$svc" && do_svc stop "$svc"; done
else
  warn "systemctl not present — skipping service stop (dev mode). Stop the app yourself first."
fi

# ── 2a. Scrub the engine SAVE dir — the per-user games (saves + hidden Vault layer), ──────────
#       always KEEPING .env AND data/ops/ (the public-deployment apply record + ops trigger dir)
#       in case the save dir and the config dir are the same.
msg "scrubbing engine saves in ${ENGINE_SAVE_DIR}"
if [[ -d "$ENGINE_SAVE_DIR" ]]; then
  while IFS= read -r -d '' entry; do do_rm "$entry"; done \
    < <(find "$ENGINE_SAVE_DIR" -mindepth 1 -maxdepth 1 ! -name "$ENV_KEEP" ! -name models ! -name ops -print0)
else
  warn "engine save dir ${ENGINE_SAVE_DIR} absent — nothing to scrub there"
fi

# ── 2b. Also scrub any sandboxes that landed in the CONFIG dir (covers ORWELL_DATA_DIR=<app>/data),
#       always KEEPING .env (the preserved config) and data/ops/ (the public-deployment apply
#       record + the live ops trigger/status dir). Skipped when it's the same dir as 2a.
if [[ "$CONFIG_DIR" != "$ENGINE_SAVE_DIR" ]]; then
  msg "scrubbing config dir ${CONFIG_DIR} (keeping ${ENV_KEEP})"
  if [[ -d "$CONFIG_DIR" ]]; then
    while IFS= read -r -d '' entry; do do_rm "$entry"; done \
      < <(find "$CONFIG_DIR" -mindepth 1 -maxdepth 1 -type d ! -name models ! -name ops -print0)
  fi
fi

# ── 2c. Scrub the cast-portrait dir (feature 0051) — a new season means a new cast, so the ────
#       generated faces from the old game must go too. The rest of the FE store (accounts,
#       sessions, settings) is PRESERVED; only this game-scoped subtree is removed.
FE_DATA_DIR="${ORWELL_FE_DATA_DIR:-${APP_DIR}/frontend/data}"
PORTRAITS_DIR="${ORWELL_PORTRAITS_DIR:-${FE_DATA_DIR}/portraits}"
if [[ -d "$PORTRAITS_DIR" ]]; then
  # Same safety as CONFIG_DIR / ENGINE_SAVE_DIR: an ORWELL_PORTRAITS_DIR=/ (or other empty/root/
  # too-shallow) override passes the [[ -d ]] test above but must NEVER be rm -rf'd. Validate the
  # shape before removal — sanity_path dies on empty, non-absolute, '/', or depth < 2.
  sanity_path "$PORTRAITS_DIR" "cast PORTRAITS_DIR"
  msg "scrubbing cast portraits in ${PORTRAITS_DIR}"
  do_rm "$PORTRAITS_DIR"
fi

# ── 3. Restart so the engine reloads with no saves; the front-end keeps its config ────────────
if [[ "$RESTART" -eq 1 && "$have_systemd" -eq 1 ]]; then
  msg "restarting services"
  for svc in "$ENGINE_SVC" "$FRONTEND_SVC"; do svc_exists "$svc" && do_svc start "$svc"; done
elif [[ "$RESTART" -eq 0 ]]; then
  msg "left services stopped (--no-restart). Start them when ready."
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  msg "dry run complete — nothing was removed."
else
  msg "game reset complete. Accounts and LLM config kept; the next visit starts a new game at the casting interview."
fi
