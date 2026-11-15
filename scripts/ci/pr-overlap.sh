#!/usr/bin/env bash
# pr-overlap.sh: list files changed by more than one open PR (ORW-415). Read-only.
usage() { cat <<'USAGE'
Usage: scripts/ci/pr-overlap.sh [--pr N] [--repo OWNER/REPO]

Lists every file that is changed by more than one open PR, with the PR numbers and branches. With --pr N, only the overlaps that
involve PR N. Run it before dispatching work (to see which files are already being edited) and before pushing (a later PR on the
same function loses a rebase round). Drafts are included. Exit code 0 always when it ran; 1 if the GitHub calls failed.
USAGE
}
set -u
R=Psychout-Media/orwell; only=""
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) usage; exit 0 ;;
    --pr) shift; only=${1:-} ;;
    --repo) shift; R=${1:-} ;;
    *) echo "unknown argument $1" >&2; usage >&2; exit 64 ;;
  esac; shift
done
if [ -n "$only" ]; then case $only in *[!0-9]*) echo "--pr needs a number" >&2; exit 64 ;; esac; fi
# Paginated (a fixed --limit silently dropped every PR past it); one object per PR, slurped into an array.
prs=$(gh api --paginate "repos/$R/pulls?state=open&per_page=100" --jq '.[]|{number,headRefName:.head.ref,isDraft:.draft}' | jq -s .) || { echo "listing open PRs failed" >&2; exit 1; }
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
while IFS=$'\t' read -r n br dr; do
  [ -z "$n" ] && continue
  files=$(gh api --paginate "repos/$R/pulls/$n/files?per_page=100" --jq '.[]|.filename, (.previous_filename // empty)' 2>/dev/null) || { echo "listing files of PR $n failed" >&2; exit 1; }
  while IFS= read -r f; do [ -n "$f" ] && printf '%s\t%s\t%s%s\n' "$f" "$n" "$br" "$([ "$dr" = true ] && echo ' (draft)')" >>"$tmp"; done <<<"$files"
done < <(jq -r '.[]|"\(.number)\t\(.headRefName)\t\(.isDraft)"' <<<"$prs")
python3 -I - "$tmp" "$only" "$(jq length <<<"$prs")" <<'PY'
import sys, collections
path, only, total = sys.argv[1], sys.argv[2], sys.argv[3]
by_file = collections.defaultdict(list)
for line in open(path, encoding="utf-8"):
    f, n, br = line.rstrip("\n").split("\t")
    by_file[f].append((int(n), br))
rows = [(f, sorted(p)) for f, p in sorted(by_file.items()) if len(p) > 1 and (not only or int(only) in [n for n, _ in p])]
scope = f"involving PR #{only}" if only else "among all open PRs"
print(f"{len(rows)} file(s) changed by more than one open PR, {scope} ({total} open PRs scanned)")
for f, p in rows:
    print(f"\n{f}")
    for n, br in p:
        print(f"  #{n}  {br}")
PY
