# 0207 - Showmances and attraction (Theme A, ORW-657..661)

Cards: ORW-657 (theme), ORW-658 A1, ORW-659 A2, ORW-660 A3, ORW-661 A4. Ryne approved all four slices 2026-11-18. Executable spec: `0207-showmances.feature` (spec-only until the build). Foundation: `src/engine/attraction.ts` + `tests/unit/attraction.test.ts` (built, BDD Auditor). The slices: Overseers A and B, through the Coordinator.

## What exists today (build on it, don't duplicate it)
- **Seeded showmances** (`seededRels.showmances`, 0059): engine-picked couples with stages; `showmancePartnerOf` feeds house life's flirt/cuddle (`houseLife.ts`, `v.showmance`).
- **The orientation rule** `diversity.ts#showmancePlausible` (both sides). `canBeDrawnTo` is the same rule read one way; keep them in step.
- **Romance scenes** fold as `showmance` (`bondRecord`: `romance` count, `warmth`; kind `showmance` at `BOND.showmanceScenes`). Faked distance (0184 2b) already hides romance scenes from onlookers.

## The model (foundation)
- **Attraction is one-sided and private.** A can be drawn to B whatever B feels, only within A's own orientation (`canBeDrawnTo`).
- **Chemistry** is a ceiling per ORDERED pair from its own keyed roll (`chemistryOf`): most pairs none (`ATTRACTION.chemistryShare` 0.2 of eligible pairs have any).
- **It grows with time together** (`attractionNow`, `growthPerDayTogether` per shared day) and never past the ceiling.
- **It shows only in behaviour:** who someone seeks out (`seekPull`), sits near, protects. Never a number or a label, never a list of lines; the narrator voices it.

## Slices and seams
- **A1 (ORW-658) attraction in house life.**
  - Store: `live.chemistry?: Record<chemistryKey, number>`, drawn once at season start on a keyed side stream (one roll per ordered pair; headless byte-identical: played games only), plus days-together counted from shared house-life scenes.
  - House life: add `seekPull(attractionNow(...))` to the partner score when choosing whom to spend time with; flirt/cuddle can start from a mutual-enough attraction, not only a seeded showmance. Seeded showmances stay (they start with chemistry already high).
  - The player as object: an NPC can be drawn to the player only once the player has stated their gender (casting or later); undefined means never. The player's own attraction is never modelled.
- **A2 (ORW-659) the couple is a target.**
  - `readsAsCouple(perceivedBond, romanceSeenOrTold)` per reader: own-view perceived bond (ORW-574) plus a romance scene the reader registered or a told claim.
  - Nominations: an HOH outside a pair it reads as a couple adds `coupleNomPush` to one of them. Measure with the stacking report (a new decision term).
- **A3 (ORW-660) heart against game.**
  - At a vote where the partner and an alliance pull apart: `heartWins(romanceTie, allianceTie, mutual)`; the loser tie takes a strain either way (shaken).
  - Breakup: `BREAKUP` deltas (deeper than `BETRAYAL_SHOCK`), a grudge-book entry (ORW-607), the showmance stage to resolved.
- **A4 (ORW-661) the player's showmance.**
  - `playerShowmance(scenesThePlayerStarted, npcDrawnToPlayer)`: only by the player's own acts, answered by an NPC drawn to them. The engine never decides it.
  - Then the house notices (as A2), the partner expects loyalty (a broken expectation is a betrayal, ORW-646's claims path), rivals use it. An NPC the player turns down reacts in character (narrated, from their profile).
- **Flag:** `ORWELL_SHOWMANCES`, default ON, sorted into the flag files.
- **Measure:** the 12-season mix (romance share will rise; say by how much), the stacking report for A2/A3, jury reach and gradient unchanged (played only).

## The rules
- The player in both directions: NPCs can be drawn to the player and the player can start one; never assume the player's gender or orientation.
- No short lists: no player-facing words from a list; the narrator voices attraction from behaviour.
- The wall: attraction and chemistry are engine-only; a couple is read only from what the reader saw or was told.
- Never shown as numbers.
