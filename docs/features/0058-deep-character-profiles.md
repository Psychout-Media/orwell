# 0058 — Deep character profiles (born deep, persist, play out)

> **Status:** ✅ **PHASE 1 + PHASE 2 BUILT** — BDD-gated by `0058-deep-character-profiles.feature`.
> Phase 1 (the engine foundation): the seeded floor spawns the §3-depth profile split across the Vault
> Wall, persists it byte-stable, seeds & seals story threads, seeds the NPC→player edge from the Day-1
> read, and recalls authored detail in full. **Phase 2 is now LIVE too** (the items previously deferred):
> the **LLM-authored** write-back is wired end to end — `recordCastProfile` (commit `852f2db`,
> `GameSessionAdapter.recordCastProfile`) validates non-player-mirroring, SPLITS PUBLIC↔HIDDEN across
> the Vault Wall, folds the public facets onto the byte-stable Character, seals the hidden half into the
> Vault + soul recall index, re-derives the story threads, and is idempotent; the FE producer-LLM
> authoring pipeline (`frontend/src/orwell_cast_authoring.py`, kicked off pre-portraits in
> `tool_implementations.py`) calls it. The **portrait consumption** of the physical facet (L29) feeds
> `castPortraitPrompts` / `portraitPrompts.ts`. The **premiere voicing** (L31) voices the public §3
> biography through the `premiere` moment prompt + the houseguest vibe lines in `momentPrompts.ts`. The
> full thread **trigger/resolution scheduler** shipped as feature **0060** (`scheduleStoryThreads`,
> wired into the off-screen tick in `orchestrator.ts`) — dormant→active→surfaced→resolved→expired, all
> Vault-safe. **Remaining (deliberate, by design):** `recordCastProfile` does NOT re-seed the
> NPC→player edge from an authored Day-1 read — the engine deliberately KEEPS the calibrated seeded
> leans (anti-sycophancy: the LLM authors flavor, never the hidden weights; this preserves the net-zero
> perception balance the juryReach calibration gate depends on). Only the read TEXT is authored.
> **Depth reference (FORMAT/DEPTH ONLY, never ingest as data):** `docs/legacy/BB_ProducersVault.md` §3.
> **Executable spec:** `0058-deep-character-profiles.feature`.

## 1. Summary — the true-sim thesis

A real *Big Brother* season is not a script; it is **deep people colliding**. Each houseguest must be
**born deep — before they walk in** — at the depth the v0 Producer's Vault §3 proved out: a real
biography, an observable voice, a *named weakness*, true strategic goals, **2–3 secrets**, and a Day-1
read of the player. That depth must then do three things, in order of difficulty:

1. **Persist as the BASELINE, and only grow from it.** The §3 depth a houseguest walks in with is their
   **fixed baseline** (the static `CHARACTER`) — it never thins, drifts, or is re-invented per turn. The
   *only* thing that changes during play is **growth from that baseline**: the `SOUL` accumulates and
   deepens (0041) and **responds more and more** as the season runs, so late-game behavior is shaped by
   an ever-deeper accumulated history *anchored to who they always were*. Baseline fixed; soul
   monotonic-from-baseline. (Mandate #4 non-degradation; the `CHARACTER`/`SOUL` split.)
2. **Play out.** Each secret / weakness / goal is a **live dramatic thread**, not trivia — it has a
   trigger, a way it can surface, and a hidden-weight impact, and it **resolves over the season**
   (differently each time). A secret the game never folds into behavior is a failure state.
3. **Drive an emergent, divergent season.** 16 deep characters × a seeded draw × their threads
   interacting ⇒ a different drama every playthrough. The depth doesn't decorate the season; through
   the **hidden weights** it *drives* it. **That** is what makes this a sim, not a soap opera — and
   the **Vault Wall** is what keeps it a sim: the player sees only the *behavior* the depth produces,
   never a secret and never a number, and must read it themselves.

## 2. What exists today (the gap this closes)

- **A shallow, finite floor.** `characterFactory` deals an internally-consistent skeleton — archetype,
  hidden stats, a one-line `background`, appearance, vocation, hometown, demeanor. Diverse and
  non-mirroring (L28), but a *pool*, not *endless* — and a paragraph short of §3 depth.
- **The organs to make depth play out already exist, unseeded.** The consequence loop (**0023**),
  character evolution / arc (**0041**), off-screen society (**0038**), pathway propagation (**0002**),
  Vault hidden records + reserve threads (**0001/0025**), and the v0 §15 "Loose Ends" pattern are all
  built — but nothing **seeds live story threads from a character's secrets/weakness/goals at birth**.
  Secrets today are, at most, static flavor. 0058 turns them into threads those engines carry.
- **No full-fidelity recall of authored detail (L27b).** Rich detail, if authored, is summarized thin;
  it must be recall-able in the *same* detail forever.

## 3. The profile schema (split across the Vault Wall)

Each houseguest is spawned with the §3 sections, **partitioned by who may ever know them**:

| **PUBLIC `CHARACTER`** (voiced, shown, feeds portraits — byte-stable, 0007) | **HIDDEN Vault / `SOUL`** (never crosses to player *or* admin; folds into weights) |
|---|---|
| Biography/backstory (the presentable parts) · personality & **observable** traits · **speech & voice register** (cadence, catchphrases — the L28 voice fix) · occupation · hometown · age (≥21) · archetype · **physical characteristics** (its own structured facet — see §4) | The **2–3 secrets** · the **true** strategic goals · the named **weakness / blind spot** · the real **stat scores** · the **Perception-of-the-player Day-1** read |

- **The Day-1 perception seeds the NPC→player edge** (v0 §10): the relationship layer (0017/0026)
  starts from the authored read, not from zero.
- **The weakness/blind spot is a behavioral seed** the game can exploit on a delay (e.g. "underestimates
  quiet players" → mis-reads a real threat until it is too late).
- **Diversity + non-mirroring are guaranteed by the engine**, not hoped for from the LLM: the cast must
  span archetype / disposition / voice / age / body / geography / class, and must **not echo the
  player's profile** (same seed ⇒ same cast regardless of who the player is). The seeded floor (L28) is
  the skeleton the engine validates/repairs the LLM output against — it is **not** a fallback cast: under the default `strict`
  policy a failed authoring run refuses the game start (ORW-286 item 3, Ryne BDD card 30).

## 4. The hybrid (endless variety, airtight persistence) + the pipeline order

LLM authors → **engine is the source of truth**. Mirrors the 0051 portrait-prompt handshake:

```
createCharacter
  → (1) engine seeds the deterministic skeleton (diversity caps + non-mirroring)
  → (2) engine emits the Vault-free cast SKELETON to the FE
  → (3) FE producer-LLM authors each NPC's rich §3 profile (endless variety)
  → (4) FE writes the profile BACK through a new engine seam
  → (5) engine VALIDATES/REPAIRS (diversity, non-mirroring, no player-mirroring),
        SPLITS it across the Vault Wall, STORES it airtight, INDEXES it for full recall,
        SEEDS the story threads (§5) + the NPC→player edge
  → (6) the sealed PHYSICAL CHARACTERISTICS facet feeds the portrait-gen prompt (L29)
  → (7) faces are generated
  → (8) LATER, the premiere (L31) VOICES the already-sealed personas — it never creates them
```

- **Backstories are spawned FIRST, before image generation** — the portrait prompt is built *from* the
  sealed profile, so the face matches the person. The createCharacter→portrait handshake blocks
  portrait assembly until the write-back lands (or the engine builds the prompt straight from the
  stored profile — one source of truth either way).
- **Physical characteristics are their OWN facet** (height/build, skin/ethnicity, hair, features,
  distinguishing marks, age-look, style) — the **single source of truth shared by the image generator
  AND the text narration**, so words and picture never drift (the L29 hook; the L23 "stop re-describing
  bodies" cue reads the same facet).
- **Offline/test path (amended 2026-11-11, ORW-260):** under the default strict enrichment policy a failed or impossible authoring run is a LOUD failure that refuses the game start (no fallback cast; Ryne, BDD card 30). Only keyless CI / `ORWELL_ALLOW_FLOOR_START=1` / the `soft` policy keep the old behaviour: the deterministic seeded floor stands in when no authoring LLM is available, so
  the engine and its tests never depend on a live model.

## 5. The story-thread model (this is the "play out")

At seal time the engine derives, from each character's **secrets / weakness / true goals**, a small set
of **hidden story threads** and registers them in the existing machinery — it does **not** invent a new
subsystem:

- **A thread = `{ source character, premise, trigger condition, surfacing pathways, weight impact, status }`** —
  the v0 §15 "Loose End" shape, Vault-sealed.
- **Trigger** — a game condition that activates/escalates it (e.g. "financial desperation surfaces when
  genuinely threatened on the block"; "the photographic memory fires when it catches a contradiction").
- **Surfacing pathway** — how it can become *known* to others / the player: **only** via in-game
  pathways (witnessed, told, overheard, gossip-diffused — 0002/0038), **never** by exposition, **never**
  telegraphed. The player may come to *suspect* without *knowing*.
- **Weight impact** — when active or discovered it **folds hidden deltas** into the relationship/soul
  layer (0023/0041): the trigger changes how the character plays; discovery changes how others read
  them. No number is ever shown.
- **Resolution** — threads progress, surface, get exploited, or quietly expire over the season, and are
  **never compressed while unresolved** (v0 §16 / non-degradation). Each plays out **differently per
  seed** because it resolves *through* the live game, not on rails.

This reuses: **0023** (the consequence fold), **0041** (soul evolution / arc), **0038** (off-screen
scenes that move threads when the player is away), **0002** (pathway-only propagation, knowledge vs
suspicion), **0025** (Vault sealing + reserve-style judicious surfacing), and the off-screen/loose-ends
logs. **L35 pre-game relationships** are a *special class* of seeded thread, additionally gated by the
reserve-twist rules (sealed from player+admin, sparing, non-game-breaking, organic reveal-as-event).

## 6. Non-degradation & full-fidelity recall (L27b)

**The governing principle: the baseline only grows.** "Born deep" sets the floor; gameplay is *monotonic
growth from it*. The character **grows, evolves, and responds — more and more — from baseline** as the
season runs: the soul accumulates emotional trajectory, memory, and evolving beliefs, and the deeper that
accumulation gets, the more it shapes behavior. It never shrinks back below baseline, never thins, never
overwrites the identity they walked in with — it compounds on top of it.

- The **public profile is byte-stable** (0007/0031 superset + byte-compare guard the new facets, as the
  L28 vocation/hometown/demeanor facets already are); the **soul deepens** (0041) but never loses —
  counts are monotonic, the store is a superset across every save (0007).
- Authored detail is stored **at full granularity** and is **semantically recall-able in that same
  detail** (0024 vector + soul memory) — never flattened to a one-liner. A detail established in the
  premiere is recall-able, verbatim-faithful, in the finale.
- Recall + summary follow the **v0 §16 compression discipline**: keep-in-full (emotionally significant /
  betrayals / unresolved / recent), compress stale low-stakes background, **never** compress active
  threads, pre-game ties, or deployed twists. (This also shapes **L27** retrieval-into-context.)

## 7. Emergent divergence (the replayability claim)

The same player, replayed, must get a **different season** — because (a) the cast is a fresh seeded draw
of deep characters (0004/E38 entropy seed), and (b) their threads **interact and resolve through the
live game**, never on a script. Two seasons with the same player name diverge in cast, in which secrets
surface, in who exploits which weakness, and in how it all lands. This is mandate #1 (behavioral
fidelity) realized as *generativity*, not authored content.

## 8. Vault-Wall guarantees (the non-negotiables)

- **No secret, no thread premise, no stat, no perception number ever reaches the player *or* the admin /
  God Mode.** The split in §3 is structural (engine-only stores; dependency-cruiser forbids outward
  imports of `VaultStore`/`SoulProvider`). A surface is not done until a sentinel test proves it returns
  none of it.
- **The player learns a secret only through an in-game pathway** (0002) — and even then holds it as a
  *belief* with a source/confidence, possibly distorted by gossip drift (0038). Suspicion ≠ knowledge.
- **Anti-sycophancy:** threads resolve from the deterministic core + seeded randomness + the hidden
  weights — the narrator **voices** what surfaces, it never decides outcomes or protects the player.

## 9. Testability (structural where possible)

- **Persistence:** the public profile (incl. physical facet) survives snapshot→restore **byte-identical**
  and never regenerates; the soul/threads persist across an engine restart (0030/0031).
- **Full recall:** a profile/secret detail authored at cast time is recall-able at full fidelity N turns
  later (not flattened).
- **No-leak sentinels:** plant sentinels in every secret/thread/perception field; prove they never appear
  on any player **or** admin surface, in `npcVoice`, or in the moment prompt (extends the 0001 canary).
- **Pathway-only surfacing:** a sealed thread reaches the player's knowledge **only** after a modeled
  pathway terminates at the player; absent a pathway it stays Vault-only (player may suspect).
- **Diversity & non-mirroring:** the spread holds across seeds; the cast never echoes the player's
  vocation/region/voice; same seed ⇒ same cast regardless of player profile.
- **Plays-out coverage:** over a seeded multi-week sim, a measurable share of seeded threads **activate
  and fold a hidden weight** (behavioral fidelity asserted as a richness threshold, like 0003).
- **Per-seed divergence:** two seasons (same player, different seed) differ in cast and in which threads
  surface.

## 10. Out of scope / relationships

- **Out:** the soul-evolution math (0041), the relationship math (0026), the off-screen scheduler (0038),
  the Vault mechanics (0001/0025), portrait *generation* itself (0051/L29 consume the facet) — 0058
  **seeds** these, it doesn't re-implement them.
- **Feeds:** **L29** (portraits from the physical facet), **L31** (the premiere voices sealed personas),
  **L27b** (full-fidelity recall), **L35** (pre-game relationships as a gated thread class), **L19**
  (richer-than-one-word personas, subsumed).
