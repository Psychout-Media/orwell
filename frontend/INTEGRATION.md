# Vendored: Orwell — Orwell's player front-end + LLM/agent tier

## What this is

A vendored copy of **Orwell** (https://github.com/Psychout-Media/orwell, MIT —
see [`LICENSE`](./LICENSE) and [`ACKNOWLEDGMENTS.md`](./ACKNOWLEDGMENTS.md), retained intact).
Orwell is a self-hosted AI workspace: **Python (FastAPI) backend + vanilla-JS PWA**, with a
multi-provider LLM connection (Ollama, OpenAI, OpenRouter, Anthropic, llama.cpp, vLLM) and an
**agent** built on opencode / MCP.

We reuse it as Orwell's **player front-end + LLM-connection + agent tier** rather than building
those from scratch.

## Role in Orwell (polyglot, two tiers)

- **Orwell core** = the TypeScript hexagonal **engine** (`/src`) — game rules, the Vault, ports.
  Stays the single source of truth.
- **`frontend/`** (this) = a **Python service** — the UI + LLM connection + agent. Runs as its
  **own process**, separate from the Node engine.
- They meet over a **permissioned boundary** (below) — the MCP boundary the design always
  planned; the narrative LLM was always meant to sit behind a port.

## Quarantine (important)

`frontend/` is intentionally **outside** Orwell's TypeScript tooling — `tsconfig.json`
(`include: src, tests, features`), Vitest (`tests/**`), Cucumber (`docs/features`), and
dependency-cruiser (`src`) do **not** touch it. The Vault-Wall architecture test is unaffected.
Treat `frontend/` as a separate app with its own deps (`requirements.txt`, its own
`package.json`).

## MVP keep-set

**Chat UI + multi-provider LLM connection + agent (MCP/tooling).** The agent is the
integration linchpin — it's what drives the game.

## Integration plan (the refactor — next)

1. The Orwell engine exposes the game as a permissioned **MCP server**: `getVisibleStateFor`,
   `recordInteraction`, `runCompetition`, `surfaceInformationTo` (the tools in
   `CLAUDE.md` / the spec). These return **only visible-projection data**.
2. Point Orwell's agent (`routes/mcp_routes.py`, `mcp_servers/`) at that MCP server as a
   tool backend; the LLM narrates *Big Brother* by calling the engine tools.
3. **The Vault Wall holds by construction:** `frontend/` never imports `VaultStore` and only
   receives visible projections over the boundary — the model can't leak what it never gets.
4. Build the BB-specific surfaces (narrated scene view, Diary Room, house/houseguest panels)
   on top of the chat shell.

## Wired now: the game IS the main chat

The Big Brother game is folded into the **main chat** — there is no separate game page. The
standalone `/orwell` slice has been retired; onboarding and in-character play happen in the real
app, so they inherit its session, streaming, SSE sync, and provider plumbing for free.

- **`src/orwell_engine.py`** — thin async client to the engine's HTTP MCP player channel
  (`ORWELL_ENGINE_MCP_URL`, default `http://127.0.0.1:8765`): `createCharacter`, `getGameState`,
  `getMomentPrompt`. Consumes only Vault-free results.
- **`routes/orwell_routes.py`** — the onboarding + state seam: `GET /api/orwell/{health,state,moment}`
  and `POST /api/orwell/new-game` (runs OOBE). **No bespoke chat route** — chat is the main chat.
- **In-character main chat** — `routes/chat_helpers.py:build_chat_context` prepends the engine's
  **managed per-moment game-master system prompt** (`getMomentPrompt`) to the main chat's system
  message whenever a game is in progress. This is what makes every turn speak as the game master,
  across both the streaming and non-streaming paths (they share `build_chat_context`). Best-effort
  and Vault-free; if the engine is down the chat simply isn't framed (no disruption).
- **First-class onboarding** — `static/js/orwellOnboarding.js` overlays character creation in the
  main app when `GET /api/orwell/state` reports no active game; on submit it `POST`s
  `/api/orwell/new-game` and dissolves into the chat. It **fails open** (engine down → never blocks
  the chat).
- **Cross-device sync comes free** — because play is the main chat, the existing session +
  SSE sync (`session_events` / `sessionSync`) already covers a game session across devices.

### Try it

1. Run the **engine**: from the repo root, `npm run build && ORWELL_ENGINE_PORT=8765 npm start`.
2. Run **Orwell** (this app) and log in; ensure a **default chat model** is set in settings.
3. You'll be asked to **create your houseguest** before the chat; then just chat — every turn is
   in-character. Open the same account on a second device to see the session sync.

### Driving the game (agent action tools)

In **agent mode**, the model can also *act* on the game, not just narrate it — the engine's
Vault-free player tools are exposed as function-calling tools (`src/tool_schemas.py` +
`src/tool_implementations.py` + `src/tool_execution.py`, relayed via `src/orwell_engine.py`):

- **`getGameState`** — week/phase, the player card, the house roster (names only).
- **`runCompetition`** — the **engine** resolves a competition over the live house from its OWN
  hidden stats and returns only the winner's name (no stats/scores ever cross the wall). The model
  requests it, the engine decides — anti-sycophancy holds.
- **`recordInteraction`** — record a player-present scene as a game event (player knowledge).
- **`surfaceInformationTo`** — move a fact into the player's knowledge via a named in-game pathway.

The engine enforces the Vault Wall on every result, so the model can drive the game without ever
seeing secret state.

**Still managed by the engine, not here:** game state lives in the engine process (in-memory
today; persistence is feature 0007). The deep loop (competitions, nominations, votes driving the
phase/moment) is the engine's weekly-loop work (feature 0011) — the main chat picks up those
moments automatically as the engine advances them.

## What was trimmed (footprint only — no application code removed)

Removed to keep the repo lean; none of it affects chat/agent:
- demo media (`docs/*.gif|*.webm`), marketing docs (`docs/`, `ROADMAP`/`SECURITY`/`THREAT_MODEL`/`CONTRIBUTING`),
- deployment scaffolding (`docker/`, `docker-compose*`, `Dockerfile`, build/start/launch/install scripts, `*.service`, `.github/`),
- Orwell's own `tests/`,
- heavy document-export libs (`static/lib/{xlsx,docx,mammoth,html2pdf}*`).

The Python app and front-end JS are intact and coherent.

## Deferred: the deep code-level prune (do against a *running* Python env)

A leaner cut down to **just chat + LLM + agent** — dropping the email, calendar, contacts,
research, cookbook/hwfit, compare, documents/editor, gallery, notes, tasks, voice (tts/stt),
youtube, webhooks, search, shell, and memory/skills verticals (their `routes/` + `services/` +
`static/js/` + `app.py` wiring + `index.html` script tags) — is the next pass. Because it edits
the 1,111-line `app.py` and the front-end shell, it must be **verified against a running
instance** (Python deps installed, config set), not done blind.

## Running Orwell standalone (reference)

See [`README.md`](./README.md) and `requirements.txt` (FastAPI + uvicorn); `.env.example`
documents config. During the refactor we'll run it as the Orwell front-end service.

## The golden-path / visual-regression / theme gates (0108/0113/0114) — DECOMMISSIONED

The real-model **golden-path** record/replay gate (0108) and its two screenshot siblings that
rode the same committed fixture — the **visual-regression** harness (0113) and the
**theme-surface-consistency** gate (0114) — were **removed entirely** (owner directive,
2026-07-21). They were advisory / non-gating (excluded from `ci-gate.needs`), perpetually stale
(a fixture treadmill on every prompt/schema/casting-flow change), and hang-prone (#1713). The
committed fixture, the record/replay scripts + the `src/golden_path.py` seam, the harness scripts
and `src/visual_*` / `theme_probe` modules, the three CI jobs, `golden-nightly.yml`, and their
unit gates are gone. Live model-call flows (`llm_core.stream_llm_with_fallback` / `llm_call_async`)
are plain passthroughs again; nothing else depends on the removed seam.

## The responsive contract (Stream S — ruling #16; binding)

`static/css/responsive-tokens.css` (loaded **before** `style.css`) is the one responsive
mechanism. The rules, enforced by `tests/test_s_responsive_mechanism.py` (source gate) and
`scripts/responsive_matrix.py` (runtime gate, in CI):

- **Breakpoints are tokens**: every `@media` width is one of **480 / 768 / 1024 / 1440**
  (complements 481/769/1025/1441 for `min-width` pairs). Container tiers: **360 / 620**.
  Viewport queries are for *page chrome only* — anything draggable or dockable responds to
  `@container`.
- **JS never compares `innerWidth` to a literal** — use `isNarrow()` / `isBelowMedium()` /
  `onNarrowChange()` from `static/js/platform.js` (matchMedia-backed; kills the 768
  off-by-one that was written four different ways).
- **Type sits on the rem scale** (`--fs-2xs` … `--fs-xl`); the floor for any UI text is
  `--fs-2xs` (~11px). The root font is fluid (`clamp()`), so rem surfaces breathe and the
  density classes actually work; `text-size-adjust: 100%` is set.
- **Touch**: one `(pointer: coarse)` floor on `--tap-min` (44px height / 36px width) for
  buttons, role=button, selects, and settings tabs; `.tap-exempt` opts out.
- **Installed app**: real maskable icons (192/512 + 180 apple) are precached and asserted
  by the gate; the `display-mode: standalone` tier pads fixed chrome with
  `env(safe-area-inset-*)`. A vendored update must not regress the manifest/SW posture.
- **The matrix gate ratchets**: known failures live in `responsive_matrix.py`'s `XFAIL`
  registry keyed by finding ID; landing a finding removes its entry in the same PR.

## LLM-call observability (0112 — Vault-free trace tagging + opt-in forwarding)

Always-on production live-verify telemetry for the gap the stubbed gates leave open. Every LLM
call can emit a **Vault-free** `TraceRecord` (the 0069 token-ledger facts PLUS the 0065
`beatSeq`/`phase` correlation keys) and, when enabled, tag the OpenRouter request with those keys.
**Everything is opt-in, fail-soft, and byte-identical when unconfigured.**

- **Code:** `src/llm_trace.py` (record builder + request-metadata builder + settings + sampling +
  the `emit_trace` point), `src/trace_sink.py` (the `TraceSink` port — `NoopTraceSink` default,
  `OtlpTraceSink` for OTLP/Langfuse/JSON-over-HTTP), wired at the two `src/llm_core.py` traced
  chokepoints (`_llm_call_async_traced`, `_stream_llm_with_fallback_traced`).
- **Settings** (admin-editable, read per-request — no restart): `observability_enabled` (default
  **false**), `observability_endpoint` (""), `observability_privacy_mode` (`metrics-only` default |
  `full`), `observability_sampling` (0.0–1.0, deterministic by session; default 1.0).
- **Request metadata (OpenRouter Broadcast handshake):** when enabled, the OpenAI-compatible
  payload gains `metadata: { orwell_session, beatSeq, phase, call_class }` — all Vault-free. Enable
  **OpenRouter Broadcast** account-side (OpenRouter UI → pick destinations); zero shipper code, it
  forwards correlatable traces to any of its 18+ sinks. Absent ⇒ byte-identical payload.
- **Direct-ship path:** set `observability_endpoint` to an OTLP/Langfuse/JSON-over-HTTP sink and
  the `OtlpTraceSink` POSTs each record directly (provider-agnostic, self-hostable) — no reliance
  on OpenRouter's feature.
- **Vault Wall:** the record builder reads neither the Vault store nor the soul provider (the FE
  holds no Vault handle); a structural gate (`tests/test_0112_llm_observability.py`) asserts the
  record + metadata carry **no** Vault key. `metrics-only` (the default) forwards **no** prompt/
  completion content; `full` is an explicit operator opt-in, best paired with a self-hosted sink.
- **Self-hosted sink (opt-in, off by default):** `deploy/observability/docker-compose.yml` brings
  up Langfuse on-box so a private/LAN deploy (ADR 0014) keeps all trace data local — point
  `observability_endpoint` at it.
