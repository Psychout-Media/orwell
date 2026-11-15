#!/usr/bin/env bash
# ORW-109: resume the full-season run on the game already running on the rig (same run dir). Stops the rig by PID at the end and prints one line.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); KIT=${ORWELL_KIT:-$HERE/../rehearsal-kit}; . "$KIT/slot.sh"; RUN=$(cat $RIG_RUN_PTR)
export TMPDIR=${TMPDIR:-/home/ryne/.cache/a9chrome-tmp}; mkdir -p "$TMPDIR"
/home/ryne/orwell/frontend/.venv/bin/python3 "$HERE/live_week.py" --season --resume --fe "$RIG_BASE" --engine "$RIG_ENGINE_URL" --max-turns-total ${MAX_TURNS:-800} --run-dir "$RUN" > "$RUN/live_season_resume.out" 2>&1; RC=$?
"$KIT/stop.sh" >/dev/null 2>&1
case $RC in 0) V=PASS;; 1) V=FAIL;; *) V=COULD-NOT-RUN;; esac
echo "LIVE-SEASON $V $(git -C /home/ryne/orwell rev-parse --short=8 origin/main) $RUN/report.md"; exit $RC
