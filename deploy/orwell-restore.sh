#!/usr/bin/env bash
#
# orwell-restore.sh (B72/ops A8) — restore a backup made by orwell-backup.sh.
#
# Stops the services, then ATOMICALLY REPLACES the engine + front-end data subtrees with the
# backup's, then restarts. "Atomically replace" — not "extract over" — is deliberate and
# load-bearing (data-safety audit 2026-07-13):
#
#   * P0 — engine saves are monotonic-versioned files (data/saves/<user>/vNNNNNN.json) and the
#     engine's loadLatest() returns the HIGHEST version. Extracting an OLDER backup ON TOP of a
#     newer live tree left the newer saves in place, so the restore SILENTLY DID NOT roll the game
#     back; multi-file components (portraits) were UNIONED, reintroducing stale-cast faces. So we
#     MOVE the live subtrees ASIDE first (never rm -rf — a timestamped .pre-restore-<ts> sibling is
#     kept for rollback) and only THEN extract, so what lands is exactly the backup, nothing merged.
#     On ANY extraction failure the moved-aside tree is moved back (fail-safe).
#
#   * P1 — a backup carries data/.env (ports, tokens, and the PUBLIC-EXPOSURE / TLS / GIT_TOKEN
#     profile: ORWELL_PUBLIC, ALLOWED_HOSTS/ORIGINS, SECURE_COOKIES, ORWELL_BIND_HOST, ORWELL_TLS_*)
#     but NOT the matching OS state (cloudflared/Caddy/cap-drop-in). Restoring an OLDER .env would
#     silently revert exposure/TLS/token while the OS services keep running → host-header/Origin
#     rejections, HTTPS cookie mismatch, broken auto-update. DECISION (the safe one): KEEP THE LIVE
#     data/.env — game state rolls back, host CONFIG does not. The backup's .env is preserved inside
#     the move-aside dir if ever needed. If there was no live .env at all, the backup's stands and we
#     print a loud note to re-run the public-deploy / HTTPS apply.
#
#   * Archive validation — refuse anything whose members are not exactly under data/ or
#     frontend/data/, so a stray `orwell restore /path/anything.tar.gz` can't drop arbitrary files
#     under the app tree.
#
# Usage: orwell-restore.sh <backup.tar.gz>
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/orwell}"
BACKUP="${1:-}"

# Optional whiptail TUI (deploy/orwell-tui.sh): on a TTY with no file given, pick from existing
# backups; otherwise the usage check below stands (automation must pass the file as $1).
__here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
for __lib in "${__here}/orwell-tui.sh" /opt/orwell/deploy/orwell-tui.sh /opt/bbai/deploy/orwell-tui.sh; do
  if [[ -n "${__lib:-}" && -r "$__lib" ]]; then . "$__lib"; break; fi
done
type tui_active >/dev/null 2>&1 || tui_active() { return 1; }

if [[ -z "$BACKUP" ]] && tui_active; then
  ORWELL_TUI_TITLE="Orwell — restore"
  __dir="${APP_DIR}/backups"
  mapfile -t __list < <(ls -1t "${__dir}"/orwell-backup-*.tar.gz 2>/dev/null)
  if [[ ${#__list[@]} -eq 0 ]]; then
    wt_msgbox "No backups found in:\n${__dir}\n\nCreate one first:  orwell backup"; exit 1
  fi
  __args=(); for __f in "${__list[@]}"; do __args+=("$__f" "$(date -r "$__f" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '')"); done
  wt_menu BACKUP "Choose a backup to restore:" "${__args[@]}" || { echo "cancelled."; exit 0; }
  wt_yesno "Restore from:\n${BACKUP}\n\nThis STOPS the services and REPLACES the current engine + front-end game data with the backup, then restarts.\n\n(Your host config — data/.env: ports, tokens, public-exposure & TLS — is KEPT, not reverted.)" --defaultno || { echo "cancelled."; exit 0; }
fi

[[ -n "$BACKUP" && -f "$BACKUP" ]] || { echo "usage: orwell-restore.sh <backup.tar.gz>" >&2; exit 1; }

die() { echo "ERROR: $*" >&2; exit 1; }

# ── Validate the archive is an orwell backup BEFORE touching anything ───────────────────────────
# Every member must live under data/ or frontend/data/ (a bare intermediate frontend/ dir is
# tolerated). Anything else ⇒ refuse, so a wrong-tarball restore can never drop files under the app.
MEMBERS="$(tar -tzf "$BACKUP" 2>/dev/null)" || die "cannot read '${BACKUP}' as a gzip tar archive."
[[ -n "$MEMBERS" ]] || die "archive '${BACKUP}' is empty — refusing to restore."
while IFS= read -r __m; do
  [[ -z "$__m" ]] && continue
  case "$__m" in
    data|data/|data/*) : ;;
    frontend|frontend/|frontend/data|frontend/data/|frontend/data/*) : ;;
    *) die "archive '${BACKUP}' contains unexpected member '${__m}' — not an orwell backup (expected only data/ and frontend/data/). Refusing to extract." ;;
  esac
done <<< "$MEMBERS"

# Which top-level subtrees does this archive actually carry? Replace EXACTLY those — no more.
SUBTREES=()
if grep -qE '^data(/|$)' <<< "$MEMBERS"; then SUBTREES+=("data"); fi
if grep -qE '^frontend/data(/|$)' <<< "$MEMBERS"; then SUBTREES+=("frontend/data"); fi
[[ ${#SUBTREES[@]} -gt 0 ]] || die "archive '${BACKUP}' carries neither data/ nor frontend/data/ — nothing to restore."

# ── Stop services so nothing writes while we swap ──────────────────────────────────────────────
# From here on ANY failure (a refused stop, a failed move, extraction, the .env carry-over) runs
# on_exit: the moved-aside live data goes back and the services are restarted — the box is never left
# stopped with its data stranded in .pre-restore-*. RESTORE_COMMITTED flips to 1 only once the
# restored tree is fully in place.
have_systemd=0
command -v systemctl >/dev/null 2>&1 && have_systemd=1
SERVICES_STOPPED=0
RESTORE_COMMITTED=0
ASIDE=""
MOVED=()  # subtrees that actually existed live and were moved into ASIDE

# Fail-safe: undo a partial/failed restore — drop any partially-extracted target subtree, then
# move the preserved live copy back, leaving the box exactly as it was pre-restore.
rollback_aside() {
  local rel live saved rc=0
  for rel in ${MOVED[@]+"${MOVED[@]}"}; do
    live="${APP_DIR%/}/${rel}"
    saved="${ASIDE}/${rel}"
    [[ -e "$saved" ]] || continue
    [[ -e "$live" ]] && { rm -rf -- "$live" || rc=1; }
    mkdir -p "$(dirname "$live")" && mv "$saved" "$live" || rc=1
  done
  return "$rc"
}

on_exit() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ "$rc" -ne 0 && "$RESTORE_COMMITTED" -eq 0 ]]; then
    if [[ -n "$ASIDE" && ${#MOVED[@]} -gt 0 ]]; then
      echo "WARN: restore FAILED — rolling back to the pre-restore state." >&2
      if rollback_aside; then
        # Remove the scaffolding ONLY if it holds no files (never delete a real copy a failed mv left behind).
        if [[ -n "$(find "$ASIDE" ! -type d -print -quit 2>/dev/null)" ]]; then
          echo "NOTE: kept pre-restore copy at ${ASIDE} (it still holds files)." >&2
        else
          rm -rf -- "$ASIDE" 2>/dev/null || true
        fi
        echo "original data restored; no changes kept." >&2
      else
        echo "ERROR: rollback FAILED — your previous data is in ${ASIDE}; move it back by hand." >&2
      fi
    elif [[ -n "$ASIDE" ]]; then
      rm -rf -- "$ASIDE" 2>/dev/null || true   # nothing was moved aside yet: just scaffolding
    fi
  fi
  if [[ "$rc" -ne 0 && "$SERVICES_STOPPED" -eq 1 ]]; then
    echo "==> restarting services after the failed restore" >&2
    systemctl start orwell-engine orwell-frontend >&2 \
      || echo "ERROR: could not restart the services — start them: systemctl start orwell-engine orwell-frontend" >&2
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

if [[ "$have_systemd" -eq 1 ]]; then
  SERVICES_STOPPED=1
  systemctl stop orwell-frontend orwell-engine 2>/dev/null || true
  # A service that is still running means something is still writing — refuse to swap data under it.
  for __svc in orwell-frontend orwell-engine; do
    if systemctl is-active --quiet "$__svc" 2>/dev/null; then
      die "${__svc} is still running after 'systemctl stop' — refusing to replace data under a live service."
    fi
  done
fi

# ── Move-aside → extract → (fail-safe) rollback ────────────────────────────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
ASIDE="$(mktemp -d "${APP_DIR%/}/.pre-restore-${STAMP}-XXXXXX")" || die "cannot create move-aside dir under ${APP_DIR}."

move_aside() {
  local rel src dst
  for rel in "${SUBTREES[@]}"; do
    src="${APP_DIR%/}/${rel}"
    [[ -e "$src" ]] || continue
    dst="${ASIDE}/${rel}"
    mkdir -p "$(dirname "$dst")"
    mv "$src" "$dst"
    MOVED+=("$rel")
  done
}

move_aside

tar -xzf "$BACKUP" -C "$APP_DIR" || die "extraction of ${BACKUP} failed."

# ── P1: keep the LIVE data/.env (host config: exposure / TLS / GIT_TOKEN) — do NOT silently ──────
#        revert it to the backup's older copy. The live one was moved into ASIDE with the rest of
#        data/, so restore it back over the just-extracted (older) one.
if [[ " ${MOVED[*]:-} " == *" data "* ]]; then
  if [[ -f "${ASIDE}/data/.env" ]]; then
    cp -p "${ASIDE}/data/.env" "${APP_DIR%/}/data/.env" || die "could not carry the live data/.env across."
    echo "kept live data/.env (ports, tokens, public-exposure & TLS profile) — NOT reverted to the backup's copy."
  elif grep -qxE 'data/\.env/?' <<< "$MEMBERS"; then
    echo "WARN: no live data/.env existed; the backup's data/.env is now in place — re-run your" >&2
    echo "      public-deploy / HTTPS apply if its exposure / TLS / GIT_TOKEN values differ." >&2
  fi
  # data/.update-prev is the host's rollback pointer (the last good SHA, paired with dist.prev) — it
  # describes the live checkout, not the game, so a backup must never rewind it.
  if [[ -f "${ASIDE}/data/.update-prev" ]]; then
    cp -p "${ASIDE}/data/.update-prev" "${APP_DIR%/}/data/.update-prev" || die "could not carry data/.update-prev across."
  else
    rm -f -- "${APP_DIR%/}/data/.update-prev"
  fi
fi

# The restored tree is complete: from here a failure no longer rolls the data back.
RESTORE_COMMITTED=1

# data/models is the fastembed ONNX cache — excluded from backups, so it exists only in the moved-aside
# tree. Carry it over (a cheap same-filesystem mv) rather than re-downloading it on first boot.
if [[ " ${MOVED[*]:-} " == *" data "* && -d "${ASIDE}/data/models" ]]; then
  rm -rf -- "${APP_DIR%/}/data/models"
  mv "${ASIDE}/data/models" "${APP_DIR%/}/data/models" \
    || echo "WARN: could not carry data/models across — the embedding cache will re-warm on first boot (it is kept in ${ASIDE}/data/models)." >&2
fi

id -u orwell >/dev/null 2>&1 && chown -R orwell:orwell "${APP_DIR}/data" "${APP_DIR}/frontend/data" 2>/dev/null || true

if [[ "$have_systemd" -eq 1 ]]; then
  SERVICES_STOPPED=0
  systemctl start orwell-engine orwell-frontend \
    || die "data restored, but the services failed to start — check: systemctl status orwell-engine orwell-frontend"
fi
echo "restore complete from ${BACKUP}"
echo "previous data moved aside to: ${ASIDE}"
echo "  (kept for rollback — delete it once you've verified the restored game looks right)"
