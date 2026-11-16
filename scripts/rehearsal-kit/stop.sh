#!/usr/bin/env bash
# PID files only - never pkill -f.   RIG_SLOT=2 ./stop.sh stops slot 2's run (the pointer of that slot); slot 1 is the default.
# Exit 1 when the pointer or run directory is unreadable or no recorded process was stopped (nothing is claimed that did not happen). A pid is signalled ONLY when its command line still
# looks like this kit's process (a reused pid of an unrelated program is left alone and its stale pid file removed).
. "$(dirname "$(readlink -f "$0")")/slot.sh"   # slot values (a run dir carries its own slot.env)
RUN=$(cat "$RIG_RUN_PTR" 2>/dev/null) && [ -n "$RUN" ] && [ -d "$RUN" ] || { echo "stop: run pointer $RIG_RUN_PTR is unreadable or names no run directory" >&2; exit 1; }
n=0
for p in daemon fe engine; do
  f=$RUN/$p.pid; [ -f "$f" ] || continue
  pid=$(cat "$f" 2>/dev/null)
  case $p in daemon) pat='daemon\.py';; fe) pat='uvicorn';; engine) pat='dist/main\.js';; esac
  if [ -n "$pid" ] && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qE "$pat"; then kill "$pid" 2>/dev/null && n=$((n+1)); else rm -f "$f"; fi
done
[ "$n" -gt 0 ] && echo "stopped $n" || { echo "stop: no live process of run $RUN to stop" >&2; exit 1; }
