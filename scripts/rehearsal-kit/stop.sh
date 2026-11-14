#!/usr/bin/env bash
# PID files only — never pkill -f.   RIG_SLOT=2 ./stop.sh stops slot 2's run (the pointer of that slot); slot 1 is the default.
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
RUN=$(cat $RIG_RUN_PTR); for p in daemon fe engine; do [ -f $RUN/$p.pid ] && kill $(cat $RUN/$p.pid) 2>/dev/null; done; echo stopped
