# 0160 - Belief conviction (theme 2, Ryne's question 2)

Card: ORW-330. Executable spec: `0160-belief-conviction.feature`. Code: `src/engine/beliefConviction.ts` (pure), the adapter's `credulityOf`,
`questionsFor` and `weighEvidenceOvernight`. Builds on 0149 (claims plant beliefs) and 0150 (beliefs drive decisions).

## Ryne's ruling (2026-11-16)

"How much that I believe it depends on how much I act on it... If I don't believe it, then maybe I'm testing and I'm looking for evidence for or
against it... it depends on the person, how gullible they are, how open they are, how distrusting they are."

## What it is

- **A belief's confidence is its conviction.** It is the source's confidence (trust in the teller, corroboration) scaled by the listener's
  **credulity**: their own sheet (archetype, disposition, temperament drift) plus a small fixed personal offset. Two houseguests told the same
  thing by the same person hold it differently.
- **Act as fact.** At conviction `CONVICTION.asFact` (0.7) or more, a belief counts in decisions at full weight.
- **Test what you doubt.** A doubted belief that matters (targets-me, voted-against-me, lied-to-me, allied-with, heard-rumor) becomes an open
  question, a find-out goal, so the houseguest asks around (`askAround`, ON: Ryne accepted the gossipier week 1 it makes). Each night the
  evidence moves the conviction toward the engine's truth, sometimes the wrong way (`misleadP` 0.2), until it is held as fact or let go.
- **Low-trust deals (Ryne's Q3: "Low trust in the person would create a low trust deal").** A deal weighs as far as its holder trusts the other
  party (`dealTrust`): full at trust 0.5 or more, less below. An HOH's protective push on someone they distrust is smaller.
- Vote talk (0154), narrated claims (0155) and off-screen gossip (ORW-546) all plant beliefs through credulity.

## The wall

Conviction, credulity and the find-out goals are engine-only. No player or admin surface carries a number; the player sees only behaviour.

## Measured

The 12-season house-mix guard's reference moved with it (it is the with-conviction average; see `tests/uat/houseMixGuard.test.ts`). Calibration
gradient and jury reach pass.
