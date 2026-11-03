# 0026 — Relationship math (firmed update rule & tunable constants)

> **Status:** Built (see the [README status index](./README.md#index)). Concretizes [0017](./0017-relationship-model.md)'s *shape* (directed, graded,
> computed signals) into a **firmed update rule + default constants** — the numbers behind every
> edge, and what **0023's `apply()`** uses. **Baseline feel: realistic & competitive (sticky /
> grudge-holding)** — betrayals linger, trust is earned slowly. **But the feel is per-game, not
> global:** each houseguest's **disposition** × **per-game/per-moment temperature** pushes a given
> cast anywhere on **sticky ↔ volatile ↔ forgiving**, so every season feels different. **Every
> number is tunable config** — retune the feel later without touching logic.
> **Executable spec:** [`0026-relationship-math.feature`](./0026-relationship-math.feature)
> **Also proven by:** `tests/unit/relationshipMath.test.ts`

## 1. Summary

0017 fixed *what* a relationship edge is (the graded signals, organic labels, asymmetry). 0026
fixes *how the numbers move*: the per-interaction impacts, betrayal-shock, decay/mean-reversion,
confidence growth, and the thresholds — grounded so the consequence loop (0023) applies consistent,
believable changes. Two principles from the product call shape it:

- **Realism is the lodestar, and BB is competitive** → the **default** weights lean **sticky**: a
  blindside hits hard and is remembered for weeks; trust accrues slowly from real acts. Actions
  follow you (this is what gives 0023/0024 their weight).
- **Each game is dynamic** → the feel is **emergent, not a global knob**. A *paranoid* cast plays
  grudge-holding; a *social* cast plays bond-driven; per-game/per-moment temperature varies it
  further — and the same seed reproduces it. Realism = the dynamics are believable and cast-grounded.

## 2. Scope

**In:** the signal set (firmed); the **update rule** (`apply`); **betrayal-shock**; **decay /
mean-reversion**; **confidence** growth; the **disposition × temperature** modulation that makes the
feel per-game; the organic-label **thresholds**; the **single tunable-constants module**.

**Out:** the relationship *shape/architecture* (**0017** — this firms it, doesn't redraw it); the
**live wiring** of events → `apply` (**0023** — consumes this); temperature *distributions*
(**0006**); the player's **human-driven reads** (**0020** — the player never sees these numbers).

## 3. Signals (firmed, from 0017)

Each directed edge `A→B` carries continuous signals in `0..1`: **trust**, **affinity**, **threat**,
**alignment**, **reliability**, **confidence**. Baseline (neutral, low-data) values are config.

## 4. The update rule (`apply`)

An interaction of a given **type** moves the signals by a per-type **impact** (the
`relationships.ts` `IMPACT` table — `bonding/strategy/alliance/showmance/gossip/conflict/betrayal`).
The firmed rule:

```
signal' = clamp01( signal + impact[type][signal]
                          × dispositionFactor(holder, signal)   # who the holder IS (§7)
                          × temperatureJitter(moment) )          # bounded per-moment variance (0006)
confidence' = clamp01( confidence + CONFIDENCE_STEP )            # more data ⇒ firmer read
```

Applied to **both** directions (asymmetrically — each holder's disposition differs). **Recency-
weighted:** recent interactions weigh more; the model reads the *trajectory*, not just the sum.

## 5. Betrayal-shock (the sticky default)

A **witnessed** adverse act (a blindside, a broken word) is a **step change**, not a slope:
trust/affinity drop **sharply** and threat jumps. By default the magnitude is **large** and its
**decay is slow** (§6) — the grudge lingers. This is the competitive, realistic core; it is the
single biggest lever on "feel," and it is **config** (`BETRAYAL_SHOCK`).

## 6. Decay / mean-reversion

A **neglected** edge drifts toward the holder's **baseline** over time at `DECAY_RATE`. Default is
**slow** (sticky — grudges and bonds persist when untended), but **disposition scales it**: a
forgiving archetype decays grudges faster; a paranoid one barely at all. Betrayal-shock decays
slower than ordinary drift, so a blindside outlasts a cold shoulder.

## 7. Disposition × temperature = the per-game feel (the crux)

The feel is **not** one setting. `dispositionFactor(holder, signal)` is derived from the holder's
**`Character`** (archetype/temperament — paranoid, trusting, volatile, loyal…): it scales how hard
betrayals land, how fast trust builds, how quickly grudges fade. Layered with per-moment
**temperature** (0006), this means:

- a **paranoid / villain** cast trends **sticky & grudge-holding**;
- a **social-butterfly / loyalist** cast trends **bond-driven & forgiving**;
- most casts land **in between**, and **temperature** keeps any single game from feeling fixed.

Same seed ⇒ same feel (testable). Different casts/seeds ⇒ a **measurable spread** of feels. That
spread *is* the dynamic-game requirement.

## 8. Thresholds (organic, dispositional — 0017)

The alliance bar and any "ally / enemy / closest-confidant" reading are **derived on the spot**
through the holder's disposition (never stored). Thresholds are **dispositional**: a paranoid holder
tips an edge to "threat" at a lower bar than a trusting one. All threshold numbers are config.

## 9. Tunable constants (one place)

**Every number** — the `IMPACT` table, `BETRAYAL_SHOCK`, `DECAY_RATE`, `CONFIDENCE_STEP`, the
disposition factors, the thresholds — lives in **one config module** (sibling to the temperature
constants, 0006, and `richnessConfig.ts`). The **shape is fixed; the numbers are config**, so the
overall feel can be retuned later (or made a future admin/God-Mode knob, 0016) without touching the
update logic.

## 10. Contracts (stack-agnostic)

```
RELATIONSHIP_CONSTANTS = {                          # the single tunable module — retune the "feel" here
  baseline, IMPACT, BETRAYAL_SHOCK, DECAY_RATE, CONFIDENCE_STEP,
  dispositionFactors, thresholds,
}
applyInteraction(edge, type, holderDisposition, temperature) -> edge'   # §4 rule; both directions; recency-weighted
decayToward(edge, baseline, holderDisposition, dt) -> edge'             # §6; betrayal-shock decays slower
# Consumed by 0023's apply(); read by 0017's labelFor / strongestBondFor.
```

**Invariants:** default dynamics are **sticky** (a betrayal's drop persists after a quiet stretch);
the **same history yields a stickier read for a paranoid disposition than a forgiving one**;
across casts/seeds the aggregate feel shows a **measurable spread** (dynamic per game); betrayal is
a **step change**; confidence rises with data; **all numbers are config** (changing one changes the
dynamics); seed-reproducible.

## 11. Test strategy

- **Sticky default:** inject a betrayal, then a quiet stretch; trust stays depressed (slow decay) —
  the grudge lingers.
- **Disposition varies the feel:** the *same* interaction history under a paranoid vs a forgiving
  `Character` yields a stickier vs softer edge (and faster vs slower grudge decay).
- **Per-game spread:** over many seeds/casts, the aggregate "stickiness" varies measurably — no two
  seasons feel identical; yet each is reproducible by seed.
- **Betrayal-shock is a step:** one witnessed betrayal produces a large single-step adverse move.
- **Confidence:** rises monotonically with interaction data.
- **Tunable:** changing a constant in the module changes the resulting dynamics (the config is the
  single knob).

## 12. Definition of Done

- [ ] The firmed `apply` rule, betrayal-shock, decay, and confidence growth are implemented from a
      **single tunable constants module**; 0023's `apply()` uses it.
- [ ] **Default feel is sticky/realistic**; a betrayal lingers through a quiet stretch.
- [ ] **Disposition × temperature** make the feel **per-game** — a measurable spread across casts,
      reproducible by seed.
- [ ] Organic-label thresholds are dispositional (0017) and config-driven.
- [ ] No number is hard-coded outside the constants module; the player never sees a value (0020).

## 13. Dependencies

**0017** (the shape this firms), **0023** (`apply()` consumes it), **0006** (the temperature it
layers), **0004/0015** (the `Character` disposition), **0024** (recall-weighted history feeds the
read), **0020** (the player infers, never sees the numbers). Builds on the existing
`src/engine/relationships.ts` `IMPACT` table.

## 14. Downstream effects — what has expanded this since (PO note, 2026-07-06)

0026 is the **base layer**: the raw per-interaction update, betrayal-shock, decay, confidence, and the
disposition × temperature modulation. A large ecosystem of *built* features now layers effects on top of
it — this cross-reference keeps the picture honest (the relationship math became the spine of the social
game). None of them redraw the §4 rule; they consume, arc, gate, or derive-structure-from the edges it
produces, and every one still keeps the numbers Vault-side (0020 — the player only feels them):

- **Layering the feel over a season:** **0028** (temperature / emotional-modifier constants), **0041**
  (character evolution — souls evolve and bend the competition modifier + reads across the game).
- **Arcs on top of the raw numbers:** **0087** (warming/cooling relationship *trajectories* — the most
  direct expansion), **0024** (recall-weighted history keeps the *relevant* past sharp, not just recent).
- **Structures derived from the relationship graph:** **0043** (emergent blocs), **0107** (named
  alliances), **0059** (hidden pre-seeded edges), **0095** (pre-show ties → time-bombs).
- **Trust/confidence-gated behavior:** **0075** (what an NPC will confide is gated by trust), **0098**
  (confidence-calibrated reads).
- **Deals & leverage acting on trust:** **0039** (promises/deals), **0109** (deal duration), **0093** /
  **0099** (secrets as levers / currency).
- **Beliefs that can be wrong (the 0002 hidden layer):** **0038** (gossip diffusion), **0094** (distorted
  gossip has real consequences).
- **Grudges at the endgame:** **0100** (jury grudge book — the sequestered jury-house hardening on top of
  the eviction-manner grudge), **0110** (the jury grudge folds on a *deduced* belief, not the true ballot).
- **The consumer of the fold:** **0023** (the live consequence loop applies this rule every recorded scene).

## 15. Traceability

`docs/decisions/0002-relationship-model.md` ("the math — update rule, recency/decay, betrayal-shock,
thresholds — are tunable config… a dedicated feature spec can follow once the math firms up"); this
session's calibration (realistic/competitive default-sticky, **per-game dynamic** feel, all weights
tunable); `docs/features/0017` (shape), `0006` (temperature constants precedent).
