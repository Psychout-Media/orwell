#!/usr/bin/env bash
# ORW-109: the "after every dev update" trigger for the short tier. Dev auto-deploys main, so a new origin/main sha IS a dev update. Every POLL seconds
# (default 600) this fetches main and, when the sha is new, runs the short tier on rig slot RIG_SLOT (default 2) under the spend cap (RIG_SPEND_CAP, default
# $0.50). Each run's one verdict line is appended to $STATE/watch-<slot>.log (watch-2.log on the default slot 2, watch.log on slot 1; LIVE-SHORT PASS|FAIL|CAPPED|COULD-NOT-RUN <sha> <report path>), which the agent on
# watch reads to post the report on the board and card each FAIL the same day. A busy slot (another run holds it) is retried on the next poll.
#   RIG_SLOT=2 scripts/live-run/dev_watch.sh            # loop forever
#   RIG_SLOT=2 scripts/live-run/dev_watch.sh --once     # one poll (a cron line can call this)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); export RIG_SLOT=${RIG_SLOT:-2}; KIT=${ORWELL_KIT:-$HERE/../rehearsal-kit}; . "$KIT/slot.sh"
STATE=$RIG_STATE_DIR; mkdir -p "$STATE"; LOG="$STATE/watch$RIG_SUFFIX.log"; POLL=${POLL:-600}
STOP=0; trap 'STOP=1' TERM INT   # a kill during a run waits for that run's verdict and records it (run_short.sh has already marked the sha as done), then stops
poll() {
  local out line rc child
  out=$(mktemp); "$HERE/run_short.sh" --if-new main > "$out" 2>&1 & child=$!
  while :; do wait "$child"; rc=$?; kill -0 "$child" 2>/dev/null || break; done   # a trapped signal interrupts `wait` while the child still runs: wait again
  line=$(tail -1 "$out"); rm -f "$out"
  case "$line" in *SKIPPED*|*BUSY*) return 0;; esac   # nothing new, or the slot is in use: try again next poll
  echo "$(date -u +%FT%TZ) $line" >> "$LOG"; echo "$line"
  return $rc
}
if [ "${1:-}" = "--once" ]; then poll; exit $?; fi
# The period is measured from the START of each poll, so a long run does not push the next fetch out by its whole length. This watcher tests the NEWEST main tip
# each time (ORW-109: a cheap latest-tip check); commits superseded while a run was active are covered by the tip that contains them, and a FAIL is bisected by hand.
while [ "$STOP" = 0 ]; do
  t0=$(date +%s); poll || true
  [ "$STOP" = 0 ] || break
  left=$(( POLL - ($(date +%s) - t0) )); [ "$left" -gt 0 ] && { sleep "$left" & wait $!; }
done
