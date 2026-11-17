# 0170 - Deals between NPCs and the HOH deal (Theme 3 slice 2) - BUILT behind ORWELL_NPC_DEALS

Executable spec: `0170-npc-deals-and-hoh-deal.feature`, wired into `cucumber.cjs`; steps in `features/step_definitions/npc_deals.steps.ts`. Unit gates: `tests/unit/npcDeals.test.ts`, `npcDealsSession.test.ts`; report: `tests/calibration/npcDealsReport.test.ts`. The jury reach, the gradient and the 12-season mix guard are measured with the flag on and off (see the PR report), not asserted in a scenario.

## What it adds
NPCs strike deals with each other (not only with the player). A nervous houseguest can trade the HOH their vote for safety while planning, in secret, to turn.
An NPC HOH's nominations read its standing deals, weighted by how much it trusts each partner.

## Reuses (verified to exist)
- `src/engine/deals.ts` (the deal store and kinds), `src/engine/dealConsent.ts` / `dealTemptation.ts` (who agrees, who is tempted), `src/engine/dealCredibility.ts` + `credibility.ts` (B48, 0162: a broken deal costs the breaker's word).
- `src/engine/dealNomConstants.ts` (HOH nominations that honour a deal) is the natural place for the trust weighting; `src/engine/alliances.ts` and `blocs.ts` for the surrounding social read.
- Events through the existing recorder; witness set = the two NPCs, hidden from the player (Vault).
- Slice 1 (Auditor, 0178) owns the plan itself (keep / this week / break at a moment / flip / cut at final three). ONE plan model: slice 2 holds NO plan logic. `proposeNpcDeals` only chooses who pacts with whom and of what kind (one draw per pair, the propose roll, from `${seed}:npc-deals:${week}:${pairKey}`; the stream's draw count changed from five to one in the rework). The sealed pact is an ordinary ledger deal; `planAndCarryOutDeals` plans every open deal an NPC is bound by (the weighing margin, the bond, every deal the NPC is party to, cunning from candor, the culture dials) and carries out the due betrayals through `DealLedger.breakDeliberately`; a flip is carried out by the vote itself.
- The push: `planAwareDealPush` makes the HOH's nominations lean POSITIVE toward the partner when the HOH's own plan is a `break-at` (PLAN_SEMANTICS: a betrayal carried out as a quiet break) with moment `nominations` in THIS week, and the pact is still open or was broken by that very plan this week (`outcome` "carried-out"; the carry-out runs before the push is read). Never after that week, never for a pact that ended any other way.
- Played vs headless: main's planner runs only in played games (`live.playedGame === true`, 0178's own design), so headless seeded sims run no plans at all and the pacts there stay kept or lapse. The played path is the measured one (the PLAYED integration test through the real carry-out in `npcDealsSession.test.ts`, and the report).

## Data shape (engine-only)
The pact is a `Deal` in the ledger (never deleted); each side's plan is in the Auditor's `live.dealPlans` (append-only, with its `outcome`). Own seeded side stream (`${seed}:npc-deals:${week}:${pairKey}`) so nothing else's rolls move.

## Open owner questions
- How often NPCs deal falsely, and how easily plans flip (plan: from personality, bond, culture; never flat rates; reported).
- May an NPC HOH honour a deal it plans to break only at the vote, or may it break it at nominations?
