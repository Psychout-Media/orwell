# ORW-109: RIG_ENV_OVERRIDE="ORWELL_X=0 ORWELL_Y=1" - flag flips applied AFTER the deploy defaults, so a proof run can stage a known-bad build.
# Sourced by stage2.sh. An entry that is not exactly ORWELL_<NAME>=<value> is an ERROR (returns 1, names it on stderr): a typo must never stage a healthy
# build for the known-bad proof. Exports each good entry in the current shell.
rig_apply_env_override() {
  local kv
  for kv in $1; do
    if [[ "$kv" =~ ^ORWELL_[A-Za-z0-9_]+=.*$ ]]; then export "$kv"
    else echo "FATAL: RIG_ENV_OVERRIDE entry '$kv' is not ORWELL_<NAME>=<value>; not staging a build without the flag you asked for" >&2; return 1; fi
  done
}
