// static/js/chatOutbox.js

/**
 * #1414 (R3 PR6): the SEND-OUTBOX subsystem — the reload-durable, session-bound, self-continuing
 * queue for messages a player sends while a turn streams / while offline (#985 P2-A / #891 / #830).
 *
 * The next extraction from the chat.js god-object (docs/REFACTOR-ROADMAP.md, R3), building on PR0
 * (chatState.js) + PR1 (chatScrollEdges) + PR2 (chatSubmitButton) + PR3 (chatAttachments) + PR4
 * (chatWsSplice) + PR5 (chatMessageActions). Moved VERBATIM from chat.js — behavior-preserving, no
 * logic change (the 2-space indentation is kept exactly so the source-pin gates slice unchanged):
 *   - _enqueueSend / _paintOutboxBubble — queue a send + paint its optimistic pending bubble.
 *   - _persistOutbox / _restoreOutboxFromStorage / _outboxPeekStorage — the sessionStorage (per-tab)
 *       durability layer + boot restore.
 *   - _outboxConfirmDelivery / _requeueOutboxItem / _isNetworkSendFailure / _dedupeOutboxAgainstServer
 *       — the delivery-confirm, network-requeue, and at-most-once (pre-send server-log) seams.
 *   - _setQueuedTag / _refreshOutboxStatusTags / _setDeliveryState / _clearDeliveryRetry /
 *       _attachDeliveryRetry — the honest per-bubble delivery-state chrome (#891 P0-2 / F-A7).
 *   - _markSendFailed / _markSendFailedById / _retryFailedSend — the durable terminally-failed bucket.
 *   - _updateOutboxStrip — the #830 aggregate above-composer notice-kit projection.
 *   - _armOutboxRetry / _foldOutboxBatch / _flushSendOutbox — the capped-backoff retry, the
 *       rapid-succession fold, and the FIFO drain itself.
 *   - the boot-restore durability wiring (online/offline/pageshow listeners) — a module-level side
 *       effect that runs once at eval (chat.js imports this module exactly once, #1399).
 *
 * The three outbox queues (`_sendOutbox` / `_outboxAwaitingConfirm` / `_outboxFailed`) and the two
 * single-flight guards (`_flushingOutbox` / `_outboxRestoreDone`) live on the shared `chatState`
 * singleton (PR0) — read/written as `chatState.X` here exactly as in chat.js, so the submit path
 * (chat.js), the drain (here), and the reconcile (chat.js) all serialize on ONE instance.
 *
 * Coupling: two chat.js-internal deps.
 *   - handleChatSubmit — the flush's dispatch. It STAYS in chat.js (the turn orchestrator + stream
 *     loop); importing it here would be a circular edge, so chat.js registers the SOLE production
 *     dispatch — a headless `handleChatSubmit(null, text, opts)`, byte-identical to the pre-PR6
 *     default — through the `_setOutboxDispatch` seam at module-eval. `_setOutboxDispatch` is also the
 *     browser-gate spy hook (it swaps `_outboxDispatch` for a stub); production and test both route
 *     through it, last-writer-wins (production registers at eval; a test overrides afterward).
 *   - API_BASE — a chat.js `let` set once in init(). Injected as a `() => API_BASE` resolver via
 *     `_setOutboxDeps`, read live inside `_dedupeOutboxAgainstServer` (the PR3/PR5 apiBase pattern).
 * Everything else the subsystem touches is importable (chatRenderer / ui / sessions / chatState) or a
 * global (window.OrwellNoticeKit, window._orwellComposerDraftClear, sessionStorage, navigator, fetch).
 *
 * Public API preserved: chat.js imports every moved function and re-exports the browser-gate ones on
 * the `chatModule` object byte-identically (`_enqueueSend`, `_flushSendOutbox`, `_setOutboxDispatch`,
 * `_restoreOutboxFromStorage`, `_outboxConfirmDelivery`, `_setDeliveryState`, `_markSendFailedById`,
 * `_retryFailedSend`, `_requeueOutboxItem`, `_persistOutbox`, `_dedupeOutboxAgainstServer`,
 * `_isNetworkSendFailure`, `_outboxPeekStorage`, `_updateOutboxStrip`), plus the three chatState-backed
 * arrays. sessions.js's selectSession nudge (`window.chatModule._flushSendOutbox`) keeps working
 * through that re-export.
 *
 * Dual-load idempotent (#1399 generalized): the module-level state is either chatState-backed (one
 * shared instance) or a transient flush timer / notice handle; the durability listeners are added once
 * because chat.js imports this module exactly once. Imported BY chat.js only (never app.js / an html
 * shell), so #1399 single-eval holds.
 */

import chatRenderer from './chatRenderer.js';
import uiModule from './ui.js';
import sessionModule from './sessions.js';
import { chatState } from './chatState.js';

// ── chat.js-internal API_BASE dep injected at module-eval (see the header) ────────
// API_BASE is a chat.js `let` (set in init to window.location.origin); read it live through this
// resolver so there is no stale snapshot. A safe no-op default keeps a bare test import inert.
let _apiBaseResolver = () => '';
export function _setOutboxDeps(deps) {
  if (!deps) return;
  if (deps.apiBase) _apiBaseResolver = deps.apiBase;
}

  // ── #985 P2-A: the SEND OUTBOX ──────────────────────────────────────────────
  // A message the player sends WHILE a turn is streaming must NOT be silently dropped (the old
  // `isStreaming → Stop` branch aborted the reply and `return`ed before the new text was ever read).
  // The owner's ruling was "Queue it": enqueue the new message into this in-memory FIFO, paint its
  // optimistic bubble immediately (composes with #992 render-by-seq — a pending bubble carries a
  // clientMsgId, NO dbId/seq, so it floats to the tail until its seq lands), clear the composer (the
  // text is now safely captured here, not lost), and flush the queue IN ORDER the moment the current
  // turn settles — one in flight at a time, mirroring the engine's server-side `_framed` serialization.
  // Idempotent + multibrowser-safe: each item is keyed by its `clientMsgId`, which the existing
  // optimistic-adopt path reconciles by, so a flush is at-most-once and reconciles cleanly across
  // windows (sends target the canonical session per #990, render by seq per #992, mirror per #991).
  // Items: { clientMsgId, text, bubbleEl }. STOP is reserved for the explicit Stop button / an EMPTY
  // composer — "stop the current reply" and "send a new message" are no longer collapsed onto one
  // silent action.
  // chatState._sendOutbox is this in-memory FIFO; chatState._flushingOutbox is the single-flight
  // re-entrancy guard (only one flush send dispatched at a time). Moved to chatState.js, #1414 R3 PR0.

  // ── #891 P0 (messaging resilience): the RELOAD-DURABLE half of the outbox + honest offline status ──
  // The #985 outbox above was in-memory only — a hard reload while a send sat QUEUED lost it (the
  // explicitly-deferred half; audit row INT-3). Now every queued item is persisted the instant it
  // enters the queue and stays persisted until a SERVER row carrying its clientMsgId is observed:
  //
  //     enqueue → persist { clientMsgId, text, sessionId, ts } (sessionStorage, per-tab)
  //     dispatch → item moves to _outboxAwaitingConfirm (STILL persisted — a reload mid-flight restores it)
  //     server row with the clientMsgId observed (adopt pass / pre-send dedupe) → confirmed, released
  //
  // STORAGE CHOICE — sessionStorage, deliberately (vs IndexedDB/localStorage): the payload contract is
  // tiny (a handful of {id, text} strings — no blobs, no attachments), so IndexedDB's async machinery
  // buys nothing; and the outbox is PER-TAB by design (ADR 0008/0012 — a drained send flows through
  // THIS tab's normal canonical-session send path; localStorage is shared across tabs, so two tabs
  // restoring one queue would double-send the same message). sessionStorage is the tab-scoped store
  // that survives a reload — the exact durability owed — and follows the composer-draft precedent
  // (orwellComposerDraft.js, G17). Known boundary: closing the TAB discards its queue (a per-tab queue
  // has no other tab allowed to drain it); that residual is #891's cross-tab/service-worker tier.
  //
  // AT-MOST-ONCE across a reload: restored (and network-requeued) items carry `needsDedupe` — before
  // re-dispatch, ONE /api/history fetch drops any item whose client_msg_id the server already has
  // (the server stamps it on the persisted user row, chat_helpers.add_user_message). Fail-closed: if
  // the check cannot run, the item stays queued and the backoff retries — never an unverified re-send.
  //
  // HONEST STATUS (#891 P0-2): a queued bubble carries a real-text-node `.queued-tag` ('queued' /
  // 'queued — offline' — same a11y reasoning as `.unsent-tag`), the drain gates on navigator.onLine,
  // and the 'online' event + a capped exponential backoff auto-drain the queue. A send attempted
  // while OFFLINE goes straight to the outbox (no doomed POST), and a send that dies at the network
  // layer before any byte arrived is classified (`_isNetworkSendFailure`) and re-queued instead of
  // surfacing as a raw error.
  // chatState._outboxAwaitingConfirm: dispatched, not yet server-confirmed (persisted alongside the queue). #1414 R3 PR0.
  //
  // ── #891 F-A7 (per-bubble delivery state): the DURABLE-FAILED bucket ──
  // A message's lifecycle is queued → sending → delivered | failed, projected onto its user bubble
  // (`dataset.deliveryState`, a REAL text/aria surface — never CSS-only) and — the load-bearing half
  // — persisted so a RELOAD shows the TRUE state, not a stranded pending bubble. queued/sending are
  // already reload-durable (the queue + awaiting-confirm records above); `delivered` releases the
  // durable copy. The missing terminal state is `failed`: a send that exhausted its network-requeue
  // cap (`_OUTBOX_MAX_RETRIES`) used to be DROPPED to the generic error surface, so a reload lost the
  // "not delivered" signal entirely. Such items now live here — persisted (`state:'failed'`),
  // repainted on reload, HELD OUT of the auto-drain, and cleared only by an explicit per-bubble Retry
  // (which re-enters the ONE normal flush, `needsDedupe`-armed) or by a server row proving the POST
  // did land after all (`_outboxConfirmDelivery`). Kept separate from `_sendOutbox` so the drain,
  // backoff, and aggregation never touch a terminally-failed turn.
  // chatState._outboxFailed holds these durable terminally-failed items. Moved to chatState.js, #1414 R3 PR0.
  //
  // ── #830 (optimistic-always + aggregated unsent queue): the AGGREGATION lane ──
  // The owner's ruling: "aggregate what you send quickly … when it's time to send the payload it
  // sends all messages in one turn." Items queued WHILE A TURN WAS STREAMING (the rapid-succession
  // case — the player keeps talking while the model replies) carry `coalesce: true`; at drain time
  // a same-lane run of such items FOLDS into ONE combined turn (`_foldOutboxBatch`): one payload
  // (texts joined by a blank line), ONE clientMsgId (the head's), ONE bubble (the batch's separate
  // pending bubbles collapse into a single combined bubble via the same render path), ONE server
  // row. A single queued item dispatches byte-identical to the pre-#830 path (no fold, no marker).
  // DELIBERATELY NOT aggregated: OFFLINE-queued, network-requeued and reload-RESTORED items — each
  // is its own at-most-once idempotency unit (its POST may already have reached the server, so the
  // per-item `needsDedupe` verification and per-item drain of #891/#1379 must stand; folding items
  // with divergent delivery states could double- or half-send a batch). Aggregation therefore
  // requires `coalesce && !needsDedupe`, and never crosses a same-lane item that can't join (order
  // within a conversation is preserved). When ≥2 items sit queued, an aggregated status strip
  // (`#send-queue-strip`, role="status" — real text, WCAG 4.1.3) shows the count + a manual
  // "Send now" retry that resets the backoff and drains through the ONE normal flush.
  // chatState._outboxRestoreDone gates the once-per-page boot restore. Moved to chatState.js, #1414 R3 PR0.
  let _outboxRetryTimer = null;
  let _outboxRetryDelayMs = 0;        // 0 → next arm starts at the base delay
  const _OUTBOX_RETRY_BASE_MS = 2000;
  const _OUTBOX_RETRY_MAX_MS = 60000;
  const _OUTBOX_MAX_RETRIES = 4;      // per-item network-requeue cap — beyond it the normal error surface speaks
  const _OUTBOX_BOOT_RETRY_MS = [600, 1400, 2600, 4200]; // restore attempts (idempotent) past the boot renders
  function _outboxKey() {
    // E71 pattern (same as the composer draft): scoped per user so one account's queue never
    // bleeds into another's. Read lazily — body/data-user exist by the time any send runs.
    return 'orwell-send-outbox:' + ((document.body && document.body.dataset.user) || '');
  }
  function _outboxOnline() {
    return typeof navigator === 'undefined' || navigator.onLine !== false;
  }

  // ── #985 P2-A: SEND OUTBOX — enqueue + flush ────────────────────────────────
  /**
   * Enqueue a Send made WHILE a turn is streaming. Paints the optimistic bubble NOW (pending shape:
   * clientMsgId, no dbId/seq → floats to the tail per #992), captures the text in the FIFO, clears the
   * composer (the words are safely held in the queue, never lost), and routes the freshness seam — so
   * nothing is dropped and the queue flushes in order when the current turn settles. Mirrors the
   * optimistic-bubble + composer-clear contract of the normal send path so a queued send is
   * indistinguishable from an in-line one once it reconciles.
   */
  function _enqueueSend(text) {
    const clientMsgId = 'c-' + ((window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now() + '-' + Math.random().toString(36).slice(2)));
    const item = {
      clientMsgId,
      text,
      sessionId: (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || null,
      ts: Date.now(),
      retries: 0,
      needsDedupe: false,
      // #830: an item queued WHILE A TURN STREAMS is the rapid-succession case — it aggregates
      // with its same-lane siblings into ONE combined turn at drain time (_foldOutboxBatch). An
      // OFFLINE-queued item keeps #891's per-item at-most-once drain — the offline branch (~L801)
      // also routes here, and a device that dropped its link mid-stream must NOT fold (each offline
      // item is its own idempotency unit whose eventual POST may land independently), so coalesce
      // additionally requires a live link.
      coalesce: chatState.isStreaming === true && _outboxOnline(),
      bubbleEl: null,
    };
    // Paint the optimistic bubble immediately (pending: clientMsgId, NO dbId/seq).
    _paintOutboxBubble(item);
    chatState._sendOutbox.push(item);
    _refreshOutboxStatusTags(); // honest status the moment it queues: 'queued' / 'queued — offline'
    _persistOutbox();           // #891 P0-1: reload-durable from the instant it enters the queue
    // Clear the composer — the text is now held in the outbox (+ bubble), so it is safe (and expected:
    // the player is free to compose the next message). Mirror the normal-send composer reset.
    try {
      const mi = uiModule.el('message');
      if (mi) {
        mi.value = '';
        mi.style.height = '';
        mi.dispatchEvent(new Event('input'));
      }
      if (window._orwellComposerDraftClear) window._orwellComposerDraftClear();
    } catch (_) {}
  }

  /** #891: paint (or re-paint after a reload) a queued item's optimistic pending bubble. */
  function _paintOutboxBubble(item) {
    try {
      const bubbleEl = chatRenderer.addMessage('user', item.text, null, null);
      if (bubbleEl) {
        bubbleEl.dataset.clientMsgId = item.clientMsgId;
        bubbleEl.classList.add('msg-pending');
      }
      item.bubbleEl = bubbleEl || null;
      if (uiModule.setAutoScroll) uiModule.setAutoScroll(true);
      if (uiModule.scrollHistory) uiModule.scrollHistory();
    } catch (_) {
      // A paint failure must not strand the text — it's still captured in the queue.
      item.bubbleEl = null;
    }
  }

  // ── #891 P0-1: outbox persistence (sessionStorage — per-tab; see the design note at the top) ──
  /** Serialize queue + awaiting-confirm. An item leaves storage ONLY on server-confirmed delivery
   *  (or the dedupe pass proving its row already exists) — never merely because it was dispatched. */
  function _persistOutbox() {
    try {
      // #830: `coalesce` is deliberately NOT persisted — a restored item is its own at-most-once
      // unit and re-enters the queue outside the aggregation lane (the restore forces it false),
      // so a persisted copy of the flag would be dead weight the restore ignores.
      const items = chatState._outboxAwaitingConfirm
        .map((it) => ({ clientMsgId: it.clientMsgId, text: it.text, sessionId: it.sessionId || null, ts: it.ts || Date.now(), retries: it.retries || 0, state: 'inflight' }))
        .concat(chatState._sendOutbox.map((it) => ({ clientMsgId: it.clientMsgId, text: it.text, sessionId: it.sessionId || null, ts: it.ts || Date.now(), retries: it.retries || 0, state: 'queued' })))
        // #891 F-A7: terminally-failed sends persist too — a reload must show 'failed' (with its
        // Retry), never a stranded pending bubble or a vanished turn. `state:'failed'` routes the
        // restore to the failed bucket instead of the auto-drain.
        .concat(chatState._outboxFailed.map((it) => ({ clientMsgId: it.clientMsgId, text: it.text, sessionId: it.sessionId || null, ts: it.ts || Date.now(), retries: it.retries || 0, state: 'failed' })));
      if (!items.length) { sessionStorage.removeItem(_outboxKey()); return; }
      sessionStorage.setItem(_outboxKey(), JSON.stringify({ v: 1, items }));
    } catch (_) { /* storage unavailable — the in-memory queue still works for this page */ }
  }

  /** #891 order-stability: register a DIRECT (composer-dispatched, non-queued) player send as a
   *  durable in-flight record the moment it dispatches. The queued→dispatched path already persists
   *  its item ('state:inflight' via _outboxAwaitingConfirm), but a direct send had NO record at all —
   *  so a reload during a long-hanging POST lost the message entirely, and a QUEUED sibling restored
   *  and dispatched FIRST while the original's zombie POST could still land later (a permanent
   *  send-order inversion). Tracking it here gives a direct send the exact #891 lifecycle a flushed
   *  send has: persisted until a server row carrying its clientMsgId is observed; a reload mid-flight
   *  restores it (needsDedupe-armed, at-most-once) AHEAD of the still-queued items — _persistOutbox
   *  serializes awaiting-confirm FIRST, so the restore re-queues in original dispatch order.
   *  Idempotent per clientMsgId (a flushed outbox send is already tracked — no double record). */
  function _outboxTrackInflightSend(clientMsgId, text, sessionId, bubbleEl) {
    if (!clientMsgId || typeof text !== 'string' || !text) return false;
    for (const arr of [chatState._outboxAwaitingConfirm, chatState._sendOutbox, chatState._outboxFailed]) {
      if (arr.some((it) => it && it.clientMsgId === clientMsgId)) return false; // already tracked
    }
    chatState._outboxAwaitingConfirm.push({
      clientMsgId,
      text,
      sessionId: sessionId || null,
      ts: Date.now(),
      retries: 0,
      needsDedupe: false,
      coalesce: false,
      bubbleEl: bubbleEl || null,
    });
    _persistOutbox();
    return true;
  }

  /** #891 order-stability: release a tracked in-flight record whose send was REFUSED client-visibly
   *  (an !res.ok streamed refusal, a WS pre-stream refusal). The user saw the failure surface and the
   *  turn never became a server row — keeping the record would re-send it after a reload. Distinct
   *  from _outboxConfirmDelivery (which asserts the row LANDED): this only drops the durable copy;
   *  the bubble's error chrome is owned by the caller's error path. */
  function _outboxReleaseInflightSend(clientMsgId) {
    if (!clientMsgId) return;
    let hit = false;
    const i = chatState._outboxAwaitingConfirm.findIndex((it) => it && it.clientMsgId === clientMsgId);
    if (i >= 0) { chatState._outboxAwaitingConfirm.splice(i, 1); hit = true; }
    if (hit) _persistOutbox();
  }

  /** #891 order-stability (FIFO across a reload): is there an OLDER, still-undispatched send this
   *  session must drain BEFORE a fresh composer send may dispatch? True when the in-memory queue
   *  holds an item bound to `sessionId` (or session-less — eligible everywhere), OR — the boot
   *  window before the restore has run — when the persisted record still holds a drainable item for
   *  it. A fresh send arriving while this is true must join the queue (per-session FIFO), never jump
   *  ahead of a restored-but-unconfirmed older turn. Failed items never block (they only move on an
   *  explicit Retry); awaiting-confirm items never block in-page (they were already dispatched —
   *  their server order is settled). */
  function _outboxHasBlockingSendFor(sessionId) {
    const sameLane = (sid) => !sid || !sessionId || sid === sessionId;
    if (chatState._sendOutbox.some((it) => it && sameLane(it.sessionId))) return true;
    if (!chatState._outboxRestoreDone) {
      const rec = _outboxPeekStorage();
      const items = (rec && Array.isArray(rec.items)) ? rec.items : [];
      if (items.some((it) => it && it.clientMsgId && typeof it.text === 'string' && it.text &&
                             it.state !== 'failed' && sameLane(it.sessionId))) return true;
    }
    return false;
  }

  /** #891 order-stability (the sticky-duplicate hole): is this confirmed item's bubble a REDUNDANT
   *  copy? True when the bubble itself was never adopted (no dbId) while the AUTHORITATIVE render of
   *  the same clientMsgId — a history-rendered row, stamped with its data-db-id — is already in the
   *  DOM. Settling such a copy 'delivered' leaves two visible bubbles for one server row, and the
   *  pending shape (clientMsgId, no dbId) keeps it excluded from the divergence count so every
   *  rebuild RESCUES it — a permanent duplicate ("old messages hanging out"). The redundant copy must
   *  be removed, not settled. */
  function _isRedundantConfirmedBubble(bubbleEl, clientMsgId) {
    try {
      if (!bubbleEl || !clientMsgId) return false;
      if (bubbleEl.dataset && bubbleEl.dataset.dbId) return false;  // adopted — it IS the authoritative render
      const stamped = document.querySelectorAll('.msg[data-db-id]');
      for (let i = 0; i < stamped.length; i++) {
        if (stamped[i] !== bubbleEl && stamped[i].dataset.clientMsgId === clientMsgId) return true;
      }
    } catch (_) { /* fail-open: never remove on doubt */ }
    return false;
  }

  /** #891: restore the persisted queue after a reload — repaint pending bubbles, mark every restored
   *  item `needsDedupe` (at-most-once: the pre-send history check drops already-delivered rows), and
   *  kick the drain. Idempotent (runs once per page); scheduled past the boot renders so the bubbles
   *  land after the history paint. Returns the number of items restored (test seam). */
  function _restoreOutboxFromStorage() {
    if (chatState._outboxRestoreDone) return 0;
    if (!document.getElementById('chat-history')) return 0; // too early — a later boot attempt retries
    // #830 hardening, retained as DEFENSE-IN-DEPTH. chat.js USED to be evaluated TWICE on this
    // page (app.js imports './chat.js' bare while index.html ALSO script-tagged 'chat.js?v=…' —
    // two URLs ⇒ two module instances, each with its own queue state but SHARING one sessionStorage
    // record). #1399 removed the versioned <script> tag, so chat.js now evaluates ONCE and this
    // guard is trivially satisfied — but it is kept so that if a second load path ever regresses,
    // only the instance registered as window.chatModule restores: a shadow instance restoring the
    // same record repaints duplicate pending bubbles and — once its own dedupe pass verifies clean
    // — dispatches a SECOND time (a real double-send). Fail-open when no handle exists (stripped
    // test DOMs).
    try {
      if (window.chatModule && window.chatModule._restoreOutboxFromStorage &&
          window.chatModule._restoreOutboxFromStorage !== _restoreOutboxFromStorage) {
        chatState._outboxRestoreDone = true; // this shadow instance never restores (nor re-attempts)
        return 0;
      }
    } catch (_) { /* fail-open */ }
    let rec = null;
    try { rec = JSON.parse(sessionStorage.getItem(_outboxKey()) || 'null'); } catch (_) {}
    chatState._outboxRestoreDone = true;
    const items = (rec && Array.isArray(rec.items)) ? rec.items : [];
    let restored = 0;
    let restoredFailed = 0; // #891 F-A7: durable-failed items repaint but never auto-drain
    // #891 order-stability: only paint a restored bubble into the view of ITS OWN session (or a
    // pre-session item's — it is eligible everywhere). A restored item bound to ANOTHER session keeps
    // its record + drain semantics but paints nothing here — the drain's session gate holds it, and
    // the dispatch paints a fresh bubble when its session is actually selected. Painting into a
    // foreign session's DOM was a cross-session visual bleed.
    const _curSid = (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || null;
    const _paintable = (sid) => !sid || sid === _curSid;
    // #891 order-stability (the sticky-duplicate hole): the boot history render may ALREADY show a
    // bubble for this clientMsgId. Repainting a second pending bubble creates a duplicate the
    // divergence check is structurally blind to (pending shape ⇒ excluded ⇒ rescued by every rebuild).
    // Adopt the existing element instead; if it is db-id-stamped the row PROVABLY landed — the item is
    // delivered, so release it here (the trailing _persistOutbox normalizes storage).
    const _existingByCid = (cid) => {
      try {
        const all = document.querySelectorAll('.msg');
        for (let i = 0; i < all.length; i++) {
          if (all[i].dataset && all[i].dataset.clientMsgId === cid) return all[i];
        }
      } catch (_) {}
      return null;
    };
    for (const it of items) {
      if (!it || typeof it.clientMsgId !== 'string' || !it.clientMsgId) continue;
      if (typeof it.text !== 'string' || !it.text) continue;
      if (chatState._sendOutbox.some((x) => x.clientMsgId === it.clientMsgId) ||
          chatState._outboxAwaitingConfirm.some((x) => x.clientMsgId === it.clientMsgId) ||
          chatState._outboxFailed.some((x) => x.clientMsgId === it.clientMsgId)) continue;
      const existingEl = _existingByCid(it.clientMsgId);
      if (existingEl && existingEl.dataset.dbId) continue; // row landed — proven delivered, release
      // #891 F-A7: a persisted `state:'failed'` item restores into the DURABLE-FAILED bucket — its
      // bubble repaints as 'failed' + Retry, and it is NOT re-queued for the auto-drain (retries were
      // exhausted; only an explicit Retry, or a proven-delivered server row, moves it).
      if (it.state === 'failed') {
        const failedItem = {
          clientMsgId: it.clientMsgId,
          text: it.text,
          sessionId: it.sessionId || null,
          ts: it.ts || Date.now(),
          retries: it.retries || 0,
          needsDedupe: false,
          coalesce: false,
          failed: true,
          bubbleEl: existingEl || null,
        };
        if (!failedItem.bubbleEl && _paintable(failedItem.sessionId)) _paintOutboxBubble(failedItem);
        _setDeliveryState(failedItem.bubbleEl, 'failed');
        chatState._outboxFailed.push(failedItem);
        restoredFailed++;
        continue;
      }
      const item = {
        clientMsgId: it.clientMsgId,
        text: it.text,
        sessionId: it.sessionId || null,
        ts: it.ts || Date.now(),
        retries: it.retries || 0,
        needsDedupe: true, // EVERY restored item verifies against the server log before re-sending
        // #830: a RESTORED item is its own at-most-once idempotency unit (its POST may already
        // have reached the server), so it re-enters the queue OUTSIDE the aggregation lane —
        // per-item drain, per-item dedupe, never folded (matches the design note at the top).
        coalesce: false,
        bubbleEl: existingEl || null,
      };
      if (!item.bubbleEl && _paintable(item.sessionId)) _paintOutboxBubble(item);
      chatState._sendOutbox.push(item);
      restored++;
    }
    _persistOutbox(); // normalize (drops a corrupt/empty record)
    if (restored || restoredFailed) _refreshOutboxStatusTags();
    // Only DRAINABLE (queued) restores kick the flush — a restored 'failed' item waits for its
    // explicit Retry, never re-sending on its own.
    if (restored) setTimeout(() => { try { _flushSendOutbox(); } catch (_) {} }, 250);
    return restored;
  }

  /** #891: a server row carrying this clientMsgId was OBSERVED (adopt pass / dedupe) — delivery is
   *  proven, so release the durable copy. Cheap no-op when nothing is queued (the common case). */
  function _outboxConfirmDelivery(clientMsgId) {
    if (!clientMsgId) return;
    if (!chatState._outboxAwaitingConfirm.length && !chatState._sendOutbox.length && !chatState._outboxFailed.length) return;
    let hit = false;
    // #891 F-A7: a proven-delivered server row can rescue even a bubble we'd marked 'failed' (its
    // POST DID land — the reader just died before the confirm). Scan the failed bucket too and settle
    // the bubble to 'delivered' (clears the Retry).
    for (const arr of [chatState._outboxAwaitingConfirm, chatState._sendOutbox, chatState._outboxFailed]) {
      const i = arr.findIndex((it) => it && it.clientMsgId === clientMsgId);
      if (i >= 0) {
        const removed = arr.splice(i, 1)[0];
        // #891 order-stability: if the AUTHORITATIVE render of this row is already on screen and this
        // bubble was never adopted, settling it 'delivered' would leave a permanent duplicate the
        // divergence check can't see — remove the redundant copy instead.
        if (removed && removed.bubbleEl && _isRedundantConfirmedBubble(removed.bubbleEl, clientMsgId)) {
          try { removed.bubbleEl.remove(); } catch (_) {}
        } else if (removed && removed.bubbleEl) _setDeliveryState(removed.bubbleEl, 'delivered');
        hit = true;
      }
    }
    if (hit) {
      _outboxRetryDelayMs = 0; // a confirmed delivery proves the link — reset the backoff
      _persistOutbox();
      _updateOutboxStrip(); // #830: the aggregate count just shrank
    }
  }

  /** #891 P0-2: re-queue a send that died at the network layer (or dead-ended) back into the durable
   *  outbox — front of the queue (it is the OLDEST turn), `needsDedupe` armed (the POST may still have
   *  reached the server), bubble kept with an honest queued tag. Idempotent per clientMsgId; capped at
   *  _OUTBOX_MAX_RETRIES so a non-network failure misclassified once can't retry silently forever. */
  function _requeueOutboxItem(clientMsgId, text, bubbleEl, sessionId) {
    if (!clientMsgId || typeof text !== 'string' || !text) return false;
    const ai = chatState._outboxAwaitingConfirm.findIndex((it) => it && it.clientMsgId === clientMsgId);
    let item = ai >= 0 ? chatState._outboxAwaitingConfirm.splice(ai, 1)[0] : null;
    if (chatState._sendOutbox.some((it) => it && it.clientMsgId === clientMsgId)) {
      _persistOutbox(); // already queued — idempotent (the awaiting copy, if any, was just folded out)
      return true;
    }
    if (!item) {
      // #891 P1 fix (cross-session bleed): bind the fresh item to the session the failed send was
      // ACTUALLY targeting (the caller passes the turn's streamSessionId) — not whatever session is
      // current at catch-time (the user may have switched mid-turn). Fallback: current, then null.
      item = {
        clientMsgId, text,
        sessionId: sessionId ||
          (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || null,
        ts: Date.now(), retries: 0, bubbleEl: null,
      };
    }
    item.retries = (item.retries || 0) + 1;
    if (item.retries > _OUTBOX_MAX_RETRIES) {
      _persistOutbox(); // out of retries — hand the turn back to the normal error surface
      return false;
    }
    item.needsDedupe = true;
    // #830: a network-requeued item (like a restored one) is its own at-most-once unit — it never
    // re-joins the aggregation lane, even when the failed dispatch was itself a folded batch (the
    // batch already IS one item here; it must not fold AGAIN with newer streaming sends).
    item.coalesce = false;
    if (bubbleEl) item.bubbleEl = bubbleEl;
    if (item.bubbleEl) {
      item.bubbleEl.classList.add('msg-pending');
      item.bubbleEl.classList.remove('msg-unsent');
      delete item.bubbleEl.dataset.unsent;
    }
    chatState._sendOutbox.unshift(item);
    _refreshOutboxStatusTags();
    _persistOutbox();
    _armOutboxRetry();
    return true;
  }

  /** #891: classify a send failure as NETWORK-layer (device offline / fetch never reached the server).
   *  Deliberately NARROWER than _isRecoverableStreamErr — only the browser's fetch-network messages
   *  qualify, so a client-side TypeError from a coding bug can't masquerade as "offline" and loop. */
  function _isNetworkSendFailure(err) {
    if (!_outboxOnline()) return true;
    const m = ((err && err.message) || '').toLowerCase();
    return /failed to fetch|networkerror|network request failed|load failed|err_internet|err_network|err_connection/.test(m);
  }

  /** #891: at-most-once across a reload — before dispatching any `needsDedupe` item, verify it against
   *  the server log and drop any item whose client_msg_id the server already persisted. FAIL-CLOSED:
   *  returns false (drain deferred, backoff armed) when any needed verification is unavailable — never
   *  an unverified re-send. A 404 session (never materialized / since deleted) verifies trivially clean.
   *
   *  #891 P1 fix (cross-session bleed — PR #1379 review): each item is verified against ITS OWN
   *  recorded session's history, NEVER the currently-selected session's. The old code preferred the
   *  current session id, so a restored session-A item was "verified" against session B's log whenever
   *  B was current after the reload — vacuously clean, then dispatched into B by the old drain gate.
   *  Items are grouped by their recorded sessionId (one fetch per distinct session, normally one). An
   *  item with NO recorded sessionId was queued before any session existed — there is no server log it
   *  could have written into, so it verifies trivially clean (current-session-at-queue-time semantics,
   *  documented at the drain's eligibility check). */
  async function _dedupeOutboxAgainstServer() {
    // #1414 R3 PR6: API_BASE is a chat.js `let` (set in init); read it live through the injected
    // resolver so there is no stale snapshot — identical to chatMessageActions' _apiBaseResolver.
    const API_BASE = _apiBaseResolver();
    const flagged = chatState._sendOutbox.filter((it) => it && it.needsDedupe);
    if (!flagged.length) return true;
    const bySid = new Map();
    for (const it of flagged) {
      if (!it.sessionId) { it.needsDedupe = false; continue; }
      if (!bySid.has(it.sessionId)) bySid.set(it.sessionId, []);
      bySid.get(it.sessionId).push(it);
    }
    let allVerified = true;
    for (const [sid, items] of bySid) {
      let seen = null;
      try {
        // Bounded: a hung verification fetch must not wedge the drain (the flush holds
        // _flushingOutbox across this await). On timeout it rejects → fail-closed → backoff.
        const _dedupeOpts = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
          ? { signal: AbortSignal.timeout(15000) } : {};
        const res = await fetch(`${API_BASE}/api/history/${sid}`, _dedupeOpts);
        if (res.status === 404) { items.forEach((it) => { it.needsDedupe = false; }); continue; }
        if (res.ok) {
          const data = await res.json();
          seen = new Set((data.history || [])
            .map((m) => m && m.metadata && m.metadata.client_msg_id)
            .filter(Boolean));
        }
      } catch (_) { /* network hiccup — fail closed for this session's items */ }
      if (!seen) { allVerified = false; continue; }
      for (const it of items) {
        it.needsDedupe = false;
        if (seen.has(it.clientMsgId)) {
          // Already delivered — drop the queued copy; the adopt pass claims its bubble when the
          // authoritative row renders (same clientMsgId), so nothing is lost and nothing doubles.
          const i = chatState._sendOutbox.indexOf(it);
          if (i >= 0) chatState._sendOutbox.splice(i, 1);
          // #891 order-stability: when the authoritative row is ALREADY rendered (db-id-stamped) and
          // this bubble was never adopted, it is a redundant duplicate — remove it, don't settle it.
          if (it.bubbleEl && _isRedundantConfirmedBubble(it.bubbleEl, it.clientMsgId)) {
            try { it.bubbleEl.remove(); } catch (_) {}
          } else if (it.bubbleEl) _setDeliveryState(it.bubbleEl, 'delivered');
        }
      }
    }
    _persistOutbox();
    _updateOutboxStrip(); // #830: proven-delivered drops may have shrunk the aggregate count
    return allVerified;
  }

  // ── #891 P0-2: honest queued/offline status on the message bubble ──
  /** Set/clear the `.queued-tag` status on a queued bubble. mode: 'queued' | 'offline' | null. The tag
   *  is a REAL text node (the .unsent-tag a11y precedent — WCAG 4.1.3), never CSS generated content. */
  function _setQueuedTag(bubbleEl, mode) {
    if (!bubbleEl) return;
    try {
      const role = bubbleEl.querySelector('.role');
      let tag = role && role.querySelector('.queued-tag');
      if (!mode) {
        if (tag) tag.remove();
        bubbleEl.classList.remove('msg-queued-offline');
        return;
      }
      if (!tag && role) {
        tag = document.createElement('span');
        tag.className = 'queued-tag';
        role.appendChild(tag);
      }
      if (tag) tag.textContent = mode === 'offline' ? 'queued — offline' : (mode === 'sending' ? 'sending…' : 'queued'); // ORW-406: 'sending' = quiet wait out of a release-sized reconnect gap
      bubbleEl.classList.toggle('msg-queued-offline', mode === 'offline');
    } catch (_) {}
  }

  /** #891: sweep every queued bubble's status to the live connectivity truth. Routes through
   *  `_setDeliveryState` so `dataset.deliveryState` stays in lockstep with the visible `.queued-tag`
   *  ('queued' | 'queued — offline'). Terminally-failed bubbles are NOT swept — connectivity doesn't
   *  un-fail them; only an explicit Retry does. */
  function _refreshOutboxStatusTags() {
    const mode = _outboxOnline() ? 'queued' : 'offline';
    for (const it of chatState._sendOutbox) { if (it) _setDeliveryState(it.bubbleEl, mode); }
    _updateOutboxStrip(); // #830: keep the aggregate affordance in lockstep with the per-bubble tags
  }

  // ── #891 F-A7: per-bubble delivery state (queued → sending → delivered | failed) ──
  /** Project a message's delivery lifecycle onto its user bubble. `state`:
   *    'queued'    — held in the outbox, link up            → `.msg-pending` + `.queued-tag` 'queued'
   *    'offline'   — held, this device has no link          → `.queued-tag` 'queued — offline' + accent
   *    'sending'   — dispatched, awaiting server confirm     → `.msg-pending` (dim = in-progress), no tag
   *    'delivered' — a server row proved it landed / settled → all transient markers cleared
   *    'failed'    — terminal (retries exhausted)            → `.msg-unsent` + a REAL 'Not delivered' +
   *                                                            Retry affordance
   *    null        — clear every marker (settled)
   *  The state is ALSO stamped on `dataset.deliveryState` — a machine-readable, a11y-adjacent projection
   *  that (for 'failed') is reconstructed on reload from the persisted outbox record, so a reload shows
   *  the TRUE state. Reuses the existing message-state CSS vocabulary (`.msg-pending` / `.queued-tag` /
   *  `.msg-unsent`); it adds no new stylesheet rules. */
  function _setDeliveryState(bubbleEl, state) {
    if (!bubbleEl) return;
    try {
      if (!state || state === 'delivered') {
        _setQueuedTag(bubbleEl, null);
        _clearDeliveryRetry(bubbleEl);
        bubbleEl.classList.remove('msg-pending', 'msg-unsent');
        delete bubbleEl.dataset.unsent;
        if (state === 'delivered') bubbleEl.dataset.deliveryState = 'delivered';
        else delete bubbleEl.dataset.deliveryState;
        return;
      }
      if (state === 'queued' || state === 'offline') {
        _clearDeliveryRetry(bubbleEl);
        bubbleEl.classList.remove('msg-unsent');
        delete bubbleEl.dataset.unsent;
        bubbleEl.classList.add('msg-pending');
        _setQueuedTag(bubbleEl, state); // real `.queued-tag` text node (the existing a11y contract)
        bubbleEl.dataset.deliveryState = state;
        return;
      }
      if (state === 'sending') {
        _clearDeliveryRetry(bubbleEl);
        bubbleEl.classList.remove('msg-unsent');
        delete bubbleEl.dataset.unsent;
        bubbleEl.classList.add('msg-pending'); // dim = "in progress" (the existing vocabulary)
        _setQueuedTag(bubbleEl, null);         // the 'queued' text would be a lie once it's dispatched
        bubbleEl.dataset.deliveryState = 'sending';
        return;
      }
      if (state === 'failed') {
        _setQueuedTag(bubbleEl, null);
        bubbleEl.classList.remove('msg-pending');
        bubbleEl.classList.add('msg-unsent');
        bubbleEl.dataset.unsent = '1';
        bubbleEl.dataset.deliveryState = 'failed';
        _attachDeliveryRetry(bubbleEl, bubbleEl.dataset.clientMsgId || null);
        return;
      }
    } catch (_) { /* delivery-state chrome is best-effort — never let it break the send/queue */ }
  }

  /** #891 F-A7: remove the per-bubble failed-delivery Retry affordance (if present). */
  function _clearDeliveryRetry(bubbleEl) {
    try {
      const n = bubbleEl.querySelector('.msg-delivery-retry');
      if (n) n.remove();
    } catch (_) {}
  }

  /** #891 F-A7: attach a REAL "Not delivered" label + Retry button to a failed user bubble (WCAG
   *  4.1.3 — the meaning lives in text nodes, never CSS-only). The button re-enters the ONE normal
   *  flush via `_retryFailedSend`; it reuses the existing `.continue-btn` style (no new CSS). */
  function _attachDeliveryRetry(bubbleEl, clientMsgId) {
    try {
      const host = bubbleEl.querySelector('.body') || bubbleEl;
      if (!host || host.querySelector('.msg-delivery-retry')) return;
      const note = document.createElement('div');
      note.className = 'msg-delivery-retry';
      note.setAttribute('role', 'status');
      note.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:4px;opacity:0.9;font-style:italic;';
      const label = document.createElement('span');
      label.textContent = 'Not delivered.';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'continue-btn';
      btn.textContent = 'Retry';
      btn.addEventListener('click', () => {
        _clearDeliveryRetry(bubbleEl);
        _retryFailedSend(clientMsgId || bubbleEl.dataset.clientMsgId || null);
      });
      note.appendChild(label);
      note.appendChild(btn);
      host.appendChild(note);
    } catch (_) {}
  }

  /** #891 F-A7: move a terminally-failed send into the durable-failed bucket, paint its bubble
   *  'failed' + Retry, and persist ('state:failed') so a reload shows the true state. Idempotent per
   *  clientMsgId. `_markSendFailedById` is the caller-facing entry when only the id/text/bubble are in
   *  hand (the stream catch-hook, after the network-requeue cap is hit). */
  function _markSendFailed(item) {
    if (!item || !item.clientMsgId) return false;
    for (const arr of [chatState._sendOutbox, chatState._outboxAwaitingConfirm]) {
      const i = arr.indexOf(item);
      if (i >= 0) arr.splice(i, 1);
    }
    if (!chatState._outboxFailed.some((it) => it && it.clientMsgId === item.clientMsgId)) {
      item.failed = true;
      item.coalesce = false;
      chatState._outboxFailed.push(item);
    }
    if (item.bubbleEl) _setDeliveryState(item.bubbleEl, 'failed');
    _persistOutbox();
    _updateOutboxStrip();
    return true;
  }

  function _markSendFailedById(clientMsgId, text, bubbleEl, sessionId) {
    if (!clientMsgId || typeof text !== 'string' || !text) return false;
    // Reclaim any live copy so it can't also drain; otherwise build the record fresh (the capped
    // requeue already spliced it out of every bucket).
    let item = null;
    for (const arr of [chatState._sendOutbox, chatState._outboxAwaitingConfirm, chatState._outboxFailed]) {
      const i = arr.findIndex((it) => it && it.clientMsgId === clientMsgId);
      if (i >= 0) { item = arr.splice(i, 1)[0]; break; }
    }
    if (!item) {
      item = {
        clientMsgId, text,
        sessionId: sessionId ||
          (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || null,
        ts: Date.now(), retries: _OUTBOX_MAX_RETRIES + 1, bubbleEl: null,
      };
    }
    if (bubbleEl && !item.bubbleEl) item.bubbleEl = bubbleEl;
    const ok = _markSendFailed(item);
    return ok;
  }

  /** #891 F-A7: the user tapped Retry on a failed bubble — re-enter the ONE normal flush. The send is
   *  `needsDedupe`-armed (its earlier POST may have partially landed) and unshifted to the FRONT (it
   *  is the oldest turn), exactly like a network requeue. Fresh retry budget (the user chose this). */
  function _retryFailedSend(clientMsgId) {
    if (!clientMsgId) return false;
    const i = chatState._outboxFailed.findIndex((it) => it && it.clientMsgId === clientMsgId);
    if (i < 0) return false;
    const item = chatState._outboxFailed.splice(i, 1)[0];
    item.failed = false;
    item.retries = 0;              // user-initiated — a fresh attempt, not a continuation of the cap
    item.needsDedupe = true;       // its earlier POST may have reached the server — verify first
    item.coalesce = false;         // its own at-most-once unit, never folded
    if (item.bubbleEl) _setDeliveryState(item.bubbleEl, _outboxOnline() ? 'queued' : 'offline');
    chatState._sendOutbox.unshift(item);
    _persistOutbox();
    _armOutboxRetry();
    try { _flushSendOutbox(); } catch (_) {}
    return true;
  }

  // ── #830: the AGGREGATED unsent-queue affordance ──
  // When ≥2 sends sit queued, the scattered per-bubble tags gain one aggregate status card above
  // the composer: the count, whether the batch will send as ONE turn (the coalesce lane), the
  // offline truth, and a manual "Send now" retry. The card COMPOSES window.OrwellNoticeKit — the
  // ONE stacked above-composer zone (ruling 642; the anti-fragmentation gate in
  // test_on_notice_kit.py forbids hand-rolled anchors) — kind 'continue' (a quiet ambient notice),
  // role 'status' + real text nodes (WCAG 4.1.3, the .unsent-tag precedent). It is a PROJECTION of
  // the #891 outbox: no queue state of its own, and its retry routes through the ONE normal flush
  // (every guard re-checked; never a second send path).
  let _outboxNotice = null;   // the kit notice handle (created lazily at ≥2 queued items)
  let _outboxStripRow = null; // the body row (label + retry button) inside the kit card

  /** #830: project the outbox onto the aggregate card. Visible only at ≥2 queued items (a single
   *  item's per-bubble tag already tells the whole story); closed the moment the queue drains. */
  function _updateOutboxStrip() {
    try {
      const n = chatState._sendOutbox.length;
      if (n < 2) {
        if (_outboxNotice) {
          try { _outboxNotice.hide(); } catch (_) {}
          _outboxNotice = null;
          _outboxStripRow = null;
        }
        return;
      }
      if (!window.OrwellNoticeKit) return; // fail-open: the per-bubble queued tags still speak
      if (!_outboxNotice || !(_outboxNotice.isShown && _outboxNotice.isShown())) {
        // Belt: a just-hidden card may still be animating out under the same id — clear it so the
        // zone never briefly holds two.
        const leftover = document.getElementById('send-queue-strip');
        if (leftover && leftover.isConnected) { try { leftover.remove(); } catch (_) {} }
        _outboxNotice = window.OrwellNoticeKit.create({
          id: 'send-queue-strip',
          kind: 'continue',    // a quiet ambient above-composer notice (polite live region)
          role: 'status',      // WCAG 4.1.3 — announced without focus
          title: '',           // single-line affordance: the row lives in the body
          dismissible: false,  // its lifecycle is queue-driven, never a user dismissal
          persistDismiss: false,
        });
        const row = document.createElement('span');
        row.className = 'send-queue-row';
        const label = document.createElement('span');
        label.className = 'send-queue-label';
        row.appendChild(label);
        const btn = document.createElement('button');
        btn.type = 'button';
        // #775: kit-card buttons compose the element kit's chrome; .send-queue-retry is the hook.
        btn.className = 'ow-btn ow-btn-plain send-queue-retry';
        btn.textContent = 'Send now';
        btn.addEventListener('click', () => {
          // Manual retry (#830 "failed with Retry — retry re-sends the batch"): reset the backoff
          // and drain through the ONE normal flush, which re-checks every guard (single-flight,
          // streaming, offline, dedupe, session binding) and folds the coalesce batch exactly like
          // an auto-drain.
          _outboxRetryDelayMs = 0;
          if (_outboxRetryTimer) { clearTimeout(_outboxRetryTimer); _outboxRetryTimer = null; }
          try { _flushSendOutbox(); } catch (_) {}
        });
        row.appendChild(btn);
        _outboxNotice.show();
        _outboxNotice.setBody(row);
        // Title-less single-line card: keep the empty head row from reserving space (the
        // orwellChatHint precedent).
        const head = _outboxNotice.el && _outboxNotice.el.querySelector('.on-head');
        if (head) head.style.display = 'none';
        _outboxStripRow = row;
      }
      const offline = !_outboxOnline();
      const oneTurn = chatState._sendOutbox.every((it) => it && it.coalesce && !it.needsDedupe);
      const label = _outboxStripRow && _outboxStripRow.querySelector('.send-queue-label');
      if (label) {
        label.textContent = offline
          ? (n + ' messages queued — offline')
          : (oneTurn ? (n + ' messages queued — they will send as one turn')
                     : (n + ' messages queued'));
      }
      const btn = _outboxStripRow && _outboxStripRow.querySelector('.send-queue-retry');
      if (btn) btn.disabled = offline; // no link ⇒ a manual retry is a lie; the 'online' event drains
    } catch (_) { /* the card is best-effort chrome — never let it break the queue */ }
  }

  /** #891: capped exponential backoff retry (2s → 60s) for a queue held by offline/network failure.
   *  Reset to the base by a confirmed delivery or the 'online' event. One timer at a time. */
  function _armOutboxRetry() {
    if (_outboxRetryTimer) return;
    if (chatState._sendOutbox.length === 0) return;
    _outboxRetryDelayMs = _outboxRetryDelayMs
      ? Math.min(_outboxRetryDelayMs * 2, _OUTBOX_RETRY_MAX_MS)
      : _OUTBOX_RETRY_BASE_MS;
    _outboxRetryTimer = setTimeout(() => {
      _outboxRetryTimer = null;
      try { _flushSendOutbox(); } catch (_) {}
    }, _outboxRetryDelayMs);
  }

  /** #830: fold a rapid-succession batch (all `coalesce`, all same-lane, none dedupe-pending) into
   *  ONE turn. One combined payload (texts joined by a blank line, send order preserved), ONE
   *  clientMsgId (the head's — the batch's single idempotency key), ONE bubble: the batch's separate
   *  pending bubbles collapse into a single combined bubble painted through the SAME render path
   *  every queued bubble uses, so the live view matches the one persisted user row a reload or a
   *  peer window will show. The folded item is a normal outbox item — awaiting-confirm, persistence,
   *  network-requeue ("retry re-sends the batch") and the adopt/confirm seams all apply unchanged. */
  function _foldOutboxBatch(batch) {
    const head = batch[0];
    const folded = {
      clientMsgId: head.clientMsgId,
      text: batch.map((it) => it.text).join('\n\n'),
      sessionId: batch.map((it) => it.sessionId).find(Boolean) || null,
      ts: head.ts,
      retries: Math.max.apply(null, batch.map((it) => it.retries || 0)),
      needsDedupe: false,
      coalesce: true,
      bubbleEl: null,
    };
    try {
      for (const it of batch) {
        if (it && it.bubbleEl && it.bubbleEl.parentNode) it.bubbleEl.remove();
      }
    } catch (_) { /* a merge-paint hiccup must never lose the text — it lives in `folded` */ }
    _paintOutboxBubble(folded);
    return folded;
  }

  /**
   * Flush the next queued send IN ORDER once the current turn has settled (called from the stream-end
   * finally). ONE in flight at a time: it dispatches a single headless send that re-uses the queued
   * item's already-painted bubble + its clientMsgId (idempotent / at-most-once), and the NEXT item is
   * picked up by that send's own stream-end finally — so the queue drains strictly FIFO, one turn per
   * settle, with no double-send. #830: a run of `coalesce` items (queued in rapid succession while a
   * turn streamed) folds into ONE combined turn here (`_foldOutboxBatch`); a single queued item — and
   * every offline/requeued/restored item — dispatches byte-identical to the per-item path. Guards:
   * never while a stream is live (would race the in-flight turn), never re-entrant. A no-op when the
   * outbox is empty (the overwhelming common case).
   */
  // The flush dispatcher. #1414 R3 PR6: the outbox subsystem moved out of chat.js, so
  // `handleChatSubmit` is no longer in scope here — chat.js registers the SOLE production dispatch
  // (still a headless `handleChatSubmit(null, text, opts)`, so behaviour is byte-identical) through
  // `_setOutboxDispatch` at module-eval. The same swappable ref lets the FIFO/idempotency browser
  // gate spy the dispatch without a real LLM stream. A no-op default keeps a bare (chat.js-less)
  // import inert.
  let _outboxDispatch = () => {};
  export function _setOutboxDispatch(fn) { _outboxDispatch = fn; }
  function _flushSendOutbox() {
    if (chatState._flushingOutbox) return;
    if (chatState.isStreaming) return;            // a turn is in flight — its finally will re-attempt the flush
    if (chatState._sendOutbox.length === 0) return;
    // TEST SEAM (#891 browser gate): lets the reload-durability harness install its dispatch spy
    // before the boot-restore auto-drain can fire. Never set by app code.
    if (typeof window !== 'undefined' && window.__orwellOutboxHoldDrain) return;
    // #891 P0-2: OFFLINE — hold the queue (durable + honestly tagged), arm the backoff, and let the
    // 'online' listener drain the moment the link returns. Never a doomed dispatch.
    if (!_outboxOnline()) { _refreshOutboxStatusTags(); _armOutboxRetry(); return; }
    chatState._flushingOutbox = true;
    // #891: restored / network-requeued items verify against the server log FIRST (at-most-once
    // across a reload — a send whose POST landed but whose confirmation was lost must never
    // re-send). Fail-closed: an unverifiable check keeps the item queued and re-arms the backoff.
    // Runs BEFORE the session gate below: a proven-delivered item must be releasable even while the
    // boot is still re-selecting its session.
    const _preflight = chatState._sendOutbox.some((it) => it && it.needsDedupe)
      ? _dedupeOutboxAgainstServer()
      : Promise.resolve(true);
    _preflight.then((ok) => {
      if (ok === false) { chatState._flushingOutbox = false; _armOutboxRetry(); return; }
      if (chatState.isStreaming || chatState._sendOutbox.length === 0) { chatState._flushingOutbox = false; return; }
      // #891 P1 fix (cross-session bleed — PR #1379 review, Greptile-executed repro): an item's
      // recorded `sessionId` is BINDING — it may only dispatch while ITS session is the currently-
      // selected one, because `_outboxDispatch` submits against current sessionModule state. The
      // old guard only required that SOME session existed, so a restored session-A item dispatched
      // into session B whenever B became current first after a reload. Items bound to a non-current
      // session are HELD in the queue (kept, _flushingOutbox reset, backoff armed — never shifted);
      // they drain when their session is selected (the sessions.js selectSession nudge) or on the
      // retry tick. Earliest-eligible-first preserves per-session FIFO order. An item with NO
      // recorded sessionId was queued before any session existed (pre-session send) — its semantics
      // are current-session-at-dispatch-time: the normal send path materializes/auto-creates,
      // exactly as the inline pre-session send it stands in for would have. A still-`needsDedupe`
      // item (its verification fetch failed above) is never eligible.
      const _cur = (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || null;
      const _idx = chatState._sendOutbox.findIndex((it) =>
        it && !it.needsDedupe && (!it.sessionId || it.sessionId === _cur));
      if (_idx === -1) { chatState._flushingOutbox = false; _armOutboxRetry(); return; }
      let item = _idx === 0 ? chatState._sendOutbox.shift() : chatState._sendOutbox.splice(_idx, 1)[0];
      if (!item) { chatState._flushingOutbox = false; return; }
      // #830: AGGREGATED drain — a rapid-succession run queued while a turn streamed sends as ONE
      // combined turn ("aggregate what you send quickly … it sends all messages in one turn").
      // Collect every later item that (a) opted into the coalesce lane at enqueue time, (b) has no
      // at-most-once ambiguity (`!needsDedupe` — offline/requeued/restored items keep #891's
      // per-item drain), and (c) targets the SAME lane as this dispatch. The collection stops at
      // the first same-lane item that can't join, so conversation order is never shuffled; items
      // held for ANOTHER session are skipped over (an independent lane, untouched). One item ⇒ no
      // fold — byte-identical to the pre-#830 dispatch.
      if (item.coalesce && !item.needsDedupe) {
        const _batch = [item];
        for (let i = 0; i < chatState._sendOutbox.length; ) {
          const it = chatState._sendOutbox[i];
          if (!it) { i++; continue; }
          const _sameLane = !it.sessionId || it.sessionId === _cur;
          if (!_sameLane) { i++; continue; }
          if (it.coalesce && !it.needsDedupe) { _batch.push(chatState._sendOutbox.splice(i, 1)[0]); continue; }
          break;
        }
        if (_batch.length > 1) item = _foldOutboxBatch(_batch);
      }
      // #891: the item stays in the PERSISTED record (awaiting-confirm) until a server row carrying
      // its clientMsgId is observed — a reload mid-flight restores it, and the pre-send dedupe above
      // keeps the re-send at-most-once.
      chatState._outboxAwaitingConfirm.push(item);
      _persistOutbox();
      _updateOutboxStrip(); // #830: the queue just shrank (dispatch and/or fold)
      _setDeliveryState(item.bubbleEl, 'sending'); // #891 F-A7: actually sending now (dim, no queued tag)
      // If the queued bubble was somehow removed from the DOM (a destructive reload before flush), fall
      // back to letting the send paint a fresh one — the text is never lost.
      const bubbleAttached = item.bubbleEl && item.bubbleEl.isConnected;
      // #891 P1 fix (drain starvation — PR #1379 review): the drain is SELF-CONTINUING. A flush
      // attempt that lands while this dispatch is still in flight is swallowed by the
      // `_flushingOutbox` guard (single-flight, correct), and some dispatch paths dead-end WITHOUT
      // ever reaching the stream-end finally that normally re-kicks the drain (an early-return
      // handleChatSubmit — e.g. a failed session materialize / `_abortSendKeepMessage` — schedules
      // no flush and arms no backoff). Either way, a SECOND queued item could sit stuck until some
      // unrelated event (online, session select, an armed timer) happened to nudge the outbox. So:
      // when the dispatch settles and the guard clears, re-invoke the flush ourselves whenever
      // items remain. The re-run re-checks EVERY guard (single-flight, streaming, offline, dedupe,
      // session binding) and either dispatches the next eligible item or parks on the backoff —
      // one hop per settle, so it can never spin.
      const _continueDrain = () => {
        chatState._flushingOutbox = false;
        if (chatState._sendOutbox.length > 0) {
          setTimeout(() => { try { _flushSendOutbox(); } catch (_) {} }, 0);
        }
      };
      try {
        Promise.resolve(
          _outboxDispatch(item.text, {
            queuedClientMsgId: item.clientMsgId,
            queuedBubbleEl: bubbleAttached ? item.bubbleEl : null,
          })
        ).catch(() => {}).finally(_continueDrain);
      } catch (_) {
        _continueDrain();
      }
    }).catch(() => { chatState._flushingOutbox = false; _armOutboxRetry(); });
  }

  // ── #891 P0: durability wiring — boot restore + online/offline honesty. Module-level (the
  // orwellComposerDraft.js / ws-ready precedent): chat.js is evaluated once per page. ──
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('online', () => {
      // The link is back: reset the backoff, cancel any pending long-delay retry, retag, and drain
      // through the normal flush (which re-checks every guard). Small defer so the browser's own
      // connectivity settle (and any 'online'-triggered reconcile) lands first.
      _outboxRetryDelayMs = 0;
      if (_outboxRetryTimer) { clearTimeout(_outboxRetryTimer); _outboxRetryTimer = null; }
      _refreshOutboxStatusTags();
      setTimeout(() => { try { _flushSendOutbox(); } catch (_) {} }, 200);
    });
    window.addEventListener('offline', () => { _refreshOutboxStatusTags(); });
    // Boot restore: attempted on pageshow + a short retry schedule (idempotent — first attempt that
    // finds the chat box wins), so the restored bubbles land after the boot history render instead
    // of being wiped by it. Mirrors the composer-draft boot pattern.
    const _kickOutboxRestore = () => {
      for (const ms of _OUTBOX_BOOT_RETRY_MS) {
        setTimeout(() => { try { _restoreOutboxFromStorage(); } catch (_) {} }, ms);
      }
    };
    window.addEventListener('pageshow', _kickOutboxRestore, { once: true });
    if (document.readyState === 'complete') _kickOutboxRestore();
  }

  /** #891: read the persisted outbox record (browser gate). Exported for chat.js's chatModule
   *  re-export (`_outboxPeekStorage`); the storage key stays module-local here (`_outboxKey`). */
  function _outboxPeekStorage() {
    try { return JSON.parse(sessionStorage.getItem(_outboxKey()) || 'null'); } catch (_) { return null; }
  }

export {
  _enqueueSend,
  _flushSendOutbox,
  _restoreOutboxFromStorage,
  _outboxConfirmDelivery,
  _outboxTrackInflightSend,
  _outboxReleaseInflightSend,
  _outboxHasBlockingSendFor,
  _requeueOutboxItem,
  _isNetworkSendFailure,
  _dedupeOutboxAgainstServer,
  _setDeliveryState,
  _markSendFailedById,
  _retryFailedSend,
  _persistOutbox,
  _updateOutboxStrip,
  _outboxOnline,
  _armOutboxRetry,
  _setQueuedTag,
  _outboxPeekStorage,
};
