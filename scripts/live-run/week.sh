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
python3 -c 'import sys; c=float(sys.argv[1]); assert c>0 and c==c' "$CAP" 2>/dev/null || { echo "LIVE-WEEK COULD-NOT-RUN RIG_SPEND_CAP must be a positive number (got '$CAP'); nothing was started"; exit 2; }   # fail closed: never a paid run without a working guard
case "${RIG_WEEKS:-1}" in ''|*[!0-9]*|0) echo "LIVE-WEEK COULD-NOT-RUN RIG_WEEKS must be a positive integer (got '${RIG_WEEKS:-}'); nothing was started"; exit 2;; esac   # validated before anything is staged or spent
exec 9>"$RIG_LOCK"; flock -n 9 || { echo "LIVE-WEEK BUSY (another live run holds rig slot $RIG_SLOT)"; exit 3; }
git -C "$RIG_HOME/orwell" fetch -q origin "$REF" || { echo "LIVE-WEEK COULD-NOT-RUN fetch failed"; exit 2; }
SHA=$(git -C "$RIG_HOME/orwell" rev-parse --short=8 "origin/$REF")
PRE_PTR=$(cat "$RIG_RUN_PTR" 2>/dev/null || true)
trap 'for p in spend driver; do [ -f "${RUN:-/nonexistent}/$p.pid" ] && kill "$(cat "$RUN/$p.pid")" 2>/dev/null; done; [ -n "${RUN:-}" ] && "$KIT/stop.sh" >/dev/null 2>&1' INT TERM   # an interrupted run never leaves its rig or its guard behind
if ! STAGE_REF="$REF" "$KIT/stage2.sh" > "$STATE/stage$RIG_SUFFIX.log" 2>&1; then
  echo "LIVE-WEEK COULD-NOT-RUN $SHA stage failed (see $STATE/stage$RIG_SUFFIX.log)"
  [ "$(cat "$RIG_RUN_PTR" 2>/dev/null || true)" != "$PRE_PTR" ] && "$KIT/stop.sh" >/dev/null 2>&1   # stop only a run THIS stage created, never the one the pointer named before
  exit 2
fi
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
TMPDIR=${TMPDIR:-$RIG_HOME/.cache/a9chrome-tmp}; mkdir -p "$TMPDIR"; export TMPDIR
PY=${ORWELL_PY:-$RIG_HOME/orwell/frontend/.venv/bin/python3}; LLMIO="$WT/frontend/data/llm-io.jsonl"
python3 "$KIT/spend_guard.py" "$LLMIO" "$CAP" "$RUN" > "$RUN/spend-guard.out" 2>&1 & echo $! > "$RUN/spend.pid"
sleep 2; kill -0 "$(cat "$RUN/spend.pid")" 2>/dev/null || { echo "LIVE-WEEK COULD-NOT-RUN $SHA the spend guard did not stay alive (see $RUN/spend-guard.out); the paid driver was not started"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; }
EXTRA=""; [ "${RIG_WEEKS:-1}" -gt 1 ] && EXTRA="--season --stop-after-week $RIG_WEEKS"   # RIG_WEEKS=3: Week 1 then weeks 2 and 3 (ORW-350), stopping when week 3 ends
"$PY" "$HERE/live_week.py" --fe "$RIG_BASE" --engine "$RIG_ENGINE_URL" --run-dir "$RUN" $EXTRA > "$RUN/live_week.out" 2>&1 & echo $! > "$RUN/driver.pid"
wait "$(cat "$RUN/driver.pid")"; RC=$?
kill "$(cat "$RUN/spend.pid")" 2>/dev/null
python3 "$KIT/spend_guard.py" "$LLMIO" "$CAP" "$RUN" --once >/dev/null 2>&1   # a final spend.json
(cd "$KIT" && python3 rig_stats.py "$LLMIO" "$RUN" >/dev/null 2>&1)
"$KIT/stop.sh" >/dev/null 2>&1
if [ -f "$RUN/SPEND-CAP-HIT" ]; then echo "LIVE-WEEK CAPPED $SHA $RUN/spend.json (spend cap \$$CAP hit; the driver was stopped before it wrote a report; see also $RUN/rig-stats.md)"; exit 4; fi
case $RC in 0) V=PASS;; 1) V=FAIL;; *) V=COULD-NOT-RUN;; esac
echo "LIVE-WEEK $V $SHA $RUN/report.md"; exit $RC
