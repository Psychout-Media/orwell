# source me: WT = rehearsal worktree, RUN = this run's artifact dir (set by stage.sh)
. "$(dirname "${BASH_SOURCE[0]}")/slot.sh"   # sets WT and the slot values
_env_here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$_env_here/slot.env" ]; then export RUN=$_env_here; else export RUN=$(cat $RIG_RUN_PTR); fi   # a copied run names ITSELF; only the kit-level script follows the slot's pointer
if [ -f "$_env_here/slot.env" ]; then export KIT=${KIT:-$_env_here}; else export KIT=${ORWELL_KIT:-$_env_here}; fi   # a staged run carries the kit that staged it (slot.env); the kit-level script is its own kit
