# 0194 - Moods with more causes (ORW-626)

Status: built (first slice). Engine-only; nothing new is shown except what a houseguest chooses to say. Flag `ORWELL_MOOD_CAUSES` (default ON, `=0` byte-identical), played games only.

## What it does
Before this a mood had a cause only when a goal settled (ORW-317). Now these also leave a cause on the houseguest, in engine words, recorded append-only in `live.moodCauseLog` (hidden layer, never projected whole):
- **lied-to** - they caught someone's lie (the one cost of a caught lie, `payForCaughtLie`, whoever the liar, the player included). The existing "betrayed" mood step lands at half strength (keyed, no rng).
- **betrayed** - a broken formal deal, for the wronged party.
- **friend-evicted** - a close friend (trust and affinity mean at or above `MOOD_CAUSES.friendBond`) was just voted out. The mood itself already moves by the blindside and contagion rules.
- **bad-sleep** - a genuine night-end left their hidden rest deficit at or above two in the morning.
- **won / lost** - an HOH or veto win; a lost veto, or a lost final-three HOH.

## What is told
The cause reaches the narrator only through `npcVoice.moodCause`, only for an active houseguest, only when they would say it: closeness to the player plus candor must reach a bar, higher for a cause that points at a grudge (lied-to, betrayed). Of everything they would say this week the heaviest wins (a goal cause weighs `goalWeight`). The narrator voices it in their words (the existing `moodCause` instruction applies); it never sees a number or the log. The mood WORD stays visible through the tells. Engine decides the substance, the narrator the voice (ORW-583).

## Rules
No rng anywhere (all deterministic); the player's own mood is theirs (no cause recorded for the player, though the player as a liar or evictee is the subject of others' causes); a cause is written once per holder, source, subject and day; flag off or a headless game records nothing.

## Left for follow-up slices
One mood source for the word, tells and decisions (ORW-576, not yet built on main); causes that move a mood a second time (a bad night does not move the word); a cause that decays across weeks; a betrayal learned through a told scene (only the broken deal is wired); the FE cast card showing a witnessed public cause.

## Gates
BDD `0194-moods-with-more-causes.feature`, `tests/unit/moodCauses.test.ts` (pure rules, played-game wiring, flag-off, headless, the wall).
