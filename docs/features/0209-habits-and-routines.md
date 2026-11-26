# 0209 - Habits and routines (ORW-651)

Card: ORW-651 (Ryne approved 2026-11-17): "each houseguest has habits and routines (mornings and beyond) from their backstory, shaping where they are and what they do". Executable spec: `0209-habits-and-routines.feature` (spec-only until the build). Foundation: `src/engine/routines.ts` + `tests/unit/routines.test.ts` (built, BDD Auditor). The build: Overseer A or B, through the Coordinator.

## What exists today, and why it changes
- `houseLife.ts` `HABITS`: 11 fixed habit names (`early-riser`, `gym-rat`...), 2-3 per houseguest from a hashed pick leaned by archetype (`habitsFor`). `npcMindsAuthored` lane 1 lets the model choose from the same 11.
- That is a closed menu feeding a seeded pick, which the no-short-lists rule (Ryne 11-17) rules out. It also can't say "stargazes in the backyard like back on the farm"; it isn't from the backstory.

## The model (foundation)
- **A routine is composed:** a time of day, a room, a house-life action (~40), a company (alone, a regular, whoever) and a strength. With the authored words (`gist`), it comes from the backstory.
- **Authored first:** the cast-authoring model writes 2 to 4 routines per houseguest from their public profile. `validRoutine` checks each against the house and drops a bad one; it never repairs it into another.
- **Floor:** with no model, `composeFloorRoutine` builds them from the character's leanings, with each dimension on its own keyed roll. That's hundreds of possibilities, not a menu.
- **Pull:** `followsRoutine(routine, now, stressed, roll)`. It is weaker under stress (`stressedShare`): routines slip when the game bites.
- **Morning:** `upBeforeTheCall` (a strong morning routine) means up before the 8am house wake-up (Ryne 11-06).
- **Learning:** `knowsRoutine(daysSeen)`: an onlooker knows a routine after seeing it on 3 separate days.

## Build seams
- **Authoring:** extend lane 1 of `npcMindsAuthored` (the FE cast-authoring write-back) to return `routines` in place of `habits`, validated by `validRoutine`. Keep reading old saves' `habits` by mapping each to a routine (its action and time from today's `HABIT_ACTION`; place from the action), so no save thins.
- **Store:** `live.routines?: Record<EntityId, Routine[]>`, set at cast warm, persisted.
- **House life:** replace the habit branch (`houseLife.ts`, the `HABIT_ACTION` pick) with `followsRoutine`. When it fires, the holder moves to `place` (through the movement seam, 0076/0009, never a teleport) and takes `action`; with `a-regular`, the build resolves the regular (their closest bond awake and free).
- **Presence:** the off-screen tick consults routines for where NPCs are when no agenda step claims them. The morning anchor (slice 7.1, if carded) reads `upBeforeTheCall`.
- **Learning:** `live.routineSightings?: Record<holder, Record<routineKey, Record<onlooker, day[]>>>` from house-life onlookers (own-view: only scenes the onlooker registered). For the player as onlooker, a known routine becomes a fact the narrator may voice ("they're usually out back after dinner").
- **The player:** the player's routine is never assigned. NPCs count where they see the player by time of day; once `knowsRoutine`, an NPC agenda step that seeks the player goes there.
- **Evolution:** routines may change with the season (0041 evolution: a shaken houseguest drops one). This is optional for v1.
- **Flag:** `ORWELL_ROUTINES`, default ON. Played games only; headless keeps `habitsFor` (byte-identical calibration).
- **Measure:** the 12-season mix (where people are changes who meets whom); report the share of scenes driven by a routine.

## The rules
- The player in both directions (above).
- No short lists: routines are composed or authored, never drawn from a habit menu. The narrator words them from the gist or the action and place.
- The wall: routines are engine-held. The player knows one only by seeing it.
- Never shown as numbers.

## Built 2026-11-18 (ORW-651, Overseer B): the engine slice
- **What is live:** in a played game with `ORWELL_ROUTINES` on (default ON), each houseguest's routines replace the named-habit branch of `chooseHourAction`. `HourView.routines` present = the routine pull (`routineNow`: one keyed roll per routine at the current time of day, strongest first, weaker on the block or below mood 0.35); absent = the old habit branch, byte-identical. A step that is a routine carries `routine` (its key), so the caller can count sightings. The holder walks to the routine's place by the existing one-hour presence move (never a teleport) and takes its act; company is whoever is already in that room, a `a-regular` company is the closest-bond awake houseguest and only if they are already there.
- **Authoring chosen:** the engine floor (`floorRoutinesFor` in `houseLife.ts`): two to four routines, each a different act drawn from the action library's ordinary-life acts (derived from `ACTIONS`, not listed; the archetype's lean adds a bonus as the old habit draw did), at a time the act naturally belongs to, in the act's own usual place or a rolled shared room, alone or shared, every part its own keyed `agendaRoll`. Where the cast-authoring habits landed, `routinesFromHabits` maps each to a routine (its own act, one of its own times, strength = the old habit chance), so nothing authored thins. A live model write-back of free-form routines (`gist` words, from the whole backstory) is NOT built: it is the next lane; the floor stands in and says `floor`. (ORW-825)
- **Store:** `live.routines` (composed once on first use, never replaced or thinned) and `live.routineSightings` (the days the player has seen each routine kept), both Vault-class, persisted with the season, never projected, and listed as chat-side keys so they never count as the live loop moving.
- **Learning:** when the player is awake in the room a routine puts its holder in, that day counts; on the third separate day the player is handed one third-person fact (the holder's name, the room, the time of day, the authored words or the act) through the knowledge layer as something witnessed, and the narrator words it. Amended from the first sketch: sightings are the player's only (`holder -> key -> days`); NPCs learning where the player usually is, and seeking them there, is a follow-up. (ORW-825)
- **Not built (follow-ups):** the morning anchor (`upBeforeTheCall`, slice 7.1 is not carded: the awake set already refills toward 8am), routine changes with evolution, a hidden mood signal when a routine is broken (the spec asks for none), the NPC-seeks-the-player half. (ORW-825)
- **Measured (12-season house mix, week 1):** flag off 34.6 / 31.4 / 28.5 / 5.5 (the reference). Flag on 31.0 / 35.3 / 27.2 / 6.6 (bonding / strategy / gossip / conflict): within the guard. A routine hour replaces a free hour that was bonding-heavy, so the floor keeps routines firm (strength 0.9 to 1) to hold the mix; weaker routines cost bonding scenes (strength 0.45 to 0.75 measured 26.0 bonding). The jury-reach calibration gate is unchanged (played-only).
- **Routines change with the houseguest (ORW-980, built):** a houseguest put on the block sets one routine aside and takes up another (once a week, at most twice a season, never below two routines kept). Additive: the set-aside row stays with `retiredWeek` (it no longer pulls in `routineNow`, but what onlookers learned of it stays true and the sighting stores are untouched), the new row carries `sinceWeek`. The new act is one they have never kept, each part a keyed `agendaRoll`; no model call, no shared rng. `ORWELL_ROUTINE_CHANGE`, default ON, played games with routines on only. The snapshot guard refuses a save that un-sets a set-aside routine. Only a nominee's hours can differ from before.
