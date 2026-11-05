# 0087 — Relationship trajectories (a bond that warms or curdles, with momentum)

> **Status:** ✅ **BUILT (2026-06-27).** Design note + executable `.feature`, wired into `cucumber.cjs`
> and green. Source: `src/engine/trajectory.ts` (the pure `Trajectory` / `deriveTrajectory` /
> `decayTrajectory` / `tiltNatureWeights`) + `src/engine/trajectoryConstants.ts` (the single tunable);
> the optional `trajectoryOf` dep on `richOffscreenStretch` (`src/engine/offscreen.ts`); the momentum
> store + per-pair fold ring buffers + persistence on `GameSessionAdapter`; and the off-screen-tick wiring
> in `src/composition/orchestrator.ts`. Default ON behind the **dedicated `ORWELL_TRAJECTORIES` flag** (`=0` opts out)
> (default OFF) so neutrality is provable in isolation. Gates: `tests/unit/trajectoryOutcomeNeutral.test.ts`
> (the byte-identity / draw-stream battery), `tests/unit/trajectory0087.test.ts` (the pure derivation +
> tilt), `tests/unit/trajectoryWiring0087.test.ts` (wiring + persistence + the Vault-wall byte-identity
> proof), and the `juryReach` / UAT spines (re-verified byte-identical with the flag off). Tracks #863.
>
> **Open questions resolved at build (per §"Open questions / defaults"):** (1) the flag — a **dedicated
> `ORWELL_TRAJECTORIES`** (not a reuse of `ORWELL_CAMPAIGNS`), so the calibration spine is provably
> byte-identical with trajectories alone disabled; (2) recency window 4 folds, momentum building per
> consistent fold and **spiking on betrayal**, decaying at the 0026 neglect cadence; (3) a tight,
> momentum-scaled tilt cap (≤60% of a nature's own weight at full momentum) so off-arc beats stay
> possible (criterion 2); (4) **`NPC→player` trajectories YES** — engine-computed, behavior-only, never
> shown (the directed `recordTrajectoryFold` keys any `a→b` pair, the player included); the player's read
> of any NPC stays purely human-driven; (5) trajectories do **not** feed 0086 drives yet (a later pass —
> this feature only exposes the layer).
> **Depends on:** 0002 (the relationship model — the directed graded edges a trajectory rides on),
> 0017/0026 (the relationship math + the single `relationshipConstants` tunable), 0023 (the hidden
> consequence/memory fold a trajectory accumulates from), 0038/0078 (the off-screen society redesign
> — `richOffscreenStretch` / `natureWeights`, the scene-nature selection a trajectory biases),
> 0086 (houseguest drives — the sibling "engine-owned hidden term, surfaced only through behavior"
> pattern; a drive is *this week's* intent, a trajectory is the *multi-week arc*). **Sibling of**
> 0086 (the same Vault-safe, calibration-neutral discipline). **Bounded by:** mandate #1 (behavioral
> fidelity — coherent arcs are the point), mandate #2 (the Vault Wall — the momentum term is hidden
> engine state, never crossed to the player **or** admin, surfaced only through behavior), mandate #3
> (anti-sycophancy — the engine owns the magnitude; the model only proposes shape and narrates), and
> ADR 0005 (split authority by openness). **Relates to** the off-screen dedup / double-log fixes
> (#841 / #842) — a trajectory is computed from the deduplicated event history, never inflated by a
> double-logged scene.

## The problem (from watching the off-screen society)

Today every off-screen NPC↔NPC scene is selected **independently per tick**. `richOffscreenStretch`
draws a pair by tie strength and then rolls the scene's *nature* from `natureWeights(edgeOf(a, b))`
(`src/engine/offscreen.ts`) — a fresh weighted pick from the *current* edge signals, with no memory
of where the relationship was *heading*. The result is **whiplash**: a pair can bond on Monday,
clash on Tuesday, and bond again on Wednesday, because each scene is an i.i.d. draw off a slowly
moving edge. The edges drift coherently (0026's decay/shock), but the *scenes the player overhears
or is told about* do not — so the off-screen society reads as noise rather than as **arcs**.

Real _Big Brother_ is made of trajectories: a friendship that visibly **curdles** over weeks (warm
→ strained → cold → the blindside), an alliance that **deepens** (allies → ride-or-die), a rivalry
that **thaws**. The drama is in the *direction and momentum*, not any single scene. The current
model can produce the right *endpoints* (the edges land somewhere) but not the right *shape of the
journey*, which is exactly what a viewer (the player) reads as story.

## The core idea — a relationship has momentum, not just a position

Model each directed relationship as a **trajectory**: alongside the position (the 0002 `EdgeSignals`)
the engine keeps a small, hidden, engine-owned **momentum** term — the *direction the bond is
moving* — that **biases scene-nature selection** so consecutive off-screen scenes between a pair
tend to **continue the arc** rather than reverse it.

```
Trajectory(A → B) {
  // position — UNCHANGED: the existing 0002 directed edge (trust/affinity/threat/…)
  // momentum — NEW, hidden, engine-owned:
  phase:    "warming" | "cooling" | "souring" | "steady"   // the arc's current direction
  momentum: number   // 0..1 — how committed the arc is (how strongly it resists reversal); Vault-only
}
```

- **`phase`** is derived from the *recent* trajectory of the edge — the sign and size of the bond's
  net movement over the last few folded scenes (warming = bond rising, cooling = bond falling
  without hostility, souring = bond falling *with* threat rising — the curdle). It is a read of
  history, never hand-set.
- **`momentum`** scales with how *consistent* that recent movement has been: a string of warm
  scenes builds warming momentum; a betrayal spikes souring momentum hard (the 0026
  `BETRAYAL_SHOCK` is the natural momentum injector). Momentum **decays** toward `steady` when the
  pair is neglected — an arc that nobody feeds reverts to a flat relationship, mirroring 0026's
  edge decay.

### How momentum changes the off-screen society (the one real mechanism)

The single behavioral change is in **scene-nature selection**. `natureWeights(edge)` today returns a
propensity per nature from the *position only*. A trajectory **tilts those weights toward natures
that continue the current `phase`**, proportional to `momentum`:

| Phase | Tilt (continuation bias) |
|---|---|
| `warming` | up-weight `bonding` / `showmance` / `alliance`; down-weight `conflict` / `betrayal` |
| `cooling` | up-weight `conflict`; down-weight `bonding` / `showmance` |
| `souring` | up-weight `conflict`, and (once the 0078 betrayal gate is already met) `betrayal`; strongly down-weight `bonding` |
| `steady` | **no tilt** — exactly today's `natureWeights` |

So a curdling friendship gets *more* clash scenes as it cools, which fold *more* souring (0023),
which raises souring momentum further — a **self-reinforcing arc** that produces the visible
multi-week curdle. The tilt is **bounded** (a `momentum`-scaled fraction in one tunable, never a
hard override): a strong enough underlying tie can still produce an off-arc scene (the reconciliation
beat, the unexpected fight), so arcs bend probabilities, they don't railroad. The 0078 **betrayal
gate stays absolute** — souring momentum can never manufacture a betrayal between a pair without the
existing prior-bond + incentive floor; momentum only re-weights *eligible* natures.

This is deliberately the **smallest possible surface**: trajectories add a hidden term and a bounded
re-weight of an *already-existing* weighted pick. They do **not** add a new event kind, a new edge
signal that crosses to the player, a new scheduler, or any new player-facing surface.

## Engine-owned magnitude vs model-proposed shape (ADR 0005)

This feature lives almost entirely in the **closed set**, with one careful seam into the open set:

- **Closed set (engine dictator):** `phase`, `momentum`, the continuation-bias weights, and the
  *amount* every scene folds are all engine-computed, bounded, and seeded. Nothing here is a creative
  utterance with content to lose — it is the hidden geometry of how relationships move. The engine
  owns it absolutely (anti-sycophancy #3).
- **Open set (engine is a faithful recorder, never a normalizer):** when a *player-witnessed* scene
  is recorded (`recordInteraction`), the model may already propose the consequence **shape** (ADR
  0005's `consequence` descriptor — which edge moves, which direction, relative `emphasis`). A
  trajectory **reads** that proposed direction to update `phase`/`momentum` the same way it reads any
  folded scene — but it **never** lets the proposal set the *amount* of momentum, and **never**
  collapses the player's free-text into a phase bucket in a way that changes what can be narrated
  next. The prose stays lossless; momentum is just one more hidden quantity derived from the same
  bounded, engine-owned fold. Per ADR 0005's litmus: this constrains only the closed set (how a
  hidden number moves) and leaves the open set (what is said/played) untouched.

A trajectory therefore **never widens what the LLM may magnitude.** Widening what the model may
*propose* about a scene's shape (open-set interpretation) feeds the trajectory's *direction* only;
the trajectory's *strength* is engine-owned, exactly as `rel.applyDirected` magnitude is today.

## Vault-safe by construction (mandate #2 — symmetric for player AND admin)

`phase` and `momentum` are **hidden engine state**, held beside the 0002 edges in the engine-only
relationship layer. They are surfaced to the player **only through behavior** — the *kinds of scenes*
that happen off-screen and reach the player through the existing pathways (overhearing, gossip
diffusion, an NPC telling them), and the in-character tone the model voices. The same wall holds for
**admin / God Mode**: a trajectory is Vault-class hidden state, never returned on any admin
projection (the 0086 symmetry — admin is walled from the Vault too).

The structural guarantees (none is prompt wording):

1. **No number ever crosses.** `phase`/`momentum` appear on **no** player-facing or admin-facing
   projection — not on `npcVoice`, not on the board, not on any status surface. The load-bearing
   Vault-wall test sweeps the assembled prompt + every projection for the momentum term and finds
   nothing (the 0075 / 0086 sentinel pattern).
2. **It surfaces only as behavior, through a pathway.** A curdling arc reaches the player only when a
   clash scene it produced is overheard / gossiped / told — an ordinary recorded 0002 knowledge
   event. The player **infers** "those two are falling apart"; the engine never asserts it. Paranoia
   and the reading of arcs stay the human's to form (0017/0020).
3. **Perspective-bound, like the edge it rides.** A trajectory is directed (`A→B`) and computed from
   `A`'s own folded history — never an omniscient, house-wide "drama meter." A houseguest's arc
   toward another can only reflect scenes that genuinely folded into that edge.

## Determinism & calibration neutrality (HARD — the load-bearing constraint)

The off-screen society's rng stream is **calibration-load-bearing**: the same seeded stream that
draws off-screen scenes also advances the seeded competition/vote spine, so any change to its draw
count or order would re-phase `tests/property/juryReach*` and the UAT. Trajectories must be
**provably inert** to that spine. The discipline (the 0085/0086 pattern):

- **Opt-in, default OFF.** Trajectories run only behind an explicit flag (the 0086 `ORWELL_CAMPAIGNS`
  sibling — a dedicated `ORWELL_TRAJECTORIES` or reuse of the live-society flag, decided at build).
  Unset ⇒ no trajectory is computed, `natureWeights` is the identity, and `juryReach` / the UAT /
  the `calibrationGradient` gates are **byte-identical**.
- **Draw-count-stable when on.** The continuation tilt **re-weights** the *existing* `weightedPick`
  over natures — it adds **no new rng draw** and consumes none; the same single nature draw happens,
  only its weights differ. (Momentum is read from already-folded history; updating it is pure, takes
  no rng.) So even with trajectories ON, the off-screen stream's *draw sequence* is unchanged — only
  which nature a given draw lands on shifts, which is the intended behavioral change and is the
  *purpose* of the live-society flag, not a calibration regression. The competition/vote rolls that
  read the *same* stream stay in phase.
- **A dedicated neutrality gate.** `tests/unit/trajectoryOutcomeNeutral.test.ts` (the
  `stagedTrajectoryNeutral` / `deepProfileOutcomeNeutral` sibling) asserts: with the flag off, the
  off-screen scene sequence AND the seeded competition/vote outcomes are byte-identical to the
  pre-feature build for a fixed seed battery.
- **Pure, seeded core.** `phase`/`momentum` derivation is a pure function of the folded edge history
  + constants; same seed + same history ⇒ same trajectory ⇒ same tilt. No wall-clock, no I/O.

## How this stays "the conversation is the game" (ADR 0003)

Trajectories do **not** add a dashboard, a "relationship status: cooling ▼" readout, or any UI. They
make the *off-screen society the player overhears and is told about* cohere into arcs — so the
conversation the player has *about* the house ("have you noticed those two lately?") has a real,
deepening substrate. The model is still handed **facts to voice** (the scenes that happened, the
tone), never a script: the engine decides the arc's geometry; the model narrates the behavior; the
player forms the read. It removes whiplash (a degradation), it does not add machinery the player must
operate.

## Why it deepens immersion / retention

A house whose relationships have momentum produces **stories that pay off over weeks** — the slow
curdle that culminates in the blindside, the rivalry that thaws into an unlikely alliance. That
multi-week coherence is the single biggest difference between "a sequence of scenes" and "a season."
It gives the player something to track and predict (and be wrong about — the bounded off-arc beat),
which is exactly the engagement loop that keeps a long-form social sim alive across many sessions. It
also directly strengthens the non-degradation mandate: the arc is *accumulated* hidden state that
deepens over the game, never thins.

## Engine seams (where this lands)

- `src/engine/relationships.ts` / a new `src/engine/trajectory.ts` (pure) — the `Trajectory` type,
  `deriveTrajectory(recentFolds, prior, constants)` (phase + momentum from recent edge movement;
  pure, no rng, no Vault handle), and `tiltNatureWeights(weights, trajectory, constants)` (the
  bounded continuation re-weight applied over `natureWeights`'s output). Momentum is stored beside
  the directed edge in the engine-only relationship layer; `serialize`/`load` carry it (persistence).
- `src/engine/relationshipConstants.ts` (or a sibling `trajectoryConstants`) — the single tunable:
  the recency window, the momentum build/decay rates, the per-phase continuation-bias weights, and
  the `momentum`-scaled tilt cap. The `THREAD`/`GOSSIP`/`DRIVE` constants sibling (B59 grep gate).
- `src/engine/offscreen.ts` — `richOffscreenStretch` gains an optional, Vault-free
  `trajectoryOf?(a, b)` dep; when present (live-society on) it passes the tilted weights to the
  existing `weightedPick` over natures. Absent ⇒ today's `natureWeights` exactly (byte-identical).
- `src/composition/orchestrator.ts` — the off-screen tick wires `trajectoryOf` from the engine
  relationship layer beside the existing `edgeOf`/`occupancy`, and updates each pair's momentum from
  the scenes just folded (engine-side, after the fold). All behind the live-society flag.
- **Persistence (0007/0030 — non-degradation):** `phase`/`momentum` persist in the relationship
  snapshot beside the edges; a restored game resumes mid-arc. Absent on pre-0087 saves ⇒ resume at
  `steady`/0 (byte-identical to a pre-feature load). It deepens, never thins.

## Acceptance criteria

1. A pair fed a consistent run of warm (resp. souring) folded scenes develops `warming` (resp.
   `souring`) momentum, and their subsequent off-screen scene-nature draws tilt toward continuing the
   arc — measured over a seeded batch, the *distribution* of natures shifts in the arc's direction
   versus the no-trajectory baseline.
2. The tilt is **bounded**: a strong underlying tie still produces off-arc scenes at a nonzero rate
   (no railroading); the 0078 betrayal gate is never bypassed by momentum.
3. **Vault wall:** `phase`/`momentum` appear on no player-facing or admin-facing projection; a
   curdling arc reaches the player only as overheard/told clash scenes (recorded knowledge events),
   never as a number or a status label.
4. **Calibration neutrality:** flag off ⇒ off-screen scene sequence + seeded competition/vote
   outcomes byte-identical to the pre-feature build; flag on ⇒ the off-screen stream's *draw count and
   order* are unchanged (only nature outcomes shift), so the competition/vote spine reading the same
   stream stays in phase.
5. **Determinism:** same seed + same folded history ⇒ same `phase`/`momentum` ⇒ same tilt.
6. **Persistence:** momentum survives save/restore; a restored game resumes the arc; a pre-0087 save
   loads at `steady` with no error.
7. **Perspective-bound:** a directed trajectory reflects only scenes that folded into that directed
   edge — never an omniscient house-wide drama signal.

## Open questions / defaults (resolve at build)

1. **The flag.** Reuse the live-society flag (`ORWELL_CAMPAIGNS`, since trajectories only matter when
   the off-screen society runs live) vs. a dedicated `ORWELL_TRAJECTORIES`. Default recommendation:
   reuse — trajectories are part of the live society, and a separate flag adds a calibration matrix
   axis for no gain.
2. **Recency window + build/decay rates.** How many recent folds define `phase`, and how fast
   momentum builds vs. decays toward `steady`. Start: a short window (≈ last 3–4 folds), momentum
   building gradually but spiking on `BETRAYAL_SHOCK`, decaying at the 0026 neglect cadence. Tune
   against the UAT once live (felt, never deterministic; must read as arcs, never as a flat new knob).
3. **Tilt cap.** The maximum `momentum`-scaled fraction the continuation bias may add to a nature
   weight — tight enough that off-arc beats stay possible (criterion 2). Calibrate against the
   off-screen nature distribution so it deepens arcs without flattening the society's variety.
4. **NPC↔player trajectories.** Whether the player's *own* directed edges carry a visible-through-
   behavior trajectory (an NPC's arc *toward the player* warming/souring over weeks, surfaced only as
   that NPC's tone). Recommended: yes for `NPC→player` (engine-computed, behavior-only, never shown —
   the 0086 rule); the *player's* read of any NPC stays purely human-driven (never engine-modeled).
5. **Cross-feature: trajectories feeding drives (0086).** A souring `A→B` trajectory is a natural
   seed for `A`'s `target` drive against `B` (the arc *is* the grudge forming). Recommend: 0087
   exposes the trajectory; a later pass lets 0086 consume it — keep this feature to the trajectory
   layer.

## Tracks #863
