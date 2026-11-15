#!/usr/bin/env bash
# ORW-109: the "after every dev update" trigger for the short tier. Dev auto-deploys main, so a new origin/main sha IS a dev update. Every POLL seconds
# (default 600) this fetches main and, when the sha is new, runs the short tier on rig slot RIG_SLOT (default 2) under the spend cap (RIG_SPEND_CAP, default
# $0.50). Each run's one verdict line is appended to $STATE/watch.log (LIVE-SHORT PASS|FAIL|CAPPED|COULD-NOT-RUN <sha> <report path>), which the agent on
# watch reads to post the report on the board and card each FAIL the same day. A busy slot (another run holds it) is retried on the next poll.
#   RIG_SLOT=2 scripts/live-run/dev_watch.sh            # loop forever
#   RIG_SLOT=2 scripts/live-run/dev_watch.sh --once     # one poll (a cron line can call this)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); export RIG_SLOT=${RIG_SLOT:-2}; KIT=${ORWELL_KIT:-$HERE/../rehearsal-kit}; . "$KIT/slot.sh"
STATE=$RIG_STATE_DIR; mkdir -p "$STATE"; LOG="$STATE/watch$RIG_SUFFIX.log"; POLL=${POLL:-600}
poll() {
  local line rc
  line=$("$HERE/run_short.sh" --if-new main 2>&1 | tail -1); rc=$?
  case "$line" in *SKIPPED*|*BUSY*) return 0;; esac   # nothing new, or the slot is in use: try again next poll
  echo "$(date -u +%FT%TZ) $line" >> "$LOG"; echo "$line"
  return $rc
}
if [ "${1:-}" = "--once" ]; then poll; exit $?; fi
while true; do poll || true; sleep "$POLL"; done
