# CI

How the GitHub checks run lives in `.github/workflows/ci.yml` (the per-job comments explain each lane). This page holds the rules people have to follow.

## The flaky-test rule (ORW-229)

A flaky test is one that fails and then passes on the same code. Flakes waste everyone's time and teach people to ignore red, so we handle them the same way every time. Kevin approved this rule on 2026-11-06 (Plane ORW-229).

### 1. One automatic retry

When a test fails in CI, it gets one more try:

- engine tests (vitest): `--retry=1` in `test-unit`, `coverage-shard` and `heavy-sims`;
- front-end tests (pytest): `--reruns 1` in `fe-unit` and `fe-browser-tests`;
- the mirror-parity gates keep their own attempt loops.

A test that fails twice is red, as before.

### 2. A pass on the retry still counts as a flake

A retry hides a flake, so CI writes every test that only passed on its retry into the job summary (the "Flaky tests" section on the run page) and adds a warning to the PR's checks. A mirror gate that only passes on a later attempt is listed the same way. If you see one, it is a real problem with that test, even though the check is green: fix it, or quarantine it (step 3).

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

When the guard goes red, either fix the test and remove the marker, or delete the test. Do not just move the date. If a fix truly needs longer, explain why on the card; moving the date is then its own reviewed PR.
