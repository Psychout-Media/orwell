# 0211 - The reunion and the story of you and them (ORW-649 + ORW-648)

**Status: built (ORW-649 + ORW-648, 2026-11-18): the reunion and the stories ride the post-crown retrospective as read-only facts (`reunion`, `yourStories`; `src/engine/reunionRetro.ts`); gate `tests/unit/reunionRetro.test.ts` + BDD `0211-reunion-and-your-story.feature`. Flags `ORWELL_REUNION`, `ORWELL_YOUR_STORY` (default ON). Not built: the player-answer pending stage and `live.reunion` store (the player answers in chat; see the notes below).**

Cards: ORW-649 (reunion on finale night) and ORW-648 (the story of you and them). Ryne approved both 2026-11-17. Executable spec: `0211-reunion-and-your-story.feature` (spec-only until the build). Foundation: `src/engine/reunion.ts` + `tests/unit/reunion.test.ts` (built, BDD Auditor). The build: Overseer A or B, through the Coordinator.

Both are post-crown only. They read only what the 0048 retrospective may unseal (the sanctioned season-end unsealing). Nothing here runs before `live.finished`.

## ORW-649 the reunion
- **When:** after the crown and the 0048 retrospective unseal, as a played scene (a new post-crown stage), before the retrospective view.
- **What it airs (foundation picks, the narrator voices):**
  - `confrontations(grudges)`: from the grudge book (ORW-607). The biggest grudges, one per pair, at most 3. The player can be either side.
  - `liesComingOut(claims)`: lies from the claims log that were never caught. The listener hears it in front of the speaker, at most 3. Includes the player's own lies and lies told to the player.
  - `alliancesToExplain(groups)`: named or secret alliances (0185, groups) hidden from someone, longest first, at most 2.
- **The player:** each thread involving the player is a pending (like the 0130 exit interview): the player answers in their own words; the engine never speaks for them.
- **Store:** `live.reunion?: { threads, answers }`, persisted, then carried into the retrospective (`RetrospectiveView.reunion`).

## ORW-648 the story of you and them
- **Weekly snapshot (new):** at each week roll, record each houseguest's view of the player (`ViewPoint`: trust, affinity; their own view, hidden layer) in `live.viewOfPlayer?: Record<EntityId, ViewPoint[]>`. It's append-only and played games only. It's the one new piece of state; nothing reconstructs it later.
- **Per houseguest, post-crown:** `arcShape(points)` (engine key), `turningPoints(points)` (weeks), each joined to the player-and-houseguest events that week (event ids, from the event store). The bookends are the first scene together and how it ended (their eviction, their jury vote, unsealed post-crown).
- **The words:** the narrator (or the FE utility model) writes a short story per houseguest from these facts, post-crown, as `RetrospectiveView.yourStories`. No fixed glosses, no numbers.

## Flags and measures
- **Flags:** `ORWELL_REUNION`, `ORWELL_YOUR_STORY`, both default ON.
- **Measure:** post-crown only, so no outcome or mix can move. The weekly snapshot draws no rng; prove byte-identical seeded trajectories.

## The rules
- The player in both directions: the player confronts and is confronted, and the player's lies come out too.
- No short lists.
- The wall: post-crown only; a boundary test proves the reunion and the stories are absent before the crown.
- Never shown as numbers.

## As built (2026-11-18)
- **Presentation over the record.** Nothing is recorded, nothing folds, no rng: `RetrospectiveView.reunion` (threads: confrontation, lie, alliance) and `RetrospectiveView.yourStories` are pure reads at the crown gate (`finished` + a played game). The only new state is `live.viewOfPlayer` (one sample per houseguest per week, the week's latest, via `peek` so no edge is ever created; played games only).
- **Sources, all already behind the retrospective door:** the grudge book (pair, who held it, the wrong's kind key; never a size), the claim log (uncaught lies, the claim in plain words), the alliance history (an alliance the player never knew of), the event record (the kinds of scenes the player shared with the houseguest, by week), the week digests and the jury vote (public at the finale). The per-voter eviction ballot is not read.
- **The player's words.** A thread with the player in it is flagged (`youAreIn` / `youAre`); the narrator asks and waits in chat. No pending stage and no `live.reunion.answers` store were built: a new post-crown stage with pendings changes the finale flow and records the player's words, which is a separate decision.
