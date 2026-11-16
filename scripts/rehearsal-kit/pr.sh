#!/usr/bin/env bash
# usage: pr.sh N 'text' ['{"pick":[0]}'] - p.sh with up to 3 upstream-failure retries (30 s apart); N is a LOGICAL turn id. Exit 1 when the turn failed or the last retry still hit an upstream failure.
# A retry only happens when the engine status is byte-identical to what it was before the failed attempt (so nothing committed); if the status moved, the turn went through
# and a retry would double-advance it: exit 3 instead and let the driver read the engine (ORW-506).
snap() { curl -s --max-time 15 "$RIG_BASE/api/orwell/status" | python3 -c 'import sys,hashlib; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'; }
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
D=$(cat $RIG_RUN_PTR); N=$1; shift
for try in 1 2 3 4; do
  before=$(snap)
  out=$($D/p.sh $((N*10+try)) "$@"); rc=$?
  if [ $rc -ne 0 ]; then echo "$out"; exit $rc; fi
  if echo "$out" | grep -q "technical interlude\|feed glitched"; then
    [ $try -lt 4 ] || { echo "$out"; echo "(upstream failure persisted through 3 retries)" >&2; exit 1; }
    after=$(snap)
    if [ "$before" != "$after" ] || [ -z "$after" ]; then echo "$out"; echo "(try $try failed upstream but the engine state moved or could not be read: the turn may have committed; NOT retrying - read the status)" >&2; exit 3; fi
    echo "(try $try failed upstream; engine unchanged; retrying)"; sleep "${PR_RETRY_SLEEP:-30}"
  else echo "$out"; exit 0; fi
done
