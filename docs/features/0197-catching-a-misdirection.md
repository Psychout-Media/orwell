# 0197 - Catching a misdirection (ORW-631)

Status: built (first slice). Builds on ORW-475 (asking around, `src/engine/askAround.ts`, the `told` answer in the house search). Flag `ORWELL_CATCH_MISDIRECTION` (default ON, `=0` byte-identical), played games only.

## What ORW-475 gave this
A houseguest the player asks about a third person answers from their own record of who they saw go where, and their character sheet decides whether they tell it straight, dodge or mislead. 0197 reuses that decision and its code seam (the `askAround` closure in `houseSearchView`) and adds nothing to how the answer is chosen.

## What it adds
- **A record of every told lead** (`live.toldLeads`, `src/engine/toldLeads.ts`, append-only): who said it, about whom, the room they named, when, and - engine-only, never projected - where the person really was and whether the speaker misled. Written when the answer is given; one lead per speaker, subject and part of day.
- **Settled only by what the player can legitimately see afterwards**, at the next save: the person in view in the named room (the lead held), in view somewhere else, or the named room in view without them (the lead did not pan out). A lead from an earlier day lapses.
- **A plain observed fact** on the player's `whereabouts` read (`leadsFoundWrong`) for a few ticks: who said which room, and where the player found the person if they did. A stale lead and a misleading one read exactly the same (same fields, same words), so the player infers which it was; the engine never says it was a lie.

## Rules
The engine never acts or speaks for the player: whether to call the houseguest out is the player's choice, played in conversation like any scene. No rng and no new draw (the record is written from the existing seeded answer); flag off, a headless game, or no lead given leaves everything byte-identical. Nothing hidden (the true room, the misled flag) reaches the narrator or the player.

## Left for follow-up slices (ORW-825)
An NPC asking another NPC (parity in the other direction); a lever to cite a found-out lead (`confront`) and a standing/credibility cost when the player does call it out; a houseguest's own mood or reputation moving when the player holds a misdirection against them.

## Gates
BDD `0197-catching-a-misdirection.feature`, `tests/unit/catchMisdirection631.test.ts` (pure record, played-game wiring, the wall, flag-off, headless, save/restore).
