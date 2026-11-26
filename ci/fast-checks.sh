#!/usr/bin/env bash
# ORW-413: the FAST checks, one command (`npm run ci:fast`). CI runs exactly this in the `fast-checks` job, which nothing waits for and which is
# meant to finish in about a minute, so a typecheck error, a pinned-source guard or a leaked word is red long before the slow lanes finish.
# Run it before you push: every failure it can report would otherwise cost a full CI round.
#
# What is in it (all pure source checks, no browser, no game simulation). The guard tests and word scans (2 to 4) also run again in their full lanes; the typecheck (1), the
# py_compile and the ES-module syntax check (5) were MOVED here from the slower lanes and run only here (`ci-gate` requires this job):
#   0. no internal address / host name / real /home path in a tracked file (ORW-426: the repository is public); every workflow and composite-action file parses as YAML (ORW-413: a colon in a step name made ci.yml unparseable and the PR got no checks)
#   1. typecheck (tsc --noEmit)
#   2. the engine guard tests: the CI wiring pins (gate logic, path filter, shard tables, flaky rule), the Vault-Wall dependency test, the
#      BDD word-scan helpers, the player-projection ratchet and the real-path guard (ORW-758 A5: nothing in tests/realpath/ writes hidden state)
#   3. the front-end guard tests (pytest): the F-3 window ratchet, no-new-bespoke-menu, the orphan-chrome ratchet, the shard/quarantine/skip guards,
#      the CI filter test that proves the FE-reads-engine list is complete
#   4. the Vault word scans that fail on a public string: the 0110 vote-deduction and 0023 consequence features under cucumber (the
#      "no surface shows a confidence ..." and "the opinion change is invisible" scans)
#   2b. the short-list guard (ORW-511, ci/check_short_lists.py) and its planted-failure test (frontend/tests/test_short_list_guard.py, in step 3)
#   5. py_compile of the whole front end and a module-syntax check of every static/js file
# Skips a part with a notice (never silently) when its tool is missing, so a laptop without the Python venv still gets the rest.
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
step() { echo; echo "==> $*"; }
run() { "$@" || { echo "::error::ci:fast step failed: $*"; fail=1; }; }

PY="$PWD/frontend/.venv/bin/python"
[ -x "$PY" ] || PY="python3"

step "workflow and action files parse as YAML (a workflow that does not parse runs NO job, so the PR shows no checks at all)"
run node -e '
const Y = require("yaml"); const fs = require("fs"); let bad = 0;
for (const f of process.argv.slice(1)) { try { Y.parse(fs.readFileSync(f, "utf8"), { strict: true }); if (Y.parseDocument(fs.readFileSync(f, "utf8")).errors.length) throw new Error("yaml errors"); } catch (e) { console.error("::error file=" + f + "::" + String(e.message).split("\n")[0]); bad = 1; } }
process.exit(bad);' $(git ls-files '.github/workflows/*.yml' '.github/actions/*/action.yml')

step "no internal address, host name or real user's home path in a tracked file (the repository is public, ORW-426)"
run python3 ci/check_no_internal_details.py

step "short-list guard (ORW-511: no new short dealt list, no new example line or closed menu in prompt text, unless allowlisted with a reason)"
run python3 ci/check_short_lists.py

step "every pinned front-end dependency installs on the Python production runs (ORW-955, ci/prod_python_version)"
run python3 ci/check_lock_prod_python.py

step "typecheck"
run npx tsc --noEmit

step "engine guard tests (vitest)"
run npx vitest run \
  tests/unit/ciGateLogic.test.ts tests/unit/ciPathFilter.test.ts tests/unit/ciReshardWiring.test.ts tests/unit/ciFlakyRuleWiring.test.ts \
  tests/unit/ciResolveBase.test.ts tests/unit/ciShardAssignment.test.ts tests/unit/ciQuarantineGuard.test.ts tests/unit/ciBddShard.test.ts \
  tests/unit/bddRelationshipLeakChecks.test.ts tests/unit/bddStandaloneModuleAllowlist.test.ts tests/unit/playerProjectionRatchet.test.ts \
  tests/unit/knowledgeWall.test.ts tests/unit/backlogWhole.test.ts tests/unit/realPathGuard.test.ts tests/architecture

step "front-end guard tests (pytest)"
if "$PY" -c "import pytest" 2>/dev/null; then
  (cd frontend && "$PY" -m pytest -q -p no:cacheprovider \
    tests/test_f3_window_ratchet.py tests/test_no_new_bespoke_menu.py tests/test_1454_orphan_chrome_ratchet.py tests/test_737_surface_registry.py \
    tests/test_ci_shard.py tests/test_ci_quarantine_guard.py tests/test_ci_fe_reads_engine_filter.py tests/test_ci_fe_coverage_check.py \
    tests/test_ci_flaky_report.py tests/test_ci_runner_image_pinned.py tests/test_a41_skip_guard.py tests/test_short_list_guard.py) || { echo "::error::ci:fast step failed: front-end guard tests"; fail=1; }
else
  echo "::warning::pytest not importable by $PY: front-end guard tests SKIPPED here (CI runs them)"
fi

step "Vault word scans (cucumber, the features whose Then-steps fail on a public string)"
run env NODE_OPTIONS='--import tsx' ORWELL_BDD_FEATURES=$'docs/features/0110-vote-deduction.feature\ndocs/features/0023-consequence-and-memory.feature' npx cucumber-js

step "py_compile the front end"
# shellcheck disable=SC2046
run python3 -m py_compile $(git ls-files 'frontend/*.py' 'frontend/**/*.py')
for s in $(git ls-files 'frontend/scripts/*' 'frontend/integrations/**'); do
  # ORW-239: only a non-python shebang is skipped; a real compile error fails the step.
  if head -1 "$s" | grep -q python; then run python3 -m py_compile "$s"; fi
done

step "syntax-check every front-end script as an ES module"
# They are loaded as modules; a stray `*/` in a comment (chatReconcile.js, #1785) blanked the send path. Copy to .mjs so node parses module syntax.
tmp="$(mktemp -d)"
for f in $(git ls-files 'frontend/static/js/*.js'); do
  cp "$f" "$tmp/check.mjs"
  node --check "$tmp/check.mjs" 2>"$tmp/err" || { echo "::error file=$f::$(head -5 "$tmp/err" | tr '\n' ' ')"; fail=1; }
done
rm -rf "$tmp"

echo
if [ "$fail" -ne 0 ]; then echo "ci:fast: FAIL"; exit 1; fi
echo "ci:fast: PASS"
