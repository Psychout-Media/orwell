# 0171 - Counters, favors and the favor economy (Theme 3 slice 3) - DRAFT, not built

Executable spec (drafted only): `0171-favor-economy.feature`. Not in `cucumber.cjs`; no step definitions. Awaiting the owner's approval of the Theme 3 plan.

## What it adds
Counters come from the NPC's goal for the week and can run several rounds. A favor owed is a real debt on the bond; calling it in at a close vote and refusing it costs trust (with the caller and with witnesses). Favors become a house currency: owed, repaid, passed on, remembered.

## Reuses (verified to exist)
- `src/engine/deals.ts` (the open ledger of deals and promises, Q6), `src/engine/dealConsent.ts` and `dealTemptation.ts` (agree / counter reasoning), `src/engine/dealCredibility.ts` + `credibility.ts` (the witness-weighted caught-lie claim, as 0162 uses for a broken deal; a refused favor reuses the same weighting, not a new one).
- `src/engine/voteTalk.ts` / `voteEstimate.ts` (what a "close vote" means to an NPC), `src/engine/campaigns.ts` (the NPC's weekly goal).
- Depends on the social core (Core 1, Auditor): "debts owed" is a field on the directed bond. Until it lands, this slice keeps debts in its own favor ledger and the core adopts them.

## Data shape (engine-only)
`FavorEntry { id, owedBy, owedTo, holder, origin, madeBeat, state: owed|repaid|refused|passed, witnesses }`, append-only. A counter round count capped by a named constant. Own seeded side stream (e.g. `${seed}:favors`).

## Open owner questions
- Cap on counter rounds (plan suggests a small fixed bound)?
- Can the player be asked for a favor by an NPC and refuse it, and is a refusal remembered the same way?
