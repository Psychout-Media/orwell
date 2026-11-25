# 0004 — Embedding provider (runtime semantic soul recall)

> **Status:** Accepted — **BUILT** (E86a, 2026-06-11): `FastembedEmbedding` +
> `fastembedWorker` in `src/adapters/embedding/`, fastembed pinned exact in
> `package.json`, model pinned in the worker (`fast-bge-small-en-v1.5`), deploy
> prefetch + `ORWELL_EMBEDDINGS=fastembed` written by the installer. See the
> amended "Implementation status" below for the design constraints honored.
> **Resolves:** the last genuinely-open item in `CLAUDE.md` / `README.md` "Open decisions"
> (`docs/bb-sim-spec.md` §16.3) — which model backs `EmbeddingProvider` at runtime.
> **Source:** human ruling during the 2026-06-10 audit session
> (`docs/audits/2026-06-10-v1-transcript-meta-feedback-audit.md` §6.4).

## Context

Souls are markdown + an **engine-only** vector index (`SoulProvider`, `VectorIndex`,
`EmbeddingProvider` — all behind the Vault Wall; feature 0024). Semantic recall is what lets
"the veto betrayal" pull *that* memory rather than the most recent one (0041 live recall).
All seeded tests run against a **deterministic fake** embedding provider, so nothing in the
test gates depends on this choice; it affects only live recall quality. The deploy story is
local-first (a self-hosted LXC; Ollama or an API key are the *optional* LLM providers), so
the embedding default should not introduce a mandatory API key or network dependency.

## Decision

- **Runtime default: fastembed, local ONNX** — the engine-side adapter uses the **fastembed
  JS port** (npm `fastembed`, ONNX Runtime under the hood) with its default small BGE model,
  **version-pinned** (model + library) so recall stays stable across updates within a save.
- **The deterministic fake remains the test adapter** — every seeded/CI lane keeps using it;
  no test may depend on real embeddings.
- The adapter lives behind `EmbeddingProvider` like any other; swapping to Ollama embeddings
  or a hosted API later is an adapter change, not a design change.

## Why

- **Local-first, zero-key.** Matches the deploy's privacy/self-hosted posture; soul recall —
  a background, engine-only feature — must not be the thing that demands an API key.
- **Already in the family.** The vendored front-end uses (Python) fastembed for its
  memory/RAG; one embedding story across the product, two language-native ports of it.
- **Deterministic enough.** A pinned model version gives reproducible vectors per save,
  which suits non-degradation (0007): recall quality can improve only by *deliberate,
  versioned* migration, never silent drift.
- **Engine-only by construction.** Embeddings sit behind the wall (`VectorIndex` /
  `EmbeddingProvider` are engine-only ports; the dependency-cruiser gate already covers
  them) — provider choice cannot leak anything outward.

## Consequences

- The engine gains an optional native dependency (ONNX runtime) loaded lazily by the
  fastembed adapter; environments without it fall back to the deterministic provider
  (recall degrades gracefully, the game never breaks).
- The model file is fetched/cached at install time by the deploy scripts (offline-friendly
  thereafter), pinned alongside the engine version.
- Revisit only if live play shows recall quality is a felt problem — that would be a new
  decision record superseding this one.

## Implementation status (BUILT — E86a, 2026-06-11)

The adapter is live, honoring three engine constraints:

1. **The soul seam stays synchronous** (an `await` inside a mutating tool would reopen the
   masked sandbox-swap race): real ONNX inference runs in a worker thread
   (`fastembedWorker.ts`) and `FastembedEmbedding.embed()` blocks on a
   SharedArrayBuffer/Atomics bridge with a bounded per-call timeout.
2. **One vector space per process lifetime** (mixing spaces inside an index breaks cosine
   recall): main.ts warms the provider up at boot (`ORWELL_EMBEDDINGS=fastembed`) BEFORE any
   sandbox exists and injects it via `setRuntimeEmbedding`; warm-up failure composes the
   deterministic provider for the whole process instead. Vectors are derived state
   (`rebuildSoulIndex` re-embeds from `hg.soul.memory` on restore), so the space may differ
   per process, never within one.
3. **The game never breaks on embeddings:** a worker failure mid-process degrades the
   provider permanently (for that process) to the deterministic fallback with a loud log;
   the next restart re-derives all indexes. Deploy prefetches the model into `data/models`
   (preserved by updates and both reset scripts; offline thereafter).

The deterministic fake remains the test adapter (the bridge is proven against
protocol-faithful fake workers in `tests/unit/fastembedBridge.test.ts`; the real model runs
only in the opt-in `ORWELL_TEST_FASTEMBED=1` integration test).

The original honest-record text is kept below for history.

**Original record (superseded): no adapter existed yet.** As of this amendment the engine's only `EmbeddingProvider` adapter is the
deterministic hash-vector fake (`src/adapters/embedding/DeterministicEmbedding.ts`), and it
is what **production** composes — there is no `fastembed` dependency in `package.json`, no
pinned model, and no deploy-time model fetch. Live "semantic" recall (0024/0041) therefore
runs on the bag-of-words hash vector today. This is functional (recall is still by content,
not recency) but it is **not** the accepted decision above, and no test gate can detect the
gap because the fake is, by design, also the test adapter.

*(Don't be confused by the front-end: `frontend/requirements*.txt` does install the **Python**
fastembed — that is the vendored workspace's own RAG/memory stack, not the engine's
`EmbeddingProvider`. Its pinning is the E83 lockfile work, tracked separately on the FE side.)*

**The path to done (the fastembed adapter is its own queue item / engine lane):**

1. Add the **version-pinned** `fastembed` JS library (exact pin, not a range) and pin its
   default small BGE model alongside it.
2. Build `FastembedEmbedding` in `src/adapters/embedding/` behind `EmbeddingProvider`:
   **lazy** ONNX load at first embed; on any load/runtime failure, **fall back to
   `DeterministicEmbedding`** (recall degrades gracefully — the game never breaks).
3. Deploy scripts fetch/cache the model at install/update time (offline thereafter).
4. The deterministic fake **remains the test adapter** — no test may depend on real
   embeddings; the engine-only dependency-cruiser boundary already covers the new adapter's
   ports (`EmbeddingProvider`/`VectorIndex` are engine-only).

Until that lands, prose elsewhere (CLAUDE.md, README, spec §16 mirrors) must describe
fastembed as the **accepted runtime target**, not as running — the deferral is tracked with
the other long-acknowledged deferrals (relational adapters, MCP/JSON-RPC).
