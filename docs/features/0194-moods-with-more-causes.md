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

## Left for follow-up slices (ORW-825)
One mood source for the word, tells and decisions (ORW-576, not yet built on main); causes that move a mood a second time (a bad night does not move the word); a cause that decays across weeks; a betrayal learned through a told scene (only the broken deal is wired); the FE cast card showing a witnessed public cause.

## Gates
BDD `0194-moods-with-more-causes.feature`, `tests/unit/moodCauses.test.ts` (pure rules, played-game wiring, flag-off, headless, the wall).

## Follow-ups (2026-11-18, ORW-671)
- **A bad night moves the mood word.** When a genuine night-end writes a `bad-sleep` cause (once per holder per day), the existing "scheme" mood step (low-grade agitation) lands at `MOOD_CAUSES.badSleepMoodScale` through `catchMood`. Bounded, keyed, no rng. A repeat read the same day writes nothing and steps nothing.
- **Causes carry and fade.** A cause stays speakable for `MOOD_CAUSES.carryDays` in-game days after the day it landed, its weight falling by an equal step each day (`carryFactor`, `strongestLiveCause`), across the week roll. Keyed on `dayNumber`, never wall-clock; with no day recorded the same week counts as today and another week does not. The append-only log is never trimmed; only the read applies the age. A fresh light cause can outrank a stale heavy one.
- **A betrayal learned later.** `DealLedger.learnOfBreak` now calls an optional `learned` sink once; the adapter writes a `betrayed` cause for the wronged party the day they learn of the quiet break (through the caught-lie gate or the breaker's public act). A told claim of a lie already lands as `lied-to` through `payForCaughtLie`.
- **Cast-card line: not done.** A cause line on the roster card would either reveal who counted on whom (the friend-evicted bond is hidden) or need a new public-cause projection with its own boundary test; that is more than a small additive field, so it stays for its own slice. (ORW-825)

Left: one mood source for word, tells and decisions (ORW-576); the public-cause cast-card line.

## Amendment 2026-11-18 (ORW-614, P-11): flirt, strategy and gossip scenes move mood and memory

Only four scene kinds (betrayal, conflict, bonding, alliance) moved a houseguest's mood and memory when the player was in the scene; flirt (showmance), strategy and gossip moved nothing, while the same scenes between two houseguests moved their moods. With `ORWELL_PLAYER_SCENE_MOVES` (default ON, played games only; `=0` byte-identical) a showmance or strategy scene is remembered as a small warmth (a kindness entry, smaller than bonding: 0.25 and 0.15) and a gossip scene moves the touched houseguest's mood only; the mood event is the houseguest-side event the off-screen scene already uses. One table (`SCENE_MEMORY_SEVERITY_MORE` in `npcMemory.ts`) serves both the player's scenes and the scenes between houseguests, so the two read alike. Bounded by the ledger's per-pair cap and the existing drift scale; no rng, no new stream. Gate: `tests/unit/orw614PlayerSceneMoves.test.ts`. The older pin in `sceneMemoryWrite.test.ts` (strategy / gossip write none) is a not-played game and still holds.

## Amendment 2026-11-19 (ORW-691, B1-4): a bad night's sleep is reachable
The bar was a rest deficit of 0.25, which is a bed at exactly 2am; the latest houseguest bedtime is strictly under 2am, so no houseguest could ever meet it and the `bad-sleep` cause never fired in a real game. A played game now uses `MOOD_CAUSES.badSleepDeficitReachable` (0.125, a bed past 1am) behind `ORWELL_BAD_SLEEP_REACH` (default ON; `=0` is the old bar). Test through the real message clock and a real turn-in: `tests/realpath/orw691BadSleep.test.ts`.
