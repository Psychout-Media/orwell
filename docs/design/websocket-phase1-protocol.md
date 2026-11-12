# WebSocket Phase-1 protocol & implementation plan

> **Status:** design note (build-ready wire spec). Companion to ADR
> [`0017`](../decisions/0017-multiplexed-websocket-session-transport.md) — it turns 0017's frame
> taxonomy into a concrete, per-frame wire contract an engineer can implement directly. **Docs-only.**
> Not an ADR (it decides no new policy) and not code (it specifies the code Phase 1 writes).
> *(Merge-order dependency: ADR 0017 is **Proposed** in PR #1265 and is not yet on `main`, so the link
> above resolves only once #1265 lands. 0017 IS the correct companion — do not retarget the link; #1265
> must merge before this spec.)*
>
> **Scope:** ADR 0017 **Phase 1** — one multiplexed WebSocket per canonical session, **browser ↔ FE**
> (Hop 1). Hop 2 (FE ↔ engine) stays request/response, unchanged. No engine push. Not one byte of
> gameplay changes.
>
> **Hard gate (do not hand-wave):** Phase 1 **cannot start until Phase 0 is green.** ADR 0017 §Phasing
> makes the F5 mirror-parity harness (`docs/audits/playtest-harness/mirror_live_parity.mjs` +
> `run_mirror_gate.sh`) the red/green oracle — **Phase 0 is now DONE on `main`:** #1276 fixed the
> `bUsesIncrementalRenderer` race and wired `mirror-parity` as a **green, required CI gate** (blocking via
> `ci-gate`). **This spec is what you build now that the gate is green** — and the same gate must stay
> green after every Phase-1 change. Everything below is written assuming that precondition is satisfied.

---

## 0. What this spec ports (grounding — every seam is real, cited file:line)

The WS does not invent a consistency model; it **swaps the pipe** under the proven one. The load-bearing
FE seams Phase 1 re-hosts on the socket:

| Concern | Today's transport | file:line | Ported onto |
|---|---|---|---|
| Live token stream (+ reasoning split) | `POST /api/chat_stream` chunked SSE | `frontend/routes/chat_routes.py:685` | `event` frames on `chat` (§3.2) |
| Detached run replay→live-tail (**the crown jewel**) | `agent_runs._Run` + `subscribe()` | `frontend/src/agent_runs.py:25,179` | `subscribe`/`event` frames |
| Mirror resume (late-attach) | `GET /api/chat/resume/{id}` → `agent_runs.subscribe` | `chat_routes.py:1867` | `subscribe{fromSeq}` |
| Cross-device invitation bus (`run-started`) | `GET /api/chat/events/{id}` → `session_events` | `chat_routes.py:1851`, `frontend/src/session_events.py:103,126` | `state` `run-started` edge (§4.1) |
| Canonical binding + liveness | `_resolve_canonical_session`, `_is_live_chat_session`, `resolve_live_game_session` | `frontend/routes/chat_helpers.py:4106,4121`, `frontend/src/orwell_game_session.py:119` | `hello`/`bind` handshake |
| HUD status | `GET /api/orwell/status` poll **20 s** | `frontend/static/js/orwellStatusPanel.js:19` | `state`/`hud` push |
| Presence / locations | `GET /api/orwell/whereabouts` poll **25 s** | `frontend/static/js/orwellPresence.js:29` | `hud` push |
| Cross-device HUD ping | `game-updated` over events SSE | `orwell_game_session.py:78`, `session_events.py:92` | `state` push |
| Window layout | `GET/PATCH /api/orwell/layout` + `layout-changed` SSE | `frontend/routes/orwell_routes.py:1631,1639` | `layout` frame (per-device) |
| Client-internal HUD fan-out | `window.orwellGameChanged(reason)` (ONE dispatcher) | `frontend/static/js/platform.js` | **unchanged** — stays the in-page fan-out |

**Two consistency models ride one socket** (ADR 0017 §"Two consistency models"):

- **Engine-owned game state → authoritative push-DOWN**, ordered by `seq` (ADR 0008) / `beatSeq`
  (0065). Client never authors it. A turn is still one single-writer broadcast (ADR 0012).
- **Client-owned UI state → sync.** Notice-dismissal is per-user LWW. **Layout is per-device LWW**
  (owner call 2026-07-09) — geometry is NOT synced cross-device; only game state syncs.

No CRDT/OT — single-writer-per-turn has no concurrent-writer problem; layout is LWW by policy.

---

## 1. Endpoint & transport

### 1.1 Route

```text
WS  /api/ws/session          (Starlette/FastAPI native WebSocket)
```

FastAPI's `@app.websocket("/api/ws/session")` / Starlette `WebSocket` is the host (ADR 0017 open item
#5). One socket per **tab**; the socket is multiplexed across all channels for the **one canonical
session** it resolves to. The per-tab id is presented in `hello` (below), never in the path — the path
carries no session id so a socket can be bound *after* liveness validation, never before (this is the
whole #1085/#1086 fix: **bind+validate before subscribe**).

**Auth / owner guard.** The upgrade request carries the same session cookie every `/api/*` route does;
the handshake resolves the current user via the existing `get_current_user` / `_current_user` helper and
**every** `hello`/`bind`/`subscribe` is owner-guarded exactly as `chat_routes.py:1856`
(`_verify_session_owner`) and `chat_events` are today. A socket may only ever bind/subscribe sessions
the authenticated user owns. Cross-user isolation (0021) is structural: one socket ↔ one user.

**Browser cross-site defense (WS-specific).** The HTTP CORS / security middleware does **not** cover a
WebSocket upgrade, so cookie auth alone is not enough: the handshake **must** additionally enforce a
cross-site check — an allowed-`Origin` allowlist (matching the deploy's own host per ADR 0007/0014) **or**
a session-bound CSRF token presented in `hello` — **before** it processes any `hello`/`bind`/`subscribe`.
A foreign-origin upgrade is refused at accept time (close, no `ack`). This sits alongside the
`get_current_user`/`_current_user` auth + `_verify_session_owner` authorization above, not in place of it.

**Reverse-proxy / exposure (ADR 0017 open #5, ADR 0007/0014).** The deploy terminates TLS and proxies
to uvicorn; the WS route needs `Upgrade`/`Connection` headers passed through. Phase 1 **must** verify
the target reverse-proxy config forwards the upgrade (systemd unit + any tunnel per ADR 0014). Where the
upgrade is blocked, the client **falls back to SSE/poll** (§6) — a permanent, not transitional, path.

### 1.2 Framing

Every message is a single JSON object, one per WS text frame. The discriminator is `t` (short for
type — kept terse because chat deltas are high-frequency). Envelope:

```jsonc
{
  "t":   "event",         // discriminator (required, every frame)
  "ch":  "chat",          // channel id (required for multiplexed frames; see §2)
  "cid": "c_7f3a",        // correlation id (request/response frames only)
  "seq": 42,              // per-channel monotonic seq (subscribe/event frames)
  "d":   { /* payload */ } // frame-type-specific body
}
```

- **`t`** — one of `hello|bind|ack|subscribe|event|state|hud|turn|decision|layout|notice|error|ping|pong`.
  **There is no separate `stream` frame:** chat tokens (live AND replayed) are `event` frames on the
  `chat` channel carrying `seq` — one chat-token contract, so the replay-then-tail splice uses the same
  wire type on both sides (§3).
- **`ch`** — the multiplex channel. Phase-1 channels: `chat`, `state`, `hud`, `layout`, `notice`.
  `hello`/`bind`/`ping`/`pong` are socket-level and carry no `ch`. **`ack` and `error` carry `ch` iff
  the request they answer did** — the one rule, no path-specific parsing: a `hello`/`bind` ack (§2.3)
  and a socket-level `error` omit `ch`, while a `subscribe` ack/error echo `ch:"chat"` (§3.1) so the
  client routes the reply to the right channel. (A `turn`/`decision` ack/error rides `ch:"chat"` too —
  §3.5 — since those are chat-channel frames.)
- **`cid`** — correlation id for request/response pairs (`turn`, `decision`, `subscribe`→first `ack`).
  Echoed on the matching reply so the client resolves the right promise. **This includes NEGATIVE
  replies:** an `error` frame answering a `hello`, `bind`, `subscribe`, `turn`, or `decision` **MUST**
  carry the original request's `cid` so the client rejects the correct pending promise (a bare
  `error` with no `cid` would leave the request hung and mis-attribute the failure). Only a truly
  unsolicited/socket-level `error` (e.g. a malformed frame with no parseable `cid`) may omit it.
- **`seq`** — the per-channel replay sequence (see §3). Only on `subscribe`/`event`.

Heartbeat: server sends `{"t":"ping"}` every 20 s (mirrors `session_events._HEARTBEAT_S`); client replies
`{"t":"pong"}`. A socket with no pong for 2 intervals is closed server-side (its runs stay detached in
`agent_runs`, so nothing is lost — §3).

---

## 2. Handshake: `hello` → `bind` → `ack` (bind + validate BEFORE any subscribe)

This is the socket-native replacement for the `GET/POST /api/orwell/game-session` dance +
`_resolve_canonical_session` + `_is_live_chat_session`. It closes the #1085/#1086 class by construction:
**the socket never subscribes to a channel until the canonical id is bound AND validated live.**

### 2.1 `hello` (client → server, first frame)

```jsonc
{
  "t": "hello",
  "cid": "c_00",               // correlation id — the ack (or a negative error) echoes it
  "d": {
    "perTabId": "sess_ab12",   // the tab's own chat-session id (may be pre-game / per-tab)
    "protocol": 1
  }
}
```

The client sends `hello` immediately on open, before any `subscribe`. `perTabId` is the id this tab
would POST under today (`sessions.js` current session) — it is only an **input** for the fallback/bind
target, never a control over which resolution branch the server takes (§2.2). The `hello` deliberately
carries **no** `framed`/`gameActive` flags: those are **server-derived**, not client-supplied (§2.2).
The `ack` (or a `cid`-tagged `error`) is the reply.

### 2.2 Server resolution — the branch is SERVER-DERIVED, never client-supplied (mirrors `_resolve_canonical_session`, `chat_helpers.py:4121`)

**Security-critical:** which resolution branch runs is decided from **authenticated server state**, not
from anything in the `hello` payload. The client sends only `perTabId`; the server derives "is this a
live started game?" and "is this casting/pre-game?" from its **own** sources — the same ones
`_resolve_canonical_session` / `resolve_live_game_session` already read (the per-user canonical binding
+ `_is_live_chat_session` row check + the engine's authoritative "season started" state). A forged
`hello` that *claimed* a started game (or claimed casting) must NOT be able to flip the branch, adopt a
foreign canonical id, or weaken the dead-session guard — so the server ignores any client-asserted
`framed`/`gameActive` and computes them itself. Do not fork the logic; call the same helpers:

1. **Started live game** (server-derived: the user's canonical binding resolves and the season is
   started) → `resolve_live_game_session(user, _is_live_chat_session)` (`orwell_game_session.py:119`):
   the first-writer-wins bound id **iff it still resolves to a live chat-session row**; a confirmed-dead
   binding is unbound as a side effect and falls back to `perTabId`.
2. **Casting / pre-game** (server-derived: no started season) → the **per-tab id** (`perTabId`)
   (GAP-2-b1, `chat_helpers.py:4131`). Casting stays strictly per-tab; two casting tabs do not mirror,
   by design.
3. Else → `perTabId`.

`perTabId` is used **only** as the fallback and the first-writer bind *target* — never as the signal
that picks the branch. If nothing is bound yet and the server determines this is a started-game frame,
**first-writer-wins bind** via `bind_game_session(user, perTabId)` (`orwell_game_session.py:55`) — a
racing second socket adopts the already-bound id. **Liveness is validated (`_is_live_chat_session`)
before the id is handed back.** A socket is never `ack`-bound to a dead id, so no channel is ever
subscribed to a 404 (the root cause of #1085 window-collapse and #1086 reply-strip).

### 2.3 `ack` (server → client)

```jsonc
{
  "t": "ack",
  "cid": "c_00",                // echoes the hello/bind cid so the client resolves the right promise
  "d": {
    "canonicalId": "sess_ab12", // the id every channel keys on for this socket
    "adopted": false,           // true ⇒ this socket LOST the bind race and adopted a different id
    "beatSeq": 118,             // current engine beatSeq (0065) — seeds the client's last-seen token
    "live": true                // the canonical id resolved to a live row
  }
}
```

`adopted: true` is the socket-native replacement for the sender-private `canonical_session` SSE event
(`chat_routes.py:1837`): the client re-points its view/HUD onto `canonicalId` (its `selectSession`),
exactly as `sessionSync.convergeView` does today — **without** the settle-time reload that stripped the
casting reply (#1086), because the re-point happens at handshake, before any stream is subscribed.

**`bind` frame.** A live socket that needs to *re-resolve* (e.g. a season reset unbinds the canonical id,
surfaced today by `orwell:gamechanged`) sends `{"t":"bind","cid":"c_1a","d":{"perTabId":"sess_ab12"}}`
(same shape as `hello` — a `cid` plus `perTabId`; the branch is still server-derived per §2.2) and
receives a fresh `ack` echoing that `cid`. This is the socket-native form of `refreshCanonical()`
re-ticking on a new id (`sessionSync.js:54`). The client still drops its cached canonical id on
`orwell:gamechanged` and issues `bind` — the one-dispatcher g15 invariant is untouched (§4).

### 2.4 Refusal

A `hello`/`bind` for a **non-owned** session → `{"t":"error","cid":"c_00","d":{"code":"forbidden"}}`
then close (mirrors `_verify_session_owner` raising) — the `cid` echoes the refused request so the client
rejects the matching pending promise (§1.2). A `hello` that resolves to a **dead** id after unbinding,
with no live fallback, → `ack` with `live:false` (still `cid`-tagged); the client shows the reconnect/
reload affordance rather than subscribing a dead channel. **No subscribe is accepted before a successful
`ack`** — enforce this server-side (a `subscribe` on an unbound socket →
`{"t":"error","cid":"c_01","d":{"code":"not-bound"}}`, echoing the `subscribe` cid).

---

## 3. `chat` channel: the replay-then-tail port (highest risk — must survive verbatim)

This is the one seam that **must not regress**. Today `agent_runs._Run` (`agent_runs.py:25`) keeps a
detached run's ordered event buffer and `subscribe()` (`agent_runs.py:179`) does **replay-from-0 →
live-tail**: register the subscriber queue *before* replaying so nothing is missed, replay
`buffer[0..len)`, then drain the live queue, **skipping events already replayed** (`if seq >= next_seq`),
and on the end sentinel flush any tail the sentinel raced. Phase 1 hosts this identically; the socket is
just a second subscriber transport beside the SSE one.

### 3.1 `subscribe` (client → server)

```jsonc
{ "t": "subscribe", "ch": "chat", "cid": "c_01", "d": { "fromSeq": 0 } }
```

- **`fromSeq`** — the per-run buffer index the client already has. **A fresh window sends `fromSeq: 0`**
  (full replay, byte-identical to today's `subscribe()` from index 0). **A reconnecting socket sends
  `fromSeq: <last event.seq + 1>`** — the server replays only `buffer[fromSeq..len)` then live-tails.
  This generalizes today's implicit "replay everything then tail" into "replay the *gap* then tail," which
  is what makes reconnect gapless (§3.3).
- The channel keys on the socket's `ack`'d `canonicalId` (the `run_key` — `chat_routes.py:1791`
  `run_key = ctx.canonical_session or session`). The client never picks the run key; the handshake did.

**The `subscribe`→`ack`→`event` handshake — ONE ordering, no replay race.** `subscribe` is a
request/response pair like `hello` (§1.2): the server **FIRST** answers with an `ack` echoing the
`subscribe` `cid`, **THEN** streams the replay `event` frames from `fromSeq` and live-tails. The `ack`
is what resolves the client's subscription promise and declares the window it is about to receive, so
the replay start can never race an unresolved promise. Reuse the same `ack` frame shape as the `hello`
handshake (§2.3), discriminated by `ch`/`cid`:

```jsonc
// server → client — sent BEFORE any event frame on this channel
{ "t":"ack", "ch":"chat", "cid":"c_01", "d":{ "fromSeq":0, "headSeq":41 } }
```

- **`fromSeq`** — echoes the accepted replay start (the client's requested cursor, clamped to the
  buffer if it over-shot). **`headSeq`** — the current buffer head (`len(_Run.buffer) - 1`,
  `agent_runs.py:47`), i.e. the last `seq` the client is about to receive from the replay before the
  live tail begins. Together they tell the client exactly the `[fromSeq..headSeq]` window the replay
  covers, so it knows when the prefix ends and the live tail starts — no guessing, no race.
- **`runId`** (additive, #1087) — the stable identity of the run this subscribe attached to
  (`agent_runs.run_id`), present when `hasRun:true`. The client records it as its reconcile-by-id
  anchor: a later ring-replayed `run-started` edge (§4.1) carrying the SAME id is a stale
  re-delivery for a run already rendered and is ignored. Opaque — compared, never parsed.
- **Ordering is mandatory:** the client MUST NOT begin rendering/ordering `event` frames until it has
  the `ack` for that `subscribe` `cid`; the server MUST NOT emit any `chat` `event` frame for a
  `subscribe` before its `ack`. (`hello`/`bind` already follow this ack-first rule, §2 — `subscribe`
  is the same contract on the `chat` channel.)
- **On failure the server sends an `error` instead and streams nothing:** a `subscribe` for a
  dead/non-owned session or a malformed `fromSeq` → `{"t":"error","ch":"chat","cid":"c_01","d":{"code":…}}`
  (`not-bound` / `forbidden` / `bad-cursor`, echoing the `cid` per §1.2) and **zero** `event` frames.
  The client rejects the subscription promise on that `cid`.

### 3.2 Server behavior (a thin socket adapter over `agent_runs`)

The `subscribe` handler sends the `ack{cid, ch:"chat", d:{fromSeq, headSeq}}` first (§3.1), then runs the
**existing** `agent_runs.subscribe(canonicalId)` generator, wrapping each yielded SSE-event string in an
`event` frame (the `ack` is emitted **before** the first of these). Critically, **`_Run.buffer` is already seq-indexed**
(`_publish` does `seq = len(run.buffer) - 1`, `agent_runs.py:47`), so the socket adapter attaches that
same index as the frame `seq`. To honor `fromSeq > 0` without touching `_Run`, the adapter skips yielded
events whose buffer index `< fromSeq` (the generator yields in buffer order, so the index is just a
running counter). Equivalent, lower-risk alternative: add a `subscribe(session_id, from_seq=0)` param to
`agent_runs` (the loop already tracks `next_seq`) — **preferred**, because it avoids re-yielding a large
prefix over the socket only to drop it client-side. Either way the semantics are the existing ones.

```jsonc
// server → client, one per buffered/live agent event
{ "t":"event", "ch":"chat", "seq":0, "d":{ "delta":"He glances", "thinking":false } }
{ "t":"event", "ch":"chat", "seq":1, "d":{ "delta":"at the memory wall", "thinking":true } }
{ "t":"event", "ch":"chat", "seq":2, "d":{ "type":"message_saved", "id":"m_88", "seq":41 } }
{ "t":"event", "ch":"chat", "seq":3, "d":{ "done":true } }          // maps [DONE]
```

The `d` payloads are the **existing** `chat_stream` event bodies, unchanged (`agent_loop.py:4811` for
`{"delta", "thinking"}`; `message_saved`; `[DONE]`). Nothing is re-shaped — the reasoning split rides
**inside** the payload (§3.4). `done:true` is the terminal sentinel (today's `data: [DONE]`); on it the
client stops the round and lets the settle reconcile run, exactly as chat.js does.

### 3.3 The splice — no gap, no dup (the exact hazard)

The one place a bug hides is where the **buffered prefix meets the live tail**. `agent_runs.subscribe`
already solves it and the socket must not break it:

1. **Register before replay.** The subscriber queue is added to `run.subscribers` *before* the replay
   loop reads `len(run.buffer)` (`agent_runs.py:186`) — so a live `_publish` during replay lands in the
   queue and is not lost.
2. **De-dup by seq.** The live drain yields an event only if `seq >= next_seq` (`agent_runs.py:205`), so
   an event that was both in the replayed prefix and the queue is emitted once. The socket adapter must
   preserve this — it does, because it delegates to the same generator.
3. **Race the sentinel.** On the end sentinel `(None, None)`, flush any `buffer[next_seq..len)` the
   sentinel raced (`agent_runs.py:201`) before closing. Preserved for free.
4. **Client-side `fromSeq` monotonicity.** The client tracks the highest `event.seq` it has rendered
   and, on reconnect, sends `fromSeq = highest + 1`. Because server seqs are the stable buffer indices,
   this is exactly "give me everything after what I have" — no gap (nothing skipped) and no dup (nothing
   re-rendered). The incremental renderer (ADR 0015) already reconciles by `{id, seq}`, so even a
   belt-and-suspenders overlap is a cheap no-op.

### 3.4 Reasoning split rides INSIDE the `event` payload (never a separate channel)

The `event.d` for a token delta is `{"delta": str, "thinking": bool}` — the **same** field the
`chat_stream` producer emits (`agent_loop.py:4820`). The client keeps its two per-round buffers exactly
as `chat.js` does: `roundReplyText` (deltas with `d.thinking` falsy) → rendered into the message body via
`processWithThinking`; `roundReasoningText` (`d.thinking` truthy) → the "Thinking" accordion. **Reasoning
is NEVER a distinct `ch`** — that would be a second public path and risk a leak. It is one flag inside one
chat channel, decoded client-side by construction (CLAUDE.md reasoning-scrub contract, ADR 0015).
Server-side scrub (`_scrub_active`, `agent_loop.py:4823`) still runs in the producer before the delta is
buffered — the socket carries the already-scrubbed visible text, identical to today.

### 3.5 Up-half: `turn` / `decision` (request/response, correlation-id)

The player's send and decision-card submit become up-frames. Both ride the **`chat` channel**
(`"ch":"chat"`, per §1.2 — every multiplexed frame carries `ch`): they are the up-half of the same
single-writer turn whose result is fanned out as `chat` `event` frames below, so there is one contract
— `turn`/`decision` are chat-channel frames, not socket-level ones.

```jsonc
// client → server
{ "t":"turn", "ch":"chat", "cid":"c_09", "d":{ "message":"I pull them aside", "clientMsgId":"tmp_5",
                                               "expectedBeatSeq":118, "attachments":[], "mode":"agent" } }
{ "t":"decision", "ch":"chat", "cid":"c_10", "d":{ "pendingId":"veto-ceremony", "choice":"use",
                                                   "target":"npc_3", "expectedBeatSeq":118 } }
```

The FE relay handler runs the **exact** existing pipeline: for `turn`, the `chat_stream` body path
(ownership guard → `build_chat_context` → `agent_runs.start(run_key, ..., queue=_framed)`,
`chat_routes.py:1823`); for `decision`, the existing `POST /api/orwell/decision` handler. The result is
**not** returned inline on the `cid` — it is fanned out as `event` frames on the `chat` channel (the run
is the single-writer broadcast) plus a `state` reconcile (§4). The `cid` reply is only a lightweight
`ack{cid, accepted:true}` (or an `error{cid}` for a pre-stream refusal — the SSE-error contract at
`chat_routes.py:87`, now an `error` frame instead of a 200+`event: error`). This preserves the
**queue-don't-cancel** game-turn policy (`queue=_framed`) and the casting single-flight guard
(`chat_routes.py:1807`) verbatim — those live in `agent_runs.start`, below the transport.

- `clientMsgId` round-trips the optimistic bubble id (ADR 0008, `chat_routes.py:715`) so the sender
  adopts its own bubble by canonical `{id, seq}` from the `message_saved` event.
- **`expectedBeatSeq` (0065) — MANDATORY on every mutating up-frame.** Both `turn` and `decision`
  MUST carry `expectedBeatSeq` set to the client's last-seen `beatSeq` (from the `ack`/`state` frames,
  §2.3/§4) as the 0065 compare-and-swap token. The server refuses a stale value **before any mutation**:
  the engine's typed `StaleBeatError` surfaces as an `error` frame `{cid, code:"stale-beat", d:{beatSeq}}`
  (the `cid` echoes the refused up-frame; equivalent to today's HTTP **409 `stale-beat`**), and the client
  reconciles via the existing desync path, then retries with the fresh `beatSeq`. The CAS lives in the
  relay/engine hop — the socket only carries the token — but an implementer who omits it from the frame
  loses the stale-beat guard entirely, so it is a required field, not an optional one. (An engine that
  advertises no `beatSeq` yet — pre-0065 sandbox — simply omits the CAS; where the `ack` returned a
  `beatSeq`, the up-frame MUST echo it.)

### 3.6 `has_run` and the terminal-but-buffered resume

A short turn often **finishes** before a peer's attach arrives. `agent_runs.has_run` (`agent_runs.py:83`)
is True for a run that is *terminal but still within the 180 s evict grace* — distinct from `is_active`
(running only). The socket `subscribe` handler uses **`has_run`**, not `is_active` (mirroring
`chat_resume`, `chat_routes.py:1875`): if a run exists, subscribe replays its buffer then ends — so a
peer that attaches just after settle still mirrors the whole turn. Gating on `is_active` would 404 the
very window that should mirror (the exact bug ADR 0012/`has_run` fixed). **The 180 s `_EVICT_GRACE_S`
window (`agent_runs.py:42`) is preserved unchanged** — a subscriber connect cancels the pending evict, a
last-disconnect re-arms it. Reconnecting within 180 s replays cleanly; past it, the run is gone and the
client does a normal history load (the same fallback as today).

---

## 4. Poll deletion → `state` / `hud` push

Three periodic/ad-hoc refreshers collapse into server push, keyed by `beatSeq` (0065):

| Deleted transport | file:line | Replaced by |
|---|---|---|
| g15 status poll, **20 s** | `orwellStatusPanel.js:19` | `state` frame |
| presence/whereabouts poll, **25 s** | `orwellPresence.js:29` | `hud` frame |
| `game-updated` push over events SSE | `orwell_game_session.py:78` | `state` frame (immediate) |

```jsonc
{ "t":"state", "ch":"state", "d":{ "beatSeq":119, "reason":"advance" } }   // "something changed, re-read"
{ "t":"hud",   "ch":"hud",   "d":{ "beatSeq":119, "kind":"whereabouts" } } // presence/location changed
```

**Payloads stay pings, not state bodies** — exactly like `session_events` today (ids/types only,
`session_events.py:9`). On a `state`/`hud` frame the client re-reads its own authoritative Vault-free
projection (`GET /api/orwell/status` etc.) — the same fetch the poll did, now edge-triggered instead of
timed. This keeps the Vault Wall trivially intact (no state body crosses the socket) and reuses every
existing HUD reconcile path. `beatSeq` lets the client skip a redundant re-read it already has.

**The `orwell:gamechanged` dispatcher is UNTOUCHED.** ADR 0017 §"state/hud" and CLAUDE.md are explicit:
the in-page `window.orwellGameChanged(reason)` (the single debounced dispatcher in `platform.js`) stays
as the **client-internal** fan-out to the HUD panels. The socket's job ends at delivering the *edge*; the
frame handler calls `window.orwellGameChanged('ws:state')` — one more caller of the one dispatcher, its
"exactly one dispatcher" invariant (`test_g15_gamechanged.py`) unbroken. We delete the **timers**, not
the dispatcher. (This is the same pattern `sessionSync.notifyGameUpdated` already uses on a
`game-updated` SSE event, `sessionSync.js:95`.)

Because the poll timers were the 20–30 s HUD lag, this alone makes gadget/presence state as fresh as the
chat — the ADR's headline win.

### 4.1 The `run-started` invitation edge (the cross-device attach trigger — do NOT drop it)

WS mode deletes `GET /api/chat/events/{id}` (§0 table, the persistent invitation bus), so it must carry
that bus's one load-bearing push: **`run-started`**. An **idle** peer (a second window/device that is not
currently streaming) has to learn a run began before it can `subscribe` to the `chat` run and mirror it —
without this edge, WS-mode cross-device live mirror (F4/F5) would only recover on a poll or reload. It
rides the **`state` channel** as a distinguished edge (the invitation class from the §0 table):

```jsonc
// server → client — a new run started on the socket's canonical session
{ "t":"state", "ch":"state", "d":{ "beatSeq":119, "reason":"run-started", "runKey":"sess_ab12" } }
```

- **Client action:** on `reason:"run-started"` for a run it is not already tailing, the idle peer issues
  `subscribe{ch:"chat", fromSeq:0}` (§3.1) and mirrors from the buffer — the same attach an SSE
  `run-started` triggers today. A peer that already holds a standing `chat` subscription needs no action
  (it is already registered and receives the run's `event` frames live — §3.3 register-before-replay).
- **`runId` (additive, #1087 — at-least-once edges need an identity):** the edge carries the run's
  stable id (`agent_runs.run_id`, resolved by the server at frame-build time). `session_events`'
  replay ring re-delivers a finished run's invitation to any fresh channel attach, and the client's
  "am I tailing?" boolean cannot recognize it (the run's `done` already cleared it) — so the client
  skips a `run-started` whose `runId` matches the run it already attached/rendered (recorded from the
  §3.1 subscribe `ack`). An id-less edge (evicted run) falls back to the boolean-only behavior.
- **Idempotent re-arm (#1087):** a `subscribe{ch:"state"|"hud"}` for a channel **already running for
  the same canonical id on the same socket** is a server-side NO-OP (edge subscribes have no success
  ack, so this is wire-identical) — a respawn would re-run `session_events.subscribe()` and replay the
  ring back at a window that already consumed it (the rebind→ring-replay churn loop). A genuinely new
  subscriber (fresh socket / first arm) still gets the §3.4b ring replay, and a canonical change
  respawns to re-point the bridge. The client mirrors this: `rebind()` re-arms the edges only on a
  canonical change (the same-id guard, `orwellWs.js`).
- **Source:** the FE bridges `session_events`' `run-started`/`message-added` (`session_events.py:92`) to
  this `state` edge, exactly as it bridges `game-updated` (§4). Payload stays a **ping** (ids only — the
  `runKey`/`runId`, no body), Vault Wall intact.
- **Not a new authority:** it is the socket form of the existing invitation push; the ring
  (`_RING_REPLAY_EVENTS`) stays for fallback mode (§10). Deterministic handshake attach (§10) covers a
  peer connecting *after* a run starts; this edge covers a peer already connected *when* it starts.

---

## 5. `layout` channel — per-device LWW (owner call 2026-07-09)

ADR 0017 supersedes 0064-F: layout is **per-device**, NOT synced cross-device. Only game state syncs.

The `layout` frame carries **two distinct tokens**: `deviceId` (stable per-device — the persist/fan-out
bucket) and `origin` (the per-tab id — self-echo suppression only). They are not interchangeable.

```jsonc
// client → server (a window moved/resized/docked)
{ "t":"layout", "ch":"layout", "d":{ "windowId":"hud-roster", "state":{ "x":40,"y":120,"w":320,"open":true },
                                     "deviceId":"dev_9x", "origin":"tab_3b" } }
// server → client (echo to THIS device's OTHER tabs only — not other devices)
{ "t":"layout", "ch":"layout", "d":{ "windowId":"hud-roster", "state":{...},
                                     "deviceId":"dev_9x", "origin":"tab_3b" } }
```

- **Persist scope is per-device — `deviceId` keys the bucket.** The existing `orwell_layout.patch_layout`
  store (`orwell_routes.py:1647`) is keyed **`(user, deviceId)`** in Phase 1 instead of `user` alone — a
  desktop and a phone keep independent geometry. `deviceId` is a stable per-device token (localStorage,
  survives reload; distinct from the per-tab id). The server **echoes the store's CANONICAL `deviceId`**
  (trimmed/normalized), never the raw client value, so a receiver's exact-id match cannot miss its own
  device's update.
- **`origin` is the per-tab token, used ONLY for self-echo suppression** — the originating tab drops the
  echo carrying its own `origin`; it never selects the persist bucket. The server fans out to the same
  `deviceId`'s other tabs and lets each drop the `origin` echo.
- **LWW within a device's own windows** — last write per `windowId` field wins, as today.
- **`origin` self-echo suppression** — the originating **tab** ignores its own echo by `origin`
  (`orwell_routes.py:1627` semantics), exactly as `sessionSync.dispatchLayoutChanged` +
  `orwell:layout-changed` filter today (`sessionSync.js:101`). The echo fans out only to the **same
  device's** other tabs.
- **The cross-device `layout-changed` fan-out is dropped for geometry.** Notice-dismissal (per-user)
  still syncs — carried on the `notice` channel, not `layout`.

`notice` channel (server → client): system banners / dismissal-sync.

```jsonc
{ "t":"notice", "ch":"notice", "d":{ "id":"n_4", "kind":"system", "text":"...", "dismissedSync":false } }
```

Dismissal-state still syncs per-user (LWW) — the one piece of "client-owned UI state" that remains
cross-device, per ADR 0017.

---

## 6. Permanent SSE/poll fallback (owner call — kept forever, not transitional)

A client that cannot upgrade to WS (restrictive proxy, corporate MITM, ancient browser) **falls back to
today's transports and must still pass F1–F5.** This is a permanent path (ADR 0017 rejected-alt
"Dropping the SSE/poll fallback").

**Negotiation.** On load the client attempts the WS upgrade with a short timeout (~3 s to first `ack`).
On success → WS mode: it does **not** open the SSE streams and **cancels** the 20/25 s poll timers. On
failure/close-without-ack → **fallback mode**: it runs the *unchanged* existing stack —
`POST /api/chat_stream` (SSE), `GET /api/chat/events/{id}`, `GET /api/chat/resume/{id}`, and the g15/
presence polls. Both paths hit the **same** server helpers (`agent_runs`, `session_events`,
`_resolve_canonical_session`), so behavior is identical; only the pipe differs.

**A mid-session WS→SSE downgrade must carry the resume cursor — do NOT replay from 0 or skip the tail.**
When a WS drops mid-turn, the client is holding the highest `chat`-channel `event.seq` it has already
rendered (§3.2). On the downgrade it reopens the SSE resume path
(`GET /api/chat/resume/{canonicalId}`) and hands that cursor forward as the buffer position to resume
from — i.e. it resumes at `fromSeq = highestRenderedSeq + 1`, the same "give me everything after what I
have" cursor the WS `subscribe{fromSeq}` uses (§3.1). Because the SSE `agent_runs.subscribe` replays the
run buffer from index 0, the client **discards** the already-rendered prefix up to that cursor and
mounts only the buffered tail + live continuation — the incremental renderer's `{id, seq}` reconcile
makes the overlap a cheap no-op — so nothing is double-rendered and nothing after the drop is skipped.
The client also carries its last-seen `beatSeq` (from `ack`/`state`) into the SSE path so the next
`turn`'s `expectedBeatSeq` CAS (0065) stays correct across the downgrade. A fresh `POST /api/chat_stream`
turn started after the downgrade is unaffected — it keys the run on the same `run_key` and the sender
adopts its own bubble by `clientMsgId`/`{id, seq}` exactly as today. The client retries WS on the next
load.

**Feature flag & rollout.** *(Superseded 2026-11-12, ORW-44: the flag and the SSE fallback are removed from the game build, which is WebSocket-only; see ADR 0017's amendment. The text below is the original Phase-1 plan.)* A server flag (`ORWELL_WS_TRANSPORT`, default **off** in Phase 1) gates
whether the client *attempts* the upgrade at all; when off, every client uses today's stack (zero-risk
default). Roll out: internal → opt-in cohort → default-on once the WS-specific tests + F5 harness are
green in CI for both modes. The SSE routes are **never removed** — they are the fallback.

**Both modes must pass F5.** The mirror-parity harness (§7) runs against WS mode AND fallback mode; a
client can be forced into fallback (flag off / upgrade blocked) and must still exhibit two-window
incremental-mirror parity. This is why the fallback is not allowed to bit-rot.

---

## 7. Testability (ADR 0017 §Testability → concrete cases)

Every case is a new test alongside the existing FE pytest / harness suites. **The F5 mirror-parity
harness (`mirror_live_parity.mjs`, checks `bStartsDuringAStream`, `bUsesIncrementalRenderer`,
`lagWithinBudget`) must pass BEFORE Phase 1 starts (Phase 0) AND after each Phase-1 change — in both WS
and fallback mode.**

| # | Case (ADR 0017 §Testability) | Concrete assertion |
|---|---|---|
| a | **Reconnect-resume splice** | Open socket, start a turn, drop the socket mid-stream at event seq N, reconnect with `subscribe{cid,fromSeq:N+1}`. **Assert the `ack{cid, d:{fromSeq,headSeq}}` arrives BEFORE any `event` frame on the channel** (no replay frame precedes its `ack`), then that the reassembled token stream == the single-connection stream: **no seq gap, no dup**, terminal `done:true` once. Exercises the ported `agent_runs` primitive (§3.1/§3.3). Run once with the run still **live** at reconnect and once **terminal-but-buffered** (`has_run` true, within 180 s) — both must replay fully (§3.6). |
| b | **Liveness handshake / subscribe-refuse** | `hello` for (i) a **dead** canonical id (row deleted) → `ack{live:false}`, **no channel subscribed**; the stored binding is unbound (`resolve_live_game_session` side effect). (ii) a **non-owned** session → `error{cid,forbidden}` + close, no bind. And a `subscribe` on a dead/non-owned/unbound channel → `error{cid, code}` with **ZERO `event` frames emitted** (the server streams nothing on refuse, §3.1). Proves the #1085/#1086 guard is socket-native and that both the bind handshake and the subscribe handshake refuse **before** any replay. |
| c | **Multiplex isolation** | Interleave `chat` `event` frames and `hud`/`layout` frames on one socket; assert the client router dispatches each strictly by `ch` — a `hud` frame never reaches the chat renderer, a `chat` delta never reaches the layout store. No cross-channel bleed. |
| d | **Layout LWW + echo-suppression** | Two tabs on **one device** + one tab on a **second device**. Move a window in tab A: tab B (same device) applies it; the second device does **NOT** (per-device scope); tab A ignores its own `origin` echo. Two rapid conflicting moves → last write wins per field. |
| e | **Fallback parity** | Force the client into fallback (flag off / simulated upgrade failure). Assert it runs the SSE/poll stack unchanged **and passes the F5 mirror-parity harness** (two-window incremental mirror). |
| f | **beatSeq CAS over the socket** | A `turn` with a stale `expectedBeatSeq` → `error{cid, code:"stale-beat", d:{beatSeq}}` (the `cid` echoes the `turn` so the client rejects the right promise), no write; client reconciles and retries. Mirrors the HTTP 409 `stale-beat` contract (0065). |

**Boundaries unchanged & still green** (ADR 0017): dependency-cruiser Vault-edge test + Vault sentinels
(no new reader — the socket carries only the projections the SSE/poll surfaces already carry);
cross-user isolation (0021); the full `frontend/` pytest suite; the ADR 0008 `seq`/reconcile contract.

---

## 8. Invariants preserved (checklist → how)

| Invariant | Upheld by |
|---|---|
| **Vault Wall (mandate #2)** | The socket carries only the Vault-free projections the SSE/poll surfaces carry today. `state`/`hud` are **pings** (ids + `beatSeq`), never state bodies — the client re-reads its own projection endpoint (§4). No new reader of `VaultStore`; dependency-cruiser + Vault sentinels stay green (§7). |
| **Cross-user isolation (0021)** | One socket ↔ one user's canonical session. Every `hello`/`bind`/`subscribe` is owner-guarded (`_verify_session_owner`, `chat_routes.py:1856`). Never multiplex across users; a non-owned `hello` → `error{forbidden}` + close (§2.4). |
| **Reasoning-scrub split (ADR 0015 / CLAUDE.md)** | Reasoning is a `d.thinking` flag **inside** the `chat` channel, never a separate `ch` (§3.4). Client keeps the `roundReplyText`/`roundReasoningText` split verbatim; server-side `_scrub_active` still runs in the producer before buffering. Reasoning cannot reach the public bubble by construction. |
| **One incremental renderer (ADR 0015 / R2)** | The socket changes only *how bytes arrive*; the observer still mounts the single incremental renderer and reconciles by `{id, seq}`. The F5 harness `bUsesIncrementalRenderer` gates before and after (§7). |
| **One `orwell:gamechanged` dispatcher (g15)** | The socket deletes the poll **timers**, not the dispatcher. A `state`/`hud` frame calls `window.orwellGameChanged('ws:state')` — one more caller of the one debounced dispatcher; `test_g15_gamechanged.py` stays green (§4). |
| **Single-writer-per-turn broadcast (ADR 0012 / 0064-C)** | `turn` up-frames route to `agent_runs.start(run_key, ..., queue=_framed)` unchanged — queue-don't-cancel for game turns, casting single-flight guard, both below the transport (§3.5). |
| **Turn-driven ruling (originally `ORWELL_WATCHER_TICK_MS=0`; the watcher was deleted 2026-07-10, turn-driven is the only mode)** | No engine push. Hop 2 stays request/response. An open socket is **not** a presence/activity signal (ADR 0017 §Engine hop) — the socket carries bytes, never licenses the engine to originate beats. That is Phase 3 / a separate living-house ADR, out of scope here. |

---

## 9. Implementation order (build-ready sequence)

1. **Phase 0 gate first.** `run_mirror_gate.sh` is **green** on `main` and wired as a required CI gate
   (`mirror-parity`, blocking via `ci-gate`) — the race was fixed in #1276. Confirm it is still green before
   starting, and keep it green through every step below. (ADR 0017 §Phasing.)
2. **WS route + handshake** (§1–2). `@app.websocket("/api/ws/session")`, owner guard, `hello`→`ack`
   calling the *existing* `_resolve_canonical_session` / `resolve_live_game_session` / `bind_game_session`
   helpers. Add test (b).
3. **`chat` channel over `agent_runs`** (§3) — preferred: add `from_seq=0` to `agent_runs.subscribe`;
   socket adapter wraps its yields as `event` frames; `has_run`-gated. `turn`/`decision` up-frames route
   to the unchanged `agent_runs.start` / decision handler. Add tests (a), (f). **This is the highest-risk
   step — land it with the splice test green before anything else.**
4. **`state`/`hud` push + poll deletion** (§4). Bridge `session_events` (`game-updated`, presence/status
   change) to `state`/`hud` frames; cancel the 20/25 s timers in WS mode; frame handler calls the one
   `orwellGameChanged` dispatcher. Add test (c).
5. **`layout`/`notice`** (§5). Re-key `orwell_layout` per `(user, deviceId)`; per-device LWW; `origin`
   echo-suppression; drop cross-device geometry fan-out (keep notice-dismissal sync). Add test (d).
6. **Fallback negotiation + flag** (§6). `ORWELL_WS_TRANSPORT` (default ON since 2026-07-10, #1357); upgrade-with-timeout →
   WS-or-SSE; run the F5 harness in both modes. Add test (e).
7. **Flip the flag** once every WS-specific test + the F5 harness are green in CI for both modes.

---

## 10. Risks / seams that complicate the port (be honest)

- **The splice is the whole ballgame (§3.3).** `agent_runs.subscribe`'s "register-before-replay +
  de-dup-by-seq + flush-the-raced-tail" is subtle and already load-bearing under SSE. The **safe** port is
  to reuse the generator verbatim (add only `from_seq`) and let the socket be a dumb frame-wrapper — do
  **not** re-implement replay logic in the WS handler. Test (a) with both live and terminal-but-buffered
  runs is the gate.
- **`fromSeq` seq identity.** The client's `event.seq` must be the *buffer index* the server de-dups on,
  not a client-invented counter — otherwise a reconnect's `fromSeq` misaligns and drops or dups a token.
  Bind the frame `seq` to `_Run.buffer`'s index (`agent_runs.py:47`) exactly.
- **Casting stays per-tab (GAP-2-b1).** The handshake must NOT converge a **casting** socket onto a
  canonical id (`chat_helpers.py:4131`) — doing so re-introduces the #1086 reply-strip. The server keeps
  casting per-tab by deciding the casting-vs-live-game branch from its **own authenticated state** (no
  started season ⇒ per-tab), never from anything the client sent — the `hello` carries no
  `framed`/`gameActive` flag to trust (§2.1/§2.2).
- **`session_events` ring vs. socket replay.** The invitation ring
  (`_RING_REPLAY_EVENTS`, `session_events.py:92`) exists because a late SSE subscriber could miss a
  `run-started`. On the socket, the handshake + `subscribe{fromSeq}` make attach deterministic, so the ring
  is a **fallback-mode** concern only; do not delete it (fallback still uses it). Keep the two paths' behavior
  aligned by driving both from the same `agent_runs`/`session_events` state.
- **Per-device layout key migration.** Re-keying `orwell_layout` from `user` to `(user, deviceId)` is a
  storage-shape change; ship it read-compatible (a legacy `user`-only record seeds a new device's layout on
  first read) so existing users don't lose their arrangement.
- **Reverse-proxy upgrade (ADR 0017 open #5).** Verify the deploy's proxy/tunnel forwards the WS upgrade
  **before** flipping the flag; where it doesn't, the fallback (§6) is the answer, not a WS fix.
