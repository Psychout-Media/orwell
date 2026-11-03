# Hermes → Orwell Integration Map (Phase 3)

> **Status: audit deliverable — no integration code authorized yet.** One entry per integrate-able
> asset: source → target port → integration type → mandate-safety proof → attribution → effort/risk.
> Rejected anti-patterns are listed separately with the mandate they would breach.
>
> Sources: the five-specialist Phase-1 deep-dive (`INTEGRATION-INVENTORY.md`). Source repo:
> `hermes-agent` @ `2b3a4f0` (MIT © **Nous Research 2025** — every harvested file/pattern retains the notice).
> Target: `orwell` (MIT © kevinhirsch). orwell's FE is an *Odysseus* white-label, so harvested hermes code
> is **new** third-party material requiring a fresh `frontend/ACKNOWLEDGMENTS.md` entry + `frontend/licenses/`.

## How to read a mandate-safety proof
Per the guardian's recipe, a candidate is *proven* (not asserted) mandate-safe when: (a) its code sits FE-side
or under the dependency-cruiser `OUTWARD` set; (b) `test:arch` + `tests/architecture/vault-boundary.test.ts`
stay green ⇒ structurally cannot read the Vault; (c) any new player tool is `readsVault:false` with a
`McpServer.callTool`-dispatching boundary test; (d) any fact surfaced to the player flows through
`KnowledgeService.surfaceInformationTo` on an anchored pathway; (e) the FE full suite passes for any
chat-stream/mutation seam (g15 single-dispatcher, reasoning-scrub render contract).

---

## A. Integrate (mandate-safe, additive)

### A1 — Off-screen society **texture enrichment** via the parallel-authoring pattern  ★ highest leverage
- **Source:** `tools/delegate_tool.py` (parallel isolated-subagent fan-out: fresh child context, summary-only
  return, `ThreadPoolExecutor` batch) — **pattern only, not a code lift** (it's Python coupled to hermes' agent stack).
- **Target:** a new **FE-driven write-back** `recordOffscreenSceneTexture(eventId, content)` enriching the
  deterministic template `content` produced in `src/engine/offscreen.ts` (today: `` `${a} ${RICH_VERBS[type]} ${b}` ``).
  Wired the canonical four places (`src/ports/GameSession.ts` → `GameSessionAdapter.ts` →
  `src/surfaces/tools/registry.ts` PLAYER_TOOLS+INFRA_LEVERS → `src/adapters/mcp/McpServer.ts` guard+dispatch),
  driven by a best-effort FE task modeled on `frontend/src/orwell_zeitgeist.py` (fan out N parallel utility-LLM
  calls, one per scene skeleton the engine already decided).
- **Integration type:** net-new behavior (orchestration *pattern* adopted; the off-screen seam already exists).
- **Mandate-safety proof:**
  - **Vault (#1):** the engine has already recorded each scene as a hidden event (`hidden:true`, witness set
    excludes the player). The write-back only *replaces the prose of an already-hidden event* — it is **downstream
    of the Vault boundary, not across it.** Child LLM calls receive **public personas only** (the
    `portraitPrompts.ts` "public-facets-only" constraint). It reaches the player **only** through the *existing*
    `rollOverhears` / `diffuseGossip` pathways (both already `KnowledgeService`-filtered with drift + confidence).
    Proven by a `McpServer.callTool` boundary test (template: `tests/unit/worldSnapshotBoundary.test.ts`) asserting
    the write-back cannot carry a relationship number or set a witness, plus the standing vault-boundary tests.
  - **Anti-sycophancy (#2):** the engine commits the **entire closed set** — which pair, the nature, the seeded
    magnitude, the fold — *before* the FE is called. The model proposes **only the open set** (prose/texture),
    which ADR 0005 says is "recorded faithfully and never normalized." **No subagent ⇒ the deterministic template
    string simply stands** (byte-identical), guarded permanently by `tests/unit/expressiveNonCollapse.test.ts` +
    `frontend/tests/test_expressive_non_collapse.py`.
  - **Purity (#3):** attaches behind the existing outward `GameSession`/MCP membrane; the pure core is untouched.
  - **Non-degradation + fidelity (#4):** strictly *additive* richness for mandate priority #1 (off-screen
    NPC-to-NPC scheming the player never witnesses); the parallel fan-out makes scene *volume* affordable per tick.
- **Attribution:** Nous MIT (pattern credit in the new write-back's doc + ACKNOWLEDGMENTS).
- **Effort/risk:** **Medium / Low-Medium.** Dominant risk = the documented "FE write-back silently no-ops if
  steps 3–4 are missed" footgun (static gates don't catch it ⇒ the boundary test is mandatory). Cost/pacing risk
  (N parallel calls/tick, flooding gossip) bounded by an `imageConstants.ts`-style per-turn budget cap + turn-driven ticks.
- **Specialist confidence:** High (safety + port exist); Medium (pacing/cost tuning).

### A2 — Multi-platform **gateway** access (Telegram/Discord/Slack/WhatsApp/Signal)  ◆ optional, scope decision
- **Source:** `gateway/platforms/base.py` (`BasePlatformAdapter` ABC) + `gateway/platform_registry.py`
  (`PlatformEntry` self-registration) + `gateway/pairing.py` + `gateway/delivery.py` + `gateway/stream_dispatch.py`
  / `stream_events.py` (typed `MessageChunk` vs `ToolCallChunk`). **Adapt, not lift** — `gateway/run.py` is an
  850KB god-file; reimplement the thin `inbound → run_orwell_turn → deliver` loop against orwell's stack.
- **Target:** a NEW non-Vault player adapter (a `frontend/gateway/` package) that translates an inbound platform
  message into the same call `frontend/routes/chat_routes.py` makes (agent loop → `orwell_engine` MCP player
  channel) and delivers the public reply back out.
- **Integration type:** adapt (registry + pairing + delivery patterns) + pattern (the run loop).
- **Mandate-safety proof:**
  - **Vault (#1):** safe **by inheritance** — orwell's player tier already consumes only Vault-free projections;
    a new surface over the same MCP player channel inherits the wall (separate process, imports no TS port). The
    proof is a delivery-text boundary test: the outbound message contains no `npc:<id>` / operator-aside / reasoning.
  - **The #1 transport risk — reasoning in the public bubble:** orwell's reasoning/reply split is enforced *in the
    browser* (`chat.js`). A messaging transport has no accordion. **Required mitigation:** a **server-side
    reasoning/operator-aside scrub chokepoint** before `delivery.send` (the Python analog of `markdown.js
    processWithThinking`), modeled on hermes' `stream_dispatch.py` "eat the events you can't render" design.
  - **One-game-per-user (a first-class isolation guarantee, #1-adjacent):** hermes keys sessions *per platform*
    (`agent:<ns>:<platform>:dm:<chat_id>`) — the same human on Telegram + web would get **two games**. **Required
    mitigation:** `gateway/pairing.py` binds a platform identity to ONE orwell account; the adapter then asserts
    that account's `x-orwell-user` regardless of platform.
  - **chat-is-the-game (ADR 0003, #4):** *strengthened* (pure chat, no dashboard). Decision cards/HUD don't exist
    on Telegram ⇒ degrade `PendingDecisionView` to inline text prompts (the engine already exposes the `binding` flag).
    Must respect `ORWELL_GAME_BUILD` tool-gating so platform players can't reach inherited-workspace tools.
- **Attribution:** Nous MIT (gateway + pairing).
- **Effort/risk:** **Medium-High / Medium.** New gateway package, per-platform SDK deps, identity binding,
  server-side scrub, text-degraded decisions. **This is a product-scope decision** (does orwell want off-browser reach?).
- **Specialist confidence:** High (feasible + Vault-safe); Medium (effort sizing — decision-card degradation is fuzzy).

### A3 — `pairing.py` identity bridge
- **Source:** `gateway/pairing.py` (near-verbatim adopt). **Prerequisite for A2**; also a building block for ADR
  0007 public-internet exposure auth. **Target:** platform/external-identity → single `x-orwell-user`.
- **Mandate-safety:** no Vault contact; pure auth; must collapse to one orwell account. **Effort/risk: Low/Low.**

---

## B. Hardening drop-ins (small, low-risk)

### B1 — `agent/redact.py` + gateway SSRF / path-traversal guards
- **Source:** `agent/redact.py` (vendor-prefix + query-param secret masking), gateway URL/path guards (V-009 hardening).
- **Target:** `frontend/` logging + any new outward fetch path (esp. if A2 lands). **Type:** drop-in.
- **Mandate-safety:** generic defensive hardening, no mandate surface (orwell already redacts; this is broader).
- **Attribution:** Nous MIT. **Effort/risk: Low/Low.**

---

## C. Pattern-only (reference, no code import)

| ID | Source | Pattern to adopt | Where it informs orwell |
|---|---|---|---|
| C1 | `gateway/response_filters.py` | `[SILENT]` / `NO_REPLY` intentional-silence markers | FE agent-loop under-call correction (`agent_loop.py`) |
| C2 | `agent/context_engine.py` `ContextEngine` ABC | "compaction as a swappable port"; "REFERENCE-ONLY, latest-message-wins" summary preamble (anti-sycophancy-aligned) | *if/when* `context_compactor.py` is refactored into a port; FE transcript only, never engine state |
| C3 | `providers/base.py` `ProviderProfile` | declarative per-provider profile dataclass replacing imperative branches | optional cleanup of `llm_core.py`/`endpoint_resolver.py` — **capability already present**, value is code-cleanliness only |
| C4 | `optional-mcps/*` manifests | commit-pinned, review-gated MCP catalog discipline ("presence = approval", no floating HEAD) | a doc convention for any future ADR-0007 third-party MCP exposure |

---

## D. Rejected — anti-patterns & out-of-scope (with the mandate breached)

| Asset (hermes path) | Why rejected | Mandate breached |
|---|---|---|
| **Memory / user-modeling self-improvement loop** — `agent/background_review.py`, `agent/memory_provider.py`, `plugins/memory/{honcho,mem0,hindsight}`, `tools/memory_tool.py` (`USER.md`/`MEMORY.md`), `agent/curator.py`, cron `usage` suggestions | Its purpose is to model the human and adapt to please them; model-authored persisted state; external memory services outside the boundary. The mandate-safe shapes already exist natively (`SoulStore.ts` NPC memory, `competitionLibrary.ts` read-only catalog). | **#2 anti-sycophancy** (core), **#1 Vault** |
| **Runtime memory-coupled compression** — `agent/conversation_compression.py` (notifies memory providers, rotates sessions) | Creates a second persisted-truth store rivaling the engine/Vault; orwell's `context_compactor.py` is the safe working-context-only form. | **#4 non-degradation**, **#1 Vault** |
| **Wall-clock cron as default** — `cron/scheduler.py` | The house must NOT live while the player is away (background advances during absence = structural disadvantage; the former `ORWELL_WATCHER_TICK_MS=0` default — the watcher was deleted 2026-07-10). Ops-only at most. | Owner ruling (turn-driven game clock) |
| **Generic MCP catalog + bundled servers** — `optional-mcps/{linear,n8n,unreal-engine}` | New outward dependencies that could pierce the permission boundary; orwell's tool set is closed and audited. | **#1 Vault / permission boundary** |
| **`web/` + `ui-tui/` + `tui_gateway/` as player surfaces** | Same Odysseus lineage orwell already forked; `web/` chat is just xterm.js embedding the TUI; the chat IS the UI (ADR 0003; 0022 deferred). Lifting = dashboard-ification + re-exposing the gated workspace. | **#4 (don't build a dashboard)** |
| **Skills self-creation** — `skills/`, `agent/skill_*`, `agent/curator.py` | orwell is a fixed-domain sim, not a general agent; model rewriting its own capabilities to please recurring asks is an accommodation loop. | **#2 anti-sycophancy**, ADR 0003 (engine decides) |

## E. Duplication (orwell already has it — skip, don't re-port)
FTS5 session search (`frontend/src/session_search.py`) · context compaction + adaptive budget
(`context_compactor.py` + `context_budget.py`) · Anthropic prompt caching + reasoning/`max_completion_tokens`/
temperature quirks (`llm_core.py`) · per-turn cost/usage ledger (`orwell_token_ledger.py`, ADR 0010) · semantic
vector recall (fastembed/ONNX, ADR 0004) · server-push / cross-device sync (`_publish_game_updated`, feature 0064).

## F. Deploy invariant (carry into any plan)
The memory/skills anti-pattern surface is walled **at runtime** by `ORWELL_GAME_BUILD` (drop-set: routes
unmounted, context injection off, JS stripped) — **not compile-time.** Treat "game build on" as a **deploy
invariant**; `ORWELL_GAME_BUILD=0` silently re-exposes every rejected surface. There is no FE-side
dependency-cruiser equivalent; the proof is the pytest convention checks + `boot_smoke.py` + `browser_smoke.py`.
