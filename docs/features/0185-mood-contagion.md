# 0185 - Mood contagion (Theme 3 slice 15, ORW-567)

Status: built. Engine-only; nothing new is shown. Flag `ORWELL_MOOD_CONTAGION` (default ON, `=0` opts out), played games only.

## What it does
A shocking eviction rattles the evictee's close allies most and the house a little. A big win (HOH or veto) lifts the winner's circle a little. No houseguest is told anything new: the only thing that moves is the existing mood, so it surfaces only through the channels that already read the soul (the mood word, the mood cue, house-life manner and friction, the mood terms in votes, vetoes and deals).

## Rules (tunables in one block in `src/engine/moodContagion.ts`)
- **Shock** = the worst blindsided or betrayed read the evictee holds, 0..1 (from the hidden eviction-manner record, written before the eviction commits). An expected or respected exit is 0 and spreads nothing.
- **Exposure** of a houseguest to the source = the stronger of their direct tie and half the best two-step tie, read through the bond reader (never the relationship model).
- **Catch scale** = clamp(magnitude x (HOUSE_SHARE + (1 - HOUSE_SHARE) x exposure)), capped; a stranger still catches the house share. The scale multiplies the ordinary mood step (`evolveEmotion`'s `scale`; absent = 1 = byte-identical).
- The evictee's closest ally already takes the full blindside and is skipped. The player is never touched. A caught mood writes no memory note and no recall record (it would be filler); the mood history still records it.
- **Good side**: the same spread with the win mood and a smaller magnitude, after an HOH or veto win.
- **Culture**: paranoia scales the bad spread, bonding the good spread, loyalty the direct-tie term (each within the culture bound; exactly 1 with no culture).
- **Decay**: the existing mean-reversion and overnight settle. No new persisted field.

## Gates
BDD `0185-mood-contagion.feature` and `tests/unit/moodContagion.test.ts` (pure spread, scale byte-identity, played-game behaviour, flag-off, wall).
