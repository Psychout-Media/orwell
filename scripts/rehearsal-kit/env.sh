# source me: WT = rehearsal worktree, RUN = this run's artifact dir (set by stage.sh)
. "$(dirname "${BASH_SOURCE[0]}")/slot.sh"   # sets WT and the slot values
export RUN=$(cat $RIG_RUN_PTR)
export KIT=${ORWELL_KIT:-/home/ryne/orwell-playtest/rehearsal-kit}   # the kit itself (slot-independent)
