# 0034 — Live weekly progression & binding-decision seam

> **Status:** Built (see the [README status index](./README.md#index)) — **codifies an already-built capability.** Unusually for this repo, the engine
> code landed **before** the spec: the live weekly loop + binding-decision seam were implemented in the
> "live weekly loop, full tool wiring" change (`src/engine/liveSeason.ts`,
> `GameSessionAdapter.advanceGame`/`submitDecision`, the `GameSession` port, `advanceGame`/`submitDecision`
> player tools, the MCP client + agent tools + status panel, with unit + integration tests). What's
> **missing** is the project's source-of-truth artifact: a **name-agnostic executable `.feature`** that
> codifies the behavior and **asserts the cross-cutting guarantees** (Vault-free, persistence, 0005
> legality, binding-only-through-validation) so the live loop can't silently regress. 0034 is that spec.
> **Executable spec:** [`0034-live-weekly-progression-and-decision-seam.feature`](./0034-live-weekly-progression-and-decision-seam.feature)

## 1. Summary

Features **0011** (weekly loop) and **0019** (decision seam) were pure-core and **test-only** — they
ran in `season.ts` and unit tests but **not in the live game**. The live game now wires them: a new
`liveSeason.ts` drives the weekly loop over the live house, and `GameSessionAdapter` exposes it as
**`advanceGame()`** (auto-resolves NPC beats, **stops and returns a pending decision** when it's the
player's turn) and **`submitDecision(req)`** (validates the choice, applies it, records the event, and
**persists** — 0030). This is the **live realization** of 0011/0019, the same pattern as **0023** (the
live consequence loop) and **0030** (live persistence).

> **Who may bind a choice (BDD AMEND, Ryne-approved 2026-11-03).** Irreversible decisions (nominations,
> replacement, veto use and pick, eviction votes, juror votes, goodbye, self-evict) bind only through the
> player's decision card. The model may submit on the player's behalf only comp-intent, comp-round and
> deal-offer (#1951); that rule is proven in `frontend/tests/test_a6_model_submit_gate.py`. The engine seam
> itself still refuses an illegal choice of any kind (the two refusal scenarios below).

> **Amendment (Wave 2 — endgame & agency).** The binding-decision seam grew new `pending` kinds, all
> validated through the SAME `submitDecision` contract (no choice ever parsed from prose): **`comp-intent`**
> — declare compete / throw / play-safe before a comp the player plays (B46/audit B5; default compete);
> **`tie-break`** — the player HOH breaks a tied eviction vote (B44/audit B2); **`final-eviction`** — the
> Final-3 HOH personally evicts (0045/audit B1); **`houseguests-choice`** — the player picks the sixth veto
> player when they draw the chip (B45/audit B4). Each is immutable once its beat resolves (the pending is
> cleared) and survives a restart.

It shipped **without a `.feature`**. 0034 closes that gap: it pins the live loop's invariants as an
executable, name-agnostic spec — so the guarantees that matter (no Vault leak, no lost detail, no
illegal ceremony, no binding choice parsed from prose) are **continuously enforced**, not incidental to
the implementer's hand-written tests.

## 2. What exists today (and what 0034 adds)

| Piece | Where | State |
|---|---|---|
| Live weekly loop over the live house | `src/engine/liveSeason.ts` (`newLiveSeason`/`advance`/`applyDecision`) | ✅ built (098c36a) |
| Live advance + decision tools | `GameSessionAdapter.advanceGame()/submitDecision()`, `GameSession` port | ✅ built |
| Outward exposure | `advanceGame`/`submitDecision` in `registry.ts`; MCP client (`orwell_engine.py`); `agent_tools.py`; `orwellStatusPanel.js` | ✅ built |
| 0005 legality on choices | `liveSeason.applyDecision` (`throw` on illegal nominee/replacement/vote) | ✅ built |
| Persistence on each beat | `GameSessionAdapter` `onPersist` (0030) | ✅ built |
| Unit + integration tests | `tests/unit/liveSeason.test.ts`, `tests/integration/liveProgression.test.ts` | ✅ built |
| **Name-agnostic BDD `.feature`** | — | ⛔ **missing → 0034** |
| **Asserted Vault-free sentinel on `advanceGame`/`submitDecision`/`gameStatus` output** | partial in integration test | ⚠️ **harden in 0034** |
| **Lever manifest names the progression levers** | `momentPrompts.ts` still names only 4 | ⛔ **see B21 / 0018** |

## 3. Scope

**In:** a name-agnostic `.feature` (added to `cucumber.cjs`) over the **built** `advanceGame`/
`submitDecision` seam, asserting: NPC beats auto-resolve; the loop **stops** for the player's binding
decision; binding choices are taken **only** through the validated `submitDecision` (never parsed from
prose); **illegal** choices are **rejected** (0005); every resolved beat **persists** and **survives a
restart** (0030); the live path is **Vault-free** (sentinel-clean output on `advanceGame`/
`submitDecision`/`gameStatus`, 0001); the run is **seed-deterministic**. Where an assertion isn't yet
covered by the implementer's tests (esp. the explicit Vault sentinel on the live tools), **add it**.

**Out:** rebuilding the loop (it exists — 0034 specs/guards it); the off-screen idle tick (0031); the
consequence fold into souls (0023); naming the levers in the prompt (**B21/0018** — referenced, ties in).

## 4. Contracts (as built; 0034 pins them)

```
advanceGame(): AdvanceView                 // readsVault:false, sentinel-clean
    → auto-resolves NPC beats; returns the beat event and, when it's the player's turn,
      a `pending` decision { kind, options[] }; never advances past a player decision
submitDecision({ kind, choice }): AdvanceView   // readsVault:false, sentinel-clean
    → no-op if no pending decision of that kind; validates `choice` against 0005 legality
      (rejects illegal nominee / replacement / vote); applies; records the witnessed event;
      persists the snapshot (0030); returns the next beat/pending
```

## 5. Definition of Done

- [ ] **Auto-advance + stop:** `advanceGame` resolves NPC beats and **halts** at the player's binding
      decision, returning the engine's **legal** option set (0011/0005).
- [ ] **Binding-only-through-validation:** a nomination/veto/replacement/eviction-vote changes state
      **only** via `submitDecision` — never inferred from chat prose; an **illegal** choice is rejected
      (0005), leaving state unchanged.
- [ ] **Persist + recall:** each resolved beat persists; a new registry over the same store resumes the
      exact live position (0030) — no lost detail (0007).
- [ ] **Vault-free:** `advanceGame`/`submitDecision`/`gameStatus` outputs are **sentinel-clean** under a
      fully-populated Vault (extend the 0001 canary to the live tools); `npm run test:arch` green.
- [ ] **Deterministic:** same seed + same decisions ⇒ identical progression.
- [ ] Name-agnostic `.feature` (roles only — HOH/nominee/veto-holder/evictee) added to `cucumber.cjs`;
      `npm test` green. (Most steps map to the **existing** `liveSeason`/adapter code — this is
      codification + targeted hardening, not a rebuild.)

## 6. Dependencies & traceability

The **live realization** of **0011** (weekly loop) + **0019** (decision seam), reusing `domain/
eligibility` (**0005**) for legality and the **0030** durable snapshot for persistence, under the
**0001** Vault Wall and **0021** isolation — the same "wire the built pieces into the live game" pattern
as **0023**. Pairs with **B21/0018** (the lever manifest must name `advanceGame`/`submitDecision`). The
front-end consumes it via the MCP client + `orwellStatusPanel.js` (the 0020 status surface) and the
agent's `advanceGame`/`submitDecision` tools.
