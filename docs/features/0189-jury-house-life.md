# 0189 - The jury house has a life (ORW-618)

Status: built, parts 1 and 2. Flag `ORWELL_JURY_HOUSE` (existing; no new flag). Played games only (`playedGame === true`); headless calibration is byte-identical.

## What it does
Today jurors only harden, and nothing happens between them. Once per new juror arrival (the existing stretch), the jurors now compare notes: a juror may pass on one thing they themselves hold, the listener comes to hold it a little less surely, and their trust toward its subject moves a little. A juror who now holds that a finalist lied to them learns of any quiet deal break by that finalist through the ORW-597 gate (`learnOfBreak`, once), which applies the betrayal reaction. It is a chill house: small changes, scaled by each juror's own personality (ORW-582: easygoing jurors are open and move more, grudge-keepers pass less on and move less).

## Rules (tunables in `JURY_LIFE`, `src/engine/juryHouseConstants.ts`; the planner is `src/engine/juryNotes.ts`)
- What can be shared: a juror's own lied-to-me, targets-me, allied-with and the going-after / talking-about / lying rumors. Never a read of who voted against whom, a vote promise, a vote the holder deduced, or anything the holder does not hold. Secret ballots stay sealed until the 0048 retrospective.
- One seeded roll per talking pair and direction (the jury-house graph, `JURY_HOUSE.affinityEdge`), on its own side stream `jury-life:<seed>:<stretch>`. At most 4 notes per stretch.
- A passed-on belief lands at 0.85 of the teller's confidence, origin "told", source the teller. An adverse one moves the listener's trust toward the subject by 0.05 x confidence x the listener's personality multiplier, capped at 0.12 per (listener, subject) over the whole stay (read back from the recorded impact; nothing extra persisted), and the recorded impact keeps the belief refutable.
- One rule keyed on holder and subject: the player and an NPC finalist are treated alike.
- State change only. The narrator voices it later from facts; the engine writes no player-facing text.

## Part 2: the player as a juror (built; Auditor-approved design, six conditions)
The player is still not a node in the juror-to-juror sharing. The two-way play rides the existing claim machinery (no new tool, read or projection); played games only, flag `ORWELL_JURY_HOUSE`, and only while the player holds a juror's seat.
1. **The sequester.** `claimProblem(input, living, jury?)` (`src/engine/spokenClaims.ts`) widens only in the jury house and only for a pair where both the speaker and the listener are jurors (the player counts only when the player is a juror). A juror never speaks to or hears from anyone still in the house. What a claim is about may still be a houseguest. The pool is `GameSessionAdapter.juryPool()`; with no pool the house rule is unchanged.
2. **Juror to player.** The existing `claimsToPlayerFor` decision (`decideTellToPlayer`, `sayable`) now also runs for each juror: they confide one belief they hold (never refuted, never about the player), as the same `tellsYou` fields (kind, names, certainty band). No planted lie in the jury house. The real ballot is never a source: only beliefs are read.
3. **Player to juror.** The player's own words, caught by the open ledger as a claim, go through the existing `tellClaim`; the engine gives it its truth from its records, so a false one is a lie on the record, catchable like anyone's. In the jury house the ledger's room is the jury house, its present set the jurors, and an entry naming anyone still in the house is refused. The engine never authors the player's claim.
4. **One side stream.** The decision's own key with a `jury:` salt; the house's key is unchanged, so in-house rolls do not move.
5. **The wall.** Nothing new crosses a boundary; a test calls the tool boundary on a juror-player's game.
6. **Finale integrity.** No claim kind can carry a jury ballot; what jurors say does not depend on the recorded final votes; the tally stays the engine's alone.

## Gates
BDD `0189-jury-house-life.feature` and `tests/unit/juryLife618.test.ts` and `tests/unit/juryLife618Player.test.ts` (sharing, lie discovery once, bounded shift, sealed ballot, personality, parity, byte-identity flag off and headless, snapshot, wall).
