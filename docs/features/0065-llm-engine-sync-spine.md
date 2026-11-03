# 0065 — The LLM↔engine sync spine (versioned, at-most-once, self-correcting)

> **Two features carry the number 0065.** This is the sync spine (no `.feature`; engine Vitest + FE pytest). The other is [0065 — Cast pre-warm](./0065-cast-prewarm.md), which has a `.feature` (`0065-cast-prewarm.feature`).

**Status:** ✅ Built (authored 2026-06-20; Parts A–E are all in the code: `beatSeq` CAS, idempotency keys, the pre-emission outcome guard, the sync ledger `frontend/src/orwell_sync_ledger.py`, and the `beatSeq`-keyed delta feed; gates `tests/unit/syncSpine.test.ts` + `tests/unit/stateDelta.test.ts`). **Gate:** engine (Vitest + dependency-cruiser + BDD where
it touches a `.feature`) and front-end (pytest). **Depends on:** 0009 (MCP tool boundary), 0023
(consequence loop), 0031 (per-sandbox orchestrator & integrity checkpoint), 0064 (canonical session
+ Messenger-style turn serialization). **Bounded by:** ADR **0005** (split authority by openness),
mandate #2 (Vault Wall), mandate #3 (anti-sycophancy), ADR 0003 (the conversation is the game).

> **Companion direction:** this is the *closed-set* counterpart to ADR 0005. 0005 protects the
> **open set** (creative play must never be flattened); 0065 makes the **closed set** (facts,
> outcomes, bookkeeping) *rigorously* synced between the narration LLM and the engine. Per ADR 0005
> principle #5, closed-set strictness is not a threat to dynamism — it is what lets the model be
> freely dynamic without the harness interrupting good scenes to fix bookkeeping. **Every surface
> here is closed-set only and Vault-free by construction.**

---

## 1. Why (the two failure classes this closes)

The narration LLM and the deterministic engine drift apart in two structural ways:

- **(A) The model owns control flow.** It decides *whether* to advance, *whether* a scene happened,
  *what is true* — so the harness spends enormous effort *nudging* (`agent_loop.py`'s stall-nudge
  ladder, the `_auto_record_scene`/deal/move back-fills) and *guessing divergence from prose*
  (`chat_helpers.py`'s `_narration_claims_outcome`).
- **(B) Reconciliation is heuristic and late.** There is today **no version, no sequence number, no
  idempotency key, and no structured beat handshake** shared between model and engine. Divergence
  can only be *guessed* from prose *after the fact*, and the re-ground fires the *next* turn — the
  player has already read the wrong narration.

0064 fixed the **device↔device** axis (one canonical session, serialized turns). It explicitly
leaves a known gap on the **LLM↔engine** axis (0064 §3.C): *"a queued turn uses its submit-time
context… the engine state is authoritative and reconciles via game-updated/the desync spine."* This
spec closes that gap with structural primitives, and turns the late heuristic spine into an
early, deterministic one.

**Non-goals.** No change to engine authority, the Vault Wall, per-user isolation (0021), or open-set
handling (ADR 0005). No new device-sync transport (0064 owns that). This spec adds *bookkeeping
rigor*, never *narration constraint*.

---

## 2. Parts (priority order = build order)

| Part | Name | Side | Closes |
|---|---|---|---|
| **A** | `beatSeq` token + compare-and-swap stale-write rejection | engine + thin FE client | staleness; 0064 §3.C known-minor |
| **B** | Idempotency keys on progression tools | engine + thin FE client | double-advance on retry/queue |
| **C** | Pre-emission outcome guard | FE (desync spine + stream) | commission, *one turn earlier* |
| **D** | Sync/divergence ledger | FE (observability) | "I debug the harness a lot" |
| **E** | Delta state feed (+ R3 latency) | engine projection + FE context | staleness signal; O(events) latency |

Parts A and B are the **foundation** (a versioned, at-most-once write path) and ship first, together.
C, D, E build on the `beatSeq` token A introduces.

---

## 3. Part A — `beatSeq` token + compare-and-swap stale-write rejection

### Problem
A turn can be computed against a board that has since moved (the 0064 queued-turn case; a model
narrating from a stale in-context snapshot). Nothing lets the engine *reject* a write aimed at a
superseded board, so divergence is only caught later by prose-diffing.

### Design
Introduce an engine-issued **monotonic `beatSeq`** — a single integer that increments on every
committed state mutation for a sandbox. It is **not secret** (a counter carries no Vault content),
so it crosses the boundary freely.

- **Source of truth:** the per-sandbox orchestrator commit spine (`src/composition/orchestrator.ts`)
  already commits once per beat. Derive `beatSeq` there (a counter bumped on each successful
  `commitPlayerTurn` / committed advance), or from the authoritative event count
  (`events.count()`) if that is already monotonic+restart-safe. Persist it in the snapshot so it
  survives a restart (co-versioned with the save, per 0007).
- **Surfacing (read path):** every read/advance result carries the current `beatSeq`:
  `gameStatus` (`PublicGameStatus`), `getGameState` (`GameStateView`), `advanceGame` /
  `submitDecision` (`AdvanceView`). Add a `beatSeq: number` field (see `src/ports/GameSession.ts`).
- **Guarding (write path):** mutating tools accept an **optional** `expectedBeatSeq`. When present
  and `!== current`, the engine **refuses** with a typed conflict — reuse the `EngineRefusal`
  pattern (`McpServer.ts`) mapped to **HTTP 409** with a stable `code: "stale-beat"` and the current
  board in the body, so the caller can re-ground immediately. When absent, behavior is **byte-
  identical to today** (fully backward-compatible; the field is opt-in).
  - Apply to: `submitDecision`, `advanceGame`, `recordInteraction`, `makeDeal`, `moveTo`,
    `surfaceInformationTo`. (Read tools never carry it.)
- **FE client (thin):** `frontend/src/orwell_engine.py` gains an optional `expected_beat_seq` param
  on the mutating client functions, threaded into the request. **The model never sees the token** —
  the FE holds the last-seen `beatSeq` per canonical session and attaches it. *(The per-turn
  capture/attach wiring in `chat_helpers.py`/`agent_loop.py` is a small integration step sequenced
  after the engine slice — see §8.)*

### Contracts
- `PublicGameStatus`, `GameStateView`, `AdvanceView` gain `beatSeq: number`.
- Mutating `*Req` types gain `expectedBeatSeq?: number`.
- New typed refusal: `code: "stale-beat"`, HTTP 409, body `{ error, code, beatSeq, board }` where
  `board` is the Vault-free current ceremony status.

### Tests (Vitest)
- `beatSeq` increments by exactly one per committed beat; stable across no-op turns; survives a
  snapshot round-trip (restart-safe; ties to 0007/0030).
- A mutating call with a **stale** `expectedBeatSeq` → typed refusal / 409 `stale-beat`, **no state
  change** (the integrity checkpoint never runs a stale write).
- A mutating call with the **current** `expectedBeatSeq` → succeeds; one with **no** `expectedBeatSeq`
  → byte-identical to the pre-0065 path (regression guard).
- Two-writer race (the 0064 queued-turn shape): the second write, computed against the prior
  `beatSeq`, is refused rather than applied to the moved board.

---

## 4. Part B — Idempotency keys on progression tools

### Problem
0064 *queues* turns and the FE may retry on a flaky socket; the base prompt only *asks* the model
not to "blindly retry." A retried `advanceGame`/`submitDecision` can **double-advance**.

### Design
`advanceGame` and `submitDecision` accept an **optional** `idempotencyKey: string`. The orchestrator
keeps a small per-sandbox LRU map `idempotencyKey → AdvanceView`. A repeated key returns the
**original** result without advancing again (at-most-once). Keys are scoped per sandbox and bounded
(e.g. last 32), persisted opportunistically (best-effort; a restart that drops the cache degrades to
today's behavior, which Part A's `beatSeq` still protects against double-apply).

- With 0064's single-writer serialization there is at most one in-flight run per game, so a tiny
  cache is sufficient and race-free.
- Absent key ⇒ unchanged behavior (opt-in).
- **FE client:** `orwell_engine.advance_game` / `submit_decision` gain an optional
  `idempotency_key`; the FE generates one per *intended* progression action and reuses it on retry.

### Contracts
- `advanceGame` / `submitDecision` requests gain `idempotencyKey?: string`.
- A replayed key returns the cached `AdvanceView` (including its `beatSeq`) verbatim.

### Tests (Vitest)
- Same key twice ⇒ one advance, identical `AdvanceView` both times; `beatSeq` unchanged on the
  replay.
- Different keys ⇒ two advances.
- Absent key ⇒ unchanged behavior.
- Interaction with A: a replayed key returns the original even if `beatSeq` has since moved (the
  cache wins, no double-apply).

---

## 5. Part C — Pre-emission outcome guard (same-turn, not next-turn)

### Problem
The desync spine (`chat_helpers.py`) catches a narrated-but-uncommitted outcome only *after* the
turn, re-grounding the *next* turn — the player already read "X is evicted." 

### Design
Move the closed-set outcome check **before emission**, reusing the FE's existing sentence-buffered
stream scrubber (`agent_loop.py`'s `_scrub_game_leak` path). When a streamed sentence asserts a
**closed-set board outcome** (the existing, now phase-gated `_CLAIM_*` detectors:
eviction / winner / tally / new-HOH), **hold** that sentence until it is verified against the live
board (a `beatSeq`-cheap status read; Part A makes "did the board move?" a single integer compare).
If the board backs the claim → emit. If not → **drop or correct** it before the player sees it, and
fall through to the existing next-turn re-ground as a backstop.

- **ADR 0005 guardrail (hard):** this guard's jurisdiction is **closed-set board claims only** — it
  must never hold, drop, or rewrite creative/social prose. Conservatism is mandatory (a false hold
  on creative prose is worse than a missed catch). The expressive-non-collapse FE gate
  (`test_expressive_non_collapse.py`) is the standing protection; extend it to cover the
  pre-emission path.
- Streaming UX: hold only the *suspect sentence*, never the whole stream; everything else streams
  live (preserve the existing buffering granularity).

### Tests (pytest)
- A streamed phantom eviction (board unchanged) is **held and dropped/corrected** before emission;
  the player-visible text never contains the un-happened outcome.
- A streamed *real* outcome (board moved, verified via `beatSeq`) emits unchanged.
- **Non-collapse:** every entry in the dynamism corpus streams through **untouched** (the guard
  never fires on creative prose) — wire this into `test_expressive_non_collapse.py`.

---

## 6. Part D — Sync/divergence ledger (observability)

### Problem
"I have to debug the harness a lot." Sync signals are scattered across ad-hoc `logger.info` lines
and implicit state; there is no single per-turn record of what the harness did to keep things synced.

### Design
A structured, per-turn ledger entry capturing the closed-set sync activity of the turn:
`{ turnId, session, beatSeqBefore, beatSeqAfter, toolsCalled, nudgesFired, autoBackfills,
desyncDetected, staleRejections, idempotencyHits }`. New module
`frontend/src/orwell_sync_ledger.py` (small, append-only, bounded retention, **Vault-free** — ids /
counts / event names only, never message bodies or secret state). One structured log line per turn;
optionally surfaced to the admin LLM-I/O trace UI.

- **Dedup check (required before building the hooks):** PR #406 shipped a "full LLM I/O trace + log
  retention." **Extend that** rather than duplicate it — the ledger may be a typed projection over
  the existing trace, or a sibling that reuses its retention. The agent must read #406's
  implementation first and choose the non-duplicative path.
- **First slice (parallelizable):** the standalone module + its unit tests, with a clean
  `record_turn(...)` API. The integration hooks (the one-line calls from `agent_loop.py` /
  `chat_helpers.py`) are a small, sequenced wiring step (they touch the hot FE files — §8).

### Tests (pytest)
- A ledger entry serializes the expected fields; bounded retention drops oldest; **Vault-sentinel
  assertion** (no secret/Vault content, no message body ever recorded); cross-user isolation
  (entries are `_current_user`-scoped).

---

## 7. Part E — Delta state feed (+ the R3 latency cure)

### Problem
The model is handed a wholesale projection each turn (and the snapshot export is **O(events)** — the
deferred R3 latency item: late-season turns grow ~20× and can approach the FE timeout). It also gets
no crisp "what changed since your last turn," so staleness isn't self-evident.

### Design
A `beatSeq`-keyed **delta**: given the caller's last-seen `beatSeq`, the engine returns *what changed
since* (events appended, ceremony field diffs, status transitions) instead of (or alongside) the full
projection. The FE weaves a tight **"since your last turn: …"** line into the moment context
(`momentPrompts.ts`'s `renderGameContext` is where today's full block is built). Two wins:
(1) latency stops growing with season length (the R3 cure — incremental export instead of full
re-scan), (2) the model gets a crisp diff that makes drift self-evident.

- Build on the orchestrator's existing append-only / `trustEventPrefix` machinery (the checkpoint
  already trusts the immutable event prefix; the delta export is its read-side dual).
- Largest, most-deferred part; **may be split** (delta projection first; the R3 incremental-snapshot
  rework second). Sequenced last.

### Tests (Vitest)
- Delta from `beatSeq N` returns exactly the events/ceremony changes after N; empty when nothing
  moved ("since last turn: nothing committed").
- A late-season delta export is **O(Δ)**, not O(events) — a perf assertion / complexity guard.
- Round-trips through a restart (delta after a resumed `beatSeq` is correct).

---

## 8. Contracts summary, build order & parallelization

### New/changed contracts
| Surface | Change |
|---|---|
| `src/ports/GameSession.ts` | `PublicGameStatus` / `GameStateView` / `AdvanceView` gain `beatSeq: number`; advance/submit reqs gain `idempotencyKey?` |
| `src/ports/EngineCommands.ts` | mutating reqs gain `expectedBeatSeq?: number` |
| `src/composition/orchestrator.ts` | owns the `beatSeq` counter + idempotency LRU; persisted in snapshot |
| `src/adapters/mcp/McpServer.ts` | shape-guard the new optional fields; map `stale-beat` to 409 |
| `frontend/src/orwell_engine.py` | optional `expected_beat_seq` / `idempotency_key` on mutating client fns |
| `frontend/src/orwell_sync_ledger.py` | **new** Vault-free ledger module |
| `frontend/routes/chat_helpers.py` | (integration) capture/attach `beatSeq`; pre-emission guard hook; ledger hook |
| `frontend/src/agent_loop.py` | (integration) pre-emission hold in the stream scrubber; ledger hook |

### Build order (top to bottom)
1. **Wave 1 (parallel, disjoint files):**
   - **A + B** (engine versioned at-most-once write path + optional FE-client params). Files: `src/**`,
     `tests/**`, `frontend/src/orwell_engine.py`, `frontend/src/tool_implementations.py`. Does **not**
     touch `agent_loop.py` / `chat_helpers.py`.
   - **D module** (the standalone ledger + unit tests only). File: new
     `frontend/src/orwell_sync_ledger.py` + its test. Does **not** touch the hot FE files.
2. **Wave 2 (sequenced — these share the hot FE files `agent_loop.py` / `chat_helpers.py`, so one at
   a time):** the A/B **integration** (per-turn `beatSeq` capture+attach, idempotency-key minting) →
   **C** (pre-emission guard) → **D hooks** (wire the ledger) .
3. **Wave 3:** **E** (delta feed + R3 incremental export), engine-led, sequenced last; may split.

Each part is BDD/TDD-first (write the test red, implement to green), verified with the full gate
(`npm run test:ci` for engine; `pytest` for FE) before the next part, and committed as its own slice.

### Acceptance criteria
1. A mutating call against a superseded board is refused (409 `stale-beat`), not applied (A).
2. A replayed progression key advances **once** (B).
3. A narrated outcome the engine never committed is corrected **before** the player sees it (C).
4. Every turn produces a Vault-free ledger entry with the sync activity (D).
5. The model receives a "what changed since your last turn" delta; late-season export is O(Δ) (E).
6. **No behavior change when the new optional fields are absent** (every part is opt-in/back-compatible).
7. The expressive-non-collapse gate stays green throughout — no part flattens the open set (ADR 0005).
8. Every new surface is Vault-free and cross-user-isolated; dependency-cruiser stays clean.
