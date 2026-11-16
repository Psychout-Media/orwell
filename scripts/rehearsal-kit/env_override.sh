# ORW-109: RIG_ENV_OVERRIDE="ORWELL_X=0 ORWELL_Y=1" - flag flips applied AFTER the deploy defaults, so a proof run can stage a known-bad build.
# Sourced by stage2.sh. Entries are separated by whitespace. An entry that is not exactly ORWELL_<NAME>=<value> is an ERROR, and so is a value that has another
# ORWELL_<NAME>= inside it (a comma or other separator between entries: "ORWELL_A=0,ORWELL_B=1" would set A to "0,ORWELL_B=1" and never set B): a typo must never
# stage a build without the flag you asked for. stage2.sh validates FIRST, before the checkout and the build.
rig_validate_env_override() {
  local kv; local -a kvs=()
  read -ra kvs <<<"$1"   # split on blanks with no pathname expansion: "ORWELL_A=*" stays "*" (review of #2795)
  for kv in ${kvs[@]+"${kvs[@]}"}; do
    if ! [[ "$kv" =~ ^ORWELL_[A-Za-z0-9_]+=.*$ ]]; then
      echo "FATAL: RIG_ENV_OVERRIDE entry '$kv' is not ORWELL_<NAME>=<value>; not staging a build without the flag you asked for" >&2; return 1
    fi
    if [[ "${kv#*=}" =~ ORWELL_[A-Za-z0-9_]*= ]]; then
      echo "FATAL: RIG_ENV_OVERRIDE entry '$kv' holds a second ORWELL_<NAME>= inside its value (separate entries with spaces, not commas); not staging" >&2; return 1
    fi
  done
}
# Validates, then exports each entry in the current shell.
rig_apply_env_override() {
  local kv; local -a kvs=()
  rig_validate_env_override "$1" || return 1
  read -ra kvs <<<"$1"
  for kv in ${kvs[@]+"${kvs[@]}"}; do export "$kv"; done
}
