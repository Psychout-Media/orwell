# CI

How the GitHub checks run lives in `.github/workflows/ci.yml` (the per-job comments explain each lane). This page holds the rules people have to follow.

## One run per PR, and the fast first signal (ORW-413)

**A draft PR runs the full suite, the same as a ready one.** ORW-218 ran only a fast tier on a draft and the full suite when you marked it ready, so every PR paid two rounds and a draft's `ci-gate` was red by design. Now one run covers the PR: marking a draft ready starts nothing (`ready_for_review` is no longer a trigger), and the run that proved the last commit is the one that counts. `ci-gate` still fails closed: a job that applies to the change and was skipped fails it, and so would any run that was not the full suite.

**`fast-checks` is the first signal.** It finishes in about a minute and no other job waits for it: typecheck, the source-pinned guard tests (the CI wiring pins, the F-3 window ratchet, no-new-bespoke-menu, the Vault-Wall dependency test), the Vault word scans that fail on a public string (the 0110 vote-deduction and 0023 consequence features), py_compile and the ES-module syntax check of the front end. Run the same set yourself before every push:

```
npm run ci:fast
```

**A browser test file with no measured duration** (`frontend/tests/_ci_durations.json`) is weighed at 15 s per test by the splitter. The guard `test_every_browser_test_file_has_a_measured_duration` fails only for a file your change adds (compared with the base: the first parent of the PR merge ref, or `git merge-base` with origin/main locally); a file main gained meanwhile only warns in the job summary, so two PRs that merge a minute apart cannot turn main red. Add `"<file>.py": <seconds>` (15 per test is fine) for a file you add.

It is `ci/fast-checks.sh`. Every check in it also still runs in its full lane; nothing was moved out of a lane's coverage.

**Shard counts** (the lane is as long as its longest leg): `test-unit` and `coverage-shard` 8 legs each (balanced by `ci/test-durations.json`, refresh it with `npm run ci:refresh-durations` or from `test-unit` logs), `bdd` 3 legs (`ci/bdd-shard.mjs`, balanced by `ci/bdd-durations.json`; each leg prints `[bdd-shard] <feature> <seconds>` for the refresh), `fe-browser-tests` 10 legs (`frontend/tests/_ci_durations.json`). Every test file or feature still runs in exactly one leg; a unit test per table proves it.

## The flaky-test rule (ORW-229)

A flaky test is one that fails and then passes on the same code. Flakes waste everyone's time and teach people to ignore red, so we handle them the same way every time. Kevin approved this rule on 2026-11-06 (Plane ORW-229).

### 1. One automatic retry

When a test fails in CI, it gets one more try:

- engine tests (vitest): `--retry=1` in `test-unit` and `coverage-shard`;
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

## Flakes are quarantined the day they are seen (ORW-415)

A flake that is seen goes into quarantine that same day, with a Plane card (rule 3 above; the 7-day clock then runs). Do not wait for it to fail a second PR: tonight one flaky test and one job time limit cost six re-runs. `scripts/ci/quarantine-flakes.py` reads the flaky-test lines the lanes already write (tests that passed only on the automatic retry) from the last N completed main runs and prints, per test, in how many runs it flaked plus the patch that adds the marker. It changes nothing by itself: open the card, put its number in place of `ORW-NNN`, apply the patch, open the PR.

## CI tools for agents (`scripts/ci/`, ORW-415)

All use the `gh` CLI (logged in) and plain bash or python3; each has `--help`. They only read, except `watch-pr.sh --merge` and the re-runs it starts.

- `scripts/ci/watch-pr.sh <pr> [--merge] [--minutes N]`: polls the newest run for the PR's current head every 30 s and stops at the first failed job instead of the end of the run. It prints the job, the failing tests and the first error lines, and says "ALSO RED ON MAIN" when the same test fails on main's newest completed run (then it is not your PR's fault: do not chase it, and do not stack three PRs on it). A job cancelled at its time limit, or a failure whose only failing tests are listed in `scripts/ci/known-flakes.txt` (one test id per line), is re-run once the run completes, at most 3 times. Exit 0 green (or merged with `--merge`, which uses `--match-head-commit`), 2 real failure, 3 merge conflict, 4 deadline. `--run <id>` replays one finished run read-only.
- `scripts/ci/pr-overlap.sh [--pr N]`: every file changed by more than one open PR, with PR numbers and branches. Overseers run it before dispatching work and before pushing: two PRs on the same function mean the later one loses a round to a rebase.
- `scripts/ci/quarantine-flakes.py [--runs N]`: see the section above.
- `scripts/ci/ci_logparse.py`: the log parsers the first and third use. Their tests: `cd frontend && .venv/bin/python -m pytest tests/test_ci_tools_logparse.py -q`.

## Merge queue: turning it on and off (ORW-415)

Status: NOT enabled. The coordinator turns it on; nothing here is applied by merging this page. `ci.yml` already listens to `merge_group` (`checks_requested`), and `ci-gate` is the one required check, so the workflow side is ready. The `main-required-ci` ruleset (id 18797902) currently holds one rule, `required_status_checks` with `ci-gate` (integration 15368), no bypass actors.

### Turn it on

1. Save the current ruleset, so the rollback is exact:
   `gh api repos/Psychout-Media/orwell/rulesets/18797902 > ruleset-18797902.before.json`
2. Build the new body: the existing rule plus a `merge_queue` rule. A ruleset update replaces the whole `rules` array, so the `required_status_checks` rule must be sent again unchanged. Write `ruleset-18797902.after.json`:
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

- `gh pr merge <n> --squash` no longer merges at once: it puts the PR in the queue. GitHub builds a temporary branch of main plus the queued PRs and runs the full CI on it (the `merge_group` trigger); the PR merges only if `ci-gate` passes there. Do not use `--admin`; the ruleset has no bypass.
- A test that main breaks can no longer reach main through a PR whose own run was green on an old base, because each PR is tested merged with the queue ahead of it (SOUL lesson 5).
- Pushing to a queued PR removes it from the queue; the PR must be queued again. `gh pr merge <n> --squash --match-head-commit <sha>` still guards against a head that moved; check on the first queued PR that the flag is accepted, as the proof step above does.
- Watch with `scripts/ci/watch-pr.sh <pr>`: it follows the PR's own run; once the PR is queued, the queue's run is on `gh-readonly-queue/main/pr-<n>-<sha>` (`gh run list --branch gh-readonly-queue/main/pr-<n>-<sha> --workflow CI`) and `gh pr view <n> --json state` shows MERGED at the end. Dequeue with `gh pr merge <n> --disable-auto` or from the PR page.
- `watch-pr.sh --merge` enqueues instead of merging; its exit code 0 then means "queued", so confirm MERGED with `gh pr view`.

### Turn it off (rollback)

1. Take the saved body from step 1 of "Turn it on" and drop the read-only fields (`id`, `node_id`, `source`, `source_type`, `created_at`, `updated_at`, `current_user_can_bypass`, `_links`): 
   `jq 'del(.id,.node_id,.source,.source_type,.created_at,.updated_at,.current_user_can_bypass,._links)' ruleset-18797902.before.json > ruleset-18797902.rollback.json`
2. `gh api -X PUT repos/Psychout-Media/orwell/rulesets/18797902 --input ruleset-18797902.rollback.json`
3. Check that `gh api repos/Psychout-Media/orwell/rulesets/18797902 --jq '.rules[].type'` prints only `required_status_checks`. PRs still in the queue stay open; merge them with `gh pr merge <n> --squash` as before.
