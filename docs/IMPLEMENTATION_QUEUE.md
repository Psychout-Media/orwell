# Implementation queue — prompts for Claude Code & OpenHands

Dispatch these to implementer agents **in order** (respecting `depends on`). Items on different
tracks can run **in parallel** once their deps are met.

> 🎯 *(Stale — kept for the record; superseded by the "GitHub issue tracking" note below and the
> D1–D11 section header fix further down, which corrects this line's own self-contradiction —
> doc-drift audit, 2026-07-05: D1–D11 are DONE, not the dispatch point.)* **CURRENT DISPATCH
> POINT: the UI & runtime audit batch (D1–D11) at the bottom — everything before it is ✅ DONE.**
> *(Previous note, kept for the record:)* **The queue was drained (2026-06-10).** Every item in this file — through the product-audit
> batch (B34–B60 / C12–C18), the front-end & experience batch (B61–B66 / C19–C28), the
> operations/security/test-integrity batch (B67–B72 / C29–C33), the casting interview (B73), and
> the pre-audit feature drafts (0042/B31 · 0043/B32 · 0044/B33) — is **✅ DONE**, each marked with
> its verifying artifact. The whole file is now the work record. **New work starts as a new spec
> in `docs/features/` + a new item appended here**; the only known deferrals are listed in
> `CLAUDE.md` → "Remaining work" (0022 MVP-2, the Proxmox host smoke, the real relational/vector
> adapters, full MCP/JSON-RPC).
>
> **GitHub issue tracking (added 2026-06-23):** this file is a historical work record (the B/C/D/U/L
> lanes are ✅ DONE). New and remaining open work is now tracked as **GitHub issues** (labelled
> `type:*` / `area:*`), not appended here — e.g. the Proxmox host smoke → [#577](https://github.com/Psychout-Media/orwell/issues/577).
> The finding-code → issue map for the audit ledgers lives at the top of `ROAST-LOG.md`.
>
> **2026-07-06 closure session (18 PRs, not tracked in this file):** per the note above, this
> session's work — the last three spec-only builds (0094 scoped/0095/0096), 0101/0102, and a
> security/a11y/machinery-leak/engine-mandate-safety/deploy-ops sweep from the
> `docs/audits/2026-07-03-final-pre-ship-audit/` lanes — is recorded in
> `docs/audits/2026-06-10-full-product-audit.md`'s 2026-07-06 ledger entry and
> `docs/audits/2026-07-06-closure-session.md`, not appended here (this file's own convention, per
> the note above, is GitHub issues + the audit ledger for anything after 2026-06-23). No item
> below references any of that session's PR numbers.

**Agent split (suggested, not strict):**
- **Claude Code → the TypeScript engine** (`src/`) — it has built the hexagonal core.
- **OpenHands → the Python front-end** (`frontend/`, vendored Orwell).

**Every prompt assumes these house rules** (state them if the agent is fresh): read `CLAUDE.md`
and the named `docs/features/*` spec first; the **Vault Wall is structural** — no outward module
imports `VaultStore`/`VectorIndex`, and `npm run test:arch` (dependency-cruiser) must stay green;
**BDD/TDD-first** — the `.feature` files are the source of truth, make them green; **name-agnostic
tests** (roles only); keep `npm test` green; commit on a feature branch and **open a PR**.

> ⚠️ **Adjustments to already-built specs — pick these up.** See the
> [Amendments table in `docs/features/README.md`](features/README.md#amendments-to-shipped-specs-implementer-pick-these-up).
> *(The 0004 appearance-fields and 0023 durability rows there are **satisfied — implemented**;
> check the table for any newer, still-open amendments before starting work.)*

> 📸 **2026-06-20 — 0065 photo-first OOBE (engine ✅ done):** the cast photo is now casting **step #1**
> — `castPhoto` (`"uploaded"`/`"skipped"`) is the FIRST `CASTING_COVERAGE` entry, engine-driven and
> OPTIONAL (never gates casting `ready`; `createCharacter` finalizes either way). See the 0050
> [Amendment (0065)](features/0050-casting-interview.md#amendment-0065--the-cast-photo-is-the-first-casting-step-photo-first-oobe).
> The FE Python relay + in-chat photo box build to the same `castPhoto` contract (sibling work).

## Dispatch strategy — HISTORICAL (2026-06-08; complete — dispatch from the audit batches at the bottom)

**State as of 2026-06-08 (since superseded — C8/0032 shipped):**
- **Engine: 0001–0031 are Done.** The consequence loop (0023), soul recall (0024), per-user sandboxes
  (0021), reserve twists (0025), the streaming narrator (0027), durable persistence (0030), relationship
  + temperature constants (0026/0028), and now the **runtime orchestrator/integrity watcher (0031)** are
  all green. **The engine core is complete** — only maintenance + future specs remain.
- **Front-end: the game wiring + accounts tier are live** — onboarding/`X-Orwell-User`, the agent lever
  tools (C6), 0020 player UX (C4), and app admin (0029/C7) have all shipped. **One item remains:**
  **C8 — 0032 surface reduction** (prune the vendored workspace down to the game build).
- **C5 / 0004 appearance / C6 / C4 / C7 are complete.**

Two lanes — **Claude Code = engine (`src/`)**, **OpenHands = front-end (`frontend/`)**. The engine lane
is now drained; the active front-end work is the prune.

| Wave | Claude Code (engine) | OpenHands (front-end) |
|---|---|---|
| **1 — now** | *Engine core complete* — no queued feature. Maintenance, future specs, and any review follow-ups. | **C8** (0032 surface reduction) — reduce the front-end to the **game build**: flag-gate + **server-side 404** every dropped vertical (incl. the live **shell** endpoint), drop front-end memory/RAG, prune Settings tabs, behind one **`ORWELL_GAME_BUILD`** switch; then stop shipping the dropped JS; then delete it (deletion tier **verified on a running instance**). Keep **voice** off-by-default. |
| **after** | Future specs as drafted (jury choreography, MVP-2 engine bits, new product calls). | MVP-2 (0022) un-parks once MVP-1 is solid. |

**Coordination rules**
- **Stay in lanes** (engine `src/` vs front-end `frontend/`); don't cross-edit the other's files.
- **0032 is front-end-only** — it must **not** touch `src/` or `cucumber.cjs`; the engine gate
  (`npm test` / `npm run test:arch`) must stay **unaffected** (the front-end is quarantined).
- **0032 tier order:** Tier 1 (flag-gate + 404) → Tier 2 (stop shipping JS) → Tier 3 (delete code).
  Tiers 1–2 go green in CI (`pytest`); Tier 3's DoD is a **documented run on a live instance** (boots,
  onboards, plays a turn, portraits render, accounts/admin work) per `frontend/INTEGRATION.md`.
- **First move (historical):** OpenHands → **C8** — since shipped. (This block is the 2026-06-08
  record; the live dispatch point is the audit batches at the bottom.)

*(The full per-item prompts are below.)*

## Order & assignment

| # | Item | Agent | Depends on |
|---|---|---|---|
| A1 | Engine **HTTP MCP transport** | Claude Code | — (McpServer + build/start exist) |
| B5 | Implement **0017 relationship model** | Claude Code | — (`relationships.ts` seam exists) |
| B1 | Implement **0011 weekly loop** | Claude Code | B5 reads it (seam already exists) |
| A2 | **Orwell → engine MCP** client + game driver | OpenHands | A1 |
| B2 | Implement **0012 conversation** (engine side) | Claude Code | B1 |
| B3 | Implement **0013 Diary Room** | Claude Code | B2 |
| B4 | Implement **0014 jury & endgame** | Claude Code | B1, B5 |
| B6 | Implement **0015 OOBE** (engine side) | Claude Code | — (0004 done) |
| B7 | Implement **0016 God Mode / admin** | Claude Code | — (0001 done) |
| C1 | **BB player surfaces** in Orwell | OpenHands | A2, B2 |
| C2 | **OOBE authoring UI** in Orwell | OpenHands | A2, B6 |
| A3 | **Deploy smoke test** | either | A1, A2 |

A1 + B5 start immediately in parallel (one per agent). A2 unblocks the whole front-end track.
**B5 (relationship model) is foundational** — do it early; B1 and B4 read it. B6/B7 are
independent of the gameplay chain (their deps are already green) and can slot into any free
Claude Code slot.

## Progress (this session — onboarding vertical slice)

A first end-to-end slice fixing "no onboarding past account creation" and "the model answers as
a generic assistant" is **landed** (engine tested green; front-end bridge wired):

- **A1 — HTTP MCP transport:** ✅ confirmed present (`HttpMcpServer.ts`); engine port aligned to
  `ORWELL_ENGINE_PORT` (8765) to match the deploy/front-end contract.
- **B6 — engine OOBE:** ✅ exposed as Vault-free player tools `createCharacter` / `getGameState`,
  plus `getMomentPrompt` (managed per-moment system prompt). Tested (unit + HTTP + sentinel/arch).
- **A2 / C2 — front-end:** ✅ first slice — `/orwell` page (character creation → house → in-character
  chat) + `routes/orwell_routes.py` + `src/orwell_engine.py`; chat injects the engine's moment prompt
  via Orwell's own `resolve_endpoint`/`llm_call_async`. See `frontend/INTEGRATION.md` → "Try it".

Remaining on these: deeper agent/tool-calling integration (let the LLM *call* engine action tools,
not just narrate), surfacing `/orwell` from the main nav/landing, and the weekly-loop moments
(feature 0011) that will advance phase/moment automatically.

---

## Prompts

### A1 — Engine HTTP MCP transport  ·  Claude Code

> In `Psychout-Media/orwell` (TypeScript engine), implement an **HTTP MCP transport** that exposes the
> existing `McpServer` (`src/adapters/mcp/McpServer.ts`) over HTTP per the MCP spec (JSON-RPC, with
> SSE for streaming). Requirements: listen on **`ORWELL_ENGINE_PORT`** (default 8765, loopback by
> default); be started by **`npm start`** (build/start already exist); mount **only** the
> per-channel allowlist via `toolsFor(channel)`; **never** add a Vault-reading tool. Read
> `CLAUDE.md` and `docs/features/0009-mcp-tool-boundary.md` first. Keep the Vault Wall: the
> transport module must not import `VaultStore`/`VectorIndex`/the engine root — `npm run test:arch`
> stays green. Add tests: an MCP client lists tools and calls each over HTTP and never receives
> Vault data (extend the sentinel/architecture tests). Keep `npm test` green. Open a PR.

### B1 — Implement 0011 weekly loop  ·  Claude Code

> In `Psychout-Media/orwell`, implement feature **0011** (`docs/features/0011-weekly-loop-orchestration.{md,feature}`)
> in the **pure domain core**: the weekly phase state machine (HOH → nominations → veto → veto
> ceremony → eviction → repeat) and the season → Final 2 → jury vote → winner. NPC decisions are
> **relationship-driven** (use the existing `src/engine/relationships.ts`); player decision points
> are surfaced and **validated against feature 0005**; jury = the last 9 evictees; last-juror
> tie-break. Pure + **seed-deterministic**. Make the `0011` `.feature` green and keep all gates
> green. Read `CLAUDE.md` first. Open a PR.

### A2 — Orwell → engine MCP client + game driver  ·  OpenHands

> In `Psychout-Media/orwell`, wire the vendored **Orwell** front-end (`frontend/`, Python FastAPI +
> agent) to drive a *Big Brother* game through the engine's **MCP server**. Read
> `frontend/INTEGRATION.md`, `docs/features/0009-mcp-tool-boundary.md`, and
> `docs/features/0012-conversation-and-scene-system.md`. Tasks: (1) register the engine MCP server
> (URL from env **`ORWELL_ENGINE_MCP_URL`**) as a tool backend for Orwell's agent — it already
> supports MCP (`frontend/routes/mcp_routes.py`, `frontend/mcp_servers/`); (2) add a "Big Brother"
> game session where the agent drives play by calling the engine tools (`getVisibleStateFor`,
> `renderScene`, `recordInteraction`, `resolveCompetition`, `surfaceInformationTo`) and Orwell's
> existing LLM connection (Ollama/Anthropic) **narrates** the returned, Vault-free context;
> (3) **hybrid** interaction — free-text social play, but binding decisions (nominate / veto /
> vote) are explicit, validated tool calls. **Hard constraint:** the front-end consumes **only**
> what the MCP tools return — it never reaches the engine's Vault. Done when: from the Orwell UI
> you start a game, get narration, take a turn, and no Vault data appears. Open a PR.

### B2 — Implement 0012 conversation (engine side)  ·  Claude Code

> In `Psychout-Media/orwell`, implement the engine side of feature **0012**
> (`docs/features/0012-conversation-and-scene-system.{md,feature}`): `recordInteraction` (scenes as
> witnessed events — player-present = player knowledge, per 0002), a **`socialRead`** player tool
> (joins the registry with `readsVault: false`; honest, Vault-free, may hint but never names
> off-screen events), and **explicit decision validation** (binding choices go through a validated
> path, never parsed from prose; illegal choices rejected per 0005). NPC dialogue must be
> constrained to what that NPC legitimately knows (0002). Make the `0012` `.feature` green; gates
> green. Open a PR.

### B3 — Implement 0013 Diary Room  ·  Claude Code

> In `Psychout-Media/orwell`, implement feature **0013** (`docs/features/0013-diary-room.{md,feature}`):
> the player DR is OOC, its content is player knowledge tagged **`NO_NPC_PATHWAY`**, and
> `deriveNpcKnowledge` must **exclude** it (no NPC ever learns DR content); honor the public/private
> gap (NPCs act on public speech, never the DR); NPC confessionals are **Vault-only** and never
> surface (sentinel-clean). Make the `0013` `.feature` green; gates green. Open a PR.

### B4 — Implement 0014 jury & endgame  ·  Claude Code

> In `Psychout-Media/orwell`, implement feature **0014** (`docs/features/0014-jury-and-endgame.{md,feature}`):
> jury = last 9 evictees; **jury management** shapes votes (relationship + eviction manner); Final 2
> choreography (statements, one question per juror); the **engine decides** the vote (LLM only
> voices), jury-management-dominant with a tunable finale weight; most votes wins, last-juror
> tie-break. Make the `0014` `.feature` green; gates green. Open a PR.

### C1 — BB player surfaces in Orwell  ·  OpenHands

> In `Psychout-Media/orwell` `frontend/`, adapt Orwell's chat shell into the *Big Brother* player
> experience: a **narrated scene** view, the **hybrid decision prompts** (nominate / veto / vote
> over the legal option set returned by the engine), a **Diary Room** panel, and a
> **house / houseguest** view. Consume **only** MCP tool data (visible projection) — never the
> Vault. Keep the existing chat/LLM/agent plumbing. Open a PR.

### A3 — Deploy smoke test  ·  either

> In `Psychout-Media/orwell`, add an **install smoke test** for `deploy/`: provision a container (a real
> Proxmox LXC, or a Docker/Debian stand-in for CI), run `deploy/orwell-install.sh`, assert the UI
> responds on `ORWELL_PORT`, run `deploy/orwell-update.sh`, and assert `/opt/orwell/data` survived.
> Document how to run it on a real Proxmox host. Open a PR.

### B5 — Implement 0017 relationship model  ·  Claude Code

> In `Psychout-Media/orwell`, implement feature **0017** (`docs/features/0017-relationship-model.{md,feature}`),
> promoting `docs/decisions/0002-relationship-model.md` into the pure domain core (build on the
> existing `src/engine/relationships.ts`). Relationships are **directed, graded, asymmetric edges**
> (trust / affinity / threat / alignment / reliability / confidence) **computed from event history**
> through the holder's `Character` framing — **never** a binary ally/enemy flag, and **no label is
> ever persisted**. Fix the *shape* per the spec (recency-weighting, **betrayal-shock**, **decay**,
> rising confidence with data, dispositional labels); the **numbers are tunable config** alongside
> the temperature constants (0006). Wire the consumers: Houseguest's Choice (0005), targeting via
> `threat`, jury lean (feeds 0014). Pure + **seed-deterministic**. Make the `0017` `.feature` green;
> keep all gates green (esp. that the serialized soul holds signals+history but **no label** — ties
> 0007). Read `CLAUDE.md` first. Open a PR.

### B6 — Implement 0015 OOBE (engine side)  ·  Claude Code

> In `Psychout-Media/orwell`, implement the engine side of feature **0015**
> (`docs/features/0015-character-creation-oobe.{md,feature}`): `runPlayerOOBE(input)` — validate the
> input, reject incomplete profiles, and produce the player's **static `Character`** + **initial
> `Soul`** (emotional baseline + volatility, empty memory, **no** relationship beliefs); then seed
> the house **around** the authored player via `generateHouse(seed, player)` keeping the curated
> ensemble (0004). **Anti-sycophancy is the crux:** the player's P/M/S aptitudes must fall **within
> the same bounds as the NPCs** — no self-min-maxing (ship §9 option **A**, derived/balanced, unless
> told otherwise); the player carries **no** outcome guarantee (0006). The player's authored private
> strategy is player knowledge tagged **`NO_NPC_PATHWAY`** (0013) — no NPC starts knowing it. OOBE
> is OOC (no witnessed event). Make the `0015` `.feature` green; gates green. Read `CLAUDE.md` first.
> Open a PR.

### B7 — Implement 0016 God Mode / admin  ·  Claude Code

> In `Psychout-Media/orwell`, implement feature **0016** (`docs/features/0016-god-mode-admin.{md,feature}`),
> extending the existing `src/surfaces/admin/AdminPort.ts` and the `ADMIN_TOOLS` allowlist. Add
> useful **non-Vault** admin capability — `overrideMechanic`, `configure` (tunable constants +
> reserve-twist **count**, never content), `manageSandbox` (create/reset/save/load this sandbox) —
> while keeping the **Vault Wall on the admin surface**: no admin module imports `VaultStore`/
> `VectorIndex` (extend the dependency-cruiser rule to `surfaces/admin`), every `ADMIN_TOOLS` entry
> stays `readsVault: false`, and admin output is **sentinel-clean** (extend the 0001 canary to the
> admin surface). Enabling reserve twists must **not** reveal their content/timing to the admin
> (Vault-sealed, 0005). Make the `0016` `.feature` green; gates green. Read `CLAUDE.md` and
> `docs/features/0001-vault-wall-isolation.md` first. Open a PR.

### C2 — OOBE authoring UI in Orwell  ·  OpenHands

> In `Psychout-Media/orwell` `frontend/`, add the **character-creation (OOBE) flow** to the Orwell UI:
> a first-run, out-of-character intake that collects the player's identity, backstory, public
> persona, archetype lean, and private strategy, validates required fields, and calls the engine's
> OOBE entrypoint (via the MCP client from A2) to author the player and start a new save. Consume
> **only** what the engine returns; the UI never sets the player's stats directly (the engine
> balances them — anti-sycophancy). Keep the existing chat/LLM/agent plumbing. Open a PR.

---

## Batch 2 — features 0015–0020, in build sequence

0011–0014 + A1 are **built**; the **rename** (BBAI→Orwell) and the **"Orwell IS the game" fold**
are in flight (their own prompts, given separately). This batch finishes the gameplay + player
experience. Build in this order — two agents in parallel where deps allow:

| Step | Item | Agent | Depends on |
|---|---|---|---|
| 1 | **B5** — 0017 relationship model | Claude Code | — (foundational; 0014/0019 read it) |
| 2 | **B8** — 0018 moment orchestration | Claude Code | 0011/0008/0009 (done) |
| 3 | **B6** — 0015 OOBE  +  **B9** — 0004 appearance amendment | Claude Code | 0004; pair B6+B9 (same factory) |
| 4 | **B7** — 0016 God Mode | Claude Code | 0001 (done) — slot anytime |
| 5 | **B10** — 0019 engine decision seam | Claude Code | B5, B8, 0011/0005 |
| 6 | **C3** — 0019 agent play loop | OpenHands | B10 + the fold + 0012 |
| 7 | **B11** — 0020 engine (status + portrait descriptor) | Claude Code | B9 |
| 8 | **C4** — 0020 player UX (panel + decisions + portraits) | OpenHands | B11, C3 |

Claude Code runs the engine track (B5 → B8 → B6/B9 → B7 → B10 → B11); OpenHands picks up C3 once
B10 lands, then C4 once B11 lands. **B5/B6/B7 prompts are above; the new ones (B8–B11, C3–C4):**

### B8 — 0018 narrative & moment orchestration  ·  Claude Code

> In `kevinhirsch/bbai`, implement feature **0018** (`docs/features/0018-narrative-moment-orchestration.{md,feature}`)
> in the engine, promoting the existing `src/engine/momentPrompts.ts` + the `getMomentPrompt` tool
> into a tested spec. The **engine owns the moment** — derive it deterministically from the
> phase/schedule (0011/0008); the narrator can't change it. The managed `MOMENT_PROMPTS` registry
> is the single place for per-moment fragments; the composed prompt = base game-master persona +
> moment fragment + **Vault-free** context (player card + house names + phase). Persona/framing
> ONLY — never the Vault Wall. Make `0018` green: every moment's prompt is **sentinel-free** under a
> fully populated Vault (extend the 0001 canary to `getMomentPrompt`); the moment tracks the engine
> phase; the base persona forbids generic-assistant output; the context carries no stats/souls/
> archetypes/hidden. Keep all gates green. Open a PR.

### B9 — 0004 appearance amendment  ·  Claude Code

> In `kevinhirsch/bbai`, fold the **0004 amendment** into the built `CharacterFactory`
> (`src/engine/characterFactory.ts`): generate **public appearance/identity** fields (appearance,
> approximate age, presentation/style) into the static `Character`, seeded, internally consistent
> with the archetype, **seed-stable** (part of the byte-stable baseline, 0007), and carrying **no**
> P/M/S aptitude or hidden data. These are the Vault-free facets the portrait descriptor (0020)
> reads. Make the new `0004` appearance scenario green (see `docs/features/0004-replayability-and-naming.md`
> §8); keep all gates green. Best paired with **B6** (0015 OOBE) since both touch the factory. Open a PR.

### B10 — 0019 engine decision seam  ·  Claude Code

> In `kevinhirsch/bbai`, implement the **engine** side of feature **0019**
> (`docs/features/0019-agent-driven-play-loop.{md,feature}`): a Vault-free decision seam the agent
> drives — `pendingDecision(state) -> { kind, options[] } | none` returning the engine's **legal**
> option set (per 0011/0005), and `executeDecision(kind, choice)` that **validates** and applies a
> binding choice (rejecting illegal/ineligible per 0005), exposed as player-channel tools
> (`readsVault: false`). Binding state changes happen **only** through this path — never parsed
> from prose; the engine decides outcomes (0006/0011/0014), the agent only voices. Much of
> `pendingDecision`/advance likely already exists in the 0011 weekly loop — reuse it. Make the
> engine-side `0019` scenarios green; gates green. Open a PR.

### B11 — 0020 engine: status + portrait descriptor  ·  Claude Code

> In `kevinhirsch/bbai`, implement the **engine** bits of feature **0020**
> (`docs/features/0020-player-experience.{md,feature}`): a Vault-free **`gameStatus()`** projection
> for the status panel — `{ week, phase, hoh, nominees[], veto: { holder, used } }`, public
> ceremony-level facts only (no hidden votes/targeting), as a player-channel tool
> (`readsVault: false`); and **`portraitDescriptorFor(houseguest)`** — a Vault-free descriptor
> built from `character.md`'s **public appearance facets** (the B9 amendment), excluding aptitudes,
> hidden elements, and `Soul`/Vault. Both **sentinel-clean** under a populated Vault (extend the
> 0001 canary). Make the engine-side `0020` scenarios green; gates green. Depends on **B9**. Open a PR.

### C3 — 0019 agent play loop  ·  OpenHands

> In `kevinhirsch/bbai` `frontend/`, implement the **agent turn-loop** of feature **0019** in
> orwell: the agent drives each turn by calling the engine's Vault-free tools — read visible state,
> narrate the moment (inject `getMomentPrompt`, 0018), and when `pendingDecision` returns options,
> present them and execute the player's binding choice via the validated `executeDecision` (B10).
> **Hybrid input:** free-text social play flows in the chat (recorded as witnessed events, 0012)
> and never makes a binding decision; only the validated path does. The agent **never** invents
> outcomes — it voices what the engine returns. Consume only Vault-free tool data. This runs inside
> the "Orwell IS the game" fold (the game is the main chat). Open a PR.

### C4 — 0020 player experience (MVP-1)  ·  OpenHands

> In `kevinhirsch/bbai` `frontend/`, build **player experience MVP-1** (feature 0020) in orwell: a
> light always-visible **status panel** fed by `gameStatus` (week/phase, HOH & nominees, veto
> status — public only); **inline quick-buttons** for binding decisions rendered from the engine's
> **legal** option set (`pendingDecision`) and executed via the validated path (never typed prose);
> and **photo-style portraits** per houseguest, rendered by orwell's existing image-gen pipeline
> from the engine's **`portraitDescriptorFor`** (B11) — public facets only. Everything shown is
> Vault-free; **"your own standing" stays in narration, not the HUD**. Depends on **B11** + **C3**.
> Open a PR. *(MVP-2 — the rich game UI, feature 0022 — is **deferred**; MVP-1 is being refined.)*

### B12 — 0021 engine: per-user sandbox registry  ·  Claude Code

> In `Psychout-Media/orwell`, implement the **engine** side of feature **0021**
> (`docs/features/0021-game-session-and-save-lifecycle.{md,feature}`): turn the single in-memory
> game into a **per-user sandbox registry** — `sandboxFor(user) -> GameSession` (created on first
> use) — and route **every** player/admin MCP tool call to the asserting user's sandbox (the MCP
> layer resolves the user identity the front-end asserts). **One active game per user**
> (`createCharacter` replaces that user's own game); **unlimited users concurrently**, each fully
> isolated. **Cross-user isolation is the crux:** no call on behalf of user A may return any of
> user B's state — add a **cross-user sentinel test** (mirror the 0001 Vault canary on the user
> axis: seed A's game with sentinels, assert none appear in any of B's tool outputs, and vice-
> versa). The Vault Wall (0001) must still hold inside each sandbox; `npm run test:arch` stays
> green. Make the `0021` engine scenarios green; gates green. **Do this early** — it reshapes the
> sandbox seam, cheaper before more engine work piles on. Read `CLAUDE.md` (sandbox model) first.
> Open a PR.

### C5 — 0021 front-end: assert the authenticated user  ·  OpenHands

> In `Psychout-Media/orwell` `frontend/`, make the front-end **assert the authenticated user identity**
> to the engine on every engine MCP call (the engine binds loopback and keys a sandbox per user —
> B12). Use the already-authenticated account (`request.state.current_user`) as the sandbox key;
> never let one account act as another. Each user sees only **their** game — the chat is their
> window. Done when two logged-in users each get their own isolated game and neither can see the
> other's. Depends on **B12**. Open a PR.

### C6 — Tight, lever-complete system prompts  ·  OpenHands (+ Claude Code)  ·  **HISTORICAL — shipped (was "START NOW")**

> In `Psychout-Media/orwell`, make the game agent able to **access and pull every engine lever**. The
> engine's game-master prompt (`src/engine/momentPrompts.ts`, 0018) is already a **tight operating
> manual** that names the levers and says the engine decides outcomes; this closes the gaps around
> it. **Ready part — do now:** the drift test (3) and exposing the two levers that already exist —
> `getVisibleStateFor`, `socialRead` — in (1). The decision levers (0019) and `gameStatus` (0020)
> get exposed as they land (the drift test forces it). Steps:
> 1. **Front-end — expose the full lever set as agent tools.** `frontend/src/agent_tools.py`
>    (`TOOL_TAGS`) + `frontend/src/tool_schemas.py` currently expose only `getGameState`,
>    `runCompetition`, `recordInteraction`, `surfaceInformationTo`. Add the rest the agent should
>    drive — `getVisibleStateFor`, `socialRead`, and (as they land) `pendingDecision` /
>    `executeDecision` (0019) and `gameStatus` (0020) — each as a clean function schema so the
>    model knows **how to access** every lever.
> 2. **Front-end — inject the lever-aware prompt.** Confirm `frontend/routes/chat_helpers.py`
>    injects the engine's `getMomentPrompt` (0018) as the system message on every game turn.
> 3. **Engine — keep the manifest honest.** Mark which `registry.ts` entries are **agent levers**
>    (e.g. an `agentLever: true` field on the game-driving read/action tools — not infra like
>    `getMomentPrompt`/`endOfSessionSummary`), then add a test that **fails if any agent-lever tool
>    is missing from the base prompt's manifest**, so the prompt and the registry never drift.
> Done when the model reliably reads state, resolves comps, records scenes, surfaces info, and
> takes binding decisions **through the engine** — and never invents an outcome. Read
> `docs/features/0018-narrative-moment-orchestration.md` first. Open a PR.

### B13 — 0023 consequence & memory (the live loop)  ·  Claude Code  ·  **TOP MVP-1 PRIORITY**

> In `Psychout-Media/orwell`, implement feature **0023**
> (`docs/features/0023-consequence-and-memory.{md,feature}`) — the MVP-1 backbone, currently the
> biggest gap. **Wire the live game** so player actions have consequences and the house remembers.
> Today `GameSessionAdapter` holds only house+week+phase and `recordInteraction` just logs — change
> that:
> 1. **Apply.** The live game holds a persistent **relationship/soul** state (use
>    `src/engine/relationships.ts`); `recordInteraction` and competition results / votes **fold
>    their hidden impact into it** (a betrayal drops trust + raises threat, etc.). The player's
>    actions change how NPCs feel about them — on the **live** path, not just `simulation.ts`.
> 2. **Hide.** The shift lives in the Soul/Vault and **never** surfaces — extend the 0001 sentinel
>    canary: no opinion number or "their opinion changed" text on any player surface.
> 3. **Persist all event details + derived state to LONG-TERM memory** — wire the real store
>    (`SaveStore`/SQLite per 0007) to the live session; lossless + monotonic (no thinning); survives
>    a process restart.
> 4. **Recall** the full history + hidden state on load — a **superset**, never a reset.
> Make the `0023` `.feature` green (add it to `cucumber.cjs`); keep all gates green. Two impl forks
> (0023 §8) are yours to pick — the tests are agnostic to both. Read `CLAUDE.md` (non-degradation
> mandate) and `docs/features/0002/0007/0017` first. Open a PR.

### B14 — 0024 soul storage & memory recall (md + vector)  ·  Claude Code  ·  **pairs with B13**

> In `Psychout-Media/orwell`, implement feature **0024**
> (`docs/features/0024-soul-storage-and-memory-recall.{md,feature}`): the dynamic `Soul` as a
> **markdown narrative** + an **engine-only vector index**, behind `SoulProvider`, with
> **semantic recall**. `recall(hg, context, k)` returns the *k* semantically-most-relevant past
> memories (use an **`EmbeddingProvider` with a deterministic fake** so recall is testable + seed-
> deterministic — a query about "the veto betrayal" recalls *that* memory, not the most recent
> chat). Recall feeds **both**: it **weights the relationship read** (0017) by relevant history, and
> it **gives the narrator** a specific recalled memory. **Boundary:** the `VectorIndex`/full soul are
> **engine-only** — extend the dependency-cruiser rule so no outward module imports them (exactly
> like `VaultStore`); player-facing recall output is **sentinel-clean** and pathway-filtered (0002).
> The soul **deepens monotonically** (0007); `Character` stays byte-stable. Make `0024` green; gates
> green. **Pairs with B13** (0023 records to the soul + calls recall) — do them together. Open a PR.

### B19 — 0030 durable game persistence (survive restart)  ·  Claude Code  ·  **TOP PRIORITY (bugfix)**

> In `Psychout-Media/orwell`, implement feature **0030**
> (`docs/features/0030-durable-game-persistence-survive-restart.{md,feature}`). **Why it's urgent:**
> the live game holds all state in memory — `GameSessionAdapter` (`house/week/phase/ceremony` fields)
> and `GameSessionRegistry` (a plain `Map`) — and the only `SaveStore` is in-memory, so **every
> engine restart wipes all games**, `GET /api/orwell/state` returns `started:false`, and the
> front-end "Welcome to the house" overlay **re-fires on every load** (user-reported). Fix it by
> wiring **durable** persistence into the LIVE path, reusing the built **0007** `GameState`/`SaveStore`
> contract: (1) add a **disk-backed `FileSaveStore`** (engine-only adapter, per-user JSON under
> `ORWELL_DATA_DIR`) behind the existing `SaveStore` port; (2) add `snapshot(): GameState` /
> `restore(state)` to `GameSessionAdapter` (lossless live-house round-trip — player, NPCs, souls,
> ceremony, week/phase) using the same export/import the off-screen sim already uses; (3) give
> `GameSessionRegistry` a `SaveStore` so `sandboxFor(user)` **loads** a user's latest save into the
> sandbox and every mutating tool (`createCharacter`, `recordInteraction`, `runCompetition`, ceremony
> updates, consequence folds) **saves** afterward. Preserve **0007** co-versioning + non-degradation,
> **0021** per-user isolation **across restart**, and the Vault Wall on the reloaded state
> (dependency-cruiser stays green; the file store is engine-only). Make `0030` green (central test:
> a **new registry over the same store** recalls a `started:true` game → onboarding stops firing);
> gates green. Read `docs/features/0007`, `0021`, `0023` first. Open a PR.

### B15 — 0025 reserve twists (Vault-sealed)  ·  Claude Code

> In `Psychout-Media/orwell`, implement feature **0025**
> (`docs/features/0025-reserve-twists.{md,feature}`): a small curated pool of classic
> **non-structural** twists (secret power, double eviction, returning-juror battle-back) held in
> **reserve**. The engine, **seeded**, decides if/when one fires at a dramatic beat — **rare**, at
> most the admin-enabled count (0016). The chosen twist + timing are **Vault content**, sealed from
> **both** the player **and** the admin until it fires (extend the 0001 sentinel canary to *both*
> surfaces; cross-check 0016 §5 — enabling reveals neither content nor timing). On fire: record a
> **witnessed reveal event** (0002) + apply the mechanic. **Format-preserving:** the 0005
> eligibility invariants and the 16 → jury-9 → final-2 arc must hold **under** any twist. Make
> `0025` green; gates green. Read `docs/features/0001`, `0005`, `0016` first. Open a PR.

### B16 — 0026 relationship math (firmed update rule & constants)  ·  Claude Code  ·  **grounds B13**

> In `Psychout-Media/orwell`, implement feature **0026**
> (`docs/features/0026-relationship-math.{md,feature}`): firm 0017's shape into a concrete update
> rule + a **single tunable constants module** (sibling to the temperature/richness configs). The
> `apply` rule moves the signals by the per-type `IMPACT` (extend the existing
> `src/engine/relationships.ts` table) × **disposition factor** (from `Character`) × bounded
> **temperature**; **betrayal-shock** is a large single step that **decays slowly** (default
> **sticky/realistic** — the grudge lingers); decay/mean-reversion is **disposition-scaled**;
> confidence rises with data. **The feel is per-game, not global:** a paranoid cast trends sticky, a
> social cast forgiving, temperature varies it — with a **measurable spread across seeds** and
> reproducible by seed. **No number hard-coded outside the constants module** (retunable later, a
> future God-Mode knob). Make `0026` green; gates green. This **grounds B13** (0023's `apply()` uses
> these constants) — do it just before/with B13. Read `docs/decisions/0002` + `docs/features/0017`.
> Open a PR.

### B17 — 0027 NarrativePort LLM adapter  ·  Claude Code (+ OpenHands)

> In `Psychout-Media/orwell`, implement feature **0027**
> (`docs/features/0027-narrative-port-llm-adapter.{md,feature}`): the real async LLM behind
> `NarrativePort`, replacing `EchoNarrativePort`. Async `narrate` + `narrateStream` (token stream);
> **provider-agnostic** (Ollama / Anthropic / OpenAI-compatible) with model/endpoint/key from
> **env** (no secrets in code); **timeout + bounded retries + safe fallback**. **Vault-free by
> construction:** it gets **only** the `NarrationContext` (assembled Vault-free, 0001) — extend the
> context-assembly sentinel test. **Outcomes stay the engine's:** a narration failure or
> hallucination **changes no game state** (the port returns text, never state). In the fold, the
> **front-end `llm_core`** is the deployed realization over MCP (0009) — same two guarantees. A
> **deterministic fake** backs tests. Make `0027` green; gates green. Open a PR.

### B18 — 0028 temperature & emotional-modifier constants  ·  Claude Code

> In `Psychout-Media/orwell`, implement feature **0028**
> (`docs/features/0028-temperature-and-emotional-constants.{md,feature}`): firm 0006's shape into a
> **single tunable constants module** (sibling to `richnessConfig.ts` and the 0026 relationship
> constants) — the temperature **bound/distribution**, the **per-variable weights**, the **emotional
> modifier** (baseline / volatility scale / mean-reversion rate), and the **hidden-element surfacing
> rate**. **Defaults match 0006's calibration** (favorite ~72%, real upsets, player unprotected,
> bounded, never overrides hard rules). The emotional modifier **mean-reverts**; hidden elements
> surface **rarely**. **No number hard-coded outside the module** (a future God-Mode knob). Keep the
> 0006 calibration property green; make `0028` green; gates green. Read `docs/features/0006` +
> `docs/decisions/0001`. Open a PR.

### C7 — 0029 app admin role & user management  ·  OpenHands (+ Claude Code for any engine bit)

> In `Psychout-Media/orwell` `frontend/`, implement feature **0029**
> (`docs/features/0029-app-admin-and-user-management.{md,feature}`). Most of it exists in
> `core/auth.py` (`AuthManager`: `setup`→admin, `create_user`/`delete_user`/`rename_user`,
> `is_admin`, `list_users`, `privileges`, `change_password`) and `routes/auth_routes.py`
> (`/api/auth/users`, `/change-password`) — **close the gaps**:
> 1. **Promote/demote:** add `AuthManager.set_admin(username, is_admin, requesting_user)` (admin-only;
>    **never demote/delete the last admin**) + `POST /api/auth/users/{u}/role`.
> 2. **Admin password reset for others:** `admin_reset_password(username, new_password, admin)` (no
>    current pwd; **revoke that user's sessions**) + `POST /api/auth/users/{u}/password`.
> 3. **Admin-only Users manager in Settings:** surface list/create/promote/demote/reset/rename/delete;
>    show the section **only** when the caller has `manage_users`; **re-check the entitlement
>    server-side** on every endpoint (don't trust the hidden UI).
> 4. **Gate global LLM settings** behind `manage_llm_settings` — a regular user can't change the
>    global model/endpoint config (their own non-privileged prefs are fine).
> Gate on the **named entitlement**, not a bare `is_admin`, so finer grants are a later config
> change. This is the **app/account tier** — distinct from the game's God Mode (0016) and the
> per-user game sandbox (0021). Make `0029` green; `py_compile` clean; smoke on two accounts (an
> admin + a regular user). Open a PR.

### C8 — 0032 front-end surface reduction (the "game build")  ·  OpenHands  ·  **next front-end feature**

> In `Psychout-Media/orwell` `frontend/` (Python; **no engine change**), implement feature **0032**
> (`docs/features/0032-frontend-surface-reduction-game-build.{md,feature}`). Reduce the vendored
> general-purpose workspace to **just the Big Brother game surface** and remove every inherited
> vertical. A partial prune already exists — `static/css/game-trim.css` (CSS-hide only) and 8 keys in
> `src/settings.py` `DEFAULT_FEATURES` — but it's **cosmetic and inconsistent**: routes/JS still ship,
> `web_fetch`/`document_editor`/`rag` are still on, most verticals have **no flag**, and
> **`/api/shell/exec` + `/api/shell/stream` are LIVE** (admin-gated but only CSS-hidden). Do it in
> **three escalating tiers**:
> 1. **Flag-gate + server-side 404 (CI-green).** Extend `DEFAULT_FEATURES` with one flag per dropped
>    vertical, default **off** under a single **`ORWELL_GAME_BUILD`** profile (default on) that forces
>    the **drop-set off / keep-set on**. Gate **route registration** (don't mount a disabled vertical's
>    router) so its endpoints return **404/410**, not just a hidden button — **prove it for the shell
>    endpoints** and flip `web_fetch`/`document_editor`/`rag` off. Drop the front-end **memory/RAG/
>    skills** context injection (the engine's soul/Vault is the only memory; the engine moment prompt,
>    0018, is the only injected framing). Prune the **Settings** tabs to the keep-set.
> 2. **Stop shipping the JS (CI-green).** Don't load dropped modules — especially the ~80-file
>    `static/js/editor/` image editor — taking ~5.4 MB → a fraction.
> 3. **Delete the code (running-instance verified).** Remove the dropped verticals' `routes/` +
>    `services/` + `src/` + `static/js/` + `app.py` wiring + `index.html` tags. Because this edits the
>    large `app.py` and the shell, its DoD is a **documented run on a live instance**: boots, onboards,
>    plays a turn in-character, **renders portraits**, accounts/admin work.
> **Keep-set (must survive every tier):** main chat + streaming/SSE + session history; onboarding
> (`orwellOnboarding.js`); the LLM connection (providers/endpoints/`llm_core`, 0027) **and** the agent's
> **engine MCP tool backend** (`agent_tools.py`/`tool_schemas.py`/`orwell_engine.py` — the linchpin);
> the 0020 surfaces (status, decisions, **portraits — keep the image-GEN path**, distinct from the image
> **editor**/gallery that go); accounts/admin (0029); Settings (pruned) + Theme. **Keep voice (TTS/STT)
> behind a `voice` flag that defaults OFF** (opt-in, not deleted). Make `0032` green via
> `cd frontend && python3 -m pytest tests/` (name-agnostic — roles only; the front-end is quarantined,
> so **do not** touch `cucumber.cjs` and keep `npm test` unaffected). Read `frontend/INTEGRATION.md`
> ("Deferred: the deep code-level prune") first. Open a PR.

### B20 — 0031 game orchestrator & integrity watcher  ·  Claude Code  ·  **next engine feature**

> In `Psychout-Media/orwell`, implement feature **0031**
> (`docs/features/0031-game-orchestrator-and-integrity-watcher.{md,feature}`). The engine is
> **pull-only** today: nothing advances a game between tool calls, the **off-screen sim never ticks
> on the live path**, and **no runtime process verifies integrity**. Build the hybrid:
> 1. **Turn-driven spine** — one `Orchestrator.advance(sandbox, trigger)` that runs the off-screen
>    tick (reuse `simulation.ts`/`offscreen.ts`/`gossip.ts`, 0003), advances to the next meaningful
>    day/phase (0008/0011), folds consequences (0023), persists (0030), then runs the **integrity
>    checkpoint**. Pure-logic, **seed-deterministic** (every advance goes through this one path).
> 2. **`Clock`/`Scheduler` port** (finally) — a real-timer adapter for prod + a **fake-clock**
>    adapter for tests (no real timers anywhere in tests).
> 3. **Background watcher** — behind the scheduler, on a tick: trigger **bounded** off-screen
>    advances on **idle** sandboxes (rate-limited so a long absence can't fast-forward the season),
>    and run the integrity **audit** across all sandboxes, updating a per-sandbox **health record**.
>    The watcher holds **no game logic** — it only *triggers* `advance()` and *reads* health; cadence
>    `0` disables it (pure turn-driven fallback).
> 4. **Integrity checkpoint (fail-closed)** — verify the LIVE state vs the last snapshot:
>    non-degradation (`isSuperset`/`countsNonDecreasing`, 0007), daily-event (0008), eligibility
>    (0005), Vault-Wall sentinel-clean on player **and** admin (0001), cross-user isolation (0021).
>    On failure: **refuse the commit, keep the prior save, record a fault** — never persist a
>    degraded/leaky state.
> 5. **God Mode health surface** — add `sandboxHealth()` to the admin port: **metadata only**
>    (phase, counts, last advance/trigger, integrity status, faults), Vault-free + sentinel-clean;
>    dependency-cruiser stays green (no Vault import); player has no access.
> Make `0031` green (add to `cucumber.cjs`); keep all gates green. Read `docs/features/0003`, `0007`,
> `0008`, `0021`, `0030`, and `0016` first. Open a PR.

### B21 — complete the 0018 lever manifest (drift-guarded)  ·  Claude Code  ·  **small; finishes C6's engine half**

> In `Psychout-Media/orwell` (TS engine), complete the **0018 lever-manifest refinement** that was specced
> but never built. `src/engine/momentPrompts.ts` still names only the original **4** levers
> (`getGameState`, `runCompetition`, `recordInteraction`, `surfaceInformationTo`), while the player tool
> registry (`src/surfaces/tools/registry.ts`) now exposes many more — incl. the live-loop levers
> **`advanceGame`** and **`submitDecision`** (0034) plus `gameStatus`, `getVisibleStateFor`, `socialRead`,
> `renderScene`, `askProducers`. The model discovers them via schemas, but the in-character base prompt
> should **name** them.
> 1. Update the base prompt's **YOUR LEVERS** manifest to name **every agent-driving player lever** the
>    registry exposes (exclude pure infra — `getMomentPrompt`, `endOfSessionSummary`), keeping the
>    engine-decides-outcomes framing.
> 2. **Activate 0018's parked scenarios** — uncomment the block in
>    `docs/features/0018-narrative-moment-orchestration.feature` ("names every player-channel lever",
>    "no lever in the player tool registry is missing from it", "each moment names the lever its beat
>    calls for") and make them green.
> 3. Add a **manifest↔registry drift test** (unit) that fails if any registry agent-lever is missing
>    from the base prompt — optionally via an `agentLever: true` marker on the game-driving entries.
> Manifest is **persona/framing only** — never the Vault Wall; the prompt stays **sentinel-clean** under
> a populated Vault (the 0001 canary on `getMomentPrompt` stays green). Make `0018` green; gates green.
> Open a PR.

### B22 — 0033 engine: `playerTagline` (Vault-free, snarky, state-aware)  ·  Claude Code

> In `Psychout-Media/orwell` (TS engine), implement the **engine** side of feature **0033**
> (`docs/features/0033-dynamic-player-tagline.{md,feature}`): a Vault-free player-channel tool
> **`playerTagline()` → { text }** — a single snarky _Big Brother_ welcome line for the caller's current
> moment, **generated via `NarrativePort`** (0027) from the **Vault-free public projection only**
> (`gameStatus`: week/phase/public standing — **never** hidden votes/targeting/souls/off-screen). One
> line, bounded length; **cache per `(user, week, phase, standing)`** (regenerate when the moment
> advances, not per load); a **pre-game** default line; **fail-open** to a static themed line on
> narrator error/timeout. `readsVault: false`; extend the 0001 canary to `playerTagline`;
> dependency-cruiser green. **Anti-sycophancy:** with a seeded deterministic fake narrator over a
> weak-standing state, the line must **not** flatter. Make the engine-side `0033` scenarios green (add to
> `cucumber.cjs`); gates green. Read `docs/features/0027`, `0020`, `0001` first. Open a PR.

### C9 — 0033 front-end: render the dynamic hero line  ·  OpenHands  ·  **depends on B22**

> In `Psychout-Media/orwell` `frontend/`, implement the **front-end** side of feature **0033**: replace the
> static hero subtitle at `static/js/models.js:571` (`#welcome-sub` ← "Yours for the voyage.") with the
> engine's **`playerTagline`** (B22). Fetch it Vault-free — fold a `tagline` field into the existing
> `GET /api/orwell/state` response (`routes/orwell_routes.py` + `src/orwell_engine.py`), or add a tiny
> `GET /api/orwell/tagline`. **Fail-open:** engine down / field absent ⇒ keep the static line; the
> homepage must **never** block on the tagline. Refresh on the SSE/session-sync tick that already drives
> play. Part of the **0032** game build. `pytest` green; `py_compile` clean; engine gate unaffected.
> Depends on **B22**. Open a PR.

### B23 — 0034 codify the live progression & decision seam (as-built)  ·  Claude Code  ·  **mostly codification**

> In `Psychout-Media/orwell` (TS engine), implement feature **0034**
> (`docs/features/0034-live-weekly-progression-and-decision-seam.{md,feature}`). The capability is
> **already built** (`src/engine/liveSeason.ts`, `GameSessionAdapter.advanceGame()/submitDecision()`, the
> `GameSession` port, the `advanceGame`/`submitDecision` tools + MCP client + agent tools + status panel,
> with unit + integration tests) — but it shipped **without a name-agnostic `.feature`**. Add that spec
> (to `cucumber.cjs`) and **assert the cross-cutting guarantees** so the live loop can't regress: NPC
> beats auto-resolve; the loop **stops** for the player's binding decision and returns the **legal**
> option set; a binding choice changes state **only** via the validated `submitDecision`, **never** from
> prose; **illegal** choices are rejected (0005); each beat **persists** and **survives a restart**
> (0030); the live path is **Vault-free** — and where the explicit Vault sentinel on `advanceGame`/
> `submitDecision`/`gameStatus` output isn't already covered, **add it** (extend the 0001 canary);
> seed-deterministic. Most steps map to the **existing** code — this is codification + targeted
> hardening, not a rebuild. Pairs with **B21** (the manifest must name `advanceGame`/`submitDecision`).
> Make `0034` green; gates green. Read `docs/features/0011`, `0019`, `0005`, `0030`, `0001` first. Open a PR.

### B24 — 0035 start the off-screen watcher in the runtime  ·  Claude Code  ·  **TOP functional priority (mandate #1)**

> **SUPERSEDED / REMOVED (2026-07-10, PO real-time purge; noted in the #1939 doc-drift pass):** the `GameWatcher`, `SystemClock` and `ORWELL_WATCHER_*` surface this item built were DELETED, not disabled. The house now lives one bounded off-screen tick per committed player turn on a `LogicalClock`. Kept below as the historical prompt.

> In `Psychout-Media/orwell` (TS engine), implement feature **0035**
> (`docs/features/0035-live-offscreen-life-running-watcher.{md,feature}`). 0031 built the `Orchestrator` +
> `GameWatcher` + `Clock`/`Scheduler` port (BDD-green with `FakeClock`), but the **live runtime never
> starts them** and there's **no real-timer Clock adapter** — so the live game has **zero off-screen NPC
> life** (the house is static between turns; a direct miss against **behavioral-fidelity mandate #1**).
> 1. Add a **`SystemClock`** real-timer adapter (sibling to `FakeClock`) implementing the 0031
>    `Clock`+`Scheduler` port (`now` = `Date.now`; `every` = `setInterval(...).unref()`; `cancel` =
>    `clearInterval`).
> 2. **Instantiate + `start()`** a `GameWatcher` over the live `GameSessionRegistry` in `src/main.ts`
>    (or a small runtime root), with graceful **`stop()`** on shutdown.
> 3. **Env config** for cadence/idle/rate-limit (`ORWELL_WATCHER_TICK_MS`/`IDLE_MS`/`MAX_TICKS`, sane
>    defaults; **`TICK_MS=0` disables** ⇒ pure turn-driven).
> Reuse 0031's logic unchanged. **Assert under the running watcher:** idle sandboxes accrue **bounded**
> off-screen consequences; the player sees **no opinion numbers** (extend the 0001 canary); **per-user
> isolation** holds (0021); a long absence advances at most `MAX_TICKS` (no season fast-forward). Tests
> still use **`FakeClock`** (no real timers in tests). Make `0035` green (add to `cucumber.cjs`); gates
> green. Read `docs/features/0031`, `0003`, `0001`, `0021` first. Open a PR.

### B25 — 0036 live social surface: NPC approaches + Diary Room  ·  Claude Code

> In `Psychout-Media/orwell` (TS engine), implement feature **0036**
> (`docs/features/0036-live-social-surface-approaches-and-diary-room.{md,feature}`): expose two
> **built-but-unwired** capabilities as Vault-free live player tools (add to `PLAYER_TOOLS` + the McpServer
> allowlist + the **B21** lever manifest).
> 1. **`socialInitiatives()`** — surface houseguests who, by soul motivation, want to **approach the
>    player now** (source: `src/engine/conversation.ts` `npcInitiatedApproaches()`), with a **public-facing
>    pretext only** (no hidden motive/numbers) — so scenes are **bidirectional**, not only player→NPC.
> 2. **`diaryRoom(entry)`** — record a player DR entry as **OOC player knowledge** tagged `NO_NPC_PATHWAY`
>    via `KnowledgeService.recordDiaryRoom()`; it **may** inform the engine's read of player strategy but
>    **never** NPC behavior.
> **The wall is the crux:** extend 0013's exclusion test to the **live tool** — prove **no NPC ever learns
> DR content** (`deriveNpcKnowledge` excludes it) and NPCs act only on **public** speech; NPC confessionals
> stay **Vault-only**. Both `readsVault:false` + **sentinel-clean** (extend the 0001 canary). Make `0036`
> green (add to `cucumber.cjs`); gates green. Read `docs/features/0012`, `0013`, `0002`, `0001` first. Open a PR.

### C10 — 0036 front-end: surface approaches + a Diary-Room entry point  ·  OpenHands  ·  **READY — API wired; UI only**

> In `Psychout-Media/orwell` `frontend/`, build the **player-facing UI** for feature **0036** per its design
> note **§7** (`docs/features/0036-…md`). The engine tools **and the front-end API are already wired** — you
> only build the UI on top of these live, Vault-free routes:
> - `GET /api/orwell/initiatives` → `{ initiatives: [{ houseguest: { id, name }, pretext }] }` — surface the
>   approachers **unobtrusively** in the main chat (a small dismissible "**{name}** {pretext}" affordance by
>   the composer); acting on one starts a normal scene, ignoring is fine. Refresh on the status-panel cadence.
> - `POST /api/orwell/diary-room` `{ entry }` → `{ recorded: true }` — a clearly-labelled **Diary Room** entry
>   point (button/panel) for a private confessional; confirm on success; make the **OOC / "the house never
>   hears this"** nature explicit.
> **Constraints:** render **only** the route payloads (Vault-free); **fail open** (no approach chip on
> empty/error, graceful inline error for DR — never block the chat); keep it in the **0032 game-build
> keep-set** (game-in-progress only; survives the prune). **DoD:** `cd frontend && python3 -m pytest tests/`
> green (roles only); the **0032 headless-browser gate** (`scripts/browser_smoke.py`) still loads the keep-set
> with no broken modules; verify on a **running instance** (per `frontend/INTEGRATION.md`). Engine gate
> unaffected (front-end quarantined). Open a PR.

### B26 — 0037 engine: expose a Vault-free `finaleView` read  ·  Claude Code  ·  **small; unblocks C11** — ✅ DONE

> **DONE.** `GameSessionAdapter.finaleView()` is public + on the `GameSession` port; `finaleView` added to
> `PLAYER_TOOLS` + `McpServer` dispatch + `INFRA_LEVERS` (so the lever-manifest drift guard doesn't name it).
> The B42 sentinel sweep now calls it at every beat (incl. the live finale); a behavioral test proves it is
> null off-finale and mirrors `AdvanceView.finale` during one (no votes/script/tally/lean). arch + gate green.

> In `Psychout-Media/orwell` (TS engine), promote the existing private `GameSessionAdapter.finaleView()` to a
> **read tool** `finaleView(): FinaleView | null` on the `GameSession` port + `PLAYER_TOOLS` + `McpServer`
> dispatch (per `docs/features/0037-…md` §8.1). `readsVault: false`; classify it **infra** (add to
> `INFRA_LEVERS`, like `gameStatus`/`playerTagline`) so the lever-manifest drift guard doesn't require naming
> it. It returns the **same Vault-free projection** already proven on `AdvanceView.finale` — names + current
> stage + the reveals SO FAR only, **never** a lean/tally/eviction-manner/pre-reveal winner. Extend the 0001
> sentinel canary to `finaleView`; `npm run test:arch` + `npm test` green. Open a PR.

### C11 — 0037 front-end: render the interactive finale  ·  Claude Code  ·  **depends on B26** — ✅ DONE

> **DONE** (built in the Claude Code lane). `GET /api/orwell/finale` → `{ finale: FinaleView | null }`
> (fail-open) + an `orwell_engine.finale_view` client over the B26 tool. `static/js/orwellFinale.js` — a
> self-contained, fail-open, draggable/minimizable polling panel (sibling of `orwellSocial.js`, no new module
> deps, script-tagged after the social panel): shown only while a finale stages, it renders the finalists, the
> stage, and the vote reveal IN ORDER with a tally of the revealed votes only (never a pre-reveal winner). The
> player's turn is surfaced as composer-prefill shortcuts (player-finalist → statement/appeals; player-juror →
> finalist vote); binding submission flows through the chat-agent `submitDecision` seam. `tests/test_orwell_finale.py`
> (3, fail-open) + 184 pytest green; the 0032 headless-browser keep-set gate stays green (`orwellFinale.js`
> loads cleanly). No new `submitDecision` kind ⇒ no C12 relay change.

> In `Psychout-Media/orwell` `frontend/`, build the finale **presentation UI** for feature **0037** per its design
> note **§8** — the direct parallel to 0036's C10, in the same self-contained, fail-open, game-gated patterns as
> `orwellStatusPanel.js` / `orwellSocial.js`:
> - **Route:** `GET /api/orwell/finale` → `{ finale: FinaleView | null }` (mirror `/status`; add an
>   `orwell_engine.finale_view` client over the **B26** `finaleView` tool). Fail-open to `{ finale: null }`.
> - **`orwellFinale.js`** — a polling panel shown **only while a finale is staging**: the two **finalists**,
>   the **stage** (`statements|questions|vote|reveal`), and the **vote reveal IN ORDER** (`reveals[]` as they
>   appear, with a running tally of **revealed** votes only — **never** a pre-reveal winner/tally). On
>   completion the crown lands via `AdvanceView.winner`.
> - **Player decisions** (`finale-statement` / `finale-answer` with the legal `appeals[]` + the asking juror /
>   `juror-vote` over the two finalists) are surfaced as **composer-prefill shortcuts** (like `orwellSocial`'s
>   approach chips); binding submission still flows through the chat-agent `submitDecision` seam — the panel
>   only presents the legal options; the engine validates + scores (the prose carries no score).
> **Constraints:** render only the Vault-free payloads; fail-open; **0032 keep-set** (live-finale only, no new
> module deps → browser-smoke safe); script-tag after the social panel. **DoD:** `pytest` green (roles only —
> finalist/juror); the 0032 headless-browser gate stays green; engine gate unaffected; verify on a running
> instance. Depends on **B26**. Open a PR.

---

## Post-audit feature batch (0038–0044) · all Claude Code (engine)

A behavioral-fidelity / anti-sycophancy audit (transcript) found several capabilities **built but unwired**
and two genuine gaps. These specs close them. Build priority: **0038 first** (biggest "feels flat" risk,
pure wiring), then 0039 & 0040 (genuine gaps), then 0041/0042/0043/0044.

### B27 — 0038 live off-screen society  ·  **✅ DONE (B27a + B27b, 2026-06-10)**

> **B27b shipped with B70's PR.** `diffuseGossip` is wired into the live off-screen tick: a rumor RISES from a
> scene occasionally (`GOSSIP.riseProb`), travels the AFFINITY graph (who actually talks to whom; the player is
> a node) with low per-edge transmission, decaying confidence and per-telling drift, and lands on the player —
> when a chain terminates there — as a belief with source+confidence. The rumor is a vague PARAPHRASE
> (`rumorFrom` + `RUMOR_GLOSS`), never the verbatim hidden scene; retelling events are recipient-specific (the
> B64 twin-content lesson). The 0031 leak heuristic is PATHWAY-AWARE: hidden content covered by the player's
> legitimate pathway-borne facts is not a leak — the checkpoint commits legal propagation; the 0001 canary stays
> the precise guard. 0035 + 0038 are now in `cucumber.cjs` (11 new scenarios). `tests/unit/liveGossip.test.ts`.

> **B27a (DONE):** the orchestrator's live off-screen tick (`Orchestrator.defaultApply`) now runs
> `richOffscreenStretch` — **seven varied interaction types** folded into the relationship layer by their true
> nature (was a 4-verb stub). Bounded/seeded/Vault-walled/isolated; unit-gated (`offscreenSociety.test.ts`).
>
> **B27b (remaining) — see `docs/features/0038-…md` §8 for the full design.** (1) **live gossip→player
> diffusion**: the fix is (a) make the **0031 leak heuristic pathway-aware** — flag a hidden event's content
> as a leak only if it appears in the player projection AND is **not covered by the player's legitimate
> `KnowledgeService` facts** (gossip "told-by"/"overheard"/"surfaced" pathways); the **0001 sentinel canary
> stays** the precise guard; (b) keep the rumor a **vague paraphrase** (never the verbatim hidden scene);
> (c) wire `diffuseGossip` into the off-screen tick over a house graph with a **low transmit probability**
> (partial, distorted spread), reaching the player only via a terminating pathway as a belief with
> source+confidence. **Acceptance:** a rumor reaches the player AND the 0031 checkpoint still commits (no
> false leak) AND the 0001 canary stays green. (2) **soul deepening** is **feature 0041**. Then add 0035 +
> 0038 to `cucumber.cjs`. Gates green. Open a PR.

### B28 — 0039 promise & deal tracking

> Implement `docs/features/0039-promise-and-deal-tracking.{md,feature}`. Add a first-class `Deal` model
> (parties/terms/condition/status); make player↔NPC deals (recorded knowledge) + NPC↔NPC deals (Vault-held);
> **reconcile** open deals against binding actions (engine-decided kept/broken, never prose); on break apply
> the **betrayal-shock** fold (0026) + a jury-management demerit (0014) + a witnessed reveal. Persisted (0030);
> Vault-walled (NPC↔NPC reach the player only by 0038 rumor). Add to `cucumber.cjs`. Open a PR.

### B29 — 0040 NPC Diary Room confessionals  ·  **DONE (core)**

> ✅ `src/engine/confessionals.ts` (`confessionalFor` + `recordConfessional`): an engine-grounded private read
> (top-threat target + strongest bond, from the relationship signals — not invented), recorded **Vault-only**
> (hidden, `witnessSet:[npc]`); wired into the live off-screen tick. Proven **walled from the player AND the
> admin** (the admin surface reads no events) + seed-deterministic — `tests/unit/npcConfessionals.test.ts` (5).
> **Remaining:** the **soul-recall feedback** (grounding the NPC's later voice) needs a `SoulStore` in the live
> sandbox — **feature 0041**; optionally fire confessionals specifically at nomination/eviction beats (today
> the trigger is the off-screen tick).

### B30 — 0041 character evolution & season arc  ·  **LINCHPIN (unblocks 0038 + 0040 soul pieces)** — ✅ DONE

> **DONE.** `SoulStore` is wired into the live `EngineCore`/`buildEngineCore` (deterministic embed),
> walled engine-only by dependency-cruiser (soul/vector/embedding types in the forbidden set). The live
> consequence fold (`GameSessionAdapter.commit`) + the off-screen tick (`Orchestrator.defaultApply`) drive
> `src/engine/emotionalArc.ts` (`evolveEmotion`): bounded, mean-reverting soul `emotionalState`/`volatility`
> from real events, a persisted `emotionalHistory` arc, and `recordToSoul`/`recall` live. The evolving
> state modulates the live competition emotional modifier (0006/0028) + a rattled-HOH nomination read
> (`chooseNominationsWithMood`); `CHARACTER` stays byte-stable (0007); no number on any player surface
> (canary extended); persisted across restart (0030). Added to `cucumber.cjs`. Original prompt below.
>
> Implement `docs/features/0041-character-evolution-and-arc.{md,feature}` — **see §8 for the concrete live
> wiring.** The crux: the live sandbox's `buildEngineCore` (`engineRoot.ts`) has **no `SoulStore`** — that's
> why 0038's soul-deepening and 0040's confessional→voice feedback are deferred. (1) Add **`soul: SoulProvider`**
> to `EngineCore`/`buildEngineCore` as `new SoulStore(embed, makeIndex)` with a **deterministic fake embed**
> (seeded hash→vector, like 0024's tests); **extend the dependency-cruiser engine-only forbidden set** so no
> outward surface imports the soul/vector types (like `VaultStore`). (2) Drive `emotionalState`
> `{distress,confidence,volatility}` from **live** events (blindside→distress, survival/win→confidence),
> bounded + mean-reverting (0028 family); call `recordToSoul` on the consequence fold (0023) + the off-screen
> tick (0038). (3) Have the evolving state modulate the **competition emotional modifier** (0006/0028) **and**
> decision leanings; expose `recall` for 0040's voice grounding. Keep `CHARACTER` **byte-stable** (0007); only
> the soul drifts; no emotional number on any player surface (extend the 0001 canary). Add to `cucumber.cjs`.
> Open a PR.

### B31 — 0042 competition library  ·  **✅ DONE 2026-06-10**

> **Built to green.** New `src/engine/competitionLibrary.ts`: a curated, tunable `COMPETITION_LIBRARY`
> (12 `CompetitionDef`s — 6 HOH + 6 veto: name, phase, the existing resolution `type` with its `governing`
> aptitude pinned to `RELEVANT[type]` by test, optional secondary flavor, format, and a Vault-free narrative
> scaffold `{premise, beats, winReads}`) + the deterministic `drawCompetition(phase, week, rng, recent)`
> (seeded; avoids the last `NO_REPEAT_WINDOW` per phase). `liveSeason.ts` replaced the hardcoded
> `HOH_TYPES`/`VETO_TYPES` week-index rotation: the comp is drawn FIRST on the beat rng (so `advance` and
> `peekCompetition` replay identically), resolved draws are recorded into the persisted `compHistory` (0030),
> and a Houseguest's-Choice pause stores the drawn def id (`vetoComp`) so the resume runs the SAME comp.
> Resolution math untouched (0006/0028 — the engine still decides; favorite calibrated, player unprotected).
> `CompetitionResultView` gained optional `name`/`format`/`narrative` (no stat/score — the 0001 canary
> extended to the enriched view); the 0034 deep-game BDD fixtures repointed to seed 5 (the reshuffle moved
> which seeds run deep). `tests/unit/competitionLibrary.test.ts` (11) + all 6 BDD scenarios in `cucumber.cjs`.
> Original prompt below.

> Implement `docs/features/0042-competition-library.{md,feature}`. A seeded, tunable `COMPETITION_LIBRARY` of
> `CompetitionDef`s (name, governing/secondary stat, format, Vault-free narrative scaffold) + a deterministic
> `drawCompetition(phase, week, rng, recent)` (no immediate repeats) replacing the hardcoded `HOH_TYPES`/
> `VETO_TYPES`. Resolution stays `resolveCompetition` (engine decides — 0006/0028); the Vault-free result
> carries name+format+narrative (no stats/scores); 0005 eligibility holds. Add to `cucumber.cjs`. Open a PR.

### B32 — 0043 emergent multi-party bloc behavior  ·  **✅ DONE 2026-06-10**

> **Built to green.** New `src/engine/blocs.ts`: `detectBlocs` clusters the LIVE relationship graph at decision
> time — CLIQUE-LIKE growth over mutual bonds (a bloc can't span two members who distrust each other), bounded
> to BB sizes, deriving `{members, sharedTarget (aggregate threat), cohesion, loyaltyStrength}`. **Loyalty** (the
> 2026-06-10 dial): `derivedLoyalty(disposition × soul state)`, weakest-member-weighted per bloc; a low-loyalty
> member with a stronger outside pull DEFECTS pre-betrayal. The **bloc term** (`blocTerm`, scaled by loyalty)
> bends live nominations + eviction votes + tie-breaks (`SeasonCtx.loyaltyOf`, wired by the adapter): bloc HOHs
> shield bloc-mates, blocs vote together toward the shared enemy. Fracture is implicit (a betrayal-collapsed edge
> excludes the betrayer next read). NOTHING stored — decision 0002 holds (the snapshot is bloc-free, proven);
> Vault-free; deterministic. `tests/unit/blocs.test.ts` (incl. a live engineered-bloc drive) + all 9 BDD scenarios
> in `cucumber.cjs`. Original prompt below.

> Implement `docs/features/0043-emergent-bloc-behavior.{md,feature}`. A **pure, stateless** `detectBlocs(rel,
> active)` that clusters mutual bonds at decision time (size ~2–5), each bloc deriving a shared target +
> cohesion; add a **bloc term** to nomination/vote leanings (vote-with / shield bloc-mates / target the shared
> enemy); fracture is implicit (recomputed). **Nothing stored** — the serialized soul holds no bloc/label
> (decision 0002; cross-check 0007). Vault-free. Add to `cucumber.cjs`. Open a PR.

### B33 — 0044 strategic nomination & vote refinements  ·  **✅ DONE 2026-06-10**

> **Built to green.** `src/engine/decisionConstants.ts` is the single tunable module (sibling to 0026/0028 —
> the paranoia weight re-homed there; the B59 grep gate extended). **Nominations**: `nominationStrategy`
> (season.ts) layers on the built threat-primary read — `politicalTemperature` (house-wide threat spread; a
> runaway threat forces everyone DIRECT), disposition-gated tactics (bond ⇒ PAWN beside the target; clash ⇒
> BACKDOOR — the real target stays off the block and the replacement read completes the plan when the veto
> comes off; neutral ⇒ direct), and hard bloc protection (a mate is never nominated, even as the cheapest pawn,
> while two legal others remain). **Votes**: `voteChoice` (liveSeason.ts) blends threat × (1 + paranoia·mood
> weight) (0041 self-protection — a rattled voter can break a deal a calm one honors) + `blocTerm` (0043) −
> deal-honor pull (0039 — the ledger still reconciles a break with full consequence) − light jury management
> (don't make a bitter juror in a near-tie). `SeasonCtx` gained optional `dispositionOf`/`dealsOf` (adapter-
> wired); `autoDecision` + the NPC replacement read use the same strategy (no second rulebook). Also fixed the
> deep-endgame fault spam this surfaced: an off-screen tick with <2 living NPCs (player in the Final 2) is now
> a clean no-op, not a per-turn `no-daily-event` integrity fault. `tests/unit/strategicDecisions.test.ts` +
> all 6 BDD scenarios in `cucumber.cjs`. Original prompt below.

> Implement `docs/features/0044-strategic-nomination-and-vote-refinements.{md,feature}`. Enrich the **built**
> `chooseNominations` (add pawn/backdoor/bloc-protection, archetype-gated, + the week's political temperature)
> and `npcChoice` (fold bloc 0043 + emotional state 0041 + deal status 0039). Still **engine-decided** + seeded;
> all magnitudes in **one tunable constants module** (sibling to 0026/0028). The threat/political-temperature
> parts can ship first; the bloc/mood/deal terms as those land. Add to `cucumber.cjs`. Open a PR.

---

## Still on the feature-maker (me) — HISTORICAL (superseded 2026-06-10)

> **HISTORICAL (E87d):** this block is a point-in-time snapshot from mid-build and contradicts the
> drained-queue banner — everything it lists as "remaining" subsequently shipped (0037 UI/B26+C11,
> B27b, 0039–0044, the audit batches) except **0022**, which stays the one deferred feature. Kept
> verbatim below for the record; trust the per-item ✅ stamps and `cucumber.cjs`, not this prose.

**0001–0036 are built** (0022 deferred). The "continue all wiring" batch shipped the engine + API wiring:
**B24/0035** (SystemClock + `composeRuntime` start the off-screen watcher in `main.ts` — the house now lives
between turns), **B25/0036** (`socialInitiatives` + `diaryRoom` live tools), **B21/0018** (full lever manifest
+ drift guard), **B22/0033** (`playerTagline`), **B23/0034** (live-seam BDD), and front-end **C9/0033** (the
hero line now shows the engine's snarky tagline, fail-open) + the **0036 front-end API** (`/api/orwell/tagline`,
`/initiatives`, `/diary-room` + engine-client methods). Full engine gate green: **214 unit + 213 BDD**.

**The "continue all wiring" batch is done** (C10 = `orwellSocial.js`, merged). Since then the other agents
shipped **0037 — the interactive finale / jury-vote choreography** (engine built & BDD-green: appeal scorer +
staged statements → questions → vote reveal, through the 0034 seam) plus game-UI fixes (draggable HUDs, theme
picker). Engine gate green: **230 unit + 222 BDD**.

**Remaining — ALL implementer-ready (each carries a §8 "Definition of Ready": exact touch points, build
order/deps, test targets, no open decisions):**
- **0038** live off-screen society — **B27a done**; the **live soul-deepening half is now wired by 0041**
  (the off-screen tick `recordToSoul`s each scene); **B27b** (gossip↔checkpoint reconciliation) still ready (0038 §8).
- **0040** NPC confessionals — **done**; soul-recall feedback is now **live** (0041 put the `SoulStore` in the sandbox).
- **0041** character evolution/arc — **✅ DONE (B30, the LINCHPIN).** `SoulStore` is wired into the live
  `EngineCore`; the consequence fold + off-screen tick drive bounded, mean-reverting soul evolution that
  modulates the live competition modifier + a rattled-HOH nomination read; the arc persists + is recall-able;
  `CHARACTER` byte-stable; no number on any player surface. Unblocked the deferred soul halves of 0038 + 0040.
- **0039** promise/deal tracking — **done (B28)** · **0042** competition library (§8) → B31 · **0043** emergent bloc
  behavior (§8, honors ADR 0002) → B32 · **0044** strategic nom/vote refinements (§8) → B33.
- **0037 finale UI** — **B26** (Vault-free `finaleView` read) → **C11** (`orwellFinale.js`), per 0037 §8.
- **0022 — MVP-2 (the rich game UI)** — the one deferred feature (no DoR yet).
- **The audit batches below** — the **full product-audit batch (B34–B60 / C12–C18)** and the **front-end &
  experience batch (B61–B66 / C19–C28)**, both wave-ordered, governed by ADR 0003; audit specs
  **0045–0048 are drafted**, **0049** (B64) is drafted **and built**.

**Suggested build order for the implementer agents:** ~~0041 (linchpin)~~ **done** → 0039 (done) / 0043 → 0044
(consumes 0043 + 0041) → 0042 → B27b → 0037 UI — interleaved with the audit batches' waves (**Wave 0 hotfixes
B34–B36/C12 first**; B61/C19 are the highest-leverage experience pair). Each is independently buildable per its §8.
- *(By design, not a gap: the live engine narrator is `EchoNarrativePort`; the front-end narrates via
  `getMomentPrompt`. The `playerTagline` `setNarrator` seam is ready if engine-side narration is ever wired.)*

---

## Product ruling: the house does not exist when the player leaves (2026-06-10)

**Ruling.** The game clock runs only when the player is playing. When the player steps away — closes
the browser, ends the session — **the house ceases to exist**. No background scheming, no NPC social
ticks, no relationship drift, nothing. The lack of real estate is the core mechanic of Big Brother:
nobody leaves the house. Because the player *can* leave and NPCs cannot, any background activity that
accrues during player absence creates a structural playability asymmetry. The engine must not exploit
the player's absence against them.

**Implementation (done — `src/composition/runtime.ts`).** `DEFAULT_WATCHER.tickEveryMs` is now `0`
(pure turn-driven). The watcher is disabled by default. The house **only lives between the player's
own turns** via the existing `Orchestrator.maybeTurnDrivenTick` (one bounded off-screen tick per
player action, already built). If an operator wants real-time background life, they opt in via
`ORWELL_WATCHER_TICK_MS` — but it must never be the default.

**What "a player turn" means.** A player turn is any **state-mutating game action**: `advanceGame`,
`submitDecision`, `recordInteraction`, `makeDeal`, `diaryRoom`, `surfaceInformationTo`,
`createCharacter`. Read-only calls (`getGameState`, `gameStatus`, `playerTagline`, `getMomentPrompt`,
`socialInitiatives`, `runCompetition`) are not player turns — they don't mutate state and don't
trigger the off-screen tick. This is already encoded: only mutating ops call `onPersist()` →
`commitPlayerTurn()` → `touch()` → `maybeTurnDrivenTick()`.

---

## Full product-audit batch (B34–B60 / C12–C18) · 2026-06-09

Dispatch prompts for the **full product audit** (`docs/audits/2026-06-09-product-audit.md`). All gates were
green at audit time — every item below is *unasserted* behavior (a gap between the code and the game's own
mandates), not a failing test. **Read the audit's "Remediation principles (the preferred how)" section first** —
the seven patterns (single outcome authority · the pending-decision seam · validated references in / projections
out · folds in the commit path + constants modules · the orchestrator as the real spine · the versioned snapshot
as the contract · gates on the production path) are the architectural spine of these fixes; a fix that fights one
of them is probably wrong. **Lane note (current reality): OpenHands is not yet configured, so Claude Code owns
both lanes** — the engine items (`src/`, B-numbered) **and** the front-end items (`frontend/`, C-numbered). The
B/C split is kept as a **scope** marker (which tree the change lives in + the quarantine rules), not an agent
assignment; pick up C-items as readily as B-items. When a C-item touches `frontend/`, keep it quarantined from
the TS gate (`cd frontend && python3 -m pytest tests/`; never touch `cucumber.cjs`/`npm test`). House rules apply
(Vault Wall structural; `npm run test:arch` green; BDD/TDD-first; roles-only tests; keep gates green; PR per item).

**Feature-maker note:** four items need a `docs/features/NNNN-*.{md,feature}` spec **drafted first** before the
engine prompt can run — **0045** (B43), **0046** (B48), **0047** (B49), **0048** (B56). Draft them in the existing
spec style (design note + name-agnostic Gherkin) before dispatching those B-items.

| Wave | Item(s) | Lane | Audit ref | Depends on |
|---|---|---|---|---|
| **0 — hotfixes** | ✅ B34 bind+auth · ✅ B35 atomic/tolerant saves · ✅ B36 createCharacter guard · ✅ C12 finale relay + engine-down fail-closed + reset guard | both | E1·E2·A2 / B3·F2·A2 | — |
| **1 — ground truth** | B37 single comp authority · B38 ceremony folds · B39 knowledge integrity · B40 snapshot completeness · B41 orchestrator spine · B42 live sentinel sweep | engine | A1·A3 / C1 / A4 / C2·C3·C4 / E3·D4 / E8 | B36 (B40 reads the snapshot) |
| **2 — the endgame** | B43 0045 F5→2 · B44 tie-break · B45 Houseguest's Choice · B46 comp intent · B47 jury manner+appeal symmetry · B48 0046 player eviction · B49 0047 eviction night · **B26/C11** finale UI | engine + FE | B1 / B2 / B4 / B5 / A5·A6 / B6 / B7 | B43 first (others extend the F5→2 loop); B26/C11 already queued |
| **3 — the living house** *(merge with 0038–0044)* | **B30/0041 first** · B50 hidden elements · B51 emotional modifier · B52 evictee filters · B53 twists live · B54 live richness gate · B55 loop unification + relationship realism | engine | D1 / D2 / D5 / D6·B8 / D3 / D12·C5·C6 | 0041; D7 folds into B32/B33 |
| **4 — the experience** | **C13** lever drift · **C14** agent-path + immersion · **C15** onboarding/history · **C16** 0022 first slice · B56 0048 + **C17** recap/unseal UI | front-end + engine | F1 / F3·F6 / F5·F7 / F9 / G4 | B56 spec; C17 depends on B56 |
| **continuous** | B57 doc-hygiene · B58 ops (prune/admin/faults) · B59 boundary+catalog · B60 transport robustness · **C18** FE minors | both | H1 / E4·E5·E6 / E7·I / E9–E12 / F8 | — |

---

### B34 — close the engine network boundary (bind + auth + identity)  ·  Claude Code  ·  **Wave 0 hotfix · audit E1** — ✅ DONE

> **DONE.** `HttpMcpServer` binds `127.0.0.1` by default (`ORWELL_ENGINE_HOST` override); an optional
> `ORWELL_ENGINE_TOKEN` is required on every tool route (401 on mismatch; `/health` stays open);
> `ORWELL_ENGINE_MULTIUSER` rejects a missing `x-orwell-user` (400) instead of a shared `"default"`;
> and a non-`createCharacter` call for an unknown user is refused (404) without minting a sandbox.
> All default OFF (single-tenant loopback unchanged). `tests/integration/httpBoundary.test.ts`;
> `docs/INSTALL.md` documents the knobs and agrees with the bind. Original prompt below.

> In `Psychout-Media/orwell` (TS engine), close the cross-user network hole. Today `createHttpMcpServer(...).listen(port)`
> binds **`0.0.0.0`** (`HttpMcpServer.ts:75-77`; `main.ts:41` even logs it) while the deploy docs claim loopback,
> identity is the client-supplied `x-orwell-user` header defaulting to `"default"` (header-less clients silently
> **share** a sandbox), the **admin** channel is equally open, and `sandboxFor` mints a sandbox for any string (memory
> DoS, never evicted). (1) Bind **`127.0.0.1`** by default, host configurable via env. (2) Add a shared-secret
> **`ORWELL_ENGINE_TOKEN`** checked on every request (401 on mismatch). (3) In a multi-user mode flag, **reject** a
> missing/empty user header (400) instead of routing to `"default"`. (4) Cap registry size / require the user to exist
> in the save store for non-`createCharacter` calls. In-process isolation (0021) already holds — this is the network
> edge. **Acceptance:** integration tests — connection refused from a non-loopback bind in default config; 401 without
> the token; 400 (not `"default"` routing) without the user header in multi-user mode; deploy README and actual bind
> agree. Read `docs/features/0021` first. Open a PR.

### B35 — make saves crash-safe (atomic write + tolerant load + handler guards)  ·  Claude Code  ·  **Wave 0 hotfix · audit E2** — ✅ DONE

> **DONE.** `FileSaveStore.saveFor` writes a `.tmp` then `renameSync` (atomic); `loadLatest`
> quarantines a corrupt highest version (`.corrupt`) and steps down to the last good one (null only
> when nothing parses). The HTTP request handler is guarded (→500, splitting a sandbox-resolve
> failure from a bad tool/args→400) and `GameWatcher.onTick` isolates each user in try/catch.
> `tests/unit/saveCrashSafety.test.ts` + the 500-isolation case in `httpBoundary.test.ts`. Prompt below.

> In `Psychout-Media/orwell` (TS engine), stop one corrupt save from crash-looping the engine for **all** users. Today
> `FileSaveStore.saveFor` does a non-atomic `writeFileSync` (truncation on crash), `loadLatest` does an unguarded
> `JSON.parse` with no fallback, and `sandboxFor` runs un-caught inside the HTTP request listener (`HttpMcpServer.ts:52`)
> and the watcher tick (`gameWatcher.ts:49-67`) — so a truncated highest-version file is an uncaughtException → process
> exit, and the same file is "latest" on restart → crash loop. (1) Write to `vNNNNNN.json.tmp` + `renameSync`. (2) In
> `loadLatest`, on parse error **quarantine** the bad file and **step down** to the next-lower version. (3) Wrap the
> HTTP request handler (→ 500) and `GameWatcher.onTick` (→ recorded fault, skip) in try/catch. **Acceptance:** unit —
> truncate the latest version file ⇒ `loadLatest` returns v(N−1) and `sandboxFor` resumes; integration — a corrupt file
> ⇒ one 500, other users unaffected, process alive; the watcher tick over a corrupt-save user does not throw. Open a PR.

### B36 — guard `createCharacter` against wiping a started season  ·  Claude Code  ·  **Wave 0 hotfix · audit A2 (engine half; FE mirror in C12)** — ✅ DONE

> **DONE.** `GameSessionAdapter.createCharacter` refuses to replace a started game unless an explicit
> `confirmRestart` is set — it returns the current state unchanged and writes no new save version, so
> a stray/hallucinated/network call can't wipe an active season. A real restart goes through the admin
> reset path (`registry.resetUser`); `confirmRestart` is not in the player tool's documented schema.
> `tests/unit/createCharacterGuard.test.ts`. Original prompt below.

> In `Psychout-Media/orwell` (TS engine), `GameSessionAdapter.createCharacter` (`:206-228`) unconditionally replaces the
> house, resets to week 1, and **persists** — wiping an active game (reachable by any GM hallucination or network
> caller). Refuse when `started && !confirmRestart` (explicit arg), returning the existing view unchanged; route a real
> restart through admin `manageSandbox reset` / `registry.resetUser` (wired in B58/E5). Honors the non-degradation
> mandate at its single most destructive point. **Acceptance:** a second `createCharacter` without the flag leaves
> state byte-identical (prior save versions intact); the fresh-sandbox onboarding flow is unaffected. Open a PR.

### B37 — one competition authority (`runCompetition`/`resolveCompetition` delegate)  ·  Claude Code  ·  **Wave 1 · audit A1 + A3** — ✅ DONE

> **DONE.** The two-resolver fork is gone. `liveSeason` now owns the single competition resolution
> (`resolveHoh`/`resolveVeto` + a non-mutating `peekCompetition`), and `GameSessionAdapter.runCompetition`
> only PREVIEWS it — the loop (`advanceGame`) crowns the same winner (same seed). It validates references
> (unknown/evicted ids → null) and ignores foreign input (caller subset/stats never used); the win is
> recorded by the loop and survives restart. `momentPrompts.ts` steers ceremony comps to `advanceGame`.
> `tests/unit/runCompetition.test.ts` (9, incl. preview==crown, evicted-never-crowned, survives-restart).
> Original prompt below.

> In `Psychout-Media/orwell` (TS engine), eliminate the two-resolver fork. `runCompetition` (`GameSessionAdapter.ts:418-438`)
> resolves over the **full roster incl. evicted HGs**, accepts arbitrary caller `participantIds`, and records/persists
> **nothing**, while the real HOH/veto winner is computed independently in `advanceGame` with a **different** RNG stream —
> so the narrator can announce winner X while the loop crowns Y (the GM prompt tells it to call both,
> `momentPrompts.ts:76-84`). Per remediation principle #1 (single outcome authority) + #3 (validated references):
> during a live game make `runCompetition`/`resolveCompetition` **delegate** to the loop's already-resolved beat (or
> advance it) — **ids only**, stats resolved from the live house, unknown/evicted ids rejected, foreign fields ignored —
> and **record + persist** a `competition` event. Update `momentPrompts.ts` to steer ceremony comps to `advanceGame`.
> **Acceptance:** unit — at `hoh-competition`, `runCompetition(...)` then `advanceGame()` name the **same** winner; no
> `evictionOrder` member in any pool; caller-supplied stats are ignored; the win is in the event store and survives
> restart. Open a PR.

### B38 — fold hidden consequence into the ceremony beats  ·  Claude Code  ·  **Wave 1 · audit C1 (the consequence-loop hole)** — ✅ DONE

> **DONE.** A `CEREMONY_IMPACTS` table (`relationshipConstants.ts`) maps each consequential act to an
> existing `InteractionType`, and `GameSessionAdapter.foldCeremonyConsequence` applies engine-owned
> directed folds in the commit path: nomination ⇒ nominee→HOH adverse; veto save ⇒ saved→holder bond;
> replacement ⇒ replacement→HOH betrayal-shock-if-trusted; eviction ⇒ evictee→(HOH+voters) adverse +
> survivors→outgoing-HOH threat; comp win ⇒ house→winner threat. Magnitudes come only from the
> constants module; the move persists across restart and never reaches a player surface (0001 canary).
> `tests/unit/ceremonyConsequence.test.ts` (3). Original prompt below.

> In `Psychout-Media/orwell` (TS engine), the 0023 backbone is bypassed by the weekly loop itself: `liveSeason.ts` only
> **reads** relationships — nominations, veto saves, replacements, and eviction votes move no trust/affinity/threat
> (`ConsequenceEngine.recordVoteAgainstPlayer`/`recordCompetitionWin` have zero production callers). The game's most
> consequential acts are the only ones with no consequence. Per remediation principle #4 (folds in the commit path,
> magnitudes in constants): add a `CEREMONY_IMPACTS` table to `relationshipConstants.ts` and apply engine-owned
> directed folds in the commit/advance path — nomination ⇒ nominee→HOH adverse (threat▲ trust▼); veto save ⇒ saved→holder
> bond; replacement ⇒ replacement→HOH betrayal-shock if trusted; eviction ⇒ evictee→(HOH+voters) adverse + survivors'
> threat reads; comp win ⇒ everyone's threat▲ toward the winner. **Acceptance:** unit — after a player-HOH nomination via
> `submitDecision` the nominees' hidden edges toward the player worsen and **persist across snapshot/restore**;
> magnitudes come only from the constants module; **no number appears on any player surface** (extend the 0001 canary).
> Read `docs/features/0023`, `0026` first. Open a PR.

### B39 — anchor surfaced facts; validate recorded interactions  ·  Claude Code  ·  **Wave 1 · audit A4 (+ spec amend 0002/0009)** — ✅ DONE

> **DONE.** (a) `surfaceInformationTo` is anchored: `told-by:<id>` requires the teller to hold or have
> witnessed the fact, `overheard:<eventId>` requires the event to exist — else it is downgraded to a
> **suspicion** (returns null), never knowledge; and it now persists (`onPersist`). (b) `recordInteraction`
> refuses any initiator/witness that is not a LIVING houseguest (a `livingProvider` wired from the session)
> and caps per-call folds. Specs 0002/0009 amended. `tests/unit/knowledgeIntegrity.test.ts` (6). Prompt below.

> In `Psychout-Media/orwell` (TS engine), close the anti-sycophancy hole where the narrator mints ground truth.
> `surfaceInformationTo` accepts any `fact.content` + free-string `pathway` with no check that the claimed teller holds
> the fact or that a pathway event exists (and never persists); `recordInteraction` lets the caller set
> initiator/witnesses/kind/**direction** freely. Per principle #3: (a) require a surfacing's `pathway` to reference a
> **real** fact the claimed teller holds (`told-by:<id>` where `knowledge.knownTo(id)` matches) or an `overheard:<eventId>`
> that exists with the claimed speaker as witness — otherwise record a **suspicion**, not knowledge; add `onPersist`.
> (b) `recordInteraction`: require initiator/witnesses to be **living** houseguests; cap per-turn folds. Amend
> `docs/features/0002` / `0009` to pin the contract. **Acceptance:** unit — an unanchored surfacing is downgraded/refused;
> an interaction naming an evicted houseguest is refused; every player-known fact traces to a recorded source. Open a PR.

### B40 — complete the durable snapshot (knowledge + suspicions + counters + version)  ·  Claude Code  ·  **Wave 1 · audit C2 + C3 + C4** — ✅ DONE

> **DONE.** The knowledge layer now round-trips: `InMemoryKnowledgeService.serialize/load` (facts +
> suspicions + seq/tick) ride in `SessionSnapshot`, `toGameState().knowledge` is populated (the 0031
> checkpoint counts it), `recordInteraction` derives id+ts from the store size (restart-safe — no more
> duplicate ids), and `InMemoryEventStore.record` throws on a duplicate id. A `snapshotVersion` is
> written + validated: an unknown/future version is rejected into a fresh sandbox (no crash), a
> versionless legacy save migrates forward. `tests/unit/snapshotCompleteness.test.ts` (5). Prompt below.

> In `Psychout-Media/orwell` (TS engine), the knowledge layer is **not in the snapshot**: `exportSnapshot` = core + events
> + relationships only; restore builds a fresh empty `InMemoryKnowledgeService`; `toGameState` hardcodes `knowledge: []`
> (`sessionSnapshot.ts:76`) so the 0031 superset checkpoint is structurally **blind** to the loss — after a restart,
> everything houseguests told the player is gone (a silent mandate-#4 violation). Per principle #6 (the snapshot is the
> contract): (1) serialize **knowledge + suspicions** (and the `seq`/`tick` id counters — they restart at 0 today,
> producing **duplicate event ids** the dup-less store accepts and the id-keyed `isSuperset` mis-counts) into
> `SessionSnapshot`; populate `toGameState().knowledge` so the checkpoint guards it; make `InMemoryEventStore.record`
> **throw on duplicate id**. (2) Add a **`snapshotVersion`** field; validate + migrate-or-fault in
> `loadLatest`/`importSnapshot` (an unknown/missing version is a recorded fault, never a silent mis-restore).
> **Acceptance:** restart test — surface a fact + record a DR entry ⇒ new registry over the same dir ⇒ both knowledge
> facts return; pre/post-restart interactions get **distinct** ids + monotonic ts; the checkpoint flags a snapshot whose
> knowledge shrank; an unknown-version snapshot is rejected, not crashed on. Read `docs/features/0007`, `0030`, `0031`
> first. Open a PR.

### B41 — make the orchestrator the real per-sandbox spine  ·  Claude Code  ·  **Wave 1 · audit E3 (+ fixes D4 flood)** — ✅ DONE

> **DONE.** The registry's save-on-mutation `onPersist` now routes through `Orchestrator.commitPlayerTurn`
> (`registry.setCommit`, wired in `composeRuntime`): every player mutation runs the fail-closed integrity
> checkpoint — a leaky/degrading commit is rolled back and NOT persisted — and `touch`es the user.
> `idleSince` returns `+Infinity` for a never-active user (not-yet-idle), so the watcher stops flooding
> off-screen ticks mid-scene; in pure turn-driven mode (`tickEveryMs:0`) each turn fires one bounded
> off-screen tick so the house still lives. Health reports `lastTrigger:"player-turn"`.
> `tests/unit/orchestratorSpine.test.ts` (4). Original prompt below.

> In `Psychout-Media/orwell` (TS engine), player turns **bypass** the orchestrator — nothing outside tests calls
> `advance(user,"player-turn")`/`touch`, so the fail-closed integrity checkpoint (0031) **never runs on a player action**
> (a leaky/degrading player-turn commit persists immediately via `onPersist`), and because `touch` never fires
> `idleSince` is `-Infinity` so the watcher's idle gate is **always true** (off-screen ticks flood every wake, even
> mid-scene — audit D4). Per principle #5 (the orchestrator is the real spine): route mutating player-channel tool calls
> through `Orchestrator.advance` (or make the registry's `onPersist` a **checkpoint-then-save**), and `touch(user)` on
> every player call; treat never-active as **not-yet-idle**; in turn-driven mode (`TICK_MS=0`) trigger one **bounded**
> off-screen tick per player turn (audit D4/M6). **Acceptance:** a leak-injecting `submitDecision` (test seam) is rolled
> back and **not** persisted; an actively-calling user accrues **no** off-screen ticks until `idleTickAfterMs` after their
> last call; with `tickEveryMs:0`, N player turns ⇒ hidden-event count still grows; health shows `lastTrigger:"player-turn"`
> after a real HTTP player call. Read `docs/features/0031`, `0035` first. Open a PR.

### B42 — make the sentinel canary bite the live game  ·  Claude Code  ·  **Wave 1 · audit E8 (+ m12)** — ✅ DONE

> **DONE.** `tests/property/liveSentinel.property.test.ts` wires the sweep to the **registry resolver's**
> object graph (not a standalone adapter), plants unique sentinels into every kind of live hidden state
> (NPC backstory + soul memory via snapshot→restore, the SoulStore, a hidden event, the Vault, another
> NPC's knowledge), proves they're genuinely planted, then drives a full game to a winner sweeping
> **every** player + admin tool — including the finale — for a leak. The finale-projection lock is
> asserted (no pre-reveal winner; no `votes`/`script`/`tally` serialized). Coverage check asserts every
> `PLAYER_TOOLS`/`ADMIN_TOOLS` name was swept. Original prompt below.

> In `Psychout-Media/orwell` (TS engine), the sentinel sweep (`mcp.property.test.ts`) runs against a **standalone** adapter
> disconnected from the sentinel fixture, so for `advanceGame`/`submitDecision`/`gameStatus`/`playerTagline`/
> `socialInitiatives`/`getGameState`/`getMomentPrompt`/`runCompetition` the canary **can never fire** — the live hidden
> state these could leak (relationship numbers, NPC stats/souls, pre-reveal finale tally) carries no sentinel; the only
> live guard is the UAT's four format-coupled regexes, and the orchestrator's leak sweep is substring-only over hidden
> event content (won't catch numbers/soul text/tally). Per principle #7 (gates on the production path): build the sweep
> over a **registry-built** sandbox whose generated hidden stats/soul text/relationship-derived strings embed sentinels
> (engine-side post-process of `CharacterFactory` output), sweep **all** `PLAYER_TOOLS`/`ADMIN_TOOLS` incl. the full
> finale, and add a finale-projection lock (`finaleView.reveals.length === revealIx`; no `votes`/`script` serialize
> pre-reveal). **Acceptance:** every tool name appears in a sentinel sweep wired to the **same object graph the resolver
> serves**; a planted sentinel in any hidden field fails the sweep. Open a PR.

### B43 — 0045 endgame structure (Final 5 → Final 2)  ·  Claude Code  ·  **Wave 2 · audit B1 · NEEDS SPEC FIRST** — ✅ DONE

> **DONE.** The veto field degrades (`vetoFieldSize = min(6, remaining)`; the draw already yields it,
> now asserted at F5/F4); Final 4 resolves on the sole non-HOH/non-nominee vote; and **Final 3 is a
> final-HOH personal eviction** — `liveSeason` skips nominations/veto, runs a final-HOH competition
> (outgoing-HOH restriction lifted), and the final HOH evicts one of the other two via a new
> `final-eviction` binding decision (pending for the player; argmax-threat for an NPC; manner recorded).
> No empty-electorate 0–0 path remains. 0005 prose amended; 0011/0034/0037 stay green.
> `tests/unit/endgame.test.ts` (7) + `0045-endgame-structure.feature` (6, in `cucumber.cjs`). Prompt below.

> Draft and implement **feature 0045** (`docs/features/0045-endgame-structure.{md,feature}`). Today the late game is
> mathematically broken: 0005 demands a veto field of **exactly six** (impossible at F5/F4), and **Final 3 is not
> modeled** — at 3 active the loop runs a full nomination/veto week ending in `evictionVoters = ∅` ⇒ a permanent 0–0
> "tie" silently resolved by `npcChoice(hoh)` (`liveSeason.ts:224-228`). Amend 0005 with **field-size degradation**
> (veto field = `min(6, remaining)`; at **F4** the veto holder is the **sole** eviction vote) and add the **F3** branch
> (skip nominations/veto; a final-HOH competition; the final HOH personally evicts via a new `final-eviction`
> `submitDecision` kind — pending if the player, relationship-driven if NPC, manner recorded). Per principle #2 (the
> pending-decision seam). **Acceptance:** a seeded season reaches F2 with **every** late-week ceremony legal under the
> amended predicates; player-as-final-HOH gets the binding choice; eligibility invariance under temperature preserved;
> 0011/0034/0037 scenarios stay green. Read `docs/features/0005`, `0011`, `0034`, `0037` first. Open a PR.

### B44 — player-HOH eviction tie-break (pending decision)  ·  Claude Code  ·  **Wave 2 · audit B2** — ✅ DONE

> **DONE.** `liveSeason` splits the eviction tally (`countEvictionVotes` → `resolveEvictionBeat` →
> `commitEviction`): on a tie, if the HOH is the **player** the loop PAUSES on a new `tie-break` pending
> decision (the two nominees are the options; illegal pick refused) instead of the silent
> `npcChoice(player)`. An NPC HOH still auto-resolves; the decision survives a restart. Ports + adapter
> gain the `tie-break` kind; every full-game driver/UAT handles it (terminal `else` is now kind-generic
> so tie-break/final-eviction can't hang a drive). `tests/unit/tieBreak.test.ts` (4). Prompt below.

> In `Psychout-Media/orwell` (TS engine), a player HOH **never** breaks a tied eviction vote: `npcChoice(s.hoh!)` fires even
> when `s.hoh === ctx.player` (`liveSeason.ts:178-182`), deciding via the **hidden** player→NPC threat edges the player
> has never seen (an agency + anti-sycophancy violation; guaranteed at F3, common at F5). Add a **`tie-break`** pending
> decision kind (per principle #2): on an even tally with the player as HOH, pause and return the two nominees as the
> legal set; resume with the player's pick. NPC HOHs still resolve automatically. **Acceptance:** unit — player HOH +
> engineered tied NPC votes ⇒ loop pauses with `tie-break`; an illegal pick is refused; the chosen nominee is evicted;
> restart mid-pending resumes (0030). Open a PR.

### B45 — "Houseguest's Choice" pauses for the player  ·  Claude Code  ·  **Wave 2 · audit B4** — ✅ DONE

> **DONE.** `vetoParticipants` gains `playerChoosesOwn`: when the PLAYER draws the chip the draw
> **defers** (no `picked`, field a player short) instead of `chooseStrongestBond` reading the player's
> hidden bonds. `liveSeason`'s veto beat pauses on a new `houseguests-choice` pending decision (the
> candidates are the options); on the player's pick the field completes and the veto comp resolves
> (`applyDecision` now takes the beat rng so the resume is deterministic). An NPC draw still auto-picks;
> `peekCompetition` returns null while deferred; survives a restart. Ports + adapter + drivers/UAT
> updated. `tests/unit/houseguestsChoice.test.ts` (4). Original prompt below.

> In `Psychout-Media/orwell` (TS engine), the veto draw auto-picks for the player: `liveSeason.ts:368-371` passes
> `chooseStrongestBond` **unconditionally**, so when the player draws the chip the engine picks the sixth player using
> the player's **hidden** bond edges (canon says the player "may hold Houseguest's Choice if drawn"). Make the
> veto-competition beat two-phase (principle #2): run the draw; if `houseguestsChoice.holder === player`, set a
> **`houseguests-choice`** pending with the legal candidate set **before** resolving the comp; resume with the player's
> pick. NPC holders keep `chooseStrongestBond`. **Acceptance:** unit — a seeded draw giving the player the chip pauses
> the loop with the legal candidates; an illegal pick is refused; an NPC holder still auto-picks; the resolved 6-player
> field includes the pick; restart mid-pending resumes. Open a PR.

### B46 — live competition intent (compete / throw / play safe)  ·  Claude Code  ·  **Wave 2 · audit B5** — ✅ DONE

> **DONE.** A `comp-intent` pending fires before each comp the player plays (HOH if eligible, veto if a
> puller); `winnerOf` threads the player's declared intent into a real `CompetitionIntents` (the 0028
> throw/play-safe penalties); NPCs stay compete. The intent is consumed when the comp resolves and is
> immutable after (the pending is cleared ⇒ a late declaration is refused); survives a restart. The
> pending's `options` ARE the three intents (compete first = default), so the generic decision path +
> front-end pick from them. 0034 amended. `tests/unit/compIntent.test.ts` (4) — throw measurably lowers
> the player's win rate across seeds; the lock refuses post-beat intent. Original prompt below.

> In `Psychout-Media/orwell` (TS engine), the player **never declares competition intent** — every live resolution builds an
> empty `CompetitionIntents` (`liveSeason.ts:136`, `GameSessionAdapter.ts:435`), so the Bible-mandated, immutable
> compete/throw/play-safe choice (and the `throwPenalty`/`playSafePenalty` constants) is dead. Surface a **`comp-intent`**
> pending decision before each comp the player plays (default `compete` if skipped) and thread the `CompetitionIntents`
> into `winnerOf`; the immutability lock already exists in `competitionOutcome.ts` — feed it a real map. Amend
> `docs/features/0034`. **Acceptance:** unit — a declared `throw` measurably lowers the player's live win rate across
> seeds; intent submitted **after** the beat resolves is refused (lock); NPC intents may stay `compete` for now. Read
> `docs/features/0006`, `0034` first. Open a PR.

### B47 — jury manner applies to the player; symmetric finale appeals  ·  Claude Code  ·  **Wave 2 · audit A5 + A6** — ✅ DONE

> **DONE** (built **per the RULING below**). **A5:** `recordEvictionManner` no longer exempts the player —
> when the player is a responsible houseguest (HOH/evict-voter), the evictee records their manner toward the
> player like any NPC, so jury management cuts both ways (and the evictee→player resentment folds into the
> hidden layer at eviction, 0023). **A6 (ruling 1):** `runFinale` now has **every juror question BOTH
> finalists** (9×2 = **18** Q&A) — the player-finalist answers all 9 themselves, the NPC uses `bestAppeal`
> for all 9. No `(finalist, juror)` pair is ever unanswered, so the asymmetry vanishes at the root and the
> `appealMade` back-fill is a never-hit safety guard; CLAUDE.md's per-finalist canon stands. **Ruling 2:**
> the jury/finale magnitudes are extracted to **`src/engine/juryConstants.ts`** (`JURY_WEIGHTS`, signed
> `MANNER_LEAN`, `MANNER_THRESHOLDS`, `APPEAL`) — extraction only, 0037 calibration unchanged. Tests:
> the player records manner toward a juror they evicted + a juror they blindsided votes for them less (A5);
> the 18-Q&A leaves no unanswered pair + identical reads ⇒ a coin flip (A6 symmetry); choreography asserts
> 18 questions. 0014/0037 specs updated. *(An earlier build of this item shipped the pre-ruling 9-Q + neutral
> approach in #142; this is the ruling-compliant correction.)* Original prompt below.

> In `Psychout-Media/orwell` (TS engine), jury management — the signature mechanic — is **inert against the player**:
> `liveSeason.ts:209` skips recording eviction **manner** toward the player, so `juryLean`'s second-largest term
> (betrayed −0.6 / blindsided −0.5) is structurally **zero** for a player-finalist while fully applying to NPC finalists.
> Separately, `appealMade` back-fills `bestAppeal` for every **unasked** (finalist, juror) pair **including the player's**
> (`liveSeason.ts:250-257`) — the engine plays the player's finale **optimally** for the half of the jury they don't
> answer. (1) Delete the `r === ctx.player` manner exemption (the finale `mend` appeal already exists for redemption).
> (2) Score unasked pairs as a **neutral** default (or ask both finalists per juror), scoring player and NPC finalists
> **symmetrically**; resolve the canon line (CLAUDE.md says one question per juror *per finalist* = 18; Bible + code say
> 9 — pick one in `docs/features/0014`/`0037`). **Acceptance:** unit (mirroring the existing manner test with the player
> as the responsible finalist) — a juror the player blindsided votes for them measurably less; player and NPC finalists
> are scored symmetrically. Read `docs/features/0014`, `0037` first. Open a PR.
>
> **RULING (2026-06-10, supersedes the open choices above — build exactly this):**
> 1. **A6 = each juror questions BOTH finalists** (9×2 = **18** Q&A): `runFinale`'s `questions`
>    becomes every juror × every finalist (today `jury.ts:164` alternates `finalists[i % 2]`). The
>    **player-finalist answers all 9 themselves** (pend `finale-answer` per question); the NPC
>    finalist uses `bestAppeal` for all 9. No "unasked" pairs exist ⇒ the asymmetry vanishes at the
>    root; CLAUDE.md's "one question per juror" *per finalist* canon stands (no doc change needed).
>    Keep the `appealMade` back-fill (`liveSeason.ts:313-320`) as a never-hit safety guard.
> 2. **Extract `src/engine/juryConstants.ts`** (mirror `relationshipConstants.ts`): the manner
>    weights (betrayed −0.6 / blindsided −0.5 / respected +0.4 / disrespected −0.4, `jury.ts:48-51`),
>    `JURY_WEIGHTS` (`jury.ts:38`), the manner thresholds `TRUST_BETRAYAL`/`THREAT_BLINDSIDE`
>    (`liveSeason.ts:246-247`), and the appeal magnitudes (`jury.ts:82-93`). Extraction only — no
>    number changes; keeps the 0037 calibration green.
> *Current anchors (audit line numbers drifted):* the A5 player exemption is now
> `liveSeason.ts:261` (`if (r === evictee || r === ctx.player) continue;` in `recordEvictionManner`,
> called from `applyEviction:279` — covers the 0045 final-eviction too). *Test deltas:* the
> finale-count test (`liveSeason.test.ts:246-261`) now expects **9** player `finale-answer` stops
> (was even-indexed ~5); add the A5 test mirroring the manner-effect pattern at
> `liveSeason.test.ts:276-296` with the **player** as the responsible finalist.

### B48 — 0046 player eviction & the juror's seat  ·  Claude Code  ·  **Wave 2 · audit B6 · NEEDS SPEC FIRST** — ✅ DONE

> **DONE.** Feature 0046 built & green (in `cucumber.cjs`). `GameStateView.player.status` now marks the
> player `active` → `jury` (evicted into the last-9 jury — derived from the public eviction order + cast
> size) or `evicted` (pre-jury); the projection switches `moment` to a `jury` / `evicted` `MOMENT_PROMPTS`
> fragment. **Juror knowledge model = ceremonies-as-broadcast** (the spec's recommendation, made canonical):
> a sequestered juror keeps witnessing the PUBLIC ceremony beats (non-hidden house-events) and nothing
> private — already enforced by the 0002 witness model (off-screen scenes + confessionals exclude the
> player), so the juror's knowledge provably contains only the broadcast facts. The season completes for ANY
> eviction index (the loop plays NPCs to Final 2 + a winner without the player), and a player evicted into the
> jury still casts their own vote at the 0037 finale; out-of-game status survives a restart. `tests/unit/
> playerEviction.test.ts` (6) + the name-agnostic `.feature`. The pre-jury terminal recap ties to 0048
> (out of scope). Original prompt below.

> Draft and implement **feature 0046** (`docs/features/0046-player-eviction-and-jury.{md,feature}`) — the game's most
> common ending has **no spec**. Spec the player-evicted paths: **pre-jury** ⇒ a closure beat + a defined season-end
> state (ties to B56/0048); **jury** ⇒ a defined **juror knowledge model** (jurors witness ceremonies-as-broadcast only,
> or nothing + evictee gossip — pick one and wire it into `KnowledgeState`; this also fixes 0014's "jurors observe the
> remainder", which is incompatible with the 0002 witness model), bounded spectate/fast-forward pacing to the finale,
> then the existing 0037 juror interactivity. Add `player.status: "active" | "jury" | "evicted"` to `GameStateView` and a
> `MOMENT_PROMPTS` fragment for spectating/jury (today the projection never marks the player out — `GameSessionAdapter.ts:441-463`).
> **Acceptance:** a season where the player is evicted at **any** index completes; juror knowledge provably contains only
> the defined-pathway facts; the Vault Wall holds throughout; the post-eviction view marks the player and
> `momentForPhase` selects the jury framing. Read `docs/features/0002`, `0014`, `0037` first. Open a PR.

### B49 — 0047 eviction night live (reveal + goodbye messages)  ·  Claude Code  ·  **Wave 2 · audit B7** — ✅ DONE

> **DONE** (the 0047 spec already existed — built straight from its §8; the "NEEDS SPEC FIRST" tag was
> stale). The weekly eviction is staged through the 0034 seam like the finale: a new `EvictionProgress`
> sub-state machine in `liveSeason.ts` reveals the (engine-decided) votes ONE AT A TIME in a seeded order
> (`applyEviction` split into `recordEvictionManner` + `removeEvictee` + `rollWeek` so the week-roll defers
> past the goodbyes), then an evictee goodbye + goodbye messages from a seeded selection whose
> relationship-derived tone (warm/respectful/cold) folds into the evictee's manner (jury lean, 0014). A
> Vault-free `EvictionView` (`{stage, nominees, votesRevealed}`) lands on `AdvanceView` — names + the votes
> read so far only, never a pre-reveal tally or the evictee before the last vote. **No new pending decision
> kind** (eviction-vote / tie-break unchanged) ⇒ no FE relay mirror needed. `tests/unit/evictionNight.test.ts`
> (6) + the name-agnostic `.feature`; the tie-break/eviction unit tests updated to drive through the reveal.
> Original prompt below.

> Draft and implement **feature 0047** (`docs/features/0047-eviction-night-live.{md,feature}`). The weekly eviction —
> the show's defining beat, ~13×/season — emits one line (`liveSeason.ts:403`); the finale got staged choreography (0037)
> but evictions didn't. Stage it through the **0034 seam** like 0037: an **ordered, one-at-a-time vote reveal**
> (revealed-only tally — never a pre-reveal winner), an **evictee goodbye** beat, and **goodbye messages** from selected
> houseguests recorded as events that feed eviction **manner** (0037 §4.2) and **jury lean**. Reveal order is
> engine-decided + seeded (principle #1). **Acceptance:** reveal order is deterministic by seed; **no** pre-reveal tally
> leaks (extend the 0001 canary); a respectful vs. cold goodbye **measurably** moves the evictee's juror lean. Read
> `docs/features/0034`, `0037`, `0014` first. Open a PR.

### B50 — live NPC hidden elements (generation)  ·  Claude Code  ·  **Wave 3 · audit D1** — ✅ DONE

> **DONE.** The production `Character` now carries `hiddenElements: HiddenElement[]` — `generateHouse` mints
> **3–6 distinct, seeded, typed** elements per NPC (`secret-motive` / `pre-game-tie` / `concealed-aptitude` /
> `divergent-persona`) off a **side rng** (hashed off the name) so the main house stream stays byte-stable
> (stats/names/0007); the player's is empty (they author `privateStrategy`). `richOffscreenStretch` takes a
> `hiddenElementsOf` lookup and, gated by `hiddenSurfaces` on a **per-scene side rng** (zero perturbation of
> the existing off-screen stream), occasionally slips one element into the scene's HIDDEN content — the
> orchestrator's off-screen tick wires it. Engine-side throughout (NPC `Character` is never projected); the
> element reaches the player only if a later pathway carries it. `tests/property/hiddenElements.property.test.ts`
> (3): every NPC has 3–6 distinct elements + the player none; seed-reproducible; over a season the surfacing
> rate sits at the configured ~5% and **no** detail crosses to the player projection / their witnessed events.

> In `Psychout-Media/orwell` (TS engine), live NPCs have **no hidden elements at all** — the production `CharacterFactory`
> (`characterFactory.ts:56-73`) generates archetype/style/stats/background only; "tons of hidden elements" exist solely in
> the 0003 **test stub** (`characters.ts` HIDDEN_POOL), and `hiddenSurfaces()` has no production caller, so the rare-reveal
> "treat" loop (a pillar of 0003 + the mandate) **cannot occur in a real game**. (Distinct from 0041, which is soul
> *evolution*.) Extend `generateHouse` to mint **3–6 seeded, typed** hidden elements per NPC (secret motive, pre-game tie,
> concealed aptitude, divergent persona…) stored **engine-side** (Vault/Soul), and wire `hiddenSurfaces(rng)` into
> off-screen scenes/conversations so an element occasionally enters event content (hidden until a pathway carries it).
> **Acceptance:** property test on the **live** path — every seeded house has ≥3 hidden elements per NPC; over a season
> ≤ `hiddenSurfacingRate` of moments surface one; the player projection contains **none** without a pathway event;
> same seed ⇒ same elements. Read `docs/features/0003`, `0024` first. Open a PR.

### B51 — wire the emotional modifier into live competitions  ·  Claude Code  ·  **Wave 3 · audit D2** — ✅ DONE

> **DONE.** The core was already live via **0041** (the line refs below are stale): `ctx.emotionalOf` feeds
> the live soul `emotionalState` into `winnerOf`/the 0028 modifier, `evolveFromBeat` inflects comp wins / ally
> blindsides, mean-reversion + snapshot are in place. This closes the two real gaps: **(1) nominated ⇒
> negative** — a new `"nominated"` `EmotionalEvent` (valence −0.35) inflected at the live `nominations` (and
> the veto-ceremony replacement) beat, so a nominee carries the rattle INTO the veto and their odds dip below
> their calm baseline; **(2) `rel.decay(DECAY_RATE)` on week rollover** (audit C5) — the previously-uncalled
> decay now runs on each `eviction-result` beat, eroding untended extreme edges toward baseline so the house
> doesn't pin over a season. `tests/unit/emotionalModifierLive.test.ts` (6): a rattled competitor wins the
> veto measurably less than at baseline; the live nominees' state drops once the ceremony resolves; a season
> of rollovers decays pinned edges toward neutral; same seed ⇒ identical trajectory; snapshot/restore preserves
> states. (`season.ts` stays 0.5 — it is the test-only one-shot sim, no soul source.)

> In `Psychout-Media/orwell` (TS engine), the emotional modifier is structurally **zero** on every live comp —
> `emotionalState: 0.5` is hard-coded for every competitor (`liveSeason.ts:135`, `season.ts:78`), `emotionalModifier()`
> has no production callers, and nothing updates a soul's emotional state — so the Luck-replacement ADR exists only in
> tests (this is the comp-input wiring, distinct from KNOWN 0041 storage). Track per-houseguest `emotionalState` in the
> session (seeded at `soul.emotionalBaseline`), update it via `emotionalModifier(current, circumstance, temperatureRoll)`
> at consequential beats (nominated ⇒ negative, comp win ⇒ positive, ally evicted ⇒ negative; constants in
> `temperatureConstants.ts`), and pass it into `winnerOf`; also call `rel.decay(DECAY_RATE)` on week rollover (audit C5).
> **Acceptance:** unit — a nominee's veto win rate is measurably **below** their non-nominated baseline across seeds;
> states **mean-revert** when calm; same seed ⇒ same trajectory; snapshot/restore preserves states. Read
> `docs/features/0006`, `0028`, `0026` first. Open a PR.

### B52 — evicted houseguests stop living  ·  Claude Code  ·  **Wave 3 · audit D5** — ✅ DONE

> **DONE.** Of the three pools, `runCompetition` already excluded evictees (caller ids validated against
> `evictionOrder`; the default field is the loop's `s.active`). The two real leaks are closed: the
> **off-screen society** (`orchestrator.ts` `defaultApply`) now filters the pool to LIVING NPCs
> (`!evictionOrder`), so no evictee schemes, folds relationships, or confessions after leaving (the stretch is
> skipped when too few remain to pair, and the day-event guards an empty pool); and **`socialInitiatives`**
> now draws approaches only from living NPCs, so an evictee never "wants a word." `tests/unit/evicteesStopLiving.test.ts`
> (3): post-eviction off-screen scenes/confessionals never name an evictee (and the living house DID keep
> scheming — non-vacuous); no evictee is ever offered as an approach; an evictee is rejected as a competition
> participant and never the default winner. Jury still forms from `evictionOrder` — they stop ACTING, not existing.

> In `Psychout-Media/orwell` (TS engine), evictees keep scheming: the off-screen pool (`orchestrator.ts:206-207`),
> `socialInitiatives` (`GameSessionAdapter.ts:156-168` / `conversation.ts:57-65`), and `runCompetition`'s default pool
> (`:424-427`) all ignore `live.evictionOrder` — so an evicted houseguest folds relationship impacts, gives confessionals
> ("I need X gone"), and can "want a word with you" weeks after leaving (a fidelity break the player will notice). Filter
> all three pools by `evictionOrder` (and `active` once B43 lands). **Acceptance:** unit — no evictee id appears in
> off-screen scenes/confessionals/initiatives/competition pools after eviction. Open a PR.

### B53 — fire reserve twists in the live game (+ double-eviction mechanics)  ·  Claude Code  ·  **Wave 3 · audit D6 + B8 · ✅ DONE 2026-06-10**

> **Built to green.** `createCharacter` loads + seals the schedule (`live.reserve`, engine-only, persisted) and the
> registry writes the Vault `reserved-twist` audit copy; `SessionSnapshot` now carries the **Vault** (audit I7) so
> seals survive a restart. `rollWeek` arms `maybeFireTwist(week)`; a sealed **double-eviction** fires at that week's
> eviction as a `twist-reveal` beat + a compressed second cycle in the SAME week (HOH → noms → veto → vote, hard
> rules verbatim — the outgoing HOH is excluded from the second crown; both evictions count for jury order; the
> per-beat rng is cycle-disambiguated). Only implemented kinds load (`double-eviction` today). Three live scenarios
> appended to 0025's .feature (+ amendments row) + `tests/unit/reserveTwistsLive.test.ts`. Original prompt below.

> In `Psychout-Media/orwell` (TS engine), 0025's reserve twists are computed but **never fire live** —
> `loadReserveTwists`/`maybeFireTwist` are referenced only by tests/BDD; nothing in composition loads, seals, or fires a
> twist, and `double-eviction` is a **label with no math** (`reserveTwists.ts`). (1) At `createCharacter`,
> `loadReserveTwists(count, seededRng)` into the sandbox's Vault (sealed from player **and** admin until it fires —
> extend the 0001 canary to both); persist it via `SessionSnapshot` (`InMemoryVaultStore` is wired but absent from the
> snapshot — audit I7). (2) In week rollover, `maybeFireTwist(week)`; implement at minimum **double-eviction** as a
> compressed second cycle (HOH→noms→veto→vote within the same "night") **reusing the hard rules verbatim**, and define
> its week/jury-order semantics (audit B8: one reign, two eviction ceremonies, both count for jury order). **Acceptance:**
> BDD — a seeded game with a loaded double-eviction fires it **exactly once** at the sealed beat; invisible to player +
> admin until fired; 0005 eligibility holds within the compressed cycle; the jury-9 / final-2 arc is preserved. Read
> `docs/features/0025`, `0005`, `0016` first. Open a PR.

### B54 — measure richness on the production path  ·  Claude Code  ·  **Wave 3 · audit D3 · ✅ DONE 2026-06-10**

> **Built to green.** `tests/property/liveRichness.property.test.ts` drives the REAL spine — a registry wired
> exactly like production (turn-driven `Orchestrator` as the commit delegate, so every player mutation runs the
> checkpoint + one off-screen tick) — across 20 seeds × 3 weeks and computes `liveRichnessMetrics` (new, in
> `src/engine/richness.ts`) from the sandbox's real `EventStore`: off-screen share ≥ 0.6, type diversity, typed-scene
> floor (FAILS if `defaultApply` stops recording scenes), alliance+churn life, hidden-layer movement, and a bounded
> reveal share counted STRUCTURALLY (`GameEvent.reveal` — set by `richOffscreenStretch`, no content parsing). The
> sim's `reveals = 1` back-stop is **deleted** (it asserted its own input); the 0003 sim gate stays green without it.
> Original prompt below.

> In `Psychout-Media/orwell` (TS engine), the 0003 richness property tests run `simulateSeason` (`simulation.ts`, **no
> production callers**) which force-sets `reveals = 1` if none surfaced (`:113-115`) and whose `offscreenProb` is both the
> generator input and (effectively) the asserted threshold — **the test asserts its own input**, and the live game could
> drop to zero off-screen life with every gate green. Per principle #7: re-point the richness metrics at the **live
> spine** — a property test driving `Orchestrator.advance` + `advanceGame` over a full seeded season (the UAT path) that
> computes `richnessMetrics` from the sandbox's **real EventStore**; delete the `reveals=1` back-stop (or assert it never
> triggers). **Acceptance:** the richness property test consumes only production-path events; offscreen-share / type-
> diversity / surfacing thresholds hold across ≥20 seeds; the test **fails** if `defaultApply` stops recording typed
> scenes. Read `docs/features/0003` first. Open a PR.

### B55 — unify the season loop; ground relationship reads  ·  Claude Code  ·  **Wave 3 · audit D12 + C5 + C6 · ✅ DONE 2026-06-10**

> **Built to green.** ONE weekly-loop rulebook: `playSeason` is now a DRIVER over `newLiveSeason`/`advance`
> (new `src/engine/calibration.ts`), auto-answering player pendings with the loop's own NPC policy — the new
> exported `autoDecision` in `liveSeason.ts` (threat-ranked picks, trusted-save veto, bestAppeal finale answers).
> The duplicated `WEEK_PHASES`/`pendingNominationDecision`/`validateNominations` are DELETED from `season.ts`
> (now just the shared reads: chooseNominations(+WithMood), tallyJury); their BDD/unit consumers re-point at the
> live loop (the canonical-phase-order step now DRIVES a live week and asserts the observed beat order — it was a
> constant-equals-itself tautology). Seed realism (C5/C6): move-in reads start near BASELINE with seeded scatter,
> the threat prior leans on the PUBLIC archetype menace (`archetypeMenace`), confidence starts BELOW the knowledge
> threshold (a day-one read is a HUNCH), and `dispositionOf(archetype)` is finally WIRED into the live model at
> create + restore (derived from the persisted Character — no extra serialization). Constants in
> `RELATIONSHIP_CONSTANTS.MOVE_IN`. Original prompt below.

> In `Psychout-Media/orwell` (TS engine), the calibration sim (`season.ts`) **diverges in rules** from the live loop —
> `vetoParticipants` without the Houseguest's-Choice chip, different comp types, no manner/appeals, and dead duplicate
> decision helpers (`WEEK_PHASES`/`pendingNominationDecision`/`validateNominations`) — so the 0006 calibration + outcome
> property tests verify mechanics the player **never plays**. Either implement `playSeason` **as a driver over**
> `newLiveSeason`/`advance` (auto-answering player pendings with NPC policy) or delete the duplicated helpers and document
> the sim as **calibration-only**; the outcome/calibration suites must exercise the same `advance` the live game runs.
> While here, fix the **seed realism** (audit C5/C6): seed first impressions near baseline with **archetype-informed**
> threat priors and `confidence < knowledge threshold` (today uniform [0,1] at confidence 0.5 ⇒ day-one hunches count as
> firm knowledge); wire archetype→disposition and serialize it; call `decay()` on week rollover (if not already done in
> B51). **Acceptance:** one source of weekly-loop truth; the calibration property green against the live `advance`; move-in
> reads are **suspicions**, threat priors correlate with public archetype. Open a PR.

### B56 — 0048 season retrospective & the Vault unsealing  ·  Claude Code  ·  **Wave 4 · audit G4 · ✅ DONE 2026-06-10**

> **Built to green** (spec was already drafted). `seasonRecap()` — the public arc assembled from the EVENT RECORD
> (`season:`/deal/betrayal events; stores, never narrator memory; Vault-free, any time) — and `seasonRetrospective()`
> — the ONE sanctioned Vault read, gated IN CODE on `live.finished` (null while live): every hidden event (off-screen
> scheming, confessionals, gossip) humanized + the sealed twists with fired/unfired weeks. Both on the `GameSession`
> port (Vault-free types), wired via `setRecordProviders` from the registry; player tools + manifest bullets + the
> `post-season` moment (the reunion special) + FE wiring (schemas/tags/keep/dispatch/client per the C13 drift test).
> Lifecycle: the finished snapshot archives intact; `resetUser` + the B36 guard start a new season cleanly. Canary
> scoping proven: sealed-while-live sweeps + unsealed-post-finale + cross-user isolation (unit + 5 BDD scenarios;
> 0048 added to `cucumber.cjs`). Pairs with **C17** (the FE surface). Original prompt below.

> Draft and implement **feature 0048** (`docs/features/0048-season-retrospective-and-unsealing.{md,feature}`) — the
> biggest *fun* payoff the corpus never discusses, and the finished-season lifecycle (0021's archive deferral was never
> picked up). **Product decision in the design note first** (recommended: yes, the Wall opens **post-season**, **only
> after** the winner event, **only** for that finished season, **player-triggered**). Then: (1) an end-of-season **recap**
> surface built from the **event record** (arc highlights — not narrator memory, principle #7); (2) the **unsealed hidden
> story** (off-screen scheming, confessionals, the twist that never fired) exposed via a dedicated post-season read tool;
> (3) the **finished → new-season** lifecycle (terminal state + a clean "start a new season" path, tying to B36's reset
> guard). **Acceptance:** unsealing is **impossible while a season is live** (the 0001 sentinel canary stays green
> pre-finale); the recap is generated from stores, not the narrator; the finished-season state is explicit and a new
> season starts cleanly. Pairs with **C17** (the FE surface). Read `docs/features/0021`, `0001`, `0007` first. Open a PR.

---

### C12 — front-end hotfixes: finale relay + engine-down fail-closed + reset guard  ·  Claude Code (front-end lane)  ·  **Wave 0 · audit B3 + F2 + A2 (FE)** — ✅ DONE (verified 2026-06-10: finale kinds in the relay schema, the 409 reset guard, `test_c12_finale_relay.py`)

> In `Psychout-Media/orwell` `frontend/`, three Wave-0 fixes. (1) **Finale is unplayable** — the agent relay's
> `submitDecision` enum allows only `nominations|veto-decision|replacement|eviction-vote` and hard-rejects everything
> else, **silently dropping** `statement`/`appeal` (`tool_schemas.py:1319`, `tool_implementations.py:4650-4653`), so any
> player reaching jury/Final 2 dead-stops — **the season can't be won**. Extend the schema enum with `finale-statement`/
> `finale-answer`/`juror-vote` + `statement` (string) and `appeal` (enum `own-game|mend|connect|discredit-rival`, per
> `src/engine/jury.ts:69`); extend `do_submit_decision`'s whitelist + forwarded keys. (2) **Engine-down mid-game fails
> open into an outcome-inventing chatbot** (`chat_helpers.py:551-569`): when a game-framed session loses the engine,
> fail **visibly-closed for game content** — inject a minimal "the feed is down, do not continue the game story; Big
> Brother will resume shortly" instruction and surface a HUD banner (never freeform narration). (3) Mirror **B36**'s
> `createCharacter` guard at `POST /api/orwell/new-game` (409 when started without an explicit `confirm`) and route
> restart through admin `manageSandbox reset`. **DoD:** a UAT-style FE test drives `finale-statement → finale-answer →
> juror-vote` to a crowned winner; engine-down + game-active history yields a refusal-to-continue framing; a second
> new-game on a started sandbox is refused. `pytest` green; engine gate unaffected. Open a PR.

### C13 — close the lever drift (`diaryRoom` + `socialInitiatives` agent tools)  ·  Claude Code (front-end lane)  ·  **Wave 4 · audit F1** — ✅ DONE (verified 2026-06-10: `test_c13_lever_drift.py` pins manifest↔FE)

> In `Psychout-Media/orwell` `frontend/`, the moment prompt advertises levers the agent **cannot pull**:
> `resolveCompetition`, `socialInitiatives`, `diaryRoom` are named in `momentPrompts.ts` but absent from
> `FUNCTION_TOOL_SCHEMAS`/`TOOL_TAGS`/`ORWELL_GAME_TOOLS` — so the **Diary Room in chat is narrated but never recorded**
> (only the HUD modal records — violating the hold-the-line rule) and the narrator can never spontaneously have an NPC
> approach the player (half the bidirectional-scenes mandate). Add `diaryRoom` + `socialInitiatives` to the schemas/tags/
> keep-set with `do_diary_room`/`do_social_initiatives` wrappers (the Python clients already exist in
> `orwell_engine.py:154-163`); either expose `resolveCompetition` or remove it from `BASE_GAME_MASTER_PROMPT`. Add a
> **drift test** asserting every player-channel tool in `registry.ts` (minus documented exclusions) has a FE schema and
> every lever named in the base prompt is callable. **DoD:** a "diary room" agent turn produces a **recorded** engine
> entry; `pytest` green; engine gate unaffected. Open a PR.

### C14 — game turns always act; clean the immersion bleed  ·  Claude Code (front-end lane)  ·  **Wave 4 · audit F3 + F6** — ✅ DONE (verified 2026-06-10: `test_c14_immersion.py`; restyle superseded by C19)

> In `Psychout-Media/orwell` `frontend/`, two play paths **narrate without ever acting** — sync `POST /api/chat` gets the
> moment prompt but **no tools/no escalation**, and `can_use_agent=False` users are flipped back to plain chat **after**
> game auto-escalation (`chat_routes.py:554-557,668-670`) — producing consequence-free imitation gameplay. For
> game-active sessions, **force the agent path** with tools collapsed to exactly `GAME_TOOL_KEEP` (game tools aren't a
> privilege surface — they're the game), or refuse game framing on tool-less paths (tie into C12's fail-closed framing).
> Also fix the **immersion bleed** (audit F6): under `game_build_enabled()`, restyle game-tool thread nodes diegetically
> (no raw `advanceGame`/JSON/`npc:7`/"engine error") and swap the appended "You are an AI assistant with tool access"
> preamble for a game-consistent one on game-framed turns (it currently **contradicts** the game prompt's "never say you
> are an AI"). **DoD:** a `can_use_agent=False` user's game turn still produces engine tool calls (or an explicit
> refusal); a rendered game turn shows no raw tool JSON by default; a prompt-assembly test asserts "You are an AI
> assistant" never co-occurs with the game-master prompt. `pytest` green. Open a PR.

### C15 — onboarding holding-state + new-season history fence  ·  Claude Code (front-end lane)  ·  **Wave 4 · audit F5 + F7** — ✅ DONE (verified 2026-06-10: covered with C23 — `test_c23_onramp.py` pins the dark-house holding card + the fresh-session fence)

> In `Psychout-Media/orwell` `frontend/`, (1) **onboarding fails open to a generic workspace** — engine unreachable ⇒ the
> overlay never mounts (`orwellOnboarding.js:127-134`) and the player lands on "type /setup to get started" with tips
> referencing **dropped** verticals ("web search and code execution", "Compare mode"). Show a game-branded **holding card**
> ("The house is dark — Big Brother will return") when `/api/orwell/state` fails, and replace the tips/default tagline with
> game-flavored ones under `game_build_enabled()`. (2) **Stale season history contaminates a new game** — `createCharacter`
> resets the engine but the chat session keeps the entire previous season in context (`chat_helpers.py:589`), so the
> narrator blends casts. On a successful restart, **start a fresh chat session** (or inject a hard "NEW SEASON — disregard
> all prior season events" fence). **DoD:** browser smoke asserts the holding card renders under the game build when the
> engine is down (no tip names a dropped vertical); a test asserts the first post-restart turn carries **no** prior-season
> messages in the LLM payload. `pytest` + the 0032 headless gate green. Open a PR.

### C16 — 0022 first slice: roster, recap, decision cards  ·  Claude Code (front-end lane)  ·  **Wave 4 · audit F9 · ✅ DONE (across C20/C21/B62/C17; closed 2026-06-10)**

> All three pieces shipped under their natural homes: the **roster** is C21's memory wall (names + seats,
> Vault-free); the **decision cards** are C20's confirm-on-binding surface (the engine's pending + LEGAL options,
> bound ONLY via the validated `/decision` route — audit F4 fixed structurally, guarded by B66); the
> **"previously on…" recap** is B62's `re-entry` moment (the store recalled through the narrator — the ADR-0003
> preferred shape) plus C17's recap panel over `seasonRecap` (the record, queryable any time).

> In `Psychout-Media/orwell` `frontend/`, ship the highest-value slice of the deferred **0022** rich UI, all from Vault-free
> projections the engine already returns, in the self-contained/fail-open/game-gated pattern of
> `orwellStatusPanel.js`/`orwellSocial.js`: (1) a **houseguest roster** panel (names + status from `getGameState`);
> (2) a **"previously on…" session-open recap** (synthesized from `getVisibleStateFor` — facts the player knows +
> observable behavior only, **never** a read on where they stand, per 0020); (3) **decision cards** that render the
> engine's `pending` (prompt + **legal option set** + pick counts from `advanceGame`) and bind **only** via the validated
> `submitDecision` — fixing audit **F4** (today a model misreading prose can submit a vote the player never made). Add a
> moment-prompt note (engine side — fold into the same PR or a sibling B-item): "on `pending`, present via `ask_user` with exactly
> the engine options; `submitDecision` only with an explicit selection." **DoD:** a scripted agent test where a pending
> turn yields an `ask_user` whose options equal the engine's legal set and **no** `submitDecision` is issued in the same
> round as the question; roster/recap render Vault-free; `pytest` + 0032 headless gate green. Read `docs/features/0020`,
> `0022` first. Open a PR.

### C17 — 0048 front-end: season recap & the unsealed story  ·  Claude Code (front-end lane)  ·  **Wave 4 · audit G4 · ✅ DONE 2026-06-10**

> **Built to green** (B56 unblocked it). GET `/api/orwell/recap` (fail-open `{recap:null}`; the record, any time)
> + GET `/api/orwell/retrospective` — **404 while the season is live** (the engine's terminal-state gate surfaces
> as a missing affordance; the Wall stays absolute pre-finale). `orwellRetrospective.js`: a render-only,
> game-build-gated, dismissible post-season panel — the recap highlights + "Open the Producer's Vault" (the
> unsealed hidden story incl. the twist that never fired). Nothing in it progresses the game (B66 guard).
> `tests/test_c17_retrospective.py`; pytest 292 + boot + headless browser smokes green.

> In `Psychout-Media/orwell` `frontend/`, build the **post-season** presentation for feature **0048** (B56): a recap surface
> (arc highlights from the engine's Vault-free recap read) and — **only after the winner event** — a player-triggered
> **"watch the season back"** view over the now-unsealed hidden story (off-screen scheming, confessionals, the twist that
> never fired) from B56's post-season read tool. Same fail-open, game-gated patterns; render **only** the route payloads.
> **The wall stays absolute pre-finale:** the unseal affordance must not exist (or must 404) while a season is live.
> **DoD:** the unseal view is unreachable mid-season; the recap renders from the engine read, not chat memory; `pytest` +
> 0032 headless gate green; verify on a running instance. Depends on **B56**. Open a PR.

---

### B57 — doc-hygiene pass (the authoritative docs mis-instruct)  ·  Claude Code / feature-maker  ·  **continuous · audit H1–H9** — ✅ DONE (verified 2026-06-10: the stale spec blocks are refreshed)

> In `Psychout-Media/orwell`, one PR refreshing the authoritative docs that currently contradict the live status and
> mis-instruct a fresh implementer (per audit §H). Refresh `bb-sim-spec.md`'s stale Refinements block ("0023 is the
> biggest gap"), §11 (pre-ADR relationship shape), §12 (the daily-event scenario **omits** "significant house event" — a
> literal reading fails every legal social day), §16; close out `CLAUDE_CODE_INSTRUCTIONS.md` §15 (only the embedding
> provider is genuinely open); annotate legacy Bible §11's wrong jury-start number; clear the two **satisfied** Amendments-
> table rows + the stale 0004 banner; sync the ~25 "Status: Draft" headers on Done features to the README legend;
> reconcile the queue's contradictory "NOW" blocks; fix ADR-0002's **inverted** confidence wording; reconcile the 0010
> Proxmox-smoke claim; remove 0009 §8's stale sync-narrate flag; fix CLAUDE.md's claims that `consequence.ts` folds live
> impacts and that the orchestrator is the single advance path. Also (H2) add the **as-built** tool names
> (`runCompetition`/`submitDecision`/`advanceGame`) to the older specs that still say `resolveCompetition`/
> `executeDecision`/`advancePhase`; (H3) pin 0033's "standing" to public ceremony facts; (H4) pin admin save/load vs the
> 0007 ratchet + account-deletion→sandbox-data; (H5–H9) the smaller notes. Docs-only; no gate impact. Open a PR.

### B58 — ops: save pruning, live admin state, fault surfacing  ·  Claude Code  ·  **continuous · audit E4 + E5 + E6 · ✅ DONE 2026-06-10**

> **Built to green.** (E4) `FileSaveStore` retention is BOUNDED: newest 5 versions + newest 3 periodic
> checkpoints (every 50th), pruned on save — a 500-save soak keeps ≤8 files and the latest superset intact
> (0007 lives in the snapshot's CONTENT). (E5) the admin surface is LIVE: every persisted mutation mirrors
> week/phase/a roles-only roster onto `adminState` (`UserSandbox.syncAdmin`); `manageSandbox("reset")` routes
> to the REAL `registry.resetUser` via `AdminPort.setResetDelegate`; new Vault-free **`sandboxHealth`** admin
> tool (orchestrator health through `registry.setHealthProvider`, wired in `composeRuntime`). (E6) faults are
> LOUD and bounded: stderr log with user+kinds, stored faults capped at 20, and a circuit breaker — after 3
> consecutive faults off-screen ticks SKIP the sandbox (`HealthRecord.circuitOpen`); a clean player turn closes
> it. `tests/unit/opsHardening.test.ts`. Original prompt below.

> In `Psychout-Media/orwell` (TS engine), three operational gaps. (1) **Unbounded disk** (E4): a full snapshot file per
> mutation, never pruned, snapshot size linear in events ⇒ O(n²) disk — retain a bounded window (last K + periodic
> checkpoints; non-degradation requires the **latest** save be a superset, not every historical file). (2) **Admin/God
> Mode is decorative** (E5): `inspect` returns a never-updated stub, `overrideMechanic`/`manageSandbox("reset")` mutate a
> stub nothing reads (disconnected from `registry.resetUser`), and `sandboxHealth` is exposed by **no tool** — feed
> `adminState` from `session.snapshot()` on mutation, route reset to `registry.resetUser` (used by B36/C12), and add a
> Vault-free **`sandboxHealth`** admin tool. (3) **Faults are silent** (E6): on a checkpoint fault the rollback works but
> nobody can see health, the watcher retries identically, and faults accumulate unbounded — log to stderr with user+kind,
> add a **circuit breaker** (skip a sandbox after K consecutive faults, flag in health), cap stored faults. **Acceptance:**
> a 10k-tick FakeClock soak ⇒ ≤K files/user, latest still a superset; admin inspect reflects live week/phase after
> `advanceGame`; `manageSandbox reset` re-onboards; a forced-leak apply ⇒ stderr log + health fault over `/admin/call` +
> sandbox skipped after K. Read `docs/features/0007`, `0016`, `0031` first. Open a PR.

### B59 — close the boundary gaps + the engine cleanup catalog  ·  Claude Code  ·  **continuous · audit E7 + I · ✅ DONE 2026-06-10**

> **Built to green.** (E7) the dependency-cruiser OUTWARD set now covers `src/adapters/narrative/**` and
> `src/main.ts` (the entrypoint no longer imports `FileSaveStore` — `composeRuntime({durable:true})` owns the
> default store and exposes `knownUser`), and VAULT now names the hidden-logic engine modules
> (`relationships|confessionals|offscreen|gossip|liveSeason`) — type-only imports included; `test:arch` runs in CI
> via the unit lane (`tests/architecture/vault-boundary.test.ts` reuses the same config). (I) bug fixes: the
> veto-decision arm validates BEFORE consuming `pending` (an illegal save used to strand the loop) and the
> `nominees.filter(()=>true)` no-op is gone. Tunables consolidated: `thresholds.vetoSave` (was 0.6 ×3 inline),
> `TWIST_LOAD_PROB`, and `offscreenInteractions` is finally a REAL orchestrator knob (passed through to the apply
> step; was dead config + a hard-coded 3). The duplicate consequence fold is ONE implementation
> (`foldHiddenImpact` in `consequence.ts`, shared by `ConsequenceEngine` + `EngineCommandsAdapter`). New
> `tests/unit/constantsGate.test.ts` = the grep gate + the retune (knob-turn) test. *Deferred from the catalog
> (test-consumed seams, no production callers — not worth churn now):* the 0019 `decisions.ts` seam,
> `producerPrompt`/`deriveNpcKnowledge` routing, approach jitter, goodbye-tone 0.6. Original prompt below.

> In `Psychout-Media/orwell` (TS engine), (1) **dependency-cruiser rule gaps** (E7): OUTWARD omits
> `src/adapters/narrative/**` and `src/main.ts` (the most leak-sensitive outward consumers); VAULT omits
> `EmbeddingProvider.ts` and the engine modules that **hold** hidden logic/state (`relationships.ts`, `confessionals.ts`,
> `offscreen.ts`, `gossip.ts`, `liveSeason.ts`) — a surface could import `confessionalFor`/`relationshipLabel` today
> without tripping the gate. Extend both rule sets and ensure `npm run test:arch` actually runs in CI (depcruise was
> absent in the audit container). (2) The **cleanup catalog** (audit §I): consolidate tunables into the constants modules
> (manner thresholds, the duplicated veto-save `0.6`, all `JURY_WEIGHTS`/manner/`appealEffect` numbers → a new
> `juryConstants.ts`, approach jitter, decay 0.5, `SOCIAL_DAY_PROB`, twist load prob, orchestrator `interactions:3`) with
> a grep gate + one constants-injection retune test; pass through the dead `offscreenInteractions` config; and wire-or-
> move the dead production exports (`ConsequenceEngine` — collapse the duplicate fold in `EngineCommandsAdapter` to one
> implementation; the 0019 `decisions.ts` seam; `producerPrompt`/`deriveNpcKnowledge` — route any future NPC knowledge
> through it; etc.); fix `applyDecision`'s veto arm clearing `pending` before validating, and the `nominees.filter(()=>true)`
> no-op. **Acceptance:** `vaultBoundaryViolations()` fails when a surfaces/services/mcp/**narrative** module type-imports
> any engine-only module; the constants grep gate passes; the duplicate fold is one implementation. Open a PR.

### B60 — transport robustness + determinism  ·  Claude Code  ·  **continuous · audit E9–E12 · ✅ DONE 2026-06-10**

> **Built to green.** (E9) 256KB body cap (413 + socket destroy), a 30s request timeout, basic name/args
> validation, and honest error mapping — a DELIBERATE engine refusal (plain `Error`) is 400; any other throw
> (TypeError etc. = an engine bug) is 500. (E10) calls are SERIALIZED PER USER via a promise queue (a player
> action can never race a sandbox swap/reset; different users stay concurrent); the sandbox resolves inside the
> queued job. (E11) `UserSaveStore.listUsers?()` + `FileSaveStore` impl + `composeRuntime` preloads every saved
> user at boot — a deploy no longer freezes each house until that user's next request. (E12) the per-moment rng
> keys off the PERSISTED game seed (`SessionCore.seed`; legacy saves fall back to the old name key), the command
> seam gets a per-user rng, and the EventStore is the ONE monotonic ts authority (`record` normalizes backwards
> ts; the new `restoreRecord` round-trips a restored history exactly). `tests/unit/transportHardening.test.ts`.
> Original prompt below.

> In `Psychout-Media/orwell` (TS engine), harden the HTTP transport and the RNG/ts hygiene. (E9) Add a request **body-size
> cap** (256KB), a request **timeout**, basic per-tool **arg validation**, and map non-validation throws to **500** (today
> all errors → 400, so engine bugs masquerade as client errors). (E10) Resolve the McpServer **inside** the `end` handler
> (not at request start) to close the sandbox-swap race that loses a player action; ideally serialize per-user with a
> promise queue (also future-proofs an async narrator). (E11) **Preload** saved users at boot (enumerate the save dir, or
> lazily on first wake) so the house doesn't freeze at every deploy until each user's next request. (E12) Thread the
> **sandbox seed** into `beatRng` and `runCompetition`'s RNG (today `beatRng` keys off the player **name** only and
> `runCompetition`'s rng is identical across all users/games), and adopt **one monotonic per-sandbox tick** for event `ts`
> (today per-producer ts semantics differ, so ordering by ts is meaningless). **Acceptance:** an oversize body is rejected;
> a non-validation throw returns 500; two same-named games have distinct comp streams; events sort by a coherent ts. Open
> a PR.

### C18 — front-end minor cleanup  ·  Claude Code (front-end lane)  ·  **continuous · audit F8 · ✅ DONE (poll hygiene shipped earlier; the rest closed with C17's PR 2026-06-10)**

> Polling backoff + hidden-tab pauses shipped in the FE final batch (#170); archetype suggestions are C23's
> chips; the drift/injection tests are C13's suite. Closed now: `game-trim.css` is STRIPPED server-side when the
> game build is OFF (the full workspace returns under `ORWELL_GAME_BUILD=0`); the engine client uses ONE shared
> `httpx.AsyncClient` (patch-aware for tests; the health probe included); and the per-turn FRAMING reads default
> to a 3s `_FRAMING_TIMEOUT` (`ORWELL_ENGINE_FRAMING_TIMEOUT`) so a hung engine fails a turn's framing fast —
> the fallback prompt takes over instead of a ~60s stall. F8g noted: mitigated by B36/C12's reset guard.

> In `Psychout-Media/orwell` `frontend/`, the small items from audit F8: gate the `game-trim.css` `<link>` behind the build
> flag (today unconditional, so `ORWELL_GAME_BUILD=0` debug still hides workspace chrome); offer the five canonical
> archetypes as suggestions in onboarding (free-text still allowed) with a hint that certain words shape hidden stats;
> add **polling backoff** + a shared `httpx.AsyncClient` for the HUDs (today two HUDs × 20s poll forever, new client per
> request); add a short (2–3s) timeout for the framing engine calls so a hung engine doesn't stall a turn ~60s; and add
> the missing **drift/injection tests** (pin `ORWELL_GAME_TOOLS`/schemas to `registry.ts`; assert `build_chat_context`
> prepends the moment prompt when `started=true`). The single-user-mode God-Mode exposure (F8g) is mitigated by B36/C12's
> reset guard — note it. **DoD:** `pytest` + the 0032 headless gate green; engine gate unaffected. Open a PR.

---

## Front-end & experience batch (B61–B63 / C19–C27) · 2026-06-09

Dispatch prompts for the **front-end & experience audit** (`docs/audits/2026-06-09-frontend-experience-audit.md`).
**Read `docs/decisions/0003-conversation-is-the-game.md` first — it governs the SHAPE of every item here.**
The beta proved the loop: a good LLM + the Bible + secrets *is* the game; the engine exists only to fix four
degradations (leaks / sycophancy / memory-thinning / sameness) and otherwise **get out of the model's way**. So
these prompts are deliberately written *light*: **prefer removing context to adding it; hand the model facts to
voice, never scripts to recite; UI is for guardrails (confirm-on-binding) and memory (the wall), not for replacing
talk.** If a fix here would add framing the model doesn't need, script what it should improvise, or move play out
of conversation into a dashboard — it's the wrong shape (ADR 0003's litmus test). Same lanes/house rules as the
audit batch above; OpenHands isn't configured, so Claude Code owns both (B/C is a scope marker).

**Amendments to the audit batch (C12–C18) — pick these up when you build those items:**
- **C12** ← also handle the **mid-scene tool-error** path (N5): an outcome-tool error must yield a "feed glitched,
  try again" beat, never a narrated winner — i.e. the game preamble (C19) must *not* carry the generic "a failed
  tool is not a stopping condition — improvise" rule. Resume-specific severity: the longer the transcript, the more
  convincing a fake continuation (F2).
- **C13** ← the prompt also advertises a **second, non-existent** comp lever `resolveCompetition` (N4) — collapse the
  manifest to one comp lever (pairs with B37/B61); the unrecorded in-chat Diary Room (U8) needs the same "the house
  never hears this" banner as the modal, or unify on one DR affordance.
- **C14** ← **substitute, don't restyle** (N3): on `game_active` turns, assemble a minimal game preamble *instead of*
  `_AGENT_PREAMBLE`/`_AGENT_RULES`, not in addition to them. Also strip `npc:`/`phase:`/`pick:` from tool results
  before they reach the model (N6). (Now scoped as **C19**.)
- **C15** ← exact dropped-vertical strings + happy-path/paint-order flash (J8/R1), game-frame the setup copy (J9),
  factory-reset must also clear FE game sessions (J12). (Folded into **C23**.)
- **C16** ← split into the **confirm-on-binding guardrail** (C20, ADR-0003-light — *not* a decision-card builder) and
  **the memory wall** (C21, roster/jury/self-status/portraits); U1's full `pending` data is the source either way.
- **C18** ← add Page-Visibility gating + coalesce `/state`+`/initiatives` (P2); pin the `game-trim.css` link to the
  build flag (P4).

| Wave | Item(s) | Lane | Audit ref |
|---|---|---|---|
| **FE-0 — make it a game** (highest leverage, mostly small) | **B61** cast voices + prompt · **C19** minimal game preamble · **C22**§premiere · **C20** confirm-on-binding · **C21** memory wall | engine + FE | N1·N2·N4·N5·N7 / N3·N6 / J1 / U1·U2 / U3·V2 |
| **FE-1 — make it reliable** | **B62** lifecycle moment fragments · **C22** lifecycle beats + new-season · **C23** onboarding onramp · **C24**§HUD-resilience | engine + FE | J1·J2·J7 / J3·J4 / J5·J6·J8·J9 / U5 |
| **FE-2 — make it reachable** | **C25** accessibility · **C26** mobile · **C27**§bundle | FE | A1–A6 / M1–M3 / P1·P3·P4 |
| **FE-3 — make it whole** | **B63** jury/self-status projection · **C24** beat dividers + social texture · **C27** identity + labels | engine + FE | U3 / U4·U6·U7 / V1·V3·R2 |

---

### B61 — cast voices: surface the public persona to the narrator + a light voice directive  ·  Claude Code  ·  **FE-0 · headline · audit N1+N2 (+N4/N5/N7 prompt edits)** — ✅ DONE (verified 2026-06-10: `tests/unit/castVoices.test.ts`)

> In `Psychout-Media/orwell` (TS engine). **This is the single biggest immersion win and it's mostly already paid for.**
> The narrator is fed 15 names + a status word (`renderGameContext`, `momentPrompts.ts:127-140`; `HouseguestCard` =
> `{id,name,status}`) while the engine already mints **Vault-free public facets** per NPC — archetype, strategyStyle,
> background, age, appearance, presentation, a `PortraitDescriptor.vibe` (`characterFactory.ts:56-66, 311-335`),
> already blessed outward-safe by the portrait pipeline. Per **ADR 0003** ("hand the model facts to voice, never
> scripts to recite" + "anchors, not personalities-in-a-can"): (1) add a Vault-free `cast: CastVoiceCard[]` to
> `GameStateView` (or a `getCastVoices` read tool) = `{id,name,status,archetype,strategyStyle,background,age,
> appearance,presentation}` — **exclude** stats/soul/emotionalState/relationship edges/hidden elements; (2)
> `renderGameContext` emits **one short vibe line per active NPC** ("Bemir Sason — mastermind, plays under-the-radar;
> a bartender; 34, polished") and drops evicted houseguests; (3) add a tight **VOICE-DISTINCTNESS** block to
> `BASE_GAME_MASTER_PROMPT` — distinct, archetype-grounded, **consistent week-to-week** voices, and the boundary
> *"never invent biography beyond the supplied facets + recorded events"* — kept to a few sentences (ADR 0003:
> minimal context). While in the prompt, also: **cut** the non-existent `resolveCompetition` lever (N4), add a
> one-line **ground-truth cadence** ("read getGameState/gameStatus; never state week/phase/HOH/noms from memory;
> progress beats only via advanceGame", N7), and a one-line **error rule** ("if a tool errors, don't narrate an
> outcome — say the feed glitched, retry", N5). Seed-stable facets ⇒ the voice anchor never drifts; soul *evolution*
> stays hidden (0041). **Acceptance:** the started-game prompt lists each active NPC's public vibe; two
> different-archetype NPCs get demonstrably different descriptors; a sentinel-embedded soul/stat string never appears
> in `cast`/`renderGameContext` output over a **registry-built** sandbox (extends E8/B42); a drift test asserts the
> prompt names the cast fields + the consistency rule and no longer names `resolveCompetition`. **Also (ruling
> 2026-06-10, v1-audit §3.9 — "finality language"):** add one line to the prompt — voice unresolved outcomes as
> *reads* ("the house looks like…"), never as settled results; results exist only when the engine resolves/reveals
> them. Read ADR 0003, `docs/features/0018`, `0004` first. Open a PR.

### B62 — server-initiated lifecycle moments (premiere / re-entry / terminal), recap from the store  ·  Claude Code  ·  **FE-1 · audit J1+J7+J2 (engine half)** — ✅ DONE (verified 2026-06-10: `tests/unit/lifecycleMoments.test.ts`)

> In `Psychout-Media/orwell` (TS engine), give the front-end the engine support to open and close a season with
> narration instead of dead air. Today the moment prompt attaches only on a player keystroke, so the game opens on an
> empty chat (J1), resume is a frozen transcript (J7), and there's no ending (J2). Per **ADR 0003** ("long-term
> memory is the store, recalled — never the chat, remembered"): add three **moment kinds** + Vault-free read support
> the FE can fetch to render a *server-initiated* beat — **premiere** (move-in framing for a just-created game),
> **re-entry** (a fresh-morning continuation grounded in current phase + recent **witnessed** events from the event
> store, **never a recap of chat text**), and **terminal** (season-end: result + week, from the record). All
> synthesized from the stores so a brand-new/limited context window loses nothing (the memory-survival fix). No new
> dialogue authored — these are *framing facts + a moment fragment* the model voices. **Acceptance:** the engine
> exposes a premiere/re-entry/terminal moment + the Vault-free facts each needs; a re-entry beat references the
> correct week/phase and only witnessed events; outputs are sentinel-clean. Pairs with **C22**. Read ADR 0003,
> `docs/features/0018`, `0030`, `0002` (witness model) first. Open a PR.

### B63 — Vault-free jury-status & player-standing facts for the memory wall  ·  Claude Code  ·  **FE-3 · audit U3 (engine half) · ✅ DONE (by prior work; verified 2026-06-10)**

> **Already satisfied** by B48 (`player.status` active/jury/evicted) + B61 (`seatOf` marks every houseguest's
> card active/**jury**/evicted) + 0020 (`gameStatus` carries hoh/nominees/veto-holder ids, so the player's
> ceremony role is derivable from public facts alone). Verified by a dedicated test in
> `tests/unit/lifecycleMoments.test.ts` (roster seats distinct; role computable; no hidden-layer key on either
> projection). No standing read ("safe"/"target") was added — that stays forbidden (0020).

> In `Psychout-Media/orwell` (TS engine), the roster the FE wants to render (C21) needs two tiny **public-fact**
> additions: (1) mark evictees who are **jurors** (a `status:"juror"` once jury forms, or expose a public `juryStart`
> week) so the jury can be tracked; (2) ensure the player's own **ceremony role** is derivable from public facts
> (the player card vs `hoh`/`nominees`/`veto.holder`) — these are facts a real houseguest sees on the memory wall,
> **not** a standing read ("safe"/"target"), which stays forbidden (0020). No numbers, no souls. **Acceptance:** the
> projection distinguishes active / juror / evicted; the player's HOH/nominee/veto role is computable from the
> Vault-free projection alone; sentinel sweep clean. Read `docs/features/0020`, `0014` first. Open a PR.

### C19 — minimal game preamble (substitute, not append) + diegetic tool results  ·  Claude Code (front-end lane)  ·  **FE-0 · audit N3+N6 (replaces C14's restyle)** — ✅ DONE (verified 2026-06-10: the game-master prompt is the sole persona in `agent_loop.py`)

> In `Psychout-Media/orwell` `frontend/`. Per **ADR 0003** ("prefer removing context to adding it"), the biggest
> reliability+immersion win is *less* prompt, not more. Today `build_chat_context` prepends the GM prompt to
> `_AGENT_PREAMBLE` ("You are an AI assistant with tool access…") + `_AGENT_RULES` (`agent_loop.py:62-111`) — pages of
> email/cookbook/calendar/document rules, including *"a failed tool is not a stopping condition — improvise"* (which
> instructs the model to invent outcomes, N5) and *"don't search for things you already know"* (which invites
> narrating from stale context, N7). On **`game_active`** turns, assemble a **minimal game preamble instead** of the
> generic one: a single in-fiction tool-calling paragraph + only the rules that touch game tools; the GM prompt is the
> sole persona authority. Gate strictly on `game_active` so non-game chat is untouched. Also (N6): give game-tool
> results a diegetic formatter that **strips `npc:`/`phase:`/`pick:`** and maps ids→names before the result reaches
> the model. **DoD:** "You are an AI assistant" never co-occurs with the GM prompt; no email/cookbook/calendar rule
> text in a game-active turn's system messages; no `npc:\d+`/`phase:`/`pick:` token in a game-active tool-result fed
> to the model; `pytest` green; engine gate unaffected. Read ADR 0003 first. Open a PR.

### C20 — confirm-on-binding (the light decision guardrail)  ·  Claude Code (front-end lane)  ·  **FE-0 · audit U1+U2, reframed per ADR 0003** — ✅ DONE (verified 2026-06-10: `orwellDecision.js` + `test_c20_decision_guardrail.py`)

> In `Psychout-Media/orwell` `frontend/`. The engine returns a full Vault-free `pending` decision view (prompt, legal
> `options[]`, `pick` count, `appeals[]`) that the FE entirely ignores, so binding choices are prose guesses with no
> confirmation (U1/U2). **Per ADR 0003, the fix is a guardrail, NOT a decision-card-builder UI** — play stays in
> conversation; only the *commitment* gets structured. When an `advanceGame`/`submitDecision` response carries a
> non-null `pending`: present the engine's `prompt` + legal `options` (and `appeals` for finale answers) and require a
> **single explicit confirm** before `submitDecision` fires, enforcing `pick` exactly. The player can still type their
> reasoning/speech and have it voiced — the binding value comes only from the confirmed selection, never parsed prose
> (the F4 invariant). Keep it light: a confirm affordance on the message, not a full modal dashboard. **DoD:** a
> pending-nominations turn requires selecting exactly 2 and an explicit confirm before any `submitDecision`; a hedge
> in prose cannot bind; the finale's statement→answer(appeal)→vote flow each require confirm; `pytest` green. Read
> ADR 0003 first. Open a PR.

### C21 — the memory wall (roster · jury · self-status · portraits)  ·  Claude Code (front-end lane)  ·  **FE-0 · audit U3+V2 (depends B63 for jury)** — ✅ DONE (verified 2026-06-10: `test_c21_roster.py`)

> In `Psychout-Media/orwell` `frontend/`. The status HUD shows 4 lines of a 16-person game (U3). **Per ADR 0003, UI here
> serves *memory*, not play** — render the facts a real houseguest sees on the memory wall, all Vault-free and already
> returned by the engine: the **roster** (`getGameState().house[]` `{name,status}`) grouped Active / Jury / Evicted
> with eviction-order trail; **attrition** (N/16); the player's own **ceremony role** badge (HOH / ON THE BLOCK / VETO
> — derived from public facts via B63, **never** a safe/target standing read, 0020); and **portraits** keyed to the
> houseguest ids (the `portraits`/`image_gen` keep-set capability has no consumer today — wire it to the engine's
> appearance facets / `portraitDescriptorFor`). No stats, souls, relationship numbers. **DoD:** roster matches
> `house[]` exactly across the season; jury seats marked once formed; player role shown from public facts; portraits
> render; a sentinel test proves the surface returns no Vault data; `pytest` + 0032 headless gate green. Read ADR
> 0003, `docs/features/0020`, `0022` first. Open a PR.

### C22 — render the lifecycle beats + a guarded new-season path  ·  Claude Code (front-end lane)  ·  **FE-1 · audit J1+J7+J2+J3 (depends B62)** — ✅ DONE (verified 2026-06-10: the premiere slice + guarded new-game in `test_fe_final_batch.py` / the 409 guard)

> In `Psychout-Media/orwell` `frontend/`, render the server-initiated beats B62 exposes so the season has a curtain-up,
> a way back in, and an ending (today: dead air on start, a frozen transcript on resume, no terminal state). On
> `createCharacter` success push the **premiere** beat as the first assistant message (no user input); on session
> re-open with `game_active` push the **re-entry** morning beat; on a season ending render a **terminal card**
> (won / evicted week-N / jury chose X) with a **guarded "New season"** affordance (J3) — confirm + start a fresh chat
> session (so old-season context can't bleed, F7), routed through the B36 reset guard. **DoD:** chat shows a premiere
> with no user input; reopening shows one re-entry beat referencing the right week/phase; reaching an ending shows a
> terminal card; "New season" requires confirm and the first post-restart turn carries no prior-season messages;
> `pytest` + 0032 headless gate green. Depends on **B62** (+ B36/C12). Open a PR.

### C23 — onboarding onramp: model-gate sequencing, authoring depth, game-framed copy  ·  Claude Code (front-end lane)  ·  **FE-1 · audit J4+J5+J6+J8+J9 (extends C15)** — ✅ DONE (verified 2026-06-10: `test_c23_onramp.py`; 0050 moved authoring into the chat)

> In `Psychout-Media/orwell` `frontend/`, fix the first-run path. (J4) Before mounting onboarding, probe model
> readiness; if no model, show a game-branded "connect a feed source to begin" step linking to setup, *then* author —
> and never render the raw "No model selected for this chat" error on a game-active/onboarding session (today a fresh
> install dead-ends there immediately after authoring). (J5/J6, **lightly** per ADR 0003) add an optional
> backstory + a `NO_NPC_PATHWAY` **private-strategy** field (0015) and one line communicating the balanced-stats
> stance ("like every houseguest, balanced, never invincible") — a few fields, not an RPG builder. (J8/J9) under the
> game build, replace the "type /setup" welcome + the dropped-vertical tips ("web search and code execution",
> "Compare mode") with game-framed copy, and don't let the generic welcome paint when onboarding will mount (also
> covers C15's R1). **DoD:** fresh install yields one guided path (model → character → premiere); the raw model error
> never shows on a game session; private strategy round-trips as `NO_NPC_PATHWAY` knowledge; no dropped-vertical
> string under the game build; `pytest` + 0032 headless gate green. Read ADR 0003, `docs/features/0015` first. Open a PR.

### C24 — HUD resilience · ceremony beat dividers · NPC-initiated social texture  ·  Claude Code (front-end lane)  ·  **FE-1/FE-3 · audit U4+U5+U6+U7** — ✅ DONE (verified 2026-06-10: `test_c24_hud_resilience.py`)

> In `Psychout-Media/orwell` `frontend/`, three play-surface fixes. (U5) The HUDs `hidePanel()` on *any* error so they
> vanish on a transient engine blip — distinguish engine-error (keep last-known values + a subtle offline dot) from
> no-active-game (hide); share one poller across the two panels. (U4) Give narrated **ceremony beats** visual weight:
> diegetic labels for game-tool thread nodes ("📺 Production", "🗳 Your move") with raw JSON hidden under the game
> build, and a full-width **beat divider** ("— Nomination Ceremony · Week 3 —") from `AdvanceView.event.beat` +
> `status` on ceremony advances. (U6/U7, per ADR 0003 "facts to voice, not scripts") the NPC-approach chip should
> prefill **NPC-initiated** framing ("⟨Name⟩ catches your eye and drifts over—") rather than the canned, direction-
> inverted "I pull ⟨name⟩ aside"; allow 2–3 concurrent approaches; move dismissals server-side. (Engine-side pretext
> variety stays D8/B-lane; here, vary the prefill and stop reciting one line.) **DoD:** an injected 502 leaves the
> panel visible with stale-state indication; a ceremony turn renders a labelled divider with no raw JSON; approaches
> render NPC-initiated framing, ≥N concurrent; `pytest` + 0032 headless gate green. Open a PR.

### C25 — accessibility batch (keyboard + screen-reader play)  ·  Claude Code (front-end lane)  ·  **FE-2 · audit A1–A6** — ✅ DONE (verified 2026-06-10: focus trap/inert in onboarding; A3/A4/A5 pinned in `test_fe_final_batch.py`)

> In `Psychout-Media/orwell` `frontend/`, make the game layer accessible (the base app is; the game HUDs aren't). (A1)
> Trap focus in the onboarding modal, `inert` the background, restore focus on close (today Tab walks into the dead
> chat behind it — every new keyboard/SR player). (A2) Make the approach chips and Diary-Room actions real
> `<button>`s (or role+tabindex+Enter/Space) and trap+Escape the DR dialog (today the core "pull someone aside"
> interaction is mouse-only). (A3) Keep the status live-region always in the DOM and announce **deltas** only ("New
> nominee: …"), not a full re-read every 20s. (A4) Replace `opacity` dimming with explicit AA-checked colors and add
> a contrast clamp to the theme apply path. (A5) Stream narration into an off-live buffer and announce once on
> completion (today it's a per-token stutter to SR). (A6) `aria-hidden` the decorative loader; mirror interactive
> `title`s to `aria-label`. **DoD:** axe-core clean on the onboarding/social/status surfaces; the game is fully
> operable by keyboard and screen reader; HUD text ≥4.5:1 across shipped + a generated light theme; `pytest` + 0032
> headless gate green. Open a PR.

### C26 — mobile batch (make a full season playable on a phone)  ·  Claude Code (front-end lane)  ·  **FE-2 · audit M1–M3** — ✅ DONE (verified 2026-06-10: the responsive + coarse-pointer rules shipped in `style.css`)

> In `Psychout-Media/orwell` `frontend/`, the verdict today is *a season is not playable on a phone* (fixed-position
> HUDs overlap the composer, draggable panels strand off-screen, modals don't fit short viewports). (M1) Under a
> mobile breakpoint, dock the two HUDs into the sidebar / a bottom sheet — never free-float over the composer (today
> two 220px `position:fixed; z-index:9000` panels collide with the composer's own mobile machinery; **zero media
> queries** in any game file). (M2) Restore the default `mobileSkip` so HUDs aren't touch-draggable on phones (they're
> docked per M1), and clamp-to-viewport after every drag end. (M3) Give the onboarding/DR cards `max-height:90vh;
> overflow:auto` and stop touch-dragging the DR. **DoD:** at 390×844 neither HUD overlaps the composer or latest
> message; HUDs not free-draggable on a phone; onboarding submit reachable at 390×667 landscape; `pytest` + 0032
> headless gate green; verify on a phone-width viewport. Open a PR.

### C27 — real game bundle, asset diet, visual identity & enum labels  ·  Claude Code (front-end lane)  ·  **FE-2/FE-3 · audit P1+P3+P4 + V1+V3+V5+R2** — ✅ DONE (verified 2026-06-10: `strip_dropped_scripts` is real in `app.py`; V3 enum labels pinned in `test_fe_final_batch.py`)

> In `Psychout-Media/orwell` `frontend/`. (P1) The script-strip is a **no-op** — it removes files `index.html` never
> references while the multi-MB inherited bundle (`settings.js` 274KB, `chat.js` 251KB, `slashCommands.js` 268KB,
> `admin.js` 126KB…) parses on every load. Ship a real game bundle (a tree-shaken entry importing only the game
> keep-set + chat), or at minimum gate the inherited mega-module `<script>` tags through the same build flag.
> (P3) Drop the CDN KaTeX/Mermaid under the game build (no math/diagrams in BB). (P4) Gate the `game-trim.css` `<link>`
> on the build flag (today it's the one game-build asset the flag doesn't control). (V1, per ADR 0003: still light)
> a game-branded landing/hero (season title, "Enter the house" CTA = onboarding) + BB composer placeholder, instead
> of the generic "type /setup" workspace. (V3) Map engine phase enums → player labels ("Veto Ceremony", not
> `veto-ceremony`); no raw enum in any HUD. (V5, **RULING 2026-06-09: keep ALL theme customization tools and make
> them better** — do NOT prune: add curated season presets *on top of* the full customizer, wire an AA contrast
> clamp into the theme apply path (a11y A4), and keep the harmony generator + custom fonts working.) (R2) Gate
> the residual inherited modals/"Save to Documents" export so no dropped-vertical control is keyboard-reachable under
> the game build. **DoD:** game-build page weight drops materially (`admin.js`/`presets.js` absent); no jsdelivr
> request on a game-build load; `ORWELL_GAME_BUILD=0` restores full workspace chrome; no raw enum or dropped-vertical
> control in the player surface; `pytest` + 0032 headless gate green. Read ADR 0003 first. Open a PR.

---

### Addendum (same-session feedback) — presence, lingering, NPC coherence & testability · B64–B66 / C28

ADR 0003 was refined in-session (principles 4, 7, 8 + the new Testability section): UI may
**augment** the chat intelligently but never **replace** a game-building interaction; **lingering is
play** (mill around rooms, learn who's present/adjacent, talk to anyone while NPCs keep playing
*their* game, and nothing force-marches the week); **people must make sense** (one place at a time,
knowledge-scoped speech, stable persona); and each principle must be **testable structurally** where
possible — that section is the contract these items must satisfy. Read ADR 0003 before any of them.

### B64 — 0049 house presence & lingering play  ·  Claude Code  ·  **FE-1/FE-3 · ADR 0003 §4/§7 · ✅ DONE 2026-06-10**

> **Built to green** (engine + FE wiring in one PR): `src/domain/house.ts` (rooms + adjacency, pure
> core, `occupancyViolations` invariant) · `src/engine/presence.ts` + `presenceConstants.ts` (seeded
> affinity-clustered `assignRooms`; `rollOverhears` — ONE gate per scene, ONE ear, player-priority,
> partial fragment + reduced confidence via real `overheard:<eventId>` pathways) · `whereabouts()`
> (port + adapter + player tool + manifest bullet + FE schema/tags/dispatch per the C13 drift test) ·
> occupancy persisted in the snapshot · orchestrator tick seats the house + rolls player-direction
> overhears; `recordInteraction` grounds witnesses in co-presence + rolls NPC-direction overhears ·
> lingering proven zero-beat (BDD) and milling counts as watcher activity. Note: overhears are
> deliberately RARE (`overhearProb 0.1`, one listener) — both for drama and because every overhear is
> a recorded propagation event the per-commit snapshot pays for (UAT-measured). 8 BDD scenarios in
> `cucumber.cjs`; `tests/unit/presence.test.ts`.

> **Spec is drafted** (`docs/features/0049-house-presence-and-lingering.{md,feature}`, per the v1-transcript
> audit ruling — `docs/audits/2026-06-10-v1-transcript-meta-feedback-audit.md` §3.7: note overhearing is
> **bidirectional**, NPCs overhearing the player included). Implement **feature 0049** to green:
> a **light** spatial model that makes unhurried, information-gathering play real (ADR 0003 §7). Keep it
> minimal — this is *facts the narrator queries*, not a simulation the player operates. (1) **Rooms +
> adjacency** — the canonical BB house spaces (kitchen, living room, backyard, bedrooms, HOH room,
> diary room…) + a static adjacency map, in the pure domain core. (2) **Occupancy** — every active
> houseguest is in exactly **one** room per tick (the §8 coherence invariant); movement only between
> adjacent rooms; clustering is **seeded** and driven by the relationship/agenda layer (allies drift
> together, schemers seek empty rooms), deterministic by seed; evicted houseguests are nowhere (ties
> D5). (3) A Vault-free **`whereabouts()`** player read: who is in the player's room + who is in
> **adjacent** rooms — *facts a houseguest could see/hear*, never their motives or hidden state. (4)
> **Co-presence grounds 0002** — being in a room together is a witness pathway; an NPC in the next room
> can be *overheard* (a partial/low-confidence pathway), so milling and eavesdropping become real,
> recorded information-gathering. (5) **Lingering never advances the week** — moving rooms, milling,
> and talking are zero-beat social turns; only the explicit decision seam (`advanceGame`/`submitDecision`)
> progresses phase, and the daily-event invariant is satisfied by the day's *scheduled* beat, never by
> steamrolling a gathering player. **Acceptance (structural, per the ADR):** a property test asserts
> one-room-per-houseguest and adjacency-only movement across a seeded season; `whereabouts()` is
> sentinel-clean and contains only co-present/adjacent **public** facts; co-presence produces witness
> events and adjacency produces lower-confidence overhear pathways (extends 0002 tests); **N consecutive
> mill/move/talk turns leave week+phase+ceremony unchanged** and the watcher treats milling as activity
> (no idle fast-forward). Read ADR 0003 (§7 + Testability), `docs/features/0002`, `0008`, `0035` first.
> Open a PR.

### B65 — NPC coherence: knowledge-scoped narration context (people must make sense)  ·  Claude Code  ·  **FE-0/FE-1 · ADR 0003 §8 · ✅ DONE 2026-06-10**

> **Built to green.** New **`npcVoice(id)`** on the `GameSession` port (+ player tool + manifest bullet + FE
> wiring): the knowledge-BOUNDED voicing projection for one ACTIVE houseguest — byte-stable persona facets (B61),
> room + co-presence (0049), what THEY legitimately know (0002 `knownTo`, humanized, capped) + their hunches
> (`suspicionsOf` — voiced as suspicion, never certainty), and ORGANIC stances (`relationshipLabel` through their
> own archetype disposition — labels, never numbers). The sanctioned per-NPC-bounded seam: what it carries of the
> hidden layer is exactly what THIS houseguest knows (which they may, in character, share/shade/lie about — that
> is the game); other houseguests' knowledge, the Vault, souls, hidden elements, and every number stay out by
> construction. Canary: a sentinel outside the NPC's knowledge set never appears in their voice (per-NPC axis);
> the B42 live sweep now exercises `npcVoice` against the secret-holding NPC; persona byte-stable across turns;
> no co-presence fact crosses rooms; the departed return null. `tests/unit/npcVoice.test.ts`.

> In `Psychout-Media/orwell` (TS engine), make "people must make sense" (ADR 0003 §8) **structural**, the
> Vault way: an NPC can only speak from what it legitimately knows, so enforce it on the *context the
> narrator receives*, not on the prose. Add a Vault-free **per-NPC voicing projection** — given an NPC
> id, assemble the context to voice that NPC from **only** their legitimate knowledge: their
> witnessed/told facts (0002 `KnowledgeService`), their current room/co-presence (B64), their stable
> public persona facets (B61's cast card), and their relationship-derived *behavior* (never the numbers).
> It must **exclude** other houseguests' private knowledge, any hidden/Vault content, and souls/edges.
> This is the seam B61's voice directive needs to be safe: the model is *handed* a knowledge-bounded
> NPC and cannot voice what that NPC never learned. **Acceptance (structural):** a sentinel planted in
> facts **outside** an NPC's knowledge set never appears in that NPC's voicing context across a
> registry-built sandbox (mirrors the 0001 canary on the per-NPC axis); the projection is byte-stable
> for the persona facets (no drift across turns/context windows); an NPC in one room has no co-presence
> fact for a scene in another room. Read ADR 0003 (§8 + Testability), `docs/features/0002`, `0001`, and
> B61 first. Open a PR.

### B66 — the ADR-0003 testability harness (reusable structural assertions)  ·  Claude Code  ·  **FE-2 · ADR 0003 Testability · ✅ DONE 2026-06-10**

> **Built to green.** `tests/support/adr0003.ts` — the REUSABLE helpers, each returning named violations over a
> production-wired fixture (`adrFixture`: registry + turn-driven orchestrator as commit delegate):
> `presenceCoherenceViolations` (one room each, adjacency-only, seeded — B64), `knowledgeScopeViolations`
> (a unique terminated sentinel per NPC: each voices their OWN and no one else's — B65),
> `personaDriftViolations` (byte-identical narrator facets across turns — B61), `lingeringViolations`
> (N mill/talk turns ⇒ week/phase/pending untouched + milling counts as watcher activity — B64).
> Wired into `npm run test:unit` via `tests/unit/adr0003Harness.test.ts`. The FE half:
> `frontend/tests/test_b66_augment_guard.py` — the augment-not-replace guard as a SOURCE/REGISTRY assertion
> (game-progressing engine calls reach routes ONLY through the two sanctioned confirm paths — the C20 decision
> route and the 409-guarded new-game route; static JS never bypasses the FE routes to the engine transport).

> In `Psychout-Media/orwell`, build the reusable test scaffolding the ADR's Testability section promises,
> so these principles are enforced, not aspirational, and stay green as the game grows. Add helpers +
> property tests for: **presence coherence** (one room per HG, adjacency-only movement, seeded
> occupancy — B64); **knowledge-scoped speech** (the per-NPC sentinel sweep — B65); **persona stability**
> (the public facets fed to the narrator are byte-identical every turn — B61); **lingering safety** (N
> social/mill turns ⇒ no phase/week/ceremony change; milling counts as watcher activity — B64); and an
> **augment-not-replace guard** (no front-end UI control reaches a game-progressing engine action except
> the validated `submitDecision` behind an explicit confirm — a dependency/registry assertion mirroring
> the Vault-Wall rule). Where only a transcript-level eval is possible (distinct voices, tone), it may
> *supplement* but never *replace* a structural test. **Acceptance:** each principle has at least one
> structural test wired into `npm run test:unit` (and, for the FE guard, the front-end pytest gate);
> the suite fails if presence/ knowledge-scope/persona-stability/lingering invariants regress. Read ADR
> 0003 (Testability) first. Open a PR.

### C28 — augment the chat with presence, never replace it (whereabouts surface)  ·  Claude Code (front-end lane)  ·  **FE-1/FE-3 · ADR 0003 §4/§7 · ✅ DONE 2026-06-10**

> **Built to green** (B64 unblocked it). GET `/api/orwell/whereabouts` (read-only, fail-open: `{whereabouts:null}`
> on any error/pre-game) + `orwellPresence.js` — a LIGHT, dismissible AMBIENT strip ("📍 Backyard — with A, B ·
> nearby: Kitchen (C)"): no click-to-move, no scene buttons, the ONLY control is dismiss (which hides until the
> player's ROOM changes); game-build gated; hidden-tab + backoff poll hygiene (C18). Moving/milling/talking stay
> PROSE; the engine grounds the narration. `tests/test_c28_presence.py` pins route passthrough/fail-open + the
> ambient contract (no POST, one control); the B66 augment guard covers it structurally. pytest 275 + boot smoke
> + the local headless browser smoke all green.

> In `Psychout-Media/orwell` `frontend/`, surface presence so milling is legible **without** moving play
> out of the chat (ADR 0003 §4: augment, never replace). Render `whereabouts()` (B64) as an **ambient**
> ground for the conversation — who's in the room with the player and who's nearby — as a light,
> dismissible presence strip / part of the memory wall (C21), *not* a click-to-act room navigator: the
> player still moves, mills, asks "who's here?", and talks **in prose**, and the engine grounds the
> narration. Approaches (C24) and any "drift to the backyard" remain conversational intents the model
> acts on, never UI buttons that progress the game. Vault-free, fail-open (no strip on empty/error).
> **DoD:** the presence strip shows only co-present/adjacent public facts; no UI control advances phase
> or initiates a scene by itself (the augment-not-replace guard, B66); `pytest` + 0032 headless gate
> green. Depends on **B64** (+ C21). Read ADR 0003 first. Open a PR.

---

## Operations, security & test-integrity batch (B67–B72 / C29) · 2026-06-09 (round 3)

Dispatch prompts for the **operations/security/test-integrity audit**
(`docs/audits/2026-06-09-operations-security-tests-audit.md`). This batch is **cross-cutting** —
it touches `deploy/`, `frontend/`, `src/`, and the test suite — so the B/C split is again just a
**scope** marker (engine/infra vs. front-end Python), not an agent assignment; **Claude Code owns
all of it**. The through-line the audit found: *the front-end ↔ engine boundary is where the real
operational risk concentrates, and the green test gate gives false confidence on three of the four
mandates.* Two findings ship-broken **today** (the engine-token footgun B67; the live knowledge-drop
B68); three more re-point the mandate gates at the production loop (B69/B70). House rules apply
(Vault Wall structural; `npm run test:arch` green; BDD/TDD-first; roles-only tests; keep gates green;
PR per item).

> **Good news the audit confirmed (no work needed):** the front-end's **own** security posture is
> sound — the authenticated-user → engine-sandbox-key trust path **cannot be spoofed** (the key is
> server-derived from the session, never client input), dropped dangerous verticals are **truly
> unmounted server-side** (404 even for admins), and auth/sessions/multi-tenant isolation are
> well-built. No critical or major app-security bypass. The items below are operations, test-integrity,
> and minor hardening.

| Wave | Item | Lane (scope) | Audit ref |
|---|---|---|---|
| **R-0 — ships broken today** | B67 engine-token end-to-end + multi-user header · B68 live knowledge-drop | deploy+FE+engine / engine | A1·A2·secB3 / C1 (=product C2) |
| **R-1 — re-point the mandate gates** | B69 live richness + fairness + sentinel · B70 structural test/CI gaps | tests+engine | C2·C3·C6 / C4·C7·C8·C9 |
| **R-2 — production-grade deploy** | B71 atomic/rollback update + boot-preload + real smoke · B72 root-drop + hardening + backup/DR + hygiene | deploy/systemd (+engine runtime) | A4·A6·A7 / A5·A8·A9·A3·A10 |
| **R-1 — FE hardening** | C29 secure-cookies + proxy rate-limit + stray verticals + entitlements + deps + isolation test | front-end | secB2·B4·B5·B6·B7 + testC5 |
| **R-0 — Settings ruling** | C30 global LLM config (admin-set, hidden from non-admins; chat-bar picker stays per-profile) + per-profile prefs | front-end | settings S1·S4 · ruling |
| **R-0 — search re-wire** | C32 web search as an in-fiction agent capability (amends 0032) | front-end + engine prompt | ruling 2026-06-09 |
| **R-2 — Settings prune** | C31 dead-JS gating + live-data wipes (search prune superseded by C32) | front-end | settings S3·S5 |
| **R-2 — tagline** | C33 hero tagline genuinely AI-generated (curated/static only as fallback) | front-end + engine | ruling 2026-06-09 |

> **Reconciliation — RESOLVED / HISTORICAL (stamped 2026-06-10, E87d):** the owed 4th pass was
> superseded by the round-5/6 full product audit (`docs/audits/2026-06-10-full-product-audit.md`),
> which re-audited every prior finding from scratch. Of the confirmed fragments: **E3** (the
> orchestrator commit seam) shipped with the L1 restart spine (PR #215); the **finale relay**
> (product B3 / front-end C12) shipped (C12 ✅, finale UI B26+C11); 0041's competition-modifier
> fairness gate landed with B69. Original note kept for the record:
>
> *(was)* a 4th audit pass (every prior finding → fixed/partial/open) was
> started and parked. Confirmed fragments: **E3** (orchestrator bypassed by player turns) and the
> **finale relay** (product B3 / front-end C12) are **STILL OPEN**; **0041's emotional-arc is genuinely
> live** (real production callers) but its competition modifier is **unverified for fairness** (→ B69).

### B67 — wire `ORWELL_ENGINE_TOKEN` end-to-end; fix multi-user header semantics  ·  Claude Code (deploy + FE + engine)  ·  **R-0 · CRITICAL · ops A1 + A2 + sec §B3 · ✅ DONE 2026-06-10**

> **Built to green.** (A1) the FE now SENDS the token: `_user_headers` attaches `Authorization: Bearer <token>`
> from `ORWELL_ENGINE_TOKEN` (`BBAI_ENGINE_TOKEN` legacy fallback), read at call time — both channels share
> `_post_tool`, so player AND admin calls carry it. The installer GENERATES a token into `data/.env`
> (`openssl rand -hex 32`, `/dev/urandom` fallback) — both systemd units read the same EnvironmentFile, so
> engine auth is ON by default even co-located. (A2) an ANONYMOUS caller now sends NO `x-orwell-user` header:
> single-tenant engines default it server-side (unchanged); `ORWELL_ENGINE_MULTIUSER=1` refuses it (400) instead
> of collapsing anonymous sessions into one shared sandbox — the authenticated path is untouched.
> `docs/INSTALL.md` updated. `frontend/tests/test_b67_engine_auth.py`; the engine-side 401/400 behavior was
> already pinned by `tests/integration/httpBoundary.test.ts` (B34).

> In `Psychout-Media/orwell`, close the engine-auth footgun. The engine **enforces**
> `ORWELL_ENGINE_TOKEN` on every route (`src/adapters/mcp/HttpMcpServer.ts:92`), but the front-end has
> **no code path to send it** (`frontend/src/orwell_engine.py:24-27,172-181` send only the user header)
> and the installer never sets it — so the documented way to turn auth on (`docs/INSTALL.md:103-104`,
> "the front-end must then send it") returns **401 on every call and bricks the game**, while the only
> working config runs the engine **unauthenticated** behind nothing but the loopback bind. (1) **FE:**
> read `ORWELL_ENGINE_TOKEN` (+ `BBAI_ENGINE_TOKEN` fallback) and attach `Authorization: Bearer <token>`
> in both `_call` and `_admin_call` when set. (2) **Installer:** auto-generate a token
> (`openssl rand -hex 32`) into `.env` so engine auth is **on by default** even co-located. (3)
> **Multi-user (ops A2):** the engine rejects only a *missing* `x-orwell-user`, but the FE defaults it to
> `"default"` (`orwell_engine.py:27`), so `ORWELL_ENGINE_MULTIUSER=1` silently collapses anonymous
> sessions into one shared sandbox — make the FE send **no** user header when there's no authenticated
> owner (engine 400s), or have the engine treat literal `"default"` as unauthenticated under multi-user.
> *(The authenticated-user path is already sound — don't change how the key is derived from the session.)*
> **Acceptance:** with the token set in `.env`, the FE completes a full create→advance→decision turn and a
> tokenless `curl /player/call` 401s; with it unset, behavior is unchanged; under multi-user an anonymous
> FE call is refused, not routed to `default`. Read `docs/features/0021`, `0009` first. Open a PR.

### B68 — stop dropping the player's knowledge layer on save (live non-degradation)  ·  Claude Code (engine)  ·  **R-0 · CRITICAL · test C1 · ✅ DONE 2026-06-10 (fix shipped with B40; the missing test added now)**

> The snapshot fix itself shipped with **B40** (`SessionSnapshot.knowledge` carries facts + suspicions + the
> id/ts counters; `InMemoryKnowledgeService.serialize/load`; `toGameState().knowledge` feeds the 0031
> checkpoint). What this audit item still lacked was the LIVE-PATH test: new
> `tests/unit/knowledgeSurvivesRestart.test.ts` surfaces a real anchored fact + a suspicion to the player,
> saves through `FileSaveStore`, boots a NEW registry over the same dir (a process restart), and asserts the
> factId + pathway + suspicion survive, `counts().knowledge` is non-decreasing, `isSuperset` holds over the
> live path, and the resumed counters mint fresh ids (audit C3). Memory thinning stays impossible.

> In `Psychout-Media/orwell` (TS engine), a real **non-degradation regression ships today**: the live
> durable snapshot hardcodes `knowledge: []` (`src/engine/sessionSnapshot.ts:79`) and `SessionSnapshot`
> has **no knowledge field** (`:38-41`), so the player's accumulated knowledge (facts surfaced by
> pathway, suspicions) is **discarded on every save** and not restored on restart — the old version's
> exact "memory thinning" failure, reproduced. The non-degradation gate passes anyway because it runs a
> **different** state builder (`gameProgression.ts`) whose `counts()`/`isSuperset` *do* track knowledge
> (`saveState.ts:75,91`), and the live durable test (`durablePersistence.test.ts`) never asserts
> knowledge survives. Per remediation principle #6 (the snapshot is the contract): add `knowledge`
> (and suspicions + the id/ts counters, product-audit C3) to `SessionSnapshot`, serialize it from /
> load it into `InMemoryKnowledgeService`, populate `toGameState().knowledge` so the 0031 checkpoint
> guards it. **Add the live-path test that was missing:** surface ≥1 fact to the player via pathway →
> save + new registry over the same `FileSaveStore` dir → assert the factId and
> `counts(restored).knowledge >= counts(before).knowledge` survive. **Acceptance:** the new live restart
> test fails before the snapshot fix and passes after; `isSuperset` over the live path includes
> knowledge. Read `docs/features/0007`, `0030`, `0002` first. Open a PR.

### B69 — re-point the mandate gates at the production loop (richness · fairness · sentinel)  ·  Claude Code (tests + engine)  ·  **R-1 · MAJOR · test C2 + C3 + C6 · ✅ DONE 2026-06-10**

> **Built to green** (richness-on-production largely landed with **B54**; this finishes the batch). (C2) the
> `reveals=1` backstop was deleted in B54 and the production gate is `liveRichness.property.test.ts`;
> `simulation.ts` is now QUARANTINED (calibration-only header + a source-scan test: nothing in `src/` imports it
> beyond `richness.ts`'s type-only import). (C3) new `tests/property/liveFairness.property.test.ts`: 150 seeded
> seasons through the LIVE loop (the B55 driver) with 16 IDENTICAL houseguests — the player's HOH-reign share
> sits in a band around the exchangeable 1/16 (a hidden +0.1 favor more than doubles it) and season wins stay
> in the fair band; the live emotional-modifier SIGN is pinned for the player (rattled hurts, composed helps);
> the favorite band tightened 65–80% → 67–77% (toward the documented ~72%). (C6) the GENERATED-content sweep:
> every confessional/scene the live loop itself generates (not planted) is verbatim-swept against every player
> surface incl. `getMomentPrompt` (`re-entry` too) across seeds — clean.

> In `Psychout-Media/orwell` (TS engine), three "green" gates measure the wrong thing — the headline
> invariants run against fixtures disconnected from `liveSeason.ts`. Per remediation principle #7 (gates
> on the production path):
> 1. **Richness (mandate #1, C2):** the property test **and the gated BDD 0003** compute
>    `richnessMetrics(simulateSeason(...))`; `simulateSeason` (`src/engine/simulation.ts`) is imported by
>    **nothing in production**, hardcodes `reveals` 0/1 (`:100`) so `maxRevealsPerMoment ≤ 1` is
>    impossible to violate, and **force-sets a reveal if none occurred** (`:116-118`) so `surfacingRate>0`
>    is a tautology. Re-point `richnessMetrics` at a real `Orchestrator`/`liveSeason` run's EventStore
>    over a full season; **delete the `reveals=1` backstop**; quarantine `simulation.ts`.
> 2. **Anti-sycophancy (mandate #3, C3):** fairness is tested only at the pure `resolveCompetition` unit
>    with no soul modifier; the **live** loop wires the 0006/0028/0041 emotional modifier and a sign
>    error there would protect the player unseen. Add a live statistical test — favorite-win band **and**
>    `winRate(player) == winRate(npc)` at identical stats+soul over N seeds — and tighten the loose
>    65–80% band toward the documented ~72%.
> 3. **Sentinel (mandate #2, C6):** the canary injects sentinels into `buildEngineCore` (narrow) and the
>    UAT leak check is a fixed numeric regex, so a hidden **content string** the live loop generates (a
>    confessional line) leaking verbatim into `getMomentPrompt` is invisible. Tag live-generated hidden
>    content with a unique sentinel and assert it never appears on any player-channel response across
>    seeds.
> **Acceptance:** mutating the live reveal gate to "never reveal" fails the richness test; injecting a
> +0.1 player modifier into the live competition path fails the fairness test; echoing a seeded live
> confessional sentinel on a player surface fails the canary. Read `docs/features/0003`, `0006`, `0001`
> first. Open a PR.

### B70 — close the structural test & CI gaps (boundary · 0038 · coverage)  ·  Claude Code (tests + CI)  ·  **R-1 · MAJOR · test C4 + C7 + C8 + C9 · ✅ DONE 2026-06-10**

> **Built to green.** (C4) done by B59 — `adapters/narrative/` + `main.ts` joined the depcruise OUTWARD set.
> (C7) 0038 is now genuinely gated: B27b built (see B27 above) and BOTH 0035 and 0038 run in `cucumber.cjs`
> with real step definitions (`offscreen_society.steps.ts` — reusing the 0031 watcher steps where the phrases
> are shared). (C8) CI gains a `coverage` job; per-directory BRANCH thresholds live in `vitest.config.ts`
> (engine 90 · composition 88 · adapters/engine 82 — floors at today's real levels so coverage can only
> ratchet up; engine/composition meet the audit's ≥90). (C9) `tests/unit/failClosed.test.ts`: a leaking apply
> ⇒ fault + ROLLBACK + zero saves (a counting store proves no persist) + no aborted event left behind; the
> finale-answer rejection path covered (illegal appeal refused, the pending question survives, legal proceeds).

> In `Psychout-Media/orwell`, four gaps let mandate-violating regressions through a green gate:
> 1. **C4 — the narrative adapter is outside the Vault boundary.** `.dependency-cruiser.cjs` OUTWARD
>    covers `surfaces|services|outwardRoot|adapters/mcp` but **not** `adapters/narrative/` — the literal
>    pipe to the model; wiring `VaultStore`/`SoulStore` into `LlmNarrativePort` to "enrich" narration
>    would pass. Add `^src/adapters/narrative/` to OUTWARD. *Acceptance:* a temporary
>    `import type { VaultStore }` in `LlmNarrativePort.ts` fails `test:arch`.
> 2. **C7 — feature 0038 is spec'd but un-gated.** `docs/features/0038-live-offscreen-society.feature`
>    has 6 scenarios and **zero step definitions** (26 undefined steps), absent from `cucumber.cjs` —
>    implying coverage of Vault-isolation + cross-user + gossip behaviors that doesn't exist. Either gate
>    it with real steps (pairs with B27b's gossip→player work) or move the `.feature` to `drafts/` so the
>    repo stops implying coverage.
> 3. **C8 — CI never runs coverage.** `.github/workflows/ci.yml` runs the functional gate but no
>    `test:cov`/thresholds, so coverage can silently regress. Add a coverage job with per-directory branch
>    thresholds (`src/engine`, `src/composition`, `src/adapters/engine` ≥ 90%). *(As built — see the DONE
>    note above: engine 90 · composition 88 · adapters/engine 82, floors at the then-real levels so
>    coverage only ratchets up; the audit's E87f records the deviation from the stated 90/90/90.)*
> 4. **C9 — the 97.6% headline masks the orchestrator rollback path.** `src/composition/orchestrator.ts:
>    184-200` (the fail-closed integrity checkpoint's rollback — what protects against persisting a
>    degraded/leaky state) and `GameSessionAdapter` finale-answer rejection (81% branch) are uncovered.
>    Add tests: force an integrity failure → assert rollback + **no** persist; cover the finale-answer
>    reject path.
> **Acceptance:** all four above; dropping a covered branch below threshold fails CI. Open a PR.

### B71 — production-grade deploy: atomic/rollback updates, boot preload, real smoke  ·  Claude Code (deploy + engine runtime)  ·  **R-2 · MAJOR · ops A4 + A6 + A7 · ✅ DONE 2026-06-10**

> **Built to green.** (A4) `orwell-update.sh` builds BEFORE committing to the swap: a failed build reverts to the
> previous SHA + the preserved `dist.prev` and does NOT restart (clear message + hints); `REF=<sha|tag>` pins the
> target; `--rollback` returns to the recorded previous SHA/dist (`data/.update-prev`). (A6) done by **B60**
> (`composeRuntime` preloads every saved user at boot via `listUsers`). (A7) `deploy/smoke.sh` gained a real
> END-TO-END stage: a TOKEN-ENFORCING engine (tokenless 401 proven), the REAL front-end booted against it, and one
> full create→advance→decision turn driven through the FE's guarded routes (`deploy/smoke_turn.py`) — proving B67
> end-to-end; a stale-port pre-flight stops false positives; CI's smoke job installs the FE deps. The new stage
> immediately CAUGHT a real restart bug: off-screen/confessional event ids were index+rng-keyed, so a restarted
> process re-minted identical ids against a restored store and the duplicate-id guard killed the tick — ids are
> now store-size-keyed (the B40 pattern). Note: `advanceGame` is deliberately agent-path-only, so the smoke turn
> advances on the engine's authed channel and binds the decision through the FE's sanctioned `/decision` route.

> In `Psychout-Media/orwell` `deploy/` (+ a small `src/` runtime change), make the deploy lifecycle safe:
> 1. **A4 — atomic, pinned, rollback-able updates.** `orwell-update.sh:66-72` does
>    `git reset --hard origin/main` **then** `npm ci && build` under `set -e`, so a build failure leaves
>    the tree on new `main` with the old `dist/`; it always pulls unpinned `main` with no rollback. Build
>    **before** committing to the swap (restart only on build success; leave the prior checkout on
>    failure), add `REF`/`TAG` pinning, and keep the prior `dist`/SHA for `--rollback`.
> 2. **A6 (= product-audit E11) — preload saved users at boot.** The watcher iterates only **in-memory**
>    `registry.usernames()` (`gameWatcher.ts:52`, `registry.ts:155-157`); at process start the map is
>    empty, so every restart (incl. every update) **freezes all saved users' off-screen society** until
>    each next call. At `runtime.start()`, enumerate `saveStore` users and warm their sandboxes.
> 3. **A7 — a smoke test that proves the system works.** `deploy/smoke.sh` starts only the engine and
>    stops at `createCharacter` — a green run is compatible with a broken FE or a non-advancing game. Add
>    a stage that boots the FE on `ORWELL_PORT`, hits a real route, and drives one
>    create→advance→decision turn through the FE, including one pass with `ORWELL_ENGINE_TOKEN` set
>    (proving B67).
> **Acceptance:** a forced build failure leaves services on the previous build with a clear message + a
> pin/rollback path; after a restart with N saved users and a live watcher, off-screen events accrue with
> no prior request; smoke fails if the FE can't reach the engine or a turn can't complete. Read
> `docs/features/0030`, `0035`, `0031` first. Open a PR.

### B72 — deploy hardening & operability: drop root, backup/DR, dir split, hygiene  ·  Claude Code (deploy/systemd + docs)  ·  **R-2 · MAJOR · ops A5 + A8 + A9 + A3 + A10 · ✅ DONE 2026-06-10**

> **Built to green.** (A5) both units run as a dedicated `orwell` system user (installer creates + chowns) with
> `NoNewPrivileges` / `ProtectSystem=strict` / `ProtectHome` / `PrivateTmp` and `ReadWritePaths` scoped to the two
> data dirs; the engine unit runs `node dist/main.js` directly (npm wants a $HOME cache the sandbox denies).
> (A8) `orwell-backup.sh` / `orwell-restore.sh` cover BOTH state dirs (engine `data/` + FE `frontend/data/`);
> `orwell-ready.sh` = readiness, not liveness (engine + FE + an ONLINE model via `/api/models`); INSTALL.md
> documents the real two-dir layout. (A3) the installer writes the names the FE actually consumes (`LLM_HOSTS`
> for an OpenAI-compatible endpoint like Ollama's, `OPENAI_API_KEY`) — or honestly says "configure in Settings";
> the never-read `ANTHROPIC_API_KEY` write is gone. (A9) saves live in `data/saves/` distinct from `data/.env`
> (`ORWELL_DATA_DIR=${DATA_DIR}/saves` on new installs); the factory-reset's stale comment is fixed and all three
> layout generations scrub correctly. (A10) `EnvironmentFile=-` (optional), the `Wants=` degraded mode documented
> in the unit, REF/rollback documented in INSTALL.md.

> In `Psychout-Media/orwell` `deploy/` + `docs/INSTALL.md`, make the box operable and least-privilege:
> 1. **A5 — drop root + systemd hardening.** Neither unit sets `User=`; both run as **root** with an
>    internet-facing FastAPI app (`orwell-frontend.service:12` binds `0.0.0.0`). Create an `orwell` system
>    user, `chown` app+data, set `User=orwell`, and add `NoNewPrivileges=yes`, `ProtectSystem=strict`,
>    `ProtectHome=yes`, `PrivateTmp=yes`, `ReadWritePaths=` scoped to the two data dirs.
> 2. **A8 — backups, readiness, DR.** "Backups" is prose that **misstates the layout** (the FE SQLite is
>    `frontend/data/app.db`; engine saves are JSON under `data/` — two dirs, one undocumented). Ship
>    `orwell-backup.sh`/`orwell-restore.sh` covering **both** dirs, document the layout correctly, and add
>    a **readiness** check (engine reachable + FE up + **LLM configured**).
> 3. **A3 — installer writes a key the FE never reads.** Install writes `ANTHROPIC_API_KEY`
>    (`orwell-install.sh:84-90`) but the live engine narrator is `EchoNarrativePort` and the FE reads
>    `OPENAI_API_KEY`/`settings.json` (`constants.py:34-36`) — so "configured" is a **false signal** and a
>    fresh box isn't playable. Map the installer prompt to the names the FE consumes, or change the copy to
>    "configure the LLM in Settings after install."
> 4. **A9 — saves + secrets share one dir.** `/opt/orwell/data` holds both saves and `.env`; factory-reset
>    keeps only a file literally named `.env` (`orwell-factory-reset.sh:172-174`) — fragile once B67 adds a
>    generated token. Put saves in `data/saves/` distinct from `data/.env`; scrub the subdir wholesale; fix
>    the script's stale `ORWELL_DATA_DIR` comment.
> 5. **A10 — hygiene.** Mark `EnvironmentFile=-` optional (manual installs before `.env` fail confusingly);
>    document the FE-without-engine degraded behavior (`Wants=` not `Requires=`); support `REF=` +
>    document verifying the piped script (unpinned root `curl|bash`); set a journald `SystemMaxUse=` cap +
>    `SyslogIdentifier=`; assert a dummy key never appears in captured logs.
> **Acceptance:** `systemctl show -p User` is non-root and the game still plays; a documented
> backup→wipe→restore round-trips a game and readiness returns non-OK when the LLM is unconfigured; a
> fresh install is either playable with zero UI config or the docs say plainly it isn't; reset removes
> only the saves subdir + FE store. Open a PR.

### C29 — front-end app-security hardening + the sandbox-isolation regression test  ·  Claude Code (front-end)  ·  **R-1 · MINOR (posture) · sec §B2/B4/B5/B6/B7 + test C5** — ✅ DONE (verified 2026-06-10: hardening + isolation pins in the FE suite)

> In `Psychout-Media/orwell` `frontend/`, the app-security posture is **sound** (no bypass) — these are the
> minor-but-worth-it hardening items the audit flagged before a multi-user/internet deploy, plus the one
> missing regression test:
> 1. **C5 — guard the trust path that's correct today.** Nothing asserts the engine `X-Orwell-User` key
>    is derived from `request.state.current_user` rather than client input, or that two authed users get
>    **distinct** sandboxes. Add an FE test that **fails if** a route forwards a client-supplied `user` or
>    routes an authenticated user to `"default"`.
> 2. **B2 — two inherited verticals survive the game build.** `vault_routes` (Bitwarden/`bw` CLI,
>    `app.py:737`) and `mcp_routes` (register external MCP servers incl. `stdio` = arbitrary host binary,
>    `app.py:693`) are mounted **unconditionally** (admin-only, so not an escalation path, but outside the
>    "game and nothing else" keep-set). Route both through `mount_optional` under their own keep flags;
>    assert they 404 under `ORWELL_GAME_BUILD=1`.
> 3. **B5 — `SECURE_COOKIES` defaults false** (`auth_routes.py:141`) and the installer doesn't set it.
>    Default it true in the deploy env or auto-set `Secure` on `X-Forwarded-Proto: https`.
> 4. **B4 — rate-limiting keys on `request.client.host`** (`auth_routes.py:79-81`), which behind the
>    anticipated reverse proxy is the proxy IP — all users share one bucket. Key on a trusted
>    `X-Forwarded-For` (left-most, only behind a configured trusted proxy) and/or add per-username lockout.
> 5. **B6 — wire the dead entitlement layer.** `require_entitlement`/`has_entitlement` exist but **no
>    route calls them** (all use bare `require_admin`); route LLM-settings + user-management through
>    `require_entitlement` so a future non-admin grant actually works.
> 6. **B7 — pin `frontend/requirements.txt`** (only `pydantic>=2.0` is pinned) with a lockfile/hashes.
> **DoD:** the isolation test fails if the route trusts a client `user`; `/api/vault/config` and
> `/api/mcp/servers` 404 under the game build; `pytest` + the 0032 headless gate green; engine gate
> unaffected. Open a PR.

### C30 — settings model ruling: global LLM config (admin-set, hidden from non-admins) · per-profile preferences  ·  Claude Code (front-end)  ·  **R-0 · CRITICAL (multi-user) · settings S1 + S4 · RULING 2026-06-09** — ✅ DONE (verified 2026-06-10: `_PER_USER_KEYS` model + `test_c30_settings_model.py`)

> In `Psychout-Media/orwell` `frontend/`, implement the **settings model ruling** (see the addendum in
> `docs/audits/2026-06-09-settings-menu-audit.md`): **the first admin sets up the LLM (services/ai)
> and those settings are GLOBAL for all users** — logically-global things are global, unchangeable
> by, and **hidden from** non-admins; **user-based preferences persist per-profile**, never globally.
> Concretely:
> 1. **Mark `services` and `ai` admin-only** (join `tools`/`users`/`system` in `syncAdminVisibility`,
>    `settings.js:5060-5062`) so a non-admin never sees LLM config at all — today they land on
>    `services` as the **default tab**, see "None", and 403 on every action (`model_routes.py:1421,
>    1488,1684`, `auth_routes.py:461-466`). Pick a sensible non-admin default tab (account or
>    appearance).
> 2. **Verify and test that a non-admin actually inherits the global LLM config** — the global
>    `default_chat` endpoint/model must drive a non-admin's game turn with zero settings interaction
>    (this is the crux of the ruling: admin configures once, everyone plays). **The chat-bar model
>    switcher STAYS for every user** (ruling): selecting *among* the admin-provisioned
>    endpoints/models is a per-profile preference (persist via the `_PER_USER_KEYS`
>    `default_endpoint_id`/`default_model` seam, `settings.py:379-388` / `prefs_routes.py:82`),
>    layered over the global default — what's hidden is the config/management surface (endpoints,
>    keys, global defaults), never the picker.
> 3. **Per-profile preferences done right (S4):** `saveKeybinds()` swallows the admin-only 403 and
>    toasts "Shortcut saved" while nothing persists (`settings.js:1855-1868`). Persist keybinds via
>    per-user **`/api/prefs`** (`prefs_routes.py:82`), and apply the same rule to any other genuine
>    preference (appearance is localStorage today — optionally migrate to `/api/prefs` for
>    cross-device). No preference ever writes the global settings store.
> 4. Amend **B69**'s readiness check: "playable after install" must hold for a **non-admin** user —
>    admin sets the model once, a fresh non-admin account plays with zero config.
> **DoD:** a non-admin sees no `services`/`ai`/LLM surface anywhere; their game speaks using the
> admin's global config with zero setup; their keybind change persists per-profile across reload and
> does NOT affect other users; an admin's change to the global model affects everyone; `pytest`
> green; engine gate unaffected. Open a PR.

### C31 — finish the Settings game-build prune (no dead tabs, no live JS behind hidden ones)  ·  Claude Code (front-end)  ·  **R-2 · MAJOR · settings S3 + S5 (S2 superseded by C32)** — ✅ DONE (verified 2026-06-10: pruned with the C30 settings model)

> In `Psychout-Media/orwell` `frontend/`, close the cosmetic-hide-live-code pattern in the Settings
> modal (`docs/audits/2026-06-09-settings-menu-audit.md` S3/S5). **Note the ruling: `search` is NOT
> pruned — it is re-wired as a core in-game capability by C32** (the settings tab becomes
> admin-only global config like services/ai, per C30). Remaining prune work:
> (1) `email`/`reminders`/`integrations` are CSS-hidden (`game-trim.css:59-63`) but their `init*`
> handlers still run on every settings open (`settings.js:2081-2085`) and bind controls to 404'd
> endpoints (reminders Test → `/api/notes/fire-reminder`; email → `/api/email/*`). Gate those
> `init*` calls behind the game-build flag, and ideally strip the dropped panels **server-side**
> (extend the `index.html` rewrite that already does `strip_dropped_scripts`).
> (2) Trim the admin **System** tab's Danger-Zone wipe list + export/import to live game data —
> today it names memory/skills/notes/tasks/documents/gallery/calendar (`index.html:2099-2153`),
> categories the game build doesn't have (pair with **B71/B72**'s backup work; chats + the engine
> save dir are the real categories).
> **DoD:** under the game build no settings-originated request hits a 404'd endpoint (network-spy
> test); System offers only live-data wipes; with `ORWELL_GAME_BUILD=0` the full inherited Settings
> works unchanged; `pytest` + the 0032 headless gate green. Open a PR.

### C32 — re-wire web search as an in-fiction agent capability (the house knows the real world)  ·  Claude Code (front-end + engine prompt)  ·  **R-0 · CRITICAL · RULING 2026-06-09 · amends 0032** — ✅ DONE (verified 2026-06-10: `test_c32_infiction_search.py`)

> In `Psychout-Media/orwell`, implement the **search ruling**: the LLM must be able to **leverage web
> search in-character** — when the player references something the model doesn't know (say, a new
> movie, mid-conversation with a houseguest), the agent quickly searches, gathers results, and
> synthesizes an appropriate **in-game response in the voice of whoever the player is talking to**.
> This **amends feature 0032**: `web_search` moves from the drop-set to the **keep-set** (see the
> amendments table in `docs/features/README.md`).
> 1. **Re-mount the vertical:** remove `web_search` from `GAME_DROP_SET` (`settings.py:215`) so the
>    router mounts (`app.py:581`) and `/api/search/query` works under the game build; keep the
>    Settings `search` tab, **admin-only** (global provider/key config, per the C30 ruling) — its
>    Test button now actually tests.
> 2. **Expose it to the agent:** add `web_search` to the game build's agent tool surface
>    (`GAME_TOOL_KEEP` / `agent_tools.py` / schemas) so the model can call it during game turns.
>    Fail-soft: if no provider is configured, the tool returns a clean "no search available" result
>    — the model improvises in character, never errors at the player.
> 3. **In-fiction synthesis (the crux):** add a moment-prompt clause (engine,
>    `src/engine/momentPrompts.ts` — pairs with C19's preamble work): real-world references may be
>    looked up **silently**; results are woven into the houseguest's voice ("oh I saw the trailer
>    before we came in the house!") — never presented as search output, never breaking fiction.
>    **Hard guardrail (anti-sycophancy + ADR 0003):** search informs **flavor and real-world
>    knowledge only** — it must never resolve a game fact, outcome, or hidden state; game truth
>    comes only from the engine tools. NPC knowledge of the real world is fine (houseguests lived
>    in it until move-in day); awareness of events *after* move-in is a fiction-consistency choice
>    the prompt should handle gracefully (the house has no internet — a houseguest can know the
>    movie, not this week's box office).
> 4. **Diegetic rendering:** the search tool-node must not break immersion (pair with C14/F6's
>    restyle — e.g. a quiet "📺 production research…" node, raw results never dumped in the
>    transcript).
> **DoD:** under the game build, a scripted agent turn where the player mentions a real-world topic
> can call `web_search` and the reply is in the NPC's voice with no raw search output in the
> transcript; with no provider configured the turn still completes in character; search results
> never feed a `submitDecision`/game-outcome path (assert: no search-derived content in binding
> calls); the Settings search tab is admin-only and its Test works; `pytest` + the 0032 headless
> gate green; engine gate green. Open a PR.

### C33 — the snarky hero tagline is genuinely AI-generated (not the curated fallback)  ·  Claude Code (front-end + engine)  ·  **R-2 · MINOR · RULING 2026-06-09** — ✅ DONE (verified 2026-06-10: `test_c33_ai_tagline.py`)

> In `Psychout-Media/orwell`, make the player tagline (0033) **actually AI-generated** when a game is live,
> reserving curated/static text for the fail-open path only. Today it is **never** model-generated:
> `GameSessionAdapter.playerTagline()` (`src/adapters/engine/GameSessionAdapter.ts:232-256`) only calls
> a narrator if `this.narrator` is set, and **`setNarrator` is never called in the live composition**
> (`outwardRoot.ts` wires `EchoNarrativePort` and nothing wires the tagline narrator) — so every live
> tagline is the hardcoded `SNARKY_TAGLINES[standing]` curated line, and the front-end client
> (`orwell_engine.player_tagline`) just relays it. Per ADR 0003 (engine supplies Vault-free facts, the
> **front-end LLM voices**), generate the line where the real model lives:
> 1. **Front-end generates it** from the engine's Vault-free standing/state (`gameStatus` + the engine's
>    curated line as a seed/anchor) via the existing `llm_core`/`llm_call_async` path, with a tight
>    anti-sycophantic instruction (a weak standing must NOT flatter — keep 0033's calibration). One line,
>    bounded length; **cache per `(user, week, phase, standing)`** so it regenerates only when the moment
>    advances, not per page load (mirror the engine cache at `GameSessionAdapter.ts:102-103,234-236`).
> 2. **Fallback chain, in order:** FE LLM line → the engine's curated `SNARKY_TAGLINES[standing]`
>    (still Vault-free, state-aware) → the static **"The house is waiting."** (PR #136). Never blank,
>    never blocks the homepage (keep the fail-open contract + `test_orwell_social.py`).
> 3. **Pre-game** (no started game) keeps a themed default — generation only kicks in once there's state
>    to be snarky about.
> *(Alternative if engine-side generation is ever preferred: wire a real `NarrativePort` via the
> existing `setNarrator` seam in the live root — but the FE-LLM path is the ADR-0003-consistent choice
> and needs no new engine narrator.)*
> **Vault-free by construction:** the tagline is built only from the public standing projection — never
> hidden votes/targeting/souls/off-screen (extend the 0001 canary on `playerTagline` already covers the
> engine side; assert the FE prompt carries no Vault field). **DoD:** with a live game + LLM configured,
> the hero line varies and is model-written (not one of the fixed curated strings); with the LLM/engine
> down it falls through curated → "The house is waiting." without blocking; cached per moment; `pytest`
> green; engine gate unaffected. Read `docs/features/0033-dynamic-player-tagline.md` + ADR 0003 first.
> Open a PR.

## The casting interview (feature 0050) · 2026-06-10 — ✅ DONE

### B73 — 0050 the casting interview: producer-led character creation  ·  Claude Code (engine + FE)  ·  **product ruling 2026-06-10 · ADR 0003 · evolves 0015 — ✅ DONE**

> **DONE** (spec `docs/features/0050-casting-interview.{md,feature}`; in `cucumber.cjs`). Character
> creation is now the game's first SCENE, not a form: pre-game, the chat is the producer's "get to
> know the cast" interview. Engine: the `character-creation` moment prompt is the full interview
> operating manual (producer persona, coverage list, the canonical archetype/style **manifest
> generated from `ARCHETYPES`** — drift-tested, ending protocol); `CreateCharacterReq` carries the
> distillation (`personaArchetype`/`personaStrategyStyle`, `backstory`, `motivation`,
> `privateStrategy`, `interviewNotes[]`); the deepeners seed `Character.background` + the player's
> `Soul.memory` (pre-game memories, snapshot-durable per 0030) and the player-only fields; the
> creation return carries the **casting card** (`characterType`, `strategyStyle`, per-aptitude
> **tier words** standout/solid/scrappy, story, motivation) — qualitative only, no number crosses
> (the persona sentinel test now proves the card carries words and the payload no floats).
> Front-end: `apply_game_framing` injects the interview moment **pre-game under the game build**
> (the missing seam — pre-game chat had no game framing at all); the `createCharacter` FE schema's
> archetype enum was DRIFTED (five stale labels) — replaced with the canonical 12 + the deepener
> params, with a C13-style drift test parsing `characterFactory.ts`; `orwellOnboarding.js` is now
> the interview **gate** ("the producers will see you now" → prefill the composer, never auto-send;
> quick-start name-only fallback kept as the no-model escape hatch, audit J4). 0015's invariants
> all hold (balanced bounds, OOC/no-witness, B36 no-wipe). 7 BDD scenarios + 12 unit + 8 pytest.
> **Evolving mechanic** — anticipated next steps in 0050 §9 (richer derived signals, NPC casting
> tapes, producer follow-ups rereading the interview).

### B73b — 0050 v2: incremental intake — the modal is GONE; the chat acquires everything  ·  Claude Code (engine + FE)  ·  **product ruling 2026-06-10 — ✅ DONE**

> **DONE.** Ruling: the authoring data must be "acquired through the actual chat with Orwell instead of
> being a modal popup", and "OOBE can be half done … the status of which determines what the next step
> is within the game engine." Engine: a new `updateCasting` player tool records answers AS THEY LAND
> (any subset; notes append) into a durable pre-game intake (`SessionCore.casting` — a half-done
> interview survives a restart, 0030); `castingStatusOf` (pure, `src/engine/castingIntake.ts`) computes
> { known, missing, next, ready } in the engine's ask-order — **the engine, not the model, owns the next
> step**; the pre-game `GameStateView`/moment prompt carry the live status ("already on file — do not
> re-ask"); `createCharacter` finalizes FROM the intake (`playerName` now optional; rejected if no name
> anywhere); the casting tools (`createCharacter`/`updateCasting`/`getMomentPrompt`) may mint a fresh
> user's sandbox (HttpMcpServer allowlist). Front-end: `apply_game_framing` fetches the interview moment
> pre-game (fallback: a producer-voiced static steer); the C23 authoring form is **deleted** —
> `orwellOnboarding.js` keeps only the J4 model-gate + F5 dark-house holding cards and the seat hand-off
> (fresh chat session per interview = the F7 fence, then prefill "I take my seat for the casting
> interview." — never auto-send); `updateCasting` wired through schemas/agent allowlists/executor with
> the C13-style enum drift tests now covering both casting tools. 4 new BDD scenarios (11 total) +
> 8 new unit (20) + FE pytest green.

## UI & runtime audit batch (D1–D11) · 2026-06-10 (round 4) — ✅ DONE

> **Corrected 2026-07-05 (doc-drift audit-closure):** this header read "OPEN" while the file's own
> top banner and CLAUDE.md's architecture section both describe this batch as shipped — spot-verified
> D1 (`src/composition/orchestrator.ts` `forgetUser` + `src/composition/registry.ts` `resetUser` — the
> "ONE sanctioned season-restart door" CLAUDE.md's own architecture section names as built) and D9
> (portraits are live on roster/status/decision surfaces per 0051). No item in D1–D11 was found open
> in this pass; if a specific one resurfaces, flag it explicitly rather than reverting this header.

> Source: `docs/audits/2026-06-10-ui-runtime-audit.md` (full UI runtime audit: tool→display map,
> 121-claim verification, live Playwright across mobile/tablet/desktop and staged game states).
> Wave order: D1→D4 are CRITICAL (D1 first — it unblocks re-measuring D4); D5–D10 MAJOR; D11 MINOR.

### D1 — one sanctioned season-restart door (the headline)  ·  CRIT  ·  engine + FE route

> The FE's `/api/orwell/new-game` restarts via player-channel `createCharacter+confirmRestart`;
> the orchestrator's non-degradation baseline correctly reads the fresh season as catastrophic
> loss ⇒ every post-restart player-turn commit faults and is never persisted; on engine restart
> the finished season resurrects (verified live: after ~60 restarts the durable save still held
> season 1). Route the FE reset through the admin reset delegate (`registry.resetUser`, where
> `registry.ts:190` says B36/C12 belong) — or make `confirmRestart` reset the orchestrator
> baseline + saves identically; a fault on the restart commit must fail the request (4xx), never
> 200-then-rollback. **Add the missing test: play season 1 → FE-style restart → season 2's first
> save survives an engine restart.** Also fixes the `recordInteraction` 500s and the new-game
> state races observed on the faulted sandbox.

### D2 — floating-panel placement: nothing may cover the composer or another panel's controls  ·  CRIT  ·  FE

> At 390×844 the presence strip floats over the composer (play impossible on a phone); post-season
> the retrospective panel does the same at mobile AND tablet; the status HUD covers the social
> HUD's Diary button at ALL viewports (the DR modal cannot be opened by pointer anywhere). Also
> fix the `.hidden modal-minimized` state that still intercepts pointer events. Add the harness's
> overlap/interception checks to `browser_smoke.py`.

### D3 — decision card survives reload  ·  CRIT  ·  FE

> `orwellDecision.js` mounts only on the live agent-turn `orwell:pending` event; reloading
> mid-decision leaves no card and no signal a decision is owed. On boot, read the pending from
> `/api/orwell/state` and dispatch the same event.

### D4 — player-survival calibration (the player has never reached the jury)  ·  CRIT  ·  engine

> 62/62 seeded seasons end with the player out pre-jury (passive driver; self-saving veto answers
> included; the one fault-free season matches). Move-in priors + threat-primary noms + ever-
> deepening NPC↔NPC bonds make the player the standing consensus target. Investigate, calibrate,
> and add a property gate (passive player reaches jury in ≥X% of seeds); re-measure the social
> (recordInteraction-folding) path after D1.

### D5 — diegetic labels for updateCasting/whereabouts/seasonRecap/seasonRetrospective/npcVoice  ·  MAJOR  ·  FE + test

> The five tools render raw camelCase names in the transcript (`_orwellToolBeats` gaps); extend
> the C13 drift test to require a display label (or INFRA exemption) per lever.

### D6 — game build must not load KaTeX/Mermaid from a CDN  ·  MAJOR  ·  FE
### D7 — in-game holding copy game-framed; hide the Agent/Chat toggle on game turns  ·  MAJOR  ·  FE
### D8 — entropy default seed (same name must not replay the identical season; explicit seeds stay for tests)  ·  MAJOR  ·  engine
### D9 — portraits on roster/status/decision surfaces (C21/V2 as stated)  ·  MAJOR  ·  FE
### D10 — malformed tool args ⇒ 400 refusal, never 500 (schema-validate at the HTTP boundary)  ·  MAJOR  ·  engine
### D11 — HUD chrome tap-target floor (–/× buttons); state cache-bust on new-game  ·  MINOR  ·  FE

## The prioritized UI track (rulings #15/#16) · 2026-06-10 — IN PROGRESS

### U1 — Stream S responsive mechanism (the spine)  ·  **✅ DONE (PR #203)**

> `responsive-tokens.css` (breakpoint tokens 480/768/1024/1440 · container 360/620 · rem scale on a
> fluid root · --tap-min coarse floor · standalone tier · text-size-adjust) + the S5 normalization
> (41 JS innerWidth sites → platform.js `isNarrow()`/`isBelowMedium()`; every @media width on the
> token set, settings-600 dup as a ratcheted exception) + S7 PWA icons (real maskable 192/512 +
> apple 180, precached, served-200-asserted) + the source lint gate
> (`tests/test_s_responsive_mechanism.py`) + the runtime matrix gate
> (`scripts/responsive_matrix.py`, in CI: 6 viewports + settings passes + 200% font; overflow/
> overlap/crowding/touch; XFAIL registry by finding ID — ratchets as U2–U4 land).

### U2 — settings repair (S1 S2 S3 S12 A3)  ·  **✅ DONE (PR #205)**

> The modal sizes with `clamp(560px, 58cqw, 880px)` against its overlay container (S13's cqw fix) +
> `max-height: min(85dvh, 720px)` with the S2 short-viewport tier; the rail is fluid
> (`clamp(140px, 18cqw, 200px)`); the WHOLE settings type tree is on the --fs-* rem scale (45 region
> rules + 99 settings.js + 49 index.html inline sizes — zero px font-sizes remain, enforced; the
> density lever works again); ONE narrow-layout switch (the @container 620 query — the @media-600
> dup is deleted and the lint-gate exception registry is EMPTY); tab-rail edge-fade affordance; the
> A3 layout kit (.settings-section/-title/-divider/-hint/row variants/gap utilities) with the
> inline-style ratchet (219 → 212, capped). Matrix gate: S1 + S9 flipped from xfail to hard passes
> (37 pass · 0 xfail · 0 fail).
### U3 — chrome & windows (rulings #3/#4/#7/#8/#10/#12)  ·  **✅ DONE (PR #206)**

> In the lane's order: E64 status HUD → permanent sidebar section (collapse-in-place, E68 backoff
> reset + E69 ordinals folded in) · E88 Diary Room → standing sidebar button + composer DR mode
> (capture-phase send interception; the floating dialog is gone; social keeps only approaches) ·
> E95 minimize dock → sidebar "Windows" rows (chatbox chip strip dead; the .modal-minimized
> pointer-events leak killed by CSS) · E90 icon-only theme button in the bottom cluster · E91/S11
> the anchor-slot registry (`orwellSlots.js`: four slots stacking by measured height; drag persists
> a clamped offset-from-slot; D2 structural — the matrix XFAIL registry is EMPTY) · E97 one shared
> open animation honoring reduced-motion · E92 composer bottom inset · E67 finale-panel parity
> (adaptive poll, sheet, aria-live reveals) · E71 per-user panel keys. E70 deferred to Lane 1's D1
> one-door work by design.
### U4 — transcript surface + trims + 0052 themes  ·  **✅ DONE (PR #208)**

> E65 the gamechanged dispatcher + restart-opens-a-fresh-session · E93 the played record (game
> transcripts keep only copy/fork — no edit/delete/regenerate/rewrites) · D3/E66 pending survives
> reload (per-user FE cache at the three AdvanceView chokepoints, served on /status, card re-arms
> on boot/gamechanged) · D5/W6 diegetic beat labels for the ENTIRE keep-set incl. ui_control, with
> the drift test iterating GAME_TOOL_KEEP · E72 model picker admin-only under the game build ·
> E96 Save-to-Documents removed · D7 game-framed empty-state copy + the Agent|Chat toggle hidden
> on game turns · D6/W8 zero third-party CDN under the game build (KaTeX/Mermaid stripped at
> serve; jsdelivr gone) · E94-FE the first-class composer paperclip + the framing/attachment
> coexistence gate · 0052 the five house themes (The Feed · Telescreen · Room 101 · Memory Wall ·
> Sequester) leading the picker — frosted backdrop-blur chrome with the @supports fallback,
> per-theme micro-motion on the E97 contract (reduced-motion strips motion, never frost), AA
> contrast gated in pytest.

## The round-5/6 parallel lanes · 2026-06-10

### L1 — restart & spine (E1+D1+R1 · E2 · E3 · E6 · E7 · E57/R5 · R3 · R4 · E70 · T14)  ·  **✅ DONE (PR #215)**

> The ONE sanctioned restart door: `Orchestrator.forgetUser` + save-dir rotation
> (`UserSaveStore.resetUser`/`FileSaveStore`) wired into `registry.resetUser`, and the player
> channel's confirmed `createCharacter` restart now delegates through that same hinge
> (`GameSessionAdapter.setOnRestart`) — season 2 commits clean, persists, and survives an engine
> restart (the headline R1 production bug; proven end-to-end in
> `tests/integration/restartSpine.test.ts`, the audit's named missing test). E3: a refused commit
> THROWS typed (`TurnRefusedError` ⇒ 409; never 200-then-rollback) with one `onPersist` per beat
> (`inOneCommit`); E7: persist failures are their own fault class (`PersistFailureError` ⇒
> sanitized 500, fail-closed rollback) + `EngineRefusal` typing; E2: pre-game ticks gated and the
> synthetic npc pool deleted; E6: boot preload seeds baselines (`seedBaseline`); E57/R5: the
> turn-driven tick debounced to the turn boundary (beat commits always tick; aux tool calls share
> one); R3: the exported snapshot reused across checkpoint/save/tick (≤2 serializations per
> mutation, save by reference); R4: idle-sandbox LRU unload (`maxResident`, rebuilds from disk);
> E70: `POST /api/orwell/new-game` admin-gated (the chat tools are the player door; smoke/matrix
> configs keep working); T14: the restore-into-fresh-registry tick regression test. Unit gates:
> `restartDoor.test.ts` + `spineHardening.test.ts` + `test_e70_new_game_gate.py`.

### U-L2 — Lane 2: knowledge integrity (engine) — E9+C2+C3 · C14 · E20 · E21  ·  **✅ DONE (PR #212)**

> **E9/C2/C3 (one fix site — `InMemoryKnowledgeService.pathwayAnchored`):** anchoring now requires
> **content lineage** — `told-by:` must derive from what the teller actually holds (content or its
> undistorted gossip origin) or witnessed (subject-only match no longer anchors, the C2 exploit);
> `overheard:<id>` must derive from THAT event's content (a strict normalized fragment, the shape
> `rollOverhears` produces — a real id no longer anchors unrelated invented content, the E9/C3
> exploit). Anchored knowledge is by construction a fragment of something real; everything else
> downgrades to a suspicion with **capped** confidence. **C14:** `clamp01` on confidence at every
> knowledge write seam (`pushKnown` — surfacing/seeding/gossip — and `addSuspicion`, which also caps
> at 0.5: a hunch is never knowledge-grade). **E20:** `resolveCompetition` is **gone from the player
> channel** (registry descriptor, McpServer dispatch, the `EngineCommands` port method) —
> `runCompetition` is the single outcome authority (B37); the pure domain fn stays; smoke + the 0009
> `.feature` now assert absence + refusal. **E21:** `recordInteraction` requires the **player in the
> witness set** (the player initiating counts; off-screen scenes are the engine's to mint) and folds
> are budgeted **per beat per directed edge** (`MAX_FOLDS_PER_PAIR_PER_BEAT`, window keyed off the
> latest `season:` beat) on top of the B39 per-call cap. Verified by:
> `tests/unit/knowledgeIntegrity.test.ts` (lineage + clamp), `tests/unit/playerChannelGuards.test.ts`
> (E20 absence/refusal both channels; E21 throw/auto-seat/budget/budget-reopen), the amended
> `docs/features/0009-mcp-tool-boundary.feature` scenarios, `tests/integration/httpServer.test.ts`
> (HTTP 400 refusal), and `deploy/smoke.sh` (refusal probed on a live deploy).

## Wave E-SOCIAL — Lane 3: social-sim consequence (E42–E55 · C9 · C12 · T1) · 2026-06-10 — ✅ DONE (PR #216)

> **"Make the simulation matter":** deals, gossip, and the emotional arc stop being flavor.
> **Deals (E42/E43/E46/T1):** `bindingActionsFor` reconciles EVERY binding actor in the live commit
> path (NPC eviction votes from the staged `voteOf`, HOH tie-breaks, the Final-3 eviction); deals are
> horizon-aware (`madeWeek` + `horizonOf`: safety/vote run through their week's eviction —
> `expireWeekScoped` at the rollover — final-two/target-other bind until broken); honoring PAYS
> (`DEAL_IMPACTS.honored` + `BindingAction.alternatives`); the tightest unbound NPC pair occasionally
> seals a Vault-held NPC↔NPC pact at nominations (`DECISION.npcDeal`) that the same ledger
> adjudicates. Live gate: `tests/integration/liveDealReconciliation.test.ts` (T1).
> **Folds (E47/E48/E49):** `CEREMONY_IMPACTS` are named impact objects via `applyImpactDirected`;
> comp-won is `{threat:+0.14}` only; the eviction fold scales by recorded manner
> (`EVICTION_MANNER_SCALE`); the survivors' proven-threat read lands on THIS week's HOH.
> **Arc (E50/E51/E52):** per-role scene emotions (betrayer schemes, victim is betrayed;
> `recordOffscreenScene` evolves both); `survived-vote` fires for the surviving nominee and
> `comp-loss` for contested losers; `evolveEmotion` delegates to the canonical `emotionalModifier`
> with ADR 0001's seeded temperature roll (`swingTemperatureWeight`).
> **Signals (E53/E54):** `variableWeights` wired-or-deleted (initiative → approach variance,
> allianceShift → bond-pick wobble); ADR 0002's `reliability` evidence signal built (fed by honors/
> saves/protective votes, torn down by betrayal, consumed by `bondStrength`, never decays, lossless).
> **Interiority (E55/C12/C9):** structured confessionals (trigger/mood/seeded phrasing) at noms +
> veto ceremony + eviction night, recorded to the SoulStore and the durable `soul.memory` mirror
> (recall survives restart); hidden elements internally consistent (one secret-motive max,
> stat-backed + genuinely concealed aptitudes — property-gated).
> **Gossip (E44):** receipt folds (`GOSSIP_HEARD`, confidence-scaled, never the player's own edges)
> make rumors move third-party reads — proven by the rumor→future-HOH nomination A/B.
> **Left for the merge sequence (Lane 1 owns `orchestrator.ts`):** the ~6-line `defaultApply` wiring
> that passes `edgeOf`/`occupancy` to `richOffscreenStretch` (E45 live), `rel`/`subjects`/`sceneType`
> to `diffuseGossip` (E44 live), and swaps `recordOffscreenSoul` → `recordOffscreenScene` (E50's
> both-souls half) — the exact diff is in PR #216's description. E54's `vetoSave`/`juryLean`
> consumption is a 2-line post-merge follow-up in Lane 4's files.

## Round-5/6 audit parallel phase — Lane 4 (player agency & ladder, engine) · 2026-06-10 — ✅ DONE (PR #217)

> Source: `docs/audits/2026-06-10-full-product-audit.md` (lane plan: E34–E37, E12+T2, E38,
> E39/C7, C1, C6; E51's eviction half coordinated to Lane 3). Every finding shipped with its
> proving test in PR #217; the per-item stamps live on the audit doc's finding lines.

### Lane 4 — E38 · E39/C7 · C6 · C1 · E35 · E36 · E12+T2 · E34 · E37  ·  Claude Code (engine)  ·  ✅ DONE 2026-06-10 (PR #217)

> **DONE.** (E38 / ruling #1) NPC names are seeded samples from vendored real-name corpora
> (`src/engine/data/givenNames.ts` + `surnames.ts`) — raw material only, "no fixed cast": no
> full-name+persona pairing hard-coded (BDD-proven), the legacy Bible's names banned by corpus
> exclusion, identity (never just a first name) carries across no two seeds; the inverse realism
> gate (every part corpus-membered) finally exists. (E39/C7 = D8) `createCharacter` defaults to a
> persisted ENTROPY seed — same name no longer replays the identical season (or its secrets);
> explicit seeds stay for tests/replays. (C6) a missing/typo'd archetype defaults to the MEDIAN
> floater spec, surfaced as `defaulted` on the casting card — never a silent comp-beast grant.
> (C1, execution-confirmed) Houseguest's-Choice candidates snapshot AFTER the full draw and the
> resume re-derives legality — a duplicate veto competitor is impossible (property over seeds ×
> house sizes 5–16). (E35) the veto chip draw is a WITNESSED `veto-draw` beat (field + HC
> holder/pick) preceding any winner, and ANY player in the drawn field — chip-drawn included —
> declares compete/throw/play-safe. (E36) the F4 veto pending carries the honest legal set
> (empty saveable + why); `{use:true}` is refused with the decision standing, never inverted.
> (E12+T2) eviction votes are SECRET BALLOTS: anonymized reveal ("a vote to evict X"),
> engine-only `voteRecord`, attribution unsealed exclusively in the 0048 retrospective
> (`evictionVotes`); T2's vacuous secrecy Thens replaced with electorate-derived bounds + a new
> 0047 scenario. (E34) the player's goodbye is a real `goodbye-message` pending (tone their
> choice, folded via `goodbyeMannerFor` exactly as NPC tones; no engine-authored player goodbye
> beat exists). (E37) the player-juror asks their own scoreless `juror-question` at the finale.
> FE relay for both new kinds wired end-to-end (tool_schemas.py, orwellDecision.js,
> orwell_routes.py, tool_implementations.py, c12 mirror) without touching Lane 6/7 files.
> Gate: 516 unit/property/arch + 318 BDD + 334 FE pytest green. E51's eviction half
> (`survived-vote` inflection) confirmed adapter-side — Lane 3's fold methods, no liveSeason
> change forced.

## Full product audit (2026-06-10, round 5/6) — parallel lanes

### Lane 5 — prompt content (engine, fast)  ·  Claude Code  ·  **audit P1 + P4 + P6 + P9 + P10 + P11 + E58 + E60 + C8 — ✅ DONE (PR #213)**

> Each finding shipped with its proving pin in the same PR (`tests/unit/leverManifest.test.ts`,
> `tests/unit/castingInterview.test.ts`, new `tests/unit/houseEvents.test.ts`, new
> `frontend/tests/test_lane5_prompt_pins.py`): **P1** the FINALITY line (unresolved outcomes are
> reads, never settled results) · **P4** levers are silent production machinery + `ask_user` scoped
> to pending BINDING decisions (engine + FE schema) · **P6** `runCompetition` accurately described
> as a PREVIEW of the loop's already-decided winner (commits only via `advanceGame`) in the base
> manifest, registry, and FE schema · **P9** the casting FIELD manifest drift-pinned against
> `CASTING_COVERAGE` · **P10** `submitDecision`'s bullet de-enumerated + a drift pin parsing the
> `PendingDecisionView` kind union from the port source (no partial subset can return) · **P11**
> the two quoted example lines cut to descriptions (ADR 0003: facts to voice, never scripts to
> recite) · **E58** `src/engine/houseEvents.ts` — `dayOfWeek()` (Day 1 HOH → Day 5 eviction, woven
> into GAME CONTEXT) + `nextHouseEvent()` (seeded 12-line variety pool, store-consulted: no two
> consecutive house events share content), one-line orchestrator integration (sequenced after
> Lane 1) · **E60** the canned "wants a word with you" pretext replaced by the coarse motive enum
> (`bond` | `probe`) the GM voices — 0036 amendment row in `docs/features/README.md` · **C8**
> casting-intake hard caps (`CASTING_LIMITS`) + system-prompt echo neutralization
> (`neutralizeForPrompt`; the prompt-forgery scenario asserted end-to-end). **Deferred:** C8's
> overwrite flag (a `CastingStatusView` contract change — casting-UX follow-up); E58's
> `gameStatus.day` field (one line in Lane 4's view group once lanes merge).

## Audit parallel-phase lanes (round 5/6 + addenda) · 2026-06-10

### Lane 6 — FE framing & turn integrity (Python) + the E89 engine gate  ·  **✅ DONE (PR #214)**

> The agent-tools opt-in gates: **A1** the escalation-reason split (`auto_escalation_withhold` —
> the game escalation subtracts sanctioned opt-ins; the intent escalation keeps the full
> withhold; builtin_browser always withheld; the vacuous isolation test replaced by COMPOSITION
> tests assembling the disabled set exactly as the route does) · **A2** gate 3 (opted-in
> optionals join the schema candidate set at the pinned merge — proven by the non-vacuous
> schema-assembly test: game turn + `game_tools_enabled=["chat_with_model"]` ⇒ the schema array
> handed to the API call contains it) + gate 4 (admin-only UI copy + the app_api 404-by-design
> note) · **P2** the re-entry moment requested on the first game turn of a (re)opened session
> (THE RECORD on a fresh context; the casting session's premiere is NOT a re-entry) · **P3**
> substitution keys on `ctx.framed` (a framed casting turn gets `CASTING_AGENT_PREAMBLE`, never
> the producer-persona-on-generic-rulebook stack) · **P7/E24** incognito inert under the game
> build (route force-off + framing-level belt) · **P8** single datetime + the slim prompt-safety
> line on framed game-build turns · **E16** preset personas never ride the GM stack · **E22**
> the narrated-but-never-recorded guard in CODE (`ensure_turn_recorded`: bounded digest fallback
> + process counter; sanctioned explicitly in the B66 registry) · **E23** no blind retries of
> advanceGame/submitDecision (re-read gameStatus; "may already be resolved") · **E25** the sync
> game-turn 409 fires BEFORE the user message persists (+ discard belt) · **E29** effective_user
> on the orwell routes and the chat path (bearer tokens map to their owner, never "api") ·
> **W2** `/api/chat/events/{id}` owner-verified · **E15** `/api/orwell/moment` admin-gated ·
> **E94** the one-line attachment scene framing (the player is SHOWING something to whoever is
> present) · **E89** the ONE sanctioned engine change: `socialInitiatives` empty until the first
> ceremony beat resolves (`APPROACH_GATE` in `decisionConstants.ts`, pure derived
> `firstCeremonyBeatResolved`, seed-spanning test). Gates: FE pytest 372 green · boot/browser
> smokes green · responsive matrix 37/0/0 · `npm test` green for the engine sliver.

### U5 — game-build trim remainder (Lane 8: W1+W5 · W3 · W4 · W7 · E17)  ·  **✅ DONE (PR #211)**

> The Stream-W half U4 didn't carry. W1 `ui_control` collapses to the curated safe subset under
> the game build — highlight/clear_highlight + set_theme/create_theme — enforced in code at
> `do_ui_control` (mode/model/incognito-toggle/panel/email actions refused, game-framed) with a
> `chatStream.js` data-game-build belt · W5 the ui_control manifest is game-only on BOTH paths
> (the prompt section via a structural builtin-override injection on the settings read path —
> `GAME_UI_CONTROL_SECTION`, never persisted, wins over user overrides — and the native function
> schema via `game_ui_control_schema`: enum = safe subset, email args gone; `highlight` now
> converts with its selector) · W3 the Bitwarden vault vertical joins `GAME_DROP_SET` +
> `mount_optional` (404 server-side under the build, back off-build; boot-smoke proven live both
> ways) · W4 the slash surface is the keep-set only (`GAME_SLASH_KEEP` + a dispatch-time gate
> covering legacy aliases, with a game-framed refusal; /help, fuzzy suggestions, and the
> autocomplete menu all filter through one `isGameSlashAllowed` seam) · W7 `/backgrounds`
> removed outright (its static page was never vendored — the route only 500'd) · E17
> `search_chats` KEEP → OPTIONAL (off by default; opt-in via Settings → Tools; membership lines
> only — the gate logic is Lane 6's). Proving suite `frontend/tests/test_lane7_game_trim.py`
> (25 tests); pytest 357 · boot/browser smokes · responsive matrix all green; the W6 keep-set
> beat-label drift test stays green after the shrink.

### L8 — ops & private-repo (A4/ruling #17+E84 · E80 · E83 · E85 · E8 · E32)  ·  **✅ DONE (PR #218)**

> **A4/ruling #17 (closes E84):** the single-PAT private-repo design — `GIT_TOKEN` lives in
> `data/.env`, a git credential helper supplies it to every fetch/pull, and the host
> update/factory-reset bridges become LOCAL-COPY (execute the already-checked-out in-container
> copy after a pinned-ref `git fetch`; zero raw-curl of branch tips); the installer tolerates a
> checkout missing its origin remote. **E80:** `deploy/smoke.sh` refutes are behavioral (sentinel
> save + the full stat/edge refute list + the credential-helper gate), not textual greps.
> **E83:** the frontend Python deps ride a pip-compile lockfile (Python 3.11/Debian 12 target),
> pinned on every update. **E85:** systemd units harden fully (`CapabilityBoundingSet`,
> `RestrictAddressFamilies`, `SystemCallFilter=@system-service`, `ProtectKernel*`,
> `RestrictSUIDSGID`, `LockPersonality`, `UMask=0077`) and `orwell-frontend.service` carries a
> default `ORWELL_PORT`. **E8:** `FileSaveStore` fsyncs file + dir before rename (power-loss
> durability). **E32:** user-id capped at the HTTP edge (400) + constant-time token compare in
> `HttpMcpServer`. Verified by `tests/unit/opsPrivateRepo.test.ts`, `saveDurability.test.ts`,
> `httpEdgeAuth.test.ts`, and the upgraded smoke refutes.

### L11 — docs & specs (E86(b) · E87 · specs 0051/0053)  ·  **✅ DONE (PR #219)**

> **E86 — the amend path** (the audit's lane split: building the fastembed adapter is its own
> engine lane, E86(a) — still open): ADR 0004 → "Accepted — **adapter not yet built**" with an
> honest Implementation-status section (production composes `DeterministicEmbedding`; no
> `fastembed` in `package.json`; the FE's *Python* fastembed is the vendored RAG stack, not the
> engine's `EmbeddingProvider`) and the concrete path to done (exact lib+model pin, lazy ONNX
> load, deterministic fallback, deploy-time model fetch). CLAUDE.md / README /
> `bb-sim-spec.md` §16 / `CLAUDE_CODE_INSTRUCTIONS.md` §15 / the decisions index stop
> overclaiming — the adapter joins the long-acknowledged deferrals. No fake pin shipped.
> **E87 — the hygiene sweep, all of (a)–(i)** (+ T18's fast-check-is-selective note):
> 0033/0036's unit-gated deviation recorded in their spec headers + README rows; 0029's
> honest pytest header; CLAUDE.md regroups 0035 as BDD-gated and mentions 0029; this queue's
> "Still on the feature-maker" + "Reconciliation still owed" blocks stamped
> HISTORICAL/RESOLVED; the README 0010 row carries its host-validation deferral; the B70
> coverage-floor deviation (90/88/82) recorded; every shipped `.feature` sheds its "# DRAFT"
> header (only 0022 — deferred — and the new specced-not-built files keep one); the
> not-yet-MCP/JSON-RPC caveat parenthesized; `cucumber.cjs` 0048/0049 order/indent cosmetics
> (**no path added or removed**). **Specs (spec only — NOT built, in no gate):** **0051
> in-character images** (Vault-free prompt builder over the visible projection, knowledge-scoped
> depiction, no unresolved-outcome stills, recorded image beats, per-season style anchor,
> budgets, graceful absence — ADR 0003-bound) and **0053 admin transcripts** (ruling #14
> verbatim: admin-gated API + one quiet Settings row, read-only, tool-call nodes first-class,
> DR inclusion disclosed, survives game reset / dies with factory reset; FE pytest lane when
> built — never `cucumber.cjs`; no God-Mode/Vault escalation). Both indexed
> "Specced — not built" in `docs/features/README.md`. Gates: full `npm test` green post-merge
> (612 unit/property/arch · 318 BDD scenarios).

### L9 — calibration (D4/E33 re-measurement · the jury-reach gate · finale calibration)  ·  **✅ DONE (PR #220)**

> Re-measured on the merged spine: 19/20 passive seasons reach jury/endgame (was 0/62 in round 4)
> — emergent NPC self-interest (floaters coast, goats get dragged), **ruled realistic 2026-06-11**;
> the anti-sycophancy teeth move to the FINALE. The jury was crowning the goat (7/10 passive F2
> wins): fixed by `bondKeepWeight` in `voteChoice` (voters protect the nominee THEY are bonded to),
> dropping `−0.5·threat` from `juryLean` (finale threat-aversion structurally rewarded the goat),
> and `JURY_WEIGHTS.gameRespect × gameRespectTerm` over a new persisted public-facts resume tally
> (HOH + veto wins) — a betrayal manner still outweighs the max respect split (bitter juries stay
> real). Passive finale wins 7/10 → 3/10, each EARNED (≥2 broadcast comp wins). The permanent gate:
> `tests/property/juryReach.property.test.ts` (floor ≥3/20 · ceiling ≤19/20 · ≥1 pre-jury loss ·
> wins rare AND comp-earned; seeded-deterministic, roles only).

### L10 — hardening sweep (E18/E77 · E19 · E27/E28/E30/E31 · C4/C5 · E78 · T8/T9/T12/T15–T17)  ·  **✅ DONE (PR #221)**

> **The structural wall hardens:** dep-cruiser goes **default-deny** (E18) and EVERY forbidden
> rule is unit-asserted (E77 — `test:arch` is no longer the only place they run). **The live
> sentinel deepens** (E19): knowledge-bearing reads swept per beat + one full post-finish sweep.
> **The HTTP edge:** two-tier token auth — an admin secret is its own credential, player ⊉ admin
> (E27, unified with #218's constant-time helper); tool LISTING never mints a sandbox (E28); a
> dead-socket answer can't crash the process (E30); malformed args are field-naming 400s, never
> 500s (E31 — the 0009 sentinel sweeps treat the typed refusal as an outcome and sweep ITS text).
> **Integrity math:** any single degradation trips the checkpoint (C4); competition input guards
> (C5); the no-secrets guard scans the whole tree (E78). **Test integrity:** T8/T9/T12/T15–T17
> step-definition hardening + the 0004/0009/0036/0037/0047 feature amendments.
> **Open remainder (not reached — two lane agents died mid-work):** T3–T7, T10, T11, T19, T20.
> *(All cleared — see Lane A, Lane B, and Lane C below.)*

### Lane A — cross-lane tails (E54 · E58 · C8 · E60/E89 · ruling #1)  ·  **✅ DONE (PR #224)**

> The follow-up tails the parallel lanes left on the table, each with its proving test:
> **E54** — the `reliability` evidence signal (built in #216) is now CONSUMED: `chooseVetoSave`
> ranks a veto save by demonstrated loyalty (proven protector outranks an equally-liked stranger),
> and a centered reliability term weighted by `JURY_WEIGHTS.reliability` shifts the juror's lean.
> **E58** — the in-game DAY index (`dayOfWeek(phase)`, hoh=1…eviction=5, null off-ladder) is
> surfaced on `PublicGameStatus.day`. **C8** — casting intake's third sub-item: a later
> `updateCasting` that replaces a captured scalar reports `overwrote: [...]` so the producer
> confirms rather than silently clobbering (caps + echo neutralization unchanged from #213).
> **E60/E89 (FE)** — the approach chip varies its framing by the `bond | probe` motive enum (copy +
> class + tooltip), and a dedicated FE belt (`firstCeremonyResolved`) suppresses every chip before
> the first ceremony resolves — holding even if the engine fails open (browser-smoke proven).
> **Ruling #1 (doc-only)** — the CLAUDE.md "no fixed cast" do-not formulation. Engine `npm test`
> green (664 unit + 318 BDD); FE pytest + browser smoke + responsive matrix green.

### Lane B — T-remainder test repairs (T3–T7 · T10 · T11 · T19 · T20)  ·  **✅ DONE (PR #225)**

> The remaining open Stream-T findings (the L10 remainder). TESTS ONLY. Each strengthened test
> **mutation-verified** (break the production behavior → red → revert).
> **Live re-points:** T5 (narration never changes an outcome) and T6 (narrator cannot advance the
> game) move off pure-function / hand-built-constant fixtures onto LIVE `GameSessionAdapter`
> seasons (live competition + hallucinating narrator; live nomination beat — phase & pending
> unmoved). T7 (agent can't fabricate an outcome) moves onto the B55 live seam WITH a relationship
> model, so recording the engine's result FOLDS a real hidden consequence (the fold the old
> fixture made impossible) — the winner is a real roster member that re-runs identical.
> **Real assertions:** T3 (offscreen recall) returns the specific recorded note; T4
> (CHARACTER-unchanged) asserts a real generated houseguest's static `Character` is byte-stable
> across a season of soul-deepening.
> **T11:** the per-wake cap asserts the TICK COUNT via an `advance` spy (the ×10 event-bound fudge
> is gone); the isolation Thens plant unique per-user sentinels and assert genuine
> content/knowledge cross-absence (record + knowledge + player surface); the vacuous
> `assert.ok(true)` watcher-stop step asserts no-dangling-timer + idempotent stop.
> **T10/T19 [FE/arch]:** already hardened in code by PR #221 — T10's decorative `readsVault` assert
> carries a dep-cruiser pointer + a live-allowlist behavioral assert; T19's FE decision-kind list
> is parsed live from `src/ports/GameSession.ts` (the c13 cross-language manifest parser). Verified
> + stamped.
> **T20 [FE]:** `scripts/browser_smoke.py` gains a real social-HUD minimize-to-dock behavior check;
> `tests/test_orwell_huds.py` source-greps are explicitly re-labeled as SOURCE-PINS
> (`test_sourcepin_*`) pointing at that behavior coverage.
> **Gates:** engine `npm test` GREEN (typecheck → build → 659 unit/UAT → 318 BDD); FE
> `test_orwell_huds.py` green + both touched FE files compile (full FE pytest/browser/matrix gate
> runs in CI). Per-item stamps live on the audit doc's finding lines.

### Lane C — feature 0053 (admin transcripts, ruling #14) · front-end (Python) · **✅ DONE (PR #223)**

> Built the L11-specced 0053 surface. **API** (`frontend/routes/admin_transcript_routes.py`,
> registered in `app.py` after admin-wipe, both behind `require_admin`): `GET /api/admin/transcripts`
> lists sessions across ALL users (id, owner, title, created/updated, message count, game-session
> marker) with `?user=`/`?since=` filters + `?limit=`/`?offset=` pagination; `GET
> /api/admin/transcripts/{id}?format=json|md` exports the full transcript — message roles +
> timestamps AND the agent-thread tool-call nodes (names, args, outputs) verbatim, the debug value.
> **UI:** one admin-only "Transcripts" `admin-card` in the System panel (`static/index.html`) driven
> by `initTranscripts()` (`static/js/admin.js`) — owner filter + per-session JSON/MD download; no
> nav surface; hidden for non-admins by the `.admin-only` rule. **Boundaries:** read-only (no
> POST/PUT/PATCH/DELETE); the copy carries the Diary-Room-inclusion caveat; transcripts live in the
> FE chat store so they survive the game reset and die with the factory reset by construction (no
> script change). **Gate:** `frontend/tests/test_0053_admin_transcripts.py` (12 cases) — green; the
> rest of the FE pytest suite unaffected (425 passing; the 2 reds are pre-existing env-only
> module gaps: `rag_vector`). FE pytest lane only — never `cucumber.cjs`; no engine change.

### Lane D — deploy: privileged UI port (80) + container console password · ops · **✅ DONE**

> Two operator-reported install defects (2026-06-11), fixed at the deploy seam with the audited
> E85 posture intact.
> **Privileged UI port (<1024, e.g. 80):** the hardened `orwell-frontend.service` runs uvicorn as
> the non-root `orwell` user with an EMPTY `CapabilityBoundingSet=` — it structurally cannot bind
> a port below 1024, so `ORWELL_PORT=80` crash-looped into "connection refused".
> `orwell-install.sh` AND `orwell-update.sh` now reconcile a systemd drop-in
> (`orwell-frontend.service.d/10-privileged-port.conf`) granting exactly `CAP_NET_BIND_SERVICE`,
> written only when the configured port is <1024 and removed otherwise — the base unit stays
> byte-stable (the E85 pin holds) and running the updater repairs pre-fix installs (it reads the
> LIVE port from `data/.env`).
> **Console password:** `orwell.sh` created the LXC with no root password, so the Proxmox console
> rejected every login. New optional `CT_ROOT_PASSWORD` (whiptail passwordbox in the advanced
> flow + env for non-interactive; ≥5 chars), applied via `chpasswd` on STDIN — never on a pct
> command line (the GIT_TOKEN no-secrets-in-argv rule) — and the installer's final message now
> states the console-access path either way (`pct enter` always works).
> **Gate:** `tests/unit/opsPrivateRepo.test.ts` gains two suites (drop-in present+gated+removable
> in both scripts; update reads the live env; the base unit keeps `^CapabilityBoundingSet=$`;
> password is stdin-only with no `pct … --password`) — the <1024 gate mutation-verified; full
> `npm test` green (675 unit/property/arch → 318 BDD).

### Lane E — install-script audit & hardening (post-incident) · ops · **✅ DONE**

> A real install died silently between the engine build and service registration: the box
> answered "connection refused", the updater later failed with "Unit … not found", and the
> script's success banner was reachable by simply falling off the end. The audit (F1–F8) and
> refactor of `deploy/orwell-install.sh`:
> **Observability:** ERR trap + per-step tracking (`set -E` so it fires inside functions) names
> the failed step/line/exit and says a plain re-run resumes (idempotent); every run appends to
> `data/install.log`; the success banner is EARNED by `verify_install` — both units active AND
> the engine `/health` + FE `/openapi.json` probes answering (smoke.sh's own contracts), with
> status/journal tails on failure.
> **Bugs:** `git safe.directory` (the orwell-owned checkout vs root-git updates — git ≥2.35
> "dubious ownership" would have killed every update; latent because the 0010 real-host smoke
> never ran) · `chown` covers an out-of-tree `DATA_DIR` · the privileged-port drop-in keys on
> the EFFECTIVE port from `data/.env` (no env-arg drift on re-runs) · root guard + port
> validation up front · re-runs `systemctl restart` (no stale processes after a rebuild) · the
> final message prints the container's real IP, never `http://0.0.0.0`.
> Structured into named phase functions + `main()`; every decision comment
> (A4/E27/E32/E83/E84/E85/B67/B72/ADR-0004) preserved in place.
> **Gate:** `opsPrivateRepo.test.ts` "post-incident hardening" suite (9 tests; the verify-call
> and <1024 gates mutation-verified); `bash -n` clean; typecheck/build/684 unit/318 BDD green.
> *(Noted, not this lane: `npm run test:arch` (the depcruise CLI, outside the `npm test` gate)
> reports 3 pre-existing violations from the E86a wiring — `src/main.ts → engineRoot /
> FastembedEmbedding`; needs its own ruling/queue item.)*

## Lane F — the DWE windowing mission (audit → one window kit) · 2026-06-11

> Source: `docs/audits/2026-06-11-dwe-window-audit.md` (the surface × norm matrix is the
> spec; findings F1–F11 + the duplication census are the work). Bar: ruling #16. Order:
> ruling #15 (UI track outranks non-CRIT) — and within the lane, fresh-install blockers
> first. House rules: FE-only (never `cucumber.cjs`/`npm test`); ADR 0003 — windows AUGMENT
> the chat, no game interaction moves out of it; each wave DELETES its bespoke code in the
> same PR and flips its matrix cells from ❌ to hard gate assertions (browser_smoke /
> responsive_matrix); roles only in tests.

### F-0 — Phase 1: the audit · **✅ DONE (this PR)**

> 75 live Playwright assertions across virgin/casting/mid-game/finale-staged/engine-down ×
> both builds × the viewport matrix; 16 fails → findings F1–F11; #233's no-trap contract
> verified as the norm-(g) baseline and extended (3× cycles, the real J4 card). Matrix doc +
> failure screenshots in `docs/audits/`.

### F-1 — the window kit (`OrwellWindow` + `.ow-*`) · CRIT-first · **✅ DONE**

> Build the kit on the S-stream mechanism and fix the two structural breaks INSIDE it:
> **F1** (the invisible `#minimized-dock` — minimize currently loses the window; visibility
> driven by a class with real-pointer restore, T20 upgraded from evaluate-clicks to trusted
> clicks) and **F2** (slot-restack vs windowDrag fight — drag is dead on every slot panel;
> restack pauses during drag or drag mutates the slot offset). Kit owns: registration
> (modalManager + escMenuStack), drag+explicit clamp, resize, ONE z-authority +
> click-to-front + focused state (F9), minimize-to-dock with the ruling-#19 fly-out + E97
> reduced-motion (F4), one geometry-persistence scheme clamped per user+game (F5 deletes
> `orwell-finale-pos`), focus-return on close (F8), keyboard move (F10), teardown. The A3
> layout kit composes window BODIES. Gate: the kit's own browser-smoke block + the matrix.
> **DONE:** `orwellWindow.js` (the kit: chrome cluster ≥24px named targets · click-to-front +
> `ow-focused` + the 500–980 window band · ruling-#19 fly-out/fly-away with reduced-motion
> strip · slot-offset persistence with explicit clamp · focus-return · arrows/Home keyboard
> move · AbortController teardown · the `OrwellWindowKit` seam) + the `.ow-*` family;
> **F1 fixed** (class-driven `#minimized-dock.ow-has-rows`, the inline-'' reveal gone; dock
> FLIP respects reduced motion); **F2 fixed** (`orwellSlots` stands down while
> `modal-dragging`, reentrancy-guarded; offsets now record real deltas); **F5's persistence
> half folded in** (finale on the slot system, POS_KEY deleted + stale keys cleared,
> `mobileSkip:0` gone — its chrome migrates in its F-2 wave); Escape spliced into ui.js's
> single arbiter (menus → kit windows → modals, F7). Gates: browser_smoke gains the F1/F2
> hard assertions (trusted clicks — the evaluate-click blindness is gone) + a real
> kit-window end-to-end block; `test_f_window_kit.py` source-pins; FE pytest 445 green;
> matrix 37/0/0.

### F-2 — migration waves (each: behavior-identical-or-better, bespoke code deleted) · **✅ COMPLETE (waves 1–3)**

> Wave order: status HUD (stays sidebar chrome — composes title/controls only) → social +
> approaches (F2/F3/F6/F7 cells flip; the narrow tier gets ONE sheet host so two sheets can
> never overlap — F3) → Diary Room (button+pill stay; verify-only) → finale (F5 dual
> persistence deleted) → retrospective + presence + banner (cluster consistency, F6) →
> settings + theme (F8 focus-return; cluster already injected) → remaining modals/popovers
> (W13–W16; styledConfirm/Prompt traps fold into the kit's stack; decision card gains
> non-binding Escape, F11).
> **WAVE 1 DONE:** the SOCIAL panel composes the kit — bespoke chrome/drag/dock wiring
> deleted (`osoc-hdr`/`osoc-min`/`modalManager.register`/`makeWindowDraggable` all gone from
> `orwellSocial.js`); its Escape/focus/fly-out/persistence now come from `OrwellWindow`, and
> the C26 auto-park routes through the kit. **F3 fixed structurally:** the slot engine's
> narrow tier is a SHEET HOST (`restackNarrowSheets` — one stacked column across both top
> slots, measured heights) and the per-panel `top:44px !important` pins are deleted from
> social AND finale; two visible sheets stack, never overlap (browser-smoke-asserted at
> 390×844 via the new `_orwellFinaleEnsure` seam). A kit restore bug caught by the gate
> (display:'' falling through to a consumer's CSS `display:none` — the F1 class one layer up)
> fixed by capture/restore of the pre-minimize inline display. STATUS HUD: verify-only —
> ruling #3 sidebar chrome; all its audit cells were already green; no change.
> T20 pins amended to the kit composition (`test_orwell_huds.py`). Gates: FE pytest 464 ·
> browser smoke (kit + F1/F2/F3 hard assertions) · boot smoke · matrix 37/0/0 — all green.
> **WAVE 2 DONE:** the FINALE composes the kit — bespoke titlebar/minimize/dock/drag wiring
> deleted from `orwellFinale.js` (`ofin-hdr`/`ofin-min`/`modalManager.register`/
> `makeWindowDraggable` gone; `POS_KEY` fully retired); same ambient-HUD capability profile as
> social (minimizable, no close); the F3 sheet host + `_orwellFinaleEnsure` seam from wave 1
> keep gating it at 390×844. **Diary Room: verify-only** — ruling #4 composer mode, not a
> window; its audit cells were all green and the E88 pins stand (`test_orwell_huds.py`,
> `test_ui_elements.py`); no change.
> **WAVE 3 DONE (closes F-2):** the F6 tail — presence/retro/banner dismiss buttons adopt the
> shared `.ow-dismiss` affordance (kit CSS, injected at load; ≥24px, hover/focus-visible) —
> these stay NON-windows per rulings #3-class chrome. **F8 fixed for the WHOLE `.modal`
> family** from ui.js's one visibility observer: opener stashed on hidden→visible, focus
> restored on visible→hidden, never yanked if the user moved it. **F11 fixed**: Escape in the
> decision card = the × path (dismiss only, never submit), via the new
> `data-ow-escape-scope` contract — any in-flow surface can claim focused-context-first
> Escape and the global arbiter stands down. **Arbiter ordering corrected** (caught live by
> the smoke): menus → escape-scoped surfaces → MODALS → kit windows — a visible modal
> outranks every non-modal window, so Escape can no longer park a background panel while
> settings is open. **W13/W14 disposition:** styled dialogs + escMenuStack stay as-is (their
> audit cells were green; the keep-list keeps them; the F-3 ratchet grandfathers their
> census'd signatures). **W15/W16 disposition:** the build=0 tool-modal family gains F8
> focus-return via the shim; full kit adoption there is post-Lane-F (the game build is the
> product). Gates: FE pytest 469 · browser smoke (F8/F11/F6 + the re-ordered Escape ladder) ·
> boot smoke · matrix 37/0/0 — green.
> **F-2 is complete. Only F-3 (the ratchet) remains in Lane F.**

### F-3 — the ratchet · **✅ DONE — LANE F COMPLETE**

> A source-grep + runtime gate: any element matching the window selector must be
> kit-managed — no JS outside the kit registers drag/persist/minimize handlers on a
> window-like surface (the census §4 signatures are the grep corpus); new windows MUST
> compose the kit. Matrix cells that passed stay green; each wave wires its flipped cells
> into `browser_smoke.py` / `responsive_matrix.py` as hard assertions.
> **DONE:** `frontend/tests/test_f3_window_ratchet.py` — the census signatures as the grep
> corpus (drag-engine callers frozen to the kit + {planWindow, settings, theme, workspace};
> slot registration = kit + the two ruling-class strips; dock registration = kit only; no new
> geometry-persistence keys beyond the pinned marker set; no new per-surface Escape handlers
> beyond the surveyed frozen list — shrink-only) + the runtime half in `browser_smoke.py`
> (every floating game panel carries `[data-ow-window]`; the bespoke 'Drag to move' marker is
> extinct outside the kit; the kit seam answers). Audit findings stamped on the doc.
> **Post-Lane-F pointers:** `orwellCast.js` (0051, landed mid-campaign — own Escape handler,
> grandfathered with a pointer) is the first kit-migration candidate; the W15 build=0 family
> migration merges the legacy z counters (F9's tail) when it happens.

## Lane G — playtest response (2026-06-11, live session feedback) · PARALLEL DISPATCH

> Source: live playtest feedback (nine reports, one session). Ruling #15 ordering inside the
> lane: observability/blockers first. **Dispatch: G1/G2/G3/G5/G6/G8 run as PARALLEL agents in
> isolated worktrees, one PR each; agents do NOT edit this file** (the foreman stamps statuses
> at close-out). G4 follows G3+G6 (shared CSS regions); G7 awaits the product verdict.

### G1 — Health & Logs (admin Settings card, UI-based) + image-gen observability · **OPEN**
> Robust health checking and logging, visible in the admin side of Settings, UI-based (user
> commission). The card shows: both tiers' health + agreement (the A12 checklist in the UI);
> embeddings provider + its degrade flag; image-generation provider state
> (configured/absent/failing — answers the 0051 placeholder mystery on-screen); a persistent
> capped failure ring (timestamp · tool · sanitized error class · duration — no payloads,
> Vault-safe); slow-call timings; a "Download debug bundle" button (failures + health snapshot
> + config-sans-secrets). Engine: /health grows a capped recent-failures list + per-call
> timings (generalizing lastError; Vault-free operational metadata only).

### G2 — every launcher restores its minimized window · **OPEN**
> Clicking a window's launcher while it is minimized RESTORES it (user report: the settings
> gear no-ops — `user-bar-settings` is not a registered restore trigger). Fix
> launcher-agnostically in the open path (restore-if-minimized in modalManager), so EVERY
> window behaves identically.

### G3 — sidebar coherence: the .list-item padding standard + no dead affordances · **OPEN**
> THE STANDARD (user ruling): New Chat / Search (.list-item, uniform 8px) are the correct
> buttons — every sidebar button (incl. the 6px user-bar cluster) normalizes to equal padding,
> smoke-asserted (equal computed padding across visible sidebar buttons). Dead affordance:
> under the game build the Tools section is a 10px collapse chevron guarding a lone Theme
> entry — when a section has ≤1 visible child, drop the chevron and render the entry as a
> plain row. Every visible button must visibly act.

### G4 — one visual language across all windows · **OPEN (wave 2 — after G3+G6)**
> Settings/legacy modals vs kit windows look different (user report). Extract shared visual
> tokens (bg, border, radius, shadow, titlebar type) consumed by BOTH families.

### G5 — the refresh-persistence audit · **OPEN**
> User commission ("we need audits for this"): every transient state × refresh, live-driven —
> composer prefill, decision card (re-arms, U4), approaches, banners/toasts, minimized/restored
> window state (currently in-memory only — prime suspect), DR mode, settings tab, panel
> positions. Verdict per cell: survives / re-arms / lost. Audit DOC first (the Phase-1
> pattern); fixes follow as findings.

### G6 — settings keeps its LEFT rail (user preference) · **OPEN**
> The container-620 switch flips the rail to top-tabs when the modal narrows (snapped/narrow
> windows). Retune so the left rail survives far narrower (shrink the fluid rail first; stack
> only as the last resort); matrix-gated.

### G7 — fold The House (approaches) into the sidebar · **AWAITING PRODUCT VERDICT**
> User: the floating House window is redundant with the sidebar's house section.
> Recommendation on the table: approach rows under the game-status sidebar section (the
> rulings #3/#4/#10 drift), retiring the floating window; E89 belt stays; mobile = drawer.

### G8 — casting finalization must not read as an outage · **OPEN**
> User report: slow interview filing → momentary "engine unreachable" error → recovery.
> Mechanism (verify with a timed run): createCharacter's soul-seeding batch blocks the event
> loop through the SYNCHRONOUS embedding bridge; /health times out; the banner fires. Fix:
> chunk the seeding so the loop breathes (engine), and suppress the red banner while
> createCharacter is in flight in favor of an in-fiction holding line (FE).

### Lane G wave 2 (commissioned 2026-06-11: "cover it all including root causes") — G10–G15

> Each item names its ROOT CAUSE and fixes the pattern, not the instance. Dispatch is gated
> on wave-1 file ownership (one owner per file); items launch as their blockers merge.

### G10 — the cast window composes the kit · **QUEUED (after G9 — same file)**
> User: cast window's close dead, no minimize, alien visual language, "basically broken."
> ROOT CAUSE: post-kit drift — 0051 landed mid-campaign with hand-rolled chrome + its own
> Escape handler (ratchet-grandfathered with this exact pointer). Fix: the social/finale
> migration pattern; DELETE the bespoke chrome + private Escape; SHRINK the ratchet
> grandfather list. PLUS tighten the runtime ratchet: any fixed-position element carrying
> close/minimize-shaped controls must be `[data-ow-window]` or the gate fails (closes the
> hand-rolled-chrome-without-censused-signatures hole).

### G11 — the failure ring becomes the standard sink for every user-facing fail-open · **QUEUED (after G1 + G8)**
> ROOT CAUSE: the house `catch (_) {}` fail-open idiom is correct UX but structurally
> silent — every feature failure renders as absence (the image-gen complaint generalized).
> Fix: one tiny FE reporter (surface, errorClass, durationMs → the G1 ring; never throws,
> never blocks) and a sweep wiring it into the user-facing fail-open catches: panel polls,
> in-fiction web search, TTS/voice, mid-turn agent tool failures (quiet OOC note + ring),
> theme particles when A5 lands. The G1 card then shows EVERYTHING that silently failed.

### G12 — every soul-write burst breathes · **QUEUED (after G8 — same seam)**
> ROOT CAUSE: the ADR-0004 embedding bridge is synchronous per call; ANY batched soul write
> pins the engine event loop (creation was just the loudest site). Fix at the seam, not the
> site: move G8's chunk-and-yield INTO the shared soul-write path (SoulStore/seeding helper)
> so eviction nights, finale bursts, season restarts, and future batch sites inherit it;
> /health stays answerable during every burst (the G8 integration test generalized).
> Note the R3 ledger item (O(events) snapshot export) compounds late-season — measure both
> in the same harness; if week-10+ turn latency still breaches, promote R3's
> incremental-snapshot item out of "if play feels it" (the playtest has now felt it).

### G13 — the trim-zombie sweep: gating must cascade · **QUEUED (after wave 1 merges — tree-wide sweep)**
> ROOT CAUSE: the game build hides ITEMS but not their PARENTS/launchers (the Tools chevron
> instance generalized). Fix as a RULE: a container with zero visible actionable children
> hides itself; an affordance whose action is build-refused is hidden, not click-refused.
> Sweep: the shortcuts modal's bindings for dropped verticals, overflow-menu items, empty
> settings tabs for non-admins, rail icons across build transitions. Gate: a browser-smoke
> walk asserting every visible interactive element under the game build produces a visible
> effect (the G3 assertion generalized beyond the sidebar).

### G14 — one z-authority for restored modals · **QUEUED (after G2 — same file)**
> ROOT CAUSE (the F9 tail, now user-adjacent): modalManager's `_bringToFront` stamps
> `z-index ~300s !important` while ui.js promotes opens to ~1000s plain — inline !important
> wins, so a dock-restored tool window likely sits ABOVE every newly opened window until
> clicked (build=0; verify live first). Fix: `_bringToFront` defers to the ONE counter
> (ui.js's promote, or a shared module both consume) — no !important. Pull this F9 tail
> forward instead of waiting for the full W15 migration.

### G15 — event-driven freshness: `orwell:gamechanged` dispatch sweep · **QUEUED (wave 2)**
> ROOT CAUSE: sidebar/panel surfaces are poll-based (20–25s) and the `gamechanged` event is
> dispatched inconsistently, so post-action UI lags up to a poll period ("the sidebar is
> behind"). Fix: every FE path that mutates engine state (advanceGame, submitDecision,
> recordInteraction, createCharacter, new-game, casting updates) dispatches
> `orwell:gamechanged` on success — one helper at the tool-executor seam, not per-call-site
> copies; panels already listen.

> **Also recorded:** G5's audit findings will spawn G16+ fix items on landing; G4 (one
> visual language) additionally covers the cast window's px/rem discipline and the three
> chip languages (approach/decision/dock) under the shared tokens.
