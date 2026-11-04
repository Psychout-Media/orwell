# 0041 — Character evolution & season arc

> **Status:** ✅ GREEN (in `cucumber.cjs`) — **the linchpin landed.** The live sandbox's `EngineCore`
> (`buildEngineCore`) now wires a `SoulStore` (deterministic embed), walled engine-only by
> dependency-cruiser like the Vault. The live consequence fold (`GameSessionAdapter.commit`) and the
> off-screen tick (`Orchestrator.defaultApply`) drive each NPC's soul from real events:
> `src/engine/emotionalArc.ts` (`evolveEmotion`) moves the soul `emotionalState` + `volatility` by
> **bounded, mean-reverting** deltas (blindside ⇒ distress/volatility ▲; comp win / survived vote ⇒
> confidence ▲; calm ⇒ revert toward baseline — the 0028 family), appends to a persisted
> `emotionalHistory` arc, and `recordToSoul`s a name-free inflection that `recall` can surface live to
> ground an NPC's voice. The evolving state **modulates behavior**: the live competition emotional
> modifier (0006/0028) reads it, and a rattled HOH's nominations bend toward whoever they least trust
> (`chooseNominationsWithMood`) — emotion **never** overrides a hard rule (0005). The static `CHARACTER`
> stays **byte-stable** (0007); only the soul drifts; the arc **persists across a restart** (0030) and
> recall is re-derived from it. No emotional number reaches any player surface (the 0001 canary, extended).
> **This unblocks the deferred soul halves of 0038 and 0040.**
> Was: relationship edges evolved (0023/0026) and `SoulStore`/`emotionalState` existed (0024), but
> `recordToSoul`/`recall` were unwired from the live loop and a blindside changed nothing.
> **Executable spec:** [`0041-character-evolution-and-arc.feature`](./0041-character-evolution-and-arc.feature)

> **Known limit (AMEND 0041/0124 #5, 2026-11-04):** the arc notes `recordToSoul` appends to `soul.memory` have **no behavioural reader** today - only the numeric mood/volatility moves behaviour (competition modifier, nomination bend). The notes only ground an NPC's voice via `recall`. This stands until the unified memory/emotion design (#2017 family, `design/npc-emotion-visibility-brief.md`) lands; do not describe the notes as driving decisions.

## 1. Summary

A season should *change* a houseguest. Today the relationship layer moves, but the houseguest's own
**emotional trajectory** — rattled by a blindside, hardened by survival, emboldened by a win — neither
accumulates into their soul live nor bends their later play. 0041 closes the loop: consequential events
update the NPC's **soul emotional state** (live), that state **modulates competitions and decisions**, and
the accumulated trajectory is a **recall-able season arc** the narrator can voice — all in the hidden layer,
with the **static character baseline unchanged** (the `CHARACTER`/`SOUL` split, CLAUDE.md).

## 2. What exists today (the gap this closes)

- **Edges evolve** (`consequence.ts`/`0023` → `applyDirected`, decay/mean-reversion in `0026`) — but that's
  *relationships*, not the houseguest's own affect.
- **`SoulStore.recordToSoul`/`recall` + `emotionalState`** exist (0024) but are **not called from the live
  runtime** (grep: only the store, its port, and tests) — so the soul doesn't deepen during live play and
  `emotionalState` isn't driven by what happens.
- **The competition emotional modifier** (0006/0028) reads a soul emotional value, but nothing **evolves**
  that value from live events — so a "rattled" houseguest never actually exists in a live game.
- **No arc abstraction:** no persisted trajectory of "how this character has changed."

## 3. Scope

**In:** drive each NPC's **soul `emotionalState`** (e.g. distress / confidence / volatility) from **live
event history** (a blindside spikes distress/volatility; surviving a vote / winning builds confidence) via
**bounded, mean-reverting** deltas (sibling to 0028's emotional modifier); **wire `recordToSoul`/`recall`
into the live loop** so the soul deepens during play; have the evolving state **modulate live behavior** —
(a) the **competition** emotional modifier (0006/0028), and (b) **decision leanings** (a rattled HOH
nominates more erratically; a confident houseguest throws/plays-safe differently); a persisted, monotonic
**season arc** (`recall` surfaces "since the week-4 blindside, guarded"); and a bounded **disposition drift**
at the **soul** level that mean-reverts toward the character baseline.

**Out:** changing the **static `CHARACTER`** (archetype/core aptitudes/backstory stay **byte-stable**, 0007);
rebuilding `SoulStore` (reused, 0024); the relationship math (0026); narration quality (the engine evolves
the state; the LLM voices it).

## 4. Design

- **Emotional update (live).** On each consequential event for an NPC (eviction survived, blindside
  witnessed, betrayal suffered/committed, comp win/loss), apply **bounded** deltas to their soul
  `emotionalState` with **mean-reversion** when things calm (the 0028 emotional-constants family), and
  `recordToSoul` the moment (append-only, 0024/0007). This runs on the **live** path (the consequence fold,
  0023, and the off-screen society, 0038) — not just in tests.
- **Behavior modulation.** The evolving `emotionalState` feeds **competitions** (the 0006/0028 emotional
  modifier — a rattled houseguest is more volatile/under-performs; a confident one steadier) and **decision
  leanings** (mood scales the threat/trust weighting in nominations/votes/initiative). All bounded — emotion
  **never overrides hard rules** (eligibility, the Vault Wall).
- **The arc.** The persisted trajectory of `emotionalState` + the key events that moved it **is** the season
  arc; `recall(npc, context)` surfaces a *specific* past inflection so the narrator can voice a changed
  houseguest consistently.
- **CHARACTER vs SOUL.** Only the **SOUL** drifts; the **CHARACTER** (the byte-stable baseline, 0007) never
  changes. Disposition drift is a **soul-level current temperament** that mean-reverts toward the baseline —
  the character is who they are; the soul is who the game has made them this week.
- **Vault Wall.** All of it is hidden. The player sees a changed houseguest only through **behavior** — never
  an emotional number (sentinel-clean).

## 5. Contracts (stack-agnostic)

```
on a consequential event for npc:
   soul.emotionalState = boundedUpdate(state, eventKind)     // mean-reverts when calm (0028 family)
   soul.recordToSoul(npc, moment)                            // append-only (0024/0007); live
behavior:
   competitionEmotionalModifier(npc) reads the evolving soul state   (0006/0028)
   decisionLeaning(npc) scales threat/trust weighting by mood         (nominations/votes/initiative)
arc:
   recall(npc, context) → a specific past inflection ("since the week-4 blindside…")
invariants: CHARACTER byte-stable (0007); emotion bounded, never overrides hard rules; player sees no numbers
```

## 6. Definition of Done

- [ ] **Driven by live history:** a blindside (or a survived vote / a win) **measurably shifts** the NPC's
      soul emotional state on the **live** path (not just in `simulation.ts` tests).
- [ ] **Modulates behavior:** the shift changes live behavior — a rattled houseguest's competition and
      decision tendencies differ from the same houseguest calm (asserted with a seeded source).
- [ ] **Accumulates as an arc:** the soul deepens monotonically (0024/0007) and `recall` surfaces a specific
      past inflection that colors later play.
- [ ] **CHARACTER byte-stable:** the static character (archetype/aptitudes/backstory) is unchanged across the
      season; only the soul drifts (cross-check 0007).
- [ ] **Bounded + mean-reverting + deterministic:** emotion stays in bounds, reverts toward baseline when
      calm, never overrides hard rules; same seed ⇒ same arc.
- [ ] **Vault-free:** no emotional number on any player surface (extend the 0001 canary); persisted (0030);
      name-agnostic; added to `cucumber.cjs`; `npm test` green.

## 7. Dependencies & traceability

Wires **0024** (`SoulStore` recall) into the **live** loop, driven by **0023** (consequence) + **0038**
(off-screen life), modulating **0006/0028** (competition emotional modifier) and the decision leanings
(0011/0014), under **0001** (Vault Wall) and **0007** (the byte-stable `CHARACTER` vs the drifting `SOUL`),
persisted by **0030**. Makes "the house changed me / changed them" a real, hidden, recall-able mechanic.

## 8. Live wiring (the linchpin — unblocks deferred 0038 & 0040 pieces)

**Why this is the linchpin:** the live sandbox's engine core (`src/composition/engineRoot.ts`
`buildEngineCore`) exposes only `{ events, vault, knowledge, relationships }` — **there is no `SoulStore`**.
That single gap is why **0038's soul-deepening** and **0040's confessional→voice feedback** are both
deferred. 0041 puts the soul in the sandbox; once it's there, those two light up.

### 8.1 Put the `SoulStore` in the sandbox
- Add **`soul: SoulProvider`** to `EngineCore` + `buildEngineCore`, constructed as
  `new SoulStore(embed, makeIndex)`. Inject a **deterministic fake `embed`** (a seeded hash→vector, like
  0024's tests) so `recordToSoul`/`recall` work live and reproducibly — a *real* embedding model is the one
  still-open decision (CLAUDE.md), not a blocker here. Default `makeIndex` = `InMemoryVectorIndex`.
- **Boundary (critical):** `SoulProvider`/`SoulStore`/`VectorIndex` are **engine-only** (CLAUDE.md). Adding
  `soul` to `EngineCore` must NOT let any outward surface reach it — extend the dependency-cruiser forbidden
  set so `surfaces/**` and the MCP adapter never import the soul/vector types (exactly as for `VaultStore`).
  The player/admin projections never expose an emotional number.

### 8.2 Drive the soul live (the call sites)
- **Consequence fold (0023)** and the **off-screen tick (0038, `Orchestrator.defaultApply`)** call
  `soul.recordToSoul(npc, moment)` for each consequential event, and update the soul's **`emotionalState`**:
  `{ distress, confidence, volatility }` (0..1), moved by **bounded deltas** per event kind (blindside ⇒
  +distress/+volatility; survived vote / comp win ⇒ +confidence; calm stretch ⇒ **mean-revert** toward the
  `CHARACTER` baseline, reusing the 0028 emotional-constants family). Append-only (0007); persisted (0030).
- **Behavior reads:** the **competition emotional modifier (0006/0028)** reads the *live evolving*
  `emotionalState` (today it reads a static soul value); **decision leanings** (0011/0014, and 0044) scale by
  mood. All bounded — emotion never overrides hard rules (0005) or the Vault Wall.
- **Recall grounding:** `soul.recall(npc, context)` becomes usable live — this is the hook **0040** needs to
  ground an NPC's later *voice* in their own confessionals/history.

### 8.3 What this unblocks
- **0038 soul half:** the off-screen tick can now `recordToSoul` each scene → the house's souls deepen
  between turns (B27b's sibling).
- **0040 feedback half:** confessionals can fold into the soul + be `recall`-ed to keep an NPC's voice
  consistent.

### 8.4 Definition of Done (additions)
- [ ] `EngineCore`/`buildEngineCore` expose a `SoulStore` (deterministic embed); `npm run test:arch` stays
      green with the soul/vector types added to the engine-only forbidden set (no outward import).
- [ ] `recordToSoul`/`recall` are exercised on the **live** path (consequence + off-screen tick), not only
      in 0024's tests; the soul deepens monotonically and `recall` returns the relevant memory.
- [ ] `emotionalState` evolves live (bounded, mean-reverting) and modulates a competition + a decision; the
      player surface shows **no** emotional number (extend the 0001 canary); persisted across restart (0030).
