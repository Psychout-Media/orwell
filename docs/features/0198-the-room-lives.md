# 0198 - The people in your room live too

Card: ORW-621 (approved by Ryne 2026-11-17, "Yes to all 5"). Executable spec: `0198-the-room-lives.feature`. Unit gates: `tests/unit/roomLife.test.ts`.
Flag: `ORWELL_ROOM_LIFE` (default ON, `=0` kill switch). Played games only (`live.playedGame`); a headless game and flag-off are byte-identical (no room step is planned, drawn, recorded or saved).

## What it is

Until now a houseguest in the player's room took no engine action. The hourly house-life stretch stepped everyone else through their goals, while the people with the player were held still and the narrator improvised. Now the houseguests with the player take their own goal steps there, in the player's view: someone has a word with another, two start up a game of cards, someone needles a roommate. The engine decides and the narrator voices it.

## How

- Where: `GameSessionAdapter.houseLifeStretch` (the same hourly stretch). A room of two or more awake houseguests with the player runs the planner for each (`planFor`, in `room` mode), over a view of that room only. The player is never an actor, never a partner and never moved; a goal aimed at the player still goes through the desire clock, as before.
- What is kept: a step done in company, in THIS room, with houseguests who are in it (`roomLifePlans`). The act keeps its real kind, so it folds through its real interaction type (bonding, strategy, alliance, conflict, gossip, showmance), engine-decided; a showmance step still obeys the existing gates.
- What is recorded (`recordRoomAct`): ONE witnessed event, NOT hidden, the actor first and the player in the witness set. It carries no engine-only `houseLife` record, so the bond record reads the actor and the first partner as the principals and the player (and anyone else there) as bystanders (ORW-609).
  The fold uses its own keyed stream (`hashSeed` over seed, hour, actor, partner), never the shared rng.
- What the player sees (`roomActLine`, the existing action vocabulary plus the manner): house-life and romance acts and clashes show as themselves ("cooked with", "confronted", "(warm)"); a goal step (a pitch, a plant, a plea, a flip) shows as the plain act of having a word with someone. The goal, the subject of a rumor and whether what was said was true never appear. A spoken claim is still decided by the engine and the player hears the words only when they overhear it (0188), on the existing roll.
- How it reaches the narrator, through the existing channels, no new tool, read or projection: the event is in the player's witnessed record (the delta feed, scene recall and the daily recap), and the player holds the same line as something they witnessed (pathway `witnessed`), so the per-turn "what you've learned" block carries it.

## Pacing

A keyed roll (`ROOM_LIFE.chance`, 0.4) decides whether anyone steps this stretch; a keyed rotation says who; at most `perStretch` (1) now and `perHour` (2) per in-game hour, counted from the record so a restart cannot reset it, and a houseguest at most once an hour. The player's own turn stays primary.

## Wall

Hidden (never in the event, the prompt or the player's knowledge): the goal, its kind, the truth of what was said, every roll. Observable: who, with whom, the act, the manner. No number crosses.

## Deferred (ORW-825)

Trajectory folds for room steps (the orchestrator feeds them for hidden scenes only); a room act that makes a houseguest leave because the player walked in; two houseguests whispering as a distinct observable beat.
