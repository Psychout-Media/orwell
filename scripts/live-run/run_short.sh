#!/usr/bin/env bash
# ORW-109: one command for the short live run. Stages origin/<ref> (default main) on the rehearsal rig with FRESH data and images OFF, plays live_short.py against
# the real narrator, stops the rig by PID, and prints ONE line:  LIVE-SHORT PASS|FAIL|COULD-NOT-RUN <sha> <report path>.   Exit 0 pass, 1 fail, 2 could not run, 3 busy.
#   run_short.sh [--if-new] [REF]      --if-new: do nothing if this exact sha was already run (so a watcher can call it after every dev update)
# One run at a time (flock on the rig lock). Reads the narrator key only inside the kit's stage script; never prints it. Extra branches: MERGE_BRANCHES / MERGE_PR as the kit.
set -uo pipefail
KIT=${ORWELL_KIT:-/home/ryne/orwell-playtest/rehearsal-kit}; HERE=$(cd "$(dirname "$0")" && pwd); STATE=${ORWELL_LIVE_STATE:-/home/ryne/orwell-playtest/live-short}; mkdir -p "$STATE"
IF_NEW=0; [ "${1:-}" = "--if-new" ] && { IF_NEW=1; shift; }; REF=${1:-main}
exec 9>"$STATE/rig.lock"; flock -n 9 || { echo "LIVE-SHORT BUSY (another live run holds the rig)"; exit 3; }
git -C /home/ryne/orwell fetch -q origin "$REF" || { echo "LIVE-SHORT COULD-NOT-RUN fetch failed"; exit 2; }
SHA=$(git -C /home/ryne/orwell rev-parse --short=8 "origin/$REF")
[ "$IF_NEW" = 1 ] && [ "$(cat "$STATE/last-sha" 2>/dev/null)" = "$SHA" ] && { echo "LIVE-SHORT SKIPPED $SHA (already run)"; exit 0; }
if ! STAGE_REF="$REF" "$KIT/stage2.sh" > "$STATE/stage.log" 2>&1; then echo "LIVE-SHORT COULD-NOT-RUN $SHA stage failed (see $STATE/stage.log)"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; fi
RUN=$(cat /tmp/claude-1000/a11_run)
python3 - <<'P' || { echo "LIVE-SHORT COULD-NOT-RUN $SHA could not switch images off"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; }
import json
f="/home/ryne/orwell-rehearsal/frontend/data/settings.json"; d=json.load(open(f)); d["image_gen_enabled"]=False; json.dump(d,open(f,"w"))
P
TMPDIR=${TMPDIR:-/home/ryne/.cache/a9chrome-tmp}; mkdir -p "$TMPDIR"; export TMPDIR
PY=${ORWELL_PY:-/home/ryne/orwell/frontend/.venv/bin/python3}
"$PY" "$HERE/live_short.py" --run-dir "$RUN" > "$RUN/live_short.out" 2>&1; RC=$?
"$KIT/stop.sh" >/dev/null 2>&1
echo "$SHA" > "$STATE/last-sha"; cp "$RUN/report.md" "$STATE/last-report.md" 2>/dev/null
case $RC in 0) V=PASS;; 1) V=FAIL;; *) V=COULD-NOT-RUN;; esac
echo "LIVE-SHORT $V $SHA $RUN/report.md"; exit $RC
