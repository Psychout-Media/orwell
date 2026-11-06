#!/usr/bin/env bash
# ORW-218: which commit does the `changes` job diff against? Picked PER EVENT, never from a field that is empty for that event:
#   pull_request -> the PR's base sha (github.event.pull_request.base.sha)
#   merge_group  -> github.event.merge_group.base_sha  (a merge-queue run has NO pull_request payload; using the PR field there made the base empty)
#   push         -> github.event.before (the previous tip of the branch), falling back to HEAD~1 for a new branch (all-zero `before`) or an unknown sha
# Inputs (env): EVENT_NAME PR_BASE MG_BASE PUSH_BEFORE. Prints the sha on stdout; never prints an empty string.
set -euo pipefail
ZERO=0000000000000000000000000000000000000000
known() { [ -n "${1:-}" ] && [ "$1" != "$ZERO" ] && git cat-file -e "$1^{commit}" 2>/dev/null; }
base=""
case "${EVENT_NAME:-}" in
  pull_request) base="${PR_BASE:-}" ;;
  merge_group)  base="${MG_BASE:-}" ;;
  push)         base="${PUSH_BEFORE:-}" ;;
esac
if [ -n "$base" ] && [ "$base" != "$ZERO" ] && ! known "$base"; then git fetch --no-tags --depth=1 origin "$base" >/dev/null 2>&1 || true; fi
if ! known "$base"; then base="$(git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)"; fi
echo "$base"
