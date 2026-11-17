# 0183 - Private habits and group identity (Theme 3 slice 7, parts a and b)

Card: ORW-566 (plan: vault "Theme 3 Slice Plan", slice 7). Executable spec: `0183-private-habits-and-group-identity.feature`. Unit gates: `tests/unit/groupIdentity.test.ts`,
`tests/unit/groupIdentityLive.test.ts`. Flag: `ORWELL_GROUP_IDENTITY` (default ON, `=0` kill switch). Played games only (`live.playedGame`); a headless game is byte-identical.

## What it is

Pairs and groups grow private habits and an identity. A close pair keeps a spot of its own and meets there in the hours after a ceremony; an alliance is named from
the words the house itself authored; a third houseguest who sees the habit starts to suspect the pair. The engine decides; the narrator only voices the scene. Nothing is a
number, a roster or a label ("they are allies" is never said). Everything is hidden state in the Vault class and never crosses to any surface.

Standing rule (Ryne, 2026-11-17): no new short lists. A spot is the best-scoring public room by a keyed roll (a sort, never an indexed pick), words come from the house's authored
culture, and the offline floor is the plain room reference or today's stock name. No prompt text is added in this part.

## Part a: the floor, the habit action, the after-ceremony window

- **`debrief` action** (`houseLife.ts`): house-life family, one partner, folds as `bonding` (the same magnitude class as any bonding scene, so no edge is distorted). It is not a
  valid authored ritual (a pair's own habit, never a house-wide one).
- **Planned in `chooseHourAction`** just before the ritual block, from `HourView.pairHabits?: [{with, room, key}]`. A keyed `agendaRoll(seed, owner, 'habit-pair:'+key+':d{day}h{hour}')`
  against `HOUSE_LIFE.pairHabitPull` (0.4) x the culture's `meetings` dial. No shared-rng draw. The partner must ALREADY be at the spot or it falls through (only the actor moves,
  review of #2850). A view with no `pairHabits` plans byte-identically.
- **Close allies** (`groupIdentity.ts`, one small reader seam `BondReader` to swap for the shared bond reader later): they share an alliance, OR the weaker direction of
  (trust + affinity) / 2 clears `habitBar` = `ALLIANCE.npcAllyFloor x GROUP_IDENTITY.habitFloor` (1.1), divided by the culture's `loyalty` dial (a loyal house keeps habits at a lower bond).
- **The spot** is one PUBLIC room, fixed per pair for the season: the best keyed-score room among the house's own nicknamed rooms when it has authored any, else among all public rooms.
- **The after-ceremony window**: `live.lastCeremonyAbsHour` is stamped (flag on, played game, clock on) when a nominations, veto-ceremony or eviction beat resolves;
  `pairHabits` is built only when the in-game hour is within `GROUP_IDENTITY.windowHours` (3) of it.
- **The identity floor**: `live.groupIdentity?: Record<pairKey | allianceId, {name?, spot?, kind: 'debrief' | 'alliance', since}>`, hidden, write-once (monotonic), persisted optional.
  A habit scene stores the pair's spot (the house's nickname for the room, else the plain room reference). An NPC alliance formed in a played game takes its name from the house's own
  authored words: the nickname of the room its founder stands in, else a ritual name, else the head words of the running joke. With nothing authored it keeps `pickAllianceName`'s result
  exactly (the stock pick is still drawn, so the shared stream is untouched). `alliances.ts` and its stock table are not touched (ORW-509 owns them).

## Part b: suspicion

A habit scene is stamped `houseLife.habit` (the pair key) and keeps the existing `seenBy` (houseguests in the room who were not in the scene). The existing `perceivedBond`
already reads a witnessed bonding scene as a closer pair, so a watcher reads the pair as close. A sibling of `whisperConspicuousPairings` (`whisperHabitSighting`, `houseSuspicion.ts`)
lets the onlooker most motivated to notice start a position-only whisper ("keep ending up in <spot> together after the ceremonies", never what was said) on its own keyed stream
(`house-habit:${seed}:${tick}`), no relationship fold. No Theme 2 claim is emitted.

## The wall

No `groupIdentity`, `pairHabits`, `lastCeremonyAbsHour`, habit stamp or pair key appears in any projection, tool result, `getMomentPrompt` or `inspectNonVaultState`
(tested by a JSON search with a positive control). `groupIdentity.ts` is in the dependency-cruiser denylist beside `houseLife`.

## Part c: the model's words for a group (built)

`groupsAwaitingWords` (an FE-driven infra read: group ids, member ids, a room, the house's authored culture and the names other groups carry) and
`recordGroupIdentity {groupId, name?, ritual?, signal?, insideJoke?}` (an FE-driven write-back) are infra levers, not model levers. After a turn the FE
driver (`frontend/src/orwell_group_identity.py`) asks which groups wait (a new NPC alliance, or a close pair whose habit key was first created), makes one
cheap utility call per group from the members' PUBLIC cards, the culture and the room, retries once, and writes back. The engine validates every string with
`validateGroupIdentity` (the shared `cleanText`), keeps the first record per group id (write-once, monotonic over the floor), caps the season at
`maxAuthoredPerSeason` groups, and may rename an alliance the player does not know of ONCE (the alliance history keeps the old name; a name that collides or
is a houseguest's name is dropped and the other words still land). The prompt states rules, never a menu or sample. No model, or a failed pair of calls: the
floor stands and an admin alert is raised. `ORWELL_GROUP_IDENTITY=0` disables the driver and the write-back. The authored words stay in `live.groupIdentity`
(engine-only); the retrospective line is part (d).

## Not in this part (TODO)

- (c) is built (ORW-566 part c): see "Part c" below.
- (d) the retrospective's words-only `groupLife` field behind the crown gate.
- The Auditor's shared bond reader replaces `BondReader` when it merges.
