# Front-end API contract (the `/play` React app)

Status: POC/MVP, 2026-11-06. Owner: front-end lane. Change by PR only; the back-end lane may not change a
shape listed here without updating this file in the same PR.

The new front end (`frontend/web/`, served at `/play`) uses only the endpoints below. Everything is
same-origin and rides the existing session cookie (`credentials: 'same-origin'`). No new server
behaviour is required for the POC or MVP. Gaps are listed at the end.

## 1. Auth

| | |
|---|---|
| Page | `GET /play` is behind the normal auth middleware. No cookie: `302 /login` (same as `/`). |
| API | any `/api/*` 401 flips the store to `auth = 'loggedOut'` and the app shows a "Sign in" screen (link to `/login`). The game is saved server-side; nothing is lost. |

## 2. REST reads

| Endpoint | Used for | Shape the app reads |
|---|---|---|
| `GET /api/orwell/game-session` | canonical game chat id (ADR 0008/0012) | `{ sessionId: string \| null }`. `null` shows "No game in progress" with a link to the classic UI. The app never creates or binds a session. |
| `GET /api/history/{sessionId}` | the transcript, and every reconcile | `{ history: [{ role, content, metadata }] }`. `metadata` fields used: `_db_id`, `_seq`, `client_msg_id`, `game_moment`, `thinking`. Only `user` and `assistant` rows render. Housekeeping user prompts (`Continue where you left off`, `(Production cue...`, etc.) are skipped, same list as `isSkippableUserPrompt`. Empty assistant rows never render. Order is by `_seq`. |
| `GET /api/orwell/state` | the single shared poll: week, phase, `timeOfDay`, `dayNumber`, `ceremony` (hoh, nominees, veto), `whereabouts` (room and who is in it), `pending`, `house`, `beatSeq` | `GameState` in `frontend/web/src/api/types.ts`. Missing fields simply hide their chip. |
| `GET /api/orwell/roster` | names for the bold-name speaker fallback; fetched once, then only when the cast signature (`id:status` of `house`) changes | `{ roster: [{ id, name, status, isPlayer, portrait }] }` |
| `GET /api/chat/stream_status/{sessionId}` | on load: is a run still going? | `{ status: 'streaming' \| 'idle' }` |

## 3. Sending a turn (SSE, same as the classic client)

`POST /api/chat_stream`, `multipart/form-data`:

| field | value |
|---|---|
| `message` | the player's text |
| `session` | the canonical game session id. A send is bound to the session it was written for. |
| `client_msg_id` | `c-<uuid>`, minted once per message and reused on any re-send. The server dedups on it. |
| `mode` | `agent` |

Headers: `X-Tz-Offset` (minutes east of UTC), `X-Tz-Name` (IANA zone).
Response: `text/event-stream`. Each `data:` line is JSON, or `[DONE]`. `event: error` marks the next payload as an error.

Payloads the app handles (everything else is ignored):

| payload | action |
|---|---|
| `{type:'run-started', runId}` | remember the run id; not counted for the resume cursor |
| `{type:'user_message', id, seq, clientMsgId}` | adopt the optimistic user row: set its server id and seq, state `sent` |
| `{delta, thinking?}` | `thinking` falsy: public reply buffer. `thinking` truthy: reasoning buffer. **Never mixed.** |
| `{type:'tool_start' \| 'agent_step' \| 'status'}` | show the quiet "Working" label until the next reply text |
| `{type:'orwell_pending', pending}` | set the pending decision (the card appears now, not at the next poll) |
| `{type:'message_saved', id, ts, moment}` | the assistant row's server id and in-world moment |
| `{type:'canonical_session', id}`, `orwell_narrator`, `metrics`, `model_*`, `doc_*`, `research_*`, `web_sources` | ignored by the POC |
| `[DONE]` | flush the last frame, convert the live text into a stored row, then reconcile from history |
| error payload / `status >= 400` | turn marked failed |

Invariants kept from `CLAUDE.md` "Front-end client conventions":

* **Reasoning never reaches the public bubble.** Two buffers exist from the first byte: the bubble renders only the reply buffer; reasoning has its own "Production notes" box, which is OFF in the game build (shown only behind the classic admin escape hatch `data-show-thinking` on `<body>`; engine ids removed). The live buffer goes through a streaming guard (a port of the classic state machine in `chat.js`): while a `<think>` is unclosed, or a plain "Thinking Process:" preamble has no reply after it, nothing of it is rendered (only text before the opener), and a partial opener such as `<thi` is held back, so nothing shown is ever taken back. Text-level leaks are handled by the classic wall itself: `/play` imports `frontend/static/js/markdown.js` (build alias `@classic`, `ui.js` stubbed) with `<body data-game-build>`, and runs it on the WHOLE reply (inline and unclosed `<think>`, plain reasoning preambles, raw ids, machinery and real-world-denial scrubs, restated-reply collapse, OOC asides, speaker chips) before the result is split into top-level blocks.
* **Send outbox.** A send is written to `sessionStorage` (per tab) before the POST and removed only when a server row with its `clientMsgId` is observed, or when the server refuses it with a 4xx other than 401/403/409 (then the bubble is taken back and the text is restored to the composer). 401/403/409 keep it in the outbox; a 401 also switches to the sign-in screen. An outbox item drains only into its own session. On load the app (1) reads history, (2) drops outbox items the server already has, (3) if `stream_status` says a run is going, re-attaches with `GET /api/chat/resume/{id}?from_seq=0`, else (4) re-sends the remaining items with the same `client_msg_id`.
* **Canonical binding.** The app reads the session id from `GET /api/orwell/game-session` on every load and sends only to it. It never selects, creates, or deletes sessions.
* **Mirror rule (F5, ADR 0012).** Single window in the MVP. The app opens no `/api/chat/events/*` or WebSocket, dispatches no `orwell:*` window events and listens for none, and writes nothing the classic UI reads, so the classic two-window mirror is unaffected. Both UIs can be open on the same game.

Resume: `GET /api/chat/resume/{sessionId}?from_seq=N` streams the same payloads, replayed from event `N`. `404` means no buffered run.
Stop: `POST /api/chat/stop/{sessionId}`.

## 4. Decision cards

The card is driven entirely by `pending` (from `/api/orwell/state` or an `orwell_pending` stream event).

`POST /api/orwell/decision`, JSON, `idempotency_key` = `dec:<kind>|<option ids>|<prompt>` (stable per card, so a retry or double tap is a replay):

| `pending.kind` | options come from | body |
|---|---|---|
| `nominations` | `options[]`, pick 2 | `{kind, choice:[id,id]}` |
| `veto-decision` | `options[]` plus "Don't use" | `{kind, use:false}` or `{kind, use:true, save:id}` |
| `secret-veto` | fixed | `{kind, use:bool}` |
| `eviction-vote`, `final-eviction`, `tie-break`, `juror-vote`, `houseguests-choice`, `deal-offer` | `options[]` | `{kind, vote:id}` |
| `replacement` | `options[]` | `{kind, replacement:id}` |
| `comp-intent`, `comp-round` | fixed `compete`, `throw`, `play-safe` | `{kind, intent}` |
| `goodbye-message`, `exit-interview`, `finale-interview` | `options[]` (tones or stances) plus optional text | `{kind, vote:id, statement}` |
| `finale-statement`, `juror-question` | free text only | `{kind, statement}` |
| `finale-answer` | `appeals[]` | `{kind, appeal}` |
| `spectator-choice` | `options[]` | `{kind, vote:id}` |
| `self-evict` | confirm | `{kind, confirmed:true}` |

A 409 (the board moved) refreshes the shared state and re-arms the card from the engine's current `pending`. A kind not in the table shows its prompt and options but cannot confirm (the same as the classic card, whose `buildPayload` returns null for it); the player dismisses it and decides in conversation. Never a guessed payload.

## 5. Static serving

| Path | Response | Cache |
|---|---|---|
| `GET /play`, `GET /play/` | `frontend/web/dist/index.html`; `503` page with a classic-UI link if not built | `no-cache` |
| `GET /play/assets/{hashed}` | file from `dist/assets/`, gzip when accepted, containment-checked | `public, max-age=31536000, immutable` |

Defined in `frontend/routes/play_routes.py`; no other route changes. Rollback: remove the include in `app.py`.

## 6. Live updates (design for the next iteration; the MVP uses one shared poll)

Today every HUD panel polls (20 to 30 s), and the server pushes only a "something changed" ping (ORW-167, the
WS `state`/`hud` frames of `websocket-phase1-protocol.md` section 4). The ping forces each client to re-read
several endpoints. Proposal: **versioned state deltas keyed on the engine's `beatSeq`**, over the existing
WebSocket (SSE fallback uses the same payloads).

### 6.1 Frame

```jsonc
{ "t":"delta", "ch":"state", "d":{
    "from": 118,            // beatSeq the delta applies on top of
    "to":   119,            // beatSeq after applying it (monotonic, contiguous per user)
    "ops": [                // ordered, idempotent, last-write-wins per path
      { "path": "status",      "set": { "phase": "veto", "timeOfDay": "evening", "dayNumber": 9 } },
      { "path": "ceremony",    "set": { "hoh": {"id":"npc:4","name":"Cassandra Stout"}, "nominees": [] } },
      { "path": "whereabouts", "set": { "room": "kitchen", "present": [ {"id":"npc:7","name":"Regina Barber"} ] } },
      { "path": "roster.npc:7","set": { "status": "evicted" } },
      { "path": "pending",     "set": null },
      { "path": "season",      "set": { "number": 1, "week": 3 } }
    ] } }
```

Rules:

* Paths are the store slices (section 7): `status`, `ceremony`, `whereabouts`, `roster.<id>`, `pending`, `season`. A `set` replaces that slice or merges the listed fields; `null` clears. Ops are idempotent, so a replayed delta is harmless.
* Only the Vault-free public projection ever appears in a delta, the same fields `/api/orwell/state|status|whereabouts|roster` return today. No hidden state, no bios.
* The server computes a delta by diffing its last-sent projection per user against the new projection when `beatSeq` advances (it already tracks `beatSeq` and publishes `game-updated`; this replaces the ping body). Chat text is **not** in a delta: chat has its own `chat` channel with `seq`.

### 6.2 Client apply

```
on delta d:
  if d.to <= store.beatSeq            -> ignore (duplicate or old)
  if d.from == store.beatSeq          -> apply ops, store.beatSeq = d.to
  else (gap: d.from > store.beatSeq)  -> resync (6.3)
```

The poller from the MVP becomes the **resync path only**: it stays, at a slow cadence (60 s, with backoff), as a safety net.

### 6.3 Resync after a missed delta

1. Client sends `{ "t":"resync", "ch":"state", "d":{ "have": <store.beatSeq> } }` (SSE: `GET /api/orwell/state` as today).
2. Server replies with either the missed deltas still in its short ring (last ~64 per user), or one `{ "t":"snapshot", "d":{ "beatSeq": N, "state": <full projection> } }` if `have` is older than the ring.
3. Client replaces the whole game slice from the snapshot, sets `beatSeq = N`.

Same recovery is used after a socket reconnect, a tab returning from background, and a 401/502 recovery. A decision POST returns the new `beatSeq`, so the client can tell whether its own delta arrived.

### 6.4 Rollout

Phase A: server emits deltas next to the existing pings (additive). Phase B: `/play` consumes them and drops its timer to the 60 s safety net. Phase C: delete the classic panels' pollers as they are replaced. Contract test: replaying any recorded delta sequence on top of a snapshot yields the same state as `GET /api/orwell/state` at the final `beatSeq`.

## 7. Store model (one Zustand store, `frontend/web/src/store/gameStore.ts`)

| Slice | Contents | Written by (the only writer) |
|---|---|---|
| `auth` | `unknown \| ok \| loggedOut` | bootstrap; the 401 handler |
| `boot`, `bootError`, `sessionId` | load state, the canonical session id | bootstrap |
| `rows` | `ChatRow[]`: settled transcript. `text` is public only; `reasoning` separate | bootstrap (history), send (optimistic row, adopt, fail), stream commit, history reconcile |
| `stream` | the live reply: `{clientMsgId, reply, reasoning, working}` | the stream controller only, once per animation frame |
| `game` | `GameState` (status: week, phase, timeOfDay, dayNumber; ceremony; whereabouts; house; `beatSeq`) | the shared poller (later: delta applier) |
| `roster` | `RosterEntry[]` | the shared poller, only when the cast signature changes |
| `pending` | the open decision or `null` | the shared poller; the stream's `orwell_pending`; cleared by the next state read after a decision |
| `season` | (not in the MVP) season number and progress | the delta applier |
| `pollHealthy` | drives the "Reconnecting..." chip | the shared poller |

Rules: components only read via selectors; no component fetches; writers are the four modules above; the stream
controller never touches `game`, and the poller never touches `rows` or `stream`. The renderer accepts whole
paragraphs (`StreamController.appendReply`) through the same per-frame batcher, so the showrunner's checked
paragraphs can be delivered later with the rule that **nothing already shown is ever rewritten**: the transcript
only appends, and reconcile adds server rows, it never edits text that has been displayed.

## 8. Gaps (use what exists; noted for the owning lane)

1. No state-delta endpoint (section 6). The MVP polls `/api/orwell/state` (one request) every 20 s, with backoff and a pause when hidden.
2. `/api/orwell/state` is the only single-request read of status plus room plus pending, but it also carries biographies for the whole cast. A lean `/api/orwell/hud` read (the fields in section 6.1) would cut the payload.
3. `timeOfDay` and `dayNumber` are absent when the engine's time-of-day feature is off; the status bar then shows week and phase only.
4. Portraits: `roster[].portrait` is a reference, not a URL the POC resolves; chips use initials until a portrait URL contract exists.
5. `/api/history/{id}` is unpaginated (planned in the rebuild plan); the POC loads it whole.
6. The deploy scripts do not build `frontend/web`. Until `npm ci && npm run build` is added to the install/update step, `/play` answers 503 with a link to the classic UI.
