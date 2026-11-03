#!/usr/bin/env bash
#
# orwell-backup.sh (B72/ops A8) — back up EVERYTHING a game owns, correctly.
#
# The state lives in TWO places (the layout the old prose misstated):
#   <app>/data/            engine config (.env incl. the generated token) + saves/ (per-user games)
#   <app>/frontend/data/   the front-end SQLite (accounts, chats, settings) + uploads
#
# Usage:  orwell-backup.sh [dest-dir]      (default: <app>/backups)
# Output: orwell-backup-YYYYmmdd-HHMMSS.tar.gz — restore with orwell-restore.sh.
#
# Scheduling (DEPLOY-9, 2026-07-05 ops-hygiene close-out): this script was manual-only, with no
# retention policy — `backups/` grew unbounded on the same disk the game's saves/portraits/models
# also occupy. `deploy/systemd/orwell-backup.timer` now runs this daily; retention is enforced HERE
# (not just by the timer) so a manually-triggered run (control panel / cron / CI) prunes too.
# ORWELL_BACKUP_RETENTION_DAYS=0 disables pruning (keep every backup forever).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/orwell}"
[[ -d "$APP_DIR" ]] || { echo "ERROR: app dir ${APP_DIR} not found (set APP_DIR=...)" >&2; exit 1; }
DEST="${1:-${APP_DIR}/backups}"
RETENTION_DAYS="${ORWELL_BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${DEST}/orwell-backup-${STAMP}.tar.gz"

mkdir -p "$DEST"
# A consistent snapshot does not strictly require stopping the services (saves are atomic files,
# SQLite is journaled), but quiescing is safest when available.
#
# EXCLUDE data/models — that is the fastembed ONNX embedding cache (ORWELL_EMBED_CACHE). It is
# re-fetchable and RE-WARMS on the engine's first boot, so it is game-irrelevant weight: a daily
# backup × the 30-day retention would otherwise bloat the very disk the saves/portraits live on.
tar -czf "$OUT" -C "$APP_DIR" --exclude='data/models' \
  $( [[ -d "${APP_DIR}/data" ]] && echo "data" ) \
  $( [[ -d "${APP_DIR}/frontend/data" ]] && echo "frontend/data" )
chmod 600 "$OUT"
echo "backup written: ${OUT}"
echo "contents: <app>/data (engine .env + saves; the models/ embedding cache is EXCLUDED and re-warms on first boot) + <app>/frontend/data (FE SQLite + uploads)"

# Retention: prune backups OLDER than the window, never the one just written (mtime-based `find
# -mtime +N`, so a fresh install with only one backup prunes nothing).
if [[ "$RETENTION_DAYS" -gt 0 ]] 2>/dev/null; then
  PRUNED="$(find "$DEST" -maxdepth 1 -name 'orwell-backup-*.tar.gz' -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l | tr -d ' ')" || true
  # `if`, not `[[ ]] && echo`: when nothing was pruned (the normal case) the `&&` list is false and, as the
  # script's LAST command, made a fully successful backup exit 1 — systemd then reported the unit failed.
  if [[ "${PRUNED:-0}" -gt 0 ]]; then
    echo "retention: pruned ${PRUNED} backup(s) older than ${RETENTION_DAYS} days"
  fi
else
  echo "retention: disabled (ORWELL_BACKUP_RETENTION_DAYS=0) — no backups pruned"
fi
