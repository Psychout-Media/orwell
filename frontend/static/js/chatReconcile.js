// static/js/chatReconcile.js

/**
 * #1414 (R3 PR7): the cross-device RECONCILE / seq-order / peer-resume cluster (ADR 0008/0012).
 *
 * The next extraction from the chat.js god-object (docs/REFACTOR-ROADMAP.md, R3), building on PR0
 * (chatState.js) + PR1 (chatScrollEdges) + PR2 (chatSubmitButton) + PR3 (chatAttachments) + PR4
 * (chatWsSplice) + PR5 (chatMessageActions) + PR6 (chatOutbox). Moved VERBATIM from chat.js —
 * behavior-preserving, no logic change (the 2-space indentation is kept exactly so the source-pin
 * gates slice unchanged):
 *   - `_historyMsgText` / `_serverMsgId` / `_isSkippableUserPrompt` — the history-row text/id/skip
 *       helpers (isSkippableUserPrompt is the ONE source of truth both this reconcile and sessions.js
 *       filter through; re-exported on chatModule).
 *   - `_msgSeq` / `_insertBySeq` / `_reorderBySeq` — BUG 1 (ADR 0008): render BY the authoritative
 *       `data-seq` (a pure read + the insert choke point + the non-destructive in-place reorder).
 *   - `_isEmptyTurnNoSave` — BUG 2 (#985 P2-B): the pure clean-empty-turn predicate.
 *   - `_visibleMsgCount` / `_isPendingOptimisticBubble` / `_expectedVisibleBubbleCount` — F5 / #873
 *       (dedup hardening): the orphan-aware bubble count + its multi-round oracle.
 *   - `softReloadHistory` — the ADR-0008 render-and-reconcile total-order rebuild (adopt pass →
 *       non-destructive reorder → divergence check → seq-ordered rebuild only when DIVERGED/forced),
 *       the #836 pending-bubble rescue, and the ADR-0012 GAP-2 one-shot forced-rebuild self-guard.
 *   - `flushPendingReconcile` / `deferPeerResume` / `flushPendingPeerResume` — the stream-settle
 *       reconcile flush + the ADR-0012 GAP-1 deferred peer-resume seam.
 *
 * The reconcile Sets (`_pendingReconcile` / `_pendingPeerResume` / `_forceRebuild`) and the outbox
 * queues live on the shared `chatState` singleton (PR0) — read/written as `chatState.X` here exactly
 * as in chat.js, so the submit path (chat.js), the outbox (chatOutbox.js), and this reconcile all
 * serialize on ONE instance. `#1085`/`#1086`/`#873` minefield preserved unchanged: this stays
 * pure-DOM/reconcile with NO session-binding side-effects (binding stays validated-before-subscribe +
 * unbind-on-delete in sessions.js/sessionSync.js, which CALL this cluster via `window.chatModule`).
 *
 * Coupling: three chat.js-internal deps injected at module-eval via `_setReconcileDeps`.
 *   - `hasActiveStream` — the SSE-reader liveness helper. It STAYS in chat.js (it reads the shared
 *     chatState stream maps directly); softReloadHistory + flushPendingPeerResume gate on it.
 *   - `resumeStream` — the live-resume attach. It STAYS in chat.js (the R2 live-render/resume cluster);
 *     flushPendingPeerResume calls it once our own stream settles.
 *   - API_BASE — a chat.js `let` set once in init(). Injected as a `() => API_BASE` resolver, read live
 *     inside `softReloadHistory` (the PR3/PR5/PR6 apiBase pattern) — no stale snapshot.
 * Everything else is importable: chatRenderer / ui / sessions / markdown / chatState, plus
 * `_outboxConfirmDelivery` from chatOutbox.js (the adopt pass releases a delivered outbox copy).
 *
 * Public API preserved: chat.js imports the moved functions and re-exports the browser-gate ones on
 * the `chatModule` object byte-identically (`softReloadHistory`, `flushPendingReconcile`,
 * `deferPeerResume`, `flushPendingPeerResume`, `isSkippableUserPrompt`, `_msgSeq`, `_insertBySeq`,
 * `_reorderBySeq`, `_isEmptyTurnNoSave`, `_visibleMsgCount`, `_expectedVisibleBubbleCount`).
 * sessions.js (`isSkippableUserPrompt`) and sessionSync.js (`softReloadHistory` / `deferPeerResume`)
 * reach this cluster through those `window.chatModule` re-exports, unchanged.
 *
 * Dual-load idempotent (#1399 generalized): the state is chatState-backed (one shared instance); this
 * module holds no module-level timers/listeners. Imported BY chat.js only (never app.js / an html
 * shell), so #1399 single-eval holds.
 */

import chatRenderer from './chatRenderer.js';
import uiModule from './ui.js';
import sessionModule from './sessions.js';
import markdownModule from './markdown.js';
import { chatState } from './chatState.js';
import { _outboxConfirmDelivery } from './chatOutbox.js';

// ── chat.js-internal deps injected at module-eval (see the header) ────────────────
// hasActiveStream (the SSE-reader liveness helper) + resumeStream (the R2 live-resume attach) STAY in
// chat.js; API_BASE is a chat.js `let`. Read them live through these bindings so there is no stale
// snapshot. Safe no-op defaults keep a bare test import inert. The call sites below (`hasActiveStream(
// sessionId)` / `resumeStream(id)` / `${_apiBase()}`) stay byte-identical to the pre-PR7 source.
let hasActiveStream = () => false;
let resumeStream = async () => false;
let _apiBase = () => '';
export function _setReconcileDeps(deps) {
  if (!deps) return;
  if (deps.hasActiveStream) hasActiveStream = deps.hasActiveStream;
  if (deps.resumeStream) resumeStream = deps.resumeStream;
  if (deps.apiBase) _apiBase = deps.apiBase;
}

  /**
   * Cross-device sync: re-render the conversation for `sessionId` from saved
   * history WITHOUT the heavy, draft-clearing selectSession path. Used when
   * another device adds a message to the session this device is viewing. No-op
   * if it isn't the open session, or if this device is mid-stream/resume for it
   * (its own live view is authoritative). Preserves the message input; only
   * touches #chat-history, and only auto-scrolls if already near the bottom.
   */
  // ADR 0008: sessions that DIVERGED while a stream was in flight — reconciled when it ends.
  // → chatState._pendingReconcile (moved to chatState.js, #1414 R3 PR0).
  // ADR 0012 (GAP 1 — the ±1 cross-tab live-attach lag): a PEER's run-started arrived for the
  // canonical session while THIS window's OWN POST stream for that same session was still in flight,
  // so the observer's `!hasActiveStream(id)` guard suppressed the live `resumeStream` attach. The peer
  // run is durable (chained as the current `_RUNS[canonical]`, still `has_run` within the evict grace),
  // so we DON'T drop the invitation — we record it here and RE-ATTEMPT the attach the moment our own
  // stream settles (the finally below). subscribe() replays the peer run's buffer (or its tail) then
  // live-tails, so the deferred attach mirrors the peer turn in lockstep instead of waiting on a later
  // poll/reconcile (the transient one-window-behind offset the 50× smoke caught).
  // → chatState._pendingPeerResume (moved to chatState.js, #1414 R3 PR0).
  // ADR 0012 (GAP 2): sessions whose NEXT softReloadHistory must FORCE the seq-ordered rebuild even if
  // the rendered id-order looks "converged". The error path adopts the live error bubble to the
  // persisted message's {id, seq} (so the divergence check passes) but its CONTENT is still the raw
  // "Error 503", not the persisted friendly fallback — only a content rebuild makes the sender match
  // the peer. The convergence short-circuit is about avoiding flicker on a NORMAL turn; on an error we
  // accept the one rebuild to guarantee identical settled text.
  // → chatState._forceRebuild (moved to chatState.js, #1414 R3 PR0).
  function _historyMsgText(msg) {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) return msg.content.filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
    return '';
  }
  export function _isSkippableUserPrompt(text) {
    const t = (text || '').trim();
    return t === 'Continue where you left off' || t.startsWith('Your message was cut off.') ||
      t.startsWith('Your previous response was interrupted.') ||
      t.includes('[Instruction: Rewrite') || t.includes('[Instruction: Explain') ||
      // OOBE hand-off cues are the producers reaching out — never the player's own words.
      // sendHiddenCue() hides them live; on a history reload / cross-device load the persisted
      // user turn must stay hidden too, or it surfaces as a "You" bubble and breaks immersion
      // (UX audit J1-03). Match the "(Production cue …)" envelope.
      t.toLowerCase().startsWith('(production cue');
  }
  function _serverMsgId(msg) { return msg.id || (msg.metadata && msg.metadata._db_id) || null; }

  /**
   * BUG 1 (ADR 0008 — render BY the authoritative seq, never by arrival order).
   *
   * The server assigns a monotonic `seq` per session (UNIQUE(session_id, seq)); the FE log is a
   * replica of that total order. Every live insert (optimistic user send, stream holder, peer
   * resume holder) is necessarily append-to-bottom because seq isn't known until the row persists —
   * so two turns whose persistence interleaves (a peer write racing the local turn, two windows)
   * could sit in ARRIVAL order, not seq order. Reconcile (`softReloadHistory`) rebuilds in seq order
   * but only when DIVERGED and only when idle, leaving a visible out-of-seq window mid-stream.
   *
   * The structural fix: a single seq read (`_msgSeq`) + a single non-destructive reorder
   * (`_reorderBySeq`) that the reconcile's ADOPT PASS runs on every reconcile attempt (it runs even
   * while a stream is in flight — the `hasActiveStream` early-return is AFTER the adopt pass). A
   * bubble that has been stamped with `data-seq` is moved into ascending-seq position WITHOUT a DOM
   * wipe, reordering ONLY among the seq'd bubbles' own slots; bubbles with NO seq yet (a still-pending
   * optimistic send, the LIVE streaming holder, an un-adopted orphan) and non-`.msg` nodes (tool
   * threads) never move — so the live holder is never torn from its threads. Idempotent: a no-op when
   * already ordered (the overwhelming common case). This makes it STRUCTURALLY impossible for an adopted
   * bubble to remain out of seq order relative to server truth.
   */
  export function _msgSeq(el) {
    if (!el || !el.dataset || el.dataset.seq == null || el.dataset.seq === '') return null;
    const n = Number(el.dataset.seq);
    return Number.isFinite(n) ? n : null;
  }

  /** Insert `el` into `box` at its `data-seq` position: before the first existing `.msg` whose seq
   * is strictly greater. No seq on `el` (a pending/optimistic send) ⇒ append to bottom (the newest
   * local turn). Used at the live insert sites so a bubble that DOES know its seq lands ordered. */
  export function _insertBySeq(box, el) {
    if (!box || !el) return;
    const s = _msgSeq(el);
    if (s == null) { box.appendChild(el); return; }
    const kids = box.querySelectorAll('.msg');
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] === el) continue;
      const ks = _msgSeq(kids[i]);
      if (ks != null && ks > s) { box.insertBefore(el, kids[i]); return; }
    }
    box.appendChild(el);
  }

  /** Non-destructive in-place reorder of the SEQ'D message bubbles in `#chat-history` to ascending
   * `data-seq`. DELIBERATELY CONSERVATIVE: it reorders ONLY the `.msg[data-seq]` bubbles among
   * themselves, reassigning them into the very DOM SLOTS those seq'd bubbles already occupy. Everything
   * else — no-seq bubbles (a still-pending optimistic send, the LIVE streaming holder, an un-adopted
   * orphan) AND non-`.msg` nodes (`.agent-thread` tool groups, decision cards, notices) — stays exactly
   * where it is, so a mid-stream reconcile can never tear the live holder away from its tool threads or
   * disturb thread `has-top`/`has-bottom` adjacency. A persisted bubble that landed out of arrival-vs-seq
   * order (a peer write racing the local turn, two interleaved `message_saved`s) is moved into its seq
   * slot WITHOUT a DOM wipe. Idempotent: zero churn when already ordered. Returns the count of bubbles
   * actually moved so callers/tests can detect a real correction. */
  export function _reorderBySeq(box) {
    if (!box) return 0;
    // The slots: the current DOM positions held by seq'd bubbles. We only ever permute WITHIN these.
    const seqd = Array.from(box.querySelectorAll('.msg')).filter(el => _msgSeq(el) != null);
    if (seqd.length < 2) return 0;
    const wantOrder = seqd.slice().sort((a, b) => {
      const as = _msgSeq(a), bs = _msgSeq(b);
      if (as !== bs) return as - bs;          // ascending seq
      return seqd.indexOf(a) - seqd.indexOf(b); // seq tie → preserve current relative order (stable)
    });
    // Already ordered? (common case — bail with zero churn).
    let same = true;
    for (let i = 0; i < seqd.length; i++) { if (wantOrder[i] !== seqd[i]) { same = false; break; } }
    if (same) return 0;
    // Reorder WITHIN the seq'd slots only: drop an empty placeholder where each seq'd bubble currently
    // sits (preserving the exact slot positions among all the OTHER, untouched nodes), detach the seq'd
    // bubbles, then fill the placeholders in ascending-seq order. No-seq bubbles (the live streaming
    // holder, a pending optimistic send) and non-`.msg` nodes (tool threads, cards) never move — their
    // surrounding placeholders are swapped under them.
    const marks = seqd.map(() => document.createComment('seq-slot'));
    for (let i = 0; i < seqd.length; i++) box.replaceChild(marks[i], seqd[i]);
    let moved = 0;
    for (let i = 0; i < marks.length; i++) {
      if (wantOrder[i] !== seqd[i]) moved += 1;   // this slot's occupant changed
      box.replaceChild(wantOrder[i], marks[i]);
    }
    return moved;
  }

  /**
   * F-5 / N-10 (playtest blocker, 2026-11-03): is this assistant bubble a HEADER-ONLY shell — a holder that mounted for a pure-tool or
   * pre-resolved round and never received any body content? Playtest shots show one "Production HH:MM" empty bubble directly above the real
   * reply on nearly every game-phase turn (agent_step un-hides the pure-tool round's holder; the narration then lands in another bubble).
   * Conservative by design — an element is "empty" only when ALL of these hold, so a live or meaningful bubble is never touched:
   *   · it is an assistant bubble (`.msg-ai`) and NOT live (`.streaming`);
   *   · it is not a persisted row (`data-db-id`) — the server's history is authoritative for persisted rows;
   *   · its `.body` has no non-whitespace text, no media (img/video/audio/canvas/iframe/svg), no controls (button/a), no decision/retry
   *     card, no spinner/thinking chrome that is actually VISIBLE (a hidden debug accordion does not count as content).
   */
  export function isEmptyAssistantBubble(el) {
    if (!el || !el.classList || !el.classList.contains('msg-ai')) return false;
    if (el.classList.contains('streaming')) return false;
    if (el.dataset && el.dataset.dbId) return false;
    const body = el.querySelector('.body');
    if (!body) return false;
    // innerText (CSS-aware) so text inside a display:none debug accordion does not count as content; textContent as the detached-node fallback.
    if (((body.innerText !== undefined ? body.innerText : body.textContent) || '').trim()) return false;
    if (body.querySelector('img,video,audio,canvas,iframe,svg,button,a,input,textarea,[class*="retry"],[class*="decision"],[class*="odec"]')) return false;
    for (const chrome of body.querySelectorAll('[class*="spinner"],[class*="thinking"],.agent-thread')) {
      let visible = true;
      // getClientRects is empty for an element OR any ancestor that is display:none (a hidden debug accordion's children included).
      try { visible = chrome.getClientRects().length > 0; } catch (_) { /* assume visible */ }
      if (visible) return false;
    }
    return true;
  }

  /** Remove every header-only assistant bubble under `box`; returns how many were removed (idempotent). */
  export function pruneEmptyAssistantBubbles(box) {
    if (!box || !box.querySelectorAll) return 0;
    let removed = 0;
    for (const el of Array.from(box.querySelectorAll('.msg.msg-ai'))) {
      if (isEmptyAssistantBubble(el)) { el.remove(); removed++; }
    }
    return removed;
  }

  /**
   * BUG 2 (#985 P2-B): the CLEAN-EMPTY-TURN predicate — pure so it can be gated without a live stream.
   * True iff the stream ended cleanly (a `[DONE]`, not a thrown drop), persisted NO message
   * (`!sawSave`), produced NO other visible artifact (`!producedVisible` — image/ask_user/budget/error),
   * had NO assistant content (`accumulated` blank), and was NOT user-cancelled. That is the
   * "backend produced no turn" state the FE must surface with a user-controlled Retry — distinct from
   * a network drop (thrown error ⇒ the existing `_tryAutoRecover`/`_renderStreamDropRetry` path) and
   * from a reasoning-only turn (non-blank `accumulated`, handled by the thinking-display branch).
   */
  export function _isEmptyTurnNoSave({ sawDone, sawSave, producedVisible, accumulated, cancelled } = {}) {
    return !!sawDone && !sawSave && !producedVisible && !cancelled &&
      (accumulated == null || String(accumulated).trim() === '');
  }

  /**
   * CASTING-RESUME-HANG Fix 3 (the likely ACTUAL hang): a framed CASTING turn can settle to
   * reasoning-only — a long thinking trace with an EMPTY VISIBLE reply and no tool call. `accumulated`
   * (merged reply + reasoning) is NON-blank there, so `_isEmptyTurnNoSave` above is false and no Retry
   * arms; the reasoning renders into the "Thinking" accordion and the interview just HANGS. None of the
   * auto-continue paths catch it — they fire on truncation / interruption / step-limit (a cut-off), not
   * on a clean empty completion. This pure predicate decides whether to fire exactly ONE bounded
   * re-prompt: true iff we're in the CASTING register (game build, season NOT started), the stream ended
   * cleanly (a `[DONE]`, not thrown/cancelled), the turn used NO tools and produced NO visible artifact,
   * the VISIBLE reply is empty, THE TURN HAD REASONING (`hadReasoning` — a non-blank `accumulated`), and
   * the one-shot re-prompt has not already fired. SCOPED to casting — in-game empty turns keep their
   * existing behavior. Pure so it is gated without a live stream.
   *
   * The `hadReasoning` gate is load-bearing (review #1595): it makes this predicate MUTUALLY EXCLUSIVE
   * with `_isEmptyTurnNoSave` above (which fires only when `accumulated` is BLANK). A fully-silent
   * completion (no reasoning, no reply) is the no-content case → it takes ONLY the clean-empty Retry
   * path; a reasoning-only completion (non-blank `accumulated`, empty visible reply) is THIS case → it
   * takes ONLY the bounded re-prompt. Without it, a silent turn would trip BOTH — a Retry banner AND an
   * auto re-prompt in the same turn.
   */
  export function _isCastingEmptyReplyReprompt({
    gameBuild, seasonStarted, sawDone, cancelled, usedTools, producedVisible, visibleReply, hadReasoning, alreadyReprompted,
  } = {}) {
    return !!gameBuild && !seasonStarted && !!sawDone && !cancelled &&
      !usedTools && !producedVisible && !!hadReasoning && !alreadyReprompted &&
      (visibleReply == null || String(visibleReply).trim() === '');
  }

  // #1785: minimum char threshold for a viable turn reply. Anything shorter is degenerate
  // (a bare "The" or a single punctuation mark). Flagged for PO tuning post-merge — the
  // conservative default of 3 catches only truly empty/near-empty generations.
  const _MIN_VIABLE_TURN_CHARS = 3;

  /**
   * #1785 (F8): minimum-viable-turn gate. True iff the visible reply is below a conservative
   * length threshold OR carries a dangling-markdown syntax error (unclosed **, odd backticks,
   * trailing lone `*` or `_`). Pure structural pattern matching — no product tuning.
   *
   * Two halves OR'd together:
   *   1. LENGTH-threshold: visibleReply is shorter than _MIN_VIABLE_TURN_CHARS chars.
   *      A valid short reply like "Yes." (4 chars) must NOT trip it.
   *   2. DANGLING-MARKDOWN: visibleReply ends mid-token — unclosed **, an odd count of
   *      unescaped backticks, a trailing lone * or _ not followed by content.
   *
   * Mutually compatible with siblings: fully-blank is caught by _isEmptyTurnNoSave first;
   * the reasoning-only casting hang is caught by _isCastingEmptyReplyReprompt first.
   */
  export function _isBelowThresholdOrDanglingTurn({ sawDone, cancelled, usedTools, producedVisible, visibleReply, alreadyGated } = {}) {
    if (!sawDone || cancelled || usedTools || producedVisible || alreadyGated) return false;
    if (visibleReply == null || visibleReply === '') return false;  // fully-blank goes to _isEmptyTurnNoSave
    const text = String(visibleReply);
    // ── LENGTH threshold ──
    if (text.length < _MIN_VIABLE_TURN_CHARS) return true;
    // ── DANGLING-MARKDOWN checks ──
    // Unclosed ** (odd number of ** pairs, i.e. odd count of ** occurrences)
    const doubleStarMatches = text.match(/\*\*/g);
    if (doubleStarMatches && doubleStarMatches.length % 2 !== 0) return true;
    // Odd count of unescaped backticks (backtick not preceded by backslash)
    const backtickMatches = text.match(/(?<!\\)`/g);
    if (backtickMatches && backtickMatches.length % 2 !== 0) return true;
    // Trailing lone * or _ not followed by content (end of string, or followed by space/punctuation)
    if (/[*_]$/.test(text)) return true;
    // Trailing lone * or _ followed only by whitespace/punctuation at the very end
    if (/[*_]\s*$/.test(text)) return true;
    return false;
  }

  /**
   * F5 (dedup hardening): count the message bubbles that SHOULD map 1:1 to a persisted server message
   * — i.e. exclude rows that are intentionally hidden (display:none): a tool-only continuation round
   * (chat.js ~2780) and a skippable production-cue user bubble. Those have no server counterpart, so
   * they must not inflate the count. Everything else visible (a real user bubble, a real AI bubble, and
   * crucially an ORPHANED continuation/finalize bubble) counts. softReloadHistory compares this to the
   * server's visible-message count to detect an orphan a pure id-order check is blind to. Pure (DOM in,
   * number out) and exported so the reconcile contract is unit-testable without a live stream.
   */
  export function _visibleMsgCount(box) {
    if (!box) return 0;
    let n = 0;
    box.querySelectorAll('.msg').forEach((el) => {
      // A bubble explicitly hidden via inline style is an intermediate/skipped row with no
      // server message — don't count it. (Hidden via class is rare; the live hide uses style.display.)
      const hidden = (el.style && el.style.display === 'none');
      if (hidden) return;
      // #836 / "never eat a message": an UN-ADOPTED optimistic send (clientMsgId, no dbId yet) is a
      // legitimate PENDING user bubble, NOT an orphan — its persisted row simply hasn't reached THIS
      // /api/history snapshot (canonical-vs-per-tab adoption, an SSE reconcile racing the just-committed
      // row, or a non-persisted/incognito turn). Excluding it from the divergence count means it never
      // forces a destructive rebuild on its own; combined with the rebuild-time preservation in
      // softReloadHistory it can never be ERASED. The next reload adopts it once its row appears.
      if (_isPendingOptimisticBubble(el)) return;
      n += 1;
    });
    return n;
  }

  /** #836 — a still-pending optimistic user send: carries a clientMsgId but has not yet been adopted
   * (no dbId). Mirrors the sessions.js `wouldWipe` guard — such a bubble must SURVIVE any reconcile so
   * "what I typed goes in the bubble, verbatim, every time" can never be violated by the rebuild. */
  export function _isPendingOptimisticBubble(el) {
    if (el && el.dataset && !el.dataset.dbId && el.classList && (el.classList.contains('msg-ai') || el.classList.contains('msg-system')) && el.querySelector('.stream-drop-retry')) return true;  // ORW-96: a no-[DONE] drop's Retry holder has no server row either - the rebuild must not erase the player's only recourse
    return !!(el && el.dataset && el.dataset.clientMsgId && !el.dataset.dbId);
  }

  /**
   * mirror-toolturn fix: ONE persisted agent message can legitimately render as MULTIPLE `.msg`
   * bubbles — chatRenderer.addMessage's "Agent multi-bubble reconstruction" (chatRenderer.js
   * ~1929) re-splits a message carrying `metadata.tool_events`/`round_texts` back into one bubble
   * PER non-empty narration round, so a re-opened multi-round tool-rich turn reads exactly as it
   * streamed live instead of collapsing into one blob (L6c). `_visibleMsgCount(box) ===
   * visible.length` (the OLD orphan check) never accounted for this: a 2-narration-round turn is
   * ALWAYS 2 bubbles for 1 server message, so the check NEVER converged for a tool-rich turn —
   * softReloadHistory retried a full destructive rebuild on every single reconcile trigger
   * forever. Each rebuild reproduced the identical correct render (chatRenderer.addMessage is
   * deterministic from the same metadata), so this never showed as a literal duplicate, but it
   * silently burned a `/api/history` fetch + full DOM wipe+rebuild on every peer ping — pure churn
   * that widens the window for an unrelated concurrent mutation to interleave. Count bubbles the
   * SAME way addMessage does so a fully-reconciled multi-round turn actually reads "converged".
   */
  export function _expectedVisibleBubbleCount(visible) {
    let n = 0;
    for (const msg of (visible || [])) {
      const meta = msg && msg.metadata;
      if (meta && Array.isArray(meta.tool_events) && meta.tool_events.length) {
        const roundTexts = Array.isArray(meta.round_texts) ? meta.round_texts : [];
        const textRounds = roundTexts.filter((t) => (t || '').trim()).length;
        n += Math.max(1, textRounds);
      } else {
        n += 1;
      }
    }
    return n;
  }

  // F-5: liveness probe for the empty-bubble sweep (a thin wrapper so the reconcile body's own hasActiveStream ordering stays pinned).
  const _streamIsLive = (sid) => hasActiveStream(sid);

  /**
   * ORW-168: can this reconcile be answered by the newest server row alone? Only when the DOM is a plain, fully-adopted, idle
   * transcript: no live stream, no one-shot forced rebuild, no optimistic/unadopted bubble, every visible bubble carries its
   * {db-id, seq}, and the tail bubble IS the server's newest row (same id and seq) while the server's row count equals the number
   * of distinct rendered messages. Then there is nothing to adopt, reorder, rescue or rebuild and the full fetch would be a no-op.
   * Returns {converged:true}; or {data} when the server ignored `limit` and sent the whole log; or null = take the normal path.
   * Pure read: no DOM write, no one-shot flag consumed.
   */
  async function _convergedProbe(sessionId) {
    try {
      const box = document.getElementById('chat-history');
      if (!box || hasActiveStream(sessionId) || chatState._forceRebuild.has(sessionId)) return null;
      const bubbles = Array.from(box.querySelectorAll('.msg')).filter((el) => !(el.style && el.style.display === 'none'));
      if (!bubbles.length) return null;
      if (bubbles.some((el) => _isPendingOptimisticBubble(el) || !el.dataset.dbId || !el.dataset.seq)) return null;
      if (box.querySelector('.msg.msg-ai[data-kept-live], .msg.msg-ai[data-live-holder]')) return null;
      const ids = bubbles.map((el) => el.dataset.dbId).filter((v, i, a) => v !== a[i - 1]);
      const last = bubbles[bubbles.length - 1];
      const res = await fetch(`${_apiBase()}/api/history/${sessionId}?limit=1`);
      if (!res.ok) return null;
      const body = await res.json();
      const page = body && body.page;
      if (!page) return (body && Array.isArray(body.history)) ? { data: body } : null;   // old server: it sent everything
      const row = (body.history || [])[0];
      if (!row || (body.history || []).length !== 1) return null;
      if (_serverMsgId(row) !== last.dataset.dbId || String(row.seq) !== last.dataset.seq) return null;
      if (page.total !== ids.length) return null;
      return { converged: true };
    } catch (_) { return null; }
  }

  /**
   * ADR 0008 — render-and-reconcile to the authoritative seq-ordered log.
   *
   * The chat conversation is a FE-replicated log; the audit (S3-RACE) proved two tabs diverge
   * under concurrent writes because the sender was optimistic-only and a busy tab dropped the
   * peer's events. This reconciles every tab to the server's `seq` total order WITHOUT a blanket
   * full rebuild:
   *   1. ADOPT PASS — stamp the canonical {id, seq} onto already-rendered bubbles (matching by db
   *      id OR the optimistic client-temp id). Gives the sender read-your-writes with zero churn.
   *   2. DIVERGENCE CHECK — if the rendered id order already equals the server seq order, return
   *      (no flicker in the overwhelming common case).
   *   3. Only when DIVERGED: defer if a stream is live (don't stomp it), else do the clean
   *      seq-ordered rebuild — identical to a manual reload, which the audit proved converges.
   */
  export async function softReloadHistory(sessionId) {
    if (!sessionId) return;
    const isCurrent = () => !sessionModule || !sessionModule.getCurrentSessionId ||
      sessionModule.getCurrentSessionId() === sessionId;
    if (!isCurrent()) return;

    // Sweep header-only assistant shells, but NEVER while a stream is live: a peer/observer holder is empty until its first delta.
    try { if (!_streamIsLive(sessionId)) pruneEmptyAssistantBubbles(document.getElementById('chat-history')); } catch (_) { /* never block the reconcile */ }
    let data;
    try {
      // ORW-168: an idle, already-converged reconcile (the overwhelming common case) needs the newest server row, not the whole
      // transcript. Probe with ?limit=1 and compare it with the DOM; ANYTHING that doesn't match exactly falls through to the
      // unchanged full fetch below (an older server that ignores `limit` hands back the full log, which is then used as-is).
      const probe = await _convergedProbe(sessionId);
      if (probe && probe.converged) { chatState._pendingReconcile.delete(sessionId); return; }
      if (probe && probe.data) data = probe.data;
      else {
        const res = await fetch(`${_apiBase()}/api/history/${sessionId}`);
        if (!res.ok) return;
        data = await res.json();
      }
    } catch (_) { return; }
    if (!isCurrent()) return;

    const box = document.getElementById('chat-history');
    if (!box) return;
    const modelName = data.model || null;
    // Authoritative seq-ordered log (the API orders by seq), minus the continuation/instruction
    // prompts the live view never shows.
    const visible = (data.history || [])
      .filter(m => !(m.role === 'user' && _isSkippableUserPrompt(_historyMsgText(m))));

    // 1) ADOPT PASS — no DOM churn.
    const byId = new Map(), byClient = new Map();
    box.querySelectorAll('.msg').forEach((el) => {
      if (el.dataset.dbId) byId.set(el.dataset.dbId, el);
      if (el.dataset.clientMsgId) byClient.set(el.dataset.clientMsgId, el);
    });
    for (const msg of visible) {
      const sid = _serverMsgId(msg);
      const cid = msg.metadata && msg.metadata.client_msg_id;
      // #891: a server row carrying this clientMsgId PROVES delivery — release the reload-durable
      // outbox copy (awaiting-confirm) so it can never re-send. Cheap no-op when nothing is queued.
      if (cid) _outboxConfirmDelivery(cid);
      const el = (sid && byId.get(sid)) || (cid && byClient.get(cid)) || null;
      if (el) {
        if (sid) { el.dataset.dbId = sid; byId.set(sid, el); }
        if (msg.seq != null) el.dataset.seq = String(msg.seq);
        // OOC retro-styling (live half): a message classified OUT-OF-CHARACTER after the fact —
        // server metadata `ooc: true`, NO `((...))`/`ooc:` markers in the text — must style the
        // ALREADY-RENDERED bubble the moment the row is observed, not only on the next full reload
        // (the classic live-vs-reload divergence class, ADR 0015). Rides the adopt pass (zero DOM
        // churn) through chatRenderer's shared metadata half, which self-gates on the game build +
        // role and is additive-only (it never strips a marker-applied class).
        if (chatRenderer.applyOocClassFromMetadata) {
          chatRenderer.applyOocClassFromMetadata(el, msg.metadata, msg.role);
        }
      }
    }

    // BUG 1 — REORDER PASS (non-destructive). Now that every matched bubble carries its authoritative
    // `data-seq`, move any that are out of seq order back into place WITHOUT a DOM wipe. This runs on
    // EVERY reconcile attempt — including the "converged"/early-return common case below AND while a
    // stream is in flight (the `hasActiveStream` early-return is further down), so a bubble that was
    // appended out of arrival-vs-seq order (a peer write racing the local turn, two interleaved
    // `message_saved`s) is corrected the instant its seq is known, not only when a destructive rebuild
    // finally fires. Idempotent: zero churn when already ordered. A still-pending optimistic send (no
    // seq) keeps its place at the tail — exactly where the newest local turn belongs.
    _reorderBySeq(box);

    // 2) DIVERGENCE CHECK — rendered id order vs. server seq order.
    // ADR 0012 (GAP 2): an error turn forces ONE content rebuild — the error bubble may already carry
    // the persisted message's {id, seq} (so the id-order is "converged") while showing the raw error
    // text, not the persisted fallback. Consume the one-shot flag so subsequent reloads are normal.
    // SELF-GUARD: only honor the force when the server actually has at least as many messages as are
    // rendered — i.e. there IS a persisted message to converge to. A hard fail that persisted NOTHING
    // (server has fewer messages) keeps its live error bubble rather than the rebuild erasing it.
    let _forced = chatState._forceRebuild.delete(sessionId);
    const renderedCount = box.querySelectorAll('.msg').length;
    if (_forced && visible.length < renderedCount) _forced = false;
    // A multi-round tool-rich message legitimately renders as SEVERAL contiguous bubbles sharing
    // the same data-db-id (chatRenderer.addMessage's multi-bubble reconstruction — see
    // _expectedVisibleBubbleCount above). Collapse consecutive duplicate ids before comparing to
    // the server's one-id-per-message order, so such a turn can actually reach "converged" instead
    // of id-order matching by coincidence while the orphan check below never converges.
    const renderedIdsRaw = Array.from(box.querySelectorAll('.msg[data-db-id]')).map((el) => el.dataset.dbId);
    const renderedIds = renderedIdsRaw.filter((v, i) => v !== renderedIdsRaw[i - 1]);
    const serverIds = visible.map(_serverMsgId).filter(Boolean);
    // F5 (dedup hardening): the id-order check alone is BLIND to a db-id-LESS ORPHAN bubble — a
    // continuation/round bubble (multi-round agent turn) or a resume finalize-in-place bubble that
    // never received its data-db-id. Such an orphan is invisible to `renderedIds` (which selects only
    // `.msg[data-db-id]`), so the rendered id-order could equal the server seq-order ("converged")
    // WHILE an extra duplicate bubble sits on screen → the dup survived every reload (issue #873 / F5).
    // Count VISIBLE message bubbles (excluding the hidden tool-only / production-cue rows, which are
    // display:none and have no server counterpart) and require it to equal the server's EXPECTED
    // visible-bubble count (accounting for multi-round reconstruction, not a raw 1:1 message count).
    // A mismatch means a genuine orphan (or a missing bubble) is present → NOT converged → rebuild to
    // the authoritative log, which collapses the orphan with ZERO net churn on the already-correct case.
    const orphanFree = _visibleMsgCount(box) === _expectedVisibleBubbleCount(visible);
    // S17: a live holder that selectSession KEPT across a history repaint (marked `data-kept-live`) is id-converged once adopted by dbId but was never FINALIZED (no footer, live-path header), so a
    // window that joined a run mid-generation settled on a different transcript than a fresh window. Such a bubble is not converged: rebuild it from the authoritative log. Only marked
    // bubbles count, so every other adopted bubble keeps the zero-churn contract (#873 / #985).
    const liveUnfinalized = Array.from(box.querySelectorAll('.msg.msg-ai[data-kept-live], .msg.msg-ai[data-live-holder]')).some((el) =>
      !(el.style && el.style.display === 'none') && !el.querySelector('.msg-footer'));
    const converged = orphanFree && !liveUnfinalized &&
      renderedIds.length === serverIds.length &&
      renderedIds.every((v, i) => v === serverIds[i]);
    if (converged && !_forced) { chatState._pendingReconcile.delete(sessionId); return; }

    // 3) DIVERGED (or forced) — defer past a live stream, else rebuild to the authoritative order.
    if (hasActiveStream(sessionId)) {
      chatState._pendingReconcile.add(sessionId);
      if (_forced) chatState._forceRebuild.add(sessionId);   // re-arm the one-shot force for the deferred flush
      return;
    }
    chatState._pendingReconcile.delete(sessionId);

    // #836 / "never eat a message": before we blow away the DOM, RESCUE any still-pending optimistic
    // user bubble (clientMsgId, no dbId) whose persisted row is ABSENT from this server snapshot — so the
    // authoritative rebuild can NEVER erase what the player just typed. A bubble whose client_msg_id IS
    // present in `visible` is re-rendered from the server log below (no rescue needed); only the un-adopted
    // pending sends are carried across, then normal adoption reconciles them when their row appears.
    const _serverClientIds = new Set(
      visible.map(m => m.metadata && m.metadata.client_msg_id).filter(Boolean)
    );
    const _pendingToPreserve = Array.from(box.querySelectorAll('.msg'))
      .filter(el => _isPendingOptimisticBubble(el) && !_serverClientIds.has(el.dataset.clientMsgId));

    const nearBottom = (box.scrollHeight - box.scrollTop - box.clientHeight) < 120;
    const prevScrollTop = box.scrollTop;
    box.classList.add('no-animate');
    box.innerHTML = '';
    for (const msg of visible) {
      const meta = msg.metadata ? { ...msg.metadata, _fromHistory: true } : { _fromHistory: true };
      chatRenderer.addMessage(msg.role, markdownModule.renderContent(_historyMsgText(msg)), modelName, meta);
    }
    // Re-append the rescued pending sends after the authoritative log (they are the newest turn — the row
    // the server hasn't surfaced yet). They keep their clientMsgId so the next reload's adopt pass claims
    // them with zero churn the moment /api/history carries their persisted row.
    for (const el of _pendingToPreserve) box.appendChild(el);
    box.classList.remove('no-animate');
    if (nearBottom) {
      if (uiModule.scrollHistoryInstant) uiModule.scrollHistoryInstant();
      else if (uiModule.scrollHistory) uiModule.scrollHistory();
    } else {
      // Reader was scrolled up — keep their place (new content was appended below).
      box.scrollTop = prevScrollTop;
    }
  }

  /** ADR 0008: flush a reconcile deferred because a stream was in flight (called at stream end).
   * Returns the softReloadHistory promise so callers can sequence work AFTER the rebuild settles
   * (the GAP-1 peer-resume chains on it so the peer's user turn is adopted before its reply attaches). */
  export function flushPendingReconcile(sessionId) {
    const id = sessionId || (sessionModule && sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId());
    if (!id) return Promise.resolve();
    // Always run once at stream end: the adopt pass alone (cheap, no churn) gives the sender
    // read-your-writes even when nothing diverged; if it DID diverge, this does the rebuild.
    chatState._pendingReconcile.delete(id);
    try { return Promise.resolve(softReloadHistory(id)).catch(function () {}); } catch (_) { return Promise.resolve(); }
  }

  /**
   * ADR 0012 (GAP 1): note a peer's run-started that we couldn't attach to LIVE because our own
   * stream was in flight, so the stream-end finally can RE-ATTEMPT the attach. Called from
   * sessionSync's run-started handler. Idempotent (a Set); no-op if no resume seam exists.
   */
  export function deferPeerResume(sessionId) {
    if (!sessionId) return;
    chatState._pendingPeerResume.add(sessionId);
  }

  /**
   * ADR 0012 (GAP 1): flush a peer-resume deferred because OUR stream was in flight (called at
   * stream end). Now that our stream has settled, attach to the canonical run so we mirror the peer's
   * turn LIVE. resumeStream's own guards make this safe + idempotent: it no-ops if another reader is
   * already live for the session (hasActiveStream) and replays a just-finished run's buffer within the
   * evict grace; if the run is already gone, softReloadHistory has the settled message anyway.
   */
  export function flushPendingPeerResume(sessionId) {
    const id = sessionId || (sessionModule && sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId());
    if (!id) return;
    if (!chatState._pendingPeerResume.has(id)) return;
    chatState._pendingPeerResume.delete(id);
    // Only attach if we're still viewing this session and nothing else is already rendering it live.
    const onIt = !sessionModule || !sessionModule.getCurrentSessionId ||
                 sessionModule.getCurrentSessionId() === id;
    if (!onIt) return;
    if (hasActiveStream(id)) return;          // a newer stream took over — it owns the render
    try { resumeStream(id); } catch (_) {}
  }
