#!/usr/bin/env bash
# usage: pr.sh N 'text' ['{"pick":[0]}'] - p.sh with up to 3 upstream-failure retries (30 s apart); N is a LOGICAL turn id. Exit 1 when the turn failed or the last retry still hit an upstream failure.
# NOTE: a retry sends the same player action as a fresh turn; read the engine status first if the failed call may have committed (see ORW-481 card).
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
D=$(cat $RIG_RUN_PTR); N=$1; shift
for try in 1 2 3 4; do
  out=$($D/p.sh $((N*10+try)) "$@"); rc=$?
  if [ $rc -ne 0 ]; then echo "$out"; exit $rc; fi
  if echo "$out" | grep -q "technical interlude\|feed glitched"; then
    [ $try -lt 4 ] || { echo "$out"; echo "(upstream failure persisted through 3 retries)" >&2; exit 1; }
    echo "(try $try failed upstream; retrying)"; sleep 30
  else echo "$out"; exit 0; fi
done
