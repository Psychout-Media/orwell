# 0193 - The endgame changes the rules of trust

Card: ORW-623 (approved by Ryne 2026-11-17, Fable pitch #8). Executable spec: `0193-endgame-trust.feature`. Unit gates: `tests/unit/endgameTrust.test.ts`.

Summary: at four houseguests left or fewer, every relationship becomes "can I beat you?". Each houseguest weighs their own odds against every rival at a final two, and that read pushes their nominations and their vote. It also tilts how sincerely they reassure someone, and old final-two promises get tested out loud. Ryne approved it on 2026-11-17 (Fable's pitch 8). Flag `ORWELL_ENDGAME_TRUST`, default ON (`=0` is byte-identical). Played games only. Engine-only: nothing is shown as a number.

## The read: can I beat you?
- `beatShare(me, rival)` is `me`'s OWN estimate of their share of the jury's votes against `rival` at a final two.
- Each juror leans to whoever they are closer to, as `me` can see it: the perceived-bond reader (0163). `me` knows a juror's warmth toward themselves; between two others, they see only what they witnessed or were told.
- The public comp record counts too: each win of difference is the same step the NPC final HOH uses (`juryMinds`).
- With no jurors yet, the record alone decides.

## Where it bites
1. **The vote.** A new last term, `endgame`, in `voteChoice`: a voter pushes out the nominee they can't beat (`endgamePush = 1.2 x (0.5 - share)`) and keeps the one they can. At the final four the veto holder is the only voter, so this is that houseguest's call.
2. **Nominations.** The same term ends the nomination read, the replacement pick included: the HOH puts up who they can't beat.
3. **Reassurances.** When an NPC reassures someone they can't beat, the assurance's faking chance rises (`endgameFakeLean`, only ever adds). A later vote against them breaks it, with B4's full cost.
4. **Final twos tested out loud.** Once per endgame week, after the eviction result, each NPC side of an open final two asks the other:
   - an NPC partner answers with a fresh `vote` reassurance on the assurance ledger, its sincerity the engine's call;
   - a player partner is pulled aside and asked to their face whether the final two still stands, and the answer is the player's own words.

The final HOH's eviction already weighs jury odds (`juryMinds`, ORW-318); this extends the same question to the final four's other decisions.

## The player in both directions
- **The player's play moves the house.** The player's comp wins and their bonds with the jury make NPCs read them as harder to beat, so the house targets them at the final four.
- **The house moves on the player.** An NPC holding a final two with the player asks them about it to their face; the reassurances NPCs give the player carry the same endgame lean.
- **The player is never pushed.** Their own vote and nominations stay their own call, and the engine never speaks for them.

## The wall
- Every read is the decider's own. The jurors' bonds go through the perceived reader, never the hidden edge between two others.
- No numbers reach any view.
- No list feeds a random, hash or modulo pick.

## Measured
- The 12-season mix guard measures week 1, so it can't see the final four.
- Jury reach and the gradient run headless (`playedGame` off), so they cannot move.

Tests: `tests/unit/endgameTrust.test.ts`, `0193-endgame-trust.feature`.
