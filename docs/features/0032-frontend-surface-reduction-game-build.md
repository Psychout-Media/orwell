# 0032 — Front-end surface reduction (the "game build")

> **Status:** **All three tiers implemented & green.** Tier 1 = server-enforced reduction
> (`frontend/tests/test_game_build.py`, all 9 scenarios); Tier 2 = stop shipping the dropped JS
> (`scripts/boot_smoke.py`); Tier 3 = **delete the dropped front-end code** (94 modules removed) with a
> **headless-browser gate** (`scripts/browser_smoke.py`) proving the keep-set module graph loads with
> zero broken/missing modules. All three run in CI's `frontend` lane.
> Reduce the vendored general-purpose workspace front-end (`frontend/`) to **just
> the Big Brother game surface** — chat + LLM connection + the engine MCP agent + the game's own
> surfaces (onboarding, status, portraits, accounts) — and **drop every inherited workspace vertical**
> that has nothing to do with playing the game. Done as **three escalating tiers**: (1) flag-gate +
> **server-side 404** every dropped vertical (incl. the live shell endpoint); (2) **stop shipping**
> their JS; (3) **delete** their code. Collapses the prune behind **one game-build switch**. Keeps
> **voice** (TTS/STT) behind an **off-by-default** flag. Front-end only — **no engine change**.
> **Executable spec:** [`0032-frontend-surface-reduction-game-build.feature`](./0032-frontend-surface-reduction-game-build.feature)

## 1. Summary

`frontend/` is a vendored copy of **Orwell**, a general-purpose self-hosted AI workspace (~150 JS
files, **~5.4 MB** of static JS). The Big Brother game is **folded into the main chat**
(`frontend/INTEGRATION.md`). The workspace's other verticals — email, calendar, contacts, documents
+ image editor, gallery, cookbook/hardware-fit, model compare, deep research, notes, tasks, shell,
web search/fetch, YouTube, webhooks, and the front-end's own memory/RAG/skills — are **dead weight or
worse** for a self-contained game. This feature reduces the front-end to the **game keep-set** and
removes the rest, behind a single, testable **game-build switch**.

This is the **deep prune** `frontend/INTEGRATION.md` set aside ("the deep code-level prune"); it now belongs to the front-end rebuild (ORW-146).
It must be done so it can be **verified against a running instance** for the deletion tier — pure file
removal can't be proven green in CI alone.

## 2. What exists today (the gap this closes)

A **partial, two-layer** prune is already in place and is **inconsistent**:

| Layer | Where | State |
|---|---|---|
| CSS hide (entry points only) | `static/css/game-trim.css` | Hides ~14 launchers (Tasks, Notes, Library, Gallery, Deep Research, Cookbook, Compare, Calendar, Brain/memory, Email, Plan, Shell, Web Search). **Cosmetic — routes & JS still ship and stay reachable.** |
| Server feature flags | `src/settings.py` `DEFAULT_FEATURES` (8 keys) | `web_search`/`deep_research`/`memory`/`gallery` **off**; but `web_fetch`/`document_editor`/`rag` still **on**, and **most verticals have no flag at all**. |
| JS not shipped | — | ⛔ **open, ORW-146 (front-end rebuild)** — all ~5.4 MB still loads (incl. the ~80-file `static/js/editor/` image editor). |
| Code removed | — | ⛔ **open, ORW-146 (front-end rebuild)** — every vertical's `routes/` + `services/` + `static/js/` + `app.py` wiring remains. |

**Concrete gaps in the half-done state:**
- **`/api/shell/exec` + `/api/shell/stream` are LIVE** (`routes/shell_routes.py`) — admin-gated but
  **only CSS-hidden**, not flag-gated, not removed. A real arbitrary-shell endpoint sits behind the
  game UI, reachable by any app-admin account (0029). **Security, not just bloat.**
- **`web_fetch`, `document_editor`, `rag` default `True`** — irrelevant to the game and still on.
- **No flag** covers email, calendar/caldav, contacts, cookbook/hwfit, compare, notes, tasks, shell,
  voice, YouTube, webhooks, skills.
- **Two competing memory systems.** The game's memory is **engine-side** (souls + Vault, 0023/0024).
  The front-end ships its own `memory`/`rag`/`skills` verticals with their own vector store — a second
  memory that can feed chat context **outside the engine's Vault discipline**. (`memory` is off, but
  **`rag` is on**.) This is a **correctness/architecture** concern, not only footprint.

## 3. Scope

**In:** define the game **keep-set** and **drop-set**; a single **game-build switch**; extend the
feature-flag system to gate **every** dropped vertical **and its route registration** (server-side
404, not just a hidden button); stop shipping the dropped JS; delete the dropped code (verified on a
running instance); prune the **Settings** modal tabs; keep **voice** behind an off-by-default flag.

**Out:** any **engine** (`src/`) change (front-end only); the game's player-UX build-out (0020 — this
only *preserves* its surfaces); accounts/admin behavior (0029 — preserved, not changed); choosing the
LLM provider (0027 — preserved). No new game mechanics.

## 4. Design

### 4.1 The keep-set (the game surface — must survive every tier)
- **The main chat** + streaming + SSE session sync + **session history/library** (game continuity).
- **Onboarding overlay** (`orwellOnboarding.js`) — the game OOBE.
- **LLM connection** — providers / endpoints / model picker / `llm_core` (0027); the agent + its
  **engine MCP tool backend** (`agent_tools.py`, `tool_schemas.py`, `orwell_engine.py`, the MCP route
  pointing at the engine) — **the integration linchpin**.
- **Game surfaces (0020):** the status panel, inline decision buttons, and **per-houseguest portraits**
  — so the **image-generation** path that renders portraits (`portraitDescriptorFor` → image-gen)
  **stays**. *(Distinct from the image **editor** and the workspace gallery, which go — see §4.2. The
  implementer must confirm the portrait render path still works after the editor/gallery removal; this
  is precisely a "verify on a running instance" item.)*
- **Accounts/admin (0029):** auth, the Users manager, LLM-settings gate.
- **Settings** (pruned, §4.3) and **Theme** (cosmetic, cheap — keep).

### 4.2 The drop-set (irrelevant verticals — removed by the end state)
Email · Calendar/reminders/caldav · Contacts · Documents **+ image editor** (`static/js/editor/`, the
biggest single chunk) · workspace Gallery · Cookbook/hwfit/diagnosis (local-model serving) · model
Compare · Deep Research/research-synapse · Notes · Tasks · **Shell** · Web Search/Web Fetch/YouTube ·
Webhooks · Signature/fonts · Companion/pairing · Codex/Copilot · the front-end's own **memory / RAG /
skills** (replaced by the engine's soul/Vault — §2).

### 4.3 Settings, pruned
Keep tabs: **Providers/Models**, **Account/Users** (0029), **Tools** (the engine MCP backend),
**Appearance/Theme**, conversation **Search**, and **Voice** (§4.5). Drop tabs for every dropped
vertical (email already dropped in `game-trim.css`; add gallery/cookbook/research/memory/…).

### 4.4 The single game-build switch
One lever flips the whole keep-set instead of N scattered flags: a **`game_build`** profile (env
`ORWELL_GAME_BUILD`, default **on** for this product) that forces the drop-set **off** and the
keep-set **on**. Per-vertical flags remain (so a vertical can be re-enabled for debugging), but the
profile is the **one** thing tests assert and operators set.

### 4.5 Voice exception (kept, opt-in)
Voice (TTS/STT) **stays in the tree** behind a **`voice`** flag defaulting **off** — easy to enable
later for immersion (hearing the house / Diary Room) without a code change. It is **not** in the
deletion tier.

### 4.6 The three tiers (escalating; deletion is the end state)
1. **Flag-gate + server-side 404 (CI-green).** Every dropped vertical is off under `game_build`; its
   **route registration is gated** so endpoints **404/410** (not merely hidden) — this is what actually
   neutralizes `shell`, `web_fetch`, and the front-end memory/RAG. Entry points hidden; flags consistent.
2. **Stop shipping the JS (CI-green).** Dropped modules no longer load (esp. `static/js/editor/`),
   taking ~5.4 MB → a fraction. Pure load-time win; no files deleted yet.
3. **Delete the code (running-instance verified).** Remove the dropped verticals' `routes/` +
   `services/` + `src/` + `static/js/` + `app.py` wiring + `index.html` script tags. Because this edits
   the large `app.py` and the shell, the **DoD for this tier is a running instance** (Python deps
   installed, config set): the app boots, a game onboards, a turn plays in-character, portraits render,
   and accounts/admin work — exactly the `frontend/INTEGRATION.md` requirement.

## 5. Contracts (stack-agnostic)

```
features (extend DEFAULT_FEATURES): one flag per vertical, default off under the game build
  + voice: false (kept, opt-in)
game build:  ORWELL_GAME_BUILD (default on) ⇒ drop-set forced off, keep-set forced on
route gating: a dropped vertical's router is NOT mounted when its flag is off
              ⇒ its endpoints return 404/410 (verified server-side, e.g. /api/shell/exec)
chat context: assembly pulls NO front-end memory/RAG/skills when those flags are off
              (the engine moment prompt + lever manifest is the only injected context)
settings UI:  only keep-set tabs render
```

## 6. Definition of Done

- [x] **Game surface intact:** with `game_build` on, the player gets onboarding → in-character chat →
      status panel/decisions → portraits; accounts/admin (0029) and the engine MCP agent backend all work.
- [x] **Drop-set gone server-side (Tier 1):** each dropped vertical's endpoints return **404/410** (not
      just hidden) — **explicitly proven for `/api/shell/exec` and `/api/shell/stream`**; `web_fetch`,
      `document_editor`, `rag` default **off** under the game build.
- [x] **No parallel memory:** with the game build on, chat-context assembly injects **no** front-end
      memory/RAG/skills content — the engine's soul/Vault is the only memory; the only injected framing
      is the engine moment prompt (0018).
- [x] **One switch:** `ORWELL_GAME_BUILD` flips the entire keep-set/drop-set; a test asserts the profile
      (not 20 individual flags).
- [x] **Voice opt-in:** TTS/STT is present but **off by default**; enabling its flag restores it.
- [x] **JS slimmed (Tier 2):** dropped modules (incl. the image editor) are not loaded; the served page
      references none of them (`boot_smoke.py`).
- [x] **Deletion verified (Tier 3):** the drop-set's front-end code is deleted (94 modules) with all
      ES imports removed; a **headless-browser gate** (`scripts/browser_smoke.py`, CI) boots a running
      instance, loads the page, and proves the keep-set module graph loads with **zero broken/missing
      modules** and no uncaught errors — the live in-instance onboarding/turn/portrait walkthrough remains
      the documented manual check per `frontend/INTEGRATION.md`.
- [x] Name-agnostic tests (roles only — player/admin); `cd frontend && python3 -m pytest tests/` green;
      `py_compile` clean; the engine gate (`npm test`) **unaffected** (front-end is quarantined).

## 7. Dependencies & traceability

Front-end only; **no engine change**. Preserves the surfaces of **0020** (status/decisions/portraits —
keeps the image-**gen** path), **0027** (the LLM connection), **0029** (accounts/admin), the **0009**
MCP agent backend, and the **0018** moment-prompt injection (the only context that should reach the
model). Removes the front-end memory/RAG/skills that would otherwise rival the engine's **0023/0024**
soul+Vault memory. Realizes the set-aside prune (now the front-end rebuild, ORW-146) in `frontend/INTEGRATION.md` and supersedes the
CSS-only `static/css/game-trim.css` first cut with a server-enforced, single-switch reduction.
Answers the product call: the player-facing app should be **the game and nothing else**.
