#!/usr/bin/env bash
# watch-pr.sh: watch one PR's CI and react the moment a job fails, not when the 25-minute run ends (ORW-415).
usage() { cat <<'USAGE'
Usage: scripts/ci/watch-pr.sh <pr> [--merge] [--minutes N] [--repo OWNER/REPO] [--run RUN_ID]

Polls the newest CI run for the PR's CURRENT head every 30 s (a run for an older head is never used; of several runs for the
same head the newest wins).

  * Any job that concludes failure: prints the job name, the failing tests and the first error lines from the job log
    (pytest `____ test_x ____` and `E   ` lines, vitest `FAIL`, cucumber `Failures:` block), says whether the same test is
    also failing on main's newest completed run ("also red on main"), and exits 2 at once, without waiting for the run to end.
  * A job cancelled at its time limit, or a failure whose only failing tests are listed in scripts/ci/known-flakes.txt,
    is re-run with `gh run rerun --failed` once the run completes (at most 3 times) and the watch goes on.
  * ci-gate success: exits 0; with --merge it squash-merges with --match-head-commit first (never done unless asked).

--run RUN_ID  read-only replay of one named run (any head): reports like a normal watch but never re-runs and never merges.

Exit codes: 0 ci-gate green (or already merged / merged now), 2 real failure, 3 merge conflict, 4 deadline (--minutes, default 120),
            5 PR closed, or draft finished (ci-gate fails closed for a draft), 64 bad arguments.
The known-flake list: one test id per line, `#` comments; a bare test name matches the full node id. Quarantine a flake the day it is seen (docs/CI.md).
USAGE
}
set -u
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PARSE="python3 -I $HERE/ci_logparse.py"
FLAKES="$HERE/known-flakes.txt"
R=Psychout-Media/orwell; pr=""; merge=0; mins=120; only_run=""
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    --merge) merge=1 ;;
    --minutes) shift; mins=${1:-}; ;;
    --repo) shift; R=${1:-} ;;
    --run) shift; only_run=${1:-} ;;
    -*) echo "unknown option $1" >&2; usage >&2; exit 64 ;;
    *) pr=$1 ;;
  esac; shift
done
case $pr in ''|*[!0-9]*) echo "need a PR number" >&2; usage >&2; exit 64 ;; esac
case $mins in ''|*[!0-9]*) echo "--minutes needs a number" >&2; exit 64 ;; esac
POLL=${WATCH_PR_POLL:-30}
deadline=$(( $(date +%s) + mins*60 )); reruns=0; floor_attempt=0
declare -A seen=()      # job ids already analysed
declare -A flakejobs=() # job name -> 1: failures that are known flakes
declare -A superseded=() # run ids cancelled by a newer run of the same ref
declare -A unknown=()
declare -A cancelled=() # job name -> 1: cancelled / timed out
names() { local k; for k in "$@"; do printf "%s; " "$k"; done; }
now() { TZ=America/Phoenix date +%H:%M:%S; }
say() { echo "$(now) $*"; }
log_of() { gh api "repos/$R/actions/jobs/$1/logs" 2>/dev/null; }

# $1 = failing test names (newline separated), $2 = job name -> prints where else it is red
main_check() {
  local tests=$1 jname=$2 mrun mconc mjobid mlog hits=""
  mrun=$(gh run list -R "$R" --branch main --workflow CI --status completed --limit 20 --json databaseId,conclusion,createdAt \
        --jq '[.[]|select(.conclusion=="success" or .conclusion=="failure")]|sort_by(.createdAt)|last|"\(.databaseId) \(.conclusion)"' 2>/dev/null)
  [ -z "$mrun" ] || [ "$mrun" = "null null" ] && { echo "main check: no completed run of main found"; return; }
  mconc=${mrun#* }; mrun=${mrun% *}
  # every failed job of main's run, not only the one with the same name: shards are rebalanced between commits
  mlog=""
  while IFS= read -r mjobid; do
    [ -n "$mjobid" ] && mlog="$mlog"$'\n'"$(log_of "$mjobid" | $PARSE failures | jq -r '.tests[]')"
  done < <(gh run view "$mrun" -R "$R" --json jobs --jq '.jobs[]|select(.conclusion=="failure" and .name!="ci-gate")|.databaseId' 2>/dev/null)
  if [ -z "${mlog//[$'\n ']/}" ]; then
    echo "main check: no failing test found on main's newest completed run $mrun ($mconc): this failure is the PR's own (https://github.com/$R/actions/runs/$mrun)"; return
  fi
  while IFS= read -r t; do [ -n "$t" ] && grep -qxF -- "$t" <<<"$mlog" && hits="$hits $t"; done <<<"$tests"
  if [ -n "$hits" ]; then echo "ALSO RED ON MAIN (run $mrun):$hits  -> not this PR's fault; https://github.com/$R/actions/runs/$mrun"
  else echo "main check: main's newest completed run $mrun ($mconc) has other failing tests, not these: this failure is the PR's own"; fi
}

report_failure() { # $1 job id, $2 job name, $3 parsed json, $4 run id
  local tests errs
  tests=$(jq -r '.tests[]' <<<"$3"); errs=$(jq -r '.errors[]' <<<"$3")
  say "FAILED job: $2   (run $4, https://github.com/$R/actions/runs/$4/job/$1)"
  if [ -n "$tests" ]; then echo "failing tests:"; sed 's/^/  - /' <<<"$tests"; else echo "failing tests: none found in the log (a build or setup step failed)"; fi
  [ -n "$errs" ] && { echo "first error lines:"; sed 's/^/  | /' <<<"$errs"; }
  [ -n "$tests" ] && main_check "$tests" "$2"
}

while :; do
  j=$(gh pr view "$pr" -R "$R" --json state,isDraft,mergeable,headRefOid,headRefName 2>/dev/null) || { sleep "$POLL"; continue; }
  st=$(jq -r .state <<<"$j"); dr=$(jq -r .isDraft <<<"$j"); mg=$(jq -r .mergeable <<<"$j")
  head=$(jq -r .headRefOid <<<"$j"); br=$(jq -r .headRefName <<<"$j")
  [ "$st" = "MERGED" ] && { say "PR #$pr already merged"; exit 0; }
  [ "$st" = "CLOSED" ] && { say "PR #$pr is closed"; exit 5; }
  [ -z "$only_run" ] && [ "$mg" = "CONFLICTING" ] && { say "PR #$pr has a MERGE CONFLICT with main at head ${head:0:10}: rebase it"; exit 3; }
  if [ -n "$only_run" ]; then run="{\"databaseId\":$only_run}"; merge=0; reruns=3
  else run=$(gh run list -R "$R" --branch "$br" --workflow CI --limit 30 --json databaseId,status,headSha,createdAt \
        --jq "[.[]|select(.headSha==\"$head\")]|sort_by(.createdAt)|last // empty" 2>/dev/null); fi
  rid=$(jq -r '.databaseId // empty' <<<"${run:-null}")
  if [ -n "$rid" ]; then
    rj=$(gh run view "$rid" -R "$R" --json status,attempt,jobs 2>/dev/null) || { sleep "$POLL"; continue; }
    rst=$(jq -r .status <<<"$rj"); att=$(jq -r .attempt <<<"$rj")
    # 1. failed jobs, the moment they conclude
    while IFS=$'\t' read -r jid jname; do
      [ -z "${jid:-}" ] && continue; [ -n "${seen[$jid]:-}" ] && continue; seen[$jid]=1
      parsed=$(log_of "$jid" | $PARSE failures --flakes "$FLAKES")
      [ -z "$parsed" ] && parsed='{"tests":[],"errors":[],"known_flake":false}'
      if [ "$(jq -r .known_flake <<<"$parsed")" = true ]; then
        flakejobs[$jname]=1; say "known flake in $jname: $(jq -r '.tests|join("; ")' <<<"$parsed") (will re-run when the run completes)"
      else report_failure "$jid" "$jname" "$parsed" "$rid"; exit 2; fi
    done < <(jq -r '.jobs[]|select(.conclusion=="failure" and .name!="ci-gate")|"\(.databaseId)\t\(.name)"' <<<"$rj")
    while IFS=$'\t' read -r cid cn; do
      [ -z "${cn:-}" ] && continue; [ -n "${seen[$cid]:-}" ] && continue; seen[$cid]=1
      ann=$(gh api "repos/$R/check-runs/$cid/annotations" --jq '.[].message' 2>/dev/null)
      if grep -q "higher priority waiting request\|Canceling since" <<<"$ann"; then
        superseded[$rid]=1; say "job $cn was cancelled because a newer run of this ref took over (not a time limit, not a failure)"
      elif grep -q "exceeded the maximum execution time" <<<"$ann"; then
        cancelled[$cn]=1; say "job hit its TIME LIMIT: $cn (will re-run when the run completes)"
      else unknown[$cn]=1; fi
    done < <(jq -r '.jobs[]|select((.conclusion=="cancelled" or .conclusion=="timed_out") and .name!="ci-gate")|"\(.databaseId)\t\(.name)"' <<<"$rj")
    for cn in "${!unknown[@]}"; do   # cancelled with no stated reason: a dependent of a superseded job is superseded too
      if [ -n "${superseded[$rid]:-}" ]; then say "job $cn was cancelled along with the superseded jobs"
      else cancelled[$cn]=1; say "job cancelled for an unknown reason: $cn (will re-run when the run completes)"; fi
    done; unknown=()
    # 2. the run is over
    if [ "$rst" = completed ] && [ "$att" -gt "$floor_attempt" ]; then
      if [ -n "${superseded[$rid]:-}" ] && [ "${#flakejobs[@]}" -eq 0 ] && [ "${#cancelled[@]}" -eq 0 ]; then
        say "run $rid was superseded by a newer run of this ref; waiting for it (none yet: a new push or ready_for_review starts one)"
        [ -n "$only_run" ] && exit 2
        [ "$(date +%s)" -ge "$deadline" ] && { say "DEADLINE ${mins} min: PR #$pr head ${head:0:10}, only superseded runs"; exit 4; }
        sleep "$POLL"; continue
      fi
      gate=$(jq -r '[.jobs[]|select(.name=="ci-gate")|.conclusion]|first // "none"' <<<"$rj")
      if [ "$gate" = success ]; then
        if [ "$dr" = true ]; then say "ci-gate is green but PR #$pr is a draft (reruns $reruns)"; exit 5; fi
        if [ "$merge" = 1 ]; then
          if out=$(gh pr merge "$pr" -R "$R" --squash --match-head-commit "$head" 2>&1); then say "MERGED PR #$pr (head ${head:0:10}, run $rid, reruns $reruns)"; exit 0
          else say "MERGE FAILED PR #$pr: $out"; exit 2; fi
        fi
        say "ci-gate GREEN for PR #$pr (head ${head:0:10}, run $rid, reruns $reruns)"; exit 0
      fi
      if [ "${#flakejobs[@]}" -gt 0 ] || [ "${#cancelled[@]}" -gt 0 ]; then
        if [ "$reruns" -lt 3 ]; then
          reruns=$((reruns+1)); gh run rerun "$rid" -R "$R" --failed >/dev/null 2>&1
          say "re-run $reruns of 3 of run $rid (flakes: $(names "${!flakejobs[@]}")cancelled: $(names "${!cancelled[@]}"))"
          floor_attempt=$att; flakejobs=(); cancelled=(); sleep "$POLL"; continue
        fi
        say "no re-run (limit 3 reached, or --run replay) for run $rid; red or cancelled: $(names "${!flakejobs[@]}" "${!cancelled[@]}")"; exit 2
      fi
      [ "$dr" = true ] && { say "draft PR #$pr: run $rid finished, ci-gate=$gate (a draft cannot pass ci-gate)"; exit 5; }
      say "run $rid finished with ci-gate=$gate and no failed job found: https://github.com/$R/actions/runs/$rid"; exit 2
    fi
    say "run $rid attempt $att $rst; $(jq -r '[.jobs[]|select(.status=="completed")]|length' <<<"$rj")/$(jq -r '.jobs|length' <<<"$rj") jobs done, none failed"
  else say "no CI run for head ${head:0:10} yet"; fi
  [ "$(date +%s)" -ge "$deadline" ] && { say "DEADLINE ${mins} min: PR #$pr head ${head:0:10}, reruns $reruns"; exit 4; }
  sleep "$POLL"
done
