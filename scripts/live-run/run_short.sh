#!/usr/bin/env bash
# ORW-109: one command for the short live run. Stages origin/<ref> (default main) on the rehearsal rig with FRESH data and images OFF, plays live_short.py against
# the real narrator, stops the rig by PID, and prints ONE line:  LIVE-SHORT PASS|FAIL|COULD-NOT-RUN <sha> <report path>.   Exit 0 pass, 1 fail, 2 could not run, 3 busy.
#   run_short.sh [--if-new] [REF]      --if-new: do nothing if this exact sha was already run (so a watcher can call it after every dev update)
# One run at a time (flock on the rig lock). Reads the narrator key only inside the kit's stage script; never prints it. Extra branches: MERGE_BRANCHES / MERGE_PR as the kit.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); KIT=${ORWELL_KIT:-$HERE/../rehearsal-kit}; . "$KIT/slot.sh"; . "$HERE/short_lib.sh"   # RIG_SLOT (default 1) picks the rig: ports, lock, worktree, run pointer
STATE=$RIG_STATE_DIR; mkdir -p "$STATE"
IF_NEW=0; [ "${1:-}" = "--if-new" ] && { IF_NEW=1; shift; }; REF=${1:-main}; CAP=${RIG_SPEND_CAP:-0.5}   # ORW-109: a spend cap per run (dollars, estimated high)
short_valid_cap "$CAP" || { echo "LIVE-SHORT COULD-NOT-RUN RIG_SPEND_CAP=$CAP is not a positive number (a run without a working cap is never started)"; exit 2; }
exec 9>"$RIG_LOCK"; flock -n 9 || { echo "LIVE-SHORT BUSY (another live run holds rig slot $RIG_SLOT)"; exit 3; }
git -C "$RIG_HOME/orwell" fetch -q origin "${REF%%~*}" || { echo "LIVE-SHORT COULD-NOT-RUN fetch failed"; exit 2; }
SHA=$(git -C "$RIG_HOME/orwell" rev-parse --short=8 "origin/$REF")
[ "$IF_NEW" = 1 ] && [ "$(cat "$STATE/last-sha$RIG_SUFFIX" 2>/dev/null)" = "$SHA" ] && { echo "LIVE-SHORT SKIPPED $SHA (already run)"; exit 0; }
if ! STAGE_REF="$REF" "$KIT/stage2.sh" > "$STATE/stage$RIG_SUFFIX.log" 2>&1; then echo "LIVE-SHORT COULD-NOT-RUN $SHA stage failed (see $STATE/stage$RIG_SUFFIX.log)"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; fi
RUN=$(cat $RIG_RUN_PTR)
python3 - <<P || { echo "LIVE-SHORT COULD-NOT-RUN $SHA could not switch images off"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2; }
import json
f="$WT/frontend/data/settings.json"; d=json.load(open(f)); d["image_gen_enabled"]=False
import os
if os.environ.get("RIG_ZERO_CLOCKS") == "0": d["zero_clocks"]=False  # the known-bad proof: the ORW-377 setting OFF brings back clock times
json.dump(d,open(f,"w"))
P
TMPDIR=${TMPDIR:-$RIG_HOME/.cache/a9chrome-tmp}; mkdir -p "$TMPDIR"; export TMPDIR
PY=${ORWELL_PY:-$RIG_HOME/orwell/frontend/.venv/bin/python3}
LLMIO="$WT/frontend/data/llm-io.jsonl"
# The report header (the Live Run Pass Bar's format): build, model, cap, and the engine's /health flags.
python3 - "$RUN" "$SHA" "$REF" "$CAP" "$WT/frontend/data/settings.json" <<'P'
import json, sys
run, sha, ref, cap, settings = sys.argv[1:6]
try: model = json.load(open(f"{run}/default-chat.json")).get("model") or json.load(open(settings)).get("default_model") or "?"
except Exception: model = "?"
json.dump({"sha": sha, "ref": ref, "cap": cap, "model": model}, open(f"{run}/meta.json", "w"))
P
curl -s --max-time 10 -H "x-orwell-token: rehlocal" "$RIG_ENGINE_URL/health" > "$RUN/health.json" 2>/dev/null || true
python3 "$KIT/spend_guard.py" "$LLMIO" "$CAP" "$RUN" > "$RUN/spend-guard.out" 2>&1 & echo $! > "$RUN/spend.pid"
CROSS=(); [ "${RIG_CROSSOVER:-}" = 1 ] && CROSS=(--crossover)   # only the exact value 1 (RIG_CROSSOVER=0 must not turn it on)
"$PY" "$HERE/live_short.py" --fe "$RIG_BASE" --engine "$RIG_ENGINE_URL" --run-dir "$RUN" ${CROSS[@]+"${CROSS[@]}"} > "$RUN/live_short.out" 2>&1 & echo $! > "$RUN/driver.pid"
wait "$(cat "$RUN/driver.pid")"; RC=$?
kill "$(cat "$RUN/spend.pid")" 2>/dev/null
python3 "$KIT/spend_guard.py" "$LLMIO" "$CAP" "$RUN" --once >/dev/null 2>&1   # a final spend.json for the report
short_patch_spend "$RUN"; [ -f "$RUN/SPEND-CAP-HIT" ] && short_partial_report "$RUN" "$SHA" "$CAP"
"$KIT/stop.sh" >/dev/null 2>&1
echo "$SHA" > "$STATE/last-sha$RIG_SUFFIX"; cp "$RUN/report.md" "$STATE/last-report$RIG_SUFFIX.md" 2>/dev/null
if [ -f "$RUN/SPEND-CAP-HIT" ]; then echo "LIVE-SHORT CAPPED $SHA $RUN/report.md (spend cap \$$CAP hit; see $RUN/spend.json)"; exit 4; fi
case $RC in 0) V=PASS;; 1) V=FAIL;; *) V=COULD-NOT-RUN;; esac
echo "LIVE-SHORT $V $SHA $RUN/report.md"; exit $RC
