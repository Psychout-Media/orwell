# 0186 - A deal exposed; renegotiation after a twist (Theme 3 slice 14, ORW-552)

Status: built. Engine-only; nothing new is shown. Flag `ORWELL_DEAL_EXPOSURE` (default ON, `=0` opts out), played games only.

## What it does
- **Exposure.** A houseguest holds a final two from someone. When they come to HOLD that the same houseguest also holds a final two with a third (a believed "allied with" claim about the pair: a told claim, an overheard pair, a witnessed scene; never the truth), their trust in the double-dealer drops. The deal weight the vote reads (`dealTrustFor`) follows that trust, so the promise weighs less. When most of the house holds it, the pair is public and every other holder of that houseguest's final two re-weighs at once.
- **Renegotiation after a twist.** A partner's HOH win reopens the deals that houseguest is party to; a double eviction reopens every open deal among the living. The reopening goes through the existing seam: the same weighing (`weighDealBreak`, with the renegotiation floor waived), the same lighter term (`renegotiatedKind`), the one standing `dealOffer` carrying `replacesDealId`. A deal with the player becomes a standing offer the player may accept or decline; the engine never accepts for them. A deal between two NPCs is swapped engine-side. A "break" verdict counts as a renegotiation here: a twist asks for new terms, it does not betray.
- **The player is plugged in both ways.** The player's two final-two deals expose like anyone's: the partner who learns loses trust in the player. The NPCs' own final-two deals with each other expose too. The player is never given a roster: they learn by an observable act or a told claim, as before. An NPC partner's HOH win reopens the player's deal as a standing offer.

## Rules
- Pure module `src/engine/dealExposure.ts`: `exposureHits` (who learns, deterministic order), `reopened` (which deals a twist reopens), `twistKey`. Constants in one block: `SEVERITY` 0.5 (a share of the plain break's betrayal fold, reusing `applyDirected(..., "betrayal", rng, scale)`), `PUBLIC_SHARE` 0.5.
- Exposure is applied overnight (`settleOvernight`), once per holder, double-dealer and rival (`live.dealExposed`). A side-stream rng keyed on (seed, key) only for the fold's jitter. The player is never a holder; they can be the double-dealer.
- A twist is handled once (`live.dealReopened`), one roll per deal per twist from a side stream keyed on (seed, deal, twist). If the one standing-offer slot is taken the player's deal waits for a later beat.
- Vault class: no view, prompt, tool or admin projection shows the exposure state, the reopened keys or a deal weight. The offer line is the existing renegotiation line.

## Gates
BDD `0186-deal-exposed-and-renegotiated.feature`, `tests/unit/dealExposure.test.ts` (pure rules, live adapter, flag-off, save round trip, wall).
