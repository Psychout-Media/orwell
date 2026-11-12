# 0146 - NPC minds: the model's words (ORW-253 slice 5) and "the house you never saw" (slice 7)

> **Status:** spec, approved design (vault "NPC Minds Design Theme 1", Ryne 2026-11-12). Built by the overseers to this spec.
> **Rules every lane follows:** ADR 0022 (the model proposes SHAPE as structured data; the engine decides), ADR 0019 (each call sees only
> what THAT houseguest knows), the Vault Wall (every output is engine-side; nothing here writes player-facing text), the leak harness
> (ORW-307) on every call, the utility model only, and Ryne's answer 2 (2026-11-12): **if a call fails, retry once; if it fails again, skip
> that item, the engine's own version stands, and raise an admin alert.** The engine always has its own habits, aims and reasons, so a
> failure never blocks play and nothing is invented to cover it.

## Why
The engine decides every goal, action and reason (slices 1-4, 6). What it cannot do is read a free-text backstory or write prose. Ryne:
"Fable should also get creative and look for ways even this can be expanded" (2026-11-11) and said yes to house culture and "the house
you never saw" (2026-11-12).

## Lane 1: habits and a season aim from the backstory (once per houseguest, at cast creation)
- **When:** right after the deep backstories (0058) are written; part of the required start-of-season work (no-fallback rule, ORW-260):
  the call is required, but per answer 2 a second failure keeps the engine's `habitsFor` / `seasonLeanOf` and alerts the admin.
- **Input:** that houseguest's own profile (public facets, biography, vocation, hometown, identity concept, their own hidden elements).
- **Output (validated JSON):** `{ habits: Habit[2..3] from the closed set, aimHint: SeasonGoalKind, aimWhy: string <= 80 chars }`.
- **Engine use:** habits replace `habitsFor` for that houseguest (persisted once); `aimHint` ADDS `MODEL_AIM_BONUS` (0.4) to that aim's
  lean in `seasonLeanOf` (it shapes, never forces). `aimWhy` is Vault, kept for the retrospective.

## Lane 2: house culture (once per season)
- **Input:** the cast's PUBLIC facets and the world snapshot (0062). Never anyone's hidden elements.
- **Output:** `{ spots: up to 3 x { room: Room, nickname }, rituals: up to 3 x { timeOfDay, action: ActionKind (house-life family), name },
  runningJoke: string <= 80 chars }`.
- **Engine use:** a ritual adds `RITUAL_PULL` (0.3) to that action at that time of day for anyone free (slice 3's house-life branch);
  spot nicknames and ritual names are PUBLIC (the narrator may use them once the player has been in the house when one happened).
  The running joke is public once the player has witnessed a scene where it came up.

## Lane 3: the nightly reflection (per houseguest, during the sleep mull)
- **When:** inside the nightly `mullAgenda` (asleep: inner processing only, never scheming).
- **Input:** that houseguest's agenda (their own goals and reasons), their memories, and today's events THEY witnessed or were told.
- **Output:** `{ order: goalId[] (a permutation of their active goal ids), reflection: string <= 60 words, first person }`.
- **Engine use:** the order nudges commitments by at most `REORDER_NUDGE` (0.1) toward that ranking; it never adds, removes or resolves a
  goal. The reflection is Vault and kept on the agenda history for the retrospective. Cost: about 15 calls a game night.

## Lane 4: wording for scenes that can reach the player
- **Which scenes:** only off-screen scenes a pathway can later carry to the player (a participant may gossip about it, it was overheard,
  it feeds the recap of something the player learned, or the retrospective). Reuses the 0070 texture lane.
- **Input:** the scene's structured record (actions, places, manners, who said what, truthful or not) and the participants' public facets.
- **Output:** 1-3 sentences, stored Vault on the event. It reaches the player only as a participant's retelling through a pathway (theme
  2), never as narration of the hidden scene.

## Slice 7: "the house you never saw" (the post-season retrospective)
Ryne 2026-11-12: "who are these people really that I didn't see? Basically, I want that limited perspective to be broken in the season
retrospective." The 0048 retrospective (already a sanctioned unsealing, post-season only) gains, per houseguest: their season aim and
why, each goal in order (what they wanted, from when, how it ended), their real reasons next to what they SAID for each big decision
(nominations, veto, votes, final HOH) with the lies marked, their long con if they ran one, and their nightly reflections. Same door, same
limits: only after the winner is crowned; never during play; never admin during play (producerVault excepted, as today).

## Cost (estimate; measured only with Ryne's OK on a capped run)
About 30,000 tokens in and 6,500 out per game day for lanes 3-4 (lanes 1-2 are once per season), about 1 cent a game day, under
1 dollar a season, on the cheap utility model.

## Gates
Each lane: the ORW-307 harness (per-call scope, fan-out pairing, data-only output, funnel confidentiality); a malformed-output test (two
failures => skipped + one admin alert + the engine version stands); the engine never lets an output change an outcome beyond its stated
bonus (mutation: double the bonus and a pinned decision changes). Slice 7: the retrospective sentinel (nothing of it appears before the
season ends) and a content test (a planted long con, a lie and a reflection all appear after it ends).
