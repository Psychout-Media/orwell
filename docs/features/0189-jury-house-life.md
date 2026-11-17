# 0189 - The jury house has a life (ORW-618)

Status: part 1 built (jurors with each other). Part 2 (the player as a juror, both directions) is designed, not built: it needs a decision on the player wall. Flag `ORWELL_JURY_HOUSE` (existing; no new flag). Played games only (`playedGame === true`); headless calibration is byte-identical.

## What it does
Today jurors only harden, and nothing happens between them. Once per new juror arrival (the existing stretch), the jurors now compare notes: a juror may pass on one thing they themselves hold, the listener comes to hold it a little less surely, and their trust toward its subject moves a little. A juror who now holds that a finalist lied to them learns of any quiet deal break by that finalist through the ORW-597 gate (`learnOfBreak`, once), which applies the betrayal reaction. It is a chill house: small changes, scaled by each juror's own personality (ORW-582: easygoing jurors are open and move more, grudge-keepers pass less on and move less).

## Rules (tunables in `JURY_LIFE`, `src/engine/juryHouseConstants.ts`; the planner is `src/engine/juryNotes.ts`)
- What can be shared: a juror's own lied-to-me, targets-me, allied-with and the going-after / talking-about / lying rumors. Never a read of who voted against whom, a vote promise, a vote the holder deduced, or anything the holder does not hold. Secret ballots stay sealed until the 0048 retrospective.
- One seeded roll per talking pair and direction (the jury-house graph, `JURY_HOUSE.affinityEdge`), on its own side stream `jury-life:<seed>:<stretch>`. At most 4 notes per stretch.
- A passed-on belief lands at 0.85 of the teller's confidence, origin "told", source the teller. An adverse one moves the listener's trust toward the subject by 0.05 x confidence x the listener's personality multiplier, capped at 0.12 per (listener, subject) over the whole stay (read back from the recorded impact; nothing extra persisted), and the recorded impact keeps the belief refutable.
- One rule keyed on holder and subject: the player and an NPC finalist are treated alike.
- State change only. The narrator voices it later from facts; the engine writes no player-facing text.

## Part 2: the player as a juror (not built)
See the PR notes. The player is not a node in the jury house on purpose (no pathway reaches the player). Two-way play needs the existing room-scene claim path (`tellsYou`, currently switched off in jury mode) and the player's own spoken claims, with jurors as speakers; that touches a player-channel projection, so it waits for the wall decision.

## Gates
BDD `0189-jury-house-life.feature` and `tests/unit/juryLife618.test.ts` (sharing, lie discovery once, bounded shift, sealed ballot, personality, parity, byte-identity flag off and headless, snapshot, wall).
