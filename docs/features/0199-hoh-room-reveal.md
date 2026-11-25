# 0199 - The HOH room reveal

Card: ORW-629 (approved by Ryne 2026-11-17, Fable idea pitch #6). Executable spec: `0199-hoh-room-reveal.feature`. Unit gates: `tests/unit/hohRoom.test.ts`.
Flag: `ORWELL_HOH_ROOM` (default ON, `=0` kill switch). Played games only (`live.playedGame`); a headless game and flag-off are byte-identical (nothing is read, drawn, recorded or saved).

## What it is

When a houseguest is crowned HOH, their room is opened to the WHOLE house, the player included. Not coming is the huge exception and the house reads it as rude. How people feel and behave up there is a signal, by how well they can act.

## How

- Hook: `commit` on the `hoh-competition` beat, right after the lobby pitches (`GameSessionAdapter.recordHohRoom`, idempotent per week and HOH through `live.hohRoom`, saved).
- Everyone alive is invited (`src/engine/hohRoom.ts`, pure, Vault class). Skipping is an engine-decided snub from a keyed `agendaRoll` (never the shared rng): a tiny base chance, more only for a strong feeling against the HOH (squared, capped). The house reads it as
  rude through the existing directed bond move (the HOH most, every other guest a little). The player is never snubbed or moved by the engine.
- Masking: a guest's real feeling toward the HOH (a read of their directed edge and any held grudge) either stays hidden or slips. How well they act is their Social aptitude plus a keyed per-person roll (no trait list, never flat). Only a SLIP is recorded, as a visit
  event with its direction (resentment or fear), never the strength, the mask or the true feeling; the HOH then thinks a little less of them (small, bounded).
- Photos and letter: for a player who came up, one true fact about the HOH is revealed, a keyed pick over the facets that character itself carries (its vocation, hometown, background and biography sentences; never a draft biography, never a repeat). Nothing is
  authored by the engine beyond the stored fact; the narrator voices it.
- The player as HOH: their room is opened too; NPC snubs and slips are observable facts the narrator voices. The player's own choice of whether to go up has no lever yet (deferred). (ORW-825)

## Wall

Hidden (never stored, never projected): the true feeling, the mask skill, every roll. Observable: who came, who skipped, who slipped and which way, the revealed fact. No number crosses.
