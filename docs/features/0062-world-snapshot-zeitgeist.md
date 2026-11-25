# 0062 — Move-in zeitgeist snapshot (a frozen, shared world the whole cast moved in with)

> **Status:** ✅ **BUILT — BDD-gated** (2026-06-20). The engine module `src/engine/zeitgeist.ts`
> captures ONE frozen, seeded `WorldSnapshot` at season creation (off the same season-seed hinge as the
> cast), persists it byte-stable on `SessionCore`/`GameState` (recalled, never re-searched — guarded by
> the 0007 superset/byte-compare), and renders the Vault-free "world you all moved in with" block into
> BOTH the player moment prompt AND the off-screen/`social` moment prompt (the C32-beyond reach), scaling
> the out-of-the-loop drift by the live week. It is FLAVOR ONLY — a seeded game advanced WITH vs. WITHOUT
> the snapshot is byte-identical in every competition result, vote, nomination, and relationship/soul fold
> (the §6/§10 headline guard, proven structurally). The owner's recommendations were taken: the one-time
> 7-day lag offset (§11 #1), capture-once-persist-forever with the deterministic `model-framed` fallback
> for tests/replays (§11 #2/#9), small-and-bounded slices (§11 #3), and an engine-side outward field on
> `GameState` (§11 #4 — for the 0007 guard). **The FE-owned `web_search` capture lane is now built**
> (`frontend/src/orwell_zeitgeist.py`): at season creation (a genuine `do_create_character` start) it
> fires a best-effort background capture — a bounded `web_search` over the move-in-era zeitgeist (a ~7-day
> one-time lag, §11 #1) synthesized to the slice JSON and written back via `recordWorldSnapshot` (the seam
> the boundary fix in PR #416 opened), REPLACING the deterministic fallback ONCE per season; no model /
> no search ⇒ the deterministic snapshot simply stands (§8). FE-pytested (`tests/test_0062_zeitgeist_capture.py`,
> injected deps — never depends on a live search, §9/§10).
> Feature file `0062-world-snapshot-zeitgeist.feature` (in `cucumber.cjs`); unit `tests/unit/zeitgeist.test.ts`.
>
> *(Original spec status, retained:)* 📝 **SPEC ONLY at the time.** Authored 2026-06-19. Extends the shipped **C32** in-fiction
> `web_search` capability (the "THE REAL WORLD." clause in `src/engine/momentPrompts.ts`, the keep-set
> wiring in `frontend/src/settings.py` / `agent_tools.py` / `builtin_mcp.py`). C32 searches per-reference,
> voices it, and forgets; 0062 promotes that to **durable, shared, frozen state** — one snapshot of the
> real-world zeitgeist captured at move-in, persisted byte-stable, recalled all season, coloring both the
> player's scenes and off-screen NPC life, and going stale as the weeks pass. **The sequestration fiction
> ("no internet in the house") is the mechanism, not a limit to fight.** Carries **open decisions for the
> owner** (§11) — notably the 7-day-lag question (one-time offset vs. rolling window).

## 1. Summary — promote search-and-forget to a shared, frozen world

A real *Big Brother* cast walks in carrying the **same real world**: they all saw the same movies, heard
the same songs, followed the same news up to the day the doors closed — and then they're sealed off. Weeks
later they're charmingly, consistently **out of the loop**: dated references, wrong guesses about anything
that happened after move-in, jokes about being behind. That shared, frozen, slowly-staling pop-culture
baseline is a real-BB delight, and the engine doesn't model it.

C32 gave the narrator a way to *answer* a real-world reference the player makes (quietly search, voice it
in character). But C32 is **per-reference and stateless**: each lookup is independent, voiced, and
forgotten, so two houseguests can "know" inconsistent versions of the same thing, the off-screen society
knows nothing of the real world at all, and there is no notion of the world being *frozen at a date*.

0062 captures, **once at season creation**, a single **`WorldSnapshot`** — a small, frozen picture of the
move-in-era zeitgeist (trending topics, recent films/shows/music, sports, notable news, the general mood)
seeded from a real `web_search` with a deliberate ~7-day real-world lag. It is **persisted and byte-stable**
(frozen like the static `CHARACTER` baseline), **recalled all season**, feeds **both** the player moment
prompts **and** the off-screen society/gossip prompts, and the prompt tells the model the world is **frozen
as of the move-in date** — so the longer the season runs, the more dated and out-of-the-loop the house
gets. It is **flavor only, never game truth** — a third category of state (see §6).

## 2. What exists today (the gap this closes)

- **C32 — in-fiction `web_search`, stateless.** The agent looks up a real-world reference the player makes
  and voices it in the houseguest's own words as something they knew before move-in. Guardrails (in the
  moment prompt): never show results, never mention searching, **flavor only — never a game fact/outcome**,
  the house has no internet (know the movie, not this week's box office), fail-soft to improvisation if
  search is unavailable. Shipped, keep-set-mounted, pytest-gated (`frontend/tests/test_c32_infiction_search.py`).
- **No shared, persisted real-world state.** Each C32 lookup is independent — there is no single captured
  zeitgeist, so references are not consistent across the cast or across the season, and nothing is *frozen
  at a date*. Two houseguests can reference the same real thing inconsistently; week 1 and week 8 carry the
  same (absent) real-world baseline.
- **The off-screen society knows nothing of the real world.** The gossip / off-screen scene prompts (0038)
  carry only in-game facts — NPCs never bond over a shared show, gossip about a celebrity, or make a dated
  joke while scheming. C32 only colors the *player's* on-screen turn.
- **No "out of the loop" texture.** Nothing makes the cast get *more* dated as sequestration drags on — the
  signature comedic beat of late-season BB is unmodeled.

## 3. The artifact — a seeded, frozen `WorldSnapshot`

A single per-season artifact, **built at cast/season creation off the same seed hinge as the cast**, then
**frozen**:

```
WorldSnapshot {
  capturedFor:  <the in-fiction move-in date the house is frozen at>
  capturedAt:   <real timestamp the snapshot was taken>     // provenance, never voiced
  lagDays:      <the real-world lag applied at capture, default ~7>   // §11 open decision
  source:       "web_search" | "model-framed" | "absent"    // how it was seeded (fail-soft tier)
  slices: {
    screen:     [ … recent films / TV / streaming the cast would have seen … ]
    music:      [ … songs / artists / a tour everyone was talking about … ]
    sports:     [ … a season/championship in progress, a rivalry … ]
    news:       [ … notable, non-sensitive headline-level events … ]
    internet:   [ … a meme, a viral moment, a phrase everyone was saying … ]
    mood:       "<a one-line read of the cultural moment at move-in>"
  }
}
```

- **Seeded + frozen.** Captured ONCE at season creation and never updated in-season — a point-in-time
  capture, exactly the no-internet fiction. It is the world the cast *moved in with*; it cannot learn what
  happened after the doors closed.
- **Small + bounded.** A handful of items per slice (size/budget is a §11 open decision) — enough for
  consistent color, not an almanac. It is texture, not a knowledge base.
- **Byte-stable, persisted, recalled all season.** Lives alongside the static baseline (the `CHARACTER`
  partition / a top-level season field on `GameState`), guarded by the **0007 superset + byte-compare**
  non-degradation discipline exactly as the `CHARACTER` facets are — it never thins, drifts, or
  regenerates. Survives an engine restart (0030/0031). It is **static** by construction (the freeze IS the
  mechanism, §7).
- **Public, not Vault.** The snapshot is shared *public* real-world context — the player lives in the same
  world, so it is **not** hidden state (see §6). It lives on the **outward-safe** side of the wall and may
  cross to player- and off-screen-facing prompts. (It carries no secret; provenance fields like
  `capturedAt` are operational metadata, never voiced.)

## 4. Per-NPC interest filtering (shared baseline, individual color)

The snapshot is a **shared baseline** the whole cast moved in with — but recall is **not uniform**. Each
houseguest's persona/archetype/background decides which **slices** they are fluent in:

- A sports fan riffs on the championship; the film buff quotes the movie; the chronically-online one drops
  the meme; the news-follower references the headline. The same snapshot, refracted through who each person
  is.
- This is a **read-time projection**, not stored per-NPC state — derived from the same public persona facets
  the narrator already voices (archetype, background/vocation, demeanor; 0058 deepens these). The snapshot
  itself stays one shared, byte-stable artifact.
- The filtering hands the model a *per-person slice emphasis* (this houseguest leans screen+internet; that
  one leans sports+news), so the cast doesn't recite an identical list — shared world, individual color.
  It is a **voice anchor**, never a number, and never a lever.

## 5. Reach — the player's scenes AND off-screen NPC life

This collective coloring is what makes 0062 more than C32 (which only ever touched the player's on-screen
turn):

- **Player moment prompts.** The snapshot feeds the per-moment game-master context (the Vault-free
  `renderGameContext` / `renderStoryFacts` / `buildSystemPrompt` seam in `momentPrompts.ts`) as a small
  "the world you all moved in with" block — so when the player references something real, or a houseguest
  reaches for real-world flavor, the model voices it **consistently** from the frozen snapshot first, and
  only falls back to C32's live lookup for something genuinely outside it. (C32 stays the escape hatch for
  the long tail; 0062 is the shared, consistent core.)
- **Off-screen society / gossip prompts (0038).** The off-screen scene + gossip prompts also receive the
  snapshot, so NPC-to-NPC life is colored by the same shared world: two houseguests bond over a show they
  both loved, gossip drifts onto a celebrity, someone makes a dated joke mid-scheme. The real world becomes
  part of the house's social texture, not just an answer to the player.
- **Consistency is the payoff.** Because both channels read **one frozen artifact**, a reference the player
  hears on-screen and a reference an NPC makes off-screen are drawn from the same world — no contradictions,
  no per-lookup drift.

## 6. The hard line — flavor ONLY, a THIRD category of state (never Vault, never game truth)

State this loudly. The world snapshot is **neither** of the two existing categories:

- **NOT Vault-secret.** The player shares the same real world — it is not hidden from them, so it does not
  belong behind the Vault Wall and is not gated by a witness set. It is **public, shared, real-world
  context**. (Putting it in the Vault would be a category error: the Vault holds what the player must never
  learn; the player already lives in this world.)
- **NOT game-mechanical.** It **never informs, decides, or perturbs a single game fact, outcome, or
  decision** — not a competition result, not a vote, not a nomination, not a relationship edge, not a soul
  fold. Anti-sycophancy (mandate #3) holds verbatim: ground truth stays in the engine's levers; the
  snapshot is something the narrator *voices*, never something the engine *computes against*. The C32
  guardrail — "search informs real-world flavor ONLY — it never decides or informs any game fact, outcome,
  or decision; game truth comes only from your levers" — applies to the snapshot identically and is
  extended to cover both reach channels.

So the snapshot is a **third state category: shared public real-world flavor.** Where it lives relative to
the wall:

| | Reaches the player? | Informs a game outcome? | Where it lives |
|---|---|---|---|
| **Vault / hidden** | Only via a modeled pathway (0002) | Yes (via the hidden weights) | Engine-only `VaultStore` / `SOUL` |
| **Game truth (levers)** | As public results | IS the outcome | Engine state, queried |
| **World snapshot (0062)** | Freely (shared world) | **Never** | Outward-safe season state; voiced, never computed against |

**The structural test of "never game truth" (§10):** a seeded game advanced **with** the snapshot present
produces **byte-identical** competition results, votes, nominations, and relationship/soul folds as the
**same** seeded game advanced **without** it. The snapshot touches prose only; it never reaches the
deterministic core. (This is the 0062 analogue of the Vault-Wall sentinel test — here the guard is
*outcome-invariance under the snapshot*, not *no-leak*.)

## 7. The freeze as mechanism — "increasingly out of the loop"

The sequestration boundary is the feature, not an obstacle:

- **Immutable per season.** The snapshot is captured once and never updated. The prompt tells the model:
  *the world is frozen as of the move-in date; the house has had no contact since; anything that would have
  happened after that date is unknowable to everyone here.*
- **Anything "after" is a guess.** If the player references something that postdates move-in (this week's
  box office, a result that hadn't happened yet, news from outside), the cast **can't know it** — they
  guess, get it wrong, or wave it off ("no idea, we've been locked in here for weeks"). That wrongness is
  *correct* and is itself the played texture. (This directly extends the C32 "know the movie, not this
  week's box office" guardrail into a persistent, dated rule.)
- **Drift grows with the weeks.** The longer the season runs (a derivable signal: current week vs. the
  move-in date the snapshot is frozen at), the more dated the references and the more the cast leans into
  being behind — a texture that *grows*, the late-season comedic beat. The prompt is handed the elapsed
  in-house duration so the model can scale how out-of-the-loop the house sounds. (No new clock — reuse the
  existing week/day counters.)

## 8. Fail-soft (mandate: never break the game)

The snapshot is best-effort, exactly as C32 is:

- **No search provider configured / search unavailable at creation** → seed the snapshot from the **model's
  own framed knowledge** of the era (`source: "model-framed"`), or, if even that is not wired, **skip** the
  snapshot entirely (`source: "absent"`) and degrade to C32's existing per-reference behavior. The game
  never blocks on, or fails because of, the snapshot.
- **A skipped/absent snapshot must not change any outcome** (the §6 invariance holds trivially) and must
  not break recall or persistence (an absent snapshot round-trips as absent).
- The capture is a **front-end-side** responsibility (the FE owns the concrete search provider, like C32
  and the 0051 image provider): the FE seeds the snapshot at character/season creation and persists it; the
  engine treats it as outward-safe season context it can render into prompts. (Exact ownership of the
  store — FE season store vs. an engine outward field on `GameState` — is a §11 open decision; either keeps
  the wall intact because the artifact is non-secret by construction.)

## 9. Replayability & seeded-replay reconciliation (0004)

0062 must not break same-seed reproducibility — but a **live web search is not deterministic**. The
reconciliation (recommended, flag in §11):

- **Capture ONCE, then read the persisted snapshot forever.** The snapshot is seeded/captured a single time
  at season creation and **persisted**; every subsequent turn, restart, and recall reads the **persisted**
  artifact, never a fresh search. So *within a season* the snapshot is perfectly stable and the §6
  invariance + §10 persistence tests are deterministic.
- **Across a same-seed replay**, the *deterministic core* (cast draw, competitions, votes — 0004/E38) stays
  byte-identical regardless of the snapshot, because the snapshot never touches the core (§6). The snapshot
  *content* may differ between two live captures of the "same" seed (the web moved), but that is **flavor
  divergence only** — it changes what real-world jokes get made, never the game. For a fully-reproducible
  replay (tests, debugging), the **deterministic fallback** (`source: "model-framed"` or a fixture
  snapshot) is used, exactly as the deterministic-embedding fake stands in for fastembed (ADR 0004 pattern).
- **Tests never depend on a live search.** The BDD/unit lane uses a fixture/deterministic snapshot; a real
  search is opt-in only (mirroring `ORWELL_TEST_FASTEMBED`).

## 10. Testability (structural where possible)

- **Seeded + persisted + frozen:** a snapshot captured at season creation survives snapshot→restore
  **byte-identical** and never regenerates in-season (0007 superset + 0030/0031 round-trip); the
  move-in date / frozen marker is stable across restarts.
- **Flavor-never-game-truth (the headline guard):** a seeded game advanced **with** the snapshot present
  yields **byte-identical** competition results, votes, nominations, and relationship/soul folds vs. the
  **same** seeded game advanced **without** it. The snapshot never perturbs the deterministic core.
- **Reach — both channels:** the snapshot colors a **player moment prompt** AND an **off-screen
  society/gossip prompt** (both prompts carry the snapshot's "world you moved in with" block; the off-screen
  channel is the C32-beyond delta).
- **Per-NPC interest filtering:** two houseguests with different personas/archetypes draw on **different
  slice emphases** from the same shared snapshot (a read-time projection; the snapshot itself stays one
  byte-stable artifact).
- **Played freeze-drift:** the prompt carries the frozen move-in date + the elapsed in-house duration, and
  the out-of-the-loop instruction is present and scales with the weeks (anything postdating move-in is
  unknowable → guessed/wrong).
- **Fail-soft:** with **no provider**, the snapshot seeds from model-framed knowledge or is absent, the
  game runs unchanged, and an absent snapshot round-trips as absent (the §6 invariance holds trivially).
- **No-leak by construction (defense in depth):** the snapshot is non-secret, but the structural Vault tests
  still hold — it introduces **no** outward import of `VaultStore`/`SoulProvider`/`VectorIndex`
  (dependency-cruiser stays green), and it never carries or echoes any Vault value.

## 11. Open decisions for the owner

1. **The 7-day lag — one-time seed offset (RECOMMENDED) vs. rolling 7-day-behind window.** Recommend a
   **ONE-TIME offset**: capture the zeitgeist as of approximately *(move-in − 7 days)* a single time, then
   freeze — the cast starts slightly behind, the snapshot is settled (not bleeding-edge), and it is fully
   consistent with the no-internet fiction (the house never updates). The **rolling** alternative (always
   re-capture to stay ~7 days behind real wall-clock time) would require **in-season updates** and would
   **break sequestration** — the house would mysteriously learn things that happened after move-in.
   **Recommend the one-time offset; flag the rolling option as the sequestration-breaking variant.**
2. **Live-search seeding × seeded-replay reproducibility.** Recommended (§9): capture once, persist, and
   read the persisted snapshot forever; the deterministic core stays seed-stable regardless (§6), and tests
   use a fixture/deterministic snapshot (opt-in real search, like `ORWELL_TEST_FASTEMBED`). Owner to confirm
   that *flavor divergence* between two live captures of the same seed is acceptable (it is, by §6).
3. **Snapshot size / capture budget.** How much real-world content to capture and how many search calls to
   spend at creation (a handful of items per slice vs. richer). Bounds the cost and the prompt budget.
   Recommend small-and-bounded (texture, not an almanac) with the cap a single tunable.
4. **Where the snapshot store lives.** FE per-season store (alongside the 0057 season store, consistent with
   FE owning the search provider) vs. an engine outward field on `GameState` (consistent with the 0007
   non-degradation guards). Either keeps the wall intact (the artifact is non-secret). Recommend whichever
   the implementer finds cleaner for the §10 round-trip test; an engine-side outward field gets the 0007
   superset guard for free.

## 12. Out of scope / relationships

- **Extends:** **C32** (in-fiction `web_search` — the base; 0062 is its durable/shared/frozen promotion) and
  **0032** (the `web_search` keep-set / game-build gating — the provider wiring 0062 reuses).
- **Reuses:** **0024** (soul/recall stores — the snapshot is recalled like authored detail, full-fidelity,
  though it is public not soul-private), **0038** (the off-screen society/gossip prompts — the second reach
  channel), **0007** (persistence non-degradation — the snapshot is a byte-stable frozen artifact under the
  superset guard), **0004** (replayability/seeded draw — the snapshot shares the season seed hinge and the
  deterministic-fallback pattern), **0030/0031** (durable persistence + integrity across restart).
- **Pairs with:** **0050/0058** (character creation / deep profiles — the snapshot is seeded at the same
  createCharacter hinge and read through the same public persona facets for per-NPC filtering), **0057**
  (seasons as levels — each new season captures its own fresh, later snapshot).
- **Not here:** any snapshot content that informs a game outcome (forbidden by §6); a *secret* world
  snapshot (it is public by construction — Vault placement would be a category error); an in-season
  refresh / rolling window (would break sequestration — §11 #1); a player-facing "world feed" surface (the
  snapshot is *voiced* in the fiction, never shown as a dashboard panel — ADR 0003: don't turn the game
  into a dashboard).
