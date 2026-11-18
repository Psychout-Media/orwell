# 0208 - Seasons that remember (Theme B, ORW-662)

Card: ORW-662 (Ryne approved all three slices 2026-11-18). Executable spec: `0208-seasons-that-remember.feature` (spec-only until the build). Foundation: `src/engine/seasonMemory.ts` + `tests/unit/seasonMemory.test.ts` (built, BDD Auditor). The slices: Overseers A and B, through the Coordinator.

Ryne's rules (2026-11-18): the player chooses to start new or return; returning brings reputation. "Old players can return no matter what. One from your old season or not." Returning NPCs must be real NPCs from seasons this player actually played: "don't make a returning player as simply as part of a backstory".

## Built: B1 (ORW-663)
Returning houseguests are built: the per-user `UserSeasonArchive` (engine-only, append-only, separate subtree), `src/engine/returnees.ts` (the `resolveReturnee` validator, keyed `planReturner`, the softened carry), `createCharacter.start?: "new" | "return"` (the player's own choice; unknown values refused typed at the tool door; absent = today's `keepCharacter` behaviour), flag `ORWELL_SEASON_MEMORY` (default ON). A returner keeps who they are (identity, personality, backstory, voice, age, look: the archived public persona, never the hidden layer) and their feelings toward the player, softened by the seasons since; goals, agenda, plans and secrets in play are fresh for the new season, and no past event is invented. Scenarios: `0208-returning-houseguests.feature`. Not built: the FE choice UI and FE tool-schema entry for `start` (a follow-up); B2 and B3.

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

## B2 built (ORW-664, 2026-11-18; flag `ORWELL_SEASON_MEMORY`, default ON, the one flag for all three slices)
- **What changed.** At the season-end terminal, `openSetOutcome()` (played games with reputations on) adds `houseHeardWrong`: the mean share of standing the player lost across the cast (0184 part 1: what each houseguest heard or saw of them lying to or turning on people, softened by kept promises). It is a bounded summary of what spread through the house, never a belief, name or number shown.
- **How it carries.** `deriveReputation` adds it to the treachery facet (`NOTORIETY.derive.brokenWord`, clamped), so the existing 0104 day-one lean (trust down, threat up, shaded by archetype, scaled by each NPC's own recognition, some distorted) reads warier. When the house clearly heard it (`NOTORIETY.brokenWordKnownAt`), the legend gains one clause the narrator voices at the premiere through the existing "RETURNING CAST" board line. No new prompt text.
- **Only on a return.** Nothing new reads on a new start: no notoriety is set, so day one is byte-identical. The carry is still 0104's `carriesNotoriety` door (`keepCharacter`); B1's `SeasonStart` must map `start === "return"` to it (`reputationApplies`), and the player's choice to return as a past character stays the only way in. Unchanged by B2: cross-user isolation, the wall, the per-user monotonic store.
- **Seeds.** No new rng. The day-one bias keeps its dedicated `:notoriety` stream; the broken-word record is a pure read at the cutover.
- **Off.** Flag off (or a game nobody plays, or reputations off): the field is absent and every derived summary is today's.
- **Tests.** `tests/unit/seasonMemoryReputation.test.ts`; executable scenarios in `0208-your-reputation-walks-in.feature` (step prefix `reputation:`).
