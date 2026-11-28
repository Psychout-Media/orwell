# shellcheck shell=bash
#
# orwell - the DEPLOY HOLD check (sourced, NOT executed). ORW-1145.
#
# A dev live check needs the box to stand still: an auto-deploy that restarts both services mid-run ends the check (11-26: two restarts in 90 minutes).
# The live-check script writes ${APP_DIR}/data/.deploy-hold holding `until=<epoch>` (and `reason=<text>`); while that time is in the future an
# ordinary update run exits 0 without touching anything, and the next update after the hold ends deploys the tip as usual.
# NEVER STUCK, by construction: a hold is honoured for at most ORWELL_DEPLOY_HOLD_MAX_MINUTES (default 240, clamped 1..1440) counted from the
# file's own mtime, whatever `until` says, and only a regular, non-symlink file is read. --ignore-hold (or ORWELL_UPDATE_IGNORE_HOLD=1),
# --rollback and --set-token skip it.
#
# update_deploy_hold_active <hold file>: prints the effective end of the hold (UTC ISO time) and returns 0 while the hold is active; returns 1 otherwise.
update_deploy_hold_active() {
  local f="$1" until_ mtime max now cap
  [[ -f "$f" && ! -L "$f" && -r "$f" ]] || return 1
  until_="$({ timeout 5 sed -n 's/^until=//p' "$f" 2>/dev/null || true; } | tail -1 | tr -d "\"' \r")"
  [[ "$until_" =~ ^[0-9]{1,12}$ ]] || return 1
  until_=$((10#$until_))
  mtime="$(stat -c %Y "$f" 2>/dev/null)" || return 1
  [[ "$mtime" =~ ^[0-9]+$ ]] || return 1
  max="${ORWELL_DEPLOY_HOLD_MAX_MINUTES:-240}"
  [[ "$max" =~ ^[0-9]{1,4}$ ]] || max=240
  max=$((10#$max)); (( max >= 1 && max <= 1440 )) || max=240
  cap=$((mtime + max * 60))
  (( until_ > cap )) && until_=$cap
  now="$(date +%s)"
  (( now < until_ )) || return 1
  date -u -d "@${until_}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf '%s' "$until_"
  return 0
}
