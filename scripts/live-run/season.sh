#!/usr/bin/env bash
# ORW-109: the ONE full-season run (casting to the finale and jury vote) on the real narrator. Same rig rules as run_short.sh; prints one line at the end.
set -uo pipefail
KIT=${ORWELL_KIT:-/home/ryne/orwell-playtest/rehearsal-kit}; HERE=$(cd "$(dirname "$0")" && pwd); STATE=${ORWELL_LIVE_STATE:-/home/ryne/orwell-playtest/live-short}; mkdir -p "$STATE"
exec 9>"$STATE/rig.lock"; flock -n 9 || { echo "LIVE-SEASON BUSY"; exit 3; }
git -C /home/ryne/orwell fetch -q origin main; SHA=$(git -C /home/ryne/orwell rev-parse --short=8 origin/main)
"$KIT/stage2.sh" > "$STATE/stage.log" 2>&1 || { echo "LIVE-SEASON COULD-NOT-RUN $SHA stage failed"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; }
RUN=$(cat /tmp/claude-1000/a11_run)
python3 -c "
import json;f='/home/ryne/orwell-rehearsal/frontend/data/settings.json';d=json.load(open(f));d['image_gen_enabled']=False;json.dump(d,open(f,'w'))" || exit 2
export TMPDIR=${TMPDIR:-/home/ryne/.cache/a9chrome-tmp}; mkdir -p "$TMPDIR"
/home/ryne/orwell/frontend/.venv/bin/python3 "$HERE/live_week.py" --season --run-dir "$RUN" > "$RUN/live_season.out" 2>&1; RC=$?
"$KIT/stop.sh" >/dev/null 2>&1
case $RC in 0) V=PASS;; 1) V=FAIL;; *) V=COULD-NOT-RUN;; esac
echo "LIVE-SEASON $V $SHA $RUN/report.md"; exit $RC
