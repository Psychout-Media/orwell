# 0208 - Seasons that remember (Theme B, ORW-662)

Card: ORW-662 (Ryne approved all three slices 2026-11-18). Executable spec: `0208-seasons-that-remember.feature` (spec-only until the build). Foundation: `src/engine/seasonMemory.ts` + `tests/unit/seasonMemory.test.ts` (built, BDD Auditor). The slices: Overseers A and B, through the Coordinator.

Ryne's rules (2026-11-18): the player chooses to start new or return; returning brings reputation. "Old players can return no matter what. One from your old season or not." Returning NPCs must be real NPCs from seasons this player actually played: "don't make a returning player as simply as part of a backstory".

## What exists today
- **0104 notoriety:** `UserNotorietyStore` (per user, survives `registry.resetUser`), `deriveNotoriety` at season end, `notorietyBias` on day-one reads with a per-NPC recognition. B2 builds on it.
- **`priorSeasonNames`** (cast genesis) keeps new casts from reusing past first names. A returner is the one deliberate exception.
- **The 0048 retrospective** unseals a finished season to the player. B3 reads only that.

## The choice (all slices)
- **Seam:** `createCharacter` gains `start?: SeasonStart` (`"new"` default for a first season; the FE asks on every later season). `reputationApplies(start)` gates notoriety bias (B2) and returners (B1). Starting new is a clean slate.

## B1: a face from a past season
- **Archive (new port, like `UserNotorietyStore`):** `UserSeasonArchive { read(user): ArchivedHouseguest[]; append(user, entries) }`. Written at the season-end terminal, beside `accumulate`. Per user, never cross-user, survives `resetUser`, append-only (non-degradation).
  - Each NPC's entry: their static CHARACTER snapshot (`characterRef`), their placement, juror flag, end feelings toward the player (`endToward`, from the live model at the crown) and their own claims about the player (`carriedClaims`: witnessed first, capped).
  - The archive is engine-only (it holds hidden-layer reads). Never projected.
- **Casting:** on a return, `castsReturner(start, archive.length, keyedRoll)`. If true, `pickReturner(pool, castIds, keyedRoll)` replaces one generated NPC with the archived CHARACTER (a fresh id-map entry; the name may repeat by design).
  - Seed their edge toward the player from `softenedFeelings(endToward, seasonsSince)`.
  - Their carried claims enter the claims system as their own beliefs (origin `witnessed` or `told`, as carried). They spread only by the usual pathways (`tellClaim`, rumor mill). The player hears them only in a scene.
  - Played games only; headless casts are byte-identical.
- **Narration:** the narrator gets "this houseguest played with you in a past season" as a fact to voice; never a script.

## B2: your reputation walks in
- On a return, 0104's bias applies, as today. On a new start, it is off.
- Add 0184's broken-word record (part 1's standing) to `deriveNotoriety`'s treachery input, so a deal-breaking season reads warier next time.
- "Who knows of it" stays 0104's per-NPC recognition. A returner always knows.

## B3: the hall of fame
- At season end, append `hallEntry(season, placement, juror, {winnerId, bestMoveEventId, worstBetrayalEventId})` to a per-user list (the same archive port, or a sibling).
  - The highlights are event ids from the retrospective the player has already seen. The FE words them; no fixed glosses.
- **Read tool:** `hallOfFame()` on the player channel, Vault-free (a boundary test through `McpServer.callTool`; the four-place write-back rule does not apply, but a read the narrator prompt names needs the five-place FE wiring). The FE shows it outside the game.

## Flags and measures
- **Flag:** `ORWELL_SEASON_MEMORY`, default ON.
- **Measure:** B1 and B2 change day-one reads only on a return, so jury reach and the gradient (single seasons, headless) can't move. B1 needs a two-season test: finish one, return, assert the returner is a real past NPC and starts colder or warmer as they ended.

## The rules
- The player in both directions: the player chooses new or return; returners treat the player as they ended, warm or cold.
- No short lists: no player-facing words from a list.
- The wall: the archive is engine-only; the hall of fame holds only what was already unsealed; a returner's account reaches the player only in a scene.
- Never shown as numbers.
