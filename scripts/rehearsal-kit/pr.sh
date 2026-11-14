#!/usr/bin/env bash
# usage: pr.sh N 'text' ['{"pick":[0]}'] — p.sh with up to 3 upstream-failure retries (30 s apart); N is a LOGICAL turn id
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
D=$(cat $RIG_RUN_PTR); N=$1; shift
for try in 1 2 3; do
  out=$($D/p.sh $((N*10+try)) "$@")
  if echo "$out" | grep -q "technical interlude\|feed glitched"; then echo "(try $try failed upstream; retrying)"; sleep 30; else echo "$out"; exit 0; fi
done
echo "$out"
