# 0136 - Your Legend Precedes You

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped, gated by data and phase rather than a dedicated flag, before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1791; merged in PR #1902.

## Problem
Season notoriety (0087/0088 family) records what a returning player did, but nothing voiced it, so a returning player entered a house that behaved as if it had never heard of them.

## What shipped
- New optional `notorietyLegend?: string[]` on `GameStateView`, populated only from `notorietySummary().legendBeats`, and only in `premiere` or week-1 `social` (`GameSessionAdapter.ts` ~line 11640).
- `renderGameContext` (`src/engine/momentPrompts.ts`) emits an always-on `RETURNING CAST:` line: `the house has heard things - <legend clauses>`. An always-on context block, not an under-callable tool.
- `notorietySummary()` is an outward, Vault-free projection on the `GameSession` port; it returns only `NotorietyLegendView` (`legendBeats`, legend clauses, no facets). `setNotoriety` supplies the summary.

## Flag
No dedicated flag. The legend is set only when the player returns as the same character (`keepCharacter` -> `carriesNotoriety` -> `setNotoriety` in `src/composition/registry.ts` ~696), from the 0104 notoriety store; otherwise there is no summary and the line is empty. It is also empty outside the premiere / week-1 `social` window.

## Vault Wall and anti-sycophancy
Only open-set legend clauses cross; reputation facets, numbers and day-one biases stay in the engine. Notoriety is barred from competition, vote and jury rolls; the day-one bias does shift NPC→player move-in edges (ADR 0003: voiced facts, not scripts).

## Tests
`tests/unit/notorietyVault.test.ts` (no numbers/facets/keys on any player, prompt or admin surface), `notoriety.test.ts`, `notorietyOutcomeNeutral.test.ts`, `portDispatchCoverage.test.ts`.

## Known gaps
Only voiced at the start of a season; later weeks do not repeat it.
