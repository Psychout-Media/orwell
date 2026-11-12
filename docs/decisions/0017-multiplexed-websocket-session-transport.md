# 0017 — One multiplexed WebSocket per session (end-to-end dynamic transport)

> **Status:** **Accepted** (owner directive, 2026-07-12). Accepted 2026-07-12 (owner directive — WS Phase-2
> turn-on); originally owner-requested 2026-07-09. A transport-layer consolidation: replace the
> current real-time patchwork (SSE-over-fetch chat stream + a mirror SSE + 20–30 s HUD polls + the 0064
> cross-device push + the up-channel POSTs) with **one multiplexed WebSocket per canonical session** that
> carries **every dynamic, Vault-free surface** as a framed channel.
> **Status note (2026-11-03 doc-drift pass, #1939):** references below to `gameWatcher.ts` / `ORWELL_WATCHER_TICK_MS=0` describe the 2026-06-10 turn-driven ruling as it was first enforced. the wall-clock `GameWatcher` and every `ORWELL_WATCHER_*` knob were DELETED on 2026-07-10 (real-time purge, PO ruling), not merely disabled — the runtime clock is a pure `LogicalClock` and the only advance is one bounded off-screen tick per committed player turn; the ruling's substance (no engine-originated push) is unchanged.

> **Amendment 2026-11-12 (ORW-44, Ryne: "Drop it" — WebSocket only):** the permanent SSE/poll fallback this ADR required is **withdrawn for the game
> build.** The game build is **WebSocket-only**: no long-poll or SSE fallback, no `ORWELL_WS_TRANSPORT` rollback flag (the flag is deleted;
> `ws_transport_enabled()` is the game build), and a network that blocks the live connection **cannot play** — the player sees a clear, persistent
> message ("this network blocks the live connection", `orwell:ws-blocked`) instead of a silent downgrade. Server side, the game build refuses
> `GET /api/chat/events/{id}`, `GET /api/chat/resume/{id}` and `POST /api/chat_stream` with a typed `426 ws-only` error; the WS `turn` frame reuses the chat
> pipeline, not those routes. A window that boots before the game is live finds the canonical session over REST and upgrades the socket
> (`OrwellWs.kick()`), since the SSE `run-started` invitation no longer exists. **The non-game build (`ORWELL_GAME_BUILD=0`) keeps the SSE/poll stack**
> (`chat_stream`, `events`, `resume`, the HUD polls); that is all the fallback now means. The F5 mirror-parity CI gate runs the WebSocket transport only
> (S4d). The "keep it permanently" statements below are therefore **superseded** for the game build; they stay as the 2026-07-09 record.

> **Owner intent (verbatim goal):** *"notifications, chats, gadget status, locations, window positions,
> window status, and anything else dynamic should go over WS — one multiplexed WS per session,
> end-to-end."*
> **Builds on / does not replace:** ADR [`0008`](./0008-chat-conversation-consistency.md) (the settled-log
> `seq` + reconcile-by-id + completion-broadcast — the delivery consistency model), ADR
> [`0012`](./0012-two-window-lockstep-mirror.md) (single-writer-per-turn broadcast via the `agent_runs._Run`
> replay-then-tail primitive), ADR [`0015`](./0015-collapse-duplicated-live-render-paths.md) (R2 — one
> incremental renderer, already landed), and feature 0064 (cross-device sync) / 0065 (the `beatSeq`/409
> closed-set spine). **This ADR changes the TRANSPORT (the pipes), not the consistency model.** No CRDT,
> no OT, no new authority — 0015 already reasoned those away.
> **Bounded by:** the **Vault Wall** (mandate #2) and **cross-user isolation** (0021), both structural and
> unchanged; the reasoning-scrub channel split (`roundReplyText`/`roundReasoningText`) stands verbatim.
> **Not one byte of gameplay changes.**

## Context

The app's real-time surface today is a **patchwork of five transports** doing one job — keep every open
window fresh. Grounded inventory (Browser ↔ FastAPI FE, all file:line verified):

| Channel | Endpoint | Transport today |
|---|---|---|
| Live chat stream (tokens) | `POST /api/chat_stream` | chunked SSE-over-fetch-POST |
| Two-window mirror events | `GET /api/chat/events/{id}` | persistent SSE (ids/types only) |
| Mirror resume (replay-then-tail) | `GET /api/chat/resume/{id}` | chunked SSE + `agent_runs.subscribe` replay→live-tail |
| Canonical-session binding | `GET/POST /api/orwell/game-session` | fetch-JSON (first-writer-wins) + liveness DB check |
| g15 HUD status | `GET /api/orwell/status` `/state` | **poll, 20 s** (`orwellStatusPanel.js`) |
| Presence / locations (0049/0066) | `GET /api/orwell/whereabouts` | **poll, 25 s** (`orwellPresence.js`) |
| Cross-device reconcile (0064) | `game-updated` over the events SSE | ad-hoc server push |
| Window layout (0064-F) | `GET/PATCH /api/orwell/layout` + `layout-changed` SSE | localStorage + debounced PATCH, LWW |
| Notifications (OrwellNotice) | — | client-created; only dismissal-state syncs (via layout) |
| Up-channel (turn / decision) | `POST /api/chat_stream`, `POST /api/orwell/decision` | fetch-POST |

Two structural facts make this the right time to consolidate:

1. **The hard problems are already solved one layer down.** ADR 0008 gave the settled log a real total
   order (seq + reconcile-by-id). ADR 0012 made a turn *one authoritative server-side run fanned out
   token-by-token* via the `agent_runs._Run` **replay-then-tail** primitive (replay the buffer from seq 0,
   then live-tail — a window that opens mid-stream joins with no gap/dup). ADR 0015 (R2, **landed
   2026-06-27**) collapsed the two render engines into one incremental renderer. So a WS here is **"swap
   the pipe under a proven model,"** not "re-solve consistency."

2. **The patchwork is the fragility.** The F5 launch-blocker (realtime two-window parity) has repeatedly
   broken on the *binding/liveness* seam (#1085 window-collapse, #1086 reply-strip, #1092 late-attach) —
   all variants of *"is the canonical binding still pointing at a live window?"* guesswork. And the 20–30 s
   HUD polls mean gadget/presence state lags reality by up to a poll interval even when the chat is live.

**Owner goal:** one multiplexed per-session WebSocket becomes **the single push channel for all dynamic
Vault-free state** — chat tokens, HUD/board status, presence/locations, notifications, decision pendings,
token/usage, window positions/status, cross-device sync — so *every poll and every ad-hoc SSE/push seam
collapses into one socket*, and window-liveness becomes **socket-native** (open socket = live window),
attacking the exact root of the F5 regressions.

## Decision

**Adopt one multiplexed WebSocket per canonical session, browser ↔ FE, carrying every dynamic Vault-free
surface as a discriminated frame.** The socket is keyed on the **canonical session id** (the existing
binding is the multiplex key). Frame `type` discriminates channels. The FE↔engine hop (Hop 2) stays
**request/response** for now; engine-originated *push* is explicitly **out of scope** (it would require
reversing the turn-driven ruling — see §Engine hop).

### Frame taxonomy (one socket, many channels)

| Frame | Dir | Replaces | Notes |
|---|---|---|---|
| `hello` / `bind` | ↑↓ | the `/game-session` GET/POST handshake | client presents its per-tab id; server resolves + **validates liveness** (`_is_live_chat_session`), first-writer-wins binds, ACKs the canonical id. **Binding+liveness happen BEFORE any subscribe** — the socket never subscribes to a dead channel (kills the #1085/#1086 class). |
| `stream` | ↓ | `POST /api/chat_stream` down-half | the same `delta` / `message_saved` / `[DONE]` events; the reasoning split (`roundReplyText`/`roundReasoningText`) rides **inside** the payload, unchanged. |
| `subscribe {fromSeq}` / `event` | ↑↓ | `/api/chat/events` + `/api/chat/resume` | **THE load-bearing port**: the `agent_runs` replay-then-tail (replay from `fromSeq`, then live-tail; 180 s evict grace; `has_run` resumes a *terminal-but-buffered* run) must survive verbatim at the socket splice — no gap/dup where the buffered prefix meets the live tail. |
| `state` / `hud` | ↓ | the 20 s status poll + 25 s presence poll + `game-updated` ping | server-pushed, `beatSeq`-keyed. **Deletes the poll timers.** The in-page `orwell:gamechanged` dispatcher stays as the *client-internal* fan-out (its one-dispatcher g15 invariant is untouched). |
| `turn` / `decision` (correlation-id) | ↑ | the up-channel POSTs | request/response over the socket; the FE relay routes to the engine and pushes the result + the `state` reconcile back. |
| `layout` | ↑↓ | `/api/orwell/layout` PATCH + `layout-changed` SSE | window positions/size/open/min/dock; **PER-DEVICE (owner call 2026-07-09), LWW within a device's own windows**, `origin` self-echo suppression — a device-scoped *sync* channel, NOT synced cross-device (only game state is). See §Two consistency models. |
| `notice` | ↓ | (new capability) + dismissal-sync | server-originated notifications/system-banners; dismissal-state still syncs (today via layout). |

### Two consistency models on one socket (the crux)

The scout's key finding, and the thing the ADR must hold explicit:

- **Engine-owned game state → authoritative push-DOWN.** board/phase/HOH/noms/veto, presence/locations,
  decision pendings, `beatSeq`. The client never authors these; it receives them. Ordering stays
  `seq`/`beatSeq` (0008/0065); a turn is still a single-writer broadcast (0012). *Relay nuance:* today the
  FE is a **relay** — the engine does not push; the FE reads the engine (Hop 2, request/response) and pushes
  to the browser. The WS removes the **browser↔FE** poll, not the FE↔engine poll. *(Owner call 2026-07-09:
  a genuinely push-driven engine — the "living house" — is now to be pursued in a **separate ADR**; see
  §Engine hop and §Phasing Phase 3.)*
- **Client-owned UI/session state → collaborative sync.** dock, notice-dismissal remain **per-user LWW**,
  self-echo-suppressed by `origin`. **Window layout, however, is now PER-DEVICE (owner call 2026-07-09):**
  positions/size/open/min/dock geometry are remembered per device and are **not** synced cross-device — a
  desktop and a phone stop fighting over window placement. Only **game state** syncs cross-device; layout
  does not. This is a change from 0064-F's single shared per-user layout: the `layout` frame becomes a
  device-scoped persist (still LWW *within* a device's own windows), and the cross-device `layout-changed`
  fan-out is dropped for geometry (notice-dismissal still syncs).

Keeping these two models *distinct but co-resident* on one socket is the whole design. **No CRDT/OT** — for
game state there is no concurrent-writer problem (single-writer-per-turn), and for layout LWW is already
the accepted policy (ADR 0008 §rejected-alternatives reasoning applies).

### Invariants preserved (why this is safe, not a rewrite)

1. **Vault Wall** — only player-known projections cross the socket, exactly as the SSE/poll surfaces do
   today; the socket carries no secret state, no new reader.
2. **Cross-user isolation (0021)** — one socket ↔ one user's canonical session; never multiplex across
   users. The `hello` handshake is owner-guarded (mirrors `chat_routes.py`'s owner guard on `/events`).
3. **Reasoning-scrub split** — reasoning never reaches the public bubble; it's a buffer split *inside* the
   `stream` payload, a non-transport concern (ADR 0015 contract, unchanged).
4. **Replay-then-tail resume, generalized** — the `agent_runs` primitive that lets a window join mid-turn
   extends from chat to *every* channel: a window that (re)connects gets each channel's buffered prefix
   then its live tail. This is what makes multi-window/reconnect robust rather than fragile.
5. **F5 render parity** — ADR 0015's one-incremental-renderer stands; the WS changes only *how bytes
   arrive*, not how the observer renders them.

## Engine hop (Hop 2) — the "end-to-end" boundary

The FE↔engine hop is **100 % request/response JSON today** (`orwell_engine.py` `httpx.post(...).json()`;
`HttpMcpServer.ts` writes `application/json` + `res.end`; no `text/event-stream`, no WebSocket). Two
readings of "end-to-end WS," with sharply different risk:

1. **RPC-over-WS, behavior-preserving (allowed, low value).** Carry the same `tools/call`
   request/response envelope (correlation-id per call) over a persistent WS instead of pooled `httpx`.
   Nothing forbids it; the 409 stale-beat CAS + `beatSeq` attach/refresh work identically. But the FE
   already pools an `AsyncClient`, so the win is marginal (connection reuse). **Deferrable.**
2. **Engine-originated event push = a living, event-driven house (owner electing to pursue in a SEPARATE
   ADR; the WS is only the transport enabler, NOT the licensing signal).** For the engine to *originate*
   messages (NPCs act between the player's turns; the house pushes a beat), it needs a producer that today is
   **off by explicit product ruling** — *"the house lives between the player's own turns … and does NOT
   exist while the player is away … background advances during an absence are a structural disadvantage"*
   (2026-06-10; `ORWELL_WATCHER_TICK_MS=0` default, `gameWatcher.ts`).

   **A tempting-but-WRONG shortcut, called out so nobody takes it (owner correction, 2026-07-09):** *"open
   socket = player present = actively playing"* is **false.** A connected socket means only that a tab is
   open — a background tab, a pocketed phone, an idle desktop can all hold a live socket for hours with the
   player nowhere near it. **The activity signal that the ruling turns on is the player TAKING TURNS
   (sending messages), not holding a connection.** So the socket is **not** a presence discriminator and
   **cannot** be used to license engine push: pushing beats to an idle-but-connected player is still "the
   house living while the player isn't actually playing," which is exactly the structural-disadvantage case
   2026-06-10 closed. The WS lowers the *transport* cost of engine push to ~zero; it does **not** move the
   *game-design* line one inch.

   **Therefore the honest framing:** whether the engine may originate beats — and on what activity signal
   (only tightly around the player's own turns, as today's per-turn off-screen tick does? or on some looser
   in-session cadence?) — is a **game-design decision that squarely re-litigates the 2026-06-10 ruling**, and
   it belongs in the **separate living-house ADR** the owner is electing to open. It is **not** something
   this transport ADR can smuggle in via a socket-presence loophole. This ADR's socket is the pipe that
   *would carry* such pushes; it takes no position on *when* they are allowed.

**Therefore "end-to-end" cleanly means:** multiplex all of Hop 1 onto one per-session socket **now**, and
**optionally** move Hop 2 to behavior-preserving RPC-over-WS later. A genuinely *push-driven* engine (the
"living house") remains a **separate product decision** — but the owner has (2026-07-09) **elected to pursue
it**: a distinct ADR will re-litigate the 2026-06-10 turn-driven ruling (`ORWELL_WATCHER_TICK_MS=0`) and
decide whether/how the engine may originate beats while the player is idle. That ADR is the true
"end-to-end to the engine" decision; **this** ADR stays the transport consolidation and states the boundary
rather than implying the engine can push events today. The socket designed here is the *enabler* the
living-house ADR would build on (§Phasing Phase 3).

## Phasing

- **Phase 0 (prerequisite — DONE on `main`, #1276, 2026-07-09).** Promote the F5 mirror-parity harness
  (`mirror_live_parity.mjs` / `run_mirror_gate.sh`) to a **required CI gate** (ADR 0015's owed follow-on) —
  the **red/green oracle** for two-window parity; you do not change the launch-blocker's transport without
  it. This is now **complete.** The harness was briefly RED: two of three checks passed
  (`bStartsDuringAStream`, `lagWithinBudget`) but **`bUsesIncrementalRenderer` FAILED** — observer window B
  reconciled via the `softReloadHistory` **reload** path (mounting `.body`) rather than the incremental
  `.live-reply-content` container, and `resumeStream`'s own-echo **dup-abort** tore its holder down before the
  incremental path painted, so under the fast deterministic fake model B rendered near settle rather than as
  a live incremental mirror. **#1276 fixed that race** (it scoped the dup-abort to the true own-echo case; a
  late-attaching observer's static from-history bubble is now removed and the terminal-buffered run replayed
  through the SHARED incremental renderer) **and wired `mirror-parity` as a required CI gate — it is green
  and blocking via `ci-gate` on `main`.** ADR 0015's "R2 landed" is now backed by a green behavioral gate;
  the harness README's earlier "RED" verdict is superseded. **Do not weaken the `bUsesIncrementalRenderer`
  bar** — it is the launch-blocker's acceptance bar and now guards every PR (before *and* after the WS swap).
- **Phase 1 — browser↔FE multiplexed WS.** Stand up one WS per canonical session behind a **feature flag**,
  carrying `hello`/`stream`/`event`/`state`/`turn`/`decision`/`layout`/`notice`. Port the replay-then-tail
  splice first (highest-risk). Delete the 20–30 s polls. **Keep the SSE/poll path as a PERMANENT fallback**
  (owner call 2026-07-09; **superseded for the game build 2026-11-12, see the amendment: WebSocket only**) — a client behind a restrictive proxy that cannot upgrade to WS falls back to
  today's transports and must still pass F5; the fallback is not dropped once WS proves out. Gated by: the
  Phase-0 harness green (must pass before *and* after) + the full FE pytest suite + new WS-specific tests
  (§Testability).
- **Phase 2 (optional).** RPC-over-WS on Hop 2 — behavior-preserving, no engine change. (Open decision #1;
  marginal gain since the FE already pools `httpx`.)
- **Phase 3 (owner-elected → a SEPARATE living-house ADR).** Engine event-push. **The socket is the pipe,
  NOT the licence** (§Engine hop): an open socket means only "a live pipe exists," never "the player is
  present/playing." Whether the engine may originate beats — and on what **explicit activity/presence
  signal** (the current per-turn off-screen tick keys off the player *taking a turn*; anything looser is a
  new signal) — is a game-design decision that **re-litigates the 2026-06-10 ruling** and is settled in the
  separate living-house ADR, not here. That ADR defines the activity signal + producer, keeps the closed-set
  spine (`beatSeq`/409) authoritative, and holds the Vault Wall. This ADR's transport is its enabler only.

## Rejected / not-now alternatives

- **A CRDT / OT / event-store rewrite.** Rejected (as ADR 0015 already reasoned): single-writer-per-turn
  broadcast has no concurrent-writer problem; layout is LWW by policy. Concurrent-edit machinery buys
  nothing.
- **Keep the patchwork, lean on the settled-log reconcile.** Rejected: it leaves the 20–30 s HUD lag and
  the binding/liveness fragility that keeps re-breaking F5.
- **Gating engine push on socket-open ("the socket is a presence signal").** Rejected explicitly (§Engine
  hop): an open socket is a background tab / pocketed phone as easily as an engaged player — it says only
  "live pipe," never "playing." Any engine push must key off a real **activity signal** (the player taking
  turns), and choosing that signal re-litigates the 2026-06-10 ruling — a game-design call for the separate
  living-house ADR, not something the transport smuggles in.
- **Dropping the SSE/poll fallback once WS proves out.** Rejected (owner call 2026-07-09; **reversed 2026-11-12 for the game build: dropped, WebSocket only**): kept permanently
  so restrictive-proxy clients that cannot upgrade to WS still work and still pass F5.
- **One shared per-user layout synced cross-device (0064-F).** Superseded (owner call 2026-07-09): layout is
  now **per-device**; only game state syncs cross-device.
- **WS *without* Phase 0.** Rejected: changing the launch-blocker's transport with no required parity
  oracle is flying blind. Phase 0 is now satisfied — `mirror-parity` is a **green, required CI gate on
  `main`** (#1276) — so the WS migration has its red/green oracle in place before it starts.

## Testability / Acceptance

- **The binding gate stays the F5 harness** — `mirror_live_parity.mjs` (`bStartsDuringAStream`,
  `bUsesIncrementalRenderer`, `lagWithinBudget`) must pass **before and after** the WS swap. Once it is a
  required CI gate (Phase 0), the WS migration is safe to attempt.
- **New WS-specific tests:** (a) **reconnect-resume splice** — a socket that drops mid-turn and reconnects
  gets the buffered prefix then the live tail with no gap/dup (exercises the ported `agent_runs`
  primitive); (b) **liveness handshake** — a `hello` for a dead/non-owned session is refused *before*
  subscribe (the #1085/#1086 guard, socket-native); (c) **multiplex isolation** — frames for one channel
  never leak into another; (d) **layout LWW** — `origin` self-echo suppression holds over the socket;
  (e) **fallback** — a client with no WS falls back to SSE/poll and still passes F5. *(2026-11-12: withdrawn for the game build; a client that cannot hold the socket sees the "blocks the live connection" message instead.)*
- **Boundaries unchanged & still green:** the dependency-cruiser Vault-edge test + Vault sentinels (no new
  reader), cross-user isolation (0021), the full FE pytest suite, and the ADR 0008 `seq`/reconcile
  contract.

## Owner decisions (resolved 2026-07-09) + remaining red-lines

**Resolved by the owner (2026-07-09):**

2. **Engine push / living house → PURSUE, in a separate ADR.** The real "end-to-end to the engine" question
   is elevated to its own ADR (§Engine hop, Phase 3). **The socket is the transport enabler, not the
   licence** — an open socket is not a presence/activity signal (a background tab holds one), so engine push
   must key off an explicit activity signal (the player taking turns), and choosing that signal
   re-litigates the 2026-06-10 turn-driven ruling. The separate ADR owns that game-design decision + the
   producer; this ADR only carries the bytes.
4. **Fallback lifetime → KEEP the SSE/poll fallback permanently.** *(Superseded 2026-11-12 for the game build: WebSocket only, Ryne "Drop it".)* For restrictive proxies / clients that
   cannot upgrade to WS; not dropped once WS is proven.
3. **Layout policy → PER-DEVICE.** Supersedes 0064-F's single shared per-user layout: geometry is
   remembered per device and not synced cross-device; only game state syncs.

**Still open (please red-line):**

1. **Hop 2:** RPC-over-WS in Phase 2, or leave FE↔engine on pooled HTTP indefinitely? (Marginal gain — the
   FE already pools `httpx`.)
5. **Server framework:** Starlette/FastAPI native WebSockets are the obvious host; confirm no reverse-proxy
   (the ADR 0007/0014 exposure/HTTPS story) blocks WS upgrade in the target deploy.

## Consequences

- **All dynamic state pushed over one socket** — chat, HUD/board, presence, notifications, decision
  pendings, layout, cross-device — with polling deleted (instant HUD/cross-device freshness) and
  window-liveness socket-native (the F5 binding fragility attacked at the root).
- **Smaller surface, not larger** (like 0015): five browser↔FE transports collapse to one multiplexed
  socket; the consistency model and the engine are untouched.
- **Vault Wall + cross-user isolation + reasoning split preserved** by construction.
- **Bounded blast radius:** `frontend/` (the transport layer + the consume loops) + a FastAPI WS route.
  The engine, the closed-set spine, and gameplay are unchanged.

## Traceability

- Owner request: 2026-07-09 ("one multiplexed WS per session, end-to-end; everything dynamic over WS").
- Grounded in: the 2026-07-09 transport inventory (Hop 1 / Hop 2 channel map, file:line).
- Builds on: ADR 0008 (settled-log consistency), ADR 0012 (single-writer broadcast + replay-then-tail),
  ADR 0015 (R2 one renderer), features 0064 (cross-device) / 0065 (beatSeq spine).
- Gated by: the 2026-06-10 turn-driven ruling (`ORWELL_WATCHER_TICK_MS=0`) for the engine-push half; the
  Vault Wall (mandate #2) and cross-user isolation (0021) throughout.
- Prerequisite: promote the F5 mirror-parity harness to a required CI gate (ADR 0015 owed follow-on) —
  **satisfied on `main` by #1276** (`mirror-parity` is now green and blocking via `ci-gate`).
