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

## Amendment 2026-11-18 (ORW-636 follow-up): the couple term never fired; why, and the fix
The stacking report found `nomination-*.couple` and `replacement.couple` never non-zero in played chat-paced seasons. A funnel over 8 seeds x 1500 messages (`tests/calibration/coupleFunnel.test.ts`, report only, `ORWELL_COUPLE_FUNNEL=1`) showed every upstream stage working: 17-30 ordered pairs per season with attraction at or above the flirt bar, 2-68 romance scenes (flirt/cuddle) in 1-3 pairs, most of them seen by someone, and 6-23 reader/pair combinations per season that had caught a romance. It dropped to zero at the last stage: **no reader's own-view perceived bond of a pair ever reached 0.65.** Cause: a houseguest's read of two OTHERS is the edge baseline (0.25) plus `floaterBondSpan` (0.35) times what they saw, so it tops out at 0.60; the foundation's `coupleBondAtLeast` (0.65, on the whole 0..1 bond scale) sat above the ceiling of the read it was judged against. The existing unit tests stubbed `perceivedBond` to 0.9, which hid it.
Fix (wiring/scale, no new flag, flag off byte-identical): in a played game with the own-view read on, `couplePushFor` judges the pair on the read's own scale, `readsAsCoupleOwnView` (`attractionLife.ts`): the share of the way from the baseline to the ceiling must be at least `ATTRACTION_LIFE.coupleReadShare` (0.7, three net warm scenes watched, plus a romance seen or told). The blended unplayed read keeps the foundation's bar. `coupleNomPush` (0.25) is untouched. Proof: a unit test with a real (unstubbed) read, red on main.

## Amendment 2026-11-19 (ORW-733, Vault Wall): the browser never receives the house-known showmances
A season-2 playtest found `/api/orwell/state` carrying `showmances: [{a, b}]` for a pair the player had seen nothing of (the producer said there was none to miss). The engine's state read lists the showmances at stage `visible` ("the house knows") for the NARRATOR to voice; no screen reads the field, and the house knowing is not the player having seen it. Fix at the projection seam, no flag (OFF would reintroduce the leak): the front-end route now cuts the state to a closed set of top-level keys (`_BROWSER_STATE_KEYS`, `frontend/routes/orwell_routes.py`), the same shape as ORW-707's per-houseguest set. Dropped by construction: `showmances`, `notorietyLegend`, `returningHouseguests`, the Diary-Room and producer cues, open deal offers and vote pitches, owed favors, `alliances`, `playerDossier`, the jury house, the required lever and the other narrator-only keys. A new engine field reaches the browser only when a screen needs it and it is added to the set. Proof: `frontend/tests/test_orw733_unseen_showmance_wall.py` (sentinel with a positive control) and the top-level closed-set test in `test_orw707_browser_state_wall.py`. The narrator's own read is unchanged. Open: the narrator is still told a `visible` pair is public to the house even if the player has not witnessed it; whether the narrator should wait for the player to see or be told is a follow-up.
