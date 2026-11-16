# 0154 - Caught in a lie, and lying about your vote (theme 2, slice 5)

Plan: the vault note "Theme 2 Slice Plan" (slice 5). Builds on 0149 (claims core), 0150 (beliefs drive decisions), 0153 (NPCs spread and lie). `spokenClaims.ts` and `houseSpeech.ts` are owned by the BDD Auditor: ask before changing them.

## What exists and is reused (do not duplicate)
- `writeLieCaught(holder, liar, confidence, origin)` (B23, flag `ORWELL_LIES_CAUGHT`): writes the `lied-to-me` belief; 0150's `beliefPull` reads it at weight 0.8 and a strong one forms a revenge goal.
- `refuteClaim` for the claim-planted belief (id ends `|claim:<n>`); B48 `credibility` reads `lied-to-me` claims and broken casual assurances.
- B4 `AssuranceLedger` ("safe" / "vote" / "loyal") for "you're safe with me".
- `truthOf` + the adapter's `truthFacts()` (engine truth incl. `voteRecord`, never exposed).

## Triggers (each a pure check; the adapter calls them at the moment the board changes)
1. **A public count makes "I voted to keep you" impossible**: a check on the PUBLIC tally only (never a ballot): e.g. a unanimous count means every claimant lied.
2. **A nomination after "you're safe"**: reuse the B4 assurance break; make the assured hold `lied-to-me` about the assurer through the same writer.
3. **Two claims from one speaker that cannot both be true** (to the same listener): a small table of contradictory pairs over the fixed claim kinds (e.g. final-two-with vs going-after on the same pair; voted-to-keep vs voted-against).

## Effects when caught
Refute the listener's claim-planted belief (`refuteClaim`, id kept); write `lied-to-me` about the speaker at real confidence (`writeLieCaught`); the speaker's credibility with that listener drops (B48, no new code); a lie that cost the listener can form a goal (0150). No tell: nothing new reaches the narrator, and a caught lie the player did not witness is never narrated.

## Lying about your vote
After an eviction, NPCs tell each other how they voted. The engine decides whether each tells the truth or lies (cunning and need), as claims of kind `voted-against` / `voted-to-keep` (the latter requested of the claims-core owner). Vote deduction may read them as evidence at its normal strength; the ballots stay secret (the unseal is the 0048 retrospective only). Seeded side stream; the house-mix and late-game guards run in the PR.
