# 0167 - Triads, swing votes and kingmakers (Theme 3 slice 13) - DRAFT, not built

Executable spec (drafted only): `0167-triads-swing-votes-kingmakers.feature`. Not in `cucumber.cjs`; no step definitions. Awaiting the owner's approval of the Theme 3 plan.

## What it adds
Structural balance: a shared enemy warms two houseguests; two friends of one drift together; an unbalanced triad strains. A houseguest whose vote decides an eviction is courted by both sides, knows it, and their price rises.

## Reuses (verified to exist)
- `src/engine/voteEstimate.ts`, `voteTalk.ts`, `voteQuestions.ts`, `voteDeduction.ts` (the count and who can see it), `src/engine/campaigns.ts` (lobbying), `src/engine/dealTemptation.ts` (the "price" a swing weighs).
- `src/engine/relationships.ts` (+ constants) for the drift; the drift is a small bounded fold, not a new relationship model; the social core adds the cleaner place for it.
- Q1: the NPC's answer to a pitch is engine-decided from belief and price; the narrator only voices it.

## Data shape (engine-only)
`SwingRead { houseguest, eviction, decides: boolean, sides, priceTier }` derived at vote time; triad drift as a bounded daily fold on the existing edges. Own seeded side stream. Tiers, not numbers, on any surface.

## Open owner questions
- Can the player be a swing houseguest and be courted? (Plan implies yes; the narrator voices the pitches; the engine never says "you decide".)
- Drift size: recommended small, bounded, reported in the mix guard.
