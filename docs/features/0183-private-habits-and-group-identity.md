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

**Ruling (the Coordinator, Vault Wall): words are authored lazily at reveal; hidden groups are never described to any model.** No hidden membership leaves the
engine before the player could know it, not even to the utility model. `groupsAwaitingWords` (an FE-driven infra read) lists ONLY groups the player could already
know about: an alliance whose `knownTo` includes the player (witnessed, told or exposed; never one the player belongs to, the narrator names those), or a pair habit
the player saw (they were in the room; the entry's `seen` flag). Anything hidden keeps the engine floor (a placeholder nobody sees), is not mentioned by the read at all
(no ids, no members), and `recordGroupIdentity` refuses it (`unknown-group`). It gets its words the first after-turn read after the player learns of it. The post-crown
retrospective (a sanctioned unsealing) is part (d). Not built: a pair habit the player only heard about through a claim (no hook yet; the habit is listed once seen). (ORW-825)

`recordGroupIdentity {groupId, name?, ritual?, signal?, insideJoke?}` is the FE-driven write-back (both tools are infra levers, not model levers, wired in all four places).
After a turn the FE driver (`frontend/src/orwell_group_identity.py`) makes one cheap utility call per listed group from the members' PUBLIC cards, the culture and the
room, retries once, and writes back. The engine validates every string with `validateGroupIdentity` (the shared `cleanText`), keeps the first record per group id
(write-once, monotonic over the floor), caps the season at `maxAuthoredPerSeason` groups, and may rename the alliance ONCE (its `formed` history entry keeps the floor
name; a name that collides or is a houseguest's name is dropped and the other words still land). The prompt states rules, never a menu or sample. No model, or two failed
calls: the floor stands and an admin alert is raised. `ORWELL_GROUP_IDENTITY=0` disables the driver and the write-back. The words stay in `live.groupIdentity` (engine-only).

## Not in this part (TODO)

- (c) is built (ORW-566 part c): see "Part c" below.
- (d) is built (ORW-566 part d): see "Part d" below.
- The Auditor's shared bond reader replaces `BondReader` when it merges.

## Part c2: formation-time alliance naming (the anonymized sealed-prompt door)

Ruling: every alliance, the ones only its members know included, gets a name when it forms, chosen by its members and authored live from their shared facts with no
list. Finding out an alliance's name is later ammunition (it spreads as a claim in the Theme 2 slice; this part only STORES it and exposes nothing).

- **The name is secret content.** `live.groupIdentity[allianceId].sealed = {name, floor, authored}`, engine-only, never on any player or admin read, tool result or prompt.
  The alliance's own displayed name is untouched. The floor is the name the alliance formed with (the house's own words through `allianceNameFromHouse`, else the stock table);
  it is applied at formation, so an alliance always has a name, and it stays the name when no model is available.
- **The door** (`src/engine/allianceNaming.ts`): the engine builds the WHOLE prompt; the FE only ever sees `{ticket, prompt}`. Nothing identifying is in it: no id, name,
  member count, room or day tied to the group; every trait is shared by at least (members + 2) LIVING houseguests (a k-anonymity floor; failing traits are dropped).
- **No timing or count side channel.** Once per in-game night (at the overnight settle) the engine issues a FIXED batch of `batch` = 3 tickets: up to 3 real, padded with decoys
  built from random k-anonymous trait sets, all by keyed `agendaRoll` hashing (never the shared rng, so seeded games stay byte-identical). Every ticket of a night carries the
  same number of traits, which depends only on who is living. More real alliances than slots wait for the next night; the fixed cadence is the cover. Three covers the busiest
  night (the society founds at most one alliance per tick) and keeps the nightly utility cost small.
- **One-way ticket.** `live.nameTickets: ticket -> {kind, allianceId?, issuedNight, prompt}`; single use; last night's unanswered tickets lapse. `recordAllianceName {ticket, name}`
  answers a bare `{accepted:true}` for a real ticket, a decoy and a refused name alike; only an unknown, used or expired ticket answers `{accepted:false}`.
- **Validation engine-side.** `cleanText`, 3 to 40 characters, at most five words, no houseguest's name (anyone's), no collision with any other alliance's displayed or sealed name or the
  avoid list; a refusal leaves the floor for good. Write-once per alliance.
- **Channel.** `allianceNameTickets` (read) and `recordAllianceName` (write-back) are FE-driven infra levers, wired in all four places, not model levers. The FE driver
  (`frontend/src/orwell_group_identity.py`, same after-turn seam and single flight as part c) makes one utility call per ticket (one retry, fail-soft) and learns nothing about any group.
- The prompt states rules only: no sample name, no example line, no quoted word list. Flag: `ORWELL_GROUP_IDENTITY` (no new flag). Played games only.

## Part d: the retrospective's `groupLife` (built)

`RetrospectiveView.groupLife` (`src/engine/groupLifeRetro.ts`, assembled in `GameSessionAdapter.buildGroupLifeView`) rides the existing `seasonRetrospective()` door: behind the `finished` gate,
played games only, `ORWELL_GROUP_IDENTITY` (no new flag); before the crown there is nothing. This is the sanctioned unsealing: hidden alliances appear with their sealed name, and the displayed
name too when it differed (`knownAs`). Per group, facts only: the members' names, the name, ritual / signal / inside joke if authored, the spot, the week it formed and (alliances) the week it
ended with a plain phrase for how, and whether the player knew of it. Never an id, a number or a truth marker; weeks are plain integers. `line` is the composed offline floor (names, name, room,
weeks); the narrator voices it live under rules-only text in the post-season moment fragment (not the base prompt). The FE shows the floor lines under "The groups of the house".
Week stamps (`week`, `endedWeek`) live on the hidden `groupIdentity` entry; an end is stamped at the next night's settle.
