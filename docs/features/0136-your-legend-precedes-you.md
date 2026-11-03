# 0136 - Your Legend Precedes You

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped flag-gated before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1791; merged in PR #1902.

## Problem
Season notoriety (0087/0088 family) records what a returning player did, but nothing voiced it, so a returning player entered a house that behaved as if it had never heard of them.

## What shipped
- New optional `notorietyLegend?: string[]` on `GameStateView`, populated only from `notorietySummary().legendBeats`, and only in `premiere` or week-1 `social` (`GameSessionAdapter.ts` ~line 11640).
- `renderGameContext` (`src/engine/momentPrompts.ts`) emits an always-on `RETURNING CAST:` line: `the house has heard things - <legend clauses>`. An always-on context block, not an under-callable tool.
- `notorietySummary()` is exposed on the `GameSession` port for engine-internal use; `setNotoriety` supplies the summary.

## Flag
No dedicated flag was found in `src/featureFlags.ts` or `deploy/orwell-env-defaults.sh`; the gate is data-driven (empty without a notoriety summary, and outside the premiere/week-1 window). Not verified: whether an upstream flag controls whether a summary is set.

## Vault Wall and anti-sycophancy
Only open-set legend clauses cross; reputation facets, numbers and day-one biases stay in the engine. Notoriety perturbs no outcome (ADR 0005: voiced facts, not scripts).

## Tests
`tests/unit/notorietyVault.test.ts` (no numbers/facets/keys on any player, prompt or admin surface), `notoriety.test.ts`, `notorietyOutcomeNeutral.test.ts`, `portDispatchCoverage.test.ts`.

## Known gaps
Only voiced at the start of a season; later weeks do not repeat it.
