#!/usr/bin/env bash
# ORW-1044: the ONE place that maps a pull request's changed paths to the CI lanes it can affect (pure: no git, no network, no GITHUB_OUTPUT).
#   stdin : the changed paths, one per line (the `changes` job's `git diff --name-only`; an EMPTY list counts as every file changed)
#   env   : EVENT_NAME   `pull_request` narrows `heavy`/`fe_render`/`deploy` further (ORW-193); every other event (push to main, merge_group) uses the broad sets
#   stdout: `engine=true|false`, `frontend=...`, `fe_render=...`, `deploy=...`, `heavy=...` (the `changes` job appends them to $GITHUB_OUTPUT; `ci-gate` reads them)
# CONSERVATIVE BY CONSTRUCTION: a path that matches no known lane set and is not on the short INERT list (docs, root markdown, LICENSE) is UNKNOWN, and one
# unknown path turns EVERY lane on. So a new top-level directory, a root config file (.dependency-cruiser.cjs, .gitignore ...), `.claude/`, `debug/`, `dev/` and
# `patches/` all run everything until someone proves them inert and adds them here. A skip therefore always means "the mapping proved this lane cannot be affected".
# Proven by tests/unit/ciLanes.test.ts (a table of changed-path sets -> lanes) and tests/unit/ciPathFilter.test.ts (big lists, empty diff).
set -euo pipefail
changed="$(cat)"
if [ -z "$changed" ]; then
  # NEVER UNDER-TEST: an empty diff must not skip every lane and go green.
  changed="$(git ls-files)"
fi
EVENT_NAME="${EVENT_NAME:-}"

# `ci/` (the scripts this workflow runs, e.g. ci/resolve-base.sh) counts like this workflow file in EVERY filter: a change to them must run
# everything (ORW-218 review), never skip every lane. So do the shared composite actions in `.github/actions/`: they are steps of every job
# that uses them (setup-fe-python runs in engine, deploy and FE jobs), so a change to ONLY an action still runs each of those jobs (ORW-229).
# ENGINE: TS sources, all tests, BDD step code (features/) AND the Gherkin itself — the .feature
# files live under docs/features/, so a scenario-only edit must still run the BDD gate (BDD PAT-6),
# the build/test config, this workflow. (Deliberately matches EVERY .feature, including spec-only ones
# cucumber.cjs does not execute: cheap insurance, and a later wiring into cucumber.cjs can't slip through.)
ENGINE_RE='^(src/|tests/|features/|docs/features/.*\.feature$|package\.json$|package-lock\.json$|tsconfig.*\.json$|vitest\.(config|shard\.config|sequencer)\.ts$|cucumber\.cjs$|\.github/workflows/|ci/|\.github/actions/|frontend/|deploy/|scripts/(probes/|ci/|[^/]+$)|docs/(FLAG-INVENTORY\.md$|design/undercall-seam-structural\.md$|features/.*\.md$))'
# FRONTEND: the vendored Python app + this workflow.
FRONTEND_RE='^(frontend/|\.github/workflows/ci\.yml$|ci/)'
FE_READS_ENGINE_RE='^src/(surfaces/tools/|ports/|adapters/mcp/|adapters/engine/GameSessionAdapter\.ts$|engine/(momentPrompts|voice|liveSeason|beatAnnouncement|characterFactory|genesisConstants|portraitPrompts|promiseTerms|spokenClaims|socialRoles)\.ts$|engine/castGenesis|engine/data/vocations\.ts$|domain/(house|styleFamilies|traitConsistency)\.ts$|domain/(castRealism|castAges)\.json$|composition/runtime\.ts$)|^src/main\.ts$'
# ORW-416 (root cause of the #2681 main break): front-end tests also READ repo files outside frontend/ and src/ (deploy scripts, systemd units, ci/ and harness
# scripts, a few design docs and fixtures). #2681 changed only deploy/, fe-unit was skipped, and test_orw174 (which reads deploy/orwell-backup.sh) broke every later PR.
# frontend/tests/test_ci_fe_reads_repo_filter.py proves this list covers EVERY such path the front-end tests read.
FE_READS_REPO_RE='^(deploy/|ci/|\.github/workflows/|scripts/(live-run|rehearsal-kit)/|scripts/ci(/|$)|tests/unit/beatsTerminateThemselves\.test\.ts$|tests/fixtures/orw480_(cast_s3_text|tag_cases|style_fit_cases)\.json$|tests/fixtures/orw563_dealt_lives\.json$|tests/fixtures/orw1008/corpus\.txt$|scripts/stage-finale-snapshot\.ts$|docs/audits/playtest-harness/|docs/design/(liquid-glass/|frontend-single-worker-ceiling\.md$)|docs/legacy/meta-feedback/|docs/mocks/)'
# DEPLOY: anything the end-to-end deploy smoke boots — engine, FE, deploy scripts, this workflow.
DEPLOY_RE='^(src/|frontend/|deploy/|\.github/workflows/ci\.yml$|ci/|\.github/actions/)'
# HEAVY (calibration-relevant): the simulation inputs. A subset of engine — a docs/frontend
# change can never move a calibration result, so the heavy lane skips for those. `deploy/orwell-env-defaults.sh` is in the set
# because it still writes the gameplay flags to a box's .env (an `=0` there overrides the code default), so a change to it re-plays the game.
HEAVY_RE='^(src/|tests/|package\.json$|package-lock\.json$|vitest\.config\.ts$|cucumber\.cjs$|deploy/orwell-env-defaults\.sh$|\.github/workflows/ci\.yml$|ci/|\.github/actions/)'
# ORW-193 PRECISION (pull requests ONLY; a push to main always uses the broad sets above, so main never loses coverage):
#   - `heavy`: the heavy sims import only src/ plus their own tests/{uat,property,calibration} files and the tests/support
#     setup files, so an edit under tests/{unit,integration,architecture,dev} cannot move a calibration result.
#   - `fe_render` / `deploy`: edits to ONLY front-end tests or markdown (frontend/tests/** except the vendored axe-core,
#     frontend/**/*.md) cannot change what the render lanes (fe-browser, fe-responsive, mirror-parity, a11y-matrix) and the
#     deploy smoke boot. The pytest lanes (fe-unit, fe-browser-tests) still run for any frontend/ change.
fe_changed="$changed"
if [ "${EVENT_NAME:-}" = "pull_request" ]; then
  HEAVY_RE='^(src/|tests/(uat|property|calibration|support)/|package\.json$|package-lock\.json$|vitest\.config\.ts$|cucumber\.cjs$|deploy/orwell-env-defaults\.sh$|\.github/workflows/ci\.yml$|ci/|\.github/actions/)'
  fe_changed="$(echo "$changed" | grep -vE '^frontend/(tests/|.*\.md$)' || true; echo "$changed" | grep -E '^frontend/tests/vendor/' || true)"
  DEPLOY_RE='^(src/|frontend/|deploy/|\.github/workflows/ci\.yml$|ci/|\.github/actions/)'
fi
FRONTEND_RE="$FRONTEND_RE|^\.github/actions/"
# scripts/live-run/ and scripts/rehearsal-kit/ are read only by the front-end tests (FE_READS_REPO_RE); no engine test, step or config names them (grep of tests/, features/, src/, ci/, configs), so they run the front-end lanes, not the engine ones.
# INERT: files no lane reads. (docs/ files that tests DO read are in ENGINE_RE above; the front end's reads are in FE_READS_REPO_RE.)
INERT_RE='^(docs/|[^/]+\.md$|LICENSE$)'
KNOWN_RE="$ENGINE_RE|$FRONTEND_RE|$FE_READS_ENGINE_RE|$FE_READS_REPO_RE|$DEPLOY_RE|$HEAVY_RE|$INERT_RE"
unknown=0
if grep -qvE "$KNOWN_RE" <<<"$changed"; then unknown=1; fi
# SHARED: files every lane runs on (a workflow, a composite action, a ci/ script, the npm manifest and lockfile): any one of them runs EVERY lane, the same as an unknown path.
SHARED_RE='^(\.github/|ci/|package\.json$|package-lock\.json$)'
if grep -qE "$SHARED_RE" <<<"$changed"; then unknown=1; fi
# ORW-1044: engine tests and BDD steps read frontend/ widely (src/, static/js, tests/fixtures, the gateway pytest files the 0072/0073 steps run, requirements, INTEGRATION.md), and it is
# too wide to prove path by path, so ALL of frontend/ is engine-affecting (the engine lane also gates `bdd`, `test-unit`, `coverage`) EXCEPT the dirs and files nothing in tests/, features/, src/ or ci/ names:
# frontend/integrations/, frontend/companion/, frontend/ACKNOWLEDGMENTS.md, frontend/README.md.
engine_changed="$(grep -vE '^frontend/(integrations/|companion/|ACKNOWLEDGMENTS\.md$|README\.md$)' <<<"$changed" || true)"
for name in engine frontend fe_render deploy heavy; do
  subject="$changed"
  case "$name" in
    engine)    re="$ENGINE_RE"; subject="$engine_changed" ;;
    # ORW-218 (root cause of the #2457 main break): front-end tests READ engine source (the tool registry, the GameSession port, the MCP server, the prompt text...), so an
    # engine-only PR that changes one of those files must still run fe-unit; before this, FRONTEND_RE matched only frontend/ and test_1412/1414 were skipped while ci-gate passed.
    # frontend/tests/test_ci_fe_reads_engine_filter.py proves this list covers EVERY engine .ts file the front-end tests read.
    frontend)  re="$FRONTEND_RE|$FE_READS_ENGINE_RE|$FE_READS_REPO_RE" ;;
    # ORW-218: the F5 mirror-parity gate script lives under docs/audits/playtest-harness/, outside frontend/, so a change to ONLY the gate used to skip every render lane.
    fe_render) re="$FRONTEND_RE|^docs/audits/playtest-harness/"; subject="$fe_changed" ;;
    deploy)    re="$DEPLOY_RE"; subject="$fe_changed" ;;
    heavy)     re="$HEAVY_RE" ;;
  esac
  if [ "$unknown" = 1 ] || grep -qE "$re" <<<"$subject"; then
    echo "${name}=true"
  else
    echo "${name}=false"
  fi
done
