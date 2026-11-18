# Fail-soft scale audit (WORK ITEM 1 of #1599)

**Ruling (owner, 2026-07-14, issue #1599):** *NOTHING fails softly unless the owner gives explicit
permission.* Every **genuine failure** (an exception / non-2xx / a guard that couldn't run / a
refused write) must (1) show **RED** on `/admin/status` — *including when auto-corrected*, annotated
`auto-corrected by <belt>` vs `uncorrected`; (2) **log at WARN/ERROR** with class + error +
correction; (3) **never `except: pass` a real error into the void.** An **expected negative result**
(no deal to extract, no NPC present, an empty optional) is normal flow — **not** a failure, and does
not alarm. The ban is on **swallowed errors**.

This document is the **scale deliverable** (WORK ITEM 1): an enumeration + classification of every
fail-soft site so the owner can grant/deny per-site permission. It is **docs-only** — it does **not**
build the allowlist mechanism, the `/admin/status` panel, or the CI lint (work items 4–6), and it
ships **no code**. Per the ruling's sequencing ("produce a count + list for the owner to grant/deny
per-site permission"), the corrections below are **proposed, not applied** — remediation follows the
owner's per-site grants (a later slice).

**Reference pattern (the model the proposed corrections copy):**
`frontend/src/faithfulness.py::_record_faith_guard_down` — on a guard failure it WARN-logs **first**,
then records a RED-eligible health event via `log_rings.record_overseer(..., ok=False)`, and only
demotes a *telemetry-record* failure to DEBUG **after** the WARN. The recommended remediation promotes
that pattern to a shared recorder `frontend/src/log_rings.py::record_soft_failure` (**proposed** — not
built here).

---

## Method

An AST pass (`ast.Try` walk) over `frontend/src/**` and `frontend/routes/**` enumerated every
exception handler whose body is a pure **swallow** — `pass`, `return None`, `return <constant>`,
`return <empty collection>`, `continue`, or `return <default>` — and which does **not** re-raise.
Each was bucketed by two heuristics over the `try`-body and handler text: (a) does the body already
log at WARN/ERROR? (b) does the guarded work touch a **call** surface (LLM / engine tool / HTTP /
write-back) vs a **benign** surface (config/env read, `json.loads`, `int()`/`float()`, `getattr`) vs
a **telemetry/logging** surface (a recorder like `record_overseer` / `record_io` / `emit_trace` /
the ledgers)? The TS engine (`src/**`) was swept separately for swallowing `catch` blocks.

The A/B/C split below is heuristic at the aggregate level (keyword-based); the **high-signal class-A
tables** further down are **hand-verified**. The scanner and its JSON output live under the session
scratchpad (not committed).

### Classification

| Class | Meaning | Disposition |
|---|---|---|
| **A** | **Real-error path** — a genuine failure (call/engine/LLM/write-back) is swallowed with no RED-eligible record. | → must become **RED + WARN/ERROR log**. |
| **B** | **Expected-empty / normal flow** — a config/env read with a documented default, a parse-with-fallback, a "no X present" optional, a capability probe that legitimately returns "unavailable". | **Leave alone** — not a failure; alarming would be noise. |
| **C** | **Owner-allowlist candidate** — a *telemetry/logging-path* swallow ("logging must never hurt the app": the recorder/logger itself failing, a ring `push`, a ledger write). Terminal by design. | Documented reason; **allowlist** (work item 6). |

---

## Counts

### Front-end (Python) — `frontend/src`, `frontend/routes`

Total swallow-handlers analysed: **1041**.

| Surface | Handlers | A (real-error) | B (expected) | C (allowlist-cand.) |
|---|---:|---:|---:|---:|
| **Game surface** (the `ORWELL_GAME_BUILD` app: `orwell_*`, `agent_loop`, `faithfulness`, `overseer`, `chat_*`, `tool_*`, `llm_*`, `enrichment_policy`, the admin/chat/ws/model routes, …) | 614 | **120** | 450 | 44 |
| **Inherited workspace** (`cookbook`, `shell`, `email`, `research`, `pdf`, `caldav`, `document`, `memory/rag/chroma`, … — largely **stripped by the game build**) | 427 | **47** | 376 | 4 |
| **FE total** | **1041** | **167** | **826** | **48** |

### Engine (TypeScript) — `src`

The pure domain core uses **typed errors** and the orchestrator's fail-closed integrity checkpoint;
the swallow surface is small and concentrated in **adapters**. Swept: **~16** swallowing `catch`
blocks (vs ~3 that re-raise), in `FileSaveStore.ts`, `SqliteSaveStore.ts`, `FileUserNotorietyStore.ts`,
`GameSessionAdapter.ts`, `HttpMcpServer.ts`, `LlmNarrativePort.ts`, `composition/registry.ts`,
`composition/runtime.ts`. These are **deferred to a later slice** (this PR's remediation is FE-side,
matching the reference `record_overseer` recorder); they are catalogued in
[TS engine sites](#ts-engine-sites-deferred) below.

**Headline for the owner:** ~**167** FE class-A candidates (**120** on the live game surface) plus
~**16** TS adapter sites are silently failing today. The high-signal subset — the guard/judge and
narration/utility-LLM and write-back lanes the ruling names — is enumerated below with a proposed
correction for each; the long tail is the per-site grant/deny backlog.

---

## Class-A: high-signal game-surface sites (the grant/deny list)

Grouped by the three lanes the ruling calls out. Every correction below is **proposed** (no code
ships in this docs-only PR); the recommended first slice is marked **◆**, the longer tail ⏳.

### Lane 1 — guard / judge failures

| # | Site | The swallow | Class | Proposed correction |
|---|---|---|---|---|
| 1 | `frontend/src/overseer.py` `LlmOverseer.assess` (`except` ~L528) | model-call/parse error → deterministic floor, **silent** | A | ◆ `record_soft_failure("overseer:judge-call-failed", …, corrected="deterministic-floor")` before the floor |
| 2 | `frontend/src/overseer.py` `DeterministicOverseer.assess` (`except` ~L406) | heuristic self-error → benign `hold` verdict, **silent** | A | ◆ `record_soft_failure("overseer:heuristic-error", …, corrected="hold")` before the hold |
| 3 | `frontend/src/agent_loop.py` live overseer judge (`except` ~L7585) | LLM judge call failed → deterministic floor, **silent** | A | ◆ `record_soft_failure("overseer:judge-call-failed", …, corrected="deterministic-floor")` |
| 4 | `frontend/src/agent_loop.py` **active-mode** overseer judge (`except` ~L6332) | LLM judge call failed → deterministic floor, **silent** | A | ◆ same recorder |
| 5 | `frontend/src/agent_loop.py` overseer model-resolve (`except` ~L7573) | `_resolve_llm_fn` **raised** (≠ returned None) → floor, **silent** | A | ◆ record on a genuine **raise** only (a `None` return = no model = expected/Class B, untouched) |
| 6 | `frontend/src/agent_loop.py` overseer hook outer (`except` ~L7595) | whole hook errored → `logger.debug`, no RED | A | ◆ upgrade to `record_soft_failure("overseer:hook-error", …)` |
| 7 | `frontend/src/agent_loop.py` in-game faithfulness gate (`except` ~L7616) | `_faith_check` raised before its own record → `logger.debug`, no RED | A | ◆ upgrade to `record_soft_failure("faith:gate-error", …)` |
| 8 | `frontend/src/agent_loop.py` casting faithfulness gate (`except` ~L7632) | same, casting twin → `logger.debug`, no RED | A | ◆ upgrade to `record_soft_failure("faith:casting-gate-error", …)` |
| — | `frontend/src/faithfulness.py` (`_faith_check` + `assess`) | already RED via `_record_faith_guard_down` | — | **Reference — already done (#1599 interim).** |

### Lane 2 — narration / utility-LLM call swallows (the enrichment write-back drivers)

The FE model-driven enrichment lanes (`cast-authoring` 0058, `cast-identity` #544, `cast-prewarm`
0065, `cast-genesis` 0116, `zeitgeist` 0062, `offscreen-texture` 0070) all funnel their genuine
failures through **`enrichment_policy.record_failure`** under the shipped **strict** policy. That
recorder logs ERROR + a bounded admin ledger, but only routed to the RED overseer channel for the
*"no model"* reason (via `assess_enrichment_health`, and only its `escalation` verdict is RED) — a
failed LLM **call**, garbage output, or a **refused write-back** never reached RED.

| # | Site | The swallow | Class | Proposed correction |
|---|---|---|---|---|
| 9 | `frontend/src/enrichment_policy.py` `record_failure` (~L97) | ERROR-logs + ledger, but **no RED** for call-failure / bad-output / refused-write-back reasons | A | ◆ emit `record_overseer(anomaly, "enrichment:<callClass>", …, ok=False)` for **every** enrichment failure — covers all **6** driver classes at one seam |
| ⏳ | `frontend/src/orwell_cast_authoring.py` per-NPC LLM fail (~L700), retry fails (~L723/737) | `logger.warning` but no RED | A | (deferred) route the per-NPC WARN through `record_soft_failure` |
| ⏳ | `frontend/src/orwell_gen_competitions.py` (~L174/181/223), `orwell_offscreen_texture.py` (~L135), `orwell_zeitgeist.py` (~L193) module-import guards | `import _resolve_llm_fn` failing → `return {}`/no-model | C-ish | (deferred) import-guard; genuine call failures already route via `record_failure` (#9) |

### Lane 3 — write-back / engine-tool failures

**Key finding:** every FE→engine call already flows through `orwell_engine._call`, which records
`log_rings.record_io(name, args, ok=False, …)` on **any** exception (an ERROR-level entry in the
Engine I/O ring, surfaced on `/admin/status`). So the ~50 `do_*` handlers in
`tool_implementations.py` that `except … return {"error": …, "exit_code": 1}` are **not silent to the
operator** — the raw failure is already on the status page (and the model is told). What they lack is
a **classified RED alarm/rollup**, which is **work item 3** (deferred). They are therefore **not**
slice-1 targets (remediating them would double-record the IO tap).

| Site | Status | Note |
|---|---|---|
| `frontend/src/tool_implementations.py` `do_*` engine dispatch (`except` ×~50: `run_competition`, `record_interaction`, `advance_game`, `submit_decision`, `make_deal`, …) | ⏳ deferred | Already IO-recorded (ERROR) via `orwell_engine._call`. Needs the **rollup alarm** (work item 3), not a per-site record. |
| `frontend/src/agent_loop.py` state-read best-effort (`get_game_state`/`get_visible_state` ~L2826/2833/2851) | ⏳ deferred | IO-recorded on failure; the swallow only skips an *optional* read. Lean-B (expected-empty on engine-down). |

---

## Class-C: owner-allowlist candidates (the "logging must never hurt the app" class)

**48** FE sites (44 game-surface) are *telemetry/logging-path* swallows — the recorder, logger, or
ring itself failing, where there is nowhere left to write and the swallow is terminal by design. The
reference pattern already treats these as the final tier (demote to DEBUG *after* the WARN). They are
the **seed of the owner allowlist** (work item 6). Representative:

- `frontend/src/log_rings.py` `Ring.push` (`except: pass` L40), `_RingHandler.emit` (L78) — the ring
  writer itself.
- Every `try: … record_overseer(…) except: pass` in `agent_loop.py` (~L2658/2748/2791/3334/3478/
  3572/6555/6576) — the health recorder failing.
- `frontend/src/orwell_sync_ledger.py` (~L342), `orwell_token_ledger.py` (~L212),
  `orwell_overseer_debug.py` (~L255) — the ledger-write swallows (already `logger.debug` after a
  best-effort write).
- `frontend/src/llm_trace.py` `emit_trace` / archive-write swallows (~L409), and
  `llm_core.py` `emit_trace` calls (~L1498/2506).
- `frontend/routes/admin_health_routes.py` `_scrub_text` sub-scrubs (~L682/686).

These should be **explicitly allowlisted** (not "fixed") — surfacing a logger-down through the same
logger is circular. Recommended reason string: *"telemetry/logging path — logging must never hurt the
app; failure is terminal (nowhere left to write)."*

---

## Class-B: expected-empty (the large majority — leave alone)

**826** FE sites are normal flow, e.g.: settings/env reads with a documented default
(`get_setting(...) except: <default>`), `json.loads(...) except: <fallback>`, `int()/float()`
coercions, `getattr(...)` shape probes, "no game in progress / pre-game" reads that legitimately
return `None`/`{}`, and capability probes (`image_generation_available`, `authoring_available`) that
return `False` when unconfigured. Alarming on these would bury the real signal — they are explicitly
**out of scope** for remediation per the ruling ("an expected negative result … does not alarm").

---

## TS engine sites (deferred)

| Site | Note |
|---|---|
| `src/adapters/engine/FileSaveStore.ts`, `SqliteSaveStore.ts`, `FileUserNotorietyStore.ts` | persistence best-effort — a save/read failure swallow. Candidate A (a refused/failed persist is a real fault; the orchestrator's persist-failure path is the intended RED seam). |
| `src/adapters/engine/GameSessionAdapter.ts` | adapter-layer swallows around optional reads. |
| `src/adapters/mcp/HttpMcpServer.ts` | transport-edge swallows. |
| `src/adapters/narrative/LlmNarrativePort.ts` | narration adapter (engine-side narrator is `EchoNarrativePort` live; narration runs FE-side, so low live-signal). |
| `src/composition/registry.ts`, `runtime.ts` | composition wiring. |

The engine already surfaces state-integrity + persist-failure faults through the orchestrator's
typed, fail-closed checkpoint (`sandboxHealth`), so the TS remediation is about routing these adapter
swallows into that existing RED-eligible channel — a self-contained later slice.

---

## Recommended first slice (proposed — pending owner grant)

The recommended shared recorder — **`frontend/src/log_rings.py::record_soft_failure`** — would promote
the `_record_faith_guard_down` pattern (WARN first → RED `record_overseer(ok=False)` → demote a
telemetry-write failure to DEBUG after the WARN), taking a `corrected=<belt/lever>` argument so an
**auto-corrected** failure still shows **RED**, annotated `auto-corrected by <belt>` (vs the default
`uncorrected`) — satisfying the ruling's "a correction is not a cloak."

The recommended first slice (the **◆** rows above): overseer judge-call failures (sync + both live
paths), the overseer heuristic self-error, the overseer model-resolve *raise*, the overseer-hook and
both faithfulness-gate outer skips, and the **enrichment `record_failure`** seam (all 6 driver
classes) — **9 edit sites** (one covering 6 enrichment call classes), none of them Class-B. No code is
shipped here; this awaits the owner's grant.

## Deferred (later work items of #1599)

- **Work item 2** — per-class/-tool health rollup with rolling failure rates.
- **Work item 3** — RED alarms for game-breaking signals (guard class failing, narration
  5xx/timeout/empty, write-back EngineRefusal storms, desync/stale-beat bursts, embeddings
  `degraded:true`, integrity/circuit-open) + auto-corrected belt shows RED-with-`auto-corrected`.
- **Work item 4** — the proactive `/admin/status` panel.
- **Work item 5** — the CI test/lint discipline (fail the build on an un-allowlisted swallow).
- **Work item 6** — the allowlist registry (empty by default; the lint reads it).
- The remaining Class-A tail: `orwell_cast_authoring` per-NPC WARNs, the `do_*` rollup, and the
  **TS engine adapter** sites.

## 2026-11-18 amendment (ORW-500): cast-authoring and cast-gate corrections in the health totals

Design choice (Coordinator call 2026-11-17): count them in the existing rollup totals under their own
namespaces, with no new tile. `_SOFT_FAIL_PREFIXES` in `frontend/routes/admin_health_routes.py` now
includes `cast-authoring:` and `cast-gate:`, so every such record shows in the admin health guards
table. They are routine (several per cast), so they never alarm: no storm class reads them and the
`auto-corrected` alarm skips them. Pinned in `frontend/tests/test_1599_failsoft.py`.
