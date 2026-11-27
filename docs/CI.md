# CI

How the GitHub checks run lives in `.github/workflows/ci.yml` (the per-job comments explain each lane). This page holds the rules people have to follow.

## One run per PR, and the fast first signal (ORW-413)

**A draft PR runs the full suite, the same as a ready one.** ORW-218 ran only a fast tier on a draft and the full suite when you marked it ready, so every PR paid two rounds and a draft's `ci-gate` was red by design. Now one run covers the PR: marking a draft ready starts nothing (`ready_for_review` is no longer a trigger), and the run that proved the last commit is the one that counts. `ci-gate` still fails closed: a job that applies to the change and was skipped fails it, and so would any run that was not the full suite.

**`fast-checks` is the first signal.** It finishes in about a minute and the test lanes run in parallel with it and do not wait for it, but `ci-gate` requires its result: typecheck, the source-pinned guard tests (the CI wiring pins, the F-3 window ratchet, no-new-bespoke-menu, the Vault-Wall dependency test, the short-list guard `ci/check_short_lists.py` from ORW-511: it fails on a new short list the code deals from or a new example line / closed menu in prompt text unless `ci/short_list_allowlist.json` has an entry with an owner and a reason), the Vault word scans that fail on a public string (the 0110 vote-deduction and 0023 consequence features), py_compile and the ES-module syntax check of the front end. Run the same set yourself before every push:

```
npm run ci:fast
```

**You never hand-edit a duration table in a feature PR** (`ci/test-durations.json`, `ci/bdd-durations.json`, `frontend/tests/_ci_durations.json`). A new test file or feature with no entry is weighed by the splitter (the median for unit files and features, 15 s per test for a browser file) and reported as a warning. Only the front-end browser-file check labels it (`added by this change` or `by main`) and writes it to the job summary; the unit (`vitest.sequencer.ts`) and BDD (`ciBddShard.test.ts`) checks print a plain `::warning::` line to the log; an entry for a deleted file is ignored. None of these fails a PR. The tables are only balancing hints and are refreshed from main's own run logs by `npm run ci:refresh-durations`, `ci/refresh-test-durations.mjs` and `frontend/tests/_ci_refresh_durations.py` (a scheduled refresh PR is the follow-up, ORW-413 PR 3).

It is `ci/fast-checks.sh`. Not every check in it is repeated in a slower lane: the typecheck, the py_compile of the front end and the ES-module syntax check were moved out of the slower lanes and run only here (the guard tests and word scans also still run in their full lanes). Nothing lost coverage, because the full suite still includes the `fast-checks` job and `ci-gate` requires it.

**Shard counts** (the lane is as long as its longest leg): `test-unit` 10 legs (it collects the coverage too, see below; balanced by `ci/test-durations.json`, refresh it with `npm run ci:refresh-durations` or from `test-unit` logs), `bdd` 3 legs (`ci/bdd-shard.mjs`, balanced by `ci/bdd-durations.json`; each leg prints `[bdd-shard] <feature> <seconds>` for the refresh), `fe-browser-tests` 10 legs (`frontend/tests/_ci_durations.json`). Every test file or feature still runs in exactly one leg; a unit test per table proves it.

## Merge time (ORW-410): why a merge waits twice, and what was and was not changed

A merge waits for the PR run (338 to 556 s measured) and again for the merge-queue run (422 to 570 s).

- **Done: `test-unit` in 10 legs on a refreshed table.** The table was stale (the slowest leg ran 301 s of tests next to 115 s for the fastest), so the leg time was the imbalance. After a refresh from three green PR runs the greedy split is flat, and the unit lane stops being the critical path (the browser legs are).
- **Not done: reusing a PR's proof in the merge queue.** The proof marker is an Actions cache entry, and a cache entry written by a pull request run is readable only by that pull request's own ref (the comment in `ci.yml` at the `changes` job says so). A `merge_group` run executes on `refs/heads/gh-readonly-queue/main/pr-<n>-<sha>`, which cannot restore it, so reuse there would never hit: as built it is inert, not unsafe. Making it work needs a different carrier for the marker (for example a workflow artifact or a check run found through the PR's head sha, with `actions: read`) plus a PR-number lookup from the queue branch name, and the logic can only be exercised by a real queue entry, not by a draft PR. A wrong "reuse" there would merge an untested tree to main, so it is not built on a path nobody can test first. If it is wanted: the marker would carry the tested tree (already does), the queue run would recompute `git rev-parse HEAD^{tree}` and reuse only on equality (a single-entry queue with the PR up to date with main), and any difference runs the full suite as today. (ORW-882)

## Browser lane: two workers per leg (ORW-414), and the ORW-413 parts that were dropped

The `fe-browser-tests` legs run `pytest -m browser -n 2 --dist loadgroup`. ORW-414 (#2714) gave every browser stack a kernel-assigned free port and its own data directory, and its body said the lane "needs `-n 2` in ci.yml (ORW-413)"; ORW-413's two PRs never added it, so the lane stayed serial (found by the live check of 2026-11-15 11:30 MST). `conftest.py` marks every browser file with an `xdist_group` named by the file, so `--dist loadgroup` keeps its tests on one worker and a module-scoped stack boots once per file; the files in `_BROWSER_SPREAD_FILES` (today `test_a58_golden_render_live_vs_reload.py`, about 30 s per independent case, alone the longest leg) carry no group and spread over both workers, each booting its own stack. The A41 skip guard (0 skips) works under xdist (checked locally on three files, 6 passed, 0 skipped).

Dropped from ORW-413, with the reason (the card said to build them or record why not):

- **Build `dist/` once and download it.** Left out on purpose in #2704, and the evidence agrees: in run 43745734739 the build step took 0 to 1 s in the browser legs and 5 to 7 s in the others, about what an artifact upload plus download costs. Nothing to win.
- **Finer path filters (CI-only, portrait-only front end).** A change to `ci/`, `.github/actions/` or `.github/workflows/ci.yml` counts in every filter on purpose (ORW-218 review; the engine and front-end-reads filters take every file under `.github/workflows/`): those files are steps of every job, so a CI-only change can break any lane. A "portrait-only" filter needs a per-file map of which front-end tests read which files; that map is exactly what failed three times (the main breaks of #2457 and #2681, ORW-416), and `test_ci_fe_reads_repo_filter.py` exists to keep the existing coarse lists honest. The docs-only and front-end-tests-only rules that already exist stay.
- **Related-tests selection on PRs and a `full-ci` label.** The merge queue (on since 2026-11-15 10:53 MST) runs every lane that applies to each `merge_group`, with main's broad path filters (not the narrower pull-request ones), so main is never under-tested, but selection would still let a PR go green and then fail in the queue, which costs a full queue round. Measured: the 544 s PR run 43745734739 was set by one browser leg (519 s); the unit legs were shorter in that run (fe-unit 253 s and 241 s; over the last 20 green PR runs the `test-unit` legs took a median of 219 s and at most 361 s), so selecting unit tests would not have shortened that run. The browser lane cannot be selected by changed module (the reads are by file path, see above). With nothing narrowed, a `full-ci` label would have nothing to force. Reopen it only if a measured PR run is again set by a lane that selection can shorten.

## The flaky-test rule (ORW-229)

A flaky test is one that fails and then passes on the same code. Flakes waste everyone's time and teach people to ignore red, so we handle them the same way every time. Kevin approved this rule on 2026-11-06 (Plane ORW-229).

### 1. One automatic retry

When a test fails in CI, it gets one more try:

- engine tests (vitest): `--retry=1` in `test-unit` (which also collects coverage);
- front-end tests (pytest): `--reruns 1` in `fe-unit` and `fe-browser-tests`;
- the mirror-parity gates keep their own attempt loops.

A test that fails twice is red, as before. Two limits keep a retry from hiding a real bug:

- A property test (fast-check) gets **the same random cases on its retry** (`tests/support/fastCheckSeed.ts`), so a real counterexample, such as hidden information reaching a player in one rare season, fails again instead of passing on fresh cases. The failure prints the seed; set `ORWELL_FC_SEED` to that number to replay the run's cases locally.
- The heavy sims (`heavy-sims`) play fixed seeds, so a retry could only hide a failure. They never retry.

### 2. A pass on the retry still counts as a flake

A retry hides a flake, so CI writes every test that only passed on its retry into the job summary (the "Flaky tests" section on the run page) and adds a warning to the PR's checks. A mirror gate that only passes on a later attempt is listed the same way. If you see one, it is a real problem with that test, even though the check is green: fix it, or quarantine it (step 3). The count never fails a build by itself; it is there so flakes get fixed, not forgotten.

### 3. Red on main: quarantine within the hour

If a test fails on main and the failure has nothing to do with the change that triggered it, quarantine the test within the hour:

1. Open a Plane card for the fix.
2. Mark the test with the card and today's date (UTC):
   - pytest: `@pytest.mark.quarantine(card="ORW-123", added="2026-11-06")`
   - vitest: `import { quarantine } from "../support/quarantine";` then `quarantine({ card: "ORW-123", added: "2026-11-06" }).it("name", () => { ... })` (or `.describe` for a whole block).
3. Open the PR with only that change, and link it from the card.

Write the card and the date as plain text, exactly like the examples, because the guard test reads them straight from the file.

### 4. Quarantined tests still run, every night

A quarantined test is left out of PR, merge-queue and main runs, so it can no longer block anyone. It still runs every night in the `ci-nightly` workflow, with no retry, so we can see whether it is still flaky. A failing night opens or updates one GitHub issue labelled `ci-nightly` that names the run and each quarantine's Plane card. (GitHub's machines cannot reach our Plane, so the issue points at the cards.)

To run quarantined tests yourself, set `ORWELL_RUN_QUARANTINED=1`. With pytest, `-m quarantine` selects only those tests.

### 5. Fix it within 7 days

A quarantine is meant to be short. A guard test fails the build when a quarantine has no Plane card, has no date, or is more than 7 days old:

- `frontend/tests/test_ci_quarantine_guard.py` (front end)
- `tests/unit/ciQuarantineGuard.test.ts` (engine)

Each guard runs whenever its lane runs (an engine change runs the engine guard, a front-end change the front-end one) and every night in `ci-nightly`, so an expired quarantine is caught within a day even if nobody touches that code.

When the guard goes red, either fix the test and remove the marker, or delete the test. Do not just move the date. If a fix truly needs longer, explain why on the card; moving the date is then its own reviewed PR.

## PROPOSAL, not yet a rule: quarantine a flake the day it is seen (ORW-415)

This is a PROPOSAL of the ORW-415 coordinator that tightens the ORW-229 rule Kevin approved (ORW-229 let a flake be fixed instead of quarantined, and rule 3 above quarantines only failures that are red on main); it stands once Kevin or Ryne confirms it. Until then, fixing the flake the same day is also acceptable. The proposal: a flake that is seen goes into quarantine that same day, with a Plane card (rule 3 above; the 7-day clock then runs). Do not wait for it to fail a second PR: tonight one flaky test and one job time limit cost six re-runs. `scripts/ci/quarantine-flakes.py` reads the flaky-test lines the lanes already write (tests that passed only on the automatic retry) from the last N completed main runs and prints, per test, in how many runs it flaked. Only a pytest test gets a patch; a vitest test gets manual instructions, and a gate job (a step with its own attempt loop) gets a note that there is nothing to mark, so engine-side flakes are not expected to apply a patch. It changes nothing by itself: open the card, put its number in place of `ORW-NNN`, apply the patch, open the PR.

## CI tools for agents (`scripts/ci/`, ORW-415)

All use the `gh` CLI (logged in) and plain bash or python3; each has `--help`. They only read, except `watch-pr.sh --merge` and the re-runs it starts.

- `scripts/ci/watch-pr.sh <pr> [--merge] [--minutes N]`: polls the newest run for the PR's current head every 30 s and stops at the first failed job instead of the end of the run. It prints the job, the failing tests and the first error lines, and says "ALSO RED ON MAIN" when the same test fails on main's newest completed run (then it is not your PR's fault: do not chase it, and do not stack three PRs on it). A job cancelled at its time limit, or a failure whose only failing tests are listed in `scripts/ci/known-flakes.txt` (one test id per line), is re-run once the run completes, at most 3 times. Exit 0 green (or merged with `--merge`, which uses `--match-head-commit`), 2 real failure, 3 merge conflict, 4 deadline. `--run <id>` replays one finished run read-only.
- `scripts/ci/pr-overlap.sh [--pr N]`: every file changed by more than one open PR, with PR numbers and branches. Overseers run it before dispatching work and before pushing: two PRs on the same function mean the later one loses a round to a rebase.
- `scripts/ci/quarantine-flakes.py [--runs N]`: see the section above.
- `scripts/ci/ci_logparse.py`: the log parsers the first and third use. Their tests: `cd frontend && .venv/bin/python -m pytest tests/test_ci_tools_logparse.py -q`.

## Merge queue: turning it on and off (ORW-415)

Status: ON since 2026-11-15. The `main-required-ci` ruleset (id 18797902) holds two rules, `required_status_checks` with `ci-gate` (integration 15368) and `merge_queue`, no bypass actors; `ci.yml` listens to `merge_group` (`checks_requested`). The steps below are how it was turned on, and how to turn it off again.

### Turn it on

1. Save the current ruleset, so the rollback is exact:
   `gh api repos/Psychout-Media/orwell/rulesets/18797902 > ruleset-18797902.before.json`
2. Build the new body: the existing rule plus a `merge_queue` rule. A ruleset update replaces the whole `rules` array, so the `required_status_checks` rule must be sent again unchanged. Build `ruleset-18797902.after.json` from the saved copy so no live field is lost (the strict policy, `do_not_enforce_on_create` and the check list stay exactly as saved): `jq --argjson mq '{"type":"merge_queue","parameters":{"merge_method":"SQUASH","grouping_strategy":"ALLGREEN","max_entries_to_build":5,"min_entries_to_merge":1,"max_entries_to_merge":5,"min_entries_to_merge_wait_minutes":5,"check_response_timeout_minutes":60}}' '{name, target, enforcement, conditions, bypass_actors, rules: (.rules + [$mq])}' ruleset-18797902.before.json > ruleset-18797902.after.json`. The result is expected to look like this (compare it with your file before step 3):
   ```json
   {
     "name": "main-required-ci",
     "target": "branch",
     "enforcement": "active",
     "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"], "exclude": []}},
     "bypass_actors": [],
     "rules": [
       {"type": "required_status_checks", "parameters": {
         "strict_required_status_checks_policy": false, "do_not_enforce_on_create": false,
         "required_status_checks": [{"context": "ci-gate", "integration_id": 15368}]}},
       {"type": "merge_queue", "parameters": {
         "merge_method": "SQUASH", "grouping_strategy": "ALLGREEN",
         "max_entries_to_build": 5, "min_entries_to_merge": 1, "max_entries_to_merge": 5,
         "min_entries_to_merge_wait_minutes": 5, "check_response_timeout_minutes": 60}}
     ]
   }
   ```
   `check_response_timeout_minutes` must be longer than a full CI run (25 to 80 minutes when runners are busy); raise it if queue entries time out.
3. Apply it: `gh api -X PUT repos/Psychout-Media/orwell/rulesets/18797902 --input ruleset-18797902.after.json`
4. Check: `gh api repos/Psychout-Media/orwell/rulesets/18797902 --jq '.rules[].type'` prints `required_status_checks` and `merge_queue`.
5. Prove it with one low-risk PR: `gh pr merge <n> --squash` must answer that the PR was added to the merge queue, a `merge_group` run of CI must start on the `gh-readonly-queue/main/...` branch, and the PR must merge when `ci-gate` is green there.

If the API refuses the `merge_queue` rule (the plan or the repository type may not allow it), stop: nothing was changed.

### What changes for agents

- `gh pr merge <n> --squash` no longer merges at once: it puts the PR in the queue. GitHub builds a temporary branch of main plus the queued PRs and runs CI on it with main's path filters (the `merge_group` trigger); the PR merges only if `ci-gate` passes there. Do not use `--admin`; the ruleset has no bypass.
- A test that main breaks can no longer reach main through a PR whose own run was green on an old base, because each PR is tested merged with the queue ahead of it (SOUL lesson 5).
- Pushing to a queued PR removes it from the queue; the PR must be queued again. `gh pr merge <n> --squash --match-head-commit <sha>` still guards against a head that moved; check on the first queued PR that the flag is accepted, as the proof step above does.
- Watch with `scripts/ci/watch-pr.sh <pr>`: it follows the PR's own run; once the PR is queued, the queue's run is on `gh-readonly-queue/main/pr-<n>-<sha>` (`gh run list --branch gh-readonly-queue/main/pr-<n>-<sha> --workflow CI`) and `gh pr view <n> --json state` shows MERGED at the end. Dequeue with `gh pr merge <n> --disable-auto` or from the PR page.
- `watch-pr.sh --merge` enqueues instead of merging; its exit code 0 then means "queued", so confirm MERGED with `gh pr view`.

### Turn it off (rollback)

1. Take the saved body from step 1 of "Turn it on" and drop the read-only fields (`id`, `node_id`, `source`, `source_type`, `created_at`, `updated_at`, `current_user_can_bypass`, `_links`): 
   `jq 'del(.id,.node_id,.source,.source_type,.created_at,.updated_at,.current_user_can_bypass,._links)' ruleset-18797902.before.json > ruleset-18797902.rollback.json`
2. `gh api -X PUT repos/Psychout-Media/orwell/rulesets/18797902 --input ruleset-18797902.rollback.json`
3. Check that `gh api repos/Psychout-Media/orwell/rulesets/18797902 --jq '.rules[].type'` prints only `required_status_checks`. PRs still in the queue stay open; merge them with `gh pr merge <n> --squash` as before.

## Repeat work that is gone (ORW-413 PR 2)

- **The unit suite runs once.** Each `test-unit` leg collects v8 coverage in the same run and uploads its blob; the `coverage` job merges the ten blobs and is still the only place the per-directory floors are enforced. The separate `coverage-shard` legs no longer exist.
- **An identical tree is not tested twice.** When `ci-gate` passes on a pull request, `record-proof` saves a marker in the Actions cache keyed by the hash of the tested merged tree (`git rev-parse HEAD^{tree}` of the merge ref) and of `ci.yml`. A later run of the same pull request with the same key (a re-run, or a rebase that changes nothing) skips every job and `ci-gate` passes with a line naming the run that proved the tree. It never passes an untested tree: the marker is written only after a passing run that reused nothing, it is read only on pull requests (main and the merge queue always run everything), and the restored file must match the tree and workflow hash exactly. The cache is scoped to the PR's own ref.
- **Heavy sims are cached by what they read.** A heavy leg that passed leaves a marker keyed by the hash of `src/`, the uat/property/calibration/support tests, the package files, the vitest config and tsconfig; the same hash skips the leg (a tests/unit-only change on main, a re-run). Bump `heavy-proof-v1` in `ci.yml` after changing a leg's script list or `UAT_TIMEOUT_SCALE`.
- **Left on the full suite, on purpose:** related-test selection (`vitest related`, a pytest changed-module map) and finer path filters. The suites read each other's source (the front-end tests read engine `.ts` files, the property tests re-play whole seasons) and a workflow edit can break any lane, so a selection I cannot prove safe stays out; every pull request runs everything.
- **Path -> lane mapping lives in one script (ORW-1044).** `ci/path-lanes.sh` reads the changed paths and prints which lanes apply (`engine`, `frontend`, `fe_render`, `deploy`, `heavy`); the `changes` job only calls it, and `ci-gate` counts a skip as a pass only when that output says the lane does not apply. It is conservative by construction: a path that matches no known set and is not on the short inert list (`docs/`, root `*.md`, `LICENSE`) is UNKNOWN and runs EVERY lane, as does any workflow, composite action, `ci/` script, `package.json` or lockfile. `tests/unit/ciLanes.test.ts` is the table test (changed-path set -> exact lane set); it runs in the unit shards. Tightened in the safe direction: `deploy/` and `scripts/` now run the engine lanes (unit tests read and execute them), and the docs the engine tests read (`docs/FLAG-INVENTORY.md`, `docs/design/undercall-seam-structural.md`, `docs/features/*.md`) run the engine lanes; a dated `docs/audits/` or `docs/decisions/` note still skips everything but `backlog-whole`.
