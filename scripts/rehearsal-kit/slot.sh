# Rig slots (ORW-344). SOURCE this file; never run it.   . "$(dirname "${BASH_SOURCE[0]}")/slot.sh"
# One variable, RIG_SLOT (default 1), sets every port and path the rehearsal kit uses, so two playtests can run at once.
#   slot 1 = the rig as it has always been, byte for byte: engine :18765, front end :17000, rig.lock, /home/ryne/orwell-rehearsal, pointer /tmp/claude-1000/a11_run, runs rehearsal-<date>.
#   slot 2 shares NOTHING with it: engine :18766, front end :17001, rig-2.lock beside rig.lock, its own worktree, its own run pointer, runs slot2-rehearsal-<date> (no "rehearsal-*" glob of slot 1 can ever match them).
# The scripts a stage copies into a run directory keep working there: stage writes `slot.env` (the resolved values) beside them and they read that first.
if [ -n "${RIG_SLOT_ENV:-}" ] && [ -f "$RIG_SLOT_ENV" ]; then . "$RIG_SLOT_ENV"; else
  _rig_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [ -f "$_rig_here/slot.env" ]; then . "$_rig_here/slot.env"; else
    RIG_SLOT=${RIG_SLOT:-1}
    RIG_PLAYTEST_DIR=${ORWELL_PLAYTEST_DIR:-/home/ryne/orwell-playtest}
    RIG_STATE_DIR=${ORWELL_LIVE_STATE:-$RIG_PLAYTEST_DIR/live-short}
    case "$RIG_SLOT" in
      1) RIG_ENGINE_PORT=18765; RIG_FE_PORT=17000; WT=/home/ryne/orwell-rehearsal;   RIG_RUN_PTR=/tmp/claude-1000/a11_run;   RIG_RUN_PREFIX=rehearsal-;    RIG_SUFFIX="" ;;
      2) RIG_ENGINE_PORT=18766; RIG_FE_PORT=17001; WT=/home/ryne/orwell-slot2; RIG_RUN_PTR=/tmp/claude-1000/a11_run_2; RIG_RUN_PREFIX=slot2-rehearsal-; RIG_SUFFIX="-2" ;;
      *) echo "FATAL: RIG_SLOT must be 1 or 2 (got '$RIG_SLOT')" >&2; exit 2 ;;   # exit, not return: a sourcing script without set -e must not carry on with empty values
    esac
    RIG_LOCK=$RIG_STATE_DIR/rig$RIG_SUFFIX.lock
    RIG_BASE=http://127.0.0.1:$RIG_FE_PORT; RIG_ENGINE_URL=http://127.0.0.1:$RIG_ENGINE_PORT
  fi
fi
export RIG_SLOT RIG_ENGINE_PORT RIG_FE_PORT RIG_BASE RIG_ENGINE_URL RIG_RUN_PTR RIG_LOCK RIG_STATE_DIR RIG_SUFFIX WT

# Write the resolved values for a run directory (the scripts copied there source it).
rig_write_slot_env() { # $1 = run dir
  { for v in RIG_SLOT RIG_ENGINE_PORT RIG_FE_PORT RIG_BASE RIG_ENGINE_URL RIG_RUN_PTR RIG_LOCK RIG_STATE_DIR RIG_SUFFIX RIG_RUN_PREFIX RIG_PLAYTEST_DIR WT; do printf '%s=%q\n' "$v" "${!v}"; done; } > "$1/slot.env"
}

# Slot 1's worktree is the established rehearsal tree and is never created or altered here. Any other slot gets its OWN git worktree, sharing node_modules and the front-end venv READ-ONLY
# from the main checkout (so no second install and nothing written into slot 1's tree).
rig_ensure_worktree() {
  [ "$RIG_SLOT" = 1 ] && return 0
  local main=${ORWELL_MAIN_CHECKOUT:-/home/ryne/orwell}
  if [ ! -e "$WT/.git" ]; then git -C "$main" worktree add --detach "$WT" origin/main >/dev/null 2>&1 || { echo "FATAL: could not create the slot-$RIG_SLOT worktree $WT" >&2; return 1; }; fi
  [ -e "$WT/node_modules" ] || ln -s "$main/node_modules" "$WT/node_modules"
  [ -e "$WT/frontend/.venv" ] || ln -s "$main/frontend/.venv" "$WT/frontend/.venv"
}
