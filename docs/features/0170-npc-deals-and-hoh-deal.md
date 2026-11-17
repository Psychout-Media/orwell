# 0170 - Deals between NPCs and the HOH deal (Theme 3 slice 2) - BUILT behind ORWELL_NPC_DEALS

Executable spec: `0170-npc-deals-and-hoh-deal.feature`, wired into `cucumber.cjs`; steps in `features/step_definitions/npc_deals.steps.ts`. Unit gates: `tests/unit/npcDeals.test.ts`, `npcDealsSession.test.ts`; report: `tests/calibration/npcDealsReport.test.ts`. The jury reach, the gradient and the 12-season mix guard are measured with the flag on and off (see the PR report), not asserted in a scenario.

## What it adds
NPCs strike deals with each other (not only with the player), each side with its own secret plan. A nervous houseguest can trade the HOH their vote for safety while planning to turn.
An NPC HOH's nominations read its standing deals, weighted by how much it trusts each partner.

## Reuses (verified to exist)
- `src/engine/deals.ts` (the deal store and kinds), `src/engine/dealConsent.ts` / `dealTemptation.ts` (who agrees, who is tempted), `src/engine/dealCredibility.ts` + `credibility.ts` (B48, 0162: a broken deal costs the breaker's word).
- `src/engine/dealNomConstants.ts` (HOH nominations that honour a deal) is the natural place for the trust weighting; `src/engine/alliances.ts` and `blocs.ts` for the surrounding social read.
- Events through the existing recorder; witness set = the two NPCs, hidden from the player (Vault).
- Slice 1 (Auditor) owns the plan itself (keep / this week / break at a moment / flip / cut at final three); slice 2 only gives NPC-to-NPC deals and the HOH read. Ordering dependency: slice 1 first.

## Data shape (engine-only)
Per deal, per side: `{ holder, partner, kind, plan, madeBeat }`, appended to the deal history, never deleted. A weight read from the holder's trust in the partner. Own seeded side stream (e.g. `${seed}:npc-deals`) so nothing else's rolls move.

## Open owner questions
- How often NPCs deal falsely, and how easily plans flip (plan: from personality, bond, culture; never flat rates; reported).
- May an NPC HOH honour a deal it plans to break only at the vote, or may it break it at nominations?
