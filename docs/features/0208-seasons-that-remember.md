# 0208 - Seasons that remember (Theme B, ORW-662)

Card: ORW-662 (Ryne approved all three slices 2026-11-18). Executable spec: `0208-seasons-that-remember.feature` (spec-only until the build). Foundation: `src/engine/seasonMemory.ts` + `tests/unit/seasonMemory.test.ts` (built, BDD Auditor). The slices: Overseers A and B, through the Coordinator.

Ryne's rules (2026-11-18): the player chooses to start new or return; returning brings reputation. "Old players can return no matter what. One from your old season or not." Returning NPCs must be real NPCs from seasons this player actually played: "don't make a returning player as simply as part of a backstory".

## Built: B1 (ORW-663)
Returning houseguests are built: the per-user `UserSeasonArchive` (engine-only, append-only, separate subtree), `src/engine/returnees.ts` (the `resolveReturnee` validator, keyed `planReturner`, the softened carry), `createCharacter.start?: "new" | "return"` (the player's own choice; unknown values refused typed at the tool door; absent = today's `keepCharacter` behaviour), flag `ORWELL_SEASON_MEMORY` (default ON). A returner keeps who they are (identity, personality, backstory, voice, age, look: the archived public persona, never the hidden layer) and their feelings toward the player, softened by the seasons since; goals, agenda, plans and secrets in play are fresh for the new season, and no past event is invented. Scenarios: `0208-returning-houseguests.feature`. ORW-739 built the choice itself: the FE tool schema now carries `start` and `returnAs` (a season number naming one of the player's OWN previous characters; `returnAs` is a return and is refused with `start: "new"` or a season the player has no character for). A played season files the player's own authored character in the per-user archive (`readOwn`/`appendOwn`, its own `<user>.own.json`, append-only, older archives load unchanged: no hidden layer, no number, name and season number only ever reach the narrator). At a season's end the post-season facts list those characters, the one just finished included, so the narrator offers the choice in its own words; a season that was not played is never offered. Real-path test: `tests/unit/returnAsPreviousCharacter739.test.ts`. Not built: a button/screen for the choice (it is a chat choice today; the Next Season button still keeps or recasts only); the choice at the pre-game casting door after a Recreate reset (it is offered only through the confirmed-restart door); B2 and B3.

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

## B3 built (2026-11-18, ORW-665): the hall of fame
- **Record (`src/engine/hallOfFame.ts`, pure):** `buildHallRecord` builds on the foundation's `hallEntry` (season, placement, result) and adds the cast size, the crowned and the runner-up by NAME (a past season's NPC ids mean nothing later), the player's own counts, `bestMove` (an unsealed "your edit" fact whose actor is the player and which reads well for its actor) and `worstBetrayal` (a betrayal or blindside with the player as its subject). Highlights are facts with names, not event ids: the foundation's optional event-id fields stay unused, because the retrospective hands facts, not ids. The narrator words them; no fixed glosses, no number shown.
- **Store:** `UserHallOfFameStore` (`read(user)`, `append(user, record)`), a sibling of 0104's notoriety store: `<dataDir>/hall-of-fame/<hex-user>.json`, its own subtree, survives `resetUser`, per user. `mergeHall` is monotonic: a stored season is never changed or dropped (`hallKeepsAll` is the superset check). A corrupt file is quarantined, not overwritten.
- **Filing:** `registry.resetUser` files the dead season beside the notoriety accumulate (`GameSessionAdapter.hallRecordDraft(season)`: finished, played game, flag on; else nothing). Fail-soft.
- **Read:** one player read tool, `hallOfFame()` (`GameSession.hallOfFame`): the filed seasons plus a just-finished, not yet filed season; empty with the flag off. Vault-free; boundary-tested through `McpServer.callTool`. It is NOT named in the narrator prompt, so no five-place FE wiring yet: **follow-up** is the FE screen outside the game and, if wanted, a premiere board line handing the narrator the last seasons as facts. (ORW-825)
- **Flag:** the same `ORWELL_SEASON_MEMORY`. No rng, no outcome moves. Played games only.
- **What B1 must provide:** nothing. B3 is independent of the archive; if B1 later wants "was a past winner" for a returner, `hallOfFame().seasons` already carries winners by name.
- **Known limit:** `bestMove` and `worstBetrayal` read the top two facts behind the player's edit (`you.because`), so a season whose top two are both neutral files none; the counts still carry. A fuller pick needs the edit tally exposed (Auditor-owned `yourEdit.ts`).
- **Tests:** `tests/unit/hallOfFame.test.ts`, `docs/features/0208-the-hall-of-fame.feature` (prefix "hall of fame:").

## Amendment 2026-11-19 (ORW-690)
A returning houseguest's public persona is not re-authored by the cast-profile write-back: the engine drops the public facets of that write for a returner (hidden fields still apply). Test: `tests/unit/returnerPersonaGuard.test.ts`.

## Amendment 2026-11-19 (ORW-713)
A season the player ends mid-way (New Chat -> "End this season and start a new one", see 0057) is abandoned, not finished: `hallRecordDraft` and `archiveFinishedSeason` both require a finished, played season, so it earns no hall-of-fame record and adds no returner. Conservative reading of this spec; giving an abandoned season a hall entry would be a one-line change to those guards. Test: `tests/unit/abandonSeason713.test.ts`.
