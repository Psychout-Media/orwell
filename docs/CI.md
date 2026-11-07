# CI

How the GitHub checks run lives in `.github/workflows/ci.yml` (the per-job comments explain each lane). This page holds the rules people have to follow.

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

## Nightly: what runs once a night instead of on every push (ORW-229)

Some checks cost a lot on every push and almost never tell us anything new there. Those moved to the nightly run. Kevin approved this on 2026-11-06 ("decided by measured cost and value, and coverage is still measured there").

**How it runs.** `.github/workflows/ci-nightly.yml` runs every night at 04:23 UTC, and on demand from the Actions tab ("Run workflow"). It calls `ci.yml` itself with `nightly: true`, so the suite is written down once. A nightly run has no "before" commit, so every lane runs, plus everything below. A failing night opens or updates one GitHub issue labelled `ci-nightly` (tracked in Plane as ORW-234).

**What moved, and why.** We measured cost from the committed duration tables and 7 days of CI history (2026-10-31 to 11-06), and value as "did it catch a problem on a PR or on main, that nothing else caught?":

- **The three SHOWRUNNER_REWEIGHT heavy sims** (`jury-reweight`, `gradient-reweight`, `uat-reweight`). That flag is off by default, so these test a version of the game we do not ship. In those 7 days each one failed only on PRs where its normal twin failed too, and never alone. Together they took about 4 runner-minutes on every push that runs the heavy sims, and `jury-reweight` made its leg the slowest heavy job.
- **COVERAGE_RESULT_PLACEHOLDER**

**What stayed on every push.** Everything else, including every slow test that failed on a PR or on main in those 7 days: the base heavy sims (they caught a vault-leak and a stuck pending decision on PRs), the Vault sentinel property test, the eviction and reactive-twist tests, and `test_a64_week1_clock_real_loop.py` (it caught a real regression on 2026-11-06).

**Changing the list.** Moving a test off the per-push path needs the same evidence in the PR: its cost per push, and that it caught nothing on its own recently. Anything that guards the Vault Wall stays on every push unless Kevin says otherwise.
