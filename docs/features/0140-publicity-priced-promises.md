# 0140 - Publicity-Priced Promises

> **Retrospective note (written 2026-11-03, issue #1938).** This feature shipped flag-gated before any spec existed; this documents what was actually built from the merged code, not a forward design. Issue #1802; merged in PR #1906.

## Problem
A deal struck in front of a crowd and one struck in a quiet room were mechanically identical, so choosing the room made no difference.

## What shipped
- The deal record gains `formationWitnesses`: the co-present houseguests at the `makeDeal` commit, excluding both parties, sourced from presence ground truth (`src/domain/deal.ts`, `GameSessionAdapter.ts`).
- The audience scale `formationAudienceScale = min(maxScale, 1 + perWitness * n)` (`src/engine/deals.ts`) is applied to the KEPT-deal (honored) fold in `applyHonor`, only when `dealsWitnesses` is on; with `dealDepth` also on, the loyalty-streak multiplier overwrites the audience scale (a bigger audience does not then raise the fold). Constants: `perWitness` 0.08 and the existing 1.6 cap (`relationshipConstants.ts`, ADR 0005: the engine owns magnitude).
- At breach, the wronged party learns via the existing reveal (when it witnesses the break), and `revealToWitness` additionally sends a collateral copy to each formation witness, exactly that set, no over-reach. The sealed-ballot case is fixed (#2108, BDD audit D1): the witness loop applies the same `sealed` guard, so a SECRET `vote-evict` break names no breaker to formation witnesses.
- At FORMATION (ORW-85, AMEND 3c item 5; played games only, needs the NPC-memory layer): each awake formation witness writes a memory about the dealmakers, reading the deal against its own position - a `target-other` deal that names the witness (or one of its allies) leaves a `deal-resented` grudge toward BOTH dealmakers; a witness whose own ally struck the deal without it takes a smaller `deal-resented` hurt toward that ally; anyone else keeps a recall-only `deal-witnessed` entry. Magnitudes: `DEAL_WITNESS` in `src/engine/npcMemory.ts` (tunable). Deterministic, no rng; bounded by the per-pair memory cap; sleepers and absent houseguests remember nothing; entries hold kind/week/severity only, never the deal's words. Tests: `tests/unit/dealWitnessMemory.test.ts`.
- Purely diegetic lever (pick the room and company); no new tool.

## Flag
Flag `ORWELL_DEAL_WITNESSES`, deploy default ON; OFF leaves `formationWitnesses` unpopulated and fold + diffusion byte-identical.

## Vault Wall and anti-sycophancy
Bounded and inside existing fold paths; breach knowledge reaches only players who were actually present (no pathway invented). Does not move the `juryReach` band.

## Tests
`tests/unit/deals.test.ts`: TEST 1 capture; TEST 2 the `formationAudienceScale` multiplier math and cap only (no fold assertion); TEST 3 `revealToWitness` reaches exactly the witness set; TEST 4 with the flag off no witness callback fires and no record is set (it does not assert fold or diffusion byte-identity); `juryReach` per the PR.

## Known gaps
No FE surface; the lever is not advertised to the player.
