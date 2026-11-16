# 0163 - Deals between NPCs and the HOH deal (Theme 3 slice 2) - DRAFT, not built

Executable spec (drafted only): `0163-npc-deals-and-hoh-deal.feature`. Not in `cucumber.cjs`; no step definitions. Awaiting the owner's approval of the Theme 3 plan.

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
