# source me. rig_pid_is KIND PID RUN: true only when PID is this run's own KIND process (command line AND, for engine/fe, working directory under $WT; daemon: its command line names $RUN).
rig_pid_is() {
  local kind=$1 pid=$2 run=$3 cmd cwd
  case $pid in ""|*[!0-9]*) return 1;; esac
  cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null) || return 1
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || cwd=""
  case $kind in
    daemon) case $cmd in *daemon.py*"$run"*) return 0;; esac;;
    fe) case $cmd in *uvicorn*"--port $RIG_FE_PORT"*) case $cwd in "$WT"/frontend*) return 0;; esac;; esac;;
    engine) case $cmd in *dist/main.js*) case $cwd in "$WT"|"$WT"/*) return 0;; esac;; esac;;
  esac
  return 1
}
