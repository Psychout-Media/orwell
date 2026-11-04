#!/usr/bin/env bash
#
# orwell — change the front-end UI port (ORWELL_PORT), with first-class support for moving
# TO and FROM a privileged port (<1024, e.g. 80).
#
# The hardened front-end unit (E85) runs uvicorn as the non-root `orwell` user with an EMPTY
# CapabilityBoundingSet, so it structurally CANNOT bind a port below 1024. This script reconciles
# the systemd CAP_NET_BIND_SERVICE drop-in for you (the SAME mechanism orwell-install.sh /
# orwell-update.sh use), updates ORWELL_PORT in data/.env, reloads systemd, restarts the
# front-end, and verifies the new port is serving. It only ever touches the UI port — never the
# engine's loopback MCP port (ORWELL_ENGINE_PORT).
#
# Run it EITHER on the Proxmox HOST (it locates the orwell LXC and runs INSIDE it) OR directly
# inside the container — same host→container bridge as orwell-update.sh.
#
# Usage:
#   bash orwell-change-port.sh 80            # move the UI to :80   (adds the CAP_NET_BIND_SERVICE drop-in)
#   bash orwell-change-port.sh 8080          # move back to :8080   (removes the drop-in — back to locked-down)
#   bash orwell-change-port.sh 80 --yes      # no confirmation prompt (automation)
#   bash orwell-change-port.sh 80 --no-restart   # change config only; don't restart yet
#   bash orwell-change-port.sh 80 --dry-run      # show what WOULD change; touch nothing (no root needed)
#   bash orwell-change-port.sh               # interactive (whiptail prompt on a TTY)
#
# Env overrides (same names the other deploy scripts honor): APP_DIR, CTID, CT_HOSTNAME,
# ORWELL_SERVICE_USER.
set -euo pipefail

NEW_PORT=""; ASSUME_YES=0; NO_RESTART=0; DRY_RUN=0
CT_HOSTNAME_SET="${CT_HOSTNAME:+1}"
CT_HOSTNAME="${CT_HOSTNAME:-orwell}"

usage() { sed -n '3,28p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; }

for __a in "$@"; do
  case "$__a" in
    --yes|-y)     ASSUME_YES=1 ;;
    --no-restart) NO_RESTART=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    -h|--help)    usage; exit 0 ;;
    -*)           echo "ERROR: unknown flag: $__a (see --help)" >&2; exit 1 ;;
    *)            [[ -z "$NEW_PORT" ]] && NEW_PORT="$__a" \
                    || { echo "ERROR: unexpected argument: $__a" >&2; exit 1; } ;;
  esac
done

# ── Optional whiptail TUI (deploy/orwell-tui.sh) ───────────────────────────────────────────────
# Sourced for the interactive port prompt + confirmation; searched beside this file first, then
# the installed checkout. Absent (e.g. the /tmp copy pushed into the container over pct exec with
# no PTY) ⇒ tui_active is false and the plain-text prompts below run unchanged.
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -n "${__lib:-}" && -r "$__lib" ]]; then . "$__lib"; break; fi
done
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }

msg()  { echo -e "==> $*"; }
warn() { echo -e "WARN: $*" >&2; }
die()  { echo "ERROR: $*" >&2; exit 1; }

# First install dir found here: an explicit override, then the current path, then the legacy one.
find_app() {
  local d
  for d in "${APP_DIR:-}" /opt/orwell /opt/bbai; do
    [[ -n "$d" && -d "$d/.git" ]] && { printf '%s' "$d"; return 0; }
  done
  return 1
}

# ── Host → container bridge ────────────────────────────────────────────────────────────────────
# On a Proxmox host (pct present, no local app dir) the app lives inside the LXC — locate the
# orwell container and re-run this change INSIDE it, exactly as orwell-update.sh does. There is no
# PTY in the container, so a target port MUST be supplied on the command line when bridging.
if command -v pct >/dev/null 2>&1 && ! find_app >/dev/null 2>&1; then
  [[ -n "$NEW_PORT" ]] || die "a target port is required from the host (no TTY in the container): e.g. bash $0 80"
  CTID="${CTID:-$(pct list 2>/dev/null | awk -v n="$CT_HOSTNAME" 'NR>1 && $NF==n {print $1}' || true)}"
  [[ -n "$CTID" || -n "$CT_HOSTNAME_SET" ]] || CTID="$(pct list 2>/dev/null | awk 'NR>1 && $NF=="bbai" {print $1}' || true)"
  [[ -n "$CTID" ]] || die "no orwell LXC found (hostname '${CT_HOSTNAME}' or legacy 'bbai'). Set CTID=<id> and retry."
  [[ "$(printf '%s' "$CTID" | wc -w)" -eq 1 ]] || die "multiple containers named '${CT_HOSTNAME}' (${CTID//$'\n'/ }). Set CTID=<id>."
  [[ "$(pct status "$CTID" 2>/dev/null)" == *running* ]] || die "LXC ${CTID} is not running — start it first: pct start ${CTID}"

  msg "orwell lives in LXC ${CTID}; changing the UI port inside the container"
  FWD=""
  [[ $ASSUME_YES  -eq 1 ]] && FWD="${FWD} --yes"
  [[ $NO_RESTART  -eq 1 ]] && FWD="${FWD} --no-restart"
  [[ $DRY_RUN     -eq 1 ]] && FWD="${FWD} --dry-run"
  FWD_ENV="export ${APP_DIR:+APP_DIR='${APP_DIR}' }ORWELL_SERVICE_USER='${ORWELL_SERVICE_USER:-}';"
  if [[ -n "${BASH_SOURCE[0]:-}" && -r "${BASH_SOURCE[0]:-}" ]]; then
    TMP="$(mktemp /tmp/orwell-change-port-XXXXXX.sh)"; cp "${BASH_SOURCE[0]}" "$TMP"
    pct push "$CTID" "$TMP" /tmp/orwell-change-port.sh; rm -f "$TMP"
    pct exec "$CTID" -- bash -c "${FWD_ENV} bash /tmp/orwell-change-port.sh ${NEW_PORT}${FWD}"
  elif [[ -n "${BASH_EXECUTION_STRING:-}" ]]; then
    TMP="$(mktemp /tmp/orwell-change-port-XXXXXX.sh)"; printf '%s\n' "$BASH_EXECUTION_STRING" > "$TMP"
    pct push "$CTID" "$TMP" /tmp/orwell-change-port.sh; rm -f "$TMP"
    pct exec "$CTID" -- bash -c "${FWD_ENV} bash /tmp/orwell-change-port.sh ${NEW_PORT}${FWD}"
  else
    pct exec "$CTID" -- bash -c "${FWD_ENV} for d in \"\${APP_DIR:-}\" /opt/orwell /opt/bbai; do
        [ -n \"\$d\" ] && [ -f \"\$d/deploy/orwell-change-port.sh\" ] && exec bash \"\$d/deploy/orwell-change-port.sh\" ${NEW_PORT}${FWD}
      done; echo 'ERROR: no in-container deploy/orwell-change-port.sh found' >&2; exit 1"
  fi
  exit 0
fi

# ── In-container (or direct) ────────────────────────────────────────────────────────────────────
APP_DIR="$(find_app || true)"; APP_DIR="${APP_DIR:-/opt/orwell}"

# Service name follows the install: prefer orwell-*, fall back to the legacy bbai-* unit.
unit_exists() { systemctl list-unit-files "$1" 2>/dev/null | grep -q "$1"; }
if   unit_exists orwell-frontend.service; then FRONTEND_SVC="orwell-frontend"
elif unit_exists bbai-frontend.service;   then FRONTEND_SVC="bbai-frontend"
else                                           FRONTEND_SVC="orwell-frontend"
fi
ENV_FILE="${APP_DIR}/data/.env"
DROPIN_DIR="${ORWELL_SYSTEMD_DIR:-/etc/systemd/system}/${FRONTEND_SVC}.service.d"   # ORWELL_SYSTEMD_DIR: tests/dev only
DROPIN="${DROPIN_DIR}/10-privileged-port.conf"

# The CURRENT UI port (data/.env wins; the unit's default is 8080).
CUR_PORT="$(sed -n 's/^ORWELL_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
CUR_PORT="${CUR_PORT:-8080}"

# Prompt for the port if none was given.
if [[ -z "$NEW_PORT" ]]; then
  if tui_active; then
    ORWELL_TUI_TITLE="Orwell — change UI port"
    wt_input NEW_PORT "Current UI port: ${CUR_PORT}\n\nEnter the new front-end (UI) port (1–65535; 80 = standard HTTP).\nMoving to/from a privileged port (<1024) is handled automatically." "$CUR_PORT" \
      || { echo "cancelled."; exit 0; }
  elif [[ -t 0 ]]; then
    read -rp "New UI port [current ${CUR_PORT}]: " NEW_PORT
    NEW_PORT="${NEW_PORT:-$CUR_PORT}"
  else
    die "no target port given and no TTY to prompt. Usage: $0 <port>"
  fi
fi

# Validate.
[[ "$NEW_PORT" =~ ^[0-9]+$ ]] || die "port must be a number: '${NEW_PORT}'"
(( NEW_PORT >= 1 && NEW_PORT <= 65535 )) || die "port out of range (1–65535): ${NEW_PORT}"

PRIV=0;     (( NEW_PORT < 1024 )) && PRIV=1
WAS_PRIV=0; [[ "$CUR_PORT" =~ ^[0-9]+$ ]] && (( CUR_PORT < 1024 )) && WAS_PRIV=1

# systemd is the runtime we manage (the drop-in + restart). Needed unless we're only describing.
if [[ $DRY_RUN -eq 0 ]]; then
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this script manages the systemd front-end unit (${FRONTEND_SVC})."
  [[ "$(id -u)" -eq 0 ]] || die "must run as root (edits ${ENV_FILE}, the systemd drop-in, and restarts ${FRONTEND_SVC}). Try: sudo bash $0 ${NEW_PORT}"
fi

# Conflict check: is the TARGET port already held by a DIFFERENT listener? The current FE is on
# CUR_PORT, so a listener on any other NEW_PORT is by construction something else — and the restart
# could never bind it, so this is fatal (nothing has been changed yet). Without `ss` the check cannot
# run; the post-restart probe + revert below is then the safety net.
if [[ "$NEW_PORT" != "$CUR_PORT" ]]; then
  if command -v ss >/dev/null 2>&1; then
    if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${NEW_PORT}\$"; then
      die "port ${NEW_PORT} already has a listener that is not the orwell front-end (it is on ${CUR_PORT}) — pick another port or stop that listener. Nothing was changed."
    fi
  else
    warn "ss not found — cannot pre-check whether port ${NEW_PORT} is free; the post-restart probe will catch a conflict and revert."
  fi
fi

# Describe the plan.
if [[ "$NEW_PORT" == "$CUR_PORT" ]]; then
  msg "ORWELL_PORT is already ${NEW_PORT} — re-applying (reconcile the drop-in + restart)."
fi
PLAN="  • set ORWELL_PORT=${NEW_PORT} in ${ENV_FILE} (was ${CUR_PORT})"
if [[ $PRIV -eq 1 ]]; then
  PLAN+=$'\n'"  • write ${DROPIN} — grant CAP_NET_BIND_SERVICE (privileged port <1024)"
else
  PLAN+=$'\n'"  • remove ${DROPIN} if present — no privileged bind needed (locked-down default)"
fi
if [[ $NO_RESTART -eq 1 ]]; then
  PLAN+=$'\n'"  • (--no-restart) leave services as-is — you apply the restart yourself"
else
  PLAN+=$'\n'"  • systemctl daemon-reload && systemctl restart ${FRONTEND_SVC}"
fi

# Confirm (interactive only; --yes / automation / --dry-run skip it).
if [[ $DRY_RUN -eq 0 && $ASSUME_YES -eq 0 ]]; then
  if tui_active; then
    wt_yesno "Change the Orwell UI port: ${CUR_PORT} → ${NEW_PORT}\n\n${PLAN}\n\nProceed?" || { echo "cancelled."; exit 0; }
  elif [[ -t 0 ]]; then
    echo "Change the Orwell UI port: ${CUR_PORT} → ${NEW_PORT}"; echo "$PLAN"
    read -rp "Proceed? [y/N] " __ans; [[ "$__ans" =~ ^[Yy] ]] || { echo "cancelled."; exit 0; }
  fi
fi

if [[ $DRY_RUN -eq 1 ]]; then
  msg "[dry-run] would change ${CUR_PORT} → ${NEW_PORT}:"; echo "$PLAN"; exit 0
fi

# ── 1. data/.env: set ORWELL_PORT (preserve the file + its ownership). ──────────────────────────
# In-place rewrite (cat into the existing file) so the .env keeps its owner/mode; append if absent.
set_env_key() {
  local key="$1" val="$2" tmp
  mkdir -p "$(dirname "$ENV_FILE")"
  if [[ -f "$ENV_FILE" ]] && grep -q "^${key}=" "$ENV_FILE"; then
    tmp="$(mktemp)"; sed "s|^${key}=.*|${key}=${val}|" "$ENV_FILE" > "$tmp"; cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
# Everything from here to the verified probe is reverted on ANY failure (a failed write, daemon-reload,
# restart, or a front-end that never answers on the new port): snapshot what we are about to change.
ENV_SAVED=""; DROPIN_SAVED=""; ENV_EXISTED=0; DROPIN_EXISTED=0; CHANGED=0; COMMITTED=0
snap_dir="$(mktemp -d)"
if [[ -f "$ENV_FILE" ]];  then ENV_EXISTED=1;    ENV_SAVED="${snap_dir}/env";    cp -p "$ENV_FILE" "$ENV_SAVED"; fi
if [[ -f "$DROPIN" ]];    then DROPIN_EXISTED=1; DROPIN_SAVED="${snap_dir}/dropin"; cp -p "$DROPIN" "$DROPIN_SAVED"; fi

# The REAL probe: the front-end itself must answer its health route on the port (a bare listener —
# anything else holding the port — does not count).
probe_port() { curl -fsS --max-time 2 "http://127.0.0.1:${1}/api/health" 2>/dev/null | grep -Eq '"status"[[:space:]]*:[[:space:]]*"healthy"'; }
wait_for_port() { local i; for i in $(seq 1 "${ORWELL_PORT_WAIT:-20}"); do probe_port "$1" && return 0; sleep 1; done; return 1; }

revert_port() {
  warn "reverting to the previous port ${CUR_PORT}"
  # cp -p: put back the original bytes AND owner/mode (the secrets file must not keep the new metadata)
  if [[ $ENV_EXISTED -eq 1 ]]; then cp -p "$ENV_SAVED" "$ENV_FILE"; else rm -f "$ENV_FILE"; fi
  if [[ $DROPIN_EXISTED -eq 1 ]]; then mkdir -p "$DROPIN_DIR"; cp -p "$DROPIN_SAVED" "$DROPIN"
  else rm -f "$DROPIN"; rmdir "$DROPIN_DIR" 2>/dev/null || true; fi
  systemctl daemon-reload || true
  if [[ $NO_RESTART -eq 1 ]]; then return 0; fi
  systemctl restart "$FRONTEND_SVC" || true
  if wait_for_port "$CUR_PORT"; then
    warn "the front-end is serving again on ${CUR_PORT}; the port was NOT changed."
  else
    echo "ERROR: reverted the config, but the front-end is not answering on ${CUR_PORT} — check: systemctl status ${FRONTEND_SVC} ; journalctl -u ${FRONTEND_SVC} -e" >&2
  fi
}
on_exit() {
  local rc=$?
  trap - EXIT
  if [[ $rc -ne 0 && $CHANGED -eq 1 && $COMMITTED -eq 0 ]]; then revert_port || true; fi
  rm -rf -- "$snap_dir"
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

CHANGED=1
msg "setting ORWELL_PORT=${NEW_PORT} in ${ENV_FILE}"
set_env_key ORWELL_PORT "$NEW_PORT"
# Keep a legacy BBAI_PORT in sync IF (and only if) it already exists (a pre-rename box).
if [[ -f "$ENV_FILE" ]] && grep -q '^BBAI_PORT=' "$ENV_FILE"; then set_env_key BBAI_PORT "$NEW_PORT"; fi

# Restore .env ownership to the service user (a root-created/edited file would otherwise be
# root-owned; mirrors orwell-oobe-reset.sh's ownership restore).
SVC_USER="${ORWELL_SERVICE_USER:-}"
[[ -n "$SVC_USER" ]] || SVC_USER="$(systemctl show -p User --value "$FRONTEND_SVC" 2>/dev/null || true)"
[[ -n "$SVC_USER" ]] || SVC_USER="orwell"
if id "$SVC_USER" >/dev/null 2>&1; then
  chown "$SVC_USER":"$(id -gn "$SVC_USER" 2>/dev/null || printf '%s' "$SVC_USER")" "$ENV_FILE" 2>/dev/null || true
  chmod 600 "$ENV_FILE" 2>/dev/null || true
fi

# ── 2. The privileged-port capability drop-in (the to/from-:80 hinge). ──────────────────────────
if [[ $PRIV -eq 1 ]]; then
  msg "port ${NEW_PORT} is privileged (<1024): granting CAP_NET_BIND_SERVICE (drop-in)"
  mkdir -p "$DROPIN_DIR"
  cat > "$DROPIN" <<EOF
# Written by orwell-change-port.sh: ORWELL_PORT=${NEW_PORT} is a privileged port (<1024).
# The base unit's empty CapabilityBoundingSet= is the audited default (E85); this grants the
# single capability a non-root bind below 1024 requires. Removed when the port moves >=1024.
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
EOF
elif [[ -e "$DROPIN" ]]; then
  msg "port ${NEW_PORT} is unprivileged (>=1024): removing the CAP_NET_BIND_SERVICE drop-in"
  rm -f "$DROPIN"
  rmdir "$DROPIN_DIR" 2>/dev/null || true   # tidy the .d dir if it's now empty (leave it if other drop-ins remain)
fi

# ── 3. Apply: reload units (the drop-in changed) + restart the front-end. ───────────────────────
if [[ $NO_RESTART -eq 1 ]]; then
  COMMITTED=1
  msg "config changed; NOT restarting (--no-restart). Apply later with: systemctl daemon-reload && systemctl restart ${FRONTEND_SVC}"
  exit 0
fi
msg "reloading systemd + restarting ${FRONTEND_SVC}"
systemctl daemon-reload
systemctl restart "$FRONTEND_SVC"

# ── 4. Verify the new port is really the front-end answering (~20s); otherwise revert. ─────────
if wait_for_port "$NEW_PORT"; then
  ok=1; COMMITTED=1
else
  ok=0
  echo "ERROR: the front-end did not answer on port ${NEW_PORT} after the restart (a foreign listener, a failed bind, or a crash)." >&2
  echo  "  check: systemctl status ${FRONTEND_SVC} ; journalctl -u ${FRONTEND_SVC} -e" >&2
  exit 1   # the EXIT trap restores the old port, drop-in and service
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
msg "done — the front-end is serving on port ${NEW_PORT}."
echo "  play:  http://${IP:-<container-ip>}:${NEW_PORT}"

# Reminders.
echo
echo "Reminders:"
echo "  • External access: update any firewall rule / Proxmox port-forward / reverse proxy to ${NEW_PORT} (the old port ${CUR_PORT} is released)."
if [[ $PRIV -eq 1 ]]; then
  echo "  • :${NEW_PORT} serves plain HTTP. For public exposure, terminate TLS at a reverse proxy and set SECURE_COOKIES=true in ${ENV_FILE}."
fi
if [[ $WAS_PRIV -eq 1 && $PRIV -eq 0 ]]; then
  echo "  • The CAP_NET_BIND_SERVICE grant was removed — the front-end unit is back to its locked-down default (no capabilities)."
fi

