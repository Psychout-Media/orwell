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

## Amendment 2026-11-19 (ORW-704 / ORW-710): who the narrator and the strip may name, and no introduction twice

- While the premiere's entrances run, the state read and the narrator's roster carry only the houseguests who have walked in (the met set). The ones still to come are a count (`unarrivedCount`, and one anonymous placeholder each in `premiere.remaining`); their names and cards ship nowhere (the narrator, the browser state, the roster, the premiere strip) until their own entrance. The strip draws an unlit, nameless tile per placeholder, labelled from the placeholder's own data. Flag `ORWELL_MET_ONLY_ROSTER` (default on; off ships the whole cast as before). Proof: `tests/unit/metOnlyRoster.test.ts` (an unmet houseguest's name is in the engine record, absent everywhere player-facing until they arrive, present after).
- Recap-beat rule (in the entrance beat while anyone is outside): a beat that must refer to a houseguest the player has not met may call them only a not-yet-introduced arrival, never by name, until their entrance; a recap beat may name only houseguests the player has met.
- Entrances and the toast must not repeat or skip: the front end keeps who walked in after the player and whether a reply named them, owes the narrator any arrival not yet named (not only the latest), holds the next release (bounded) until the latest arrival is named, and tells the narrator when the current toast batch has already been voiced. Proof: `frontend/tests/test_orw704_entrances_voiced.py`.

## Amendment 2026-11-19 (ORW-690)
- **Arms on either path into the circle.** The record used to arm only on the tour's call. The circle is the meet-the-cast moment whether or not the tour ran, so it now also arms when the last arrival closes the entrances with no tour (flag off, no tour). One idempotent arming step serves both paths; order is unchanged (entrances, tour if any, circle, bed rush). Same flag, same played-game condition.
- **A returner is never re-authored (0208).** `recordCastProfile` drops every public facet (name, vocation, biography, identity concept, presentation, look, voice) for a returner on a live house; the hidden storyline fields still apply. The recorded persona the player knew stays byte-stable.

## Amendment 2026-11-23 (ORW-800)
- **An older save arms on load.** A save already in the toast with no `introduced` record (written by the code before the no-tour arming) is armed at the end of a resume (`registry.importSnapshot` calls `armRestoredMeetTheCast`, after the relationship layer is loaded): everyone who has already spoken in the toast (never the host) is introduced, in order, with their first-impression fold; the rest are introduced as the circle runs. Nothing a save held is dropped (`retroArmedIntroductions` in `sessionSnapshot.ts`, a pure superset helper). A save in the entrances, a finished circle, an armed record (even an empty one), or the flag off, is left as it was.

## Amendment 2026-11-28 (ORW-1129, ORW-1130, ORW-1131, ORW-1132; Ryne's prod premiere)

- **One toast a turn (ORW-1131, Ryne approved).** `TOAST_BATCH` is 1: each release is one houseguest's toast, and two or three others react and play off it. The host opens with the first speaker. An explicit "keep going" releases up to three (`_TOAST_FLOW_BATCHES`).
- **The player's slot waits (ORW-1129).** A release never runs past the player's slot. The slot is released alone; that reply ends on the invitation, and the next release comes on the player's next message (their toast or a pass). That release carries `playerJustToasted`, so the room answers the toast first.
- **Nobody toasts twice (ORW-1130).** The front end reads which houseguests a reply showed giving their toast (`toasts_voiced_in`) and hands them to the engine as `advanceGame.toastVoiced`. The engine records them as spoken, out of order if need be, and never releases them again.
- **The close is a moment (ORW-1132).** When the release closes the circle, the reply carries the host's call that ends the circle and opens the bedrooms, before the house breaks up.
