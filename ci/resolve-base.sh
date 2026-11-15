#!/usr/bin/env bash
# ORW-218: which commit does the `changes` job diff against? Picked PER EVENT, never from a field that is empty for that event:
#   pull_request -> the PR's base sha (github.event.pull_request.base.sha)
#   merge_group  -> github.event.merge_group.base_sha  (a merge-queue run has NO pull_request payload; using the PR field there made the base empty)
#   push         -> github.event.before (the previous tip of the branch, so a push carrying several commits diffs all of them);
#                   a new branch (all-zero `before`) diffs its tip commit against HEAD~1
# NEVER UNDER-DIFF: a base that is missing, or that cannot be found even after a fetch, yields the EMPTY TREE, so every tracked file counts
# as changed and every lane runs. (Falling back to HEAD would give an empty diff, i.e. every lane skipped and a green gate.)
# Inputs (env): EVENT_NAME PR_BASE MG_BASE PUSH_BEFORE. Prints one object name on stdout, never an empty string. Tested in tests/unit/ciResolveBase.test.ts.
set -euo pipefail
ZERO=0000000000000000000000000000000000000000
EMPTY_TREE="$(git hash-object -t tree /dev/null)"
known() { [ -n "${1:-}" ] && [ "$1" != "$ZERO" ] && git cat-file -e "$1^{commit}" 2>/dev/null; }
base=""
case "${EVENT_NAME:-}" in
  pull_request) base="${PR_BASE:-}" ;;
  merge_group)  base="${MG_BASE:-}" ;;
  push)         base="${PUSH_BEFORE:-}" ;;
esac
if [ "${EVENT_NAME:-}" = "push" ] && [ "$base" = "$ZERO" ]; then
  # A new branch: its tip commit against its parent; a root commit has no parent, so everything is new.
  git rev-parse --verify -q 'HEAD~1^{commit}' || echo "$EMPTY_TREE"
  exit 0
fi
if [ -n "$base" ] && [ "$base" != "$ZERO" ] && ! known "$base"; then
  git fetch --no-tags --depth=1 origin "$base" >/dev/null 2>&1 || true
fi
if known "$base"; then echo "$base"; else echo "$EMPTY_TREE"; fi
