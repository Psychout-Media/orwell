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
CANCELLED=0
cleanup() {  # a cancelled run ends its own children (the driver and the spend guard, by recorded pid) and THEN stops the rig
  if [ "$CANCELLED" = 1 ] && [ -n "${RUN:-}" ]; then for n in driver spend; do [ -f "$RUN/$n.pid" ] && { kill "$(cat "$RUN/$n.pid")" 2>/dev/null; wait "$(cat "$RUN/$n.pid")" 2>/dev/null; }; done; fi
  "$KIT/stop.sh" >/dev/null 2>&1
}
trap cleanup EXIT; trap 'CANCELLED=1; exit 143' TERM; trap 'CANCELLED=1; exit 130' INT   # a cancelled run stops the rig AND ends (a bare TERM trap would let the script carry on against a stopped rig)
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
[ "${RIG_EVICTION:-}" = 1 ] && [ "${RIG_CROSSOVER:-}" != 1 ] && CROSS=(--eviction)   # ORW-506: RIG_EVICTION=1 forces eviction night and plays it (the exact value 1; not with RIG_CROSSOVER=1); the run stays under the same RIG_SPEND_CAP guard
case "${RIG_EVICTION_TURNS:-}" in [0-9]|[0-9][0-9]) [ "${CROSS[*]:-}" = "--eviction" ] && CROSS=(--eviction --eviction-turns "$RIG_EVICTION_TURNS") ;; esac   # the bound on the night's chat turns (1..20; eviction_e1.py clamps)
# ORW-109 formal short tier: RIG_BEATS="veto-ceremony eviction finale" (any subset) adds the beats; --max-spend is the run's cap, --max-turns bounds the real chat turns (RIG_MAX_TURNS, default 60).
BEATS=(); for b in ${RIG_BEATS:-}; do case "$b" in veto-ceremony) BEATS+=(--veto-ceremony);; eviction) [ "${CROSS[*]:-}" = "" ] && CROSS=(--eviction);; finale) BEATS+=(--finale);; *) echo "LIVE-SHORT COULD-NOT-RUN unknown RIG_BEATS entry '$b'"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2;; esac; done
case "${RIG_MAX_TURNS:-60}" in ''|*[!0-9]*|0) echo "LIVE-SHORT COULD-NOT-RUN RIG_MAX_TURNS must be a positive integer"; "$KIT/stop.sh" >/dev/null 2>&1; exit 2;; esac
"$PY" "$HERE/live_short.py" --max-spend "$CAP" --max-turns "${RIG_MAX_TURNS:-60}" ${BEATS[@]+"${BEATS[@]}"} --fe "$RIG_BASE" --engine "$RIG_ENGINE_URL" --run-dir "$RUN" ${CROSS[@]+"${CROSS[@]}"} > "$RUN/live_short.out" 2>&1 & echo $! > "$RUN/driver.pid"
wait "$(cat "$RUN/driver.pid")"; RC=$?
kill "$(cat "$RUN/spend.pid")" 2>/dev/null
python3 "$KIT/spend_guard.py" "$LLMIO" "$CAP" "$RUN" --once >/dev/null 2>&1   # a final spend.json for the report
short_patch_spend "$RUN"; [ -f "$RUN/SPEND-CAP-HIT" ] && short_partial_report "$RUN" "$SHA" "$CAP"
"$KIT/stop.sh" >/dev/null 2>&1
# a COULD-NOT-RUN revision stays untested, so --if-new tries it again; a CAPPED run (the guard TERMs the driver: RC 143) DID run and spend its cap, so it is recorded or every poll would re-spend the cap on the same build
if [ -f "$RUN/SPEND-CAP-HIT" ]; then echo "$SHA" > "$STATE/last-sha$RIG_SUFFIX"; else case $RC in 0|1|4) echo "$SHA" > "$STATE/last-sha$RIG_SUFFIX";; esac; fi
cp "$RUN/report.md" "$STATE/last-report$RIG_SUFFIX.md" 2>/dev/null
if [ -f "$RUN/SPEND-CAP-HIT" ]; then echo "LIVE-SHORT CAPPED $SHA $RUN/report.md (spend cap \$$CAP hit; see $RUN/spend.json)"; exit 4; fi
case $RC in 0) V=PASS;; 1) V=FAIL;; 4) V=CAPPED;; *) V=COULD-NOT-RUN;; esac
echo "LIVE-SHORT $V $SHA $RUN/report.md"; exit $RC
