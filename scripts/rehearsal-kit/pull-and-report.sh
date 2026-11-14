#!/usr/bin/env bash
# One command: pull a playtest session from the box (READ-ONLY) and write the plain-language report.
#   bash pull-and-report.sh root@<host> ["2026-11-06 17:00" ["2026-11-07 06:00"]]    (times are UTC; default: the last 14 hours)
# Reads journals, the app database, the model-call log and the engine's latest save. Writes nothing on the box.
set -euo pipefail
HOST="${1:-${ORWELL_PLAYTEST_HOST:-}}"
[ -n "$HOST" ] || { echo "usage: bash pull-and-report.sh root@<host> [since-UTC [until-UTC]]" >&2; exit 2; }
SINCE="${2:-$(date -u -d '14 hours ago' '+%Y-%m-%d %H:%M')}"
UNTIL="${3:-}"
OUTDIR="$(cd "$(dirname "$0")/.." && pwd)/reports"
mkdir -p "$OUTDIR"
OUT="$OUTDIR/session-$(date -u +%Y%m%d-%H%M).md"
ARGS=(--ssh "$HOST" --since "$SINCE" --out "$OUT")
[ -n "$UNTIL" ] && ARGS+=(--until "$UNTIL")
python3 "$(dirname "$0")/post_session_analyzer.py" "${ARGS[@]}"
echo "Report: $OUT"
