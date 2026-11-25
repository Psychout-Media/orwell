# 0060 — Story-thread trigger/resolution scheduler (0058 Phase 2)

> **Status:** ✅ **BUILT — BDD-gated** (#336; `0060-story-thread-scheduler.feature` in `cucumber.cjs`).
> Shipped with the owner's **restrained** posture (`threadConstants.ts`; the hard season surfacing
> cap ≈3–4). This is the spec the build followed.
>
> **Parent feature:** [0058 — Deep character profiles](./0058-deep-character-profiles.md). 0058 Phase 1
> ships the *born-deep* §3 profile split across the Vault Wall and the **story-thread model** (§5): each
> character's secrets / weakness / true goals are seeded as `dormant` hidden `StoryThread`s, sealed in the
> Vault, persisted, and the **activation-and-fold HOOK is built and proven** (`GameSessionAdapter.activateThread`
> reuses the 0023 consequence fold). **The one Phase-2 piece this spec covers is the automatic *when-to-fire*
> scheduler** — the missing orchestrator that decides, each tick, which dormant thread should activate, which
> active thread should surface, and which should resolve or expire. (0058's other Phase-2 deferrals — the LLM
> write-back wiring, portrait consumption L29, premiere voicing L31 — are out of scope here.)
> **Executable spec:** `0060-story-thread-scheduler.feature` (skeleton; not yet in `cucumber.cjs` — added when built to green).

## 1. Summary — close the "play out" loop

0058 §1 promised three things of a deep character: *persist as the baseline*, **play out**, and *drive a
divergent season*. Phase 1 delivered the first and seeded the machinery for the second — but a seeded thread
that nothing ever fires is still trivia, exactly the failure state 0058 §2/§5 warns against ("a secret the game
never folds into behavior is a failure state"). **This phase makes the seeded threads actually play out** by
riding the **existing bounded off-screen tick** with a small, seeded, bounded scheduler that walks each
thread's lifecycle (`dormant → active → surfaced → resolved`, or → `expired`).

**It is purely a *when-to-fire* orchestrator. It authors nothing and computes no new content.** Activation
reuses 0023 (the consequence fold, already wired in `activateThread`). Surfacing reuses 0038 (gossip diffusion)
+ 0002 (`surfaceInformationTo`, with content-lineage anchoring). Resolution reuses 0023 again. The scheduler
only decides *which transition fires this tick* — it adds **no parallel subsystem** (the same discipline 0058 §5
and 0059 §5 hold).

## 2. What exists today (the gap this closes)

- **Threads are seeded, sealed, persisted — and frozen at `dormant`.** `deriveStoryThreads` (Phase 1) mints
  `{ id, sourceId, premise, trigger (prose), surfacingPathways, weightImpact, status }` per secret/weakness/
  goal; the whole cast's threads seal into the Vault and survive restart. `ThreadStatus` already enumerates the
  full lifecycle (`dormant | active | surfaced | resolved | expired`).
- **Only `dormant → active` is wired, and only by an explicit caller.** `GameSessionAdapter.activateThread`
  flips one dormant thread to `active` and folds `weightImpact` toward `[PLAYER]` via `foldHiddenImpact`
  (0023). **Nothing calls it automatically** — there is no per-tick decision that *picks* a thread to fire, and
  the other three transitions (`active → surfaced`, `→ resolved`, `→ expired`) have no code at all.
- **The `trigger` is prose only.** `StoryThread.trigger` is an English sentence for recall/flavor
  ("activates when this houseguest is genuinely threatened on the block or cornered socially"). There is no
  **structured** condition the scheduler can evaluate against live season context.

## 3. Structured triggers (extend `StoryThread`)

Add a structured, machine-evaluable `triggerCondition` to `StoryThread`, **alongside** (never replacing) the
existing prose `trigger` — the prose stays for full-fidelity recall and narrator flavor (0058 §6 / L27b). The
condition is a **small closed enum** (mirroring `decisionConstants.ts`'s closed `NominationTactic`/disposition
sets), each member evaluated each tick against a Vault-free **season context** snapshot:

| `triggerCondition` | Fires when (evaluated against live season context) | Typical source field |
|---|---|---|
| `on-block` | the source houseguest is currently nominated | secret |
| `nominated-twice` | the source has been on the block in ≥2 distinct weeks | secret / weakness |
| `cornered-socially` | the source's standing has dropped — bottom-quartile bond/threat read among the living house | secret |
| `house-tightens` | the living-cast count has fallen to ≤ `THREAD.tightenCastSize` (default 8) | true goal |
| `contradiction-witnessed` | the source witnessed an event that contradicts a public claim they hold | secret (a maintained lie) |
| `goal-demands-move` | the source holds power this week (HOH / veto) — the goal demands a visible play | true goal |
| `rivalry-present` | a houseguest the source seeded a thread *about* is still in the house | secret (a recognized rival) |

- **`deriveStoryThreads` maps each thread to a condition** by its source class (secret/weakness/goal),
  deterministically off the same side rng, so the choice is seed-stable and the prose `trigger` and the
  structured `triggerCondition` agree in spirit. (The existing three prose-trigger lines map cleanly:
  the secret line → `on-block`/`cornered-socially`; the weakness line → `contradiction-witnessed`/
  `goal-demands-move`; the true-goal line → `house-tightens`/`goal-demands-move`.)
- **The season context is Vault-free.** The predicates read only public/engine-internal *position* facts
  (nominations, week, living-cast size, power holders, relationship reads the engine already owns) — never the
  thread premise itself. A predicate is a *gate on when the world is ripe*, never a content channel.
- **Back-compat / persistence:** a thread restored from a pre-0060 save (no `triggerCondition`) defaults its
  condition by source class on load — the lossless round-trip / superset guarantee (0007) holds, and a
  re-derive on restore is idempotent (Phase 1 already re-derives authored threads).

## 4. The per-tick scheduler (rides the existing bounded tick)

The scheduler is **one function called once per bounded off-screen tick** (the same tick `defaultApply` in
`src/composition/orchestrator.ts` already runs — turn-driven by default per the 2026-06-10 ruling, opt-in for
the wall-clock watcher). It is **not** a new subsystem, a new loop, or a new clock. It runs *after* the tick's
society/gossip/confessional steps so it can read the freshly-moved house, and walks the cast's threads:

```
schedulerTick(ctx):                                  # ctx = the Vault-free season context, engine-only
  for each thread (seed-stable iteration order):
    dormant   & triggerCondition(ctx) met & roll< P_activate  → activateThread(source)        # 0023 fold
    active    & roll< P_surface & under the season surfacing cap → surfaceThread(thread, ctx)  # 0038 + 0002
    surfaced  (or active beyond resolveAfter weeks)            → resolveThread(thread)         # 0023 final fold
    triggerWindowPassed(thread, ctx)                           → expireThread(thread)          # record, never delete
```

Each transition reuses an existing organ — **the scheduler computes only the WHEN:**

### 4.1 `dormant → active` — *reuse 0023*
When `triggerCondition(ctx)` is met **and** a bounded seeded roll passes (`THREAD.activateProb`), call the
**existing** `activateThread(sourceId)`. That already flips the status and folds `weightImpact` toward
`[PLAYER]` through `foldHiddenImpact` (the proven 0023 path). No new fold code. (The hook stays callable
directly for tests; the scheduler is just its first automatic caller.)

### 4.2 `active → surfaced` — *reuse 0038 + 0002*
When an active thread rolls to surface (`THREAD.surfaceProb`) **and** the season surfacing cap (§5) is not yet
spent, the thread becomes *known to someone* — **only** through an in-game pathway, **never** exposition:

- **NPC↔NPC (the common case):** mint a **vague rumor paraphrase** of the thread (the `rumorFrom`-style gloss
  pattern, *never* the verbatim premise) and hand it to the **0038 gossip engine** (`diffuseGossip`) along the
  affinity graph. It diffuses with the normal low transmit probability, decay, and per-telling drift. Most of
  the time it stays among the NPCs; the player catches it only if a chain terminates at them.
- **Directly to the player (rare):** when a modeled pathway already reaches the player (they witnessed the
  source's tell, or an NPC confidant relays it), call **0002 `surfaceInformationTo`** with a paraphrase that is
  a genuine **fragment of real content** — so the `pathwayAnchored` content-lineage check (E9/C2/C3) accepts it
  as a *belief* (with source + confidence), never laundering an invented claim into knowledge. An unanchored
  attempt is correctly downgraded to a suspicion (Phase 1 / 0002 already does this).

Either way the player ends with a **belief held with confidence** (possibly gossip-drifted), **never** a
fact-on-a-projection and **never** an exposition line. Mark the thread `surfaced` and count it against the
season cap.

### 4.3 `surfaced` / long-`active` → `resolved` — *reuse 0023*
A thread resolves when it has surfaced, or when it has been `active` for more than `THREAD.resolveAfterWeeks`
without surfacing (it played out off-screen and burned down). Resolution folds **one final** bounded delta via
`foldHiddenImpact` (a closing beat — the secret's exploitation lands, the goal's move is made) and sets
`status = "resolved"`. A resolved thread is inert thereafter (it never re-fires).

### 4.4 trigger-window-passed → `expired` — *record, never delete (non-degradation)*
A thread `expires` (without ever firing) when its window has closed: the **source is evicted**, or
`THREAD.expireAfterWeeks` have elapsed since seed without the condition ever being met. An expired thread is
flipped to `status = "expired"` and **kept in the Vault forever** — it is recorded as *never-fired*, never
deleted. This is mandate #4 (non-degradation): the store is a superset across every save; a thread that didn't
get its moment is still part of the season's history.

### 4.5 Determinism & cost
Every roll is drawn from a **seeded side rng** (hashed off `seed:thread-scheduler:<tick-or-thread-id>`), so the
same seed + same trigger sequence ⇒ the same thread drama, and the scheduler never perturbs the main house
stream (0007 byte-stability). Iteration order over threads is the seed-stable cast/derive order. The whole pass
is O(threads) over a small set; its incremental per-tick cost must be measured against the per-tick budget
before it is wired live (§8).

## 5. Restraint (the owner ruling) — not every secret detonates

A real season is **mostly buried secrets**. The drama is that *some* surface, most don't, and the player only
ever catches a fraction. This phase bakes that in structurally — it is the same lesson the **L40 showmance
overload** taught (the narrator reading *every* high-affinity edge as a romance saturated the cast; the fix was
sparseness + earned-only surfacing). Concretely:

1. **A hard season cap on SURFACED threads** — `THREAD.maxSurfacedPerSeason = 4` (range guidance **3–4**). Once
   the cap is spent, no further thread surfaces *to anyone* this season, however ripe — surplus threads still
   activate and resolve in the hidden layer, but their drama stays off-screen. This is the direct analogue of
   0059's "≤2 ties / ≤2 showmances" sparseness gate.
2. **NPC↔NPC surfacing is the common path; surfacing *to the player* is rarer still.** Surface-to-player is
   gated behind an already-modeled player pathway (§4.2) *and* a lower probability, so most thread drama is
   something the player half-catches secondhand or never learns at all — exactly 0058 §7's "different season
   every time, and you only see some of it."
3. **Belief-level / atmospheric this phase.** A surfaced thread reaching the player produces a **belief with
   confidence** (possibly drifted), shaping atmosphere and the player's own reads — it is **not** yet a lever
   the player can *act on* mechanically (no "confront the secret" decision point). *(Open question — see §9: a
   later phase may make surfaced threads player-actionable. Held out of scope deliberately to keep this phase
   restrained.)*
4. **Bounded per-tick activation, too.** `THREAD.maxActivationsPerTick` (default 1) keeps any single tick from
   detonating a cluster — threads activate gradually across the season, not in a burst.

## 6. The new bounded constants module (`threadConstants.ts`)

Mirror `decisionConstants.ts` / `relationshipConstants.ts` / `gossip.ts`'s `GOSSIP`: a single tunable module,
every magnitude the scheduler reads lives **here**, no magic number at a call site (the B59 grep gate covers it
like its siblings). All terms are **bounded** nudges/probabilities — they pace drama, they never override a
hard rule (0005 legality binds downstream, the Vault Wall is structural).

```ts
export const THREAD = {
  // ── per-tick transition probabilities (bounded; seeded rolls) ──
  activateProb: 0.20,          // chance a ripe dormant thread activates this tick
  surfaceProb: 0.15,           // chance an active thread surfaces this tick (if the cap allows)
  surfaceToPlayerProb: 0.30,   // OF a surfacing, the chance it goes to the player (vs NPC↔NPC only)
  // ── restraint caps (the L40 lesson) ──
  maxSurfacedPerSeason: 4,     // HARD cap — ≈3–4; surplus drama stays off-screen
  maxActivationsPerTick: 1,    // no single tick detonates a cluster
  // ── lifecycle windows (in weeks) ──
  resolveAfterWeeks: 3,        // an un-surfaced active thread burns down after this long
  expireAfterWeeks: 6,         // a never-triggered dormant thread expires (recorded, never deleted)
  // ── structured-trigger thresholds ──
  tightenCastSize: 8,          // `house-tightens` fires at/below this living-cast count
} as const;
```

## 7. Vault-Wall safety (the §8 non-negotiables, reused verbatim)

This phase inherits 0058 §8 unchanged and adds nothing that could weaken it:

- **No premise, trigger, secret, stat, or perception string EVER reaches a player- OR admin-facing
  projection** — not the view, not `npcVoice`, not the moment prompt, not God Mode. `triggerCondition`,
  `StoryThread`, and the deep profiles stay engine-only (the dependency-cruiser default-deny forbids any
  outward import of `VaultStore`/`SoulProvider`). The scheduler runs entirely inside the engine adapter.
- **Surfacing produces a pathway BELIEF, never a fact-on-a-projection and never an exposition line.** What
  crosses to the player is the same shape gossip/overhears already produce: a vague paraphrase held with
  source + confidence, content-lineage-anchored (E9). The verbatim premise never leaves the Vault, so the
  0031 leak-sweep stays strict about exact strings.
- **Active threads are never compressed (0058 §16 / non-degradation).** Recall + summary keep active threads
  (and unresolved/recently-resolved ones) in full; only stale, *expired*-and-old low-stakes threads may be
  compressed in summaries — and even an expired thread is retained at full fidelity in the Vault store.
- **Anti-sycophancy:** the scheduler fires on the deterministic core + seeded rolls + the live position read —
  it never protects the player, never engineers a favorable surfacing, and the narrator only *voices* what a
  surfaced belief gives it.

## 8. Cross-cutting note — per-tick cost vs. the L18/R3 budget (sequencing)

The scheduler adds work to **every bounded off-screen tick**: evaluating `triggerCondition` against the season
context for every dormant thread, plus the surfacing/resolution rolls. With ~3 threads × 15 NPCs (~45 threads)
this is a small O(threads) pass — but it lands on the same hot path the **R3** audit flagged, where per-call
latency already grows over a season (the O(events) snapshot export; ~20× week 1 → week 14). **Before this is
wired into the live tick its measured per-tick cost must be checked against the L18/R3 per-tick budget** — the
predicates must read cheap *position* facts (computed once per tick, not re-derived per thread), and the pass
must not re-serialize the snapshot. **Sequence this build AFTER the current lanes land and after any R3 /
incremental-snapshot / SQLite work**, so the budget it spends is measured against an already-improved tick, not
added on top of the known late-season growth.

## 9. Open questions (for the implementer / a later phase)

- **Player-actionable surfacing: superseded** (ORW-822, 11-24: the player acts on what surfaces through 0094 `confront`, 0099 secrets as currency and 0202 leverage). This phase keeps surfacing *belief-level / atmospheric*. A later
  phase could turn a surfaced-to-player thread into a real decision point (a "confront / exploit / sit on it"
  pending), making the player an active participant in a secret's resolution. Held out of scope to keep this
  phase restrained — flag for product before building.
- **Trigger-condition coverage.** The §3 enum is a starting set sized to the three Phase-1 thread classes; the
  implementer may extend it (still a closed enum, still Vault-free predicates) as authored profiles (0058
  Phase-2 write-back) introduce richer source material — but each addition must keep the predicate a *position*
  gate, never a content channel.
- **Pre-game ties / showmances (0059) as a thread class.** 0058 §5 notes pre-game relationships (L35/L40) are a
  *special class* of seeded thread under the reserve-twist rules. If 0059 ships its surfacing through this same
  scheduler, the season surfacing cap (§5) should likely be **shared** across both thread kinds so the house's
  total "secrets that surface" budget stays scarce — confirm when both are built.

## 10. Testability (BDD coverage outline)

`0060-story-thread-scheduler.feature` (skeleton authored; added to `cucumber.cjs` when built to green). The
scenarios mirror 0058's structure and the 0003 richness-threshold style:

- **(a) Plays-out coverage.** Over a seeded multi-week sim, a **measurable share** of seeded threads both
  **activate** *and* reach **resolved/expired** (the lifecycle actually runs end to end — asserted as a richness
  threshold, like 0003 / 0058 §9 "plays-out coverage"), and a measurable share fold a hidden weight.
- **(b) Per-seed divergence.** Two seasons (same player, different seed) differ in *which* threads activate,
  surface, and resolve — the drama is generative, not scripted (0058 §7).
- **(c) No-leak sentinel after surfacing.** Plant a sentinel in every thread premise/trigger/`triggerCondition`;
  drive a sim until threads surface; prove the sentinel **never** appears on any player surface, the admin
  surface, `npcVoice`, or the moment prompt — even *after* a thread has surfaced (what crosses is the anchored
  paraphrase belief, never the premise). Extends the 0001 canary / 0058 §8 sentinel.
- **(d) Restart survival.** A thread the scheduler has driven to `active` (or `surfaced`/`resolved`/`expired`)
  survives snapshot→restore **at that status** — the lifecycle persists across an engine restart (0030/0031),
  and an expired thread is still present (never deleted; non-degradation).
- **(e) The season surfacing cap holds.** Over a long seeded sim, the count of threads that ever reach
  `surfaced` never exceeds `THREAD.maxSurfacedPerSeason` — the L40 restraint guard, asserted as a property over
  seeds (the analogue of 0059's "cast never saturated with romances").
- **Determinism (unit).** Same seed + trigger sequence ⇒ identical thread transitions; the scheduler never
  perturbs the main house stream (stats/names byte-stable, 0007).

## 11. Out of scope / relationships

- **Out:** the consequence-fold math (0023), the soul-evolution math (0041), the gossip-diffusion mechanics
  (0038), the pathway-anchoring rules (0002/E9), the Vault sealing/persistence (0001/0025/0030) — 0060 **calls**
  these, it re-implements none. Also out: 0058's other Phase-2 deferrals (LLM write-back wiring, portrait
  consumption L29, premiere voicing L31) and **player-actionable** surfacing (§9, a later phase).
- **Feeds / pairs with:** **0058** (Phase 2 — the play-out half), **0059** (its seeded ties may surface through
  this same scheduler with a shared cap, §9), **0038** (the tick this rides), **0023/0041** (the folds it
  triggers), **0048** (the retrospective unsealing finally has *resolved/expired* thread arcs to show).
