// ============================================================================
// orwellWs.js — WebSocket Phase-1 CLIENT transport (ADR 0017 / docs/design/
// websocket-phase1-protocol.md).  Browser ↔ FE, Hop 1 only.
// ============================================================================
//
// ONE multiplexed socket per tab for the ONE canonical session it resolves to.
// This module owns the WIRE: the hello/bind/ack handshake (§2), the `chat`
// replay-then-tail `subscribe{fromSeq}` (§3), the `state`/`hud`/`layout`/`notice`
// down-frames (§4/§5), the `turn`/`decision` up-frames (§3.5), the heartbeat
// pong, reconnect with a gap cursor, and — critically — the PERMANENT SSE/poll
// FALLBACK negotiation gated by the `ORWELL_WS_TRANSPORT` flag (§6).
//
// It does NOT render anything and it does NOT decide game state.  It is a dumb,
// fail-soft frame pipe:
//   • incoming `event` frames on `chat`      → handed to chat.js (the reasoning
//     split + the ONE incremental renderer live there — §3.4, ADR 0015);
//   • incoming `state`/`hud` frames          → handed to platform.js, which is
//     the ONE caller of `window.orwellGameChanged('ws:state')` (§4, g15);
//   • incoming `layout`/`notice` frames      → handed to the layout/notice code.
// Strict `ch` routing (a `hud` frame NEVER reaches the chat buffers, a `chat`
// delta NEVER reaches the layout store) is the whole point of the multiplex —
// see test_ws_multiplex_isolation.py.
//
// Written as a plain IIFE (no import/export) so it is (a) executable as a
// side-effect ES module — `import './orwellWs.js'` runs it — and (b) evaluable
// directly in a Node harness with stubbed globals for the behavioral tests
// (the same shape sessionSync.js uses).
//
// FAIL-SOFT IS LAW.  Any error, any blocked upgrade, the flag off, or the
// non-game build ⇒ we stay/enter fallback mode and the EXISTING SSE + poll
// stack (sessionSync.js, orwellStatusPanel.js, orwellPresence.js) carries the
// game unchanged.  The socket is an optimization, never a dependency.
(function () {
  "use strict";

  if (typeof window === "undefined") return;
  if (window.OrwellWs) return; // idempotent — never double-install

  // ── config / feature flag (§6) ──────────────────────────────────────────
  var API_BASE = window.API_BASE || "";
  var PROTOCOL = 1;
  var HELLO_TIMEOUT_MS = 3000;   // ~3s to first `ack` (§6 negotiation)
  var RECONNECT_BASE_MS = 500;
  var RECONNECT_MAX_MS = 15000;
  var RECONNECT_GIVEUP = 6;      // consecutive failed reconnects → permanent fallback
  // Fallback→WS RECOVERY backoff (the turn-on gate — see `_maybeUpgradeFromFallback`). A window that
  // booted before the game was live sits in fallback; it re-attempts the WS upgrade on
  // `orwell:gamechanged`, spaced by a growing backoff so a genuinely-blocked upgrade never storms.
  var UPGRADE_BACKOFF_MIN_MS = 8000;
  var UPGRADE_BACKOFF_MAX_MS = 60000;
  // Per-tab-id READINESS gate (the hello REQUIRES a non-null `perTabId`). The tab's chat-session id is
  // resolved ASYNCHRONOUSLY at boot (the session bootstrap / `selectSession`), so `_perTabId()` is null
  // for the first few hundred ms after DOMContentLoaded. If we hello with that null, the server refuses
  // it `bad-request` and we lock into a PERMANENT (handshake-cause) fallback that never recovers — the
  // exact turn-on blocker. So we DEFER the connect until the id lands (poll below), bounded so a
  // game-build page that never establishes a session (an idle welcome screen) doesn't poll forever.
  var PERTAB_POLL_MS = 200;
  var PERTAB_WAIT_MAX_MS = 30000;

  // `ORWELL_WS_TRANSPORT` (default ON since 2026-07-10 (#1357, §6)). The
  // server injects it; we read it defensively from either a global or a body
  // data-attribute. Absent ⇒ the client still attempts the upgrade.
  function _flagOn() {
    try {
      if (window.ORWELL_WS_TRANSPORT === true || window.ORWELL_WS_TRANSPORT === 1 ||
          window.ORWELL_WS_TRANSPORT === "1" || window.ORWELL_WS_TRANSPORT === "true") return true;
      var b = window.document && window.document.body;
      if (b && b.dataset && (b.dataset.wsTransport === "1" || b.dataset.wsTransport === "true")) return true;
    } catch (_) {}
    return false;
  }

  // The transport is a GAME-build concern (the mirror/HUD it ports live only
  // there). The full workspace build never attempts it.
  function _gameBuild() {
    try {
      var b = window.document && window.document.body;
      return !!(b && b.dataset && b.dataset.gameBuild === "1");
    } catch (_) { return false; }
  }

  // The tab's own chat-session id — the id this tab would POST under today
  // (§2.1 `perTabId`). It is only an INPUT to the server's bind target; the
  // server DERIVES the resolution branch itself (§2.2), never from us.
  function _perTabId() {
    try {
      var sm = window.sessionModule;
      return (sm && sm.getCurrentSessionId && sm.getCurrentSessionId()) || null;
    } catch (_) { return null; }
  }

  function _wsUrl() {
    var loc = window.location;
    var scheme = (loc && loc.protocol === "https:") ? "wss:" : "ws:";
    var host = (loc && loc.host) || "";
    // API_BASE may be an absolute http(s) origin in some embeds; normalize it.
    if (/^https?:\/\//i.test(API_BASE)) {
      return API_BASE.replace(/^http/i, "ws").replace(/\/$/, "") + "/api/ws/session";
    }
    return scheme + "//" + host + "/api/ws/session";
  }

  // ── state ───────────────────────────────────────────────────────────────
  var _mode = "idle";            // idle | negotiating | ws | fallback
  var _sock = null;
  var _cid = 0;
  var _pending = {};             // cid → { resolve, reject, t }
  var _canonicalId = null;
  var _live = false;
  var _beatSeq = 0;              // last-seen engine beatSeq (0065)
  var _highestChatSeq = -1;      // highest `chat` event.seq rendered (reconnect cursor)
  var _chatSubscribed = false;
  var _chatTailActive = false;   // are we tailing a LIVE chat run right now? (§4.1 re-attach guard)
  // ORW-217: was a LIVE chat run being tailed when the socket last dropped? `onclose` clears `_chatTailActive`, so the reconnect cannot read it; this remembers it until the
  // reconnect's chat subscribe has been acknowledged. `hasRun:false` on an IDLE reconnect is the normal idle state and must NOT be reported as a vanished run.
  var _runInFlightAtDrop = false;
  // ORW-217 (review): `_liveRunKnown` = we have POSITIVE evidence a run is live: the chat subscribe ack said `hasRun` (not false), or a `run-started` edge mounted the new run's holder.
  // Unlike `_chatTailActive` (set when the subscribe is merely SENT, and the re-attach guard) it is NOT set pre-ack, so a drop between "subscribe sent" and "ack" is not misread as a vanished run.
  // Cleared by the run's `done`, a `hasRun:false` ack, and the drop itself (after being remembered in `_runInFlightAtDrop`).
  var _liveRunKnown = false;
  // CodeRabbit fix (2026-07-17): a monotonic generation stamped on each `_onRunStarted` re-attach's
  // OWN `_subscribeChat(0)` call. `_chatTailActive` is a single shared boolean — a STALE reattach A's
  // `hasRun:false` ack can resolve AFTER a genuinely new run B has superseded it (B's own re-attach,
  // or B's own `done` clearing the flag), so by the time A's ack lands `_chatTailActive` no longer
  // reflects what A itself observed. Bumped once per `_onRunStarted` re-attach; each ack callback
  // captures its OWN generation at subscribe-time and compares against the CURRENT value before
  // acting — a superseded ack (an older generation) is always a no-op, regardless of what
  // `_chatTailActive` currently reads.
  var _chatReattachGen = 0;
  // #1087 reconcile-by-id: the id of the run this socket is attached to (or last fully rendered).
  // `session_events` is at-least-once — its replay ring re-delivers a FINISHED run's `run-started`
  // edge (≤8 events, 180s retention) to any fresh state-channel subscribe. The `_chatTailActive`
  // boolean alone can't tell a STALE replayed edge from a genuinely new run (the finished run's
  // `done` already cleared it), so each `run-started` carries the run's id and we skip edges for a
  // run we already attached/rendered. Learned from the chat subscribe `ack` (authoritative) and
  // provisionally at `_onRunStarted` attach-time (so a same-id replay BURST is inert even before
  // the ack lands). Never cleared by `done` — remembering the finished run is the whole point.
  var _lastRunId = null;
  // #1087 queued-run attach: the id of a run that QUEUED behind the run we're currently tailing.
  // ws_routes publishes a queued turn's `run-started` edge IMMEDIATELY (right after
  // `agent_runs.start(queue=True)`), stamped with the queued run's id (the registry's current run) —
  // but that run does NOT stream until the active run drains, and NO second edge follows. We can't
  // attach mid-tail (that would tear down the active run's tail), so we REMEMBER the queued run's id
  // here and attach after the active run's `done`. Without this the only invitation is dropped and a
  // peer window silently misses the queued turn entirely. Cleared once drained and on any transport
  // reset (the replay ring re-delivers the edge, so nothing durable is lost).
  // #1087 same-id rebind guard: are the state/hud edge channels armed on THIS socket? A rebind
  // re-arms them only on a genuine canonical change (mirrors the chat-subscribe guard) — a same-id
  // re-arm would respawn the server's session_events bridge and replay its event ring back into
  // `orwell:gamechanged` (the rebind→ring-replay churn loop).
  var _edgesSubscribed = false;
  var _fallbackReason = null;    // WHY we fell back — only "pregame-not-live" is recoverable (see _goFallback)
  var _helloTimer = null;
  var _reconnectFails = 0;
  var _reconnectTimer = null;
  // ORW-308 (phone play): has THIS page load ever had a live (acked) socket? Once it has, a failed reconnect is "the network is away" (screen asleep, an app switch, a wifi/cell
  // handoff, a tunnel) and never a "this network cannot carry WebSockets" verdict, so it retries forever instead of dropping to the permanent fallback (which, in the WS-only game
  // build, is a dead game until a reload).
  var _everLive = false;
  var PROBE_TIMEOUT_MS = 4000;   // ORW-308: how long a wake-up liveness ping may go unanswered before the socket is declared a zombie
  var _probeTimer = null;
  var _beatAtDrop = -1;           // ORW-308: the last beatSeq we held when a live socket died (-1 = unknown); a reconnect whose beat differs missed something
  var _connectStartedAt = 0;      // ORW-308: when the current connect attempt began (a wake-up replaces only an attempt that has had its chance)
  var _closingForGood = false;
  var _lastUpgradeAttempt = 0;                    // ms of the last fallback→WS upgrade attempt
  var _upgradeBackoffMs = UPGRADE_BACKOFF_MIN_MS; // grows per failed upgrade, caps at MAX; reset on activate
  var _pertabTimer = null;                        // the deferred-connect poll while `_perTabId()` is null
  var _pertabWaitStart = 0;                       // ms the current defer-for-perTabId wait began

  // per-channel handler registries — strict `ch` routing (§ multiplex).
  var _handlers = { chat: [], state: [], hud: [], layout: [], notice: [] };

  function _nextCid() { _cid += 1; return "c_" + _cid.toString(36); }

  function _now() { return (typeof Date !== "undefined" && Date.now) ? Date.now() : +new Date(); }

  function _emitWindow(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); } catch (_) {}
  }

  // ── public: handler registration ────────────────────────────────────────
  function onFrame(ch, fn) {
    if (!_handlers[ch] || typeof fn !== "function") return;
    if (_handlers[ch].indexOf(fn) === -1) _handlers[ch].push(fn);
  }
  function offFrame(ch, fn) {
    if (!_handlers[ch]) return;
    var i = _handlers[ch].indexOf(fn);
    if (i !== -1) _handlers[ch].splice(i, 1);
  }
  function _emit(ch, frame) {
    var list = _handlers[ch];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](frame); } catch (_) { /* one bad handler never wedges the pipe */ }
    }
  }

  // ── the frame router — dispatch STRICTLY by `ch` (the multiplex wall) ────
  // Exposed as `_handleFrame` so a test can feed an interleaved frame sequence
  // straight in (case c) without a live socket.
  function _handleFrame(frame) {
    if (!frame || typeof frame !== "object") return;
    switch (frame.t) {
      case "ping":
        _send({ t: "pong" });
        return;
      case "pong":
        return;
      case "ack":
        _onAck(frame);
        return;
      case "error":
        _onError(frame);
        return;
      case "event":
        // `event` frames are the ONLY frames that carry `ch`-scoped stream data.
        // Route by `ch`; a non-`chat` frame can never reach the chat buffers.
        if (frame.ch === "chat") {
          if (typeof frame.seq === "number" && frame.seq > _highestChatSeq) _highestChatSeq = frame.seq;
          // A terminal `done` ends this run's tail — a LATER `run-started` edge must re-attach for the
          // NEXT run (a standing subscribe does NOT span runs; each run is a fresh per-run buffer).
          // `_lastRunId` is deliberately KEPT: it is what lets a stale replayed `run-started` for
          // this now-finished run be ignored (#1087).
          var _chatDone = !!(frame.d && frame.d.done);
          if (_chatDone) { _chatTailActive = false; _liveRunKnown = false; }
          _emit("chat", frame);
        } else if (_handlers[frame.ch]) {
          _emit(frame.ch, frame);
        }
        return;
      case "state":
        if (frame.d && typeof frame.d.beatSeq === "number") _noteBeat(frame.d.beatSeq);
        // §4.1 — the `run-started` invitation edge: a NEW run began on our canonical. A standing chat
        // subscription does NOT tail across runs (agent_runs' `subscribe()` returns when its run ends,
        // and each run is a fresh per-run buffer), so we must RE-ATTACH the chat channel to mirror the
        // new run — the sender's own reply AND a peer's turn both ride this. Skipped while we're already
        // tailing a live run (§4.1 "a run it is not already tailing"). The frame's `runId` (when the
        // server knows it) lets the handler ignore a STALE replayed edge for a run already rendered
        // — session_events' ring re-delivers finished runs' edges at-least-once (#1087).
        if (frame.d && frame.d.reason === "run-started") _onRunStarted(frame.d.runId);
        _emit("state", frame);
        return;
      case "hud":
        if (frame.d && typeof frame.d.beatSeq === "number") _noteBeat(frame.d.beatSeq);
        _emit("hud", frame);
        return;
      case "layout":
        _emit("layout", frame);
        return;
      case "notice":
        _emit("notice", frame);
        return;
      default:
        return; // unknown frame type — ignore, never crash the pipe
    }
  }

  function _noteBeat(b) { if (typeof b === "number" && b > _beatSeq) _beatSeq = b; }

  // #1596 — AUTHORITATIVE beat adoption (handshake ack on reconnect + the stale-beat CAS refusal).
  // Unlike `_noteBeat` (monotonic-forward — the right rule for replayable `state`/`hud`/`event` push
  // frames, which can arrive out of order or be ring-replayed), an AUTHORITATIVE source that reports a
  // beat LOWER than our last-seen is the engine telling us its committed head moved BACKWARDS. That is
  // the engine-restart signal (a power-outage restart whose in-memory beatSeq reset): if we cling to
  // our now-FUTURE `_beatSeq`, every up-frame attaches a stale `expectedBeatSeq` and 409s forever (the
  // wedge). So HEAL DOWNWARD to the engine's real head and emit a one-shot `orwell:ws-resync` so the
  // chat reconciles + re-renders instead of sitting wedged on a half-painted bubble. A forward/equal
  // beat is just a normal advance. `b <= 0` is the "no beat" sentinel — never adopt it downward.
  function _adoptBeat(b) {
    if (typeof b !== "number" || !(b > 0)) return;
    if (b < _beatSeq) {
      // #1599 — a backwards engine head is a REAL anomaly (engine restart / rollback). It is being
      // AUTO-CORRECTED here (heal downward + resync), but a correction is NOT a cloak: log it at WARN
      // with disposition so it is never silently swallowed. A42: it also raises the RED health event on /admin/status.
      try { if (window.OrwellReport) window.OrwellReport.fail('ws:beat-backwards', 'BeatSeqBackwards', _beatSeq + ' -> ' + b, { red: true, corrected: 'heal downward + resync' }); } catch (_) {}
      try {
        console.warn("[orwellWs #1596] engine beatSeq went BACKWARDS (" + _beatSeq + " -> " + b +
          ") — restart detected; healed downward + emitting ws-resync (auto-corrected).");
      } catch (_) {}
      _beatSeq = b;
      _emitWindow("orwell:ws-resync", { canonicalId: _canonicalId, beatSeq: b, reason: "beat-backwards" });
      return;
    }
    if (b > _beatSeq) _beatSeq = b;
  }

  function _onAck(frame) {
    var cid = frame.cid;
    var d = frame.d || {};
    // Handshake ack (hello/bind): carries canonicalId/live/beatSeq (§2.3).
    if (cid && _pending[cid] && _pending[cid].t === "hello") {
      var p = _pending[cid]; delete _pending[cid];
      _canonicalId = d.canonicalId || _canonicalId;
      _live = d.live !== false;
      _noteBeat(d.beatSeq);
      if (d.adopted) {
        // We lost the bind race and adopted a different canonical id (§2.3) —
        // re-point the view WITHOUT a settle-time reload (that reload was #1086).
        _emitWindow("orwell:ws-adopted", { canonicalId: _canonicalId });
      }
      try { p.resolve(frame); } catch (_) {}
      return;
    }
    // Subscribe ack (§3.1): `ch:"chat"`, d:{fromSeq, headSeq} — sent BEFORE any
    // `event` frame on the channel, so the client knows the [fromSeq..headSeq]
    // replay window.
    if (cid && _pending[cid]) {
      var q = _pending[cid]; delete _pending[cid];
      if (frame.ch === "chat") {
        _chatSubscribed = true;
        // §3.1/§3.6 — `hasRun:false` means there is NO run to tail right now (the ack returns with no
        // live tail). Clear the tail flag so the FIRST subsequent `run-started` edge (§4.1) re-attaches
        // instead of being skipped as "already tailing". A live/terminal-buffered run keeps the flag —
        // its `done` event (or a drop) clears it.
        if (frame.d && frame.d.hasRun === false) { _chatTailActive = false; _liveRunKnown = false; }
        else if (frame.d && frame.d.hasRun === true) _liveRunKnown = true; // ORW-217: positive evidence of a live (or buffered, until `done`) run
        // #1087 reconcile-by-id: the ack names the run this subscribe attached to (the run whose
        // buffer replays/tails). Record it so a later ring-replayed `run-started` for the SAME run
        // is recognized as stale and ignored.
        if (frame.d && frame.d.runId != null) _lastRunId = frame.d.runId;
      }
      try { q.resolve(frame); } catch (_) {}
      return;
    }
    // A generic up-frame ack (turn/decision accepted, §3.5) with an unmatched
    // cid — nothing to resolve, ignore.
  }

  function _onError(frame) {
    var cid = frame.cid;
    var d = frame.d || {};
    // A `cid`-tagged error rejects the matching pending promise (§1.2) so the
    // caller (a turn/decision/subscribe/hello) fails the RIGHT request.
    if (cid && _pending[cid]) {
      var p = _pending[cid]; delete _pending[cid];
      // stale-beat: the engine refused a 0065 CAS BEFORE any write. The surfaced beatSeq is the
      // engine's AUTHORITATIVE current head — "the fresh beat the client reconciles to" (§3.5). Adopt
      // it even if it is LOWER than our last-seen: a lower head means the engine went backwards (a
      // restart), and clinging to our now-future value would 409 every retry forever (#1596). `_adoptBeat`
      // heals downward (and emits a resync) or advances forward, exactly matching the reconcile contract.
      if (d.code === "stale-beat" && typeof d.beatSeq === "number") _adoptBeat(d.beatSeq);
      var err = new Error(d.code || "ws-error");
      err.code = d.code; err.detail = d;
      try { p.reject(err); } catch (_) {}
    }
    // forbidden / not-bound at the handshake ⇒ this socket can't serve the game;
    // fail soft to the SSE stack rather than leaving the user stuck. A refusal is a permanent
    // cause (not pre-game) — recovery won't re-attempt it.
    if (d.code === "forbidden" || d.code === "not-bound") {
      _goFallback("handshake");
    }
  }

  // ── send helpers ────────────────────────────────────────────────────────
  function _send(frame) {
    try {
      if (_sock && _sock.readyState === 1) { _sock.send(JSON.stringify(frame)); return true; }
    } catch (_) {}
    return false;
  }

  // request/response: allocate a cid, register the pending promise, send. Gated on the
  // socket being OPEN (not on `_mode`): the handshake `hello`/`subscribe` legitimately
  // fire during `negotiating`, before we flip to `ws`. Callers of the up-frames
  // (sendTurn/sendDecision) additionally gate on isActive() at their call site.
  function _request(t, ch, d, tag) {
    var _cidOut = null;
    var prom = new Promise(function (resolve, reject) {
      if (!_sock || _sock.readyState !== 1) { reject(new Error("ws-not-open")); return; }
      var cid = _nextCid();
      _cidOut = cid;
      _pending[cid] = { resolve: resolve, reject: reject, t: tag || t };
      var frame = { t: t, cid: cid, d: d || {} };
      if (ch) frame.ch = ch;
      if (!_send(frame)) { delete _pending[cid]; reject(new Error("ws-send-failed")); }
    });
    prom._cid = _cidOut;   // N-12: lets a caller that gave up (timeout) cancel the retained entry via cancelRequest()
    return prom;
  }
  // N-12: drop the pending entry of a request the caller abandoned (a timed-out submit) so retries never accumulate retained requests.
  function cancelRequest(prom) {
    var cid = prom && prom._cid;
    if (cid && _pending[cid]) delete _pending[cid];
  }

  // Reject the outstanding UP-FRAME requests (turn/decision) whose socket just died. `_request`
  // registers a pending promise with NO timeout of its own (unlike `hello`, which `_helloTimer`
  // guards). The awaiting caller — `handleChatSubmit`'s `await OrwellWs.sendTurn(...)` (chat.js) and
  // `orwellDecision`'s `await OrwellWs.sendDecision(...)` — therefore hangs FOREVER when the ack can
  // never arrive because the socket that would carry it is gone (a mid-turn drop: laptop sleep, a
  // network blip, a uvicorn worker idle-recycle reaping the connection). That stranded `await` never
  // completes its try-block, so the stream-end `finally` that resets `chatState.isStreaming` and
  // re-enables the composer never runs: the composer stays disabled / stuck on Stop and the player
  // must RELOAD the page to continue (the reproducible FE freeze). Reject those pendings so the
  // caller's catch runs — it reconciles from history (softReloadHistory) and returns, letting the
  // finally recover the UI; a reconnect independently resumes the run's frames via the gap cursor.
  // Handshake/subscribe pendings ("hello"/"bind"/"subscribe") are deliberately LEFT to the existing
  // reconnect / `_helloTimer` machinery — their internal `.then` chains assume they never reject.
  function _rejectPending(reason) {
    var code = reason || "ws-closed";
    for (var cid in _pending) {
      if (!Object.prototype.hasOwnProperty.call(_pending, cid)) continue;
      var p = _pending[cid];
      if (!p || (p.t !== "turn" && p.t !== "decision")) continue;
      delete _pending[cid];
      var err = new Error(code);
      err.code = code;
      try { p.reject(err); } catch (_) {}
    }
  }

  // ── the handshake (§2) ──────────────────────────────────────────────────
  function _hello(perTabId) {
    return _request("hello", null, { perTabId: perTabId, protocol: PROTOCOL }, "hello");
  }

  // Re-resolve the canonical id (§2.3 `bind`) — dropped + re-issued on every
  // `orwell:gamechanged` (the ONE g15 dispatcher). A rebind re-arms the lightweight state/hud
  // push edges ONLY when the canonical id actually CHANGED (or they were never armed on this
  // socket), and re-points the `chat` channel under the same guard (a genuine re-resolve:
  // adoption, or a season-reset unbind).
  //
  // Why the EDGE guard is load-bearing too (#1087 — the rebind→ring-replay churn loop): a
  // same-id `_subscribeEdges()` re-arm makes the server REPLACE its state/hud channel task, and
  // the fresh `session_events.subscribe()` REPLAYS the per-session event ring (≤8 events, 180s
  // retention — the ADR 0012 §3.4b durable invitation). Those replayed `state` frames re-enter
  // `orwell:gamechanged` via platform.js's bridge → another rebind → another replay: a
  // self-sustaining ~2s churn whose stale `run-started` edges also repeatedly re-subscribed chat
  // from 0 (duplicate bubbles; the toolturn-parity failure). The server dedups the same-canonical
  // re-arm too (belt-and-braces), but the client simply not re-arming is what starves the loop.
  //
  // Why the guard is load-bearing: `orwell:gamechanged` fires on EVERY game mutation —
  // including MID-TURN (each game-mutating tool result dispatches it). A blind
  // `_subscribeChat(0)` here would, on every one of those, tear down the in-flight chat
  // tail and full-replay the whole buffer from seq 0 — racing the live stream (a duplicate
  // replay), and at the casting→started settle, a rebind that resolves onto a DIFFERENT/empty
  // canonical would swap the subscription off the session carrying the just-streamed reply and
  // strip it (the #1085/#1086 window-collapse / reply-strip class, now over WS). On a same-id
  // gamechanged we keep the existing subscription + its cursor untouched, so the live tail is
  // never interrupted. `_rebinding` coalesces overlapping gamechanged rebinds into one bind — and
  // is held across the ENTIRE operation (the bind AND the conditional `_subscribeChat(0)`), released
  // only once the whole chain settles. If it were released at the bind ack (before the chat
  // subscribe's own ack sets `_chatSubscribed=true`), a second gamechanged could re-enter while
  // `_chatSubscribed` is still false and fire a SECOND full-history chat subscribe on the same id —
  // exactly the double-replay this fix prevents.
  var _rebinding = null;
  function rebind() {
    if (_mode !== "ws") return Promise.reject(new Error("ws-not-active"));
    if (_rebinding) return _rebinding; // a rebind is already in flight — never stack a second
    var prevCanonical = _canonicalId;
    var prevChatSubscribed = _chatSubscribed;
    var op = _request("bind", null, { perTabId: _perTabId() }, "hello").then(function (ack) {
      // The socket dropped during the bind (onclose flipped us to negotiating) — the reconnect
      // path re-arms every channel from its own onopen; don't subscribe a dead sock.
      if (_mode !== "ws") return ack;
      // Re-arm the state/hud edges ONLY on a genuine canonical change (the running server bridge
      // serves its spawn-time canonical, so a re-point needs a fresh subscribe) or if they were
      // never armed on this socket. A same-id re-arm is the ring-replay churn trigger (#1087);
      // the HUD push keystone (test_ws_statehud_subscribe) stays live — the existing bridge is
      // still attached and pushing.
      if (_canonicalId !== prevCanonical || !_edgesSubscribed) _subscribeEdges();
      if (!_live) return ack;
      // Re-point chat ONLY on a genuine canonical change (or if it was never subscribed).
      // `_onAck` has already updated `_canonicalId` from the bind ack by the time this runs.
      // Returning the subscribe promise keeps `_rebinding` held until the chat `ack` lands
      // (which sets `_chatSubscribed=true`), so a re-entrant gamechanged can't double-subscribe.
      if (_canonicalId !== prevCanonical || !prevChatSubscribed) {
        _chatSubscribed = false;
        return _subscribeChat(0); // full history on the newly-resolved id (a real re-point)
      }
      return ack;                 // same id → the in-flight chat tail stays intact
    });
    // Release the coalescing guard (success AND failure) only after the WHOLE chain settles —
    // never mid-operation. Guarded so a teardown that already cleared `_rebinding` and started a
    // fresh rebind isn't clobbered by this stale settle.
    var release = function () { if (_rebinding === settled) _rebinding = null; };
    var settled = op.then(function (v) { release(); return v; },
                          function (e) { release(); throw e; });
    _rebinding = settled;
    return settled;
  }

  // ── the chat channel subscribe (§3.1) ───────────────────────────────────
  // A fresh window sends fromSeq:0 (full replay); a reconnecting socket sends
  // fromSeq = highest rendered seq + 1 (replay only the gap, then live-tail).
  function _subscribeChat(fromSeq) {
    var from = (typeof fromSeq === "number") ? fromSeq : (_highestChatSeq + 1);
    if (from < 0) from = 0;
    _chatTailActive = true;   // after a subscribe we ARE tailing this run (until its `done`)
    return _request("subscribe", "chat", { fromSeq: from }, "subscribe");
  }

  // §4.1 — re-attach the chat channel when a NEW run starts on our canonical. The previous run's
  // `subscribe()` returned at its own end (per-run buffers don't span runs), so `_chatSubscribed` being
  // "true" is stale — the server-side tail is gone. Re-subscribe from 0 (the new run's buffer restarts
  // at seq 0). Two guards (#1087 — at-least-once edges, exactly-once attach):
  //   • `_chatTailActive` (fast path) — an ID-LESS edge while tailing can't be told apart from a stale
  //     replay, so it is ignored (don't tear a live tail down on an ambiguous edge). A genuinely-NEW run
  //     (distinct id) re-attaches IMMEDIATELY even while tailing (SSE-parity — the WS analog of the SSE
  //     observer's resumeStream(id)-per-run; the server cancels the old chat channel on the new subscribe);
  //   • reconcile-by-id — a replayed STALE edge for a run we already fully rendered (its `done`
  //     cleared the boolean, so the boolean can't catch it) carries the SAME `runId` we recorded;
  //     skip it instead of resetting the cursor and full-replaying the finished run (the repeating
  //     duplicate-bubble churn). An id-less edge (older server / evicted run) falls back to the
  //     boolean-only behavior.
  function _onRunStarted(runId) {
    if (_mode !== "ws") return;
    // Reconcile-by-id (#1087): a STALE ring-replayed edge for the run we already rendered / are tailing
    // carries the SAME id — ignore it (the duplicate-bubble churn guard). Checked FIRST so it holds
    // whether or not we're currently tailing.
    if (runId != null && runId === _lastRunId) return;
    if (_chatTailActive) {
      // An ID-LESS edge while tailing can't be told apart from a stale replay — keep the conservative
      // #1087 behaviour (don't tear a live tail down on an ambiguous edge; the active run's `done` frees it).
      if (runId == null) return;
      // A genuinely-NEW run (distinct id) started while we were still tailing the PREVIOUS one. Do NOT
      // wait for the old run's `done` to attach it: deferring mounted the new run's live round only AFTER
      // the old run's possibly-late `done`, too late for the realtime mirror — the F5 WS-leg flake (the
      // OBSERVER renders the new run via a full-repaint reconcile → incrementalStream=false). The server
      // started a fresh per-run buffer for the new run and CANCELS the old chat channel on our new
      // subscribe (_spawn_channel — no double-tail), the old run's tail is moot (a new run began ⇒ its
      // engine work is done) and its final content reconciles from history. Re-attach the new run NOW —
      // the WS analog of the SSE observer's resumeStream(id)-per-run (sessionSync.js). Fall through.
    }
    if (runId != null) _lastRunId = runId; // provisional; the subscribe ack confirms/overwrites it
    _highestChatSeq = -1;          // a NEW run's buffer restarts at seq 0 — replay it from the top
    _chatSubscribed = false;
    // Tell the render layer a genuinely-NEW run is beginning (reconcile-by-id already applied above, so
    // this fires once per new run, never on a stale replay). The OBSERVER must start a FRESH live round
    // for it — otherwise the new run's replayed deltas render into the PRIOR run's still-connected holder
    // and B never mounts a fresh streaming container (mirror-parity `incrementalStream=false`). A DISTINCT
    // window event (not `orwell:gamechanged`), so the g15 single-dispatcher rule is untouched.
    _emitWindow("orwell:ws-run-boundary", { runId: runId != null ? runId : null });
    _liveRunKnown = true; // ORW-217: a new run's holder is mounted; if the socket drops before its ack/done, that run IS in flight
    // Ship-gate F2 ("right status") self-heal: the boundary emit above already mounted an observer
    // holder + a "Responding" spinner in ANTICIPATION of a live run (chatWsSplice._onWsRunBoundary),
    // before knowing whether one actually exists. Most of the time it does — but a `run-started` edge
    // can also be a STALE ring replay (ADR 0012 §3.4b: session_events replays its ≤8-event invitation
    // ring to every FRESH `state`-channel subscribe, e.g. every single page reload) for a run that has
    // since been fully evicted from `agent_runs`. When that is the case, THIS re-attach's own ack comes
    // back `hasRun:false` — there is no run to mirror, and since a dead run streams no further `event`
    // frames (no delta, no `done`), the speculative spinner/holder would otherwise sit wedged FOREVER —
    // the "stuck Production Responding after refresh" bug. Self-heal through the SAME teardown the
    // reconnect-run-gone case already uses (`orwell:ws-resync`: destroy the spinner, remove the wedged
    // holder, release the render-lock, reconcile from history — a cheap no-op if there is nothing to
    // fix). Guarded on `!_chatTailActive` so a genuinely-new run-started that raced in behind this one
    // (and is already being tailed) is never torn down by this stale ack's own resolution.
    // CodeRabbit fix: ALSO guarded on the reattach generation — `_chatTailActive` is a single shared
    // boolean, so a STALE reattach's ack can still land after `_chatTailActive` has been flipped back
    // to false by an UNRELATED later event (e.g. a superseding run B's own `done`), which would make
    // this stale ack misread as "genuinely no live run" and tear down B's already-reconciled holder.
    // Stamp THIS reattach's own generation and require it still be current before acting at all.
    var _myReattachGen = ++_chatReattachGen;
    _subscribeChat(0).then(function (ack) {
      if (_myReattachGen !== _chatReattachGen) return;  // superseded by a newer reattach — no-op
      if (ack && ack.d && ack.d.hasRun === false && !_chatTailActive) {
        _emitWindow("orwell:ws-resync",
          { canonicalId: _canonicalId, beatSeq: _beatSeq, reason: "run-started-empty" });
      }
    }).catch(function () { _chatTailActive = false; });
  }

  // ── the state/hud EDGE channels (§4) — the HUD push keystone ─────────────
  // These are the lightweight edge pings that make every WS HUD push reach the
  // browser. A `subscribe{ch:"state"|"hud"}` is what ARMS the server's continuous
  // `session_events → state/hud` bridge (`_run_state_channel`, ws_routes.py:273);
  // without it that bridge is never spawned, the only `state` frame a client ever
  // sees is the one-shot inline one from the decision handler, and platform.js's
  // correct `state`/`hud` → `orwellGameChanged` bridge STARVES (no push edge).
  //
  // Unlike `chat`, the server answers a state/hud subscribe with NO success `ack`
  // (only an `error{not-bound|forbidden}` on refusal — ws_routes.py:334), so these
  // are FIRE-AND-FORGET, NOT a request/response promise: a `_request` here would
  // register a pending that never resolves and leak forever. They carry no
  // `fromSeq`/replay semantics — just an empty `d` (§4). A refusal still routes
  // through `_onError`'s forbidden/not-bound → fallback leg (the socket is broken).
  var EDGE_CHANNELS = ["state", "hud"];
  function _subscribeEdges() {
    var sent = true;
    for (var i = 0; i < EDGE_CHANNELS.length; i++) {
      // A cid for the protocol shape (§3.1 `{t,ch,cid,...}`; echoed on a refusal
      // error) but NO pending promise — success never acks.
      if (!_send({ t: "subscribe", ch: EDGE_CHANNELS[i], cid: _nextCid(), d: {} })) sent = false;
    }
    // Armed on THIS socket (the #1087 same-id rebind guard reads this). A failed send means the
    // socket is dying — onclose/_goFallback resets the flag, and the reconnect onopen re-arms.
    _edgesSubscribed = sent;
  }

  // ── public up-frames (§3.5) ─────────────────────────────────────────────
  // Both ride the `chat` channel; both MUST carry expectedBeatSeq (0065 CAS) —
  // default to the last-seen beatSeq when the caller didn't pin one.
  function _beatFor(explicit) {
    var b = (typeof explicit === "number") ? explicit : _beatSeq;
    return (typeof b === "number" && b > 0) ? b : undefined;
  }
  function sendTurn(payload) {
    payload = payload || {};
    return _request("turn", "chat", {
      message: payload.message,
      clientMsgId: payload.clientMsgId,
      expectedBeatSeq: _beatFor(payload.expectedBeatSeq),
      attachments: payload.attachments || [],
      mode: payload.mode || "agent"
    }, "turn");
  }
  function sendDecision(payload) {
    payload = payload || {};
    // Carry the FULL decision body (kind + kind-specific fields — vote/save/use/intent/
    // statement/appeal/confirmed/choice…) VERBATIM so the server relay reconstructs the SAME
    // body the HTTP POST /api/orwell/decision handler receives (fix #1866: ws_routes
    // `_handle_decision` now runs the EXACT shared `_post_decision_tail` from orwell_routes,
    // so the parity claim is TRUE — F14 advance, pending cache, CON-4 reconcile, and DB1
    // debounce all fire over the WS path). The engine requires `kind` — a fixed
    // {pendingId,choice,target} shape would drop it and be refused `unknown-kind`. The explicit
    // pendingId/choice/target still round-trip through the spread (superset — back-compatible).
    // `expectedBeatSeq` defaults to the last-seen beatSeq (0065 CAS) when the caller didn't pin
    // one; `idempotencyKey` (snake_case `idempotency_key` accepted too) rides its own normalized
    // slot the server pulls out.
    var d = {};
    for (var k in payload) {
      if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
      if (k === "expectedBeatSeq" || k === "idempotencyKey" || k === "idempotency_key") continue;
      if (payload[k] === undefined) continue;
      d[k] = payload[k];
    }
    d.expectedBeatSeq = _beatFor(payload.expectedBeatSeq);
    var idem = payload.idempotencyKey || payload.idempotency_key;
    if (idem) d.idempotencyKey = idem;
    return _request("decision", "chat", d, "decision");
  }
  // layout is fire-and-forget per-device LWW (§5) — no cid/ack.
  // ORW-44 S2: the game build has no SSE send path any more, so a turn first makes sure the socket is up. ensure() resolves true when the socket is live (waiting out a reconnect that is already in flight, and
  // forcing ONE immediate upgrade attempt for the two RECOVERABLE fallback causes: the canonical id was not live yet, or the per-tab id had not resolved), and false when it cannot be: a permanent
  // fallback cause (proxy / handshake / exhausted retries = a network that blocks WebSockets) or the deadline. Never throws.
  function ensure(timeoutMs) {
    return new Promise(function (resolve) {
      var deadline = _now() + (timeoutMs > 0 ? timeoutMs : 8000);
      var kicked = false;
      (function check() {
        if (_mode === "ws" && _sock && _sock.readyState === 1) return resolve(true);
        if (_mode === "fallback") {
          var recoverable = _fallbackReason === "pregame-not-live" || _fallbackReason === "pertab-pending";
          if (!recoverable || kicked) return resolve(false);   // permanent cause, or our one upgrade attempt already fell back again
          kicked = true;
          _lastUpgradeAttempt = 0; _upgradeBackoffMs = UPGRADE_BACKOFF_MIN_MS;
          _maybeUpgradeFromFallback();
        }
        if (_now() >= deadline) return resolve(false);
        setTimeout(check, 150);
      })();
    });
  }

  function sendLayout(d) { return _send({ t: "layout", ch: "layout", d: d || {} }); }

  // ── negotiation + lifecycle (§6) ────────────────────────────────────────
  function _clearHelloTimer() { if (_helloTimer) { clearTimeout(_helloTimer); _helloTimer = null; } }

  // `reason` records WHY we fell back so recovery can be gated by CAUSE (see
  // `_maybeUpgradeFromFallback`): only a `"pregame-not-live"` fallback (the canonical id wasn't a
  // live game yet) is worth re-attempting on `orwell:gamechanged`. A `"proxy"` (blocked upgrade /
  // dead route), `"handshake"` (refused / closed before ack), or `"reconnect-exhausted"` fallback is
  // PERMANENT — retrying it would just re-pay the hello timeout on every eligible gamechanged.
  function _goFallback(reason) {
    if (_mode === "fallback") return;
    _mode = "fallback";
    _fallbackReason = reason || _fallbackReason || "handshake";
    // ORW-44 S1 (measure before deciding whether SSE can ever go): every permanent WS -> SSE downgrade is reported, once per page load (the guard above), with its reason. NOT red: falling back is the
    // designed behaviour today; the count per session is what the transport decision needs.
    try { if (window.OrwellReport) window.OrwellReport.fail('ws:fallback', String(_fallbackReason), 'this page load continues on the SSE transport', { corrected: 'SSE transport' }); } catch (_) {}
    // ORW-44 S3: a PERMANENT fallback cause in the game build means this network cannot carry the live connection: tell the player (orwellWsBlocked.js shows the banner). The two recoverable
    // pre-game causes never announce it (the next turn's ensure() retries them).
    if (_gameBuild() && _fallbackReason !== "pregame-not-live" && _fallbackReason !== "pertab-pending") _emitWindow("orwell:ws-blocked", { reason: _fallbackReason });
    _chatSubscribed = false;
    _chatTailActive = false;
    _edgesSubscribed = false;
    _rebinding = null;
    _clearHelloTimer();
    _clearPertabTimer();
    _closingForGood = true;
    try { if (_sock) _sock.close(); } catch (_) {}
    _sock = null;
    // A permanent WS→SSE downgrade also strands an in-flight up-frame: its ack rides the socket we
    // just closed (and `_closingForGood` makes onclose early-return before it can reject). Reject here
    // so the caller falls through to its catch and the SSE stack / history reconcile takes over.
    _rejectPending("ws-fallback");
    // Hand the resume cursor forward for a mid-session WS→SSE downgrade (§6):
    // the SSE resume path replays the run buffer from 0 and the client discards
    // the already-rendered prefix up to `fromSeq`; `beatSeq` keeps the next
    // turn's expectedBeatSeq CAS correct across the downgrade.
    _emitWindow("orwell:ws-inactive", {
      mode: "fallback",
      fromSeq: _highestChatSeq + 1,
      beatSeq: _beatSeq
    });
  }

  function _activate() {
    _mode = "ws";
    _everLive = true;
    _reconnectFails = 0;
    // A live socket clears the fallback-recovery backoff so a FUTURE drop-to-fallback re-attempts
    // promptly rather than inheriting a grown interval.
    _upgradeBackoffMs = UPGRADE_BACKOFF_MIN_MS;
    _lastUpgradeAttempt = 0;
    _fallbackReason = null;   // live now — a future fallback records its own fresh cause
    _emitWindow("orwell:ws-active", { canonicalId: _canonicalId, beatSeq: _beatSeq });
  }

  // Fallback→WS RECOVERY (the turn-on gate). `_goFallback()` is otherwise PERMANENT: a window that
  // booted pre-game (no live canonical yet ⇒ the hello ack returns `live:false` ⇒ `_goFallback`) would
  // NEVER upgrade even after the season starts. Two windows opened at different lifecycle points would
  // then sit on DIFFERENT transports (WS vs SSE) — the exact split that breaks two-window mirror parity
  // and risks the #1085/#1086 reply-strip on turn-on. So on every `orwell:gamechanged` a fallback window
  // re-attempts a REAL connect (not `rebind()`, which early-returns in fallback), gated on: the flag +
  // game build being on (dormancy preserved — flag off ⇒ never attempt), and a growing backoff having
  // elapsed (storm guard while a genuinely-blocked upgrade keeps failing). The full handshake resolves +
  // liveness-validates the canonical id SERVER-SIDE before any subscribe (bind-before-subscribe), so a
  // still-not-live game just returns `live:false` and falls back again until the next eligible change.
  function _maybeUpgradeFromFallback() {
    if (_mode !== "fallback") return;
    if (!_flagOn() || !_gameBuild()) return;   // flag off / non-game build ⇒ stay in fallback (dormant)
    // Gate by CAUSE: only a pre-game-not-live fallback (the canonical id wasn't live yet) OR a
    // pertab-pending fallback (the wait window elapsed before the per-tab session id resolved) recovers.
    // A proxy/handshake/exhaustion fallback is permanent — retrying it just re-pays the hello timeout on
    // every gamechanged. (start() below re-defers if the id STILL isn't ready, so it never hellos null.)
    if (_fallbackReason !== "pregame-not-live" && _fallbackReason !== "pertab-pending") return;
    var now = (typeof Date !== "undefined" && Date.now) ? Date.now() : +new Date();
    if (now - _lastUpgradeAttempt < _upgradeBackoffMs) return;  // within the backoff window — skip
    _lastUpgradeAttempt = now;
    _upgradeBackoffMs = Math.min(UPGRADE_BACKOFF_MAX_MS, _upgradeBackoffMs * 2);
    _mode = "idle";            // re-open the start() gate for a genuine reconnect attempt
    _closingForGood = false;
    start();                   // resolves the canonical id LIVE before subscribing; live:false ⇒ back to fallback
  }

  // ── deferred connect: WAIT for a valid perTabId before the hello (§2 handshake) ─────────────────
  // The hello frame carries `perTabId` and the server refuses a null/empty one `bad-request` (its guard
  // is correct — a socket must name a session). At boot that id resolves async, so rather than hello
  // with null and lock into a permanent handshake-cause fallback, we POLL until `_perTabId()` lands, then
  // connect for real. Bounded by `PERTAB_WAIT_MAX_MS`; on expiry we fall soft to the SSE stack with a
  // RECOVERABLE cause so a later game-load re-arms the wait through `orwell:gamechanged`.
  function _clearPertabTimer() { if (_pertabTimer) { clearTimeout(_pertabTimer); _pertabTimer = null; } }

  function _deferForPerTab() {
    if (_pertabTimer) return;                      // a wait is already armed — never stack a second
    if (!_pertabWaitStart) _pertabWaitStart = _now();
    _pertabTimer = setTimeout(function () {
      _pertabTimer = null;
      if (_mode !== "idle") return;                // a real connect / fallback already took over
      if (!_flagOn() || !_gameBuild()) return;     // dormancy (flag flipped off) — stop quietly
      if (_perTabId()) { _connect(); return; }     // the id landed → connect for real (a VALID hello)
      if (_now() - _pertabWaitStart >= PERTAB_WAIT_MAX_MS) {
        // No session after the wait window (an idle no-game page). Fall soft to SSE, but mark the cause
        // RECOVERABLE: a later game-load's `orwell:gamechanged` re-runs start() → re-arms this wait.
        // Reset the wait clock FIRST so recovery gets a FRESH full PERTAB_WAIT_MAX_MS budget — otherwise
        // `_deferForPerTab` re-arming with a stale `_pertabWaitStart` would time out on its very first
        // poll tick and immediately re-fall-back (the id never gets a real chance to resolve).
        _pertabWaitStart = 0;
        _goFallback("pertab-pending");
        return;
      }
      _deferForPerTab();                            // keep polling until the id lands or the bound elapses
    }, PERTAB_POLL_MS);
  }

  // While DEFERRING (idle, poll armed), the session bootstrap that establishes the per-tab id also
  // dispatches `orwell:gamechanged` (the ONE g15 seam). Use it to connect PROMPTLY once the id is ready
  // rather than waiting out the next poll tick. Re-checks the dormancy gate; a no-op if the id still
  // isn't ready (the poll keeps waiting) — so we never hello with a null perTabId.
  function _maybeConnectWhenPerTabReady() {
    if (_mode !== "idle") return;
    if (!_flagOn() || !_gameBuild()) return;
    if (_perTabId()) { _clearPertabTimer(); _pertabWaitStart = 0; _connect(); }
  }

  function _connect() {
    _clearPertabTimer();
    _pertabWaitStart = 0;
    _mode = "negotiating";
    _closingForGood = false;
    _connectStartedAt = _now();
    var perTabId = _perTabId();
    var sock;
    try {
      sock = new WebSocket(_wsUrl());
    } catch (_) { _goFallback("proxy"); return; }
    _sock = sock;

    // ~3s upgrade budget: no `ack` in time ⇒ blocked proxy / dead route ⇒
    // permanent fallback (§6). We never hang the player on a wedged upgrade.
    _clearHelloTimer();
    _helloTimer = setTimeout(function () {
      if (_mode === "ws") return;
      // ORW-308: a RECONNECT whose hello is unanswered is a flaky link, not a blocked proxy: close and let onclose schedule the retry.
      if (_everLive && _gameBuild()) { try { sock.close(); } catch (_) {} if (_sock === sock) _onSocketGone(sock); return; }
      try { sock.close(); } catch (_) {} _goFallback("proxy");
    }, HELLO_TIMEOUT_MS);

    sock.onopen = function () {
      // #1596 — capture reconnect-ness BEFORE `_activate()` clears `_reconnectFails`. A reconnect
      // handshake is a fresh authoritative sync point (used for the engine-restart beatSeq self-heal
      // + the run-gone reconcile below).
      var wasReconnect = _reconnectFails > 0 || _highestChatSeq >= 0;
      var runWasInFlight = _runInFlightAtDrop; // ORW-217: a live run was mid-tail when the socket dropped
      var beatAtDrop = _beatAtDrop;           // ORW-308: what we held when the socket died
      _hello(perTabId).then(function (helloAck) {
        _clearHelloTimer();
        if (!_live) {
          // Bound to a not-yet-live id (§2.4) — pre-game / casting hasn't produced a live
          // canonical game yet. Fall soft to SSE, but mark the cause RECOVERABLE: once the
          // season starts, the next `orwell:gamechanged` upgrades this window to WS (§6 turn-on).
          _emitWindow("orwell:ws-dead", { canonicalId: _canonicalId });
          _goFallback("pregame-not-live");
          return;
        }
        // #1596 — on a RECONNECT, adopt the ack's beatSeq AUTHORITATIVELY. `_onAck` already
        // `_noteBeat`d it (monotonic-forward), so if the engine RESTARTED and its committed head is
        // now LOWER than our last-seen, `_beatSeq` is still stale-high; `_adoptBeat` heals it down
        // (and resyncs) so the first post-reconnect up-frame doesn't 409 forever.
        if (wasReconnect) {
          try {
            var _hb = helloAck && helloAck.d && helloAck.d.beatSeq;
            if (typeof _hb === "number") _adoptBeat(_hb);
          } catch (_) {}
        }
        _activate();
        // ORW-308: a RECONNECT may have missed board changes (a ceremony step that advanced, a pending card that changed) while the phone was away: the state/hud edge pings that carried
        // them died with the old socket, and the pollers are off while a socket is live. If the server's beat at reconnect differs from the beat we held at the drop (or we did not know it),
        // something was missed: hand the existing `state` listeners one edge ping (ids + beatSeq only, like every state frame) - platform.js's bridge turns it into the single
        // `orwell:gamechanged` dispatch (g15), so the HUD and the pending card re-read their projections now. A reconnect that missed nothing asks for nothing. No second dispatcher here.
        if (wasReconnect) {
          try {
            var _hb2 = helloAck && helloAck.d && helloAck.d.beatSeq;
            if (typeof _hb2 !== "number" || beatAtDrop < 0 || _hb2 !== beatAtDrop) _emit("state", { t: "state", ch: "state", d: { beatSeq: _beatSeq, reason: "reconnect" } });
          } catch (_) {}
        }
        // Fresh window ⇒ full replay from 0; a reconnect resumes from the gap.
        _subscribeChat(wasReconnect ? _highestChatSeq + 1 : 0)
          .then(function (subAck) {
            _runInFlightAtDrop = false; // ORW-217: this reconnect's subscribe was answered; the drop is accounted for
            // #1596 — a reconnect whose re-subscribe finds NO live run (`hasRun:false`) means the run
            // we were mid-tail on was INTERRUPTED by the engine restart and is gone. Never sit wedged
            // on the half-painted bubble: emit a resync so the chat tears it down and reconciles from
            // the authoritative history (idempotent — a converged session is a cheap no-op).
            if (wasReconnect && runWasInFlight && subAck && subAck.d && subAck.d.hasRun === false) {
              // #1599 — the run we were tailing vanished across the reconnect (engine restart mid-turn).
              // This is a REAL interruption being AUTO-CORRECTED (resync → history reconcile); log it with
              // disposition rather than swallowing. A42: it also raises the RED health event.
              try { if (window.OrwellReport) window.OrwellReport.fail('ws:reconnect-run-gone', 'RunGoneOnReconnect', 'the mid-stream run vanished across the reconnect', { red: true, corrected: 'ws-resync history reconcile' }); } catch (_) {}
              try {
                console.warn("[orwellWs #1596] reconnect found NO live run for the canonical — the " +
                  "mid-stream run was interrupted (engine restart); emitting ws-resync to reconcile " +
                  "(auto-corrected).");
              } catch (_) {}
              _emitWindow("orwell:ws-resync",
                { canonicalId: _canonicalId, beatSeq: _beatSeq, reason: "reconnect-run-gone" });
            }
          })
          .catch(function (e) {
            // #1599 — a subscribe REFUSAL is a genuine failure (chat degrades to the SSE fallback for
            // this session): log it at WARN with disposition, never swallow it silently.
            // A42: it also raises the RED health event (chat degrades to the SSE fallback).
            try { if (window.OrwellReport) window.OrwellReport.fail('ws:chat-subscribe-refused', 'SubscribeRefused', (e && e.message) || String(e), { red: true, corrected: 'SSE fallback' }); } catch (_) {}
            try {
              console.warn("[orwellWs #1596] chat subscribe refused on " +
                (wasReconnect ? "reconnect" : "connect") + " — chat falls back to SSE for this session:",
                (e && e.message) || e);
            } catch (_) {}
            // Actually PERFORM the handoff the warning promises: without this the window stays in WS
            // mode with chat inactive (silently dead) — a soft failure. `_goFallback` tears down the
            // socket and emits `orwell:ws-inactive` so the SSE resume path picks chat back up.
            _goFallback("chat-subscribe-refused");
          });
        // Arm the state/hud push edge too (§4). This runs on EVERY successful
        // handshake — a fresh connect AND a reconnect (both re-enter this onopen) —
        // so a dropped socket re-arms all three channels, not just chat.
        _subscribeEdges();
      }).catch(function () {
        _clearHelloTimer();
        // ORW-308: a rejected/stranded hello on a RECONNECT (the socket died under it) retries; only a page that never went live falls back for good.
        if (_everLive && _gameBuild()) { try { sock.close(); } catch (_) {} if (_sock === sock) _onSocketGone(sock); return; }
        _goFallback("handshake");
      });
    };

    sock.onmessage = function (ev) {
      _clearProbe(); // ORW-308: any inbound frame proves the socket is alive
      var frame;
      try { frame = JSON.parse(ev.data); } catch (_) { return; }
      _handleFrame(frame);
    };

    sock.onerror = function () { /* onclose drives the retry/fallback decision */ };

    sock.onclose = function () {
      if (_sock !== sock) return; // ORW-308: a stale socket (a wake-up already replaced it) must not tear down its successor
      _onSocketGone(sock);
    };
  }

  // ORW-308: the one place a dead socket is accounted for (called from onclose AND from the hello-timeout/hello-reject paths, which can see the death before onclose fires).
  function _onSocketGone(sock) {
    if (_sock !== sock) return;
    _sock = null;
    if (_mode === "ws") _beatAtDrop = (typeof _beatSeq === "number" ? _beatSeq : -1);
    _chatSubscribed = false;
    if (_liveRunKnown) _runInFlightAtDrop = true; // ORW-217: remember it BEFORE the reset below (a run was known live at the drop)
    _liveRunKnown = false;
    _chatTailActive = false;
    _edgesSubscribed = false;
    _rebinding = null;
    _clearHelloTimer();
    _clearProbe();
    if (_closingForGood) return;
    // A genuine mid-session drop: strand no in-flight turn/decision (its ack died with the socket).
    _rejectPending("ws-closed");
    if (_mode === "ws" || (_mode === "negotiating" && _everLive && _gameBuild())) {
      // We were live (or a reconnect attempt just failed) - reconnect with the gap cursor (fromSeq = highest+1) and resume the buffered tail (§3.3 monotonicity).
      // Before this page load ever went live the retries are bounded and past the cap we downgrade (§6). AFTER it has been live (ORW-308, the game build) there is no cap:
      // the network is only away, and the backoff stays capped at RECONNECT_MAX_MS so a returning link is found within seconds.
      _mode = "negotiating";
      _reconnectFails += 1;
      if (!_everLive && _reconnectFails > RECONNECT_GIVEUP) { _goFallback("reconnect-exhausted"); return; }
      var wait = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.min(_reconnectFails, 12) - 1));
      if (_reconnectTimer) clearTimeout(_reconnectTimer);
      _reconnectTimer = setTimeout(function () { _reconnectTimer = null; if (!_closingForGood) _connect(); }, wait);
    } else {
      // Never got live (closed before ack) ⇒ fallback.
      _goFallback("handshake");
    }
  }

  // ORW-308 - phone lifecycle. A phone that sleeps, switches apps or hops wifi/cell leaves the socket either dead-and-reported (onclose, handled above) or a ZOMBIE: readyState 1
  // with nothing flowing, which the browser only notices minutes later. On every return signal we (a) if a reconnect is waiting out its backoff, cut the wait and reconnect now;
  // (b) if the socket claims to be open, prove it with one ping (the server answers a client ping with a pong, ws_routes) and close it if nothing at all comes back.
  function _clearProbe() { if (_probeTimer) { clearTimeout(_probeTimer); _probeTimer = null; } }

  function _wake(reason) {
    if (_closingForGood || !_everLive || !_flagOn() || !_gameBuild()) return;
    if (_mode === "negotiating") {
      if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; _reconnectFails = 0; _connect(); return; }
      // an attempt is mid-flight: if it is older than the hello budget it is a zombie too - replace it
      if (_sock && _sock.readyState !== 1 && _now() - _connectStartedAt > 1500) { var old = _sock; _sock = null; try { old.onclose = null; old.close(); } catch (_) {} _reconnectFails = 0; _connect(); }
      return;
    }
    if (_mode === "ws" && _sock && _sock.readyState === 1) {
      _clearProbe();
      try { _sock.send(JSON.stringify({ t: "ping" })); } catch (_) { try { _sock.close(); } catch (__) {} return; }
      var probed = _sock;
      _probeTimer = setTimeout(function () {
        _probeTimer = null;
        if (_sock !== probed) return;
        // no frame at all since the ping: a zombie. Treat it as dropped now rather than waiting for the browser's own timeout.
        try { probed.onclose = null; probed.close(); } catch (_) {}
        _onSocketGone(probed);
      }, PROBE_TIMEOUT_MS);
    }
  }

  function start() {
    if (_mode !== "idle") return;
    if (!_flagOn() || !_gameBuild()) {
      // Flag off or non-game build ⇒ pure fallback, the zero-risk default (§6). Not a recoverable
      // cause — `_maybeUpgradeFromFallback`'s flag/gameBuild gate already blocks it, but record it.
      _mode = "fallback";
      _fallbackReason = "flag-off";
      _emitWindow("orwell:ws-inactive", { mode: "fallback", reason: "flag-off" });
      return;
    }
    if (!_perTabId()) { _deferForPerTab(); return; }  // id not resolved yet — DEFER, never hello null
    _connect();
  }

  // Re-resolve on a game change (season reset unbinds the canonical id). We only
  // LISTEN for the ONE g15 dispatcher's event — we never dispatch it (§4).
  try {
    window.addEventListener("orwell:gamechanged", function () {
      if (_mode === "ws") { try { rebind(); } catch (_) {} }
      else if (_mode === "fallback") { try { _maybeUpgradeFromFallback(); } catch (_) {} }
      // Still deferring for the per-tab id (idle, poll armed): the bootstrap that JUST established the id
      // fired this event — connect promptly now that it's ready instead of waiting the next poll tick.
      else if (_mode === "idle") { try { _maybeConnectWhenPerTabReady(); } catch (_) {} }
    });
  } catch (_) {}

  try {
    window.addEventListener("online", function () { _wake("online"); });
    window.addEventListener("pageshow", function () { _wake("pageshow"); });
    if (window.document && typeof window.document.addEventListener === "function") {
      window.document.addEventListener("visibilitychange", function () {
        if (window.document.visibilityState === "visible") _wake("visible");
      });
    }
  } catch (_) {}

  try {
    window.addEventListener("beforeunload", function () {
      _closingForGood = true;
      try { if (_sock) _sock.close(); } catch (_) {}
    });
  } catch (_) {}

  // ── public surface ──────────────────────────────────────────────────────
  window.OrwellWs = {
    onFrame: onFrame,
    offFrame: offFrame,
    sendTurn: sendTurn,
    sendDecision: sendDecision,
    cancelRequest: cancelRequest,
    sendLayout: sendLayout,
    ensure: ensure,
    // ORW-44 S4b: the WS-side bootstrap. sessionSync resolves the canonical game id over REST (no SSE in the WS-only game build); the moment one appears for a window that booted pre-game, kick() forces ONE
    // immediate upgrade attempt (same recoverable-cause gate as ensure()), so a second window finds the live session without the old SSE run-started invitation.
    kick: function () {
      if (_mode !== "fallback") return false;
      if (_fallbackReason !== "pregame-not-live" && _fallbackReason !== "pertab-pending") return false;
      _lastUpgradeAttempt = 0; _upgradeBackoffMs = UPGRADE_BACKOFF_MIN_MS;
      _maybeUpgradeFromFallback();
      return true;
    },
    flagOn: _flagOn,   // ORW-44 S2: chat.js asks whether the WS transport is switched on (ORWELL_WS_TRANSPORT) before it treats the socket as the only send path
    rebind: rebind,
    isActive: function () { return _mode === "ws" && !!_sock && _sock.readyState === 1; },
    isFallback: function () { return _mode === "fallback"; },
    mode: function () { return _mode; },
    isChatSubscribed: function () { return _chatSubscribed; },
    canonicalId: function () { return _canonicalId; },
    lastBeatSeq: function () { return _beatSeq; },
    highestChatSeq: function () { return _highestChatSeq; },
    lastRunId: function () { return _lastRunId; },   // #1087 reconcile-by-id (diagnostics/tests)
    // test seam: feed a frame straight through the router (no live socket).
    _handleFrame: _handleFrame,
    _wake: _wake,   // test seam (ORW-308): the phone-return signal, without a real visibilitychange
    // test seam: force negotiation start (start() is auto-called on ready).
    _start: start
  };

  // Announce availability so load-order-independent consumers (platform.js's
  // state/hud bridge) can register even if they evaluated first.
  _emitWindow("orwell:ws-ready", {});

  // Auto-start once the DOM (and thus body[data-game-build]) is known.
  if (window.document && window.document.readyState === "loading") {
    window.document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
