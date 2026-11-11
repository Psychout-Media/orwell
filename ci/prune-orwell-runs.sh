#!/usr/bin/env bash
# ORW-134: prune stale run directories under /srv/orwell-runs on a runner. DRY RUN BY DEFAULT: it only LISTS what it would remove (path, real size, age, reason).
# Nothing is deleted unless BOTH --apply and ORWELL_PRUNE_CONFIRM=yes-ryne-approved are given (Ryne's yes is required on the card first). Kill switch: touch /srv/orwell-runs/.prune-disabled.
#
# Selection: a run dir is a CANDIDATE when it is not in the newest KEEP_NEWEST (default 40) by mtime, has not been modified for MIN_AGE_HOURS (default 48), is not the lone dir of a live
# job (no process has it as its cwd or an open file: lsof +D is too slow, so /proc/*/cwd is checked), and has no .keep file. Everything in a run dir is rebuilt from git + npm ci.
set -uo pipefail
ROOT="${ORWELL_RUNS_ROOT:-/srv/orwell-runs}"
KEEP_NEWEST="${ORWELL_PRUNE_KEEP_NEWEST:-40}"
MIN_AGE_HOURS="${ORWELL_PRUNE_MIN_AGE_HOURS:-48}"
APPLY=0
for a in "$@"; do [[ "$a" == "--apply" ]] && APPLY=1; done

[[ -d "$ROOT" ]] || { echo "no such directory: $ROOT" >&2; exit 2; }
[[ -e "$ROOT/.prune-disabled" ]] && { echo "kill switch present ($ROOT/.prune-disabled): doing nothing"; exit 0; }
if [[ $APPLY -eq 1 && "${ORWELL_PRUNE_CONFIRM:-}" != "yes-ryne-approved" ]]; then
  echo "refusing --apply without ORWELL_PRUNE_CONFIRM=yes-ryne-approved (the dry-run digest must be on the card and approved first)" >&2; exit 3
fi

now=$(date +%s)
min_age=$(( MIN_AGE_HOURS * 3600 ))
# directories only, newest first
mapfile -t dirs < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | awk '{ $1=""; sub(/^ /,""); print }')

# working directories of live processes
declare -A busy
for p in /proc/[0-9]*; do
  c="$(readlink "$p/cwd" 2>/dev/null)" || continue
  [[ "$c" == "$ROOT"/* ]] || continue
  rest="${c#"$ROOT"/}"; busy["$ROOT/${rest%%/*}"]=1
done

printf '%-8s %-10s %-9s %s\n' ACTION SIZE AGE_H PATH
total_kb=0; n=0; idx=0
for d in "${dirs[@]}"; do
  idx=$((idx+1))
  m=$(stat -c %Y "$d" 2>/dev/null || echo "$now"); age_h=$(( (now - m) / 3600 ))
  reason=""
  if   [[ $idx -le $KEEP_NEWEST ]]; then reason="keep-newest"
  elif [[ -e "$d/.keep" ]];         then reason="keep-file"
  elif [[ -n "${busy[$d]:-}" ]];    then reason="in-use"
  elif [[ $(( now - m )) -lt $min_age ]]; then reason="too-recent"
  fi
  if [[ -n "$reason" ]]; then continue; fi
  kb=$(du -sk "$d" 2>/dev/null | awk '{print $1}'); kb=${kb:-0}
  total_kb=$(( total_kb + kb )); n=$((n+1))
  printf '%-8s %-10s %-9s %s\n' "$([[ $APPLY -eq 1 ]] && echo DELETE || echo would-rm)" "$(( kb / 1024 ))M" "$age_h" "$d"
  if [[ $APPLY -eq 1 ]]; then rm -rf --one-file-system -- "$d"; fi
done
echo "candidates: $n  (du counts hardlinked node_modules per dir, so the real freed space is lower than ~$(( total_kb / 1024 )) MB)"
echo "root: $ROOT  keep-newest: $KEEP_NEWEST  min-age-hours: $MIN_AGE_HOURS  mode: $([[ $APPLY -eq 1 ]] && echo APPLY || echo DRY-RUN)"
df -h "$ROOT" | tail -1
