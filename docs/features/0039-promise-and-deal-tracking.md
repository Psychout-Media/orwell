# 0039 — Promise & deal tracking (first-class deals)

> **Status:** ✅ GREEN (in `cucumber.cjs`). **Deals are core _Big Brother_ texture** — "I won't put you
> up," final-2s, votes-for-votes — and they are now a **first-class tracked object**: a `Deal` domain model
> (parties, terms, the condition that would break it, kept/broken status) that the **engine** evaluates
> against binding actions — so a broken promise **deterministically** moves trust/threat and the jury,
> recorded and consequential, **never narrated away** (anti-sycophancy). Implemented in `src/domain/deal.ts`
> (model + condition predicates), `src/engine/deals.ts` (the `DealLedger`: make / reconcile / consequences),
> wired into the live loop via `GameSessionAdapter` (player↔NPC deals, `makeDeal` tool/lever) with the
> betrayal-shock fold (0026), a jury demerit (`manner.betrayed`, 0014), a witnessed reveal (0002), and
> persistence (0030); NPC↔NPC deals are Vault-held (canary-covered).
> **Executable spec:** [`0039-promise-and-deal-tracking.feature`](./0039-promise-and-deal-tracking.feature)

## 1. Summary

A deal is a commitment between two houseguests with a condition that, if violated by a later binding
action (a nomination, a vote, a veto), **breaks** it. Today the consequence loop (0023) only reacts to an
interaction explicitly tagged a betrayal; there is no object that remembers *what was promised, to whom,
and whether it was kept*. 0039 makes the deal a tracked first-class thing the engine reconciles against
the live loop (0034) — closing a behavioral-fidelity gap and adding a clean anti-sycophancy lever (the
engine, not the storyteller, decides a promise was broken and makes it hurt).

## 2. What exists today (the gap this closes)

- **No `Deal`/`Promise` type** anywhere in `src/` (grep: only JS `Promise<T>` + prose "deal" in tool
  descriptions). Deals are *implicit* in 0023 consequences only.
- **Betrayal-shock exists but is untethered:** `relationshipConstants`/`0026` model a large, slow-decaying
  trust drop for `kind:"betrayal"`, but nothing connects it to a *specific tracked promise* being violated.
- **The jury cares (0014)** about how you treated people, but a broken deal isn't a discrete jury-management
  signal today.

## 3. Scope

**In:** a Vault-free-projectable **`Deal`** domain model; **making** a deal (player↔NPC via a command;
NPC↔NPC off-screen → Vault-held); **reconciliation** — when a binding action (nomination/replacement/veto/
vote, 0034/0005) implicates an open deal, the engine marks it **kept** or **broken**; on **break**, a
**betrayal-shock** consequence fold (relationships 0026 + a jury-management note 0014) **plus** a recorded
**witnessed reveal event** when the wronged party witnesses/learns it; player-facing visibility limited to
deals the player is **party to** (their knowledge) — NPC↔NPC deals reach them only as a **rumor by pathway**
(0038/0002). Persisted (0030), seed-deterministic.

**Out:** a general contract DSL (model only the concrete BB deal kinds — safety / vote / final-two /
nominate-someone-else); the relationship math itself (reused from 0026); the narration of the deal (the
engine tracks/decides; the LLM only voices).

## 4. Design

- **Model.** `Deal { id, parties: [a, b], kind: "safety" | "vote" | "final-two" | "target-other", terms,
  condition, status: "open" | "kept" | "broken", madeEventId, resolvedEventId? }`. `terms` is a Vault-free
  human description; `condition` encodes the binding action that violates it (e.g. safety ⇒ "a nominates b").
- **Making.** A player↔NPC deal is made through a Vault-free command (recorded as a player-witnessed event —
  player knowledge, 0002). NPC↔NPC deals are made **off-screen** by the society (0038) and held **Vault-only**
  (hidden), diffusing like any hidden fact.
- **Reconciliation (the crux).** On every binding action through the 0034 seam, the engine checks **open
  deals** the action implicates: honoring leaves `kept`; violating sets `broken`. This is **engine-decided**
  from the action + the deal's condition — never inferred from prose.
- **Consequence on break.** A broken deal applies the **betrayal-shock** fold (0026: large trust drop +
  threat rise, slow decay — the grudge lingers) to the wronged party's read of the breaker, **and** records
  a **jury-management** demerit (0014) weighting that juror's later lean. If the wronged party witnesses or
  learns the break, a **witnessed reveal event** (0002) enters their knowledge.
- **Vault Wall.** Player surfaces show only the **fact** of deals the player is party to and **observable**
  fallout — **never** the trust/threat numbers. NPC↔NPC deals and the magnitude of the shock stay hidden
  (sentinel-clean); the player may *hear* a betrayal happened (rumor, 0038) but reads the consequence as
  behavior.

## 5. Contracts (stack-agnostic)

```
Deal: { id, parties:[a,b], kind, terms, condition, status:"open"|"kept"|"broken", madeEventId, resolvedEventId? }
makeDeal(a, b, kind, terms): Deal                 // player↔NPC recorded (knowledge); NPC↔NPC off-screen (Vault)
reconcile(action): for each open deal the action implicates → kept | broken   // engine-decided, not prose
on broken: rel.applyDirected(wronged, breaker, "betrayal")  (0026)  +  jury demerit (0014)
           + (if witnessed/learned) a recorded reveal event (0002)
visibility: player sees deals they are PARTY to + observable fallout; NPC↔NPC only via pathway; never numbers
```

## 6. Definition of Done

- [x] **First-class + persisted:** a made deal is a tracked `Deal` object (status `open`), persisted in the
      session snapshot and surviving a restart (0030); making it records a player-witnessed event.
- [x] **Engine-decided kept/broken:** `DealLedger.reconcile` marks an implicated open deal **kept** or
      **broken** from the structured action + condition (`actionBreaks`/`actionHonors`) — never from prose.
- [x] **A broken promise hurts (anti-sycophancy):** it applies the **betrayal-shock** fold (trust↓/threat↑,
      sticky, 0026), records a **jury demerit** (`manner.betrayed`, 0014), and surfaces a **witnessed reveal**
      to the wronged party (0002).
- [x] **Vault Wall:** NPC↔NPC deals are Vault-held (never an outward fact) and reach the player only as a
      **rumor by pathway**; no player surface shows a trust/threat number (0001 canary extended with an
      NPC-deal sentinel).
- [x] Seed-deterministic; name-agnostic (roles only — promisor/promisee/wronged); added to `cucumber.cjs`;
      `npm test` + `npm run test:arch` green.

## 7. Dependencies & traceability

Builds on **0023** (consequence loop) + **0026** (betrayal-shock math) + **0014** (jury management), through
the **0034** decision seam, with NPC↔NPC deals living in the **0038** off-screen society and diffusing via
**0002**; persisted by **0030**, under **0001** (Vault Wall) and **0021** (isolation). Turns the implicit
"a betrayal moves edges" into an explicit, tracked, engine-adjudicated promise — the deterministic core
deciding that a broken word costs you, not the narrator.

## 8. Implementer-ready (Definition of Ready)

**Touch points (exact):**
- **New** `src/engine/deals.ts` — the `Deal` type (`{ id, parties:[a,b], kind:"safety"|"vote"|"final-two"|
  "target-other", terms, condition, status:"open"|"kept"|"broken", madeEventId, resolvedEventId? }`),
  `makeDeal(...)`, and `reconcile(deals, action): Deal[]` (engine-decided kept/broken from the action +
  condition — never prose).
- **Persistence (0030):** add `deals: Deal[]` to `SessionCore` (`src/engine/sessionSnapshot.ts` L25) so deals
  round-trip and survive a restart (cloneSession/toGameState already handle plain JSON).
- **Make a deal:** add `makeDeal` to the `EngineCommands` port + `EngineCommandsAdapter` (sibling to
  `recordInteraction`/`diaryRoom`) for player↔NPC deals (recorded knowledge); NPC↔NPC deals are made
  off-screen (0038) and held **Vault-held** (hidden).
- **Reconcile on binding actions:** hook `reconcile` where the live loop applies a binding choice —
  `src/engine/liveSeason.ts` `applyDecision` (nominations/replacement/eviction-vote). On **broken**:
  `rel.applyDirected(wronged, breaker, "betrayal", rng)` (betrayal-shock, `relationshipConstants` 0026) +
  a jury-management demerit via `jury.ts` `EvictionManner`/`mannerToward` (L24) + a recorded **witnessed
  reveal** event when the wronged party witnesses/learns it.

**Build order / deps:** 0026 (betrayal-shock — built), 0014/`jury.ts` (manner — built), 0030 (persistence —
built) are all ready. The **player↔NPC deal object + reconciliation ships now**; **NPC↔NPC rumor diffusion**
of a broken deal rides on **B27b** (gossip) — guard that path so it no-ops until B27b lands.

**Test targets:** `tests/unit/deals.test.ts` + `docs/features/0039-*.feature` → add to `cucumber.cjs`.
Assert §6: a first-class **persisted** deal (survives restart, 0030), **engine-decided** kept/broken (never
prose), broken ⇒ **betrayal fold + jury demerit + reveal** (measurable later behavior change), NPC↔NPC deals
**Vault-held** (player learns only via pathway), **no number** on any player surface (extend the 0001 canary),
seed-deterministic.

**No open decisions.** Model only the concrete BB deal kinds (safety / vote / final-two / target-other); the
engine adjudicates from the action + condition (anti-sycophancy); magnitudes reuse 0026's constants.

**Consent (ORW-82, 2026-11-06).** Since #2110 (`ORWELL_NPC_DEAL_CONSENT`, ON) the *engine* decides whether an NPC agrees to a deal the player proposes, from the NPC's own read of the player (trust, warmth, threat, remembered grudges, the belief that the player targets them) and the cost of the ask; the narrator never decides. A refusal records **no** deal, folds nothing, and returns a Vault-free in-fiction line with **no numbers** (`reason`: distrust / threat / grudge / targeted / cost). By design roughly 10-20% of the opening cast refuse even cheap asks (consent's own calibration): that is not a bug. Guards: the live scenario "An NPC who distrusts the player refuses a deal and no deal is recorded" (`features/step_definitions/deal_consent_live.steps.ts`), the break-then-propose chain `tests/unit/dealConsentChain.test.ts` (the real `reconcileDeals` break, no hand-planted grudge), and the unit set `tests/unit/dealConsentLive.test.ts`. Consent reads the `targets-me` belief, not `lied-to-me` (that is B48's credibility).
