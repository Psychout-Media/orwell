# 0205 - Meet the cast (ORW-653)

Ryne's ruling (2026-11-18): the champagne circle is the meet-the-cast moment - official introductions and first impressions both ways - and none of it happens before the player walks in. Premise check: the entrances already mark each houseguest met as they arrive and fold a small first read from those already inside (A9); the toast already hands the narrator each speaker's public basics (ORW-368). What did not exist: an introduction record, an engine-decided first impression of the player at the circle, and a manner the narrator is handed.

## What it does
- **When.** The circle is entered from the tour as before (0206): the next `advanceGame` after everyone is in calls it. In a played game with the flag on, calling the circle arms the record `premiereEntrance.introduced` (append-only, saved with the season). Before that nothing is introduced; the entrances and the tour are unchanged.
- **One introduction per speaker.** The toast batches (0111, one `advanceGame` per batch, the order and the bed rush after it unchanged) are the introductions: each houseguest in a batch is introduced exactly once, in the order the entrances drew, from their public facts only (the cast card the toast already hands over: name, age, job, hometown, how they come across). Each is marked met (the #380 gate) and name-locked. The player's own slot only records that the player was introduced; the engine never writes or voices the player's words and the player introduces themselves in chat.
- **First impressions of the player.** When an NPC is introduced the engine decides how they take to the player: a keyed side stream (season seed, houseguest) plus the gap between the two public ages plus the houseguest's own social aptitude, giving a lean in [-1, 1]. It folds into the hidden NPC-to-player edge at a small bounded magnitude (`MEET_FIRST_IMPRESSION`: affinity 0.03, trust 0.015, scaled by the lean) through the same directed-impact rule the arrivals use. It draws nothing from the season rng and the player never sees a number.
- **What the narrator gets.** Per speaker, a plain word for the visible manner (`drawn-to`, `even`, `guarded`, engine keys) and one per-turn board rule: show it in conduct and tone, never state it or turn it into a verdict, never say what the player feels, never write the player's introduction. The player's impressions of the cast are the player's own; the engine hands only public facts and observable manner.
- **No short lists.** No fixed line per case: the narrator authors every introduction live from the facts. The only words the engine emits are the three manner keys (engine enum values, not a pick from a dealt list).

## Flag
`ORWELL_MEET_THE_CAST`, default ON, a played game with the staged premiere and the tour only. Off or headless: no record, no manner, no fold; the circle is byte-identical to before.

## Left for later
- An NPC introduction beat that speaks to the player's own introduction when they give one (reads from the recorded scene).
- Letting the first impression see more of the player's public profile than the age.
