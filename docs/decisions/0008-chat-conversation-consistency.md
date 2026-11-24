# 0008 — Cross-tab/-device chat conversation consistency (an authoritative ordered message log)

> **Status:** **Accepted — BUILT** (2026-06-21; root-caused in the pre-launch playtest audit — see
> `AUDIT-LOG.md` §S3-RACE / §2.4; PO direction 2026-06-21: *"if we need to refactor deeply to make this
> part ROCK SOLID I wouldn't be opposed… it's a huge issue that there's no tolerance for"*, then *"finish
> the audit first, then implement"*). Implemented FE-only across two phases: **Phase A** — the authoritative
> per-session `seq` (schema + backfill migration + seq-ordered reads + the `message-added` completion
> broadcast); **Phase B** — render-/reconcile-by-id (optimistic temp id → canonical `{id, seq}` adoption,
> divergence-gated rebuild, deferred-past-a-live-stream), the optimistic temp-id round-trip, and dropping
> the blanket `hasActiveStream` suppression in `sessionSync`. **Phase C** — the permanent gates
> (`frontend/tests/test_adr0008_chat_seq.py` + `…_reconcile_contract.py`). Verified: migration applied to
> the live DB (dense backfill, UNIQUE index), full FE suite green (1688), `/api/history` serves `{id, seq}`
> seq-ordered, clean browser runtime.
> **Source:** **S3-RACE** — the two-window concurrent-write parity investigation (audit 2026-06-21):
> looped reproduction (**10/10 iterations diverge**, accumulating), the engine perfectly consistent
> throughout, and a reload that reconciles (render-layer, persisted log intact).
> **Builds on:** ADR 0003 (the conversation IS the game), feature 0064 (cross-device session sync),
> feature 0065 (the engine closed-set `beatSeq` spine — the engine half, already solid), and the FE
> session/SSE layer (`session_events`, `sessionSync.js`, `chat.js`, `core/database.py`).
> **Inherits / bounded by:** the **Vault Wall** (mandate #2) and **cross-user isolation** (0021) —
> unchanged: the sync channel carries ids / `seq` / event-types, **never** message bodies or secret
> state. The `session_events.py` "tiny payloads, each device fetches authoritative state itself"
> property is preserved and, in fact, finally made true.

## Context

The TS engine's **closed set** is consistent by construction (ADR 0005 + feature 0065: a monotonic,
per-user-serialized, 409-guarded `beatSeq`). But the **verbatim chat conversation is FRONT-END-owned** —
persisted in the FastAPI app's session DB, not the engine — and replicated across a user's open
tabs/devices over the `session_events` SSE channel (feature 0064).

The pre-launch audit (S3-RACE) found that **two tabs on the same game/session diverge in their rendered
conversation under concurrent — or merely active — writes, and the divergence accumulates without bound
during live play:**

- Looped concurrent-write reproduction: **10/10 iterations diverged**; the message-count gap grew
  (e.g. A = 45 / B = 40 messages), and even equal-count iterations differed in content/order.
- Throughout, the **engine stayed perfectly consistent** (`beatSeq` matched on every iteration), with
  **zero HTTP 409s and zero JS errors**.
- A **manual reload reconciles** both tabs to an identical conversation (49 / 49) — proving the
  **persisted log is intact** and the defect is entirely in the **live FE replication** (a render-layer
  consistency failure, not data loss).

### Root cause (traced — exact sites)

The FE chat conversation is a **replicated log with no merge discipline**. It *claims* (in
`session_events.py`'s own comments) to be "a single authoritative server-ordered log every device renders
from," but it was never built that way. Three compounding defects:

1. **No ordering key.** `ChatMessage` (`core/database.py:161-188`) carries a random `uuid4` id and a
   **non-unique** `timestamp` (`utcnow()`); render/reload order is `ORDER BY timestamp` only
   (`session_manager.py:143`, `history_routes.py:82`). Two near-simultaneous writes tie, and the SQLite
   tie-break on a non-unique index is unspecified → **reorder** across tabs.
2. **The sender tab is optimistic-only and never reconciles.** On send, `chat.js:692-694` renders the
   user bubble and streams the reply into a local bubble; for an ordinary game turn there is **no
   post-`[DONE]` re-fetch** of the authoritative history. The sender's DOM is a permanent local guess.
3. **The busy tab drops the peer's events.** `sessionSync.js:51` (`if (hasActiveStream(id)) return`)
   cannot distinguish "my own echo" from "the *other* tab's real `message-added` / `run-started`," so a
   streaming tab **discards the very events that would tell it a peer wrote** — and streaming turns
   publish only `run-started` (`chat_routes.py:1364`), never a completion event, so there is no later
   recovery. *(Latent: `agent_runs.py:154-164` keeps one `_Run` per session → a run-replacement
   lost-update on `resumeStream`.)*

The **intended** consistency model is **read-your-writes over a convergent server-ordered log**; it is
**violated** by an optimistic-append UI layered over at-least-once SSE treated as exactly-once, with a
suppression gate that drops the reconcile signal.

## Decision

Make the chat conversation the **id + `seq`-ordered authoritative log the code already claims it is**, and
have every tab **render-and-reconcile to it** rather than maintain a private optimistic copy:

1. **Authoritative ordering.** Add a **monotonic per-session sequence** to `ChatMessage`
   (`seq INTEGER`, `UNIQUE(session_id, seq)`), assigned under the same per-session serialization the
   `agent_runs` queue already provides. **All render paths and `/api/history` order by `seq`**, never
   `timestamp`.
2. **Render-by-id, reconcile-not-replace.** The optimistic local bubble carries a client-temp id; when
   the server-assigned `{id, seq}` arrives (in the SSE event payload or a targeted fetch), the tab
   **merges by id** — temp → canonical, inserting any missing peer turns in `seq` order — instead of
   "full `innerHTML` rebuild OR nothing."
3. **Idempotent event handling.** Replace the coarse `hasActiveStream` suppression with **`{id, seq}`
   dedup**: process every event, drop only those whose `{id, seq}` is already rendered. A mid-stream tab
   still ingests the peer's turns.
4. **A completion broadcast + run-by-id.** Publish `message-added` carrying the new `seq` when a
   streaming turn persists its assistant message (today only `run-started` fires), so a tab that missed
   `run-started` still converges; and make `resumeStream` attach to a run **by id**, not "whatever
   `_RUNS[session_id]` is now."

This is a **contained refactor** — one schema column + the two render paths + the sync handler + one
extra broadcast — **entirely FE-side (the engine is untouched)**, and it preserves the tiny,
Vault-free SSE-payload property (`seq` is closed-set-ish metadata, never content).

## Alternatives considered

- **Leaf patch — "after `[DONE]`, the sender calls `softReloadHistory`."** *Rejected.* It narrows but does
  not close the window: `softReloadHistory` still self-guards on `hasActiveStream` (`chat.js:3521`), still
  orders by `timestamp` (no stable tie-break), and the suppress-gate still drops a peer event arriving
  mid-stream. The structure stays unsound for concurrent writers. (This is the exact "patch the leaf"
  the mandate warns against.)
- **Full reload on every SSE event.** *Rejected.* Heavy (re-fetch + full `innerHTML` rebuild per event),
  causes flicker/scroll-jump, fights streaming, and *still* lacks a stable ordering key — it converges
  counts but can reorder a tied pair.
- **A CRDT / OT layer for the conversation.** *Rejected as over-engineered.* The conversation is
  append-mostly with a **single server writer per turn** (the `agent_runs` queue already serializes); a
  server-assigned monotonic `seq` + id-dedup gives a total order. A CRDT's concurrent-edit machinery
  buys nothing here.

## Consequences

- Two tabs/devices **provably converge during live play** (not only after a manual reload) — the 0064
  cross-device promise becomes real under concurrent activity.
- The conversation gains a real **total order** (`seq`), which also fixes a **latent single-tab reorder
  bug** (two messages persisted in the same `utcnow()` tick).
- A schema migration adds `seq` (back-fillable from existing `timestamp` order for legacy rows; new rows
  assigned under the queue lock).
- The **Vault Wall and cross-user isolation are untouched** (sync payloads stay ids / `seq` / types).
- **Verification (binding):** a permanent **two-tab concurrent-write parity gate** — the audit's looped
  harness distilled to a test — asserting both tabs converge to a byte-identical rendered conversation
  under concurrent writes (and that a reload is never *required* to converge).

## Open / to confirm

- **Done:** implementation authorization granted ("finish the audit first, then implement"); the `seq`
  assignment was pinned to **`_persist_message`** — `MAX(seq)+1` under the SQLite write lock, with the
  `UNIQUE(session_id, seq)` index as the race backstop (IntegrityError → recompute + retry).
- **Remaining (verification):** a live two-tab **concurrent-write** browser re-run with real model turns
  (the audit's `s3raceloop` against the fixed FE) — the convergence is proven at the persistence layer
  (the interleaved-writers gate) and the render layer executes clean + is contract-pinned, but the
  end-to-end browser re-run is best done via CI's `frontend` job or a dedicated session with a fresh game.
