#!/usr/bin/env bash
# ORW-332 / ORW-344: ONE whole Week 1 (casting to the morning of Week 2) on the real narrator, on rig slot RIG_SLOT (default 1), under a SPEND CAP. Prints one line:
#   LIVE-WEEK PASS|FAIL|COULD-NOT-RUN|CAPPED <sha> <report path>      exit 0 pass, 1 fail, 2 could not run, 3 busy, 4 capped (the spend cap stopped it).
#   RIG_SLOT=2 RIG_SPEND_CAP=3 scripts/live-run/week.sh [REF]
#   RIG_WEEKS=N ... play on through week N (default 1 = Week 1 only; the cap and the checks run the same)
#   RIG_DRY=1 ...   a DRY stage: stand the slot up, check the front end and the engine answer, tear it down. No driver, no model calls, nothing spent.
# One run per slot at a time (flock on the slot's lock). Reads the narrator key only inside the kit's stage script; never prints it. Extra branches: MERGE_BRANCHES / MERGE_PR as the kit.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); KIT=${ORWELL_KIT:-$HERE/../rehearsal-kit}; . "$KIT/slot.sh"
STATE=$RIG_STATE_DIR; mkdir -p "$STATE"; REF=${1:-main}; CAP=${RIG_SPEND_CAP:-3}
exec 9>"$RIG_LOCK"; flock -n 9 || { echo "LIVE-WEEK BUSY (another live run holds rig slot $RIG_SLOT)"; exit 3; }
git -C /home/ryne/orwell fetch -q origin "$REF" || { echo "LIVE-WEEK COULD-NOT-RUN fetch failed"; exit 2; }
SHA=$(git -C /home/ryne/orwell rev-parse --short=8 "origin/$REF")
if ! STAGE_REF="$REF" "$KIT/stage2.sh" > "$STATE/stage$RIG_SUFFIX.log" 2>&1; then echo "LIVE-WEEK COULD-NOT-RUN $SHA stage failed (see $STATE/stage$RIG_SUFFIX.log)"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; fi
RUN=$(cat "$RIG_RUN_PTR")
python3 - <<P || { echo "LIVE-WEEK COULD-NOT-RUN $SHA could not switch images off"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; }
import json
f="$WT/frontend/data/settings.json"; d=json.load(open(f)); d["image_gen_enabled"]=False; json.dump(d,open(f,"w"))
P
if [ "${RIG_DRY:-0}" = 1 ]; then
  FE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$RIG_BASE/api/orwell/status"); EN=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "x-orwell-token: rehlocal" "$RIG_ENGINE_URL/health")
  "$KIT/stop.sh" >/dev/null 2>&1
  echo "LIVE-WEEK DRY slot=$RIG_SLOT $SHA fe=$FE engine=$EN run=$RUN"; [ "$FE" = 200 ] && [ "$EN" = 200 ]; exit $?
fi
TMPDIR=${TMPDIR:-/home/ryne/.cache/a9chrome-tmp}; mkdir -p "$TMPDIR"; export TMPDIR
PY=${ORWELL_PY:-/home/ryne/orwell/frontend/.venv/bin/python3}; LLMIO="$WT/frontend/data/llm-io.jsonl"
python3 "$KIT/spend_guard.py" "$LLMIO" "$CAP" "$RUN" > "$RUN/spend-guard.out" 2>&1 & echo $! > "$RUN/spend.pid"
EXTRA=""; [ "${RIG_WEEKS:-1}" -gt 1 ] && EXTRA="--season --stop-after-week $RIG_WEEKS"   # RIG_WEEKS=3: Week 1 then weeks 2 and 3 (ORW-350), stopping when week 3 ends
"$PY" "$HERE/live_week.py" --fe "$RIG_BASE" --engine "$RIG_ENGINE_URL" --run-dir "$RUN" $EXTRA > "$RUN/live_week.out" 2>&1 & echo $! > "$RUN/driver.pid"
wait "$(cat "$RUN/driver.pid")"; RC=$?
kill "$(cat "$RUN/spend.pid")" 2>/dev/null
python3 "$KIT/spend_guard.py" "$LLMIO" "$CAP" "$RUN" --once >/dev/null 2>&1   # a final spend.json
(cd "$KIT" && python3 rig_stats.py "$LLMIO" "$RUN" >/dev/null 2>&1)
"$KIT/stop.sh" >/dev/null 2>&1
if [ -f "$RUN/SPEND-CAP-HIT" ]; then echo "LIVE-WEEK CAPPED $SHA $RUN/report.md (spend cap \$$CAP hit; see $RUN/spend.json)"; exit 4; fi
case $RC in 0) V=PASS;; 1) V=FAIL;; *) V=COULD-NOT-RUN;; esac
echo "LIVE-WEEK $V $SHA $RUN/report.md"; exit $RC
