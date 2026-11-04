# 0017 — Relationship model

> **Status:** Built (see the [README status index](./README.md#index)). **Promotes [decision 0002](../decisions/0002-relationship-model.md) into an
> executable spec.** The single most important social signal in the sim — *who you confide in and
> who your enemies are* — as **directed, graded, asymmetric, computed beliefs**, never binary
> flags. The engine already has a relationship seam (`src/engine/relationships.ts`, used by 0003's
> alliance churn); this feature makes its **properties assertable**.
> **Executable spec:** [`0017-relationship-model.feature`](./0017-relationship-model.feature)
> **Also proven by:** `tests/unit/relationshipModel.test.ts`

> **Known limit (AMEND 0024/0017 #5, 2026-11-04):** an edge's `confidence` and the `read()` projection are *modelled and tested* but not yet *consumed* by any strategic decision (nominations, vetoes, votes, campaigns, approaches read trust/affinity/threat, not confidence). They are inputs for the unified memory/belief design (#2017 acceptance criteria: every decision reads all memory sources through one interface; see `design/npc-memory-inventory.md`). Do not describe confidence as shaping behaviour until a reader exists.

## 1. Summary

Relationships live in the dynamic `Soul` as **directed edges** computed from the accumulated event
history (what was witnessed, said, and done) folded through the holder's `Character` disposition
and the temperature roll. Each edge `A→B` carries **graded signals**, not an ally/enemy enum.
Labels ("ride-or-die," "a threat I'm keeping close") are **organic — derived on the spot through
the holder's framing, never stored.** This is where *Big Brother*'s drama comes from: misreads,
slow drift, sudden betrayal, one-sided trust.

Following the precedent of 0006 (temperature) and decision 0001, this feature **pins the shape and
invariants**; the **numeric math is tunable config**, designed alongside the temperature constants
(0006) — not hard-coded into the spec.

## 2. Scope

**In:** the directed-edge signal set; asymmetry; computed-from-history (not stored labels);
**uncertainty/confidence**; the update dynamics' **shape** (recency, betrayal-shock, decay);
dispositional thresholds; the consumers (Houseguest's Choice, confiding, targeting, jury lean).

**Out:** the exact numbers (tunable config, like 0006); the gossip/knowledge pathways that *feed*
the history (**0002**); competition outcomes (**0006**); jury-vote choreography (**0014** — this
feeds it); how relationships are *generated at start* (they aren't — they accrue from play, 0015).

## 3. The model (from decision 0002)

A directed edge `A→B` carries continuous, graded signals (exact set tunable):

| Signal | Drives |
|---|---|
| **trust** | who A confides in / shares secret information with |
| **affinity** | warmth / closeness / liking (bonds, showmances) |
| **threat** | how dangerous A thinks B is to A's game (targeting, nominations) |
| **alignment** | overlap of strategic interest *this week* (shifts fast) |
| **reliability** | track record — has B actually had A's back? (from past votes/actions) |
| **confidence** | how much interaction data backs this read — **uncertainty**, shrinks as data accrues |

## 4. Properties (the invariants this feature asserts)

- **Directed & asymmetric.** `A→B` ≠ `B→A`. One-sided showmances, misread loyalty, and the
  player's signature **paranoia** live in the gap between the two directions.
- **Computed, not stored as labels.** A relationship-inference function folds the event history
  (recency-weighted, **shocks** on betrayal, **decay** on neglect) into the signals. Only the
  graded signals + history are persisted; **no label is ever stored.**
- **Uncertain.** Low `confidence` early — a houseguest can *lean* / *suspect* long before they can
  act, mirroring the knowledge-vs-suspicion rule (0002). Confidence grows with interaction data.
- **Labels are organic.** Any "ally / enemy / best friend" reading is a **soft, momentary
  description** computed off the signals **through the holder's `Character` framing** — the same
  edge surfaces differently to different holders, and **thresholds are dispositional** (a paranoid
  archetype tips to "threat" far sooner than a trusting one). Labels **emerge from character +
  history, not a global rulebook**, and drift as signals move.

## 5. Update dynamics — shape fixed, numbers tunable

The spec fixes the **direction** of each force; the magnitudes are config (0006-style):

- **Recency-weighting:** recent events weigh more than old ones.
- **Betrayal-shock:** a witnessed adverse action (a blindside, a broken word) drops trust/affinity
  **sharply** and raises threat — a step change, not a gentle slope.
- **Decay / mean-reversion:** a neglected edge drifts back toward the holder's baseline over time.
- **Reliability accrues from acts:** kept promises and protective votes raise it; betrayals cut it.
- **Temperature variance:** the per-moment roll (0006) adds bounded noise — relationships don't
  move in perfectly smooth lines — but **never** flips a well-evidenced read on a single roll.

## 6. Consumers

- **The consequence loop** (**0023** — the live wiring): every recorded player↔NPC happening folds
  its impact into these edges and **persists**, so the **player's own actions change how
  houseguests feel about them** — on the live path, not only the off-screen sim. 0017 is the
  *model*; 0023 is where it **updates on live play and is saved/recalled**.
- **Veto "Houseguest's Choice"** (0005): an NPC holder picks their **strongest available bond** as
  scored here — with temperature variance, not a fixed flag.
- **Confiding / scheming:** gated by `trust`. **Nominations / targeting:** driven by `threat`.
- **Alliance churn** (0003): an alliance "forms" when an edge crosses that holder's bar and
  "fractures" when it falls back — the existing richness metric measures exactly this.
- **Jury management** (0014): the edge trajectory **at eviction** (blindsided vs. respected) feeds
  the juror's later lean.

> **Human-driven player reads (the boundary).** The engine tracks both `NPC→player` and
> `player→NPC` edges from history — the `NPC→player` edges drive NPC behavior; the `player→NPC`
> edges only ever inform the engine's read of player strategy. **Neither is ever shown to the
> player as a value.** The player's *own conscious* read of the house is the **human's** — they
> infer trust and threat from behavior and narration; the engine never hands them a number (0020,
> 0023). The model is computed and hidden; the *feeling* is theirs.

## 7. Contracts (stack-agnostic)

```
relationshipOf(holder, other) -> Edge{ trust, affinity, threat, alignment, reliability, confidence }
    # computed from event history (recency-weighted; betrayal-shock; decay) × holder Character × temperature
    # DIRECTED: relationshipOf(A,B) may differ from relationshipOf(B,A)
labelFor(holder, other) -> string        # organic, derived ON THE SPOT through holder's framing; NEVER stored
strongestBondFor(holder, candidates) -> other   # Houseguest's Choice consumer (0005), temperature-varied
# Persisted: only the graded signals + the event history. NO label, NO binary ally/enemy enum, anywhere.
```

**Invariants:** edges are directed (asymmetry possible and observed); **no** label or ally/enemy
enum is persisted; `confidence` is low with little data and rises with more; a witnessed betrayal
produces a sharp adverse step; a neglected edge decays toward baseline; the same history yields
**different** labels under different `Character` dispositions; seed-reproducible.

## 8. Test strategy

- **Graded, not binary:** an edge exposes the continuous signal set, not an ally/enemy flag.
- **Asymmetry:** construct a history where A invests in B but B doesn't reciprocate; assert
  `A→B` ≠ `B→A` (one-sided trust).
- **Computed from history:** with no interactions, `confidence` is low and the read is "suspect,
  not know" (cross-checks 0002); adding consistent interactions raises `confidence`.
- **Betrayal-shock:** inject a witnessed betrayal; assert trust/affinity drop sharply and threat
  rises in one step.
- **Decay:** with no further interaction, an edge reverts toward baseline over time.
- **No stored label:** serialize the soul and assert it contains the signals + history but **no**
  label / ally / enemy field (cross-checks 0007 non-degradation — signals deepen, labels never
  persist).
- **Dispositional labels:** the **same** history under a paranoid vs. a trusting `Character`
  yields different organic labels at the same moment.
- **Consumer — Houseguest's Choice:** an NPC holder picks the strongest available bond per the
  signals, temperature-varied (cross-checks 0005).
- **Seeded & reproducible** throughout (property-style over many histories/seeds).

## 9. Open / to confirm (tunable, non-blocking)

Per decision 0002: the **signal set** (the six are a starting point) and the **math** — update
rule, recency/decay rates, betrayal-shock size, dispositional thresholds — are **tunable config**
to design with the temperature constants (0006). The **shape** above is fixed; the **numbers**
are not. NPC→player edges are tracked the same way (the engine reads how NPCs feel about the
player); the player's **own** reads stay human-driven (the player isn't told a number — they
infer, and may be wrong).

## 10. Definition of Done

- [ ] All scenarios pass, name-agnostic, seed-reproducible.
- [ ] Edges are directed, graded, and **asymmetric**; no binary flag anywhere.
- [ ] Reads are **computed from history** with low-data uncertainty that shrinks as data accrues.
- [ ] Betrayal-shock and decay behave per the fixed shape; magnitudes are config.
- [ ] **No** label / ally / enemy enum is ever persisted; labels are derived organically and
      vary by `Character` disposition.
- [ ] Houseguest's Choice and targeting read this model (cross-checks 0005); jury lean consumes
      the trajectory at eviction (feeds 0014).

## 11. Dependencies

**Decision 0002** (the architecture this promotes), **0002 event-visibility** (the history +
knowledge/suspicion this reads), **0003** (alliance churn = edges crossing thresholds — the
existing `relationships.ts` seam), **0005** (Houseguest's Choice consumer), **0006** (temperature
roll + the tunable-constants precedent), **0007** (signals deepen, labels never persist),
**0014** (jury lean), **0015** (relationships accrue from play, not authored).

## 12. Traceability

`docs/decisions/0002-relationship-model.md` (the full decision record this promotes);
`docs/bb-sim-spec.md` §11 (Relationship/edge: type, strength, known-by set), §6 (knowledge vs
suspicion); `docs/features/0003-behavioral-fidelity.md` (alliance churn); `CLAUDE.md` (organic
relationship model; "any ally/best-friend/enemy label is organic and emergent … never stored").
