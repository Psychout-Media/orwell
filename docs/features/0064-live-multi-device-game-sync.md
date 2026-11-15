# 0064 — Live multi-device game sync (the canonical game chat)

**Status:** ✅ Built (authored 2026-06-20; parts A, B/D and C shipped; part F shipped as cross-device layout sync and was then **superseded by ADR [0017](../decisions/0017-multiplexed-websocket-session-transport.md)** (owner call 2026-07-09: window/HUD geometry is remembered **per device**, not synced cross-device); see *Shipped so far* below and the README index). **Gate:** FE (pytest) + browser smoke.
**Depends on:** 0021 (per-user sandboxes / one game per user), 0032 (the game build), 0050
(casting interview), 0054 (gadget rail HUD). **Supersedes** the per-tab/per-device onboarding
guards described in *Implementer handoff → What this replaces*.

> **Companion:** `0064-live-multi-device-game-sync.feature` (role-only Gherkin). This is an
> **FE feature** (the chat sessions live in the front-end's store and streaming happens in the
> front-end), so the executable gate is **front-end pytest** + the browser smoke, **not** Cucumber
> — it is not added to `cucumber.cjs`.

## Decisions locked (2026-06-20, product owner)

These resolve §7's open questions and steer the build:

1. **Model = Messenger, not a driver lock.** The game chat behaves like a Facebook-Messenger-style
   thread: **any device may type at any time**, there is **one shared persistent thread**, and it
   **stays in sync across every device**. There is **no read-only spectator lockout, no disabled
   composer, and no explicit "take over" button/action.** Concurrency is handled by **serializing**
   turns into the one thread (never two parallel reasoning chains, never a stomped run) — see the
   revised §3.C.
2. **Instant cross-device updates.** Ship the `game-updated` SSE ping (the HUD reconciles
   immediately, not on the ~2s poll).
3. **Build order:** **stopgap first** (§7 *Build order*), then the full Messenger-sync build.

### Shipped so far (2026-06-20)

- **A — canonical game session** (#399, merged): every device converges on one chat; existing
  cross-device sync engages.
- **F — window/HUD layout sync** (this PR; **policy superseded by ADR 0017** — layout is now per-device, not cross-device; the store/route/SSE plumbing below remains, scoped by device id): open/minimized/docked + size + position originally synced across
  devices (`orwell_layout.py` store + `GET/PATCH /api/orwell/layout` + a `layout-changed` SSE event
  + kit capture/apply in `orwellWindow.js` + `orwellLayoutSync.js`).
- **B/D — `game-updated` instant HUD reconcile, the cast-photo onboarding fix, and the once-only
  kickoff** (this PR): salvaged from the parallel build (PR #400) in the **Messenger** model — i.e.
  **without** that build's turn-lock / spectator / take-over (owner ruling). `game-updated` fires on
  `/decision` + `/self-eviction/*`; the cast-photo gate pins centered and closes across devices.
- **C — Messenger serialization (queue-don't-stomp)** (this PR): a game-framed turn now **queues**
  behind any in-flight run for the canonical session instead of cancelling it
  (`agent_runs.start(..., queue=True)` — the chat route opts in via `ctx.framed`). Two devices on
  the one game chat serialize: one reasoning chain at a time, the live turn is never stomped. Plain
  chats keep cancel-on-double-send. *(Known minor: a queued turn uses its submit-time context, so in
  the rare exactly-simultaneous case the second reply may not yet reflect the first — non-destructive;
  the engine state is authoritative and reconciles via `game-updated`/the desync spine.)*

---

## 1. Why (the bug this closes)

The engine already enforces **one active game per user** (0021). The front-end does **not**: it is
a multi-session chat app (ChatGPT-style), and every device independently picks or *creates its own*
chat session. Nothing binds the single per-user game to a single chat session.

Observed in the field (two devices, same account, same instant): **two producers, two thinking
traces, two divergent casting interviews** — two independent LLM reasoning chains, both writing
`updateCasting` into the one shared engine intake. The engine serializes per user
(`HttpMcpServer` enqueue, audit E10), so state is not *corrupted*, but the experience is broken and
casting answers from one screen clobber the other.

**Root cause:** the cross-device live-sync stack *already exists and works* —
`src/agent_runs.py` (detached runs + replay buffer), `src/session_events.py` (per-session SSE
pub/sub), the routes `GET /api/chat/events/{id}` · `/resume/{id}` · `/stop/{id}`, and the client
`static/js/sessionSync.js`. But `session_events` is keyed by **`session_id`**, and the two devices
are on **different** session ids, so the sync never engages.

This feature makes the game **one canonical chat session per user** that every device converges on,
then leans on the existing sync so all screens render the **same conversation live** — and adds
**one-driver-at-a-time** turn ownership so "two reasoning chains" becomes structurally impossible.

---

## 2. Scope

**In scope (FE only):**

- **A. Canonical game session** — a server-authoritative, per-user mapping `user → game_session_id`;
  every device resolves and opens *that* session for the game.
- **B. Engage the existing live-sync** for the canonical session (verify + harden late-join,
  hidden-kickoff reconciliation, HUD reconciliation).
- **C. Turn serialization** — *(original design was a per-user turn lock with live spectators and a guarded take-over; superseded by the locked **Messenger** decision above.)* As shipped: a game-framed turn **queues** behind any in-flight run for the canonical session (`agent_runs.start(..., queue=True)`); no lock, no spectator mode, no take-over.
- **D. Once-only casting kickoff** — the producers' opener fires once per game, not once per device.
- **E. Robustness** — late join (replay + live), reconnect, FE-restart catch-up, multi-tab,
  cross-user isolation, Vault-free throughout.
- **F. Window & HUD layout sync** — *(SUPERSEDED 2026-07-09 by ADR 0017: layout is remembered per device, not synced across devices; this section is the original cross-device design, kept as the record. Noted 2026-11-12, ORW-286 item 8.)* the gadget-rail and every OrwellWindow kit window's
  **open / minimized / docked** state, **size (w,h)**, and **position (x,y)**. *(Originally specified to sync across the user's devices; **superseded by ADR 0017** — geometry is now remembered per device and only the same device's tabs mirror each other.)*

**Out of scope / non-goals:**

- Any change to engine authority, the Vault Wall, or per-user isolation (0021) — unchanged.
- Persisting in-flight runs across an FE process restart (`agent_runs`/`session_events` stay
  in-memory; devices catch up from persisted history — see §6.E).
- Real-time co-editing of the composer draft, or presence cursors.
- Sharing a game across *different* users (forbidden by 0021; this is multi-**device**, one user).

---

## 3. Design

### A. The canonical game session

The chat sessions are FE-owned, so the binding lives in the FE — mirroring the per-user
`orwell_seasons.py` store (a small JSON map in `DATA_DIR`, atomically written, keyed by
`_current_user`, Vault-free by construction: a session **id** carries no game secret).

**New store — `frontend/src/orwell_game_session.py`** (pattern: `orwell_seasons.py`):

```
get_game_session(user) -> str | None        # the user's bound game session id, or None
set_game_session(user, session_id) -> None   # bind (atomic; lock-guarded)
clear_game_session(user) -> None             # unbind (season reset / new season)
```

`DATA_DIR/orwell_game_session.json` = `{username: session_id}`. The factory-reset scrub of
`data/` already takes it back to OOBE; the in-app reset-progress / new-season rotates it explicitly
(below).

**Routes (in `routes/orwell_routes.py`), `_current_user`-scoped — _as shipped (stopgap)_:**

- `GET /api/orwell/game-session` → `{ "sessionId": <bound id | null> }` (read-only; null ⇒ nothing
  bound yet).
- `POST /api/orwell/game-session { sessionId }` → bind **first-writer-wins**; returns
  `{ "sessionId": <effective>, "bound": <bool> }`. A racing second caller **adopts** the
  already-bound id (`bound:false`).

**Binding happens server-side on first frame (no fragile client mint-then-bind).** Rather than have
`GET` mint a chat (server-side session minting needs endpoint/model resolution) or the client bind
after an async create (the new session has no id until its first message), the binding is performed
inside **`apply_game_framing`** (`routes/chat_helpers.py`): the **first** session that drives a
game/casting turn for a user is bound as canonical (`_bind_canonical_game_session`, first-writer-
wins, best-effort). So the device that opens the interview owns the binding the moment its first
turn frames; every other device's `GET` then resolves it. The `POST` route remains for explicit
binding/tests.

**Season-reset rotation.** The three reset doors already exist in `orwell_routes.py`
(`/new-game`, `/next-season`, `/reset-progress`). Each must `clear_game_session(user)` as part of
the reset so the next `GET /api/orwell/game-session` mints a clean session for the new season —
a dead season's transcript never rides as narrator context. This makes the existing F7/E65
"fresh session on restart" behavior **server-authoritative** instead of per-tab `sessionStorage`.

**Onboarding change — `static/js/orwellOnboarding.js`.** `openFreshInterviewSession()` no longer
blindly clicks "+ New chat" (which mints a *device-local* session). Instead it (fail-open at every
step):

1. `GET /api/orwell/game-session` → `sessionId`.
2. If a `sessionId` is bound **and it exists in this device's session list**,
   `sessionModule.selectSession(sessionId)` (open it) and stop — never a second chat.
3. Otherwise open a fresh chat as before; the server binds **that** session on its first framed turn
   (above), so the next device resolves and converges onto it.

Every device — first load, second device, a reload — lands on the **same** session id. The
per-device `SEAT_TAKEN_KEY` (`sessionStorage`) and `WELCOME_KEY` (`localStorage`) guards become
**advisory UI niceties only**; the server store is the source of truth for "which session is the
game."

### B. Engage the existing live-sync

Once every device shares the session id, `sessionSync.js` + `session_events` already deliver the
live experience: device A's `run-started` / `message-added` events reach device B, which
soft-reloads history and attaches to the live reply (`chatModule.resumeStream`). Harden three game
edges:

1. **Late join (open mid-run).** A device opening the canonical session while a run is in flight
   must **proactively** attach (replay buffer + go live) rather than wait for the next event.
   `sessions.js` already does an on-open resume check (~`selectSession`); verify it fires for the
   game session and that `agent_runs.subscribe` replays the buffer from seq 0 (it does — see
   `agent_runs.subscribe`).
2. **Hidden kickoff reconciliation.** The casting opener is auto-sent with the user bubble hidden
   (`_orwellOpenGameAfterCasting`, the `OPEN_GAME_LINE` production cue). When device B soft-reloads
   history it must **not** render that raw cue as a player line. The persisted kickoff message is
   already phase-marked (`mark_message_phase`) / hidden-bubble; verify the reload path honors the
   hidden flag so B sees the producers' message first, exactly like A.
3. **HUD reconciliation.** The decision card, status panel, roster, finale, and gadget rail already
   poll `/api/orwell/*` and read the engine's **authoritative** `pending` (the engine is the source
   of truth; ADR 0003). So a binding decision on A clears on B within one poll. Add a
   `session_events.publish(game_session, "game-updated")` after `/api/orwell/decision`,
   `/self-eviction/*`, and a committed `advanceGame` so B reconciles **instantly** instead of
   waiting up to ~2s (optional nicety; polling remains the correctness floor).

### C. Concurrency — Messenger-style serialization (no lock, no take-over)

**Decision (locked):** the game chat behaves like a **Messenger thread** — any device may type at
any time, there is **no read-only spectator**, **no disabled composer**, and **no explicit
"take-over"**. The job here is only to guarantee **one reasoning chain at a time** (the original
bug was two *parallel* divergent chains) while every device stays in sync.

**The hazard to fix:** `agent_runs.start(session, …)` **cancels** any prior in-flight run for the
same session on a new submit (designed for one device's rapid double-send). For the game session
that would let a second device **stomp** the first's turn mid-stream.

**The fix — serialize, don't stomp.** For a **game-framed** turn on the canonical session, a submit
that arrives while a run is in flight is **queued**, not cancelled: the user message is appended to
the one shared thread and its turn runs when the current turn completes (the engine already
serializes per user; this aligns the FE run manager with that). Concretely, the game path uses a
per-session **serial queue** in `agent_runs` (or a thin `game_turn_queue` wrapper) instead of the
cancel-prev branch. Plain (non-game) chats keep today's cancel-prev behavior unchanged.

**What every device shows.** While the house is composing a reply, every device renders the live
stream (existing attach path); a subtle, non-blocking "the house is responding…" affordance is fine,
but the composer **stays enabled** — a message typed during a reply simply **queues** and runs next,
exactly like sending a second Messenger message. No banner, no lockout, no button.

**Near-simultaneous sends.** Two messages sent at the same instant become two queued user turns and
two sequential house replies (Messenger-equivalent) — never two parallel chains. *(Optional v2
refinement, not v1: coalesce sends within a short window into one turn.)*

**Why this kills the bug at the root:** with the canonical session (A) + serialization (C), there is
never more than **one** run in flight per game and runs are **never stomped** — independent of how
many devices/tabs, or how flaky the per-device JS guards are.

### D. Once-only casting kickoff

The producers' opener must fire **once per game**, not once per device. Today `_openSent`
(in-memory) + `SEAT_TAKEN_KEY` (`sessionStorage`) are per-page-load / per-tab. Re-anchor the guard
to game state, two layers:

1. **Server (authoritative):** the turn queue (C) already serializes a second concurrent kickoff run behind the first.
   Additionally, the kickoff should only fire when the canonical session has **no prior assistant
   turn** — i.e. the game session is empty. The FE can check session history length before sending
   the cue; the engine's casting intake (`updateCasting` "next" status) is the deeper truth (a
   half-done interview resumes, never re-opens).
2. **Client:** `_orwellOpenGameAfterCasting` fires the cue only if (a) this is the canonical
   session, (b) the session has no messages yet, and (c) no run is active (existing
   `hasActiveStream` guard). A second device finding the opener already present simply renders it
   live and joins the shared thread.

### E. Robustness

- **Late join:** §B.1 (replay + live).
- **Reconnect:** `EventSource` auto-reconnects; `sessionSync.js` already re-establishes with capped
  backoff on hard-close.
- **FE restart mid-turn:** `agent_runs` / `session_events` / the turn queue are in-memory, so a
  restart drops the in-flight run **and** any queued turns (fail-open — a new turn can be driven).
  Devices catch up from **persisted history** (the wrapped generator saved the assistant message on
  completion, or its partial on cancel); the next poll / open reloads it. No run survives a restart
  by design (non-goal).
- **Multi-tab, one device:** same session id ⇒ turns serialize through the queue (identical to
  multi-device).
- **Cross-user isolation (0021):** `/api/chat/events/{id}` already owner-guards (W2);
  `/api/orwell/game-session` is `_current_user`-scoped and never returns another user's session;
  the turn queue is keyed by the user's own session id. No call for user A can observe user B.

### F. Window & HUD layout sync across devices

> **Superseded (owner call 2026-07-09, ADR 0017; noted 2026-11-12, ORW-286 item 8).** Cross-device layout sync was built and then reversed: window/HUD geometry is now remembered **per device** and only game state syncs across devices. The text below is the original design, kept as the record; where it says the layout is a "synced, per-user blob so every device shows the same arrangement", that is no longer the behavior.

The game UI is a set of draggable/resizable **OrwellWindow** kit windows (cast, finale,
retrospective, …) plus the **gadget rail** (0054). Their state persists **per-device** today, in
`localStorage`, under three per-user key families (`static/js/orwellWindow.js`):

- `orwell-slot-offset:<slotKey>:<user>` — the dragged geometry **offset (x,y)** (the one sanctioned
  geometry scheme, clamped at save + restore, S11/E91) and, where resized, **size (w,h)**;
- `orwell-win-parked:<id>:<user>` — **minimized / parked** state;
- `orwell-<id>-docked:<user>` — **docked** state.

So a window you move/minimize/dock on one device is invisible on the next. **F makes the layout a
synced, per-user blob** so every device shows the same arrangement.

**New store — `frontend/src/orwell_layout.py`** (pattern: `orwell_seasons.py`; Vault-free — UI
geometry carries no game secret):

```
get_layout(user) -> dict                      # { "windows": { "<id>": {open, minimized, docked, x, y, w, h} } }
patch_layout(user, window_id, partial) -> dict # last-write-wins per window; atomic + lock
```

`DATA_DIR/orwell_layout.json` = `{username: {windows: {...}}}`. Bounded (only known window ids; tiny
numeric/bool fields); factory-reset scrub takes it to default.

**New routes (in `routes/orwell_routes.py`), `_current_user`-scoped:**

- `GET  /api/orwell/layout` → the user's layout blob (defaults when unset).
- `PATCH /api/orwell/layout` → `{ windowId, state:{…partial…} }`; persists + publishes a
  `layout-changed` SSE event (below). **Debounced** on the client (drag/resize settle ~300–400ms;
  open/minimize/dock fire immediately).

**Client — `static/js/orwellWindow.js` + `orwellGadgetRail.js`:**

- On a geometry/min/dock/open/close change, write to the server (debounced) **in addition to**
  `localStorage` (localStorage stays the instant local cache + offline fallback; the server is the
  cross-device source of truth — on load, server layout wins when present).
- Apply remote `layout-changed` events live (move/resize/minimize/restore/dock the named window),
  **ignoring the device's own echo** (same pattern as `sessionSync.js`) and **deferring** a remote
  change to a window the user is **actively dragging/resizing right now** until that gesture ends
  (never yank a window out from under a live drag).

**Transport.** Reuse the canonical game session's `session_events` channel for `layout-changed`
(all of the user's game devices are subscribed to it via §B). Payload is ids + small geometry
numbers only — no message body, no Vault.

**Conflict model.** Last-write-wins per window (UI state, low stakes); debounce avoids chatter.
`prefers-reduced-motion` is honored when applying a remote move (snap, don't animate).

**Build phase.** F is part of the **full** build (after the stopgap), and is independent of the chat
serialization (C) — it can ship in its own slice.

---

## 4. Port / route / module contracts

| Surface | Kind | Contract |
|---|---|---|
| `frontend/src/orwell_game_session.py` | **new** FE store | `get/set/clear_game_session(user)`; JSON in `DATA_DIR`; atomic + lock; Vault-free (ids only). |
| `GET /api/orwell/game-session` | **new** route | `_current_user`-scoped; resolves-or-mints the canonical session; idempotent under concurrency; `{sessionId, created}`. |
| `/api/orwell/{new-game,next-season,reset-progress}` | **amend** | also `clear_game_session(user)` on reset (rotate the session for the new season). |
| ~~`frontend/src/game_turn_lock.py`~~ | **not built** | superseded by the Messenger decision (no turn lock / spectator / take-over). |
| `POST /api/chat/stream` (game-framed) | **amend** | **as shipped:** opts into `agent_runs.start(..., queue=True)` via `ctx.framed`, so a second device's game turn **queues** behind the in-flight run instead of stomping it or being refused (no 409). |
| `POST /api/chat/stop/{id}` | **reuse** | unchanged plain stop; no lock to release. |
| `GET /api/chat/events/{id}`, `/resume/{id}` | **reuse** | the existing per-session SSE + run-attach; now engaged because devices share `id`. |
| `static/js/orwellOnboarding.js` | **amend** | resolve + `selectSession` the canonical session instead of minting a device-local one. |
| `static/js/sessionSync.js` | **reuse/verify** | already reconciles `run-started` / `message-added`; verify late-join attach. |
| `frontend/src/orwell_layout.py` | **new** FE store | `get_layout` / `patch_layout(user, window_id, partial)`; JSON in `DATA_DIR`; atomic + lock; Vault-free (geometry only). |
| `GET /api/orwell/layout`, `PATCH /api/orwell/layout` | **new** routes | `_current_user`-scoped read/patch; PATCH publishes `layout-changed`. |
| `static/js/orwellWindow.js`, `orwellGadgetRail.js` | **amend** | write geometry/min/dock/open changes to the server (debounced) + apply remote `layout-changed` (ignore self-echo; defer during a live drag). |
| `session_events` `game-updated` / `layout-changed` | **new** events | instant cross-device HUD + window reconcile (ids/geometry only). |

**Vault Wall:** every new surface is Vault-free by construction — session **ids**, run status, and
"something changed" pings only; message bodies are fetched through the existing **owner-guarded**
history route. No new path touches `VaultStore` (engine-only anyway). The God-Mode wall is
untouched.

---

## 5. Test strategy

FE **pytest** is the gate (the feature is FE-only); the **browser smoke** drives two simulated
clients. No names in any fixture (roles only). Concrete suites:

- **Canonical session (`test_0064_canonical_session.py`)** — two *concurrent* `GET
  /api/orwell/game-session` for one user return the **same** id; a different user gets a **different**
  id; a reset (`/next-season`, `/reset-progress`) **rotates** the id; a stored id that no longer
  exists is re-minted.
- **Turn queue (`test_0064_turn_queue.py`)** — while a game run is active, a second game-turn submit
  **queues** and runs after the first (no stomp, no 409, no spectator state); a plain (non-game) chat
  keeps cancel-on-double-send. *(Replaces the original turn-lock / 409 `turn-in-progress` suite, which was never built.)*
- **Live sync (`test_0064_session_sync.py`)** — a subscriber to `/api/chat/events/{id}` receives
  `run-started` + `message-added` for the shared session; a subscriber for a **different user's**
  session id is refused (owner guard); event payloads carry **no message body** and no Vault
  sentinel.
- **Once-only kickoff (`test_0064_kickoff_once.py`)** — with two devices on the canonical session,
  the producers' opener is recorded **once** (one assistant opener; one casting-intake open).
- **Layout sync (`test_0064_layout_sync.py`)** — `PATCH /api/orwell/layout` for a window persists +
  is reflected by `GET /api/orwell/layout`; a different user's layout is isolated; a `layout-changed`
  event fires carrying only ids + geometry numbers (no Vault, no message body); last-write-wins on a
  concurrent patch of the same window.
- **Browser smoke (extend `scripts/browser_smoke.py`)** — two headless contexts, same account:
  device A drives a casting turn; device B (already open) renders the **same** producer message and
  the live stream; B's composer stays enabled (Messenger model, no spectator banner) and a turn B
  sends during A's turn queues behind it.

**Definition of done:** the pytest suites green; the browser smoke shows two devices on one
conversation with one-driver-at-a-time; an owner-guard + Vault-sentinel assertion on every new
route; the two-device casting-interview no longer produces two reasoning chains.

---

## 6. Acceptance criteria

1. Two devices on one account always open the **same** game `session_id`.
2. A game turn driven on one device **streams live** on every other device (tokens, not just the
   final message).
3. At most **one** game reasoning chain runs at a time per user; a second device's turn is
   **queued behind** the in-flight run (Messenger model), never a stomp, never a 409 / spectator lockout, and never a second parallel chain.
4. The casting producers reach out **once** per game regardless of device count.
5. A device opening mid-turn **catches up** (replay + live); a reconnect resumes; an FE restart
   degrades to history catch-up without a stuck game.
6. A season reset **rotates** the canonical session (no dead-season bleed-through).
7. Every new surface is **owner-scoped and Vault-free**; no cross-user observation.
8. A window's **open/minimized/docked** state, **size**, and **position** are persisted server-side
   **per device** (ADR 0017 superseded the original cross-device sync: a desktop and a phone keep
   independent arrangements; only the same device's tabs mirror each other), without yanking a window
   the user is actively dragging.

---

## 7. Implementer handoff

**Build order (locked: stopgap first):**

- **Stopgap PR** — **A** (canonical session store + `GET /api/orwell/game-session` + onboarding
  resolves/selects it; reset doors clear it) + **D** (once-only kickoff). This alone stops today's
  two-device double-up: once devices share the session, the existing `sessionSync.js` engages and
  both screens show one conversation.
- **Full PR(s)** — **C** (Messenger-style serialization: queue-don't-stomp on the game session;
  composer stays enabled; no take-over) → **B** hardening (late-join attach, hidden-kickoff
  reconcile, `game-updated` instant HUD event) → **E** (robustness) → **F** (window/HUD layout
  sync — independent slice) → tests throughout (BDD/TDD-first: write the pytest red, implement to
  green).

**What this replaces.** The per-tab / per-device onboarding guards (`_openSent`, `SEAT_TAKEN_KEY`,
the `currentSessionId` localStorage default, the per-session `_SESSION_GAME_FRAMED`) are no longer
the coordination mechanism — the **server-side canonical session + turn queue** are. Leave the JS
guards as cheap local fast-paths, but they must never be the only thing standing between two devices
and two reasoning chains.

**Watch:** `routes/chat_helpers.py` `_SESSION_GAME_FRAMED` and the desync spine
(`_LAST_BEAT_SIG`, `_DESYNC_REGROUND`) are keyed by `session_id` / `user`. With a single canonical
session this is now coherent across devices (good) — verify the re-entry moment (P2) fires once on
the shared session, not per device.

**Open questions — RESOLVED (2026-06-20, see *Decisions locked* up top):**

1. **Concurrency model →** *Messenger-style* (any device types anytime; one shared synced thread; no
   spectator lockout, no driver lock). Concurrency is handled by **serializing** turns (§3.C), so the
   former "passive vs co-drive / take-over" question is moot — there is **no take-over action**.
2. **Take-over friction →** n/a (no explicit take-over).
3. **`game-updated` instant-reconcile event →** **ship in v1** (instant HUD + window sync).
4. **Idle-driver auto-release →** n/a (no lock). A stuck *player decision* still surfaces on every
   device via the engine's authoritative `pending` and can be taken on any device.

**Remaining open question (minor):** should layout sync (F) be **always on** (spec default) or a
per-user **toggle**? Recommend always-on for v1 (it's what "one game, every screen in sync" implies);
add a toggle only if a player asks to keep devices independent.

---

## Amendment (2026-06-28) — instant HUD parity from the chat-turn path (F5 status/gadget half)

**Status:** ✅ Built. **References:** ship-gate **F5** (`docs/audits/2026-06-27-ship-gate.md` — realtime
two-window mirror parity, the #1 release blocker), ADR [0012](../decisions/0012-two-window-lockstep-mirror.md)
(the Messenger mirror) and ADR [0015](../decisions/0015-collapse-duplicated-live-render-paths.md) (the
chat-RENDER half — this amendment is its **status/gadget complement**). **Gate:** the harness HUD-parity
gate `docs/audits/playtest-harness/mirror_hud_parity.mjs` (via `run_mirror_gate.sh MIRROR_HUD=1` — key-free,
deterministic fake model, RED→GREEN) + the source-pin `frontend/tests/test_1130_hud_parity_instant.py`.

### The gap (§3.B.3 was half-wired)

§3.B.3 specced the `game-updated` instant-reconcile ping "after `/api/orwell/decision`, `/self-eviction/*`,
and a committed `advanceGame`". The first two shipped (the three `_publish_game_updated` call sites in
`routes/orwell_routes.py`); **the committed-`advanceGame` / chat-turn case did not** — the chat-turn path
(`routes/chat_routes.py` / the agent loop) was the one mutation seam that **never published**. A game-framed
chat turn whose agent-loop tools mutate engine state (`markHouseguestMet`, `advanceGame`,
`recordInteraction`, the **0055 `_auto_record_scene` belt**) refreshed **only the SENDER's** HUD —
client-side, via `chat.js → orwellGameChanged('tool:…')` (the g15 dispatcher). Peer windows got **no**
push and stayed stale until their own 20–30s poll. Observed live (two windows, one game): window A "1 of
15 met", window B "0 of 15".

### The fix (server-side only; the FE reaction was already correct)

The chat-turn DONE seam now fires the **same** 0064 push the decision/self-eviction routes do, gated on an
**actual committed mutation** so a pure no-op / OOC / refused turn pushes nothing:

- `routes/chat_helpers.py :: publish_game_updated_after_turn(user, beat_seq_before, tools_called)` —
  publishes `game-updated` (via the shared, Vault-free `orwell_game_session.publish_game_updated`) **iff**
  the turn mutated: a `GAME_ENGINE_WRITE_TOOLS` call ran this turn, **or** the user's `beatSeq` advanced
  over the turn (which also catches the FE error-correction belts that mutate **without** the model naming
  a write tool — the `markHouseguestMet` auto-belt, the forced `advanceGame`). Fail-soft.
- `routes/chat_routes.py` (the `data: [DONE]` branch) snapshots `last_beat_seq(ctx.user)` **before** the
  turn, calls the helper at settle, **and** chains a second push onto the E22/0055 `recordInteraction`
  fallback task (`add_done_callback`) — that fallback mutates fire-and-forget **after** settle, so its push
  rides its own completion (only when it actually recorded).

**The FE reaction is unchanged.** The `game-updated` SSE still routes through the ONE g15 dispatcher:
`sessionSync.js notifyGameUpdated() → window.orwellGameChanged('sync:game-updated')` → the debounced
`orwell:gamechanged` → every HUD panel re-fetches its own Vault-free projection. No new dispatcher, no
ad-hoc `new CustomEvent`. **Vault-free:** the push carries a session id + the bare change-type only (no
state body); each window re-fetches its own owner-guarded projection.

### The invariant (the gate's Given/When/Then)

```gherkin
Scenario: A chat turn that mutates engine state instantly updates every window's HUD
  Given two windows are open on one started game (the same canonical session)
    And both windows are bound + subscribed to the canonical SSE channel (ADR 0008/0012)
  When a chat turn in window A mutates engine state
  Then the server publishes `game-updated` to the user's windows
    And window B's HUD reflects the new state within HUD_PARITY_BUDGET_MS (≤2000ms; target sub-second),
        driven by the SERVER PUSH not the 20–30s poll
    And no Vault data crosses (the push carries no state body; each window re-fetches its own
        Vault-free projection)
```

Gate mapping: *B reflects the state off the push* ⇒ the harness measures B's `orwell:gamechanged` carrying
the `sync:game-updated` reason — dispatched **only** by the 0064 SSE, never the poll — relative to A's
settle (the A↔B parity lag), and confirms the turn actually mutated (engine `beatSeq` before/after) so a
non-mutating turn can never produce a false green. RED on the base branch (B never receives a push from a
chat turn → it would only converge on its poll); GREEN after the fix.
