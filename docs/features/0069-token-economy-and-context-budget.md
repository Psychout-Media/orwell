# 0069 — Token economy: a metered LLM boundary, a reasoning budget & non-degrading context tiering

**Status:** ✅ Built (2026-06-21) · **gate: FE pytest** (a recorded deviation from the BDD-default, matching
0066/0033/0036/0055 — the `.feature` is the spec of record; the executable gate is the front-end pytest
suite, because the behaviour is entirely FE/adapter and is exercised through `llm_core.py` / `agent_loop.py`,
not a new Cucumber world). Shipped all four slices A→D + the admin cost surface + the admin Settings → Token Economy UI. The meter
+ reasoning budget cover **all four call classes** — narration/casting via the agent loop (streaming),
and **utility-extraction/background-authoring via the non-streaming path** (`llm_call_async(call_class=…,
user=…)` resolves the budget and meters the call; the auto-record extractions, the verifier, cast
authoring, zeitgeist, and tagline are wired). Gates live at
`frontend/tests/test_adr0010_{vault_free_ledger,token_policy,context_tiering,usage_meter,reasoning_budget,routing,tiering_wiring,admin_token_economy,settings_ui,utility_calls}.py`
with the full FE suite green. Speculative levers (D tiering, the high-token provider-pin) are opt-in/off-by-default.
**Executable spec:** [`0069-token-economy-and-context-budget.feature`](./0069-token-economy-and-context-budget.feature)
**Provenance:** ADR [`0010`](../decisions/0010-token-economy-architecture.md) (token economy as
architecture); the 2026-06-21 cost investigation (DeepSeek V4 Pro via OpenRouter).

## 1. Summary

Make the front-end's LLM spend **observable and governed** instead of invisible and ad-hoc — without
spending a single token the lean-context architecture (ADR 0003) doesn't need, and **never** trading
persisted detail for a lower bill (mandate #4). Four slices: **(A)** meter the one LLM boundary so every
call records its full token + cost envelope (and the context-% the player never sees); **(B)** resolve a
**token policy per call class** — reasoning effort, output cap, caching posture, context budget — and
finally *send* a `reasoning` budget (the largest, currently-unmanaged cost lever); **(C)** assemble the
prompt **stable-prefix-first** and pin provider stickiness per game session so the provider's automatic
cache actually hits; **(D)** let context **escalate toward the model's window before** lossy compaction,
so long games degrade in *cost*, not *memory*.

## 2. What exists today

- **Usage is half-captured.** OpenRouter returns the full envelope in the final SSE chunk; the parser
  reads only `prompt_tokens`/`completion_tokens` (`frontend/src/llm_core.py:1656`) and drops
  `cached_tokens`, `reasoning_tokens`, `cost`, `cost_details`. `context_percent` is computed but never
  surfaced (`agent_loop.py:1325-1328`); the sync ledger has no token fields (`orwell_sync_ledger.py`).
- **Reasoning is never sent.** The OpenAI-compatible payload (`llm_core.py:1361-1376`) carries no
  `reasoning` map — the reasoning model runs at default effort every turn, and output (mostly thinking)
  is ~89% of the per-call cost in the sampled logs.
- **Output caps are scattered constants** (narration 4096 `agent_loop.py:2545`; extractions 1500/1200/600
  `:1838/:1754/:2440`) with no shared call-class notion.
- **Caching is left to luck** — no `session_id`, no provider routing; the only `cache_control` wiring is
  Anthropic-only (`llm_core.py:688-707`). Nothing asserts the stable prefix is stable.
- **Context is capped then summarized away** — `0.60 × window` capped at **48K** (`context_budget.py:29-34`),
  then lossy compaction (`context_compactor.py`, ~85%). A 1M window is unused as a backup.

## 3. Scope

**In:**
- **(A)** Full usage-envelope capture at `llm_core.py` (input · cached · reasoning · output · cost ·
  cost_details · provider · context-%), threaded through `llm_trace.py` into a **Vault-free per-turn
  token/cost ledger** + an **admin-only** cost surface, **plus a soft per-game spend alert** (admin-only,
  configurable threshold, no enforcement).
- **(B)** A central **call-class → token policy** resolver (`narration` · `utility-extraction` ·
  `casting` · `background-authoring`) and the wiring to *send* `reasoning` (effort/`max_tokens`) on the
  OpenAI-compatible path, applied per class. Existing output caps fold into the policy. The per-class
  **reasoning budget is editable in admin settings at runtime** (read per-request, no restart); the
  constants module supplies defaults. Ratified efforts: narration = **medium**, utility-extraction =
  off/minimal, casting = medium, background-authoring = low.
- **(C)** A **stable-prefix-first** prompt-assembly contract (system + tools + static framing first,
  byte-identical; volatile content last) and **tiered** provider routing: `session_id` stickiness on
  every call (keyed off 0064); **prefer** cache-capable providers with fallbacks on by default; **pin**
  to a cache-capable provider (no fallback) **above the high token-count threshold** (the Slice-D
  large-context threshold).
- **(D)** **Tiered** context budget: lean by default, escalating toward the model window (**~0.85 ×
  window**) **before** `context_compactor` runs — opt-in behind a setting (default lean) so the seeded
  spine and the bill are both unchanged unless turned on.

**Out (Phase 2: ORW-822):**
- Per-game **hard** budget caps / a soft-stop that *interrupts* a game — Phase-2. *(The admin-only soft
  **alert** is in scope — slice A.)*
- **Unconditional** provider pinning for every call — out; the **tiered** routing (stickiness everywhere
  + prefer-with-fallback by default + high-token pin) **is** in scope (slice C).
- Routing the live model through the Anthropic endpoint for explicit `cache_control` — reserved for
  explicit-cache models only.
- Any **engine** change. This feature is FE/adapter-only; the closed set (outcomes, seeds, persistence,
  the Vault) is untouched (ADR 0005).

### Tracked follow-ons — the F-S4-D / PR #481 truncation discussion (2026-06-21)

PR #481 shipped the **tactical** truncation fix (capture `finish_reason`; surface a `Continue ▸`
affordance when the final round ends on `length`; bump the Anthropic `max_tokens` fallback 4096→8192).
The **deeper** items it surfaced are tracked here so they land **with** the slices, not ad hoc:

1. **Configurable per-turn output cap (`max_tokens`).** Slice B makes the per-class **reasoning** budget
   admin-editable at runtime; extend the **same** settings-backed treatment to the per-class **output
   cap** so an operator can raise/lower a class's `max_tokens` live (today the output cap folds into the
   policy as a constant). Same resolver, same `settings.json` read-per-request pattern (no restart), same
   clamp + admin-gate as the reasoning budget. *(A gap on top of Slice B — B currently makes only
   reasoning runtime-editable.)*
2. **Model-aware reasoning budget.** ✅ **DONE** (2026-07-12, issue #1420 item #2). Slice B sends a
   `reasoning` map per class; it is now **sized relative to the resolved model's output cap** so reasoning
   can't starve the visible reply — the exact F-S4-D mechanism (thinking billed against the same budget as
   the answer). `token_policy.resolve_reasoning_max_tokens(output_cap)` computes it —
   `reasoning = min( clamp(0.5 × cap, 1024, 32000), cap − ceil(0.4 × cap) )` — reserving **≥40% of the cap
   for the reply always** (≥ half when the fraction binds), sized off the *tighter* of the explicit
   per-request/admin cap and the model default. `llm_core._apply_reasoning_budget` attaches it as the
   OpenRouter unified `reasoning.max_tokens` beside the ratified `effort`. The Anthropic `max_tokens`
   fallback (the #481 4096→8192 stopgap) is folded into `token_policy.resolve_output_cap(model)` (a
   per-family table + 8192 floor); `llm_core._model_max_output_tokens` is a thin delegate. No number
   reaches the player. Gate: `tests/test_adr0010_{token_policy,reasoning_budget}.py`.
   *(Extends Slice B; supersedes the #481 constant.)*
3. **In-season "which cap is biting" capture.** Slice A records the full envelope; add the **applied
   `max_tokens`** (the cap actually sent) next to `outputTokens` and the `finish_reason` #481 emits, so a
   single in-season debug-bundle/ledger row answers *which* cap truncated a turn — provider default vs.
   the configured per-class cap vs. the Anthropic fallback — **without** a live repro. *(One field on the
   Slice-A `UsageEnvelope`/ledger; see §5.)*
4. **Truncation-affordance parity in chat mode.** The #481 `truncated` → `Continue ▸` affordance is
   **agent-mode only** (`agent_loop`); the non-agent chat path (`chat_routes`) receives the `finish` event
   but never converts it. Extend the same affordance to chat mode, or record the deliberate agent-only
   scope. *(Small FE follow-on; the game runs in agent mode, so non-blocking.)*



- **A — Meter once, at the boundary.** Extend the streaming usage parse (`llm_core.py:1654-1672`) to read
  the whole `usage` object — `prompt_tokens_details.cached_tokens`,
  `completion_tokens_details.reasoning_tokens`, `cost`, `cost_details` — and the non-streaming path to
  read `data["usage"]`. Carry it on the existing `usage` SSE event → `llm_trace` → a new Vault-free
  ledger (counts + class + cost + context-%, **no content**). Surface per-turn + per-game on an admin
  page, and raise a **configurable soft spend alert** (admin-only) off the per-game total. **No behavior
  change** — pure observability (the alert warns, never enforces).
- **B — Policy per class.** One resolver maps a call class to `{reasoning, max_tokens, caching,
  contextBudget}`. The call sites pass their class (narration vs. the auto-record/auto-deal extractions
  vs. casting vs. cast-authoring/zeitgeist) instead of bare `max_tokens`. The payload builder emits the
  `reasoning` map when the model supports thinking. Default-by-omission is forbidden — every class names
  its reasoning posture (narration = **medium** to keep the Thinking accordion; extraction off/minimal).
  The per-class reasoning budget is **surfaced in admin settings** and read per-request (no restart), so
  an operator retunes it live; the constants module supplies the defaults the settings override.
- **C — Cache-friendly order + tiered routing.** The system-prompt/moment-prompt assembly puts the stable
  prefix first and pushes per-turn variability (clock, `stateDelta`, the player's message) to the end, so
  the provider's prefix cache matches turn-to-turn. A stable `session_id` per canonical game session
  (0064) makes OpenRouter sticky-route from request #1. Routing is **tiered**: stickiness on every call;
  **prefer** cache-capable providers with fallbacks on by default; and **pin** to a cache-capable provider
  (no fallback) once a call's token count crosses the high-context threshold (shared with slice D), where
  a cache miss is most costly — small calls keep full availability, big calls buy a guaranteed hit.
- **D — Tier, don't truncate.** `compute_input_token_budget` gains a tier above the 48K lean cap: when a
  turn's needed context exceeds the lean budget and the model window is large, raise the budget toward the
  window (**~0.85 × window** ceiling) **before** `context_compactor` summarizes. Opt-in; default lean ⇒
  byte-identical budget + bill. Mandate #4 wins over cost, but only when needed and always metered (A).

## 5. Contracts (stack-agnostic)

```
capture:  UsageEnvelope = { inputTokens, cachedTokens, reasoningTokens, outputTokens,
                            cost, costDetails?, provider?, contextPercent,
                            appliedMaxTokens?, finishReason? }   (Vault-free; no content)
                            -- appliedMaxTokens + finishReason answer "which cap is biting" (follow-on #3)
class:    CallClass = narration | utility-extraction | casting | background-authoring
policy:   resolveTokenPolicy(class) -> { reasoning, maxTokens, caching, contextBudget }
                                       (reasoning per class is settings-backed; constants = defaults)
settings: admin-editable reasoning budget per call class (read per-request, no restart);
          soft-alert threshold; tiering ceiling (~0.85×window); high-token pin threshold
send:     OpenAI-compatible payload gains `reasoning` (per policy) on thinking-capable models
order:    prompt = [ stablePrefix (system+tools+static, byte-identical) ] ++ [ volatile (delta, turn) ]
route:    tiered — session_id always; prefer cache-capable + fallback; pin (no fallback) > pinThreshold
budget:   compute_input_token_budget(..., tier) -> lean default, escalate→~0.85×window before compaction
alert:    per-game cost > threshold -> admin-only soft alert (warn, no enforcement)
ledger:   per-turn token/cost record (admin-only surface); player surfaces show NO token/cost/context
flag:     token tiering (D) opt-in (default lean ⇒ byte-identical); meter (A) always on
```

## 6. Definition of Done

- `frontend/tests/test_adr0010_usage_meter.py` — a streamed response with a usage chunk yields an
  envelope including `cached_tokens`, `reasoning_tokens`, and `cost` (not just prompt/completion); the
  non-streaming path reads `usage` too.
- `frontend/tests/test_adr0010_vault_free_ledger.py` — the token/cost record carries **no** message
  content and no secret field; **no** player-facing surface exposes a token, cost, or context figure
  (the cost surface is admin-only); the per-game **soft spend alert** fires **admin-only** when the
  configured threshold is crossed, warns without enforcing, and never reaches a player surface.
- `frontend/tests/test_adr0010_token_policy.py` — each call class resolves its expected reasoning effort
  + output cap (narration = medium ≠ extraction off/minimal); the OpenAI-compatible payload for a thinking
  model carries the `reasoning` map per policy; no class is default-by-omission.
- `frontend/tests/test_adr0010_admin_reasoning_settings.py` — an admin edit to a call class's reasoning
  budget is **read per-request and applied to the next payload without a restart**; an out-of-range value
  is clamped to the policy bounds; the setting is admin-gated and never appears on a player surface.
- `frontend/tests/test_adr0010_cache_order.py` — two turns differing only in the player's latest message
  produce a **byte-identical** system-and-tools prefix; volatile content is last; a game session attaches
  a stable `session_id`.
- `frontend/tests/test_adr0010_provider_routing.py` — `session_id` is attached on **every** call; a call
  **above** the high-token pin threshold pins to a cache-capable provider with fallbacks **off**; a small
  call keeps fallbacks **on** (prefer-with-fallback).
- `frontend/tests/test_adr0010_context_tiering.py` — needed context above the lean budget on a large
  window escalates the budget toward the window (**~0.85×**) **before** compaction; the lean default is
  unchanged when the tier is off; no persisted detail is dropped.
- The full FE suite stays green (`cd frontend && python3 -m pytest tests/`), and the engine gate is
  untouched (no engine files change). Calibration neutrality is inherent: the engine never sees token
  policy; a fixed-seed guard asserts flipping effort/caching/budget leaves seeded outcomes byte-identical.

## 7. Dependencies & traceability

- Governed by: ADR **0010**; bounded by the Vault Wall (0001), anti-sycophancy, and non-degradation (#4).
- Builds on: ADR 0003 (lean context), ADR 0005 (open-set/FE authority), 0064 (canonical session →
  `session_id`), 0065 (the Vault-free per-turn ledger pattern, `orwell_sync_ledger.py`).
- Relates to: **PR #481** (truncated-reply `Continue ▸` affordance) — the tactical sibling; same root
  cause (DeepSeek reasoning billed against the visible-reply budget). Slice A records the
  `finish`/`finish_reason` signal #481 adds; slice B reduces how often truncation happens at all.
- Followed by: the §3 **Out** items (per-game hard caps / interrupting soft-stop; unconditional provider
  pinning) and the §3 **Tracked follow-ons** (the F-S4-D/PR #481 deeper items: runtime-editable output
  cap, model-aware reasoning sizing, the "which-cap-is-biting" envelope fields, chat-mode affordance
  parity).

## 8. Implementer handoff & resolved rulings

- **Build order A→D.** A is independent, zero-behavior-change, and unblocks tuning B/C/D against real
  numbers — ship it first and observe a few real games before sizing the rest.
- **Slice A is the "watch the context window" ask** — it's worth shipping alone even without B–D.
- **Keep the Thinking accordion fed.** Narration must keep emitting a (lighter) reasoning trace; B dials
  effort to **medium**, never off, for the `narration` class (the FE renders it via `roundReasoningText`).
- **Admin-editable reasoning (owner req. 2026-06-21).** The per-class reasoning budget lands as an admin
  setting read per-request (the `default_model` / `settings.json` pattern — no restart); the constants
  module holds only the defaults the setting overrides. Admin-gated; never on a player surface.
- **Owner rulings ratified 2026-06-21** (see ADR 0010 *Owner rulings*): narration reasoning = **medium**;
  D = **opt-in**, escalate to **~0.85×window** before compaction; cost surface **+ a soft per-game spend
  alert now** (hard caps Phase-2); provider routing **tiered** (stickiness everywhere → prefer-with-
  fallback → pin no-fallback above the high-token threshold). **Open *tuning* only:** the per-provider
  effort mapping, the ~0.85 ceiling, the alert dollar threshold, and the pin threshold — all
  constants/settings, no contract change (§5).
