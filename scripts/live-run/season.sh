#!/usr/bin/env bash
# ORW-109: the ONE full-season run (casting to the finale and jury vote) on the real narrator. Same rig rules as run_short.sh; prints one line at the end.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); KIT=${ORWELL_KIT:-$HERE/../rehearsal-kit}; . "$KIT/slot.sh"   # RIG_SLOT (default 1) picks the rig: ports, lock, worktree, run pointer
STATE=$RIG_STATE_DIR; mkdir -p "$STATE"
exec 9>"$RIG_LOCK"; flock -n 9 || { echo "LIVE-SEASON BUSY (rig slot $RIG_SLOT)"; exit 3; }
PY=""
cleanup() { [ -n "$PY" ] && { kill "$PY" 2>/dev/null; wait "$PY" 2>/dev/null; }; "$KIT/stop.sh" >/dev/null 2>&1; }   # a cancelled run ends its driver, then stops the rig
trap cleanup EXIT; trap 'exit 143' TERM; trap 'exit 130' INT   # the driver runs as a background child and we `wait`, so a signal is handled at once (a foreground child delays every trap until it exits)
git -C "$RIG_HOME/orwell" fetch -q origin main; SHA=$(git -C "$RIG_HOME/orwell" rev-parse --short=8 origin/main)
"$KIT/stage2.sh" > "$STATE/stage$RIG_SUFFIX.log" 2>&1 || { echo "LIVE-SEASON COULD-NOT-RUN $SHA stage failed"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; }
RUN=$(cat $RIG_RUN_PTR)
python3 -c "
import json;f='$WT/frontend/data/settings.json';d=json.load(open(f));d['image_gen_enabled']=False;json.dump(d,open(f,'w'))" || exit 2
export TMPDIR=${TMPDIR:-$RIG_HOME/.cache/a9chrome-tmp}; mkdir -p "$TMPDIR"
"$RIG_HOME/orwell/frontend/.venv/bin/python3" "$HERE/live_week.py" --season --fe "$RIG_BASE" --engine "$RIG_ENGINE_URL" --run-dir "$RUN" > "$RUN/live_season.out" 2>&1 & PY=$!
wait "$PY"; RC=$?; PY=""
"$KIT/stop.sh" >/dev/null 2>&1
case $RC in 0) V=PASS;; 1) V=FAIL;; *) V=COULD-NOT-RUN;; esac
echo "LIVE-SEASON $V $SHA $RUN/report.md"; exit $RC
