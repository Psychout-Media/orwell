#!/usr/bin/env bash
#
# orwell — rebuild (destroy + re-provision, KEEP ONLY the deploy token).
#
# The "nuke and pave" tier: DESTROY the orwell LXC and re-provision a fresh one (fresh OS + fresh
# code) with the SAME container parameters, preserving ONLY the deploy GIT_TOKEN. The rebuilt box
# lands at first-run OOBE — you re-enter the LLM key once. Unlike the reset tiers it does NOT keep
# accounts, saves, or the LLM/provider config — it is a brand-new container.
#
# Use it when the container itself is wedged (a corrupt rootfs, a botched OS upgrade, drifted
# system state) and a reset of the app data is not enough. For a clean app with a working
# container, prefer orwell-factory-reset.sh / orwell-oobe-reset.sh / orwell-game-reset.sh.
#
# HOST-ONLY: this destroys an LXC, so it MUST run on the Proxmox host (it has `pct`). A container
# cannot destroy itself, so running it inside the LXC is refused with a clear error.
#
# FAIL-SAFE ORDERING — it NEVER destroys the old container until BOTH are true:
#   1. the deploy GIT_TOKEN was salvaged from the old data/.env (so the rebuild can fetch the
#      repo with the deploy token, as every deploy does; the repo itself is public, ORW-426), AND
#   2. a timestamped safety-net backup of the old data/ + frontend/data/ was written to the host.
# If either fails, it ABORTS and leaves the old container completely untouched.
#
#   bash deploy/orwell-rebuild.sh             # prompts to confirm (type RESET)
#   bash deploy/orwell-rebuild.sh --yes       # no prompt (automation)
#   bash deploy/orwell-rebuild.sh --dry-run   # show exactly what it WOULD destroy + recreate; change nothing
#   bash deploy/orwell-rebuild.sh -h          # help
#
# Locates the orwell LXC by hostname "orwell" (legacy "bbai"); override with CTID=<id> or
# CT_HOSTNAME=<name> — the same discovery idiom as orwell-update.sh / orwell-doctor.sh. The old
# container's resources (cores, RAM, disk, net/bridge, hostname) and UI port are captured and
# mapped onto orwell.sh's env overrides so the new box matches the old one.
#
# NOTE: the in-container `orwell` control panel can NOT host this action — it would destroy its own
# container mid-run. It is a host-only script.
set -euo pipefail

BACKUP_DIR="${ORWELL_REBUILD_BACKUP_DIR:-/var/lib/orwell-backups}"
CT_HOSTNAME_SET="${CT_HOSTNAME:+1}"   # explicit override disables the legacy-name fallback
CT_HOSTNAME="${CT_HOSTNAME:-orwell}"

# ── Optional whiptail TUI + presentation helpers (deploy/orwell-tui.sh) ─────────────────────────
# Sourced for the ow_* sectioned status lines and the destructive confirm dialog. Absent / off a
# TTY → tui_active is false and the plain-text type-RESET prompt runs instead. The lib is searched
# beside this file first (the host checkout), then the installed checkouts.
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -n "${__lib:-}" && -r "$__lib" ]]; then . "$__lib"; break; fi
done
# Fallbacks so the script runs even if the lib is somehow missing (the host checkout always has it).
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }
type ow_logo    >/dev/null 2>&1 || ow_logo()    { :; }
type ow_section >/dev/null 2>&1 || ow_section()  { printf '\n== %s ==\n' "${1:-}"; }
type ow_step    >/dev/null 2>&1 || ow_step()     { printf '  > %s\n' "$*"; }
type ow_ok      >/dev/null 2>&1 || ow_ok()       { printf '  ok %s\n' "$*"; }
type ow_warn    >/dev/null 2>&1 || ow_warn()     { printf '  ! %s\n' "$*"; }
type ow_fail    >/dev/null 2>&1 || ow_fail()     { printf '  x %s\n' "$*"; }
type ow_info    >/dev/null 2>&1 || ow_info()     { printf '  . %s\n' "$*"; }

die() { ow_fail "$*"; exit 1; }

# ── Flags ───────────────────────────────────────────────────────────────────────────────────────
ASSUME_YES=0; DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)     ASSUME_YES=1 ;;
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help)    sed -n '3,34p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

ow_logo "rebuild — destroy + re-provision (keep only the deploy token)"

# ── 1. Host-only guard ──────────────────────────────────────────────────────────────────────────
# This destroys an LXC; only the Proxmox host can do that, and a container cannot destroy itself.
if ! command -v pct >/dev/null 2>&1; then
  die "this must run on the Proxmox HOST (pct not found). A container cannot destroy itself — run it from the host shell."
fi
# Belt: refuse if we are clearly INSIDE a container (systemd-detect-virt is the canonical probe).
if command -v systemd-detect-virt >/dev/null 2>&1 \
   && [[ "$(systemd-detect-virt --container 2>/dev/null || true)" == "lxc" ]]; then
  die "running inside an LXC — refusing. Run orwell-rebuild.sh on the Proxmox host (it cannot destroy its own container)."
fi
[[ "$(id -u)" -eq 0 ]] || die "run this on the Proxmox host as root (needs pct + write to ${BACKUP_DIR})."

# ── 2. Discover the LXC (the orwell-update.sh idiom) ─────────────────────────────────────────────
ow_section "Locate the container"
CTID="${CTID:-$(pct list 2>/dev/null | awk -v n="$CT_HOSTNAME" 'NR>1 && $NF==n {print $1}' || true)}"
# Legacy-aware: a pre-rename box may still run an LXC literally named "bbai".
[[ -n "$CTID" || -n "$CT_HOSTNAME_SET" ]] || CTID="$(pct list 2>/dev/null | awk 'NR>1 && $NF=="bbai" {print $1}' || true)"
[[ -n "$CTID" ]] || die "no orwell LXC found (hostname '${CT_HOSTNAME}' or legacy 'bbai'). Set CTID=<id> and retry."
[[ "$(printf '%s' "$CTID" | wc -w)" -eq 1 ]] || die "multiple containers named '${CT_HOSTNAME}' (${CTID//$'\n'/ }). Set CTID=<id>."
pct config "$CTID" >/dev/null 2>&1 || die "LXC ${CTID} does not exist (pct config ${CTID} failed)."
ow_ok "found orwell in LXC ${CTID}"

# ── 3. Capture the old container config so the new one matches ───────────────────────────────────
# `pct config` prints `key: value` lines. Pull the resource + network fields and map them onto the
# env overrides orwell.sh honors (CTID, CT_HOSTNAME, CORES, RAM_MB, DISK_GB, NET0, ORWELL_PORT).
ow_section "Capture the old config"
CONF="$(pct config "$CTID" 2>/dev/null || true)"
conf_get() { printf '%s\n' "$CONF" | sed -n "s/^$1:[[:space:]]*//p" | head -n1; }

OLD_HOSTNAME="$(conf_get hostname)"; OLD_HOSTNAME="${OLD_HOSTNAME:-$CT_HOSTNAME}"
OLD_CORES="$(conf_get cores)"
OLD_MEMORY="$(conf_get memory)"            # MB
OLD_NET0="$(conf_get net0)"               # full pct net0 option string — replayed verbatim
OLD_ROOTFS="$(conf_get rootfs)"           # e.g. local-lvm:vm-104-disk-0,size=12G
# Disk size from the rootfs line's size= field (digits + unit); default to the installer's 12 (GB).
OLD_DISK_GB="$(printf '%s' "$OLD_ROOTFS" | sed -n 's/.*size=\([0-9]*\)[Gg].*/\1/p' | head -n1)"

# Whether the container is running (we need it up to pct exec into it for the token/port/backup).
ENGINE_RUNNING=0
[[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] && ENGINE_RUNNING=1

# App dir: /opt/orwell, legacy /opt/bbai. Only resolvable while the container is running (pct exec).
OLD_APP_DIR=""
if [[ "$ENGINE_RUNNING" -eq 1 ]]; then
  OLD_APP_DIR="$(pct exec "$CTID" -- bash -c '
    for d in /opt/orwell /opt/bbai; do [ -d "$d/.git" ] && { printf "%s" "$d"; exit 0; }; done' 2>/dev/null || true)"
fi
OLD_APP_DIR="${OLD_APP_DIR:-/opt/orwell}"

# UI port from data/.env (ORWELL_PORT, legacy BBAI_PORT). Container must be running to read it.
OLD_PORT=""
if [[ "$ENGINE_RUNNING" -eq 1 ]]; then
  OLD_PORT="$(pct exec "$CTID" -- bash -c '
    f="'"$OLD_APP_DIR"'/data/.env"
    [ -f "$f" ] || exit 0
    v="$(sed -n "s/^ORWELL_PORT=//p" "$f" | tail -n1)"
    [ -n "$v" ] || v="$(sed -n "s/^BBAI_PORT=//p" "$f" | tail -n1)"
    printf "%s" "$v"' 2>/dev/null || true)"
fi
OLD_PORT="${OLD_PORT:-8080}"

# Bind host from data/.env (ORWELL_BIND_HOST) — salvaged like the port so a rebuilt box keeps the
# old box's LAN reachability. The unit's built-in default is loopback and orwell.sh's install-time
# default is 0.0.0.0, so an old PROXY box (127.0.0.1) MUST carry that choice over or it would flip
# to LAN on rebuild. Belt-and-suspenders for the install-time persistence: an empty result (old
# .env had no value) lets orwell.sh apply its default (LAN=yes ⇒ 0.0.0.0). Not a secret, but read
# the same careful way as the token (into a var over pct exec, never echoed onto a command line).
OLD_BIND_HOST=""
if [[ "$ENGINE_RUNNING" -eq 1 ]]; then
  OLD_BIND_HOST="$(pct exec "$CTID" -- bash -c '
    f="'"$OLD_APP_DIR"'/data/.env"
    [ -f "$f" ] || exit 0
    sed -n "s/^ORWELL_BIND_HOST=//p" "$f" | tail -n1' 2>/dev/null || true)"
fi

[[ -n "$OLD_CORES"   ]] && ow_ok "cores:   ${OLD_CORES}"      || ow_warn "cores not in config — orwell.sh default applies"
[[ -n "$OLD_MEMORY"  ]] && ow_ok "memory:  ${OLD_MEMORY} MB"  || ow_warn "memory not in config — orwell.sh default applies"
[[ -n "$OLD_DISK_GB" ]] && ow_ok "disk:    ${OLD_DISK_GB} GB" || ow_warn "rootfs size not parseable — orwell.sh default applies"
[[ -n "$OLD_NET0"    ]] && ow_ok "net0:    ${OLD_NET0}"       || ow_warn "net0 not in config — orwell.sh default applies"
ow_ok "hostname: ${OLD_HOSTNAME}"
ow_ok "UI port:  ${OLD_PORT}"
[[ -n "$OLD_BIND_HOST" ]] && ow_ok "bind host: ${OLD_BIND_HOST}" || ow_warn "bind host not in old .env — orwell.sh install default (LAN, 0.0.0.0) applies"
ow_ok "app dir:  ${OLD_APP_DIR}"

# ── 4. Salvage GIT_TOKEN (without ever printing it) ─────────────────────────────────────────────
# Capture the deploy PAT from the old data/.env so the rebuild can fetch the repo the way every deploy does (the repo is public, ORW-426; the deploy path still uses a token). The
# value is read into a variable over pct exec and NEVER echoed/logged; `set -x` is never enabled.
# An explicit GIT_TOKEN=<pat> in the environment wins (lets an operator rebuild a box whose old
# .env lost the token, e.g. a wedged container that won't `pct exec`).
ow_section "Salvage the deploy token"
GIT_TOKEN="${GIT_TOKEN:-}"
if [[ -z "$GIT_TOKEN" && "$ENGINE_RUNNING" -eq 1 ]]; then
  GIT_TOKEN="$(pct exec "$CTID" -- bash -c '
    f="'"$OLD_APP_DIR"'/data/.env"
    [ -f "$f" ] && sed -n "s/^GIT_TOKEN=//p" "$f" | tail -n1' 2>/dev/null || true)"
fi
if [[ -n "$GIT_TOKEN" ]]; then
  ow_ok "deploy token in hand (value not shown)"
else
  ow_warn "could NOT obtain GIT_TOKEN (set GIT_TOKEN=<pat> to supply it explicitly)"
fi

# ── 5. Safety-net backup of the old data (to the host) ──────────────────────────────────────────
# Tar the engine data/ (its .env + saves + souls) and frontend/data/ INSIDE the container, then
# pct pull the tarball to a timestamped file on the host. This is the recoverable record before we
# destroy anything. A dry-run skips writing the backup (it changes nothing) but reports the path.
ow_section "Safety-net backup"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_TGZ="${BACKUP_DIR%/}/orwell-rebuild-${CTID}-${STAMP}.tgz"
BACKUP_OK=0
if [[ "$DRY_RUN" -eq 1 ]]; then
  ow_info "[dry-run] would back up ${OLD_APP_DIR}/{data,frontend/data} -> ${BACKUP_TGZ}"
  BACKUP_OK=1
elif [[ "$ENGINE_RUNNING" -ne 1 ]]; then
  ow_warn "container is not running — cannot tar its data for the safety net"
else
  mkdir -p "$BACKUP_DIR" || die "cannot create backup dir ${BACKUP_DIR}"
  IN_TAR="/tmp/orwell-rebuild-backup-${STAMP}.tgz"
  # Build the tarball inside the container (relative to the app dir so paths restore cleanly).
  # Only include dirs that exist; a missing frontend/data is not fatal.
  if pct exec "$CTID" -- bash -c '
        set -e
        cd "'"$OLD_APP_DIR"'" || exit 1
        paths=()
        [ -d data ] && paths+=("data")
        [ -d frontend/data ] && paths+=("frontend/data")
        [ "${#paths[@]}" -gt 0 ] || { echo "no data dirs to back up" >&2; exit 1; }
        tar czf "'"$IN_TAR"'" "${paths[@]}"' 2>/dev/null; then
    if pct pull "$CTID" "$IN_TAR" "$BACKUP_TGZ" 2>/dev/null; then
      pct exec "$CTID" -- rm -f "$IN_TAR" 2>/dev/null || true
      chmod 600 "$BACKUP_TGZ" 2>/dev/null || true
      if [[ -s "$BACKUP_TGZ" ]]; then
        BACKUP_OK=1
        ow_ok "backup written: ${BACKUP_TGZ} ($(du -h "$BACKUP_TGZ" 2>/dev/null | cut -f1 || echo '?'))"
      else
        ow_fail "backup file is empty after pull — treating as failed"
      fi
    else
      ow_fail "pct pull of the backup tarball failed"
    fi
  else
    ow_fail "could not create the backup tarball inside the container"
  fi
fi

# ── 6. ABORT before any destroy if the token OR the backup is missing ────────────────────────────
# Fail-safe contract: we never destroy without a recovered token AND a good backup. On a dry-run
# these are advisory (we change nothing regardless).
if [[ "$DRY_RUN" -eq 0 ]]; then
  if [[ -z "$GIT_TOKEN" ]]; then
    die "no GIT_TOKEN recovered — the rebuilt box could not fetch the repo with the deploy token. NOTHING destroyed. Set GIT_TOKEN=<pat> and retry, or fix the old container's data/.env first."
  fi
  if [[ "$BACKUP_OK" -ne 1 ]]; then
    die "safety-net backup FAILED — refusing to destroy without a recoverable backup. NOTHING destroyed. Check ${BACKUP_DIR} is writable and the container is running, then retry."
  fi
fi

# ── 7. Confirm (skipped by --yes); --dry-run stops here after the preview ────────────────────────
ow_section "Confirm"
# Map the captured config onto the orwell.sh env overrides up front so the preview shows EXACTLY
# what the re-provision will use. Empty captures are simply not exported (orwell.sh applies its
# own defaults), so the new box still comes up.
declare -a REBUILD_ENV=( "CTID=${CTID}" "CT_HOSTNAME=${OLD_HOSTNAME}" "ORWELL_PORT=${OLD_PORT}" )
# Carry the salvaged bind host (only when found) so the rebuilt box matches the old reachability;
# absent ⇒ orwell.sh applies its install default (LAN, 0.0.0.0).
[[ -n "$OLD_BIND_HOST" ]] && REBUILD_ENV+=( "ORWELL_BIND_HOST=${OLD_BIND_HOST}" )
[[ -n "$OLD_CORES"   ]] && REBUILD_ENV+=( "CORES=${OLD_CORES}" )
[[ -n "$OLD_MEMORY"  ]] && REBUILD_ENV+=( "RAM_MB=${OLD_MEMORY}" )
[[ -n "$OLD_DISK_GB" ]] && REBUILD_ENV+=( "DISK_GB=${OLD_DISK_GB}" )
[[ -n "$OLD_NET0"    ]] && REBUILD_ENV+=( "NET0=${OLD_NET0}" )

ow_info "WOULD DESTROY LXC ${CTID} (${OLD_HOSTNAME}) and re-provision a fresh one with:"
for kv in "${REBUILD_ENV[@]}"; do ow_info "    ${kv}"; done
ow_info "    (deploy token: $([[ -n "$GIT_TOKEN" ]] && echo 'in hand, reused' || echo 'MISSING'))"
ow_info "    safety-net backup: ${BACKUP_TGZ}"

if [[ "$DRY_RUN" -eq 1 ]]; then
  ow_section "Dry run complete"
  ow_ok "nothing was changed — no backup written, no container destroyed."
  exit 0
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  if tui_active; then
    ORWELL_TUI_TITLE="Orwell — rebuild (destroy + re-provision)"
    wt_confirm_phrase "RESET" "REBUILD — DESTROY LXC ${CTID} (${OLD_HOSTNAME}) and re-provision a FRESH container.

This PERMANENTLY DESTROYS the container and ALL its data:
  • every game sandbox (saves, souls, the hidden Vault layer)
  • the front-end store (ALL accounts, chats, sessions, settings, uploads, portraits)
  • the LLM / provider configuration

PRESERVED:
  • ONLY the deploy GIT_TOKEN (so the new box can fetch the repo)

A safety-net backup was written to:
  ${BACKUP_TGZ}

The rebuilt box lands at first-run OOBE — you re-enter the LLM key once." \
      || die "aborted — no changes made (the safety-net backup at ${BACKUP_TGZ} is kept)."
  else
    cat <<EOF
REBUILD will DESTROY LXC ${CTID} (${OLD_HOSTNAME}) and re-provision a FRESH container.

PERMANENTLY DESTROYED (the whole container):
  • every game sandbox (saves, souls, the hidden Vault layer)
  • the front-end store (ALL accounts, chats, sessions, settings, uploads, portraits)
  • the LLM / provider configuration
PRESERVED:
  • ONLY the deploy GIT_TOKEN (so the new box can fetch the repo the way every deploy does)
Safety-net backup (kept regardless): ${BACKUP_TGZ}
The rebuilt box lands at first-run OOBE — re-enter the LLM key once.
EOF
    read -r -p "Type 'RESET' to proceed: " ans
    [[ "$ans" == "RESET" ]] || die "aborted — no changes made (the safety-net backup at ${BACKUP_TGZ} is kept)."
  fi
fi

# ── 8. Destroy: graceful stop, then force, then destroy ──────────────────────────────────────────
ow_section "Destroy the old container"
if [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]]; then
  ow_step "stopping LXC ${CTID} (graceful shutdown, then force)"
  # Graceful shutdown with a bounded timeout; fall back to a hard stop if it doesn't settle.
  if ! pct shutdown "$CTID" --timeout 60 >/dev/null 2>&1; then
    ow_warn "graceful shutdown timed out — forcing stop"
    pct stop "$CTID" >/dev/null 2>&1 || true
  fi
  # Make sure it is actually stopped before destroying.
  for _ in $(seq 1 15); do
    [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] || break
    sleep 1
  done
  [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] && pct stop "$CTID" >/dev/null 2>&1 || true
fi
ow_step "destroying LXC ${CTID}"
pct destroy "$CTID" >/dev/null 2>&1 \
  || die "pct destroy ${CTID} FAILED — the container may be partially removed. Your data backup is safe at ${BACKUP_TGZ}. Inspect with 'pct status ${CTID}' / 'pct destroy ${CTID} --force' and re-run the install if needed."
ow_ok "LXC ${CTID} destroyed"

# ── 9. Re-provision via the LOCAL orwell.sh (never a GitHub fetch) ────────────────────────────────
# Resolve the sibling installer next to THIS script. Pass the token + captured params via env
# (never on the command line — no token in host ps), and --default for a non-interactive run.
ow_section "Re-provision"
INSTALLER="${__here:+${__here}/orwell.sh}"
if [[ -z "$INSTALLER" || ! -r "$INSTALLER" ]]; then
  for cand in /opt/orwell/deploy/orwell.sh /opt/bbai/deploy/orwell.sh; do
    [[ -r "$cand" ]] && { INSTALLER="$cand"; break; }
  done
fi
[[ -n "$INSTALLER" && -r "$INSTALLER" ]] \
  || die "cannot find the local orwell.sh installer next to this script. The old container is already destroyed — recover with: GIT_TOKEN=<pat> bash deploy/orwell.sh --default (then restore ${BACKUP_TGZ} if needed)."

ow_step "running ${INSTALLER} --default with the captured container params"
# Export everything for the child process; GIT_TOKEN goes via env so it never lands in argv/ps.
export GIT_TOKEN
for kv in "${REBUILD_ENV[@]}"; do export "${kv?}"; done
bash "$INSTALLER" --default

# ── 10. Done ─────────────────────────────────────────────────────────────────────────────────────
ow_section "Rebuild complete"
ow_ok "LXC ${CTID} (${OLD_HOSTNAME}) rebuilt fresh; the deploy token was reused."
ow_info "Open the UI and finish first-run onboarding — you will RE-ENTER THE LLM KEY once (only the"
ow_info "deploy token survived; accounts / saves / LLM config did NOT)."
ow_info "If the old box was PUBLIC on the internet, re-run the admin \"Connect to the internet\" wizard —"
ow_info "token-only mode does NOT preserve the cloudflared / SSL profile."
ow_info "Safety-net backup of the OLD data is kept at: ${BACKUP_TGZ}"
