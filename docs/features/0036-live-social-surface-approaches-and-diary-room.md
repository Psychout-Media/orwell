# 0036 — Live social surface: NPC-initiated approaches + the Diary Room

> **Status:** Built (see the [README status index](./README.md#index)) — was a **functional gap**. Two built social capabilities were **not reachable in the live
> game** because no player tool exposed them: (1) **NPC-initiated approaches** — `npcInitiatedApproaches()`
> (0012) exists but is never called live, so conversations are **one-directional** (player→NPC only),
> violating the **bidirectional-scenes** mandate; and (2) the **Diary Room** — 0013's logic
> (`recordDiaryRoom`, `NO_NPC_PATHWAY`) exists but is **not a player tool**, so the player can't use their
> core OOC channel. This feature exposes both as Vault-free live tools.
> **Executable spec:** [`0036-live-social-surface-approaches-and-diary-room.feature`](./0036-live-social-surface-approaches-and-diary-room.feature)

## 1. Summary

The audit found the live social surface is half-built: the player can `recordInteraction` (player→NPC,
witnessed, folded into relationships — 0023), but:
- **NPCs never approach the player.** `src/engine/conversation.ts` `npcInitiatedApproaches()` is pure and
  tested but **never invoked on the live path** and **not in the tool registry** — so the engine can't
  tell the agent "houseguest X wants to talk to you." The mandate is explicit: *NPCs hold goals that make
  them approach the player, **and** the player can initiate — neither side initiates everything.*
- **The Diary Room is inaccessible.** `KnowledgeService.recordDiaryRoom()` + the `NO_NPC_PATHWAY` wall
  (0013) are built and correct, but **no `PLAYER_TOOLS` entry** exposes them — the player has no DR in the
  live game.

Both are **tool-exposure + live-wiring** gaps, not missing logic.

## 2. Scope

**In:** two Vault-free player-channel tools, wired into `GameSessionAdapter`/`EngineCommands`, added to
`PLAYER_TOOLS` + the McpServer allowlist + the lever manifest (ties **B21**):
1. **`socialInitiatives()`** (NPC approaches) — returns the houseguests who, by their soul motivation,
   want to approach the player **now**, with a Vault-free COARSE motive category (`bond` | `probe` —
   amended by audit E60, 2026-06-10: the fact the GM voices in its own words, never an engine-authored
   pretext line), **no hidden numbers**. Sourced from `npcInitiatedApproaches()`; bidirectional with `recordInteraction`.
2. **`diaryRoom(entry)`** — records a player Diary-Room entry as **OOC player knowledge** tagged
   `NO_NPC_PATHWAY` (via `recordDiaryRoom`). It **never** reaches any NPC (`deriveNpcKnowledge` already
   excludes it); it **may** inform the engine's read of player strategy, **never** NPC behavior. Optionally
   surface the **producer-prompted** DR (`producerPrompt`) at dramatic beats.

**Out:** the conversation/DR **logic** (built — 0012/0013; reused); scene navigation / in-house locations
(separate, lower priority); off-screen life (0035); NPC **confessionals** (Vault-only, must stay hidden).

## 3. Design & boundary

- **`socialInitiatives`** reads the live relationship/soul state (the same model 0023 folds into) to rank
  who approaches and surfaces a **public-facing** reason only — never trust/threat numbers or hidden
  motives. `readsVault: false`; **sentinel-clean** (extend the 0001 canary). The agent uses it to open a
  scene "houseguest X pulls you aside"; the player may still initiate via `recordInteraction`.
- **`diaryRoom`** writes through `recordDiaryRoom` (pathway = diary-room, `NO_NPC_PATHWAY`). **The wall is
  the crux:** assert on the **live tool** that **no NPC ever learns DR content** (extend 0013's exclusion
  test to the live path) and that the **public/private gap** holds (NPCs act on public speech, never the
  DR). Player confessionals are player knowledge; **NPC** confessionals remain **Vault-only** and never
  surface here.
- Both tools are added to the **base prompt's lever manifest** (B21) so the agent knows to pull them.

## 4. Contracts (stack-agnostic)

```
socialInitiatives(): { houseguest: name, motive: "bond" | "probe" }[]   // readsVault:false, sentinel-clean (E60)
    source = npcInitiatedApproaches(live relationship/soul state); public framing only, no numbers
diaryRoom(entry: string): { recorded: true }                   // readsVault:false, sentinel-clean
    = knowledge.recordDiaryRoom(player, entry, NO_NPC_PATHWAY)  // OOC; never reaches any NPC
```

## 5. Definition of Done

- [ ] **Bidirectional scenes:** in the live game, `socialInitiatives` returns NPCs who want to approach the
      player (driven by their soul motivation), with a Vault-free coarse motive — so scenes start from **either**
      side, not only player→NPC.
- [ ] **Diary Room usable + walled:** the player can record a DR entry on the live path; a test proves
      **no NPC** ever learns DR content (`deriveNpcKnowledge` excludes it) and NPCs act only on **public**
      speech — extend 0013's wall test to the **live tool**.
- [ ] **Vault-free:** both tools are `readsVault: false` and **sentinel-clean** under a populated Vault
      (extend the 0001 canary); `npm run test:arch` green.
- [ ] **Manifest:** both appear in the base prompt's lever manifest (coordinated with **B21**).
- [ ] Name-agnostic tests (roles only — player/NPC); `npm test` green. *(The small front-end piece
      surfaces "X wants to talk" and a DR entry point — queued separately; the agent can drive both via the
      tools without UI.)*

## 6. Dependencies & traceability

Exposes **0012** (`npcInitiatedApproaches` — bidirectional scenes) and **0013** (`recordDiaryRoom`,
`NO_NPC_PATHWAY`) into the live game, reading the live relationship state (**0023**), under **0002**
(knowledge pathways), **0001** (Vault Wall), and **0021** (isolation). Pairs with **B21** (the manifest
must name the new levers). Front-end consumption (approach prompts + a DR affordance) is a small
piece on the **0032** game build, since built.

## 7. Front-end UI (C10) — surfacing it to the player

The engine tools and the front-end **API are already wired** (the bullets below name the live routes).
What remains is the player-facing UI in the vendored front-end (`frontend/`, the **0032 game build**),
consuming **only** the Vault-free route payloads. Two surfaces:

### 7.1 NPC approach prompts ("X pulls you aside…")
- **Source:** `GET /api/orwell/initiatives` → `{ "initiatives": [{ "houseguest": { "id", "name" }, "motive" }] }` (E60)
  (already routed → `orwell_engine.social_initiatives` → the `socialInitiatives` tool).
- **UX:** when a game is in progress, surface the approachers **unobtrusively** in the main chat — e.g. a
  small dismissible chip/affordance near the composer ("**{name}** + short copy mapped from the motive).
  Acting on it **starts a
  scene** the normal way (the player engages that houseguest; the existing chat turn / `recordInteraction`
  path records it). Approaches are **suggestions**, never forced — the player can ignore them.
- **Refresh** on the same cadence as the status panel (the SSE/session-sync tick / after each advance),
  so the list tracks the live game. Show **names + the coarse motive's UI copy only** — never any
  relationship number (the engine already withholds the hidden drive).

### 7.2 The Diary Room entry point
- **Source:** `POST /api/orwell/diary-room` `{ "entry": "…" }` → `{ "recorded": true }` (already routed →
  `orwell_engine.diary_room` → `diaryRoom`).
- **UX:** a clearly-labelled **Diary Room** affordance (e.g. a button by the composer or in the game/status
  panel) that opens a small panel/modal where the player writes a private confessional and submits it.
  On success, a brief confirmation. The UI must make the **OOC / private** nature explicit ("the house
  never hears this") so the player understands it mirrors the engine guarantee — DR content **never**
  reaches any houseguest.

### 7.3 Constraints (carry the engine's guarantees into the UI)
- **Vault-free by construction:** render **only** the route payloads; never infer or display hidden state.
- **Fail-open:** if `/initiatives` errors or is empty, show **nothing** (no approach chip) — never block the
  chat; if `/diary-room` fails, a graceful inline error, never a crash. (The routes already fail-open
  server-side.)
- **Game-build keep-set (0032):** these are game surfaces — gated to when a game is in progress, and they
  must survive the front-end prune (don't reintroduce a dropped vertical).

### 7.4 Definition of Done (C10)
- [ ] Approachers from `/api/orwell/initiatives` appear in the live game UI (names + motive copy only) and can
      be acted on or dismissed; nothing shows pre-game or on error.
- [ ] A Diary-Room entry point posts to `/api/orwell/diary-room`, confirms success, and is labelled clearly
      as private/OOC.
- [ ] Vault-free + fail-open (no hidden state rendered; the chat never blocks on either surface).
- [ ] `cd frontend && python3 -m pytest tests/` green (name-agnostic — roles only); the **0032
      headless-browser gate** (`scripts/browser_smoke.py`) still loads the keep-set with no broken modules;
      the engine gate is unaffected (front-end is quarantined). Verified against a **running instance**
      (per `frontend/INTEGRATION.md`).
