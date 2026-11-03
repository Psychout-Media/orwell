# 0140 - Publicity-Priced Promises

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped flag-gated before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1802; merged in PR #1906.

## Problem
A deal struck in front of a crowd and one struck in a quiet room were mechanically identical, so choosing the room made no difference.

## What shipped
- The deal record gains `formationWitnesses`: the co-present houseguests at the `makeDeal` commit, excluding both parties, sourced from presence ground truth (`src/domain/deal.ts`, `GameSessionAdapter.ts`).
- Formation trust-fold scales with audience size: `formationAudienceScale = min(maxScale, 1 + perWitness * n)` in `src/engine/deals.ts`, with `perWitness` 0.08 and the existing 1.6 cap (`relationshipConstants.ts`, ADR 0005: the engine owns magnitude).
- At breach, the fact reaches each formation witness (a witnessed betrayal event per witness), exactly that set, no over-reach.
- Purely diegetic lever (pick the room and company); no new tool.

## Flag
Flag `ORWELL_DEAL_WITNESSES`, deploy default ON; OFF leaves `formationWitnesses` unpopulated and fold + diffusion byte-identical.

## Vault Wall and anti-sycophancy
Bounded and inside existing fold paths; breach knowledge reaches only players who were actually present (no pathway invented). Does not move the `juryReach` band.

## Tests
`tests/unit/deals.test.ts` (capture, scaled-fold-capped, breach-scope no-over-reach, flag-off byte-identical); `juryReach` per the PR.

## Known gaps
No FE surface; the lever is not advertised to the player.
