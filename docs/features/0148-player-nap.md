# 0148 — The player's nap (a chosen daytime fast-forward that eases sleep debt)

**Status:** spec (2026-11-15). **Rulings:** Ryne, 2026-11-15 (quoted below). **Owner of the design:** BDD Auditor. **Build:** an overseer lane.

## Summary

The player can choose to nap during the day. In-game time moves on by the nap's length, the house keeps living while the player sleeps, and every two hours of nap halve whatever sleep deficit the player is carrying. The deficit is never fully cleared: only a night in bed resets it. A scheduled event always wakes the player. Houseguests do not nap yet.

## Ryne's rulings (2026-11-15)

- "I almost think there should be a nap feature."
- "I think each 2-hour should remove half of the remaining deficit of sleep. Never fully removing it."
- "I think you could nap before. The event would always wake you."
- "Not yet on NPCs. We need to design this first before we add them."

Standing rules this must keep:

- "you need to choose to go to bed every single night" (11-12). Only the player's own bed ends the night, so a nap never runs into the night or ends it.
- No forced curfew (ADR 0006). Nothing makes the player nap; it is always their choice.
- The deficit stays hidden (ADR 0006, mandate 3). The player never sees a number, only the effect.

## Why

Today the bedtime gate refuses any turn-in in the morning or afternoon. So once the player is behind on sleep, the only way back is to grind to the next bedtime. A nap gives a real choice with a real cost: you recover some of your edge, but you are out of every conversation while you sleep.

## The rules

1. **Choosing it.** The player says they nap ("I take a nap", "I'll lie down for an hour"). The narrator calls the new `nap` lever with a length. That length is the player's own words, or one hour when they don't say. A nap is allowed only in the morning and afternoon phases, while the player is in the house and awake.
   - It is refused, with an in-fiction reason, while a house event is in session (comp, ceremony, gathering), while a decision is pending for the player, during the premiere, and once the evening has begun.
   - The player moves to their own bedroom (the HOH room if they are HOH) and sleeps there.
2. **Length.** From 30 minutes up to 3 hours, in 30-minute steps. It is cut short at the start of the evening (no napping into the night), and at the moment a scheduled event becomes due (rule 4).
3. **The deficit.** For the rest of today, the deficit the competition reads is the night's deficit times `0.5 ^ (hours napped today / 2)`.
   - Two hours halve it; another two halve what is left; one hour takes it to about 71%.
   - It never reaches zero. Going to bed resets the nap credit along with the night, as today.
   - If the multi-night fatigue meter is on, the same factor applies to the deficit it feeds into today's comps. The meter's own history is not rewritten.
   - Hidden: nothing player-facing carries the number or the factor.
4. **Events always wake you.** If a scheduled milestone (`daySchedule.due`) comes due mid-nap, the nap ends there: production wakes the player and the event proceeds as normal. Only the time actually slept counts toward rule 3. Napping the morning of a comp is allowed and is a real strategy.
5. **The house keeps living.** The elapsed hours are lived exactly as the player's own turns would live them: hour-by-hour house life for the awake houseguests, using the per-turn off-screen society tick, NOT the overnight catch-up path (that path suppresses sleeping scenes and caps the elapsed ticks). The nap has its own daytime policy (`consumeNapHours` in `src/adapters/engine/GameSessionAdapter.ts`, called from `src/composition/orchestrator.ts`): one tick per society-tick hours slept, at least one, capped at `EXTRA_TICK_CAP + 1`, each on its own seeded side stream so the shared stream the competition and vote spine reads is untouched. The player witnesses none of it. Anything they learn later comes only through the normal pathways (told, overheard, seen).
6. **Seen napping.** Houseguests who enter or are in the bedroom while the player sleeps witness a public fact: "the player was napping in the morning" or "in the afternoon", whichever phase the nap started in (a morning nap is allowed).
   - Each reads it through their own character, as one small bounded fold. Competitive or strategic types read it as checked-out or soft (a small threat-down); easygoing types barely react.
   - No number is shown. It can come up in their talk like any witnessed fact.
7. **Waking up.** The narrator gets a short Vault-free "while you slept" view: where the player is, who is in the room now, who has come and gone (presence deltas), and what time of day it is now. It voices only that. It never invents what happened off-screen.
8. **No NPC naps** (Ryne: design first). NPC rest stays as it is.

## Engine and front end

- **Engine:** a `nap({hours})` player lever. It returns `{ slept, wokenBy?: "event" | "evening", whereabouts }`.
  - It is Vault-free and idempotent per `idempotencyKey`, and honours `expectedBeatSeq`, like `turnIn`.
  - Live state gains an OPTIONAL `napHoursToday`: absent until the first nap, set only by a nap (so a game that never naps, and the flag-off path, serialize exactly as before), and reset by `turnIn` AND by the 8am calendar-day transition (`src/engine/liveSeason.ts`), so a player who stays awake through the day change does not keep yesterday's credit.
  - `playerRestDeficit` reads it.
  - Flag `ORWELL_NAP`, default ON (built means on). Off means byte-identical: the lever refuses with "not available".
- **Front end:** it is a model lever named in the narrator prompt, so it needs the five-place FE wiring (tool schema, tags and keep set, engine wrapper, dispatch, `do_nap`) plus a diegetic beat label.
  - An under-call belt mirrors the bed belt: an unambiguous "I take a nap" that recorded no nap calls the lever itself, with the length taken from the words.
  - The g15 `orwellGameChanged` call follows a nap like every other mutation.
- **Not in v1:** an NPC nap; any HUD meter; napping outside the house (jury house, sequester).

## Acceptance

See `0148-player-nap.feature`. Each Then asserts engine state, and each rule has a mutation that turns a scenario red. The deficit tests use the competition's own rest term, never a magic number.

## Open (not blocking)

- How strong the "seen napping" fold should be. Default: small, the same size as a minor scene impression. It is tuned by measurement, never by gating.
