#!/usr/bin/env bash
# ORW-506: run the card-aware, toast-synchronised hang-out driver (a21_sync_drive.py) against the run ALREADY STAGED on rig slot RIG_SLOT (default 1), UNDER A SPEND CAP.
#   RIG_SLOT=2 RIG_SPEND_CAP=0.5 scripts/rehearsal-kit/a21-sync-run.sh SCRIPT.txt [--max-messages N] [--max-cards N] [--max-toast-nexts N]
# Prints one line: A21-SYNC DONE|ABORT|CAPPED|COULD-NOT-RUN <run dir>.  Exit 0 done, 1 aborted, 2 could not run (nothing started), 4 capped.
# It does NOT stage and does NOT stop the rig (the lead stages with stage.sh / stage2.sh and stops with stop.sh). It takes the slot's lock so two drivers never share a rig.
# The guard (spend_guard.py) and the driver are signalled by PID only, and only while their command line still looks like ours (stop.sh's rule). A dead guard stops the driver.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/slot.sh"
SCRIPT=${1:-}; shift || true
CAP=${RIG_SPEND_CAP:-0.5}
python3 -c 'import sys, math; c=float(sys.argv[1]); assert math.isfinite(c) and 0 < c < 1e9' "$CAP" 2>/dev/null || { echo "A21-SYNC COULD-NOT-RUN RIG_SPEND_CAP must be a positive number (got '$CAP'); nothing was started"; exit 2; }
[ -f "$SCRIPT" ] || { echo "A21-SYNC COULD-NOT-RUN usage: a21-sync-run.sh SCRIPT.txt [driver flags]; no such script '$SCRIPT'"; exit 2; }
python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import sync_lib; sync_lib.parse_script(open(sys.argv[2]).read())' "$HERE" "$SCRIPT" 2>/dev/null || { echo "A21-SYNC COULD-NOT-RUN the script does not parse (see sync_lib.py for the format)"; exit 2; }
RUN=$(cat "$RIG_RUN_PTR" 2>/dev/null) && [ -n "$RUN" ] && [ -d "$RUN" ] || { echo "A21-SYNC COULD-NOT-RUN no staged run for slot $RIG_SLOT (pointer $RIG_RUN_PTR); stage one first"; exit 2; }
mkdir -p "$RIG_STATE_DIR"; exec 9>"$RIG_LOCK"; flock -n 9 || { echo "A21-SYNC BUSY (another live run holds rig slot $RIG_SLOT)"; exit 3; }
curl -s -o /dev/null --max-time 10 "$RIG_BASE/api/orwell/status" || { echo "A21-SYNC COULD-NOT-RUN the front end is not answering on slot $RIG_SLOT; nothing was started"; exit 2; }
[ -f "$RUN/SPEND-CAP-HIT" ] && { echo "A21-SYNC COULD-NOT-RUN this run already hit its spend cap (SPEND-CAP-HIT in $RUN); stage a fresh run"; exit 2; }
cp "$SCRIPT" "$RUN/script.txt"
LLMIO="$WT/frontend/data/llm-io.jsonl"
PY=${ORWELL_PY:-$RIG_HOME/orwell/frontend/.venv/bin/python3}
TMPDIR=${TMPDIR:-$RIG_HOME/.cache/a9chrome-tmp}; mkdir -p "$TMPDIR"; export TMPDIR
_ours() { local pid; pid=$(cat "$1" 2>/dev/null); case $pid in ""|*[!0-9]*) return 1;; esac; tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "$2"; }   # a pid file names a process of ours only while its command line still says so
_stop() { _ours "$1" "$2" && kill "$(cat "$1")" 2>/dev/null; return 0; }
trap '_stop "$RUN/driver.pid" a21_sync_drive; _stop "$RUN/a21-spend.pid" spend_guard' INT TERM
python3 "$HERE/spend_guard.py" "$LLMIO" "$CAP" "$RUN" > "$RUN/a21-spend-guard.out" 2>&1 & echo $! > "$RUN/a21-spend.pid"
sleep 2; _ours "$RUN/a21-spend.pid" spend_guard || { echo "A21-SYNC COULD-NOT-RUN the spend guard did not stay alive (see $RUN/a21-spend-guard.out); the paid driver was not started"; exit 2; }
"$PY" "$HERE/a21_sync_drive.py" "$RUN" "$@" > "$RUN/a21-driver.out" 2>&1 & echo $! > "$RUN/driver.pid"
DPID=$(cat "$RUN/driver.pid"); SPID=$(cat "$RUN/a21-spend.pid")
( while kill -0 "$DPID" 2>/dev/null; do kill -0 "$SPID" 2>/dev/null || { _stop "$RUN/driver.pid" a21_sync_drive; echo guard-died > "$RUN/a21-GUARD-DIED"; break; }; sleep 2; done ) &
WATCH=$!
wait "$DPID"; RC=$?
kill "$WATCH" 2>/dev/null
_stop "$RUN/a21-spend.pid" spend_guard
python3 "$HERE/spend_guard.py" "$LLMIO" "$CAP" "$RUN" --once >/dev/null 2>&1   # a final spend.json
[ -f "$RUN/a21-GUARD-DIED" ] && { echo "A21-SYNC COULD-NOT-RUN the spend guard died mid-run; the driver was stopped ($RUN)"; exit 2; }
[ -f "$RUN/SPEND-CAP-HIT" ] && { echo "A21-SYNC CAPPED $RUN (spend cap \$$CAP hit; see $RUN/spend.json)"; exit 4; }
case $RC in 0) echo "A21-SYNC DONE $RUN (log $RUN/a21sync.log)"; exit 0;; 1) echo "A21-SYNC ABORT $RUN (log $RUN/a21sync.log)"; exit 1;; *) echo "A21-SYNC COULD-NOT-RUN driver exit $RC (see $RUN/a21-driver.out)"; exit 2;; esac
