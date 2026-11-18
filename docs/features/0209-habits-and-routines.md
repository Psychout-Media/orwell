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
