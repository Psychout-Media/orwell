# 0195 - What the evicted take with them

Card: ORW-628 (approved by Ryne 2026-11-17, Fable pitch #9). Executable spec: `0195-evicted-take-with-them.feature`. Unit gates: `tests/unit/evictedTake.test.ts`.
Flag: `ORWELL_EVICTED_TAKE` (default ON, `=0` kill switch). Played games only (`live.playedGame`); a headless game and flag-off are byte-identical.

Summary: when a houseguest leaves, what they held leaves with them, and the house works out what changed. Their open deals lapse. A favor owed to them passes to their closest ally still in the house, or lapses. A favor they owed lapses, and their open assurances lapse both ways. The ones left react to what they lost or were freed from. Engine-only: nothing is shown as a number.

## What happens, once per evictee, after the eviction result
1. **Deals.** Every open deal with the evictee lapses: neutral, neither kept nor broken, with no fold. Each living NPC partner reacts:
   - **relief** if their own secret plan (0178) was to break it anyway;
   - otherwise **worry**, by how much the deal shielded them. A final two shields most, then safety, the veto save and a vote promise. A deal to target someone else shields nothing.
2. **Favors held by the evictee** (0171). An NPC evictee passes each favor to their closest ally still in the house: bond at or above `FAVOR.passBond`, never the debtor (`heirOf`). The ledger keeps the original holder, so a passed favor still remembers whose it was. With no such ally, the favor lapses and the debtor is relieved. The player's own held favors are never passed for them: the engine doesn't decide for the player, so they lapse.
3. **Favors owed by the evictee** lapse: they can't be collected now. The favor ledger gains a `lapsed` state, append-only as before.
4. **Assurances** (B4) to and from the evictee lapse.
5. **What they knew** goes to the jury house with them. This was already true: the house's gossip runs over the living (`orchestrator.ts`, the evicted are left out of the roster) and the co-presence spread runs by presence. The jury house (0189) is where it lives now.

Moods move through `catchMood`: a fraction of the existing arc events, with no rng and no memory filler. Relief is the `survived-vote` arc and worry is `nominated`. This is not the "close friend evicted" mood cause, which is ORW-626 (B), nor the blindside rattle, which is mood contagion (0185): this reaction is about what was held.

## The player in both directions
- **An NPC leaves holding a favor the player owes:** it passes to their closest ally, who can now call it in on the player.
- **The player leaves:** their deals lapse and their held favors lapse, never passed for them. The NPCs who owed them are relieved, and an NPC partner who planned to break the player's deal is relieved too.
- **The player's deals with an evicted NPC lapse** and leave the player's deal list.

## Measured
- The 12-season mix guard measures week 1. This acts after an eviction, so its effects land from week 2.
- Jury reach and the gradient run headless (`playedGame` off), where it is a no-op.
