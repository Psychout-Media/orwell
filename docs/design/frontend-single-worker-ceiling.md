# The front-end runs as ONE worker (recorded ceiling, ORW-176)

**In short.** `orwell-frontend.service` runs a single `uvicorn app:app` process. The front-end keeps important live state in that process's own
memory, so a second worker (`--workers N`, `WEB_CONCURRENCY`, a second unit behind a balancer) would split that state: a player's run buffer,
subscriptions and sync ledger would live in one worker while their next request landed on another. Do not add workers without first moving the state
below. This is a recorded ceiling, not a bug; it is not urgent for the current playtest.

## What the ceiling is

- **Capacity** is one event loop plus one worker-thread pool (anyio default **40** tokens; `ORWELL_THREADPOOL_SIZE` can set it, unset keeps 40).
  Blocking work (SQLite, engine-bridge calls, file IO) runs on that pool; the ORW-177 gate keeps the event loop itself free.
- **The engine** (`orwell-engine`, Node) is a separate process and already holds the per-user game sandboxes; it is not what limits us here.

## Process-global state (the inventory a second worker would split)

Pinned by `frontend/tests/test_orw176_single_worker_ceiling.py` so this list cannot drift from the code.

- `core/session_manager.py` - `SessionManager.sessions`: the live chat sessions.
- `src/agent_runs.py` - `_RUNS`: in-flight run buffers (the resume/mirror replay ring).
- `src/session_events.py` - `_SUBS`: per-session server-push subscriber queues (the mirror and WS `state` bridge).
- `src/llm_core.py` - `_dead_hosts`: cooldowns for unreachable model hosts.
- `src/orwell_engine.py` - `_DISCLOSURE_TURN`, `_TELLS_TURN`, `_DELIVERY_SEEN`, `_MUTATION_COUNT`, `_LAST_PENDING`, `_ENGINE_FLAGS`: per-turn belt and disclosure bookkeeping.
- `src/orwell_sync_ledger.py` - `_PENDING_BELTS`, `_PENDING_FORCED`, `_PENDING_STALE`, `_LAST_BEAT_AFTER`, `_PENDING_FE_WRITES`, `_PARKED_*`: the divergence ledger and belt telemetry.
- `src/engine_read_cache.py` - `_ENTRIES`, `_INFLIGHT`, `_INV`, `_BEAT`: the single-flight HUD read cache (ORW-166).

## When more than one busy tester is needed - the two exits

1. **Move the state to shared storage.** Run buffers and subscriptions to a broker (Redis streams / pub-sub or the existing SQLite WAL for the buffers);
   per-user ledgers to the user's own store. This is the real fix and a design slice of its own (ADR needed: it changes the WS and mirror seams, ADR 0008/0012/0017).
2. **Pin users to workers.** Sticky routing by user (the `x-orwell-user` already keys everything): every request for one user reaches the same worker, so
   the in-memory state stays valid per user. Cheaper, but a worker restart drops that worker's users' run buffers (a resume then falls back to the saved history).

Until then: one worker, measure first. If the pool is the limit, raise `ORWELL_THREADPOOL_SIZE` (watch memory; each thread is a stack).
