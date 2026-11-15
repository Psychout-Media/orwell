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
# ORW-403: the FE database runs in SQLite WAL mode and is LIVE. The old approach (checkpoint, then tar
# the raw app.db/-wal/-shm) cannot work under the unit's sandbox (only backups/ is writable, so the
# checkpoint failed and its stderr was discarded) and could capture a torn db/wal pair. Instead take a
# consistent copy with python3's Connection.backup() from a READ-ONLY connection (python3 -I; prod has
# python3 but no sqlite3 CLI) into a temp file inside the backups dir, verify it with
# PRAGMA integrity_check, and archive THAT copy in place of the live db/-wal/-shm. Errors are printed.
FE_DB="${APP_DIR}/frontend/data/app.db"
SNAP=""; SNAPDIR=""
# The snapshot lives in a temp DIRECTORY (SQLite also creates a journal beside it; a root-owned destination
# would refuse that to the db owner). The directory is removed on exit.
trap '[[ -n "$SNAPDIR" ]] && rm -rf --one-file-system -- "$SNAPDIR"' EXIT
# A SIGKILL or power loss skips the EXIT trap and leaves a full database copy behind that retention (orwell-backup-*.tar.gz) never matches: sweep orphans of an earlier run first,
# whether or not this run has a database to copy (a box that lost its app.db must not keep the stale copies forever). 60 minutes is far beyond a run (seconds), so a live snapshot is never swept.
find "$DEST" -maxdepth 1 -type d -name '.app.db.snapshot.*' -mmin +60 -exec rm -rf --one-file-system -- {} + 2>/dev/null || true
if [[ -f "$FE_DB" ]]; then
  command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required to snapshot ${FE_DB}" >&2; exit 1; }
  SNAPDIR="$(mktemp -d "${DEST}/.app.db.snapshot.XXXXXX")"
  SNAP="${SNAPDIR}/app.db"
  SNAPPY='
import sqlite3, sys
src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect("file:" + src_path + "?mode=ro", uri=True, timeout=30)
dst = sqlite3.connect(dst_path)
try:
    src.backup(dst)
    dst.commit()
    res = dst.execute("PRAGMA integrity_check").fetchall()
finally:
    dst.close()
    src.close()
if [r[0] for r in res] != ["ok"]:
    sys.exit("integrity_check failed: " + "; ".join(str(r[0]) for r in res))
'
  DB_OWNER="$(stat -c %U "$FE_DB" 2>/dev/null || true)"
  if [[ "$(id -u)" -eq 0 && -n "$DB_OWNER" && "$DB_OWNER" != "root" ]] && command -v runuser >/dev/null 2>&1; then
    chown "$DB_OWNER" "$SNAPDIR"
    runuser -u "$DB_OWNER" -- python3 -I -c "$SNAPPY" "$FE_DB" "$SNAP" || { echo "ERROR: database snapshot failed; no backup written" >&2; exit 1; }
  else
    python3 -I -c "$SNAPPY" "$FE_DB" "$SNAP" || { echo "ERROR: database snapshot failed; no backup written" >&2; exit 1; }
  fi
  # sqlite3.connect() creates the copy with the caller's umask (0644 at 022) and tar records that mode: make it owner-only before archiving.
  chmod 600 "$SNAP"
fi
TAR_ARGS=(-czf "$OUT" -C "$APP_DIR" --exclude='data/models'
  --exclude='frontend/data/app.db' --exclude='frontend/data/app.db-journal' --exclude='frontend/data/app.db-wal' --exclude='frontend/data/app.db-shm')
[[ -d "${APP_DIR}/data" ]] && TAR_ARGS+=(data)
[[ -d "${APP_DIR}/frontend/data" ]] && TAR_ARGS+=(frontend/data)
if [[ -n "$SNAP" ]]; then
  TAR_ARGS+=(--transform "s,^$(basename "$SNAP")\$,frontend/data/app.db," -C "$SNAPDIR" "$(basename "$SNAP")")
fi
tar "${TAR_ARGS[@]}"
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
