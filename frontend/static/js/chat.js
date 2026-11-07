// static/js/chat.js

/**
 * Main chat functionality - message handling and streaming
 */
// ES6 module — IIFE removed

import Storage from './storage.js';
import uiModule from './ui.js';
import sessionModule from './sessions.js';
import chatRenderer from './chatRenderer.js';
import chatStream from './chatStream.js';
import { ORWELL_TOOL_BEATS as _orwellToolBeats, orwellBeatOutcome, isGameBuild, isSeasonStarted, orwellBeatIsSilent, ORWELL_MAX_VISIBLE_BEATS, gameNarrator, setGameNarrator, orwellCeremonySlate, orwellRenderCeremonySlate, narratorWaitCopy } from './orwellToolBeats.js';
import { addAITTSButton } from './tts-ai.js';
import markdownModule from './markdown.js';
import { svgifyEmoji } from './markdown.js';
import planWindowModule from './planWindow.js';
import spinnerModule from './spinner.js';
import presetsModule from './presets.js';
import fileHandlerModule from './fileHandler.js';
import codeRunnerModule from './codeRunner.js';
import slashCommands, { initSlashCommands, isCommand, handleSlashCommand, handleSetupInput, handleSetupWizard, typewriterInto } from './slashCommands.js';
// Game build (feature 0032): workspace verticals removed — null stubs for guarded usage sites.
const searchModule = null, documentModule = null, emailInbox = null, createResearchSynapse = null;
import { createStreamRenderer } from './streamingRenderer.js';
import { isNarrow } from './platform.js';
// #1414 (R3 PR0): chat.js's cross-cluster module-level mutable state (streaming flags, the send
// outbox, the reconcile sets, background-stream maps, single-flight guards) lives on ONE shared
// singleton so the modules chat.js will be decomposed into can mutate the SAME instance (an ES
// imported binding is read-only; a shared object's fields are not). Behavior-preserving: chat.js
// still owns all the logic and just references `chatState.X` where it used to reference `X`.
import { chatState } from './chatState.js';
// #1414 (R3 PR1): the #738 scroll-edge mask + recede-on-scroll banner — the first leaf
// extraction from this god-object. Behavior-preserving: chat.js still calls
// _initChatScrollEdges() from init() exactly as before, the logic just lives in its own
// module now. Imported here only (never app.js / an html shell) so #1399 single-eval holds.
import { _initChatScrollEdges } from './chatScrollEdges.js';
// #1414 (R3 PR2): the composer submit-button state machine (#971 button reconciler / #986).
// Behavior-preserving: chat.js calls these three exactly as before — updateSubmitButton() to paint
// the Stop/Send face, and _foregroundStreamLive()/_syncSubmitButtonState() to reconcile it to the
// true streaming state. They read/write the shared streaming single-flight state via the chatState
// singleton (PR0). Imported here only, so #1399 single-eval holds; the two on the chatModule public
// API (_syncSubmitButtonState / _foregroundStreamLive) are re-exported below byte-identically.
import { updateSubmitButton, _foregroundStreamLive, _syncSubmitButtonState } from './chatSubmitButton.js';
// #1414 (R3 PR3): chat attachment opening (image → new tab; pdf/text/code → Documents viewer;
// anything else → raw file). Behavior-preserving: chat.js re-exports `openAttachment` on the
// chatModule public API below (chatRenderer.js calls it via window.chatModule.openAttachment), and
// injects the API_BASE resolver so the module reads chat.js's live value. Imported here only, so
// #1399 single-eval holds.
import { openAttachment, _setAttachmentsApiBase } from './chatAttachments.js';
// #1414 (R3 PR4): the WebSocket Phase-1 chat live-splice cluster (ADR 0017). Behavior-preserving:
// the splice was already isolated behind _wsRegisterChat; chat.js still drives the same call points
// (_wsChatActive/_wsPinRound in handleChatSubmit's up-frame reroute, _wsResetRound on refusal, and
// the boot registration below), and injects the three chat.js-internal deps the consumer reads
// (_renderLiveStream — the R2 render seam; softReloadHistory — reconcile; _senderLabel — the single-
// source sender label) via _setWsSpliceDeps, mirroring the PR2/PR3 injection pattern. None of these
// are on the chatModule public API. Imported here only, so #1399 single-eval holds.
import { _wsChatActive, _wsResetRound, _wsPinRound, _wsRegisterChat, _onWsResync, _onWsRunBoundary, _setWsSpliceDeps } from './chatWsSplice.js';
// #1414 (R3 PR5): the per-message actions cluster — edit / resend / regenerate / variant-nav /
// fork / delete / rewrite / continue. Behavior-preserving: the 8 action functions are called
// cross-file by chatRenderer.js via window.chatModule.<fn> (the per-message footer buttons), so
// chat.js re-exports them on the chatModule public API below byte-identically; _attachVariantNav is
// imported because the stream-finalize path here still calls it. Re-entrancy: editUserMessage /
// resendUserMessage / regenerateFrom / continueFrom RE-ENTER the send via handleChatSubmit, which
// STAYS in chat.js (the turn orchestrator + stream loop) — so chat.js injects the three chat.js-
// internal deps the cluster needs (handleChatSubmit; a () => API_BASE resolver; a
// setPendingRegenAttachments hand-off whose backing `let` handleChatSubmit reads/clears) via
// _setMessageActionsDeps, mirroring the PR2/PR3/PR4 injection pattern. Imported here only, so #1399
// single-eval holds.
import { editUserMessage, resendUserMessage, regenerateFrom, forkFrom, deleteMessage, editAIMessage, rewriteWith, continueFrom, _attachVariantNav, _setMessageActionsDeps } from './chatMessageActions.js';
// #1414 (R3 PR6): the SEND-OUTBOX subsystem (#985 P2-A / #891 / #830) — the reload-durable,
// session-bound, self-continuing queue for sends made while a turn streams / while offline.
// Behavior-preserving: the three queues + two single-flight guards live on the chatState singleton
// (PR0); chat.js still calls the moved helpers from handleChatSubmit (enqueue / offline / requeue /
// mark-failed), the stream-settle finally (flush), and the adopt pass (confirm), and re-exports the
// browser-gate surface on chatModule below byte-identically. Two chat.js-internal deps are injected
// (below, at module-eval): the SOLE production dispatch (a headless handleChatSubmit) through
// _setOutboxDispatch, and a () => API_BASE resolver through _setOutboxDeps. Imported here only, so
// #1399 single-eval holds; sessions.js's selectSession drain-nudge rides the chatModule re-export.
import {
  _enqueueSend, _flushSendOutbox, _restoreOutboxFromStorage, _outboxConfirmDelivery,
  _outboxTrackInflightSend, _outboxReleaseInflightSend, _outboxHasBlockingSendFor,
  _requeueOutboxItem, _isNetworkSendFailure, _dedupeOutboxAgainstServer, _setDeliveryState,
  _markSendFailedById, _retryFailedSend, _persistOutbox, _updateOutboxStrip, _outboxOnline,
  _armOutboxRetry, _setQueuedTag, _outboxPeekStorage, _setOutboxDispatch, _setOutboxDeps,
} from './chatOutbox.js';
// #1414 (R3 PR7): the cross-device RECONCILE / seq-order / peer-resume cluster (ADR 0008/0012) —
// softReloadHistory (the render-and-reconcile total-order rebuild) + the seq helpers + the
// orphan-aware bubble count + the deferred peer-resume seam. Behavior-preserving: chat.js still drives
// the same call points (softReloadHistory at the stream-settle + adopt sites, flushPendingReconcile /
// flushPendingPeerResume in the stream-end finally, _isEmptyTurnNoSave in the finalize) and re-exports
// the browser-gate surface on chatModule below byte-identically (softReloadHistory /
// flushPendingReconcile / deferPeerResume / flushPendingPeerResume / isSkippableUserPrompt / _msgSeq /
// _insertBySeq / _reorderBySeq / _isEmptyTurnNoSave / _visibleMsgCount / _expectedVisibleBubbleCount).
// Three chat.js-internal deps are injected (below, at module-eval) via _setReconcileDeps: hasActiveStream
// (the SSE-reader liveness helper), resumeStream (the R2 live-resume attach) — both STAY here — and a
// () => API_BASE resolver. Imported here only, so #1399 single-eval holds; sessions.js /sessionSync.js
// reach the cluster through the chatModule re-export, unchanged.
import {
  softReloadHistory, flushPendingReconcile, deferPeerResume, flushPendingPeerResume,
  _isSkippableUserPrompt, _isEmptyTurnNoSave, pruneEmptyAssistantBubbles, _isCastingEmptyReplyReprompt, _isBelowThresholdOrDanglingTurn, _msgSeq, _insertBySeq, _reorderBySeq,
  _visibleMsgCount, _expectedVisibleBubbleCount, _setReconcileDeps,
} from './chatReconcile.js';
// #1414 (R3 PR8): the SEVERABLE stream-presentation helpers (PARTIAL by design — the ~1,660-line
// SSE `while(true)` dispatch STAYS in handleChatSubmit; it cannot be lifted without rewriting the
// turn orchestrator's ~30 in-place-reassigned per-turn locals into `ctx.X`, the exact "gamble the
// live stream" the roadmap forbids — see chatStreamLoop.js's header + the #1414 PR8 report). Only
// the pure, closure-free, non-pinned helpers move: _ensureStreamLayout (the `.stream-content`
// render target), _toolLabels + _thinkingLabel (the tool-aware spinner label), _showThinkingSpinner
// (the transient dots bubble). They touch NO chat.js-internal state (deps: ui/spinner/document), so
// there is NO _setStreamLoopDeps to wire. `_thinkingLabel` now takes `lastToolName` as an argument
// (chat.js passes its `_lastToolName` local). None are on chatModule / called cross-file, so no
// re-export. Imported here only, so #1399 single-eval holds.
import { _ensureStreamLayout, _toolLabels, _thinkingLabel, _showThinkingSpinner } from './chatStreamLoop.js';
import { frameBatched, liveAddedElements } from './frameBatch.js';

  // #1399: chat.js must be evaluated EXACTLY ONCE per page. It was previously loaded by two
  // different urls at once — app.js's bare `import './js/chat.js'` AND index.html's versioned
  // `<script src="chat.js?v=…">` — and two urls are two module records, so every module-level
  // variable/timer/listener/cache below ran in DUPLICATE (PR #1398 fixed only the outbox-restore
  // symptom of that). The versioned <script> tag is gone; chat.js now loads solely via the app.js
  // import. This sentinel makes any regression that re-introduces a second load path LOUD instead
  // of silent. (window-guarded so non-browser contexts are unaffected.)
  if (typeof window !== 'undefined') {
    if (window.__orwellChatEvaluated) {
      console.warn('[orwell] #1399: chat.js evaluated more than once — the dual-load hazard has ' +
        'regressed; every module-level timer/listener/cache is now duplicated. Check that nothing ' +
        're-added a chat.js <script> tag alongside the app.js import.');
    }
    window.__orwellChatEvaluated = true;
    // #1626 increment 2: restore THIS tab's producer byline for the active session from the
    // per-session map. NOTE: at module-eval currentSessionId is usually not assigned yet (selectSession
    // runs later), so this seeds the default; the AUTHORITATIVE restore is orwellReapplyNarrator(id),
    // which selectSession invokes once the active sid is known (Greptile P1 timing fix). Fail-open;
    // sessionStorage clears on tab close, so a stale value can never outlive the browser tab.
    try {
      orwellReapplyNarrator(sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId());
    } catch (_) {}
  }

  const RESEARCH_TIMEOUT_MS = 360000;
  const DEFAULT_TIMEOUT_MS = 120000;

  // ── STREAM IDLE-ABORT bound (SSE/poll fallback freeze fix) ────────────────────────────────────
  // The whole-turn abort is an ACTIVITY-RESET IDLE timer, not a one-shot-cleared timer (see
  // `_makeStreamIdleGuard`). These name the max gap between ANY two stream activities (deltas / tool
  // events) before the abort fires. They REUSE the established per-mode whole-turn budget on purpose:
  // before this fix that budget already bounded the pre-first-token wait, so reusing it as the idle
  // bound can NEVER false-positive a case the shipped timeout wouldn't already have aborted. Agent /
  // research keep the generous 6-min bound specifically because a single slow tool call (web fetch,
  // a deep-research step) legitimately emits nothing for minutes — the exact false-positive the old
  // one-shot-clear was reaching for, now handled by resetting on every activity instead.
  const STREAM_IDLE_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;        // chat mode
  const STREAM_IDLE_TIMEOUT_AGENT_MS = RESEARCH_TIMEOUT_MS; // agent / research mode

  // A mid-stream SSE stall (the server stops emitting deltas partway through a turn) must ABORT +
  // recover, never leave `await reader.read()` blocked forever with `chatState.isStreaming` stuck
  // true — the same reload-forcing freeze class as the WS-orphaned-pending one (PR #1718), but on the
  // fallback transport. Before this fix the whole-turn abort timer was a ONE-SHOT:
  // `clearResponseTimeout()` fired on the FIRST stream activity and permanently disarmed it, so
  // nothing bounded a mid-stream stall (only the tab-return `visibilitychange` recovery caught it, and
  // only after a manual tab switch). This converts that abort into an ACTIVITY-RESET IDLE timer:
  // `.activity()` (re)arms the countdown on stream START and on EVERY subsequent delta/tool event, so
  // it fires only after a genuine IDLE gap (`idleMs` of no activity). A long-but-ACTIVE agent turn
  // keeps resetting it and is never tripped (the false-positive the one-shot-clear originally avoided);
  // only real silence aborts, driving the SAME recovery the turn already has (abort → catch →
  // reconcile from history → finally resets `isStreaming` + re-enables the composer + flushes the
  // outbox). `.disarm()` is the permanent turn-end clear (finally / WS handoff / pre-stream refusal).
  // Self-contained (no closure deps beyond its two args) so it is unit-testable in isolation.
  function _makeStreamIdleGuard(idleMs, onIdle) {
    let timer = null;
    let disarmed = false;
    const _clear = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
    return {
      // Called on stream START and on EVERY stream activity: (re)arm the idle countdown.
      activity() {
        if (disarmed) return;
        _clear();
        timer = setTimeout(() => { timer = null; if (!disarmed) onIdle(); }, idleMs);
      },
      // Permanent disarm on turn end (finally / WS handoff / refusal): no idle abort after the turn.
      disarm() { disarmed = true; _clear(); },
      // Introspection for tests: is the idle countdown currently armed?
      _armed() { return timer !== null; },
    };
  }
  const RESEARCH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>';
  // B11 (2026-07-05): the ONE canonical diegetic "production interruption" line for a raw
  // engine/backend failure the player must never see rendered as machinery text (I9). Originally
  // authored for the HTTP-error branch below (Orwell #872); now reused verbatim everywhere a hard
  // failure would otherwise dump `/help`/`[Error: ...]`/"step limit" copy into the narrator's own
  // message, so every "something broke" moment reads as ONE consistent in-universe interruption —
  // mirroring the pre-game holding card's voice (`orwellOnboarding.js`, "Big Brother will return…")
  // and the A2 scene-cutaway line (`frontend/src/agent_loop.py` `_SCENE_CUTAWAY_LINE`) — never a
  // scattered new string per call site.
  const _ENGINE_INTERRUPT_LINE =
    "Big Brother cuts to a brief technical interlude… hang tight, we'll be right back.";

  let API_BASE = '';
  // #1414 (R3 PR3): feed the extracted chatAttachments.js chat.js's live API_BASE. A closure over
  // this `let` (set once in init) so openAttachment reads the current value — an imported binding
  // would be read-only. Registered at module-eval (order-independent of init).
  _setAttachmentsApiBase(() => API_BASE);
  // #1414 (R3 PR6): register the outbox's two chat.js-internal deps at module-eval. The SOLE
  // production dispatch is a headless handleChatSubmit (byte-identical to the pre-PR6 default) —
  // routed through the same _setOutboxDispatch seam the browser gate uses to install a stub, so
  // production and test share one entry point (last writer wins). API_BASE is read live via the
  // resolver (the _setAttachmentsApiBase precedent). handleChatSubmit is a hoisted declaration, so
  // capturing it here (it is only INVOKED at flush time) is safe.
  _setOutboxDeps({ apiBase: () => API_BASE });
  _setOutboxDispatch((text, opts) => handleChatSubmit(null, text, opts));
  // #1414 (R3 PR0): streaming/send/display/continue mutable state moved to the shared `chatState`
  // singleton — chatState.currentAbort, .isStreaming, ._sendInFlight, ._displayOverride,
  // ._hideUserBubble, ._pendingContinue. See chatState.js for the per-field docs.
  // ── Auto-recovery: when a turn's stream silently dies (connection drop) or
  // goes quiet while the connection is alive, re-engage the model with a
  // completion handshake instead of leaving it hung. Capped so it can't loop.
  // chatState._autoNudges (handshakes fired for the CURRENT user turn) + chatState._autoContinuePending
  // (next submit is an auto-continue — don't reset the counter). Moved to chatState.js, #1414 R3 PR0.
  const _AUTO_NUDGE_CAP = 3;

  // CASTING-RESUME-HANG Fix 3 — a bounded, casting-only re-prompt for a reasoning-only turn (a long
  // thinking trace with an EMPTY visible reply and no tool call) that would otherwise HANG the casting
  // interview after the post-photo resume cue. The re-prompt only RE-ASKS the model (never engine-authors
  // content); the latch is a HARD loop-guard so it can fire AT MOST ONCE per stuck streak, and is cleared
  // the moment any casting turn lands a visible reply (so a later genuine hang can still be recovered).
  const _CASTING_EMPTY_REPROMPT =
    "(Production cue — your last turn produced no visible reply. Continue the casting interview now: " +
    "respond to me directly, in character as the producers.)";
  let _castingEmptyRepromptSent = false;
  // #1785 (F8) one-shot latch: the below-threshold/dangling-turn gate fires AT MOST ONCE per turn.
  let _gateBelowThresholdFired = false;

  /** #1785 (F8): shared helper for minimum-viable-turn gate. Judges the visible reply; if below
   *  threshold or dangling-markdown, re-triggers generation headless (single bounded retry).
   *  Extracted so a future change can wire it into _trySelfResume's separate finalize (~4707-4724)
   *  WITHOUT touching _trySelfResume now (explicitly out-of-scope follow-up). */
  function _gateAndRetryBelowThresholdTurn({ holder, streamSessionId, sawDone, cancelled, usedTools, producedVisible, visibleReply }) {
    if (_gateBelowThresholdFired) return;
    if (!_isBelowThresholdOrDanglingTurn({ sawDone, cancelled, usedTools, producedVisible, visibleReply })) return;
    _gateBelowThresholdFired = true;
    // If holder is still in DOM and the gate tripped, render a retry label on the holder AND fire
    // a headless re-submit. The retry label tells the player the generation was too short/truncated.
    const _sid = streamSessionId;
    if (holder && holder.parentNode) {
      try {
        _renderStreamDropRetry(holder, _sid, {
          label: "The response was too short — retrying silently.",
        });
      } catch (_) {}
    }
    // Defer so the turn's finally settles first. Drop if the user switched chats.
    setTimeout(() => {
      try {
        if (_sid && sessionModule.getCurrentSessionId() !== _sid) return;
        handleChatSubmit(null, null, { hideUserBubble: true });
      } catch (_) {}
    }, 50);
  }

  // ── #985 P2-A / #891 / #830: the SEND OUTBOX subsystem moved to chatOutbox.js (#1414 R3 PR6). ──
  // Its state — the three queues (chatState._sendOutbox / ._outboxAwaitingConfirm / ._outboxFailed)
  // and the two single-flight guards (chatState._flushingOutbox / ._outboxRestoreDone) — lives on the
  // chatState singleton (PR0); the _outboxKey / _outboxOnline helpers and the _OUTBOX_* backoff
  // constants moved with the subsystem. The helpers are imported above and re-exported on chatModule.

  // shortModel and modelColor are now in chatRenderer.js
  var _shortModel = chatRenderer.shortModel;
  var _modelRouteLabel = chatRenderer.modelRouteLabel;
  var _sameModelName = chatRenderer.sameModelName;
  var _applyModelColor = chatRenderer.applyModelColor;
  // C14/immersion: the single source for an AI message's SENDER label. In the game build the
  // narrator is the show ("Orwell"), never the raw LLM model name — used at every
  // placeholder / resume / continuation site so the model machinery stays invisible to the
  // player (mirrors _setRoleModelLabel for the resolved-model path).
  function _senderLabel(modelLabel) {
    return isGameBuild() ? gameNarrator() : (modelLabel || '');
  }
  // J1-30 (immersion): the pre-token wait — most visible right after the player's first deliberate
  // action ("Start casting"), where a generic "Processing request…" reads as lag/OOC. In the game
  // build, dress the GENERIC waiting stages in a production voice so the gap feels like the show
  // rolling, not the app stalling. Endpoint-DIAGNOSTIC states (online/offline/latency/countdown)
  // stay literal — they are operator truth a player rarely sees and must not be fictionalised.
  // #1325: the copy itself is PHASE-AWARE — a producers-are-deliberating voice reads as pre-game
  // once the season is actually live, so the strings live in orwellToolBeats.js's `narratorWaitCopy`
  // (casting vs. started tables) and this helper just dresses the game-build gate around it.
  function _waitLabel(stage, fallback) {
    if (!isGameBuild()) return fallback;
    return narratorWaitCopy(stage) || fallback;
  }
  // #986 — the ONE in-progress ("model is generating a response") spinner label, so it reads in the
  // same in-character "producers" voice across EVERY spinner-create site: the initial send, a
  // continuation round, a resumeStream re-attach, and a background re-entry. Before this, only the
  // initial-send site dressed its label through `_waitLabel`; the other three hard-coded "Generating
  // response" / "Response streaming in background", so two windows watching the same run showed
  // divergent labels. Routes through `_waitLabel('waiting', …)`, inheriting its game-build/non-game
  // behavior (fail-open to the generic fallback outside the game build).
  function _inProgressLabel(fallback) {
    return _waitLabel('waiting', fallback || 'Generating response');
  }
  function _setRoleModelLabel(roleEl, requestedModel, actualModel, opts) {
    if (!roleEl) return;
    opts = opts || {};
    const tsSpan = roleEl.querySelector('.role-timestamp');
    const req = requestedModel || actualModel || '';
    const actual = actualModel || requestedModel || '';
    let label = _modelRouteLabel(req, actual);
    if (opts.suffix) label += ' (' + opts.suffix + ')';
    if (opts.characterName) label = opts.characterName;
    // C14/immersion: the player must never see the raw LLM model name as the sender —
    // in the game build the narrator IS the show. Use a diegetic label unless a specific
    // speaker name was supplied.
    else if (document.body.hasAttribute('data-game-build')) label = gameNarrator();
    roleEl.textContent = label + ' ';
    _applyModelColor(roleEl, actual || req);
    // C14/immersion: the raw "alias -> dated-version" model string must never reach the
    // player in the game build — not as the sender label and not as the hover tooltip.
    if (isGameBuild()) {
      roleEl.removeAttribute('title');
    } else if (req && actual && !_sameModelName(req, actual)) {
      roleEl.title = req + ' -> ' + actual + (opts.reason ? ': ' + opts.reason : '');
    } else if (!opts.reason) {
      roleEl.removeAttribute('title');
    }
    if (tsSpan) roleEl.appendChild(tsSpan);
  }
  // #1626 increment 2: the sessionStorage key holding the PER-SESSION producer map { [sid]: name }.
  // Per-session (not one tab-wide record) so visiting session B never overwrites A's byline, and
  // reloading A restores A's producer — a NEW season/session simply has no entry ⇒ "Production".
  // Per-tab (sessionStorage), matching the ADR 0008/0012 outbox convention.
  const _NARRATOR_STORE_KEY = 'orwell.gameNarrator';
  function _readNarratorMap() {
    try {
      const m = JSON.parse(sessionStorage.getItem(_NARRATOR_STORE_KEY) || 'null');
      return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
    } catch (_) { return {}; }
  }
  // Persist the resolved producer byline SEASON-SCOPED into the per-session map. Fail-open.
  function _persistNarratorForSession(sid, name) {
    if (!name || !sid) return;
    try {
      const m = _readNarratorMap();
      m[sid] = String(name);
      sessionStorage.setItem(_NARRATOR_STORE_KEY, JSON.stringify(m));
    } catch (_) {}
  }
  // #1626 increment 2: re-apply the byline for the NOW-ACTIVE session from the per-session map — the
  // load-time read runs during module eval, BEFORE selectSession() assigns currentSessionId, so the
  // real restore happens here, invoked by selectSession once the active sid is known (exposed as
  // chatModule.orwellReapplyNarrator). Applies the session's producer, or resets to "Production" when
  // the session has no entry (a new season). Fail-open.
  function orwellReapplyNarrator(sid) {
    try {
      const name = sid ? _readNarratorMap()[sid] : null;
      setGameNarrator(name || undefined);   // falsy ⇒ the "Production" default (setGameNarrator floor)
    } catch (_) { setGameNarrator(); }
  }
  // #1626 increment 2: re-apply the byline to an ALREADY-MOUNTED live bubble after the producer name
  // resolves mid-stream (the holder is created BEFORE the SSE is read), so the current bubble updates
  // now instead of only at finalize/reload. Routes through the canonical role-label path, preserving
  // an explicit character label (an NPC-voiced row keeps its speaker name). Fail-open: no holder/role
  // ⇒ no-op; touches ONLY the .role element, never the body (reasoning-scrub/OOC state untouched).
  function _refreshLiveByline(liveHolder) {
    if (!liveHolder || typeof liveHolder.querySelector !== 'function') return;
    const roleEl = liveHolder.querySelector('.role');
    if (!roleEl) return;
    _setRoleModelLabel(roleEl, liveHolder._requestedModel, liveHolder._actualModel,
      { characterName: liveHolder._characterName });
  }
  // Per-session research tracking (supports concurrent research across sessions).
  // The id set is chatState._researchingStreamIds (moved to chatState.js, #1414 R3 PR0).
  let _researchTimerEl = null, _researchTimerInterval = null;
  let _researchStartTime = 0, _researchAvgDuration = null;
  let _researchSynapse = null;
  function _clearResearchTimer() {
    if (_researchTimerInterval) { clearInterval(_researchTimerInterval); _researchTimerInterval = null; }
    if (_researchTimerEl) { _researchTimerEl.remove(); _researchTimerEl = null; }
    if (_researchSynapse) {
      // Mark complete first so the user briefly sees the "done" state,
      // then tear it down on next tick.
      try { _researchSynapse.complete(); } catch {}
      const s = _researchSynapse;
      _researchSynapse = null;
      setTimeout(() => { try { s.destroy(); } catch {} }, 800);
    }
    _researchStartTime = 0;
    _researchAvgDuration = null;
  }

  /** Append a "Generate Visual Report" button — delegates to chatRenderer. */
  function _appendViewReportLink(msgEl, sessionId) {
    const body = msgEl.querySelector('.body');
    if (body) chatRenderer.appendReportButton(body, sessionId);
  }
  let currentAccumulated = ''; // Track accumulated text across function scope
  let currentHolder = null; // Track current message holder
  let currentSpinner = null; // Track current spinner for stop cleanup

  // Background streaming support. Moved to chatState.js (#1414 R3 PR0):
  //   chatState._backgroundStreams  Map sessionId -> { status, accumulated, sourcesHtml, abortCtrl, query, metrics }
  //   chatState._resumingStreams    Set sessionId -> a resumeStream() reader is live (re-attach lock)
  //   chatState._streamSessionId    session id for the currently active reader loop
  let _lastReaderActivity = 0; // Timestamp of last reader.read() success — used to detect frozen streams
  let _webLockRelease = null;  // Function to release the Web Lock held during streaming
  let _forcePlanOff = false;   // One-shot: suppress plan_mode for the next send (Approve & Run)

  // ── Plan store: the latest proposed/approved checklist for the CURRENT chat ──
  // Kept so (a) it can be sent back each turn and pinned in context (a long plan
  // on a weak model survives history truncation), and (b) the plan window can be
  // re-opened/docked at any time via the plan-button menu. Stored per session in
  // localStorage so it survives a reload mid-execution.
  function _setStoredPlan(text) {
    const sid = sessionModule.getCurrentSessionId();
    if (!sid || !text || !text.trim()) return;
    Storage.setJSON(Storage.KEYS.PLAN, { sid, text });
    // Live-refresh the plan window if it's open (shows progress as the agent
    // restates the checklist with [x]).
    try {
      if (planWindowModule.isPlanWindowOpen && planWindowModule.isPlanWindowOpen()) {
        planWindowModule.openPlanWindow(text, null);
      }
    } catch (_) {}
  }
  function _getStoredPlan() {
    const sid = sessionModule.getCurrentSessionId();
    const rec = Storage.getJSON(Storage.KEYS.PLAN, null);
    return (rec && rec.sid === sid && rec.text) ? rec.text : '';
  }
  // A line like "- [ ] step" / "- [x] step" marks a GitHub-style checklist.
  const _CHECKLIST_RE = /^\s*[-*]\s+\[[ xX]\]\s+/m;
  // Exposed for app.js (plan-button menu) — re-open the stored plan window.
  window._getStoredPlan = _getStoredPlan;
  window.planWindowModule = planWindowModule;

  /** Check if an SSE reader is still actively connected for a session. */
  function hasActiveStream(sessionId) {
    return chatState._streamSessionId === sessionId || chatState._backgroundStreams.has(sessionId) ||
           chatState._resumingStreams.has(sessionId);
  }

  /**
   * #1087 (SSE self-echo double): classify a `run-started` SSE edge as THIS window's OWN run vs a
   * genuine PEER's. `session_events` is at-least-once, so the sender receives its OWN `run-started`
   * echo (and the replay ring re-delivers it on a late connect). Learn our own run id the moment the
   * echo arrives while our foreground POST is live for `id` (chat_routes publishes our run-started
   * synchronously at POST, so the FIRST edge we see mid-stream is ours), then recognize it thereafter.
   * A concurrent PEER run (GAP-1) carries a DIFFERENT runId, so it is NEVER swallowed — it still
   * defers/resumes for the live two-window mirror. Returns true iff `runId` is our OWN run.
   *
   * Called by sessionSync's run-started handler. Fail-open: no runId (older server / unstamped edge)
   * ⇒ returns false ⇒ the pre-#1087 defer/resume behavior, unchanged. The map entry is reset per
   * foreground POST (handleChatSubmit) so each turn re-learns a fresh run id.
   */
  function noteRunStarted(sessionId, runId) {
    if (!sessionId || !runId) return false;
    // Only the FIRST run-started seen while OUR foreground POST is streaming `sessionId` is recorded
    // as ours (`_streamSessionId === sessionId`). A LATER, different runId that arrives while we are
    // still streaming is a genuine concurrent peer — never overwrite our own id with it.
    if (chatState._streamSessionId === sessionId && !chatState._ownRunIds[sessionId]) {
      chatState._ownRunIds[sessionId] = runId;
    }
    return chatState._ownRunIds[sessionId] === runId;
  }

  /** ADR 0012 §2.2: stamp a live bubble's role-timestamp from the SERVER-minted ISO time (carried on
   * the message_saved event) so every window renders the identical time string — replacing the
   * speculative client `new Date()` the bubble was created with. Formats identically to
   * chatRenderer.roleTimestamp (the history-reload path) so the live bubble and the settled/reloaded
   * bubble read the same. Best-effort: a bad/absent value leaves the existing placeholder intact. */
  function _applyServerTimestamp(holderEl, iso, moment) {
    try {
      if (!holderEl) return;
      var span = holderEl.querySelector('.role-timestamp');
      if (!span) return;
      var d = iso ? new Date(iso) : null;
      var haveWall = d && !isNaN(d.getTime());
      // M2-6: the beat's IN-WORLD moment leads the live/mirror stamp too (matching
      // chatRenderer.roleTimestamp on reload); the server-minted wall clock is demoted to
      // the hover title + dataset. Absent moment ⇒ neutral wall-clock stamp (prior behavior).
      if (typeof moment === 'string' && moment.trim()) {
        span.textContent = moment.trim();
        span.classList.add('role-timestamp-moment');
        if (haveWall) {
          span.title = d.toLocaleString();
          span.dataset.wallClock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return;
      }
      if (!haveWall) return;
      span.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      span.title = d.toLocaleString();
    } catch (_) {}
  }

  // Sources box builder and toggleSources are now in chatRenderer.js
  var _buildSourcesBox = chatRenderer.buildSourcesBox;

  // Browser notifications now in chatStream.js
  var _notifyResearchComplete = chatStream.notifyResearchComplete;

  // Model/image pricing, _buildImageBubble now in chatRenderer.js
  var _buildImageBubble = chatRenderer.buildImageBubble;
  var getModelCost = chatRenderer.getModelCost;
  var getImageCost = chatRenderer.getImageCost;

  // stripToolBlocks and roleTimestamp now in chatRenderer.js
  var stripToolBlocks = chatRenderer.stripToolBlocks;

  function _normalizeEndpointForCompare(url) {
    if (!url) return '';
    try {
      const u = new URL(String(url), window.location.origin);
      let path = u.pathname.replace(/\/+$/, '');
      const suffixes = [
        '/v1/chat/completions', '/chat/completions',
        '/v1/completions', '/completions',
        '/v1/messages', '/messages',
        '/v1/models', '/models',
      ];
      for (const suffix of suffixes) {
        if (path.toLowerCase().endsWith(suffix)) {
          path = path.slice(0, -suffix.length).replace(/\/+$/, '');
          break;
        }
      }
      return (u.origin + path).toLowerCase();
    } catch (_) {
      return String(url).trim().replace(/\/+$/, '').toLowerCase();
    }
  }

  async function _probeCurrentEndpointStatus(endpointUrl, signal) {
    const target = _normalizeEndpointForCompare(endpointUrl);
    if (!target) return null;
    const modelsRes = await fetch(`${API_BASE}/api/models`, { credentials: 'same-origin', signal });
    if (!modelsRes.ok) return null;
    const modelsData = await modelsRes.json().catch(() => ({}));
    const item = (modelsData.items || []).find(ep =>
      _normalizeEndpointForCompare(ep.url || ep.endpoint_url || ep.base_url) === target
    );
    if (!item || !item.endpoint_id) return null;

    const probesRes = await fetch(`${API_BASE}/api/model-endpoints/probe-local`, {
      credentials: 'same-origin',
      signal,
    });
    if (!probesRes.ok) return null;
    const probes = await probesRes.json().catch(() => ({}));
    return probes[item.endpoint_id] || null;
  }

  /**
   * Initialize with dependencies
   */
  export function init(apiBase) {
    API_BASE = apiBase;
    // #738 item #9: transcript scroll-edge mask + recede-on-scroll banner (glass polish).
    try { _initChatScrollEdges(); } catch (_) {}
    initSlashCommands({ apiBase, isStreaming: () => chatState.isStreaming });
    if (emailInbox) emailInbox.init(documentModule);
    // L9 (composer): the Agent|Chat mode toggle is meaningless in the game build —
    // play is always hybrid (OOC chat + in-character role-play + the engine tools
    // run every turn). game-trim.css hides it; this is the belt-and-suspenders JS
    // gate so the dead control stays gone even if the visibility system (app.js
    // applyUIVis) clears the inline display. The full inherited workspace is
    // unchanged. Fail-safe: wrapped so a missing node never throws in init.
    try {
      if (isGameBuild()) {
        const _modeToggle = document.querySelector('.mode-toggle');
        if (_modeToggle) _modeToggle.style.display = 'none';
      }
    } catch (_) {}
    // M2-7 — diegetic rename of the reasoning-surface Settings toggle in the GAME BUILD only.
    // game-trim.css KEEPS the "Thinking Process" toggle (it changes the in-fiction chat), but its
    // debug copy ("Show <think> collapsible bars") should read as the show's "Production Notes"
    // family — matching the beat-chip register and the accordion label. The full inherited
    // workspace (ORWELL_GAME_BUILD=0) keeps the technical operator wording untouched. Same
    // belt-and-suspenders shape as the mode-toggle gate above; fail-safe if the node is absent.
    try {
      if (isGameBuild()) {
        const _thinkRow = document.querySelector('.vis-row:has(input[data-ui-key="show-thinking"]) .vis-label');
        if (_thinkRow) {
          const _hint = _thinkRow.querySelector('.vis-hint');
          if (_hint) _hint.textContent = 'Show the show’s production notes';
          // Rewrite the leading label text node ("Thinking Process ") in place, keeping the hint span.
          for (const node of _thinkRow.childNodes) {
            if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
              node.textContent = 'Production Notes ';
              break;
            }
          }
        }
      }
    } catch (_) {}
    // Wire the slash-command autocomplete popup on the chat composer. The
    // dispatcher already handles the typed command — this just surfaces the
    // registry as a discoverable menu when the user starts a message with /.
    import('./slashAutocomplete.js').then(mod => {
      const ta = document.getElementById('message');
      if (ta && mod.initSlashAutocomplete) mod.initSlashAutocomplete(ta);
    }).catch(() => {});
  }

  // addMessage, createMsgFooter, displayMetrics, hideWelcomeScreen, showWelcomeScreen
  // are now in chatRenderer.js — referenced via the public API delegation above.
  var addMessage = chatRenderer.addMessage;
  var createMsgFooter = chatRenderer.createMsgFooter;
  var displayMetrics = chatRenderer.displayMetrics;
  var hideWelcomeScreen = chatRenderer.hideWelcomeScreen;
  var showWelcomeScreen = chatRenderer.showWelcomeScreen;

  // #1414 (R3 PR2): the submit-button state machine — updateSubmitButton / _foregroundStreamLive /
  // _syncSubmitButtonState — moved VERBATIM to chatSubmitButton.js (imported at the top of this file).
  // chat.js still calls them exactly as before and re-exports the two public-API ones (#971 gate) in
  // the chatModule object below.

  // -----------------------------------------------------------------------
  // Slash commands — now in slashCommands.js
  // -----------------------------------------------------------------------

  // API key pattern for the guard in handleChatSubmit
  const API_KEY_RE = /^(sk-[a-zA-Z0-9_\-]{20,}|gsk_[a-zA-Z0-9]{20,}|AIza[a-zA-Z0-9_\-]{30,}|xai-[a-zA-Z0-9]{20,})$/;


  /**
   * Handle chat form submission
   */
  export async function handleChatSubmit(e, overrideMsg = null, overrideOpts = null) {
    if (e && e.preventDefault) e.preventDefault();
    // Headless / programmatic send. Callers (auto-continue, stream-drop recovery, a choice-card
    // pick, a slash dispatch) hand us the message text + options DIRECTLY, instead of the old
    // anti-pattern of writing the user-visible composer (`el('message').value = …`) and synthesizing
    // a `.send-btn` click. That puppeteering depended on UI timing (the deferred click could land
    // while `isStreaming` was still true and toggle Stop instead of Send), polluted the composer, and
    // stranded text on any failure. A headless send is plain text only — never a slash command or
    // setup input — so the intercepts below are skipped for it, and the composer is never touched.
    const _headless = overrideMsg != null;
    // #985 P2-A — a FLUSHED OUTBOX send is a headless send that re-uses the ALREADY-PAINTED optimistic
    // bubble + its pre-stamped clientMsgId (so the send is at-most-once / idempotent and the bubble
    // adopts cleanly instead of painting a duplicate). These flow through the same render/adopt path as
    // a normal optimistic send below — they just skip the "paint a fresh bubble" + "generate a fresh id"
    // steps. Absent (the common case) ⇒ byte-identical behaviour.
    let _queuedClientMsgId = null;
    let _queuedBubbleEl = null;
    if (_headless && overrideOpts) {
      if (overrideOpts.hideUserBubble) chatState._hideUserBubble = true;
      if ('pendingContinue' in overrideOpts) chatState._pendingContinue = overrideOpts.pendingContinue;
      if (overrideOpts.autoContinue) chatState._autoContinuePending = true;
      if (overrideOpts.queuedClientMsgId) _queuedClientMsgId = overrideOpts.queuedClientMsgId;
      if (overrideOpts.queuedBubbleEl) _queuedBubbleEl = overrideOpts.queuedBubbleEl;
    }
    // Cancel research clarification timeout if active
    if (window._researchTimeoutTimer) {
      clearTimeout(window._researchTimeoutTimer);
      window._researchTimeoutTimer = null;
    }
    // Get current session
    const sessionId = sessionModule.getCurrentSessionId();
    const session = sessionModule.getSessions().find(s => s.id === sessionId);
    
    const submitBtn = document.querySelector('.send-btn');
    // Streaming-TTS flag, hoisted to the function scope: it is SET when the stream starts (below)
    // but also READ in the error/abort cleanup branch — a block-scoped `const` there threw
    // "streamingTTS is not defined" on ANY early submit error, masking the real failure and
    // blowing up the whole submit (no chat POST ever fired). Declare once here so both see it.
    let streamingTTS = false;

    // If compare is active, stop all compare streams
    if (window.compareModule && window.compareModule.isActive()) {
      window.compareModule.handleCompareSubmit();
      return;
    }

    // #985 P2-A — SEND-WHILE-STREAMING → QUEUE, don't Stop. A user Send with NON-EMPTY composer text
    // while a turn is in flight used to fall into the Stop branch below (abort the reply + `return`
    // before the new text was ever read → the message was silently DROPPED). The owner ruled "Queue
    // it": enqueue the new message, paint its optimistic bubble NOW, clear the composer, and flush in
    // FIFO order when the current turn settles. Only a NON-headless, NON-command, NON-empty composer
    // queues; an EMPTY composer (or the explicit Stop button) still falls through to the Stop branch,
    // and a slash command runs through its own dispatcher below (never queued as chat). The compare/
    // group routing above has already returned, so this is the plain-chat send path only.
    if (chatState.isStreaming && !_headless) {
      const _qInput = uiModule.el('message');
      const _qText = _qInput ? (_qInput.value || '') : '';
      const _qTrim = _qText.trim();
      if (_qTrim && !isCommand(_qTrim) && slashCommands.getSetupMode && !slashCommands.getSetupMode()) {
        _enqueueSend(_qText);
        return;
      }
      // empty composer / slash / setup mode → fall through to the existing Stop semantics
    }

    // If currently streaming, stop it (a headless/programmatic send never toggles Stop — it sends).
    if (chatState.isStreaming && !_headless) {
      // Cancel server-side research if in progress
      const _cancelSid = sessionModule.getCurrentSessionId();
      if (_cancelSid && chatState._researchingStreamIds.has(_cancelSid)) {
        fetch(`${API_BASE}/api/research/cancel/${_cancelSid}`, { method: 'POST' }).catch(e => console.warn('Research cancel failed:', e));
        chatState._researchingStreamIds.delete(_cancelSid);
        _clearResearchTimer();
      }
      abortCurrentRequest(true);  // explicit user Stop → also cancel the detached server run

      // Clean up any running agent thread nodes (stop wave animation, remove "running" state)
      document.querySelectorAll('.agent-thread-node.running').forEach(node => {
        if (node._waveInterval) { clearInterval(node._waveInterval); node._waveInterval = null; }
        if (node._elapsedTicker) { clearInterval(node._elapsedTicker); node._elapsedTicker = null; }
        node.classList.remove('running');
        // The timeline dot is the SINGLE state marker (no separate glyph): dropping
        // `.running` settles it to the solid done fill, and the "stopped" status below
        // labels the halt.
        const wave = node.querySelector('.agent-thread-wave');
        if (wave) wave.textContent = '';
        const statusEl = node.querySelector('.agent-thread-status');
        if (!statusEl) {
          const header = node.querySelector('.agent-thread-header');
          if (header) {
            const s = document.createElement('span');
            s.className = 'agent-thread-status';
            s.textContent = 'stopped';
            header.appendChild(s);
          }
        }
      });
      document.querySelectorAll('.agent-thread.streaming').forEach(t => t.classList.remove('streaming'));

      // Clean up any thinking spinners
      document.querySelectorAll('.agent-thinking-dots').forEach(el => {
        if (el._spinner) el._spinner.destroy();
        el.remove();
      });
      // No text accumulated — remove the empty holder with spinner
      if (currentHolder && !currentAccumulated) {
        if (currentSpinner) { currentSpinner.destroy(); currentSpinner = null; }
        // Empty cancel — keep the assistant bubble around with a "Cancelled
        // by user" indicator and persist a placeholder server-side so the
        // turn survives a refresh instead of vanishing without a trace.
        _renderCancelledBubble(currentHolder);
        currentHolder = null;
        updateSubmitButton('idle', submitBtn);
        const messageInput = uiModule.el('message');
        if (messageInput) messageInput.disabled = false;
        currentAccumulated = '';
        return;
      }
      // Render whatever was accumulated so far
      if (currentHolder && currentAccumulated) {
        // Store accumulated in a closure variable before it gets cleared
        const stoppedContent = currentAccumulated;

        // Store raw content in dataset for consistency with other messages. FEDEEP-2: scrub any
        // reasoning/machinery that bled into plain content before caching the raw copy (same chain
        // processWithThinking's public-reply branch runs on the rendered body below) — a leak must
        // not survive into the copy/regen/TTS cache just because the stream was user-stopped.
        currentHolder.dataset.raw = markdownModule.scrubMachineryForPersistence(stoppedContent);
        
        currentHolder.querySelector('.body').innerHTML = markdownModule.processWithThinking(
          markdownModule.squashOutsideCode(stoppedContent)
        );
        
        // Highlight code blocks
        if (window.hljs) {
          currentHolder.querySelectorAll('pre code').forEach((block) => {
            window.hljs.highlightElement(block);
          });
        }
        
        // Add the stopped indicator with continue button
        const stoppedIndicator = document.createElement('div');
        stoppedIndicator.className = 'stopped-indicator';
        const stoppedLabel = document.createElement('span');
        stoppedLabel.textContent = '[Message interrupted]';
        stoppedIndicator.appendChild(stoppedLabel);
        const continueBtn = document.createElement('button');
        continueBtn.className = 'continue-btn';
        continueBtn.title = 'Continue';
        continueBtn.textContent = '\u25B8';
        const _stoppedHolder = currentHolder; // capture before it gets cleared
        continueBtn.addEventListener('click', () => {
          stoppedIndicator.remove();
          chatState._hideUserBubble = true;
          chatState._pendingContinue = _stoppedHolder;
          const cutoff = stoppedContent;
          // Headless send (no composer puppeteering) — the _hideUserBubble/_pendingContinue flags set
          // above flow through; the continuation merges into the existing bubble.
          handleChatSubmit(null, 'Your previous response was interrupted. It ended with:\n\n' + cutoff.slice(-500) + '\n\nDo NOT repeat what you already said. Continue exactly from where you were cut off.');
        });
        stoppedIndicator.appendChild(continueBtn);
        currentHolder.querySelector('.body').appendChild(stoppedIndicator);

        // Tell server to mark this message as stopped
        const _sid = sessionModule.getCurrentSessionId();
        if (_sid) fetch(`${API_BASE}/api/session/${_sid}/mark-stopped`, { method: 'POST' }).catch(e => console.warn('mark-stopped failed:', e));

        // Add footer with copy/regen if not already present
        if (!currentHolder.querySelector('.msg-footer')) {
          currentHolder.dataset.raw = markdownModule.scrubMachineryForPersistence(stoppedContent);
          currentHolder.appendChild(createMsgFooter(currentHolder));
        }

        uiModule.scrollHistory();
      }
      
      // Reset button state
      updateSubmitButton('idle', submitBtn);
      
      // Re-enable message input
      const messageInput = uiModule.el('message');
      if (messageInput) messageInput.disabled = false;
      
      // Clear tracking variables
      currentAccumulated = '';
      currentHolder = null;

      return;
    }

    // --- OOBE image gate (P1 onboarding): the houseguest photo is the player's FIRST
    // interaction. Pre-game, until a cast photo is secured, NO chat message may be sent — this
    // covers every send path (button, Enter, programmatic) at one chokepoint. The gate module
    // fails OPEN (only ever blocks a confirmed pre-game game-build with no image yet), so this is
    // a no-op for normal play, a non-game build, an engine outage, or a started season. The
    // producers' auto-open fires only AFTER the photo is finalized, so it is never blocked here.
    try {
      if (window._orwellChatGate && window._orwellChatGate.blocked()) {
        if (window._orwellChatGate.recompute) window._orwellChatGate.recompute();
        return;
      }
    } catch (_) { /* gate unavailable → never block the chat */ }

    // ── #891 order-stability: per-session FIFO across a reload. A fresh composer send must never
    // jump AHEAD of an older, still-undispatched send for the same session — the restored outbox
    // (reload mid-hang) drains on its own schedule (boot restore at 600ms+ → dedupe → dispatch), so
    // an idle-looking composer can hide a queue that is still owed the earlier turns. When such items
    // exist (in memory, or still un-restored in sessionStorage during the boot window), the fresh
    // send JOINS the queue behind them instead of dispatching directly; the self-continuing drain
    // then dispatches everything in original send order. Scope mirrors the queue/offline branches:
    // plain composer chat only — headless machinery, slash commands, setup input, and
    // attachment-carrying sends (their upload needs the inline path) keep the direct route.
    if (!chatState.isStreaming && !_headless) {
      const _fifoInput = uiModule.el('message');
      const _fifoText = _fifoInput ? (_fifoInput.value || '') : '';
      const _fifoTrim = _fifoText.trim();
      if (_fifoTrim && !isCommand(_fifoTrim) &&
          slashCommands.getSetupMode && !slashCommands.getSetupMode() &&
          !fileHandlerModule.getPendingCount() &&
          !(_pendingRegenAttachments && _pendingRegenAttachments.length) &&
          _outboxHasBlockingSendFor(sessionModule.getCurrentSessionId())) {
        _enqueueSend(_fifoText);
        _armOutboxRetry();
        // Nudge the drain: the restore's own kick may already have run and parked on backoff.
        try { setTimeout(() => { try { _flushSendOutbox(); } catch (_) {} }, 0); } catch (_) {}
        return;
      }
    }

    // --- Send-path entry: block re-clicks between submit and stream start ---
    if (chatState._sendInFlight) return;
    chatState._sendInFlight = true;
    // Instant visual feedback so the user sees their click was accepted
    // even before the streaming button state kicks in below.
    const _earlyMessageInput = uiModule.el('message');
    if (_earlyMessageInput) _earlyMessageInput.disabled = true;
    if (submitBtn) submitBtn.classList.add('send-pending');
    const _releaseSendFlag = () => {
      chatState._sendInFlight = false;
      if (_earlyMessageInput) _earlyMessageInput.disabled = false;
      if (submitBtn) submitBtn.classList.remove('send-pending');
    };

    // --- Setup mode: intercept next message (but let slash commands through) ---
    if (!_headless) {
      const el = uiModule.el;
      const rawMsg = (el('message').value || '').trim();
      const currentSetupMode = slashCommands.getSetupMode();
      if (currentSetupMode && rawMsg && !isCommand(rawMsg)) {
        const mode = currentSetupMode;
        slashCommands.clearSetupMode(mode === 'endpoint-provider' || mode === 'endpoint-key-for-provider');
        el('message').value = '';
        if (window._syncModelPickerAutohide) window._syncModelPickerAutohide();
        if (uiModule.autoResize) uiModule.autoResize(el('message'));
        if (mode === true || mode === 'endpoint') {
          handleSetupInput(rawMsg);
        } else {
          handleSetupWizard(mode, rawMsg);
        }
        _releaseSendFlag();
        return;
      }
      if (currentSetupMode && rawMsg && isCommand(rawMsg)) {
        slashCommands.clearSetupMode();  // Clear setup mode, fall through to slash handler
      }
    }

    const el = uiModule.el;
    const msg = _headless ? overrideMsg : el('message').value;
    // Allow empty text when a regen carries over the original message's
    // attachment ids — a photo-only message still has something to send.
    if (!msg.trim() && !fileHandlerModule.getPendingCount() && !(_pendingRegenAttachments && _pendingRegenAttachments.length)) { _releaseSendFlag(); return; }

    // --- Slash commands: execute directly without AI (no session needed) ---
    if (!_headless && isCommand(msg.trim())) {
      const handled = await handleSlashCommand(msg.trim());
      if (handled) {
        el('message').value = '';
        if (window._syncModelPickerAutohide) window._syncModelPickerAutohide();
        if (uiModule.autoResize) uiModule.autoResize(el('message'));
        _releaseSendFlag();
        return;
      }
    }

    // ── #891 P0-2: an OFFLINE send goes STRAIGHT to the durable outbox — no doomed POST. ──
    // navigator.onLine says the device has no link: the fetch below is guaranteed to die at the
    // network layer and surface as a raw error/spinner. Instead: paint the optimistic bubble NOW
    // with an honest 'queued — offline' tag, capture the text in the reload-durable outbox, clear
    // the composer, and let the 'online' event / backoff retry drain it through the NORMAL send
    // path when the link returns (never a second send path — the drained send is a plain
    // handleChatSubmit). Attachment-carrying sends keep the normal path (their upload needs its own
    // network round-trip + error surface), as do headless machinery sends (their text is not the
    // player's words — the auto-continue/recovery family owns those semantics).
    if (!_headless && !_outboxOnline() && msg.trim() && !isCommand(msg.trim()) &&
        !fileHandlerModule.getPendingCount() && !(_pendingRegenAttachments && _pendingRegenAttachments.length)) {
      _enqueueSend(msg);
      _armOutboxRetry();
      _releaseSendFlag();
      return;
    }

    // --- BUG 1 (never eat a message): render the optimistic user bubble SYNCHRONOUSLY here,
    // BEFORE anything that might clear the composer or early-return. The first send of a session
    // has to await session/model materialization below (`materializePendingSession`,
    // `/api/default-chat`); previously those branches cleared the composer and returned with NO
    // bubble, so the user's text simply vanished ("Hello?" eaten; the 2nd message worked because by
    // then a session existed). The bubble is painted up front (in a PENDING state) so the message
    // is always visible; if materialization fails the bubble is marked unsent and the composer text
    // is RESTORED (never wiped into nothing). The later render block (post-attachment-upload) adopts
    // this element instead of painting a second bubble. Headless / skip-bubble sends never get one.
    const _wantOptimisticBubble = !_headless && !chatState._hideUserBubble;
    // ADR 0008: a client-temp id for the optimistic user bubble. The server stamps it on the
    // persisted user message, so on reconcile the sender ADOPTS this bubble to the canonical
    // {id, seq} (temp -> canonical) instead of fetching history and rendering a duplicate.
    // #985 P2-A: a flushed outbox send carries its bubble's PRE-STAMPED clientMsgId so the POST below
    // re-uses the exact same key the optimistic bubble already holds — at-most-once + clean adoption.
    const _clientMsgId = _queuedClientMsgId || ('c-' + ((window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (Date.now() + '-' + Math.random().toString(36).slice(2))));
    // The visible text for the optimistic bubble. Doc-edit context is folded into the display
    // string later (it only applies when a session already exists, never on the first-send path
    // these early returns guard), so the plain message is the correct pre-materialize display.
    const _earlyAttachInfo = (!_headless && fileHandlerModule.getPendingCount())
      ? fileHandlerModule.getPendingInfo() : null;
    let _userMsgEl = null;
    if (_queuedBubbleEl) {
      // #985 P2-A: a flushed outbox send already painted its bubble at enqueue time. ADOPT it (don't
      // paint a second one) — the adopt block below settles its msg-pending state. It already carries
      // the matching clientMsgId; re-stamp defensively so the POST + reconcile key are byte-identical.
      _userMsgEl = _queuedBubbleEl;
      _userMsgEl.dataset.clientMsgId = _clientMsgId;
    } else if (_wantOptimisticBubble) {
      _userMsgEl = addMessage('user', chatState._displayOverride || msg, null,
        _earlyAttachInfo ? { attachments: _earlyAttachInfo } : null);
      if (_userMsgEl) {
        _userMsgEl.dataset.clientMsgId = _clientMsgId;
        _userMsgEl.classList.add('msg-pending');
      }
    }
    // The composer text was just captured (`msg`) and is now mirrored in the bubble, so it is safe
    // to clear the composer immediately — BUT only once a send is actually going to proceed. On a
    // hard early-return (no model configured / materialize failed) we KEEP the bubble (marked
    // unsent) and RESTORE the composer so the user never loses their words. This helper centralizes
    // the "send is dead, don't eat the message" cleanup.
    const _abortSendKeepMessage = (assistantNote) => {
      if (_userMsgEl) {
        _userMsgEl.classList.remove('msg-pending');
        _userMsgEl.classList.add('msg-unsent');
        _userMsgEl.dataset.unsent = '1';
        // CA-2 / CA-26 (a11y): the "not sent" signal used to live ONLY in a CSS ::after
        // pseudo-element's `content` string — invisible to assistive tech (WCAG 4.1.3, Status
        // Messages requires it be "programmatically determined... without receiving focus"). Add a
        // REAL text node (styled identically via `.unsent-tag` in style.css) so it's always in the
        // accessibility tree, plus a one-time toast announcement (the app's existing
        // `role="status" aria-live="polite"` region, `uiModule.showToast`) that also gives the
        // screen-reader user an explicit remedy, not just a silent composer restore.
        try {
          const _roleEl = _userMsgEl.querySelector('.role');
          if (_roleEl && !_roleEl.querySelector('.unsent-tag')) {
            const _tag = document.createElement('span');
            _tag.className = 'unsent-tag';
            _tag.textContent = 'not sent';
            _roleEl.appendChild(_tag);
          }
        } catch (_) {}
        if (!_headless && uiModule && uiModule.showToast) {
          try { uiModule.showToast("Message not sent — it's back in your composer, ready to resend."); } catch (_) {}
        }
      }
      // Restore the composer text (it was never cleared on this path, but be explicit/idempotent so
      // a future reordering can't strand the words) — the message is preserved, never eaten.
      if (!_headless) {
        try {
          const _mi = el('message');
          if (_mi && !_mi.value) { _mi.value = msg; if (uiModule.autoResize) uiModule.autoResize(_mi); }
        } catch (_) {}
      }
      if (assistantNote) addMessage('assistant', assistantNote);
      _releaseSendFlag();
    };
    // B11 (2026-07-05) / CA-1, FLOW-1 (Blocker): this fired when the player clicked the engine-down
    // holding card's OWN "Go in anyway" affordance and then sent a message with no session ever
    // materializing — previously a raw vendored-chatbot string ("Use `/help`...", "the model
    // picker", "the `+` button") rendered via `addMessage('assistant', ...)`, i.e. attributed to the
    // narrator persona itself. In the game build that's the single most damaging possible immersion
    // break (a first-timer is taught mid-conversation that "Orwell" is a generic chat app). Gate on
    // isGameBuild(): the game build gets the same canonical diegetic interruption line used for every
    // other engine-down/error fallback; the general workspace keeps the real, actionable guidance.
    const _NO_SESSION_NOTE = isGameBuild()
      ? _ENGINE_INTERRUPT_LINE
      : ('No chat session active. You can:\n\n' +
         '- Open the model picker in the chat box and pick a model\n' +
         '- Use the `+` button in the model picker to add a model endpoint\n' +
         '- Use `/help` to see all available commands');

    // Materialize pending session (deferred from model click) on first message
    if (sessionModule.hasPendingChat && sessionModule.hasPendingChat()) {
      const ok = await sessionModule.materializePendingSession();
      if (!ok || !sessionModule.getCurrentSessionId()) { _abortSendKeepMessage(); return; }
    }

    if (!sessionModule.getCurrentSessionId()) {
      // Auto-create a session using default chat config. Always fetch fresh
      // so that a recent Settings change takes effect without a page reload.
      try {
        let dc = null;
        try {
          const dcRes = await fetch('/api/default-chat');
          dc = await dcRes.json();
          if (dc && dc.endpoint_url && dc.model) {
            try { window.__orwellDefaultChat = dc; } catch (_) {}
          }
        } catch (_) {
          dc = (typeof window !== 'undefined' && window.__orwellDefaultChat) || null;
        }
        if (dc && dc.endpoint_url && dc.model) {
          await sessionModule.createDirectChat(dc.endpoint_url, dc.model, dc.endpoint_id);
          const ok = await sessionModule.materializePendingSession();
          if (!ok || !sessionModule.getCurrentSessionId()) { _abortSendKeepMessage(); return; }
        } else {
          _abortSendKeepMessage(_NO_SESSION_NOTE);
          return;
        }
      } catch (e) {
        _abortSendKeepMessage(_NO_SESSION_NOTE);
        return;
      }
    }

    // --- API key guard: warn if message looks like an API key ---
    if (API_KEY_RE.test(msg.trim())) {
      if (!await window.styledConfirm('This looks like an API key. Sending it to the AI could expose it.\n\nDid you mean to use /setup instead?', { confirmText: 'Send anyway', danger: true })) {
        // #830 (optimistic-always): the early bubble was painted BEFORE this guard. The player
        // chose NOT to send — the text is still in the composer (never cleared on this path), so
        // remove the now-stale pending bubble instead of stranding a ghost message that will never
        // dispatch. (A flushed outbox send re-uses its queued bubble — that one is kept: its item
        // sits in awaiting-confirm and the outbox machinery owns its lifecycle.)
        if (_userMsgEl && !_queuedBubbleEl) { try { _userMsgEl.remove(); } catch (_) {} }
        _releaseSendFlag();
        return;
      }
    }


    const messageInput = el('message');
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';

    // Re-enable the textarea now that we've handed off to the stream: the
    // user wants to compose the next message while the AI is still talking.
    // The `isStreaming` flag is the re-click guard for the send button.
    if (messageInput) messageInput.disabled = false;
    updateSubmitButton('streaming', submitBtn);
    if (submitBtn) submitBtn.classList.remove('send-pending');
    chatState._sendInFlight = false;

    // Capture session ID for background stream detection
    const streamSessionId = sessionModule.getCurrentSessionId();
    chatState._streamSessionId = streamSessionId;
    // #1087 (SSE self-echo double): a NEW foreground POST gets a NEW server run id, so forget last
    // turn's own-run id for this session — the FIRST `run-started` self-echo seen while this POST is
    // live (noteRunStarted, below) re-learns it. Without this reset, turn 2's own echo would carry an
    // id != the stale recorded one and be mis-classified as a PEER run → deferred → resume-duplicated.
    try { delete chatState._ownRunIds[streamSessionId]; } catch (_) {}
    const streamQuery = msg;
    _lastReaderActivity = Date.now();

    // Acquire Web Lock to hint browser not to discard this tab while streaming
    if (navigator.locks) {
      navigator.locks.request('orwell-stream-' + streamSessionId, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) return; // Another stream already holds a lock — fine
        return new Promise(resolve => { _webLockRelease = resolve; });
      }).catch(e => console.warn('web lock acquire failed:', e)); // Ignore lock errors — best-effort
    }

    // Declare accumulated outside try block so it's accessible in catch
    let accumulated = '';
    // D2: per-stream SSE event counter — incremented for each processed data: line so the
    // self-resume knows how many events were already consumed and can resume from_seq there.
    let _sseEventCount = 0;
    // Also store on chatState so _trySelfResume (module-level, no closure access) can read it.
    chatState._sseEventCount ||= {};
    try { delete chatState._sseEventCount[streamSessionId]; } catch (_) {}
    chatState._sseEventCount[streamSessionId] = 0;
    // ADR 0012 §2.4: set if the server tells this (loser-of-the-bind) window the run lives under a
    // DIFFERENT canonical session id; converged onto in the finally (never mid-stream).
    let _adoptCanonicalAfterStream = null;
    // #1626: the producer (production-voice) name resolved this stream, remembered so we can ALSO
    // persist it under the canonical session id when this window is the loser-of-the-bind. The
    // orwell_narrator + canonical_session events can arrive in either order, so each writes through
    // to the other's id when both are known (see both handlers below).
    let _streamNarratorName = null;
    // ADR 0012 (GAP 2 — error-path consistency): set when this turn rendered a LIVE model error (e.g.
    // "Error 503"). The agent loop persists a FRIENDLY fallback ("The model returned an empty
    // response…") instead, so a peer/reload shows that text while the sender shows the raw error — two
    // windows, different text (the closest thing to the original "each window typing different
    // responses" complaint, on the error path). The finally FORCE-reconciles the sender's bubble to
    // the persisted message so the live + persisted + peer views all converge to ONE string. The
    // immediate live error feedback is kept; only the SETTLED state is reconciled.
    let _streamHadError = false;
    // P1 (OOBE cutover): set when createCharacter paints the inline "finalizing" indicator this
    // turn, so the first house-entry narration token can clear it (and the finally can safety-net).
    let _orwellFinalizingActive = false;
    // 2026-07-16 CodeRabbit fix (premiere-recovery seam): a DEDICATED latch for the
    // silent-death auto-refire (`_orwellPremiereContinueIfSilent`), decoupled from the UI-only
    // `_orwellFinalizingActive` above. `_orwellFinalizingActive` arms at tool_start (before success
    // is known) and clears on ANY delta including reasoning-only output — fine for a visual
    // indicator, but wrong for recovery: it could fire after a FAILED/refused creation, or fail to
    // fire after a reasoning-only completion (cleared before the finally ever sees it). This latch
    // arms ONLY once a createCharacter tool result confirms `started && !createRefused`, and clears
    // ONLY on a real (non-thinking) reply delta.
    let _orwellPremiereRecoveryArmed = false;
    // CodeRabbit follow-up (2026-07-17): set true ONLY in the catch block's genuine "User-initiated
    // stop" branch (an explicit Stop-button abort, never a timeout/offline/tab-recovery abort — those
    // are system interruptions the player did NOT ask for, so the silent-death recovery still applies
    // to them). An intentional Stop right after createCharacter succeeds but before any narration
    // streamed must NOT auto-refire a hidden continuation the player never asked for — that would
    // silently override their explicit cancel. Read by the finally block alongside
    // `_orwellPremiereRecoveryArmed`.
    let _orwellUserStoppedThisTurn = false;
    // Are we currently inside an unclosed <think> block? Toggled per think/answer
    // cycle so a multi-round agent response (one reasoning phase PER round) wraps each
    // round's reasoning in its own <think>…</think> instead of leaking rounds 2+ as text.
    let _thinkOpen = false;
    let holder = null;
    let finalMeta = null;
    let spinner = null;
    let timedOut = false;
    let processingProbeTimer = null;
    let processingProbeAbort = null;
    let _renderStream = () => {};
    let _cancelThinkingTimer = () => {};
    let _removeThinkingSpinner = () => {};
    // The whole-turn abort is an ACTIVITY-RESET IDLE timer (`_makeStreamIdleGuard`), not a one-shot.
    // `resetIdleTimeout` re-arms the idle countdown on each stream activity; `clearResponseTimeout`
    // is the permanent turn-end disarm (finally / WS handoff / refusal). Both are function-scoped
    // no-op stubs until the transport dispatch below wires the real guard.
    let resetIdleTimeout = () => {};
    let clearResponseTimeout = () => {};
    const clearProcessingProbe = () => {
      if (processingProbeTimer) {
        clearTimeout(processingProbeTimer);
        processingProbeTimer = null;
      }
      if (processingProbeAbort) {
        try { processingProbeAbort.abort(); } catch (_) {}
        processingProbeAbort = null;
      }
    };

    // Reset tracking variables at start
    currentAccumulated = '';
    currentHolder = null;
    
    try {
      // Re-enable auto-scroll when user sends a message
      uiModule.setAutoScroll(true);
      uiModule.scrollHistoryInstant();
      // Clear completed dot now that user is interacting
      if (sessionModule.clearStreamComplete) sessionModule.clearStreamComplete(sessionModule.getCurrentSessionId());

      // Check for document selection context before consuming display override
      const docSel = documentModule && documentModule.getSelectionContext();
      if (docSel) {
        const sels = Array.isArray(docSel) ? docSel : [docSel];
        const lineRefs = sels.map(s =>
          s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`
        );
        chatState._displayOverride = `[Doc edit: ${lineRefs.join(', ')}] ${msg}`;
      }

      const userDisplay = chatState._displayOverride || msg;
      chatState._displayOverride = null;
      const skipBubble = chatState._hideUserBubble;
      chatState._hideUserBubble = false;
      // Auto-recovery counter: carries across a turn's auto-continues, but resets
      // when the user genuinely sends a new message (so each task gets a fresh cap).
      // A real user turn (visible bubble) ALWAYS resets the budget — even if a
      // prior auto-continue's deferred click never cleared the pending flag — so a
      // stuck flag can't silently eat the next turn's recovery budget.
      if (!skipBubble) { chatState._autoNudges = 0; chatState._autoContinuePending = false; }
      else if (chatState._autoContinuePending) { chatState._autoContinuePending = false; }
      const _pendingAttachInfo = fileHandlerModule.getPendingCount() ? fileHandlerModule.getPendingInfo() : null;
      // Pre-read importable file contents before upload clears pending files
      const IMPORTABLE_EXT = /\.(txt|py|js|ts|html|htm|css|md|json|csv|yml|yaml|sh|sql|rs|go|java|c|cpp|h|rb|php|xml|jsx|tsx|log|toml|ini|conf|env|vue|svelte|scss|sass|less)$/i;
      const _importableFiles = [];
      if (_pendingAttachInfo && documentModule) {
        const rawFiles = fileHandlerModule.getPendingRaw ? fileHandlerModule.getPendingRaw() : [];
        for (let i = 0; i < _pendingAttachInfo.length; i++) {
          const att = _pendingAttachInfo[i];
          if (IMPORTABLE_EXT.test(att.name) && rawFiles[i]) {
            _importableFiles.push({ info: att, file: rawFiles[i] });
          }
        }
      }
      // ADOPT the optimistic bubble painted up front (BUG 1). The early render already created the
      // user bubble + stamped `_clientMsgId` before any session/model materialization could clear the
      // composer, so we DON'T paint a second one here — we just settle its state and reconcile its
      // visible text with the (possibly doc-edit-augmented) `userDisplay`. The `_userMsgEl` /
      // `_clientMsgId` are function-scoped from the early block.
      if (_userMsgEl) {
        _userMsgEl.classList.remove('msg-pending');
        // Doc-edit context augments the display string after the early bubble was painted with the
        // plain message — re-render the body so the user sees the same text the AI receives.
        if (userDisplay !== msg) {
          try {
            const _body = _userMsgEl.querySelector('.body');
            if (_body) _body.innerHTML = markdownModule.processWithThinking(markdownModule.squashOutsideCode(userDisplay));
          } catch (_) {}
        }
      } else if (!skipBubble) {
        // Defensive fallback: if the early render didn't happen (e.g. an unexpected state where the
        // bubble was suppressed early but is wanted now), paint it here so a message is NEVER eaten.
        _userMsgEl = addMessage('user', userDisplay, null, _pendingAttachInfo ? { attachments: _pendingAttachInfo } : null);
        if (_userMsgEl) _userMsgEl.dataset.clientMsgId = _clientMsgId;
      }
      // #891: the turn is genuinely sending now — a leftover 'queued'/'queued — offline' tag from the
      // outbox phase would be a stale status lie. (The flush also clears it; this is the belt.)
      if (_userMsgEl) _setQueuedTag(_userMsgEl, null);
      // A headless send never touches the user's composer (no clear, no draft wipe, no keyboard
      // dismiss) — the message came from a caller, not the textarea, so the user's draft is preserved.
      if (!_headless) {
      messageInput.value = '';
      messageInput.style.height = '';
      messageInput.dispatchEvent(new Event('input'));
      // G17 (refresh-persistence audit F3): a sent turn clears the persisted composer
      // draft — a refresh must never resurrect words the house already heard.
      if (window._orwellComposerDraftClear) window._orwellComposerDraftClear();
      // Mobile: dismiss the on-screen keyboard after sending. iOS in
      // particular ignores a bare blur() in some cases (or some other
      // listener refocuses straight after), so we temporarily mark the
      // input readonly which forces the keyboard to retract, then blur,
      // then drop the readonly attribute after the keyboard is gone so
      // typing still works for the next message.
      if (isNarrow()) {
        try {
          messageInput.setAttribute('readonly', 'readonly');
          messageInput.blur();
          const _dropReadonly = () => { try { messageInput.removeAttribute('readonly'); } catch {} };
          setTimeout(() => {
            // If the blur stuck, the input is no longer the active element —
            // safe to drop readonly now so the next message can be typed.
            // If it did NOT stick (some mobile browsers keep the textarea
            // focused after a programmatic blur), removing readonly here would
            // re-summon the keyboard mid-stream — the "bounce up" that then
            // lingers until the end-of-stream blur. In that case keep readonly
            // on (keyboard stays down) and drop it the moment the user taps to
            // type again, so typing still works without the bounce.
            if (document.activeElement === messageInput) {
              messageInput.addEventListener('pointerdown', _dropReadonly, { once: true });
              messageInput.addEventListener('focus', _dropReadonly, { once: true });
            } else {
              _dropReadonly();
            }
          }, 120);
        } catch {}
      }
      } // end if (!_headless) composer reset

      let ids = [];
      try {
        ids = await fileHandlerModule.uploadPending();
      } catch(e) {
        console.error('upload failed', e);
      }

      // Carry over the original message's file-ids on a regenerate so the new
      // send still references the same photos / docs (and picks up the user's
      // edited OCR text via the server-side .vision cache). Always CONSUME the
      // slot — even when empty / errored — so the regen ids can't bleed into
      // an unrelated next message if uploadPending() above had thrown.
      if (_pendingRegenAttachments && _pendingRegenAttachments.length) {
        ids = ids.concat(_pendingRegenAttachments);
      }
      _pendingRegenAttachments = null;

      // The optimistic user bubble was rendered before the upload assigned ids,
      // so image previews couldn't show (the renderer needs att.id). Now that
      // the upload resolved, stamp the ids — plus width/height for images so
      // the skeleton can size itself to the photo's aspect ratio — and
      // re-render so the thumbnail appears live, no refresh needed.
      if (_userMsgEl && _pendingAttachInfo && ids.length) {
        const _meta = fileHandlerModule.getLastUploadedMeta?.() || [];
        for (let i = 0; i < _pendingAttachInfo.length && i < ids.length; i++) {
          _pendingAttachInfo[i].id = ids[i];
          const _m = _meta[i];
          if (_m) {
            if (_m.width)  _pendingAttachInfo[i].width  = _m.width;
            if (_m.height) _pendingAttachInfo[i].height = _m.height;
          }
        }
        chatRenderer.updateMessageAttachments(_userMsgEl, _pendingAttachInfo);
      }

      // Offer to import text files to document library. #951: routed through the OrwellNotice kit
      // (an above-composer "continue"-kind notice) so it shares the ONE chrome/dismiss/motion/a11y
      // contract instead of hand-rolling its own banner + anchor + ×. Auto-dismisses after 15s.
      if (_importableFiles.length > 0 && window.OrwellNoticeKit) {
        const label = _importableFiles.length === 1
          ? `Import "${_importableFiles[0].info.name}" to document library?`
          : `Import ${_importableFiles.length} files to document library?`;
        const _imp = window.OrwellNoticeKit.create({
          id: 'import-prompt-banner',
          kind: 'continue',         // a quiet, dismissible above-composer nudge
          title: label,
          dismissible: true,
          persistDismiss: false,    // transient: it must reappear on a future upload, not "forever"
          autoDismissMs: 15000,
        });
        const body = document.createElement('span');
        body.style.cssText = 'display:inline-flex;align-items:center;';
        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import';
        importBtn.style.cssText = 'padding:2px 12px;border:1px solid var(--fg);border-radius:4px;background:none;color:var(--fg);cursor:pointer;font-size:12px;';
        importBtn.addEventListener('click', async () => {
          importBtn.disabled = true;
          importBtn.textContent = 'Importing…';
          const EXT_LANG = {'.py':'python','.js':'javascript','.ts':'typescript','.html':'html','.css':'css','.md':'markdown','.json':'json','.yml':'yaml','.yaml':'yaml','.sh':'bash','.sql':'sql','.rs':'rust','.go':'go','.java':'java','.c':'c','.cpp':'cpp','.rb':'ruby','.php':'php','.xml':'xml','.jsx':'javascript','.tsx':'typescript'};
          let imported = 0;
          for (const { info, file } of _importableFiles) {
            try {
              const content = await file.text();
              const dotIdx = info.name.lastIndexOf('.');
              const title = dotIdx > 0 ? info.name.slice(0, dotIdx) : info.name;
              const ext = dotIdx >= 0 ? info.name.slice(dotIdx).toLowerCase() : '';
              await fetch(`${API_BASE}/api/document`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title, language: EXT_LANG[ext] || '', content }),
              });
              imported++;
            } catch (e) { console.error('Import failed:', info.name, e); }
          }
          _imp.update({ title: `Imported ${imported} file${imported !== 1 ? 's' : ''}`, body: '' });
          setTimeout(() => _imp.hide(), 2000);
        });
        body.appendChild(importBtn);
        _imp.show();
        _imp.setBody(body);
      }

      // Auto-save document editor content before sending so the AI sees latest text
      if (documentModule && documentModule.isPanelOpen() && documentModule.getCurrentDocId()) {
        try { await documentModule.saveDocument(); } catch(e) { console.warn('doc auto-save failed', e); }
      }

      // Inject document selection context if present
      let finalMsg = msg;
      if (docSel) {
        const sels = Array.isArray(docSel) ? docSel : [docSel];
        if (sels.length === 1) {
          const s = sels[0];
          const lineRef = s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}-${s.endLine}`;
          finalMsg = `In the document, edit this specific text (${lineRef}):\n\`\`\`\n${s.text}\n\`\`\`\n\nInstruction: ${msg}`;
        } else {
          const parts = sels.map((s, i) => {
            const lineRef = s.startLine === s.endLine ? `line ${s.startLine}` : `lines ${s.startLine}-${s.endLine}`;
            return `Selection ${i + 1} (${lineRef}):\n\`\`\`\n${s.text}\n\`\`\``;
          });
          finalMsg = `In the document, edit these specific sections:\n\n${parts.join('\n\n')}\n\nInstruction: ${msg}`;
        }
      }

      // Apply inject prefix/suffix
      const _inject = presetsModule.getInject ? presetsModule.getInject() : { prefix: '', suffix: '' };
      let _finalMsgWithInject = finalMsg;
      if (_inject.prefix) _finalMsgWithInject = _inject.prefix + ' ' + _finalMsgWithInject;
      if (_inject.suffix) _finalMsgWithInject = _finalMsgWithInject + ' ' + _inject.suffix;

      const fd = new FormData();
      fd.append('message', _finalMsgWithInject);
      fd.append('session', streamSessionId);
      fd.append('client_msg_id', _clientMsgId);  // ADR 0008: optimistic temp id for bubble adoption
      if (ids.length) fd.append('attachments', JSON.stringify(ids));
      // Auto-save & send active doc ID so the backend sees latest content
      if (documentModule && documentModule.isPanelOpen() && documentModule.getCurrentDocId()) {
        try { await documentModule.saveDocument({ silent: true }); } catch (_e) { /* best-effort */ }
        fd.append('active_doc_id', documentModule.getCurrentDocId());
      }
      // Web toggle: pre-search in Chat mode, tool permission in Agent mode
      const toggleState = Storage.loadToggleState();
      let isAgentMode = (toggleState.mode || 'chat') === 'agent';
      // Auto-escalate to agent mode when a document is open — the user expects
      // the AI to see the document and have tools to edit it
      if (!isAgentMode && documentModule && documentModule.isPanelOpen() && documentModule.getCurrentDocId()) {
        isAgentMode = true;
      }
      fd.append('mode', isAgentMode ? 'agent' : 'chat');
      if (el('web-toggle').checked) {
        if (isAgentMode) {
          fd.append('allow_web_search', 'true');
        } else {
          fd.append('use_web', 'true');
        }
      }
      if (el('research-toggle').checked) {
        fd.append('use_research', 'true');
        // Research always runs in chat mode — override agent if set
        fd.set('mode', 'chat');
      }
      if (el('bash-toggle').checked) {
        fd.append('allow_bash', 'true');
      }
      // Plan mode: agent investigates read-only and proposes a plan to approve.
      // Only meaningful in agent mode, and never alongside deep research.
      // _forcePlanOff is a one-shot set by "Approve & Run" so the execution turn
      // runs with full tools even though the Plan toggle is still on.
      const _planToggle = el('plan-toggle');
      const planTurn = !_forcePlanOff && isAgentMode && _planToggle && _planToggle.checked && !el('research-toggle').checked;
      _forcePlanOff = false;
      if (planTurn) {
        fd.append('plan_mode', 'true');
        fd.set('mode', 'agent');
      } else if (isAgentMode) {
        // Executing (not proposing): send the stored plan back so the backend
        // pins it in context and the agent can always re-reference it.
        const _sp = _getStoredPlan();
        if (_sp) fd.append('approved_plan', _sp);
      }
      const ragChk = el('rag-toggle');
      if (ragChk && !ragChk.checked) {
        fd.append('use_rag', 'false');
      }
      const incognitoChk = el('incognito-toggle');
      if (incognitoChk && incognitoChk.checked) {
        fd.append('incognito', 'true');
      }
      const _ws = (Storage.KEYS && Storage.get(Storage.KEYS.WORKSPACE, '')) || '';
      if (_ws) {
        fd.append('workspace', _ws);
      }
      if (presetsModule.getSelectedPreset()) {
        fd.append('preset_id', presetsModule.getSelectedPreset());
      }


      const abortCtrl = new AbortController();
      abortCtrl._reason = '';
      chatState.currentAbort = abortCtrl;

      const _tState = Storage.loadToggleState();
      const _isAgent = (_tState.mode || 'chat') === 'agent';

      // Idle-abort bound: 6 min for research/agent mode, 2 min otherwise. This bounds the max gap
      // between ANY two stream activities (the pre-first-token wait AND every mid-stream gap), so a
      // mid-stream SSE stall aborts + recovers instead of hanging reader.read() forever (freeze fix).
      const idleMs = (el('research-toggle').checked || _isAgent)
        ? STREAM_IDLE_TIMEOUT_AGENT_MS : STREAM_IDLE_TIMEOUT_MS;
      const _idleGuard = _makeStreamIdleGuard(idleMs, () => {
        // Fired only after a genuine IDLE gap. Drive the SAME recovery the whole-turn timeout always
        // had: mark timed-out, tell the server to stop the run, and abort the reader — the catch's
        // `timedOut || abortReason==='timeout'` branch preserves any partial + the finally recovers UI.
        if (!abortCtrl.signal.aborted) {
          timedOut = true;
          abortCtrl._reason = 'timeout';
          try {
            if (streamSessionId) {
              fetch(`/api/chat/stop/${encodeURIComponent(streamSessionId)}`, {
                method: 'POST',
                credentials: 'same-origin',
              }).catch(() => {});
            }
          } catch (_) {}
          abortCtrl.abort();
        }
      });
      _idleGuard.activity();                 // initial arm — bounds the pre-first-token wait as before
      resetIdleTimeout = () => { _idleGuard.activity(); };   // re-arm on each stream activity
      clearResponseTimeout = () => { _idleGuard.disarm(); }; // permanent turn-end disarm

      const box = el('chat-history');
      holder = document.createElement('div');
      holder.className = 'msg msg-ai streaming';

      // Track holder globally so stop button can access it
      currentHolder = holder;
      holder._researchQuery = msg; // Store query for notification text
      
      const modelName = sessionModule.getCurrentModel() || null;

      let loadingText = 'Initializing...';

      if (el('web-toggle').checked && !_isAgent) {
        const _searchLabel = searchModule ? searchModule.getProviderLabel() : 'web';
        loadingText = `Searching via ${_searchLabel}...<br>
                       <span style="font-size: 0.9em; opacity: 0.8;">
                       Query: "${msg.substring(0, 50)}${msg.length > 50 ? '...' : ''}"<br>
                       Fetching top results...</span>`;
      } else if (el('research-toggle').checked) {
        loadingText = 'Deep research mode active...';
      } else {
        loadingText = 'Processing request...';
      }

      var roleLabel = _senderLabel(_modelRouteLabel(modelName, modelName));
      var _charNameInit = presetsModule.getCharacterName ? presetsModule.getCharacterName() : '';
      if (_charNameInit) roleLabel = _charNameInit;
      const roleTs = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      holder.innerHTML = `<div class="role">${uiModule.esc(roleLabel)} <span class="role-timestamp">${roleTs}</span></div><div class="body"></div>`;
      holder._requestedModel = modelName;
      holder._actualModel = modelName;
      // #1626 increment 2: seed the explicit character label at creation (the SAME source model_info
      // reads) so a mid-stream byline refresh (orwell_narrator arriving BEFORE model_info) preserves a
      // preset NPC label instead of clobbering it with the producer name. Empty ⇒ producer/default.
      holder._characterName = _charNameInit;
      _applyModelColor(holder.querySelector('.role'), modelName);
      holder.style.position = 'relative';
      
      // Create spinner
      spinner = spinnerModule.create(_waitLabel('init', 'Initializing'), 'right', 'wave');
      currentSpinner = spinner;
      const bodyDiv = holder.querySelector('.body');
      bodyDiv.appendChild(spinner.createElement());
      spinner.start();
      
      // Update spinner message based on mode
      if (el('web-toggle').checked && !_isAgent) {
        spinner.updateMessage('Searching web with ' + (searchModule ? searchModule.getProviderLabel() : 'SearXNG'));
        setTimeout(() => spinner.updateMessage('Processing results'), 1500);
      } else if (el('research-toggle').checked) {
        spinner.updateMessage('Researching');
        setTimeout(() => spinner.updateMessage('Analyzing sources'), 1500);
      } else {
        spinner.updateMessage(_waitLabel('waiting', 'Processing request'));
        const endpointUrlForProbe = sessionModule.getCurrentEndpointUrl ? sessionModule.getCurrentEndpointUrl() : null;
        if (endpointUrlForProbe && modelName) {
          processingProbeTimer = setTimeout(async () => {
            processingProbeTimer = null;
            if (accumulated || !spinner || !spinner.element || (chatState.currentAbort && chatState.currentAbort.signal.aborted)) return;
            processingProbeAbort = new AbortController();
            try {
              spinner.updateMessage('Checking model endpoint');
              const status = await _probeCurrentEndpointStatus(endpointUrlForProbe, processingProbeAbort.signal);
              if (accumulated || !spinner || !spinner.element || (chatState.currentAbort && chatState.currentAbort.signal.aborted)) return;
              if (!status) {
                spinner.updateMessage(_waitLabel('still', 'Still waiting for model'));
              } else if (status.alive) {
                const latency = status.latency_ms ? ` (${status.latency_ms}ms)` : '';
                spinner.updateMessage(`Endpoint online${latency}; waiting for first token`);
              } else {
                // Probe confirms the endpoint isn't responding. Don't
                // sit on a hung fetch — give the user 5s to read the
                // status, then auto-abort with reason='offline' so the
                // catch handler shows a clean "switch model" message
                // instead of leaving the spinner spinning forever.
                if (status.error) console.warn('Model endpoint probe failed:', status.error);
                let _countdown = 5;
                spinner.updateMessage(`Endpoint offline — cancelling in ${_countdown}s`);
                const _tick = setInterval(() => {
                  _countdown--;
                  if (!spinner || !spinner.element || (chatState.currentAbort && chatState.currentAbort.signal.aborted) || accumulated) {
                    clearInterval(_tick);
                    return;
                  }
                  if (_countdown > 0) {
                    spinner.updateMessage(`Endpoint offline — cancelling in ${_countdown}s`);
                  } else {
                    clearInterval(_tick);
                    if (chatState.currentAbort && !chatState.currentAbort.signal.aborted) {
                      chatState.currentAbort._reason = 'offline';
                      chatState.currentAbort.abort();
                    }
                  }
                }, 1000);
              }
            } catch (e) {
              if (e && e.name !== 'AbortError' && spinner && spinner.element && !accumulated) {
                spinner.updateMessage(_waitLabel('still', 'Still waiting for model'));
              }
            } finally {
              processingProbeAbort = null;
            }
          }, 10000);
        }
      }
      
      const researchBtn = el('research-toggle-btn');
      if (el('research-toggle').checked && researchBtn) {
        researchBtn.disabled = true;
        researchBtn.classList.remove('active');
      }
      box.appendChild(holder);
      uiModule.scrollHistory();

      const enableResearchBtn = () => {
        if (!researchBtn) return;
        researchBtn.disabled = false;
        researchBtn.classList.toggle('active', el('research-toggle').checked);
      };

      if (el('research-toggle').checked && researchBtn) {
        researchBtn.style.display = 'none';
        // Uncheck research toggle so follow-up messages don't trigger another research
        el('research-toggle').checked = false;
      }

      // User's current UTC offset in minutes (east of UTC). Threaded into
      // the agent so natural-language times like "today at 9pm" are
      // interpreted in YOUR timezone, not the server's.
      const _tzOffsetMin = -new Date().getTimezoneOffset();
      const _tzName = (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
        catch { return ''; }
      })();

      // ── #891 order-stability: durable in-flight record for a PLAYER-VISIBLE send ──────────
      // A direct composer send previously had NO durable record while its POST was in flight — a
      // reload during a long-hanging request (server wedge) lost the message entirely, and a queued
      // sibling then restored and dispatched FIRST (send-order inversion). Register the turn in the
      // outbox's awaiting-confirm bucket (persisted 'state:inflight' — the exact lifecycle a flushed
      // queued send already has) right before the transport dispatch, covering the whole hang window
      // on BOTH the WS up-frame and the SSE POST. Released when a server row carrying the
      // clientMsgId is observed (the adopt pass → _outboxConfirmDelivery — the stream-end finally
      // always runs one reconcile), folded by the network-requeue/mark-failed paths, or explicitly
      // released on a client-visible refusal below. Idempotent: a flushed outbox send is already
      // tracked, so this no-ops for it. Scope: a visible user bubble only (headless machinery text
      // must never restore as a player turn), no attachments (a restored re-send can't carry them),
      // never incognito (its row never persists — a reload must not resurrect it).
      const _incogChk = el('incognito-toggle');
      if (_userMsgEl && !ids.length && !(_incogChk && _incogChk.checked)) {
        try { _outboxTrackInflightSend(_clientMsgId, msg, streamSessionId, _userMsgEl); } catch (_) {}
      }

      // ── WebSocket Phase-1 up-frame (ADR 0017 §3.5) ──────────────────────────
      // When the socket is live, the turn goes UP as a `turn` frame instead of the
      // SSE POST. The engine hop, the queue-don't-cancel policy, and the casting
      // single-flight guard all live server-side below the transport — the socket only
      // carries the frame + the 0065 `expectedBeatSeq` CAS. The reply streams back as
      // `chat` event frames into THIS already-created holder via the persistent consumer
      // (_onWsChatFrame). We pin the holder + spinner as the render target and skip the
      // fetch. Dormant when the flag is off (byte-identical SSE path preserved).
      if (_wsChatActive() && streamSessionId) {
        const _bodyDiv = holder.querySelector('.body');
        let _sc = _bodyDiv && _bodyDiv.querySelector('.stream-content');
        if (_bodyDiv && !_sc) { _sc = document.createElement('div'); _sc.className = 'stream-content'; _bodyDiv.appendChild(_sc); }
        _wsPinRound({ holder: holder, contentDiv: _sc, state: {}, reply: '', reasoning: '',
                     sessionId: streamSessionId, clientMsgId: _clientMsgId, _spinner: spinner });
        try {
          await window.OrwellWs.sendTurn({
            message: _finalMsgWithInject,
            clientMsgId: _clientMsgId,
            mode: isAgentMode ? 'agent' : 'chat',
            expectedBeatSeq: (window.OrwellWs.lastBeatSeq && window.OrwellWs.lastBeatSeq()) || undefined
          });
          // Accepted: the persistent consumer renders the reply frames and runs the
          // settle on `done` (it releases _streamSessionId + reconciles). Keep the
          // active-stream lock set until then so a racing reconcile defers past us.
          if (clearResponseTimeout) clearResponseTimeout();
          return;
        } catch (err) {
          // ── #1878: stale-beat auto-retry once ──
          if (err && err.code === "stale-beat") {
            // err.detail.beatSeq was already adopted by orwellWs.js _adoptBeat, so
            // our next sendTurn will get the fresh expectedBeatSeq from lastBeatSeq().
            try {
              await window.OrwellWs.sendTurn({
                message: _finalMsgWithInject,
                clientMsgId: _clientMsgId,
                mode: isAgentMode ? 'agent' : 'chat',
                // Don't pass expectedBeatSeq — sendTurn uses lastBeatSeq() as default
              });
              // Retry ACCEPTED — normal stream flow continues. Keep the pinned round.
              if (clearResponseTimeout) clearResponseTimeout();
              return;
            } catch (retryErr) {
              // Retry failed again — fall through to existing cleanup + restore composer.
              // Log the double-failure so it's not silent.
              console.warn('[orwell #1878] stale-beat retry ALSO failed:', retryErr);
            }
          }

          // ── Pre-stream refusal (stale-beat / forbidden / not-bound) — release the in-flight record so a later reload can't resurrect a turn the player already saw fail. Auto-retry is the only hold — once it's a client-visible refusal, drop the durable copy. ──
          try { _outboxReleaseInflightSend(_clientMsgId); } catch (_) {}
          _wsResetRound();
          if (clearResponseTimeout) clearResponseTimeout();
          try { if (spinner) spinner.destroy(); } catch (_) {}
          if (chatState._streamSessionId === streamSessionId) chatState._streamSessionId = null;
          try { if (holder) holder.remove(); } catch (_) {}

          // ── #1878: restore composer text + visible notice when auto-retry failed or wasn't stale-beat ──
          // The player's text was in _finalMsgWithInject. Restore the composer so they don't have to retype.
          try {
            const msgEl = document.getElementById('message');
            if (msgEl) msgEl.value = _finalMsgWithInject;
          } catch (_) {}

          try { await softReloadHistory(streamSessionId); } catch (_) {}
          return;
        }
      }

      const res = await fetch(`${API_BASE}/api/chat_stream`, {
        method: 'POST',
        body: fd,
        headers: { 'X-Tz-Offset': String(_tzOffsetMin), 'X-Tz-Name': _tzName },
        signal: abortCtrl.signal
      });
      
      if (!res.ok) {
        clearResponseTimeout();
        // #891 order-stability: the server REFUSED this send with a client-visible error (rendered
        // below) — no row was written for it. Release the durable in-flight record so a later reload
        // can't resurrect a turn the player already saw fail (they retry consciously).
        try { _outboxReleaseInflightSend(_clientMsgId); } catch (_) {}
        if (res.status === 404) {
          // Session was deleted (e.g. by AI) — reload and go to welcome
          holder.remove();
          if (sessionModule) await sessionModule.loadSessions();
          return;
        }
        let errText = `Error ${res.status}`;
        try {
          const errBody = await res.text();
          // Parse nested JSON error if present
          const m = errBody.match(/"message"\s*:\s*"([^"]+)"/);
          if (m) errText = m[1].replace(/\\"/g, '"');
          else if (errBody.length < 200) errText = errBody;
        } catch {}
        // Auto-switch to chat mode for tool-related errors
        if (errText.includes('tool') || errText.includes('auto')) {
          errText = 'This model doesn\'t support agent tools — switched to Chat mode. Try again.';
          const _ab = document.getElementById('mode-agent-btn');
          const _cb = document.getElementById('mode-chat-btn');
          if (_ab && _cb) {
            _ab.classList.remove('active');
            _cb.classList.add('active');
            const _toggle = _ab.closest('.mode-toggle');
            if (_toggle) _toggle.classList.add('mode-chat');
          }
          if (typeof Storage !== 'undefined' && Storage.KEYS) {
            const _st = Storage.getJSON(Storage.KEYS.TOGGLES, {});
            _st.mode = 'chat';
            Storage.setJSON(Storage.KEYS.TOGGLES, _st);
          }
        }
        // F-S4-C (audit): a stream/connection error is a SYSTEM notice, NOT the GM's voice. The pre-created
        // bubble is `msg msg-ai` (Big Brother) WITH a GM `.role` label, so typing a raw "Error 502 / upstream
        // model error" into it read as in-game narration (immersion break). Reclassify it to the quiet
        // `.msg-system` style (left-border, no GM avatar) AND drop the `.role` label so nothing attributes the
        // failure to a houseguest; frame a generic connection failure out-of-character (the helpful tool-mode-
        // switch message set above keeps its own copy). The error path returns right after, so rebuilding the
        // idle holder is side-effect-free.
        try {
          holder.className = 'msg msg-system';
          holder.innerHTML = '<div class="body"></div>';
        } catch (_) {}
        if (!/Chat mode/i.test(errText)) {
          errText = `⚠ Connection error — your message didn't go through. Try again.`;
        }
        typewriterInto(holder.querySelector('.body'), errText);
        enableResearchBtn();
        return;
      }

      // Mark the chat log busy while streaming so screen readers wait for the
      // settled response instead of announcing every token. Cleared in finally.
      const _chatLog = document.getElementById('chat-history');
      if (_chatLog) _chatLog.setAttribute('aria-busy', 'true');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let metrics = null;
      let isThinking = false;
      let thinkingStartTime = null;
      // Streaming TTS: synthesize sentence-by-sentence during streaming (assigns the hoisted flag).
      streamingTTS = !!(window.aiTTSManager && window.aiTTSManager.autoPlay && window.aiTTSManager.available);
      if (streamingTTS) window.aiTTSManager.streamingStart();
      // #829 turn-coalescing: ALL agent-loop rounds of one player turn render into the ONE `holder`
      // bubble as stacked frozen segments (the "growing bubble"). `roundHolder` therefore stays ===
      // `holder` for the whole turn — it is kept as an alias so the per-round render/finalize sites
      // read uniformly. (Pre-#829 this was reassigned to a fresh per-round bubble; that per-round
      // mount/hide/jump — plus the #834 turn-header-promotion it needed — is gone with one bubble.)
      let roundHolder = holder;       // The one turn bubble (alias of holder; never reassigned)
      let roundText = '';             // Text accumulated for current round (MERGED reply+reasoning)
      // F8: per-round channel-split buffers. The BODY renders roundReplyText (reasoning-free by
      // construction); the live "Thinking" accordion renders roundReasoningText. These MUST be
      // reset wherever roundText is reset (agent_step / teacher_takeover) — see those sites.
      let roundReplyText = '';        // deltas with json.thinking falsy (the public reply)
      let roundReasoningText = '';    // deltas with json.thinking truthy (reasoning → accordion)
      // #829 turn-coalescing: has this turn spanned 2+ agent-loop rounds (i.e. did an
      // agent_step fire)? When true, ALL rounds render into the ONE `holder` bubble as
      // stacked frozen segments (the "growing bubble") — the stream-end finalize then
      // commits only the LAST round's segment instead of re-rendering the whole body.
      let _turnCoalesced = false;
      // S2a realignment (#1664): set true once the realign_body handler has re-rendered THIS bubble's
      // body from the corrected (excised) text WITH the Thinking accordion rebuilt. The stream-end
      // finalize then SKIPS its body re-render for this holder (it would otherwise re-render from the
      // reply-only roundReplyText and drop the accordion) — everything else in finalize still runs.
      let _realignedBodyRendered = false;
      let currentToolBubble = null;   // Current tool execution bubble
      let roundFinalized = false;     // Whether current round's text is finalized
      let _sourcesHtml = '';          // Sources box HTML to prepend to body
      let _sourcesExpanded = false;   // Track if user expanded sources during stream
      let _sourcesData = null;        // Raw sources data for rebuilding
      let _sourcesType = '';          // 'web' or 'research'
      let _findingsData = null;      // Raw findings data for collapsible box
      // _keepResearchOn removed — clarification state now persisted server-side via DB mode
      // Insert sources box as a stable DOM node that won't be replaced during streaming.
      // Returns the content container to use for innerHTML updates.
      // _ensureStreamLayout moved to ./chatStreamLoop.js (#1414 R3 PR8) — imported at module top;
      // called below (in _renderStream + the delta/tool handlers) exactly as before.
      const esc = uiModule.esc;
      // Remove thinking spinner helper
      _removeThinkingSpinner = () => {
        const el = document.querySelector('.agent-thinking-dots');
        if (el) {
          if (el._spinner) el._spinner.destroy();
          el.remove();
        }
      };

      // Tool-aware thinking spinner: `_lastToolName` tracks the latest tool the model invoked and
      // STAYS here (the tool handlers reassign it). The label map (_toolLabels), the label lookup
      // (_thinkingLabel), the search icon, and the spinner mount (_showThinkingSpinner) all moved to
      // ./chatStreamLoop.js (#1414 R3 PR8) — imported at module top; called below unchanged.
      let _lastToolName = '';
      // C14 (immersion): the Big Brother engine tools render as quiet production
      // beats — a label, never raw camelCase names or JSON payloads in the player's
      // transcript. Applies wherever these names appear (they exist only in the game).
      // E96 (ruling #11): the game build carries no Documents vertical — the
      // export item is removed from the DOM, not just hidden.
      if (document.body.hasAttribute('data-game-build')) {
        const docBtn = document.getElementById('export-doc-btn');
        if (docBtn) docBtn.remove();
      }
      // _orwellToolBeats now lives in ./orwellToolBeats.js (single source of truth,
      // imported at module top, shared with the history-reload path in
      // chatRenderer.js so the live + reload renders cannot drift).
      // _toolLabels, _thinkingLabel, and _showThinkingSpinner moved to ./chatStreamLoop.js
      // (#1414 R3 PR8) — imported at module top. `_toolLabels` is used by the tool_start handler
      // below (`_toolLabels[json.tool.toLowerCase()]`); `_thinkingLabel(_lastToolName)` +
      // `_showThinkingSpinner` are driven by `_scheduleThinkingSpinner` below.

      // Auto-show thinking spinner after text stops streaming
      let _textPauseTimer = null;
      function _scheduleThinkingSpinner() {
        if (_textPauseTimer) clearTimeout(_textPauseTimer);
        _textPauseTimer = setTimeout(() => {
          if (!document.querySelector('.agent-thinking-dots') && chatState.isStreaming) {
            _showThinkingSpinner(_thinkingLabel(_lastToolName));
          }
        }, 400);
      }
      _cancelThinkingTimer = () => {
        if (_textPauseTimer) { clearTimeout(_textPauseTimer); _textPauseTimer = null; }
      };

      // Document streaming state (text-fence detection)
      let _docFenceOpened = false;
      let _docFenceContentStart = -1;
      let _liveThinkSection = null;
      let _liveThinkContent = null;
      let _liveThinkInner = null;
      let _liveThinkHeader = null;
      let _liveThinkSpinnerSlot = null;
      let _liveThinkTimerEl = null;
      let _liveThinkToggle = null;
      let _liveThinkDomId = null;

      function _replyAfterClosedThinking(text) {
        const closeRe = /<\/(?:think(?:ing)?|thought)>|<channel\|>/gi;
        let match = null;
        let last = null;
        while ((match = closeRe.exec(text || '')) !== null) last = match;
        if (!last) return '';
        return (text || '').slice(last.index + last[0].length).trimStart();
      }

      // Direct render helper for streaming text
      _renderStream = () => {
        // F8: the BODY renders the reply-only buffer (roundReplyText — deltas with json.thinking
        // falsy). Reasoning is structurally ABSENT here, so it can NEVER paint in the public
        // bubble; the live "Thinking" accordion renders roundReasoningText separately. (A model
        // that inlines literal <think> tags on the CONTENT channel still works: processWithThinking
        // extracts/handles inline <think> and, in the game build, scrubs operator asides.)
        const dt = stripToolBlocks(roundReplyText);
        const bodyEl = roundHolder.querySelector('.body');
        const contentEl = _ensureStreamLayout(bodyEl);

        // #828: classify the WRAP as an OOC/producer aside on every live delta — the SAME
        // detectOocAside verdict the reload path (chatRenderer.addMessage) applies — so the
        // bubble picks up `.msg-ooc`/`.msg-ooc-producer` the instant the text resolves to a
        // whole-message `((...))` wrap, not only after a refresh. `dt` unchanged when it isn't
        // (yet) a whole-wrap message, so ordinary narration renders byte-identically to before.
        const _liveOoc = chatRenderer.applyOocClass(roundHolder, dt.trim(), 'assistant');
        const displayText = _liveOoc.text;

        // When the reasoning accordion has collapsed in-place, a dedicated reply container exists
        // — render the reply into it (preserve the thinking bar when there's no reply yet).
        const liveReply = contentEl.querySelector('.live-reply-content');
        if (liveReply) {
          const replyTrimmed = displayText.trim();
          if (replyTrimmed) {
            // #828: `displayText` DROPS the `((`/`))` markers the instant the wrap is classified
            // OOC — that is not an append-only extension of the raw text the renderer already
            // committed, so a renderer built against the pre-classification (unstripped) text
            // must not keep receiving the shorter, stripped one (streamingRenderer.js's `update`
            // precondition). Recreate on the ooc-state EDGE rather than every call.
            const r = (liveReply._streamRenderer && liveReply._streamRendererOoc === _liveOoc.ooc)
              ? liveReply._streamRenderer
              : (liveReply._streamRendererOoc = _liveOoc.ooc,
                 liveReply._streamRenderer = createStreamRenderer(liveReply, {
                   render: (t) => markdownModule.processWithThinking(markdownModule.squashOutsideCode(t)),
                   hljs: window.hljs,
                 }));
            r.update(replyTrimmed);
          }
          uiModule.scrollHistory();
          return;
        }

        // Normal streaming: incremental render (freeze finalized blocks, re-render only the
        // growing tail, highlight each code block once). See streamingRenderer.js.
        const renderer = (contentEl._streamRenderer && contentEl._streamRendererOoc === _liveOoc.ooc)
          ? contentEl._streamRenderer
          : (contentEl._streamRendererOoc = _liveOoc.ooc,
             contentEl._streamRenderer = createStreamRenderer(contentEl, {
               render: (t) => markdownModule.processWithThinking(markdownModule.squashOutsideCode(t)),
               hljs: window.hljs,
             }));
        renderer.update(displayText);
        uiModule.scrollHistory();
      };

      // #829 turn-coalescing (coalesceRounds / oneBubblePerTurn — the "growing bubble"):
      // FREEZE the CURRENT agent-loop round's reply + reasoning as a permanent segment INSIDE
      // the one turn bubble, so the next round appends a fresh `.stream-content` segment BELOW
      // it (the bubble GROWS) instead of minting a per-round `.msg-continuation` bubble. The
      // reply is rendered reply-ONLY (roundReplyText, F8) through the SAME processWithThinking
      // chain the reload/tool_start paths use; the round's reasoning stays in its own
      // `.thinking-section` accordion (built inside this same `.stream-content`) and is NEVER
      // spliced into the reply body — the reply/reasoning channel split holds per round. An
      // empty round (no reply, no reasoning) drops its segment so no hidden per-round holder
      // lingers; the turn bubble itself always persists (no mount/hide/jump).
      const _commitRoundSegment = () => {
        if (!roundHolder) return;
        const _cBody = roundHolder.querySelector('.body');
        if (!_cBody) return;
        const seg = _cBody.querySelector('.stream-content');
        // #829 OOC per-segment fix (Greptile P1): the live `_renderStream` toggled
        // `msg-ooc`/`msg-ooc-producer` on the SHARED holder while this round streamed. In a
        // coalesced turn that is wrong — a LATER non-OOC round's holder-level classification
        // would strip the class off the shared bubble and an EARLIER OOC segment would settle as
        // ordinary narration. So CLEAR it from the holder here and carry each round's OOC state on
        // ITS OWN segment (classified below). Single-round turns never call this, so their
        // holder-level classification (test #828) is untouched.
        roundHolder.classList.remove('msg-ooc', 'msg-ooc-producer');
        if (!seg) return;
        const dtRaw = stripToolBlocks(roundReplyText);
        const hasReply = !!dtRaw.trim();
        const thinkSection = seg.querySelector('.thinking-section');
        // Scope the emptiness check to the reasoning BODY, not the whole `.thinking-section` (its
        // header chrome — "Thinking…"/"View thinking process" + the live timer — is ~always
        // non-empty, so a round that opened an accordion but produced trivial/empty reasoning must
        // still drop, not freeze as a near-empty "Thinking" segment). (CodeRabbit)
        const _thinkInner = thinkSection && thinkSection.querySelector('.thinking-content-inner, .live-think-inner');
        const hasReasoning = !!(_thinkInner && _thinkInner.textContent.trim());
        if (!hasReply && !hasReasoning) {
          seg.remove();  // empty round → no lingering holder; the turn bubble persists
          return;
        }
        if (hasReply) {
          // Classify THIS round's own SEGMENT (not the shared holder) with the same detector the
          // reload/live paths use, so the frozen segment keeps its OOC/producer treatment even
          // after later rounds render into the same bubble. Reply rendered reply-only (F8).
          const dt = chatRenderer.applyOocClass(seg, dtRaw.trim(), 'assistant').text;
          const html = markdownModule.processWithThinking(markdownModule.squashOutsideCode(dt));
          const liveReply = seg.querySelector('.live-reply-content');
          if (liveReply) {
            // Reasoning accordion above stays put; render ONLY into the reply container.
            liveReply.innerHTML = html;
            liveReply.classList.remove('live-reply-content');
          } else if (thinkSection) {
            // Accordion present but no dedicated reply container — append the reply AFTER it so
            // the reasoning is preserved (never overwritten into the reply body).
            let rc = seg.querySelector('.round-reply');
            if (!rc) { rc = document.createElement('div'); rc.className = 'round-reply'; seg.appendChild(rc); }
            rc.innerHTML = html;
          } else {
            seg.innerHTML = html;  // plain reply-only segment (no reasoning this round)
          }
          if (window.hljs) seg.querySelectorAll('pre code').forEach((b) => window.hljs.highlightElement(b));
        }
        seg.style.minHeight = '';
        // Freeze: drop the `.stream-content` class so the next round's _ensureStreamLayout mints
        // a FRESH sibling segment below this one (the bubble grows, nothing re-mounts).
        seg.classList.remove('stream-content');
        seg.classList.add('round-seg');
        seg._streamRenderer = null;
        seg._streamRendererOoc = undefined;
      };

      let _nextIsError = false;
      let _streamSawDone = false;
      // BUG 2 (#985 P2-B): did the server persist ANY message this turn? A clean empty turn (the final
      // round made a tool call but emitted no narration; the server's `if full_response:` save is
      // skipped) emits NO `message_saved`. Combined with `accumulated === ''`, that is the
      // "backend produced no turn" terminal state — distinct from a thrown network drop. We render the
      // user-controlled Retry for it instead of silently hiding the empty bubble.
      let _sawMessageSaved = false;
      // BUG 2 — did the turn produce a VISIBLE artifact OTHER than narration text/a save? An in-character
      // image, an ask_user prompt, a budget notice, a surfaced error etc. all leave `accumulated === ''`
      // yet are a real, completed turn — NOT the empty-turn-with-no-recourse case. Set true on those so
      // the empty-turn Retry never spuriously fires after one.
      let _producedVisibleOutput = false;
      // CASTING-RESUME-HANG Fix 3 (P1 review): a turn-scoped "did this turn call any tool?" flag.
      // The tool RAIL (`.agent-thread` → `.agent-thread-node`) is appended to `#chat-history` as a
      // SIBLING of the assistant `holder` (see the tool_start branch: `chatBox.appendChild`), so
      // `holder.querySelector('.agent-thread-node')` never sees it and always read false — a
      // tool-only casting turn could then wrongly trip the empty-reply re-prompt. Set true in the
      // tool_start branch below and read by `_isCastingEmptyReplyReprompt`'s `usedTools` gate.
      let _usedToolsThisTurn = false;

      while (true) {
        const { done, value } = await reader.read();
        _lastReaderActivity = Date.now();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // Log SSE event types (e.g. "event: error") for debugging
          if (line.startsWith('event: ')) {
            const evtType = line.slice(7).trim();
            if (evtType === 'error') _nextIsError = true;
            continue;
          }
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            // D2: count every processed SSE event for resume from_seq cursor.
            // Skip prepended route events (run-started, canonical_session) — they
            // are NOT in the agent_runs buffer, so counting them makes from_seq
            // overshoot the buffer index, causing a narration GAP on self-resume.
            let _skipCount = false;
            try {
              const p = JSON.parse(data);
              if (p && (p.type === 'run-started' || p.type === 'canonical_session')) _skipCount = true;
            } catch (_) { /* non-JSON payloads ([DONE], etc.) always count */ }
            if (!_skipCount) {
              _sseEventCount++;
              chatState._sseEventCount[streamSessionId] = _sseEventCount;
            }

            // (thinking spinner removal is handled in agent_step / tool_start / content handlers)

            // Background detection: are we on a different session?
            const _isBg = (sessionModule.getCurrentSessionId() !== streamSessionId);

            // On first transition to background, store state in map
            if (_isBg && !chatState._backgroundStreams.has(streamSessionId)) {
              chatState._backgroundStreams.set(streamSessionId, {
                status: 'running',
                accumulated: accumulated,
                sourcesHtml: _sourcesHtml,
                findingsData: null,
                abortCtrl: chatState.currentAbort,
                query: streamQuery,
                metrics: null,
              });
              if (sessionModule && sessionModule.markStreaming) {
                sessionModule.markStreaming(streamSessionId);
              }
            }

            if (data === '[DONE]') {
              _streamSawDone = true;
              // Always update background map if entry exists (even if user switched back)
              var bgDone = chatState._backgroundStreams.get(streamSessionId);
              if (bgDone) {
                bgDone.status = 'completed';
                bgDone.accumulated = accumulated;
                if (_isBg) {
                  try {
                    _notifyStreamComplete(streamSessionId, streamQuery);
                    _insertStreamDoneToast(streamSessionId, streamQuery);
                  } catch (toastErr) {
                    console.warn('[bg-stream] Toast/notification error:', toastErr);
                  }
                }
                // CRITICAL: always mark stream complete for the sidebar dot
                try {
                  if (sessionModule && sessionModule.markStreamComplete) {
                    sessionModule.markStreamComplete(streamSessionId);
                  }
                } catch (dotErr) {
                  console.warn('[bg-stream] markStreamComplete error:', dotErr);
                }
                // Don't do foreground final render — the checkBackgroundStream poll
                // will detect 'completed' and reload history cleanly
                break;
              }
              // Force-close thinking if still open (model never output boundary)
              if (isThinking) {
                isThinking = false;
                cancelAnimationFrame(_thinkTimerRAF);
                var _elapsedDone = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : null;
                if (_elapsedDone) {
                  accumulated = accumulated.replace(/<think>/i, '<think time="' + _elapsedDone + '">');
                  roundText = roundText.replace(/<think>/i, '<think time="' + _elapsedDone + '">');
                }
                if (_liveThinkHeader) _liveThinkHeader.textContent = isGameBuild() ? 'Production notes' : 'View thinking process';
                if (_liveThinkSpinnerSlot) _liveThinkSpinnerSlot.remove();
                if (_liveThinkTimerEl && _elapsedDone) {
                  _liveThinkTimerEl.textContent = _elapsedDone + 's';
                  _liveThinkTimerEl.style.marginLeft = 'auto';
                  _liveThinkTimerEl.style.marginRight = '5px';
                  var _hdrDone = _liveThinkTimerEl.closest('.thinking-header');
                  // Keep the chevron furthest right with the timer to its left
                  // (match the live + final-render layout) — insert before the
                  // toggle rather than appending (which would land after it).
                  if (_hdrDone) {
                    if (_liveThinkToggle && _liveThinkToggle.parentElement === _hdrDone)
                      _hdrDone.insertBefore(_liveThinkTimerEl, _liveThinkToggle);
                    else _hdrDone.appendChild(_liveThinkTimerEl);
                  }
                }
                // Assign stable IDs
                var _thinkIdDone = 'think-' + Date.now();
                var _liveHdrDone = _liveThinkSection && _liveThinkSection.querySelector('.thinking-header');
                if (_liveHdrDone) _liveHdrDone.dataset.thinkingId = _thinkIdDone;
                if (_liveThinkContent) _liveThinkContent.id = _thinkIdDone;
                if (_liveThinkToggle) _liveThinkToggle.id = _thinkIdDone + '-toggle';
                // Create live-reply container so final render preserves thinking bar
                var _streamElDone = _liveThinkSection ? _liveThinkSection.parentElement : roundHolder.querySelector('.stream-content');
                if (!_streamElDone) _streamElDone = roundHolder.querySelector('.body');
                if (_streamElDone && !_streamElDone.querySelector('.live-reply-content')) {
                  var _replyElDone = document.createElement('div');
                  _replyElDone.className = 'live-reply-content';
                  _streamElDone.appendChild(_replyElDone);
                }
              }
              // Normal foreground completion — metrics will be displayed in the final render block below
              break;
            }
            try {
              const json = JSON.parse(data);
              // Handle SSE error events (e.g. HTTP 404 from provider)
              if (_nextIsError || json.status >= 400) {
                _nextIsError = false;
                const rawErrMsg = json.text || json.error?.message || `Error ${json.status || 'unknown'}`;
                console.error('Stream error:', rawErrMsg);
                if (spinner && spinner.element) spinner.destroy();
                // Orwell #872 (item A): NEVER render a raw HTTP status / provider error into the GM
                // body bubble in the game build — an "Error 400" reads to the player as a literal
                // Big Brother / producer message. The provider (notably deepseek-v4-pro) intermittently
                // 400s on continuation/tool rounds; the player must never see the machinery. Surface a
                // diegetic line instead; the finally still FORCE-reconciles this bubble to the persisted
                // fallback (the agent loop saves a friendly message). Outside the game build (the general
                // assistant) keep the informative error so misconfig stays debuggable.
                const errMsg = isGameBuild()
                  ? _ENGINE_INTERRUPT_LINE
                  : rawErrMsg;
                typewriterInto(roundHolder.querySelector('.body'), errMsg);
                // ADR 0012 (GAP 2): keep the immediate live feedback, but mark the turn so the finally
                // FORCE-reconciles this bubble to the persisted fallback — the agent loop saves a
                // friendly message (not the raw "Error 503"), so the sender must end on the SAME
                // persisted text a peer/reload shows (no two-windows-different-text on errors).
                _streamHadError = true;
                break;
              }
              if (json.delta || json.type === 'tool_start' || json.type === 'tool_output' || json.type === 'tool_progress' || json.type === 'agent_step' || json.type === 'doc_stream_open' || json.type === 'doc_stream_delta' || json.type === 'research_progress') {
                // Stream activity: RESET the idle countdown (was a one-shot permanent clear — that
                // left a mid-stream stall unbounded). A long-but-active turn keeps re-arming and is
                // never tripped; only a genuine idle gap aborts + recovers.
                resetIdleTimeout();
                clearProcessingProbe();
              }
              // F-2/F-4: engine announcements owed for a FE-pre-resolved beat (the model may never voice it).
              if (Array.isArray(json.announcements) && json.announcements.length) {
                try { window.dispatchEvent(new CustomEvent('orwell:announcements', { detail: { announcements: json.announcements } })); } catch (_) {}
              }
              if (json.delta) {
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                // P1 (OOBE cutover): the house-entry narration is now streaming — clear the inline
                // "finalizing" indicator so it gives way to the actual move-in prose.
                if (_orwellFinalizingActive) {
                  _orwellFinalizingActive = false;
                  try { if (window._orwellFinalizing) window._orwellFinalizing.end(); } catch (_) {}
                }
                // Text arrived after tools — connect thread line to this bubble
                const _threadAbove = roundHolder?.previousElementSibling;
                if (_threadAbove && _threadAbove.classList.contains('agent-thread') && !_threadAbove.classList.contains('has-bottom')) {
                  _threadAbove.classList.add('has-bottom');
                }
                // VLLM reasoning tokens: wrap in <think> tags for the thinking UI.
                // Stateful open/close (not a whole-message substring check) so each round
                // of a multi-round agent response gets its own <think>…</think> — otherwise
                // only round 1 is wrapped and rounds 2+ reasoning leaks into the answer.
                let _delta = json.delta;
                // F8: split the RAW delta by channel BEFORE the <think>-wrapping below, so the
                // reply buffer carries zero reasoning/markup and the accordion buffer carries raw
                // reasoning. The BODY render reads roundReplyText → reasoning can't leak into it.
                if (json.thinking) roundReasoningText += json.delta;
                else               roundReplyText += json.delta;
                // CodeRabbit fix: clear the premiere-recovery latch only on a real reply token —
                // a reasoning-only delta must NOT clear it (see declaration comment above).
                if (!json.thinking && _orwellPremiereRecoveryArmed) _orwellPremiereRecoveryArmed = false;
                if (json.thinking) {
                  if (!_thinkOpen) { _delta = '<think>' + _delta; _thinkOpen = true; }
                } else if (_thinkOpen) {
                  _delta = '</think>' + _delta; _thinkOpen = false;
                }
                const wasEmpty = !accumulated;
                accumulated += _delta;
                roundText += _delta;
                currentAccumulated = accumulated; // Update global tracker
                // First token arrived — switch stop button from processing to streaming
                if (wasEmpty && submitBtn && !_isBg) {
                  submitBtn.dataset.phase = 'receiving';
                }

                // Update background map if running in background
                if (_isBg) {
                  var bgEntry = chatState._backgroundStreams.get(streamSessionId);
                  if (bgEntry) bgEntry.accumulated = accumulated;
                  continue; // Skip all DOM writes
                }

                // --- Text-fence doc streaming (for models that don't use native tool calls) ---
                if (!_docFenceOpened && documentModule && roundText.includes('```create_document\n')) {
                  const fenceIdx = roundText.indexOf('```create_document\n');
                  const afterFence = roundText.slice(fenceIdx + '```create_document\n'.length);
                  const fenceLines = afterFence.split('\n');
                  if (fenceLines.length >= 1 && fenceLines[0].trim()) {
                    _docFenceOpened = true;
                    const title = fenceLines[0].trim();
                    // Keep in sync with backend _KNOWN_LANGS in src/tool_implementations.py
                    const knownLangs = ['python','py','javascript','js','typescript','ts','html','css','json','yaml','bash','sql','rust','go','java','c','cpp','markdown','text','plain','ruby','swift','kotlin','php','email','csv','xml','toml','ini'];
                    const isLang = fenceLines.length >= 2 && knownLangs.includes(fenceLines[1].trim().toLowerCase());
                    const lang = isLang ? fenceLines[1].trim() : '';
                    _docFenceContentStart = fenceIdx + '```create_document\n'.length + title.length + 1 + (isLang ? fenceLines[1].length + 1 : 0);
                    documentModule.streamDocOpen(title, lang);
                  }
                }
                if (_docFenceOpened && _docFenceContentStart > 0 && documentModule) {
                  let raw = roundText.slice(_docFenceContentStart);
                  const closeIdx = raw.indexOf('\n```');
                  if (closeIdx >= 0) raw = raw.slice(0, closeIdx);
                  documentModule.streamDocDelta(raw);
                }

                // Detect thinking-in-progress:
                // 1. Normal: <think>...no closing tag yet
                // 2. Malformed: <think></think>\n...text but no second </think> yet
                // 3. Qwen3.5: "Thinking Process:" without <think> tags
                let hasUnclosedThink = markdownModule.hasUnclosedThinkTag(roundText);
                // Detect non-tag thinking patterns: "Thinking:", "Thinking Process:", Gemma-style reasoning
                // These patterns don't use <think> tags, so we simulate unclosed thinking during streaming
                const _replyPrefixes = ['Hey', 'Hi ', 'Hi!', 'Hello', 'Sure', 'Yes', 'No ', 'No,', 'Yo', 'OK', 'Here', 'Absolutely', 'Of course', 'Great', 'Alright', 'Thanks', 'Welcome', 'Good ', "I'm happy", "I'd be"];
                if (!hasUnclosedThink && !/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>|<\|channel>thought/i.test(roundText)) {
                  const _trimmedRT = roundText.trimStart();
                  const _isReasoning = markdownModule.startsWithReasoningPrefix(_trimmedRT);
                  if (_isReasoning) {
                    // Check if we can see a reply boundary yet (newline then reply pattern)
                    const _lines = _trimmedRT.split('\n');
                    let _replyFound = false;
                    for (let li = 1; li < _lines.length; li++) {
                      const _l = _lines[li].trim();
                      if (!_l) continue;
                      if (_replyPrefixes.some(rp => _l.startsWith(rp))) {
                        _replyFound = true;
                        break;
                      }
                    }
                    if (!_replyFound) {
                      // Also check within-line: "reasoning text.Reply text"
                      const _inlineReply = _replyPrefixes.some(rp => {
                        const rx = new RegExp('[.!?]\\s*' + rp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                        const m = rx.exec(_trimmedRT);
                        return m && m.index > 20;
                      });
                      if (!_inlineReply) hasUnclosedThink = true;
                    }
                  }
                }
                if (!hasUnclosedThink && /^<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>\s*<\/(?:think(?:ing)?|thought)>/i.test(roundText)) {
                  // Empty <think></think> — the model likely put thinking outside the tags
                  const afterEmpty = roundText.replace(/^<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>\s*<\/(?:think(?:ing)?|thought)>/i, '').trim();
                  const closeTags = (afterEmpty.match(/<\/(?:think(?:ing)?|thought)>/gi) || []).length;
                  if (closeTags === 0 && afterEmpty.length > 0) {
                    hasUnclosedThink = true; // still waiting for real closing tag
                  }
                }
                // Detect false close: <think>short</think> where real thinking follows untagged
                // Only applies when there's a second </think> later (model leaked thinking outside tags)
                // Do NOT trigger if the text after </think> contains tool calls (that's real content)
                if (!hasUnclosedThink && isThinking) {
                  const _thinkMatch = roundText.match(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:think(?:ing)?|thought)>/i);
                  const _thinkLen = _thinkMatch ? _thinkMatch[1].trim().length : 0;
                  if (_thinkLen < 20) {
                    const _afterClose = roundText.replace(/<(?:think(?:ing)?|thought)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:think(?:ing)?|thought)>/i, '').trim();
                    // Only keep waiting if there's trailing text that looks like thinking (not tool calls)
                    const _hasToolCall = /```(?:bash|python|web_search|read_file|write_file|create_document|edit_document|manage_|generate_image)/i.test(_afterClose);
                    const _hasOrphanClose = /<\/(?:think(?:ing)?|thought)>/i.test(_afterClose);
                    if (!_hasToolCall && (_hasOrphanClose || (Date.now() - thinkingStartTime) < 500)) {
                      hasUnclosedThink = true; // keep waiting for real </think>
                    }
                  }
                }

                // R-VLT-2 (#1867): ADR-0019 Layer 2 means the MODEL receives secret state
                // (presentKnowledge). The reasoning is structurally walled server-side: the SSE
                // stream from agent_loop.py drops thinking deltas when game_mode is truthy, so
                // no Vault content reaches this accordion in the game build. The accordion still
                // works for debug builds (ORWELL_GAME_BUILD=0) where the raw reasoning passes through.
                // An operator may fully hide the accordion via `body.hide-thinking`.
                if (isGameBuild() && document.body.classList.contains('hide-thinking') &&
                    (hasUnclosedThink || isThinking)) {
                  if (hasUnclosedThink) {
                    if (!isThinking) {
                      isThinking = true;
                      thinkingStartTime = Date.now();
                      if (spinner && spinner.element) spinner.destroy();
                    }
                    // Operator hid the accordion — render nothing, just wait.
                    uiModule.scrollHistory();
                    continue;
                  }
                  // Reasoning just closed — drop back to normal streaming for the reply.
                  isThinking = false;
                  if (spinner && spinner.element) spinner.destroy();
                  _renderStream();
                  _scheduleThinkingSpinner();
                  if (streamingTTS) window.aiTTSManager.streamingUpdate(roundText);
                  continue;
                }

                if (hasUnclosedThink && !isThinking) {
                  isThinking = true;
                  thinkingStartTime = Date.now();
                  if (spinner && spinner.element) spinner.destroy();

                  // Create a live thinking box — starts expanded so content streams visibly
                  var thinkBody = roundHolder.querySelector('.body');
                  var thinkContent = _ensureStreamLayout(thinkBody);
                  thinkContent.style.minHeight = '';
                  _liveThinkDomId = 'live-think-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
                  thinkContent.innerHTML = `
                    <div class="thinking-section">
                      <div class="thinking-header" data-thinking-id="${_liveThinkDomId}">
                        <div class="thinking-header-left"><span class="live-think-header-text">Thinking\u2026</span></div>
                        <span class="live-think-spinner-slot" style="flex-shrink:0;margin-left:auto;"></span>
                        <span class="live-think-timer" style="font-size:11px;opacity:0.4;font-variant-numeric:tabular-nums;margin-left:6px;margin-right:5px;"></span>
                        <span class="thinking-toggle live-think-toggle" id="${_liveThinkDomId}-toggle"></span>
                      </div>
                      <div class="thinking-content" id="${_liveThinkDomId}">
                        <div class="thinking-content-inner live-think-inner"></div>
                      </div>
                    </div>`;
                  _liveThinkSection = thinkContent.querySelector('.thinking-section');
                  _liveThinkContent = thinkContent.querySelector('.thinking-content');
                  _liveThinkInner = thinkContent.querySelector('.live-think-inner');
                  _liveThinkHeader = thinkContent.querySelector('.live-think-header-text');
                  _liveThinkSpinnerSlot = thinkContent.querySelector('.live-think-spinner-slot');
                  _liveThinkTimerEl = thinkContent.querySelector('.live-think-timer');
                  _liveThinkToggle = thinkContent.querySelector('.live-think-toggle');
                  // Live timer
                  var _thinkTimerStart = Date.now();
                  var _thinkTimerRAF = 0;
                  function _tickThinkTimer() {
                    if (!_liveThinkTimerEl || !_liveThinkTimerEl.isConnected) return;
                    var s = ((Date.now() - _thinkTimerStart) / 1000).toFixed(1);
                    _liveThinkTimerEl.textContent = s + 's';
                    _thinkTimerRAF = requestAnimationFrame(_tickThinkTimer);
                  }
                  _thinkTimerRAF = requestAnimationFrame(_tickThinkTimer);
                  // Whirlpool spinner
                  if (_liveThinkSpinnerSlot) {
                    var _wp = spinnerModule.createWhirlpool(12);
                    _wp.element.style.margin = '0';
                    _wp.element.style.width = '12px';
                    _wp.element.style.height = '12px';
                    _wp.element.style.transform = 'translateY(-1px)'; // align the whirlpool with the header text
                    _liveThinkSpinnerSlot.appendChild(_wp.element);
                  }
                } else if (hasUnclosedThink && isThinking) {
                  if (_liveThinkInner) {
                    // F8: prefer the dedicated reasoning buffer (channel-flagged thinking:true —
                    // raw, no tag-strip needed). Fall back to stripping roundText for models whose
                    // reasoning arrives inline/untagged on the CONTENT channel (then the reasoning
                    // sits in roundText, and roundReasoningText is empty).
                    var thinkText = roundReasoningText.trim()
                      ? roundReasoningText
                      : roundText
                          .replace(/<\/?(?:think(?:ing)?|thought)(?:\s+[^>]*)?>/gi, '')
                          .replace(/<\|channel>thought\s*\n?/gi, '')
                          .replace(/<\|channel>response\s*\n?/gi, '')
                          .replace(/<channel\|>/gi, '');
                    thinkText = thinkText.replace(/^\s*Thinking(?:\s+Process)?:\s*/i, '');
                    _liveThinkInner.innerHTML = markdownModule.mdToHtml(thinkText);
                    // Keep thinking box scrolled to bottom
                    var thinkBox = _liveThinkInner.closest('.thinking-content');
                    if (thinkBox) thinkBox.scrollTop = thinkBox.scrollHeight;
                  }
                  uiModule.scrollHistory();
                  continue;
                } else if (!hasUnclosedThink && isThinking) {
                  isThinking = false;
                  var _thinkTextLen = _liveThinkInner ? _liveThinkInner.textContent.trim().length : 0;

                  // If thinking was trivially short (< 20 chars), remove the section entirely
                  // Models sometimes emit <think>The</think> or similar noise
                  if (_thinkTextLen < 20 && _liveThinkSection) {
                    _liveThinkSection.remove();
                    _liveThinkSection = null;
                    _liveThinkContent = null;
                    _liveThinkInner = null;
                    _liveThinkHeader = null;
                    _liveThinkSpinnerSlot = null;
                    _liveThinkTimerEl = null;
                    _liveThinkToggle = null;
                    _liveThinkDomId = null;
                    // Fall through to normal streaming
                    if (spinner && spinner.element) spinner.destroy();
                    _renderStream();
                    _scheduleThinkingSpinner();
                    continue;
                  }

                  // Thinking ended — smooth transition: update header, pause, then collapse
                  // Stop live timer and spinner
                  cancelAnimationFrame(_thinkTimerRAF);
                  var elapsed = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : null;
                  // Embed thinking time in the <think> tag for persistence on reload
                  if (elapsed) {
                    accumulated = accumulated.replace(/<think>/i, '<think time="' + elapsed + '">');
                    roundText = roundText.replace(/<think>/i, '<think time="' + elapsed + '">');
                  }
                  if (_liveThinkHeader) _liveThinkHeader.textContent = isGameBuild() ? 'Production notes' : 'View thinking process';
                  if (_liveThinkSpinnerSlot) _liveThinkSpinnerSlot.remove();
                  // Move timer to right side of header
                  if (_liveThinkTimerEl && elapsed) {
                    _liveThinkTimerEl.textContent = elapsed + 's';
                    _liveThinkTimerEl.style.marginLeft = 'auto';
                    _liveThinkTimerEl.style.marginRight = '5px';
                    var _hdrRow = _liveThinkTimerEl.closest('.thinking-header');
                    // Chevron furthest right, timer to its left — insert before
                    // the toggle (appending would put the timer after it).
                    if (_hdrRow) {
                      if (_liveThinkToggle && _liveThinkToggle.parentElement === _hdrRow)
                        _hdrRow.insertBefore(_liveThinkTimerEl, _liveThinkToggle);
                      else _hdrRow.appendChild(_liveThinkTimerEl);
                    }
                  }

                  // Assign stable IDs (for click-toggle handler in markdown.js)
                  var _thinkId = 'think-' + Date.now();
                  var _liveHdr = _liveThinkSection && _liveThinkSection.querySelector('.thinking-header');
                  if (_liveHdr) _liveHdr.dataset.thinkingId = _thinkId;
                  if (_liveThinkContent) _liveThinkContent.id = _thinkId;
                  if (_liveThinkToggle) _liveThinkToggle.id = _thinkId + '-toggle';

                  // Append a container for the reply text that follows thinking
                  var _streamEl = _liveThinkSection ? _liveThinkSection.parentElement : roundHolder.querySelector('.stream-content');
                  if (!_streamEl) _streamEl = roundHolder.querySelector('.body');
                  if (_streamEl) {
                    var _replyEl = document.createElement('div');
                    _replyEl.className = 'live-reply-content';
                    _streamEl.appendChild(_replyEl);
                  }

                  // Render any reply text that arrived with the closing </think> token
                  _renderStream();
                } else {
                  // Normal streaming
                  if (spinner && spinner.element) spinner.destroy();
                  _renderStream();
                  _scheduleThinkingSpinner();
                  // Feed streaming TTS with accumulated text
                  if (streamingTTS) window.aiTTSManager.streamingUpdate(roundText);
                }
              } else if (json.type === 'research_progress') {
                if (_isBg) continue; // Skip DOM updates in background
                chatState._researchingStreamIds.add(streamSessionId);
                // Highlight research button while running
                var _rToggle = document.getElementById('research-toggle-btn');
                if (_rToggle) _rToggle.classList.add('research-running');
                // Request notification permission on first research event
                if ('Notification' in window && Notification.permission === 'default') {
                  Notification.requestPermission();
                }
                // Mark session as researching in sidebar
                var _rSid = sessionModule && sessionModule.getCurrentSessionId();
                if (_rSid && sessionModule.markResearching) sessionModule.markResearching(_rSid);
                const rp = json.data;
                // Start research timer + synapse on first progress event
                if (!_researchTimerEl && spinner && spinner.element) {
                  _researchStartTime = rp.started_at ? rp.started_at * 1000 : Date.now();
                  _researchAvgDuration = rp.avg_duration || null;
                  _researchTimerEl = document.createElement('div');
                  _researchTimerEl.className = 'research-timer';
                  // Styles in .research-timer CSS class
                  spinner.element.parentNode.insertBefore(_researchTimerEl, spinner.element.nextSibling);
                  _researchTimerInterval = setInterval(() => {
                    if (!_researchTimerEl) return;
                    var elapsed = Math.floor((Date.now() - _researchStartTime) / 1000);
                    var mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
                    var ss = String(elapsed % 60).padStart(2, '0');
                    var txt = mm + ':' + ss;
                    if (_researchAvgDuration) {
                      var avgM = String(Math.floor(_researchAvgDuration / 60)).padStart(2, '0');
                      var avgS = String(Math.round(_researchAvgDuration % 60)).padStart(2, '0');
                      txt += ' / avg ' + avgM + ':' + avgS;
                    }
                    _researchTimerEl.textContent = txt;
                  }, 1000);
                  // Synapse visualization — insert right above the timer so
                  // it sits between the spinner message and the timer line.
                  try {
                    _researchSynapse = createResearchSynapse(spinner.element.parentNode, {
                      query: holder._researchQuery || rp.query || '',
                      startedAt: _researchStartTime,
                    });
                    // Move it to live between spinner and timer
                    if (_researchSynapse.element && _researchTimerEl) {
                      spinner.element.parentNode.insertBefore(_researchSynapse.element, _researchTimerEl);
                    }
                  } catch (e) { console.warn('synapse init failed', e); }
                }
                if (_researchSynapse) {
                  _researchSynapse.setPhase(rp.phase, rp);
                  if (typeof rp.round === 'number') _researchSynapse.setRound(rp.round);
                  if (typeof rp.total_sources === 'number') _researchSynapse.setSourceCount(rp.total_sources);
                  if (rp.phase === 'error') _researchSynapse.complete();
                }
                if (spinner && spinner.element) {
                  if (rp.phase === 'probing') {
                    spinner.updateMessage(`Verifying model: ${rp.model || '?'}`);
                  } else if (rp.phase === 'planning') {
                    spinner.updateMessage('Analyzing question & planning research strategy');
                  } else if (rp.phase === 'searching') {
                    const q = rp.queries ? `${rp.queries} queries` : '';
                    const s = rp.total_sources ? ` · ${rp.total_sources} sources` : '';
                    spinner.updateMessage(`Round ${rp.round || '?'}: Searching${q ? ' (' + q + ')' : ''}${s}`);
                  } else if (rp.phase === 'reading') {
                    spinner.updateMessage(rp.title ? `Reading: ${rp.title}` : `Round ${rp.round || '?'}: Reading ${rp.new_sources || ''} pages · ${rp.total_sources || 0} sources total`);
                  } else if (rp.phase === 'analyzing') {
                    spinner.updateMessage(`Round ${rp.round || '?'}: Analyzing ${rp.total_findings || 0} findings`);
                  } else if (rp.phase === 'writing') {
                    spinner.updateMessage(`Writing report · ${rp.total_sources || 0} sources`);
                  } else if (rp.phase === 'error') {
                    spinner.updateMessage(rp.message || 'Search error');
                  }
                }
              } else if (json.type === 'research_sources') {
                if (_isBg) {
                  // Store sources HTML in background map
                  if (json.data && json.data.length > 0) {
                    _sourcesHtml = _buildSourcesBox(json.data, 'research');
                    var bgE = chatState._backgroundStreams.get(streamSessionId);
                    if (bgE) bgE.sourcesHtml = _sourcesHtml;
                  }
                  // Clear researching indicator for this background session
                  if (sessionModule && sessionModule.clearResearching) sessionModule.clearResearching(streamSessionId);
                  continue;
                }
                // Research done — clean up timer, show sources box, then spinner for LLM response
                _clearResearchTimer();
                holder._researchSources = json.data;
                var _rSid2 = sessionModule && sessionModule.getCurrentSessionId();
                if (_rSid2 && sessionModule.clearResearching) sessionModule.clearResearching(_rSid2);
                if (json.data && json.data.length > 0) {
                  _sourcesData = json.data; _sourcesType = 'research';
                  _sourcesHtml = _buildSourcesBox(json.data, 'research');
                }
                if (document.hidden) {
                  _notifyResearchComplete(_rSid2 || '', holder._researchQuery || '');
                }
              } else if (json.type === 'research_findings') {
                if (_isBg) {
                  var bgEf = chatState._backgroundStreams.get(streamSessionId);
                  if (bgEf) bgEf.findingsData = json.data;
                  continue;
                }
                if (json.data && json.data.length > 0) {
                  _findingsData = json.data;
                }
              } else if (json.type === 'research_done') {
                // Research complete — reload session to show the persisted report
                _clearResearchTimer();
                if (sessionModule && sessionModule.clearResearching) {
                  sessionModule.clearResearching(streamSessionId);
                }
                chatState._researchingStreamIds.delete(streamSessionId);
                // Small delay then reload session history which includes the full report
                setTimeout(async () => {
                  // Don't yank the user back to this chat if they've navigated
                  // away (e.g. started a new chat) while research finished —
                  // just refresh the sidebar so the report shows when they return.
                  if (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId() === streamSessionId) {
                    await sessionModule.selectSession(streamSessionId);
                  } else {
                    await sessionModule.loadSessions();
                  }
                }, 500);
                continue;
              } else if (json.type === 'web_sources') {
                if (_isBg) {
                  if (json.data && json.data.length > 0) {
                    _sourcesHtml = _buildSourcesBox(json.data, 'web');
                    var bgE2 = chatState._backgroundStreams.get(streamSessionId);
                    if (bgE2) bgE2.sourcesHtml = _sourcesHtml;
                  }
                  continue;
                }
                // Web search done — store sources for final render (don't render mid-stream)
                holder._webSources = json.data;
                if (json.data && json.data.length > 0) {
                  _sourcesData = json.data; _sourcesType = 'web';
                  _sourcesHtml = _buildSourcesBox(json.data, 'web');
                }
              } else if (json.type === 'model_fallback') {
                // Model went offline — switched to fallback
                var _fbData = json.data || {};
                uiModule.showToast(
                  `Model ${_fbData.old_model || '?'} offline — switched to ${_fbData.new_model || '?'}`,
                  5000
                );
                // Update the model picker to reflect the new model
                if (sessionModule && sessionModule.updateModelPicker) {
                  sessionModule.updateModelPicker();
                }
                continue;
              } else if (json.type === 'model_info') {
                // Update role label with model name as soon as we know it
                if (!_isBg && holder) {
                  const roleEl = holder.querySelector('.role');
                  if (roleEl) {
                    holder._requestedModel = json.requested_model || json.model || holder._requestedModel;
                    holder._actualModel = json.model || holder._actualModel || holder._requestedModel;
                    if (json.suffix) holder._roleSuffix = json.suffix;
                    // Prepend character name if sent by server or set locally
                    var _charName = json.character_name || (presetsModule.getCharacterName ? presetsModule.getCharacterName() : '');
                    if (_charName) holder._characterName = _charName;
                    _setRoleModelLabel(roleEl, holder._requestedModel, holder._actualModel, {
                      suffix: holder._roleSuffix,
                      characterName: holder._characterName,
                    });
                  }
                }
              } else if (json.type === 'fallback') {
                // The selected model failed and another provider answered. Make
                // it visible so a misconfigured provider is never silently
                // masked under the selected model's name.
                if (!_isBg) {
                  var _selM = _shortModel(json.selected_model || '');
                  var _ansM = _shortModel(json.answered_by || '');
                  uiModule.showToast('⚠ ' + _selM + ' failed — answered by ' + _ansM, 6000);
                  if (holder) {
                    var _rEl = holder.querySelector('.role');
                    if (_rEl) {
                      var _tsS = _rEl.querySelector('.role-timestamp');
                      // C14/immersion: in the game build the sender is the show, never a
                      // model name — even a provider fallback stays diegetic (the toast above
                      // still surfaces the misconfig out-of-fiction). _setRoleModelLabel below
                      // re-labels to "Big Brother" and strips the tooltip.
                      if (!isGameBuild()) {
                        _rEl.textContent = _ansM + ' (fallback) ';
                        _rEl.title = (json.selected_model || '') + ' failed' +
                          (json.reason ? ': ' + json.reason : '') + ' — answered by ' + (json.answered_by || '');
                      }
                      _applyModelColor(_rEl, json.answered_by);
                      if (_tsS) _rEl.appendChild(_tsS);
                      holder._requestedModel = json.selected_model || holder._requestedModel || modelName;
                      const _hasResolvedActual = holder._actualModel && !_sameModelName(holder._actualModel, holder._requestedModel);
                      holder._actualModel = _hasResolvedActual ? holder._actualModel : (json.answered_by || holder._actualModel || holder._requestedModel);
                      _setRoleModelLabel(_rEl, holder._requestedModel, holder._actualModel, {
                        suffix: holder._roleSuffix,
                        characterName: holder._characterName,
                        reason: json.reason,
                      });
                    }
                  }
                }
              } else if (json.type === 'rounds_exhausted') {
                // The agent hit the per-turn step limit while still working.
                // Offer a Continue button instead of stalling silently.
                // NOTE: append to the chat-history container (bottom), NOT the
                // message body — the body innerHTML is re-rendered at stream
                // finalize, which would wipe a note placed inside it.
                const _chatBox = document.getElementById('chat-history');
                if (!_isBg && _chatBox) {
                  // Drop any prior box so repeated cap-hits each get a fresh
                  // Continue at the bottom (multiple continues in a row).
                  const _old = _chatBox.querySelector('.rounds-exhausted');
                  if (_old) _old.remove();
                  const note = document.createElement('div');
                  note.className = 'stopped-indicator rounds-exhausted';
                  const label = document.createElement('span');
                  label.className = 'rounds-exhausted-label';
                  // B6/B11 / MICRO-3: "Reached the N-step limit" names the agent loop's tool-call
                  // budget directly — a workspace concept that must never surface while the game build
                  // is active (it fires mid-ceremony/marquee-scene, exactly when I9 matters most). Gate
                  // on isGameBuild() — the same treatment the sibling error/fallback branches get; the
                  // non-game workspace keeps the precise diagnostic.
                  label.textContent = isGameBuild()
                    ? 'Big Brother pauses the tape for a beat — pick up where we left off.'
                    : `Reached the ${json.rounds || ''}-step limit — not finished.`;
                  note.appendChild(label);
                  const contBtn = document.createElement('button');
                  contBtn.className = 'continue-btn';
                  contBtn.title = isGameBuild() ? 'Keep the scene going' : 'Continue the task';
                  contBtn.textContent = isGameBuild() ? 'Keep going ▸' : 'Continue ▸';
                  const _holder = currentHolder;
                  contBtn.addEventListener('click', () => {
                    note.remove();
                    chatState._hideUserBubble = true;
                    chatState._pendingContinue = _holder;
                    handleChatSubmit(null, 'You hit the step limit before finishing — the task is not complete. Continue from exactly where you left off and keep going until it is done. Do NOT repeat work already done.');
                  });
                  note.appendChild(contBtn);
                  _chatBox.appendChild(note);
                  try { note.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch (_) { uiModule.scrollHistory && uiModule.scrollHistory(); }
                }
              } else if (json.type === 'truncated') {
                // F-S4-D: the reply was cut off by the model's OUTPUT token cap (finish_reason "length"),
                // not the step limit — it stopped mid-sentence. Offer a Continue affordance (mirrors
                // rounds_exhausted) so the player can resume instead of the truncation passing silently.
                // Appended to the chat-history container (bottom), NOT the message body — the body is
                // re-rendered at stream finalize, which would wipe a note placed inside it.
                const _chatBox = document.getElementById('chat-history');
                if (!_isBg && _chatBox) {
                  const _old = _chatBox.querySelector('.response-truncated');
                  if (_old) _old.remove();
                  const note = document.createElement('div');
                  note.className = 'stopped-indicator response-truncated';
                  const label = document.createElement('span');
                  label.className = 'rounds-exhausted-label';
                  label.textContent = 'The response was cut off before it finished.';
                  note.appendChild(label);
                  const contBtn = document.createElement('button');
                  contBtn.className = 'continue-btn';
                  contBtn.title = 'Continue the response';
                  contBtn.textContent = 'Continue ▸';
                  const _holder = currentHolder;
                  contBtn.addEventListener('click', () => {
                    note.remove();
                    chatState._hideUserBubble = true;
                    chatState._pendingContinue = _holder;
                    handleChatSubmit(null, 'Your previous response was cut off before it finished. Continue from exactly where you left off — do NOT repeat what you already wrote.');
                  });
                  note.appendChild(contBtn);
                  _chatBox.appendChild(note);
                  try { note.scrollIntoView({ block: 'end', behavior: 'smooth' }); } catch (_) { uiModule.scrollHistory && uiModule.scrollHistory(); }
                }
              } else if (json.type === 'model_actual') {
                if (!_isBg && holder) {
                  holder._requestedModel = json.requested_model || holder._requestedModel || modelName;
                  holder._actualModel = json.model || holder._actualModel || holder._requestedModel;
                  _setRoleModelLabel(holder.querySelector('.role'), holder._requestedModel, holder._actualModel, {
                    suffix: holder._roleSuffix,
                    characterName: holder._characterName,
                  });
                }
              } else if (json.type === 'attachments') {
                if (_isBg) continue;
                // Update user bubble — replace file chips with image previews
                const _ub = document.querySelector('#chat-history .msg-user:last-of-type');
                if (_ub) {
                  const _aw = _ub.querySelector('.attach-cards');
                  if (_aw) {
                    for (const _att of json.data) {
                      const _isImg = (_att.mime || '').startsWith('image/') || /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(_att.name || '');
                      if (_isImg && _att.id) {
                        // Skip if we already have a preview for this file id —
                        // on a regenerate the original user bubble keeps its
                        // photo and the backend re-emits the attachment event
                        // for the same id; without this guard we'd append a
                        // duplicate (which visually pushes the real photo off).
                        const _existingPreview = _aw.querySelector('[data-file-id="' + _att.id + '"]');
                        if (_existingPreview) {
                          if (_att.vision_model && !_existingPreview.querySelector('.attach-vision-model')) {
                            const _vl = document.createElement('div');
                            _vl.className = 'attach-vision-model';
                            _vl.textContent = 'Vision: ' + String(_att.vision_model).split('/').pop();
                            const _name = _existingPreview.querySelector('.attach-image-name');
                            if (_name) _existingPreview.insertBefore(_vl, _name);
                            else _existingPreview.appendChild(_vl);
                          }
                          continue;
                        }
                        const _card = _aw.querySelector('.attach-card[data-name="' + (_att.name || '').replace(/"/g, '\\"') + '"]');
                        const _iw = document.createElement('div');
                        _iw.className = 'attach-image-preview';
                        _iw.dataset.fileId = _att.id;
                        _iw.style.cursor = 'pointer';
                        _iw.onclick = () => window.open(API_BASE + '/api/upload/' + _att.id, '_blank');
                        const _im = document.createElement('img');
                        _im.src = API_BASE + '/api/upload/' + _att.id;
                        _im.alt = _att.name || 'Image';
                        _im.style.cssText = 'max-width:300px;max-height:200px;border-radius:6px;display:block;';
                        _iw.appendChild(_im);
                        if (_att.vision_model) {
                          const _vl = document.createElement('div');
                          _vl.className = 'attach-vision-model';
                          _vl.textContent = 'Vision: ' + String(_att.vision_model).split('/').pop();
                          _iw.appendChild(_vl);
                        }
                        if (_att.name) {
                          const _nm = document.createElement('div');
                          _nm.className = 'attach-image-name';
                          _nm.textContent = _att.name;
                          _iw.appendChild(_nm);
                        }
                        if (_card) _card.replaceWith(_iw); else _aw.appendChild(_iw);
                      } else {
                        const _card = _aw.querySelector('.attach-card[data-name="' + (_att.name || '').replace(/"/g, '\\"') + '"]');
                        if (_card && _att.id) {
                          _card.dataset.fileId = _att.id;
                          _card.style.cursor = 'pointer';
                          _card.onclick = () => window.open(API_BASE + '/api/upload/' + _att.id, '_blank');
                        }
                      }
                    }
                  }
                  // Caption / OCR text is no longer rendered as an inline
                  // collapsible on the user bubble — the user can view/edit
                  // it via the "Caption" button on the photo thumbnail.
                }
              } else if (json.type === 'rag_sources') {
                if (_isBg) continue;
                holder._ragSources = json.data;
              } else if (json.type === 'memories_used') {
                if (_isBg) continue;
                holder._memoriesUsed = json.data;
              } else if (json.type === 'compacted') {
                if (!_isBg) {
                  uiModule.showToast('Context compacted — older messages summarized');
                }
              } else if (json.type === 'metrics') {
                metrics = json.data;
                if (!_isBg && holder && metrics) {
                  holder._requestedModel = metrics.requested_model || holder._requestedModel || modelName;
                  holder._actualModel = metrics.model || holder._actualModel || holder._requestedModel;
                }
                if (_isBg) {
                  var bgM = chatState._backgroundStreams.get(streamSessionId);
                  if (bgM) bgM.metrics = json.data;
                  continue;
                }

              } else if (json.type === 'user_message') {
                // F1 (concurrent-session consistency): the run buffer now leads with the persisted
                // USER turn so OBSERVER windows render cause before effect. The SENDER already painted
                // its optimistic user bubble — renderObserverUserMessage dedups by clientMsgId and only
                // STAMPS the authoritative {id, seq} onto that existing bubble (never a second bubble),
                // so the settle reconcile adopts it with zero churn. Background stream ⇒ skip (no DOM).
                if (_isBg) continue;
                try { renderObserverUserMessage(json, { beforeEl: currentHolder || holder }); } catch (_) {}

              } else if (json.type === 'message_saved') {
                // Wire the persisted DB id onto the just-streamed bubble so it
                // can be edited/deleted immediately, without reloading the chat.
                if (_isBg) continue;
                _sawMessageSaved = true;   // BUG 2: the turn persisted a message — not the empty-turn case
                if (currentHolder && json.id) currentHolder.dataset.dbId = json.id;
                // ADR 0012 §2.2/§3.3: adopt the SERVER-minted timestamp so every window (sender,
                // observer, a late reload) renders the IDENTICAL time string instead of each window's
                // own `new Date()` (which drifts). Overwrite the speculative role-timestamp the bubble
                // was created with; the settled render (reload/addMessage) is already server-sourced.
                // M2-6: `json.moment` (the beat's in-world stamp) rides the same event so the live
                // bubble shows it immediately, identical to the reload render. Absent ⇒ wall clock.
                if (currentHolder && (json.ts || json.moment)) _applyServerTimestamp(currentHolder, json.ts, json.moment);

              } else if (json.type === 'run-started') {
                // D2: the POST stream now prepends a run-started event with the server's run ID.
                // Record it as our own so self-resume can find it later. Only record it when not
                // already set (the sessionSync path may have already set it via events SSE).
                if (json.runId && !chatState._ownRunIds[streamSessionId]) {
                  chatState._ownRunIds[streamSessionId] = json.runId;
                }

              } else if (json.type === 'canonical_session') {
                // ADR 0012 §2.4: the loser-of-the-bind window — it POSTed under its own per-tab id but
                // the authoritative run lives under the canonical game session. The server has already
                // fanned this run's buffer to us; we just need to RE-KEY this window onto canonical so
                // its SSE/HUD/reconcile follow the shared game. Defensive belt — the sessions.js
                // canonical ladder converges most windows BEFORE they POST; this catches one that
                // didn't. Record it and converge AFTER the stream settles (a mid-stream selectSession
                // would reload history out from under the live bubble); _adoptCanonicalAfterStream is
                // consumed in the finally.
                if (_isBg) continue;
                if (json.id) {
                  _adoptCanonicalAfterStream = json.id;
                  // If orwell_narrator already arrived, mirror the producer onto the canonical id
                  // too — otherwise the byline resets to "Production" after the finally re-keys this
                  // window onto canonical (the narrator was only persisted under the pre-bind id).
                  if (_streamNarratorName && json.id !== streamSessionId) {
                    _persistNarratorForSession(json.id, _streamNarratorName);
                  }
                }

              } else if (json.type === 'orwell_narrator') {
                // #1626 increment 2: the engine resolved this stream's producer (production-voice)
                // name. ALWAYS persist it SEASON-SCOPED (keyed to the ORIGINATING session), so a
                // background stream's producer is remembered for ITS session. But only touch the
                // tab-global byline + refresh the live bubble when this stream is the ACTIVE session
                // (`!_isBg`) — otherwise a background session A would hijack the byline of the
                // session B the user is viewing. Fail open on a blank name.
                if (json.name) {
                  _streamNarratorName = json.name;
                  _persistNarratorForSession(streamSessionId, json.name);
                  // Loser-of-the-bind: also persist under the canonical id this run was re-keyed to,
                  // so the byline survives the post-stream converge (either event order is covered —
                  // canonical_session mirrors the reverse case when it arrives second).
                  if (_adoptCanonicalAfterStream && _adoptCanonicalAfterStream !== streamSessionId) {
                    _persistNarratorForSession(_adoptCanonicalAfterStream, json.name);
                  }
                  if (!_isBg) {
                    setGameNarrator(json.name);
                    _refreshLiveByline(holder);
                  }
                }

              } else if (json.type === 'tool_start') {
                if (_isBg) continue;
                _usedToolsThisTurn = true;   // this turn called a tool → not a no-tool empty completion
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                // Force-close thinking if still open — tools are real content, not thinking
                if (isThinking) {
                  isThinking = false;
                  cancelAnimationFrame(_thinkTimerRAF);
                  var _elapsed2 = thinkingStartTime ? ((Date.now() - thinkingStartTime) / 1000).toFixed(1) : null;
                  if (_liveThinkHeader) _liveThinkHeader.textContent = isGameBuild() ? 'Production notes' : 'View thinking process';
                  if (_liveThinkTimerEl) _liveThinkTimerEl.textContent = _elapsed2 ? _elapsed2 + 's' : '';
                  if (_liveThinkSpinnerSlot) _liveThinkSpinnerSlot.remove();
                  // Assign stable IDs
                  var _thinkId2 = 'think-' + Date.now();
                  var _liveHdr2 = _liveThinkSection && _liveThinkSection.querySelector('.thinking-header');
                  if (_liveHdr2) _liveHdr2.dataset.thinkingId = _thinkId2;
                  if (_liveThinkContent) _liveThinkContent.id = _thinkId2;
                  if (_liveThinkToggle) _liveThinkToggle.id = _thinkId2 + '-toggle';
                }
                _renderStream();
                // --- Finalize current text bubble (only once per round) ---
                if (!roundFinalized) {
                  roundFinalized = true;
                  if (spinner && spinner.element) spinner.destroy();
                  let dt = stripToolBlocks(roundReplyText);  // F8: reply-only (reasoning → accordion)
                  // L6c (supersedes L6b): a round that produced VISIBLE narration is the player's
                  // dialogue (the casting interviewer's lines, a scene beat) — KEEP it even when a
                  // tool follows. Only a truly-EMPTY tool-only round is hidden. The old L6b rule hid
                  // every intermediate round in the game build, which structurally lost a multi-line
                  // interview ("4 answers go away" — prod casting loop). `dt` is reply-only (reasoning
                  // → accordion) and game-build scrubbed by processWithThinking (scrubReasoningPreamble
                  // strips planning preambles / raw npc:<id>), so a planning round still scrubs down
                  // (often to empty → hidden) without losing real narration. Game + non-game identical.
                  if (dt.trim()) {
                    var _body3 = roundHolder.querySelector('.body');
                    var _contentEl3 = _ensureStreamLayout(_body3);
                    _contentEl3.style.minHeight = '';  // clear streaming inflate
                    // #828: same wrap classification as _renderStream/reload — feed the
                    // marker-stripped text so a whole-`((...))`-wrap round doesn't ALSO get
                    // processWithThinking's inner `.ooc-producer-aside` div stacked on top of
                    // the wrap-level `.msg-ooc-producer` styling this just applied.
                    dt = chatRenderer.applyOocClass(roundHolder, dt.trim(), 'assistant').text;
                    _contentEl3.innerHTML = markdownModule.processWithThinking(markdownModule.squashOutsideCode(dt));
                    if (window.hljs) roundHolder.querySelectorAll('pre code').forEach((b) => window.hljs.highlightElement(b));
                  } else {
                    roundHolder.style.display = 'none';
                  }
                }

                // Track tool name for contextual spinner labels
                _lastToolName = json.tool || '';

                // #1336 (gate-wait UX): the #1313 house-entry gate can HOLD the createCharacter
                // tool RETURN for a whole cast-authoring pass — the player used to stare at the
                // generic tool-running node for the entire wait, because the "Production is
                // finalizing your casting…" card only fired on the tool RESULT (tool_output).
                // Paint it the moment the finalize STARTS so the hold shows the holding copy
                // throughout. begin() is idempotent (the tool_output re-begin stays as the safety
                // re-paint); cleared by the first narration token in the json.delta path, with the
                // finally-block safety net. No new window (inline indicator, not an OrwellWindow),
                // no ad-hoc events.
                if (json.tool === 'createCharacter') {
                  try { if (window._orwellFinalizing) { _orwellFinalizingActive = true; window._orwellFinalizing.begin(); } } catch (_) {}
                }

                // ADR 0011 — drop pure context-read beats in the game build (see orwellToolBeats):
                // they change nothing the player witnessed and otherwise stack as a wall of identical
                // "Production notes" chips on a long / concurrent-re-ground turn. No chip, no thread
                // node; currentToolBubble=null so the paired tool_output is skipped (the next real
                // beat re-arms it). The non-game build is unaffected.
                if (orwellBeatIsSilent(json.tool) && isGameBuild()) {
                  currentToolBubble = null;
                  continue;
                }

                // --- Thread timeline: group tools in a thread container ---
                let cmd = json.command || '';
                const chatBox = document.getElementById('chat-history');
                // Find existing thread to append to — check last few children
                // (agent_step may insert an empty msg-ai between tool rounds)
                let threadWrap = null;
                for (let ci = chatBox.children.length - 1; ci >= Math.max(0, chatBox.children.length - 5); ci--) {
                  const child = chatBox.children[ci];
                  if (child.classList.contains('agent-thread')) {
                    threadWrap = child;
                    break;
                  }
                  // Skip hidden (empty) bubbles and thinking spinners
                  if (child.style.display === 'none' || child.classList.contains('agent-thinking-dots')) continue;
                  // Stop if we hit a visible message bubble (has real content between tools)
                  if (child.classList.contains('msg')) break;
                }
                if (threadWrap) {
                  // Continuing an existing thread — remove has-bottom (agent_step may have set it
                  // expecting text, but we got more tools instead)
                  threadWrap.classList.remove('has-bottom');
                } else {
                  threadWrap = document.createElement('div');
                  threadWrap.className = 'agent-thread';
                  // Extend line up to connect to chat bubble above (if there is one)
                  const _prevSib = chatBox.lastElementChild;
                  const _hasBubbleAbove = _prevSib && (_prevSib.classList.contains('msg') && _prevSib.style.display !== 'none');
                  const _hasThreadAbove = _prevSib && _prevSib.classList.contains('agent-thread');
                  if (_hasBubbleAbove || _hasThreadAbove || (roundText.trim() && roundHolder && roundHolder.style.display !== 'none')) {
                    threadWrap.classList.add('has-top');
                  }
                  chatBox.appendChild(threadWrap);
                }
                threadWrap.classList.add('streaming');
                const _beat = _orwellToolBeats[json.tool];
                const toolLabel = _beat || _toolLabels[json.tool.toLowerCase()] || json.tool;
                if (_beat) cmd = '';  // production machinery: never show raw args
                const node = document.createElement('div')
                node.className = 'agent-thread-node running';
                const cmdHtml = cmd ? `<pre class="agent-thread-cmd">${esc(cmd)}</pre>` : '';
                // ONE state marker per node: the timeline dot is the single state
                // glyph (a hollow pulsing ring while running \u2192 a solid fill on done).
                // The old \u25B6/\u2713 icon doubled the dot with a second round mark.
                node.innerHTML = `<div class="agent-thread-dot"></div><div class="agent-thread-header"><span class="agent-thread-tool">${esc(toolLabel)}</span><span class="agent-thread-wave">▁▂▃</span></div><div class="agent-thread-content">${cmdHtml}</div>`;
                // Expand/collapse via delegated click handler (init at module bottom).
                threadWrap.appendChild(node);
                // ADR 0011 — cap the rail (backstop; a normal turn never hits it). Keep the most
                // recent ORWELL_MAX_VISIBLE_BEATS nodes; drop older overflow. The running node is the
                // newest (never dropped); the dropped ones are solidified (timers cleared on
                // tool_output — we clear defensively anyway).
                const _railNodes = threadWrap.querySelectorAll('.agent-thread-node');
                for (let _ri = 0; _ri < _railNodes.length - ORWELL_MAX_VISIBLE_BEATS; _ri++) {
                  const _oldN = _railNodes[_ri];
                  if (_oldN._waveInterval) clearInterval(_oldN._waveInterval);
                  if (_oldN._elapsedTicker) clearInterval(_oldN._elapsedTicker);
                  _oldN.remove();
                }
                currentToolBubble = node;
                // Animate the wave
                const waveEl = node.querySelector('.agent-thread-wave');
                if (waveEl) {
                  const waveFrames = ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▇', '▆▅▄', '▅▄▃', '▄▃▂'];
                  let waveIdx = 0;
                  node._waveInterval = setInterval(() => {
                    waveIdx = (waveIdx + 1) % waveFrames.length;
                    waveEl.textContent = waveFrames[waveIdx];
                  }, 100);
                }
                // Smooth per-second "cooking" timer — ticks every second (not
                // just on the 2s backend heartbeat) so a long-running tool
                // always shows visible motion and never reads as frozen.
                node._startTime = Date.now();
                node._elapsedTicker = setInterval(() => {
                  const hdr2 = node.querySelector('.agent-thread-header');
                  if (!hdr2) return;
                  let el2 = hdr2.querySelector('.agent-thread-elapsed');
                  if (!el2) {
                    el2 = document.createElement('span');
                    el2.className = 'agent-thread-elapsed';
                    // Sits at the LEFT of the header (the icon glyph was removed — the
                    // timeline dot is the state marker now), before the tool label.
                    hdr2.insertBefore(el2, hdr2.firstChild);
                  }
                  const s = (Date.now() - node._startTime) / 1000;
                  // Hundredths so it visibly counts sub-second (1.00, 1.05, …).
                  el2.textContent = s < 60 ? `${s.toFixed(2)}s` : `${Math.floor(s / 60)}m ${(s % 60).toFixed(2).padStart(5, '0')}s`;
                }, 50);
                uiModule.scrollHistory();

              } else if (json.type === 'tool_progress') {
                // Long-running subprocess (bash, python) is still in
                // flight — refresh the running tool card with the
                // elapsed-time + tail of its stdout/stderr so the
                // user doesn't stare at a blind "Running…" spinner.
                if (_isBg) continue;
                if (!currentToolBubble) continue;
                // The per-second ticker (started in tool_start) owns the
                // elapsed display; here we just surface the live output tail.
                const tailStr = (json.tail || '').trim();
                if (tailStr) {
                  let tailEl = currentToolBubble.querySelector('.agent-thread-tail');
                  if (!tailEl) {
                    tailEl = document.createElement('pre');
                    tailEl.className = 'agent-thread-tail';
                    tailEl.style.cssText = 'margin:4px 0 0;padding:6px 8px;font-size:11px;background:rgba(0,0,0,0.18);border-radius:4px;max-height:140px;overflow:auto;white-space:pre-wrap;opacity:0.85;';
                    const content = currentToolBubble.querySelector('.agent-thread-content');
                    if (content) content.appendChild(tailEl);
                  }
                  tailEl.textContent = tailStr;
                  tailEl.scrollTop = tailEl.scrollHeight;
                }
                uiModule.scrollHistory();

              } else if (json.type === 'tool_output') {
                if (_isBg) continue;
                // --- Update the current thread node ---
                if (currentToolBubble) {
                  // Stop wave animation + the per-second cooking ticker
                  if (currentToolBubble._waveInterval) {
                    clearInterval(currentToolBubble._waveInterval);
                    currentToolBubble._waveInterval = null;
                  }
                  if (currentToolBubble._elapsedTicker) {
                    clearInterval(currentToolBubble._elapsedTicker);
                    currentToolBubble._elapsedTicker = null;
                  }
                  const ok = (json.exit_code === 0 || json.exit_code == null);
                  let cmd = json.command || '';
                  let outHtml = '';
                  if (json.output && json.output.trim()) {
                    outHtml = `<details class="agent-tool-output"><summary>Output</summary><pre>${esc(json.output)}</pre></details>`;
                  }
                  // File-write diff (write_file): show a before/after unified diff.
                  let diffHtml = '';
                  if (json.diff && json.diff.text) {
                    const d = json.diff;
                    // Collapsed summary: filename + +adds (green) / −dels (red).
                    const stat = [
                      d.new_file ? '<span class="diff-stat-new">new</span>' : '',
                      d.added ? `<span class="diff-stat-add">+${d.added}</span>` : '',
                      d.removed ? `<span class="diff-stat-del">−${d.removed}</span>` : '',
                    ].filter(Boolean).join(' ');
                    const rows = d.text.split('\n').map(line => {
                      let cls = 'diff-ctx', text = line;
                      if (line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta';
                      else if (line.startsWith('@@')) cls = 'diff-hunk';
                      // Drop the leading diff marker (+/-/space) — the row colour
                      // already encodes add/del, and keeping it doubles up with
                      // markdown "- " bullets (reads as "+-"/"--").
                      else if (line.startsWith('+')) { cls = 'diff-add'; text = line.slice(1); }
                      else if (line.startsWith('-')) { cls = 'diff-del'; text = line.slice(1); }
                      else if (line.startsWith(' ')) { text = line.slice(1); }
                      return `<span class="${cls}">${esc(text) || '&nbsp;'}</span>`;
                    }).join('');  // spans are display:block — a literal \n here would double-space the diff
                    diffHtml = `<details class="agent-tool-output agent-tool-diff"><summary><span class="diff-file">${esc(d.file || 'diff')}</span> <span class="diff-summary-stats">${stat}</span></summary><pre class="diff-pre">${rows}</pre></details>`;
                  }
                  // For file edits the "command" is the raw JSON args — redundant
                  // next to the diff, so hide it when we have a diff to show.
                  const _beatOut = _orwellToolBeats[json.tool];
                  if (_beatOut) { cmd = ''; outHtml = ''; }  // game beats: label + status only, no raw JSON
                  // C20: surface the engine's pending decision (or clear it) to the confirm
                  // guardrail. Vault-free AdvanceView only; fail-open on any parse trouble.
                  if (json.tool === 'advanceGame' || json.tool === 'submitDecision') {
                    try {
                      const _adv = JSON.parse(json.output || '{}');
                      window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: _adv && _adv.pending ? _adv.pending : null } }));
                      // T0-3 (issue #1778): the SAME tool result's Vault-free `announcements`
                      // (BeatAnnouncementView[]) — the engine's broadcast chyron(s) for whatever
                      // ceremony fact(s) just committed (including a T0-2 auto-advanced beat chained
                      // onto this same call). Riding this SAME dispatch (not a new poll/transport) is
                      // what makes F5 two-window mirror parity inherited, not re-derived.
                      if (_adv && Array.isArray(_adv.announcements) && _adv.announcements.length) {
                        window.dispatchEvent(new CustomEvent('orwell:announcements', { detail: { announcements: _adv.announcements } }));
                      }
                    } catch (_) {}
                  }
                  // G15: every game-MUTATING tool result nudges the panels through THE one
                  // debounced dispatcher (platform.js orwellGameChanged) — post-action UI
                  // refreshes event-driven instead of waiting out a 20–30s poll.
                  // runCompetition rides along: it is the single outcome authority, and a
                  // comp result moves exactly what the status HUD shows (HOH/veto/phase).
                  // #1412 (R1b): the "is this tool game-MUTATING?" test is NO LONGER a
                  // hand-coded array here — it consumes the shared manifest via
                  // window.orwellIsMutatingTool (platform.js ORWELL_MUTATING_TOOLS, pinned
                  // registry-equal by test_1412_mutating_manifest.py). A newly-wired mutating
                  // registry tool flows into THIS HUD-refresh set with NO edit here: the
                  // drift-guard forces it into the manifest, and this seam picks it up for
                  // free. The helper is absent outside the game build, so the whole seam
                  // no-ops there (exactly like orwellGameChanged itself).
                  if (ok && window.orwellIsMutatingTool && window.orwellIsMutatingTool(json.tool)) {
                    // M1-3: the tool result carries the COMMITTED beatSeq (0065) — thread it
                    // through the single dispatcher so panels can verify their refetch caught up.
                    // #1785 AC3: the correction field from the engine's tool output rides the SAME
                    // G15 path as the third param to orwellGameChanged(reason, beatSeq, correction).
                    let _beat, _correction;
                    try {
                      const _parsed = JSON.parse(json.output || '{}') || {};
                      _beat = _parsed.beatSeq;
                      if (_parsed.correction && typeof _parsed.correction === 'string') _correction = _parsed.correction;
                    } catch (_) {}
                    if (window.orwellGameChanged) window.orwellGameChanged('tool:' + json.tool, _beat, _correction);
                    if (json.tool === 'createCharacter') {
                      // E65: a season RESTART opens a FRESH chat (armed only by reset-progress /
                      // next-season); NO-OP for the initial onboarding — it stays ONE conversation.
                      if (window._orwellFreshSession) window._orwellFreshSession();
                      // P1 (OOBE cutover): paint the inline "finalizing" indicator — createCharacter
                      // → house-entry is a heavy beat that must never read as frozen (cleared by the
                      // first narration token in the json.delta path, with a finally-block safety net).
                      try { if (window._orwellFinalizing) { _orwellFinalizingActive = true; window._orwellFinalizing.begin(); } } catch (_) {}
                      // CodeRabbit fix: arm the DEDICATED recovery latch only once the engine result
                      // confirms the season actually started (never on a failed/refused creation).
                      try {
                        const _cc = JSON.parse(json.output || '{}');
                        if (_cc && _cc.started && !_cc.createRefused) _orwellPremiereRecoveryArmed = true;
                      } catch (_) {}
                    }
                  }
                  const cmdHtml2 = (cmd && !(json.diff && json.diff.text)) ? `<pre class="agent-thread-cmd">${esc(cmd)}</pre>` : '';
                  // L7: a node is only EXPANDABLE when it has real content (command,
                  // output, or diff). A production beat (and any tool that returned
                  // nothing) has an empty content area, so rendering a chevron +
                  // collapsible affordance is a worthless click target. Render the
                  // chevron + content div ONLY when there is something to expand;
                  // otherwise mark the node --flat (a plain label, no expander).
                  const _expandHtml = `${cmdHtml2}${outHtml}${diffHtml}`;
                  const _hasExpand = !!_expandHtml.trim();
                  const _chevron2 = _hasExpand ? '<span class="agent-thread-chevron">\u25B6</span>' : '';
                  const _contentDiv2 = _hasExpand ? `<div class="agent-thread-content">${_expandHtml}</div>` : '';
                  // Preserve the user's .open choice across the innerHTML
                  // rewrite \u2014 otherwise expanding a running tool collapses
                  // it as soon as the result lands, forcing the user to
                  // click again. Click handling is delegated (see init at
                  // bottom of file) so no per-node listener needed.
                  const _wasOpen = _hasExpand && currentToolBubble.classList.contains('open');
                  // L42: in the game build, show the beat's PUBLIC OUTCOME (Vault-free, from the tool
                  // result) instead of a generic "done" \u2014 "\ud83d\uddf3\ufe0f Troy is evicted (7-1)", "\ud83c\udfc6 Maya wins HOH".
                  const _outcome = (_beatOut && ok) ? orwellBeatOutcome(json.tool, json.output) : null;
                  const _toolText = _outcome || _beatOut || json.tool;
                  // M2-5 (audit B7): game-build slates carry NO lowercase "done" debug tail —
                  // the ✓ + styled label IS the resolved state. Failures stay literal (operator
                  // truth, the J1-30 rule); the workspace build keeps its done/failed status.
                  const _statusHtml = _outcome ? '' : (ok && isGameBuild()) ? ''
                    : `<span class="agent-thread-status">${ok ? 'done' : 'failed'}</span>`;
                  // TRANS-12/VM-5 (2026-07 pre-ship audit): a ceremony beat's outcome (HOH crown,
                  // nomination reveal, veto result, eviction vote reveal) used to swap in via this
                  // innerHTML replace with zero motion \u2014 the show's biggest beats landed as a
                  // silent state flip. `ow-ceremony-reveal` (style.css) gives the header a brief
                  // staged entrance; reduced-motion strips it to the same instant swap as before.
                  currentToolBubble.className = 'agent-thread-node' + (ok ? '' : ' error') + (_hasExpand ? '' : ' agent-thread-node--flat') + (_wasOpen ? ' open' : '') + (_outcome ? ' ow-ceremony-reveal ow-slate-outcome' : '');
                  currentToolBubble.innerHTML = `<div class="agent-thread-dot"></div><div class="agent-thread-header"><span class="agent-thread-tool">${esc(_toolText)}</span>${_statusHtml}${_chevron2}</div>${_contentDiv2}`;
                  if (_outcome) {
                    const _revealHeader = currentToolBubble.querySelector('.agent-thread-header');
                    const _clearReveal = () => currentToolBubble.classList.remove('ow-ceremony-reveal');
                    if (_revealHeader) _revealHeader.addEventListener('animationend', _clearReveal, { once: true });
                    setTimeout(_clearReveal, 500); // belt: reduced-motion/no animationend still clears the marker
                  }
                  // M4-6 (idea 7): a curated ceremony beat (HOH win / nominations / veto win /
                  // veto ceremony / eviction result — the week roll rides the HOH card) also
                  // inserts a DESIGNED FULL-WIDTH slate card beside this compact chip, sourced
                  // ONLY from the same closed-set tool-result JSON (never parsed from prose —
                  // ADR 0005). Game-build only; the workspace build keeps the plain chip.
                  if (ok && isGameBuild()) {
                    const _slate = orwellCeremonySlate(json.tool, json.output);
                    if (_slate) {
                      const _threadEl = currentToolBubble.closest('.agent-thread');
                      if (_threadEl) {
                        // Anchor past slates already inserted for THIS thread, so a turn with two+
                        // ceremony beats keeps event order — always inserting 'afterend' of the
                        // thread itself would reverse them, diverging from the reload path's
                        // sequential anchoring and breaking .ow-cslate mirror parity (F1).
                        let _anchor = _threadEl;
                        while (_anchor.nextElementSibling && _anchor.nextElementSibling.classList.contains('ow-cslate')) {
                          _anchor = _anchor.nextElementSibling;
                        }
                        _anchor.insertAdjacentElement('afterend', orwellRenderCeremonySlate(_slate));
                      }
                    }
                  }
                  // Reset so thinking spinner between tools says "Thinking" not the old tool's label
                  _lastToolName = '';
                  uiModule.scrollHistory();
                }
                // --- Render generated images inline ---
                if (json.image_url) {
                  _producedVisibleOutput = true;  // BUG 2: an image IS a real turn artifact
                  const chatBox = document.getElementById('chat-history');
                  chatBox.appendChild(_buildImageBubble(json.image_url, json.image_prompt, json.image_model, json.image_size, json.image_quality, json.image_id));
                  uiModule.scrollHistory();
                  // Notify gallery to refresh if open
                  window.dispatchEvent(new CustomEvent('gallery-refresh'));
                }
                // --- Render browser screenshots in tool output ---
                if (json.screenshot && currentToolBubble) {
                  const contentEl = currentToolBubble.querySelector('.agent-thread-content');
                  if (contentEl) {
                    const screenshotSrc = chatRenderer.safeToolScreenshotSrc(json.screenshot);
                    if (screenshotSrc) {
                      const details = document.createElement('details');
                      details.className = 'agent-tool-output';
                      const summary = document.createElement('summary');
                      summary.textContent = 'Screenshot';
                      const img = document.createElement('img');
                      img.src = screenshotSrc;
                      img.style.cssText = 'max-width:100%;border-radius:6px;margin-top:6px;border:1px solid var(--border)';
                      details.appendChild(summary);
                      details.appendChild(img);
                      contentEl.appendChild(details);
                    }
                  }
                }
                // --- Reload sessions after manage_session tool (delete, rename, etc.) ---
                // Debounce so bulk deletes don't fire loadSessions per call
                if (json.tool === 'manage_session' && sessionModule) {
                  if (window._manageSessionTimer) clearTimeout(window._manageSessionTimer);
                  window._manageSessionTimer = setTimeout(() => sessionModule.loadSessions(), 1000);
                }
                // --- Live-refresh the calendar after manage_calendar (add/edit/delete) ---
                // so a new event shows without the user hard-refreshing. Debounced
                // so a batch of event creates only triggers one refetch.
                if (json.tool === 'manage_calendar') {
                  if (window._manageCalTimer) clearTimeout(window._manageCalTimer);
                  window._manageCalTimer = setTimeout(
                    () => window.dispatchEvent(new CustomEvent('calendar-refresh')), 600);
                }
                // --- Live-refresh Memories after manage_memory changes ---
                if (json.tool === 'manage_memory') {
                  if (window._manageMemoryTimer) clearTimeout(window._manageMemoryTimer);
                  window._manageMemoryTimer = setTimeout(
                    () => window.dispatchEvent(new CustomEvent('memory-refresh')), 600);
                }
                // --- Apply UI control actions embedded in tool_output ---
                if (json.ui_event) {
                  chatStream.handleUIControl(json);
                }

                // Schedule a thinking spinner between tool rounds (short delay so
                // agent_step in the same SSE chunk can cancel it before it shows)
                _scheduleThinkingSpinner();
                uiModule.scrollHistory();

              } else if (json.type === 'doc_stream_open') {
                if (_isBg) {
                  // Store for replay when user returns to this session
                  var bgDocOpen = chatState._backgroundStreams.get(streamSessionId);
                  if (bgDocOpen) {
                    bgDocOpen._docTitle = json.title || '';
                    bgDocOpen._docLang = json.language || '';
                    bgDocOpen._docContent = '';
                  }
                  continue;
                }
                if (documentModule) {
                  documentModule.streamDocOpen(json.title || '', json.language || '');
                }

              } else if (json.type === 'doc_stream_delta') {
                if (_isBg) {
                  var bgDocDelta = chatState._backgroundStreams.get(streamSessionId);
                  if (bgDocDelta) bgDocDelta._docContent = json.content || '';
                  continue;
                }
                if (documentModule) {
                  documentModule.streamDocDelta(json.content || '');
                }

              } else if (json.type === 'doc_update') {
                // doc_update means the server already saved the doc to DB.
                if (_isBg) continue;
                if (documentModule) {
                  documentModule.handleDocUpdate(json);
                }

              } else if (json.type === 'doc_suggestions') {
                if (_isBg) continue;
                if (documentModule && documentModule.handleDocSuggestions) {
                  documentModule.handleDocSuggestions(json);
                }

              } else if (json.type === 'ui_control') {
                if (_isBg) continue;
                chatStream.handleUIControl(json.data || {});

              } else if (json.type === 'orwell_pending') {
                // F14 (#1013): the SURFACE-THE-PENDING belt. The engine is waiting on a player-owned
                // decision (e.g. the eviction goodbye/vote card), but the model narrated past it
                // WITHOUT calling submitDecision/advanceGame — so the per-tool `orwell:pending` seam at
                // the tool-result path never fired and the card would otherwise wait out the poll. The
                // server-side belt detected the open player pending post-turn and emits it here so the
                // card SURFACES immediately. This only SURFACES the decision card — it never picks the
                // player's tone/vote (the player still resolves it through the card's engine-direct POST).
                if (_isBg) continue;
                try {
                  const _p = (json.pending && json.pending.kind) ? json.pending : null;
                  window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: _p } }));
                } catch (_) {}

              } else if (json.type === 'realign_body') {
                // S2a in-turn realignment (#1664): the server EXCISED an ungrounded closed-set claim
                // from the accumulated (persisted) body and appended a deterministic engine-truth beat.
                // Re-render THIS turn's bubble from the corrected `text` so the sender window matches the
                // persisted (reload/peer) view — never a fabrication followed by a correction. Closed-set
                // only. Skip background streams.
                if (_isBg) continue;
                try {
                  const _rbReply = (typeof json.text === 'string') ? json.text : '';
                  const _rbHolder = roundHolder || currentHolder;
                  if (_rbReply && _rbHolder) {
                    // Finding 2 (#1664): keep roundReplyText REPLY-ONLY (the F8 contract — the reply
                    // buffer must never carry reasoning; persistence/dataset.raw + the final render read
                    // it). The reasoning stays in roundReasoningText and is used ONLY at the render
                    // boundary below, wrapped in <think>, to rebuild the Thinking accordion via
                    // processWithThinking (which routes the <think> block into the accordion and the
                    // rest into the public body — so reasoning never reaches the public bubble).
                    roundReplyText = _rbReply;
                    roundText = _rbReply;
                    accumulated = _rbReply;
                    currentAccumulated = _rbReply;
                    // The corrected body is the WHOLE turn — collapse any coalesced segments.
                    _turnCoalesced = false;
                    const _rbBody = _rbHolder.querySelector('.body');
                    if (_rbBody) {
                      _rbHolder.dataset.raw = markdownModule.scrubMachineryForPersistence(_rbReply);
                      // Render-boundary ONLY: merge the reasoning back in as a <think> block so the
                      // accordion is rebuilt; the buffers above stay reply-only.
                      const _rbMerged = markdownModule.composeThinkSource(roundReasoningText, _rbReply);
                      _rbBody.innerHTML = markdownModule.processWithThinking(
                        markdownModule.squashOutsideCode(_rbMerged));
                      if (window.hljs) {
                        _rbBody.querySelectorAll('pre code').forEach((b) => window.hljs.highlightElement(b));
                      }
                      // The stream-end finalize must NOT re-render this body from the reply-only buffer
                      // (that would drop the accordion just rebuilt); flag it so finalize skips the
                      // body render for this holder (metrics/dataset.raw/etc. still run).
                      _realignedBodyRendered = true;
                    }
                    uiModule.scrollHistory();
                  }
                } catch (_) {}

              } else if (json.type === 'ask_user') {
                if (_isBg) continue;
                _producedVisibleOutput = true;  // BUG 2: an ask_user prompt IS a real turn artifact
                // The agent posed a multiple-choice question; the turn has ended.
                // Render clickable options at the bottom of the history. The
                // user's pick is sent as the next message and the agent resumes.
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                const _aq = json.data || {};
                const _opts = Array.isArray(_aq.options) ? _aq.options : [];
                if (_aq.question && _opts.length) {
                  const chatBox = document.getElementById('chat-history');
                  // Drop any prior unanswered card so only the latest shows.
                  chatBox.querySelectorAll('.ask-user-card').forEach(n => n.remove());
                  const card = document.createElement('div');
                  card.className = 'ask-user-card';
                  const multi = !!_aq.multi;
                  // Group the choices for assistive tech and label the group with
                  // the question (set below); make the card focusable so it can be
                  // moved to when it appears.
                  card.setAttribute('role', 'group');
                  card.tabIndex = -1;
                  // Render any emoji in agent-supplied text through the app's
                  // pipeline: escape, then svgify to monochrome theme-tinted
                  // glyphs (project rule: never colorful emoji; respects the
                  // "Text-only Emojis" setting like the rest of the chat).
                  const _emo = (s) => svgifyEmoji(uiModule.esc(String(s)));

                  // Header row holds the close (×) to dismiss the affordances and
                  // just type a reply instead.
                  const head = document.createElement('div');
                  head.className = 'ask-user-head';
                  const closeBtn = document.createElement('button');
                  closeBtn.type = 'button';
                  closeBtn.className = 'ow-btn ow-btn-icon ask-user-close';
                  closeBtn.setAttribute('aria-label', 'Dismiss question');
                  closeBtn.textContent = '×';
                  closeBtn.addEventListener('click', () => {
                    card.remove();
                    const mi = uiModule.el('message');
                    if (mi) mi.focus();
                  });
                  head.appendChild(closeBtn);
                  card.appendChild(head);

                  // Render the question inside the card so it's self-contained:
                  // some models call ask_user without first narrating the question
                  // as assistant text, in which case the card would otherwise show
                  // bare options with no prompt.
                  if (_aq.question) {
                    const q = document.createElement('div');
                    q.className = 'ask-user-question';
                    q.id = `ask-user-q-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
                    q.innerHTML = _emo(_aq.question);
                    card.appendChild(q);
                    // Label the choice group with the question for screen readers.
                    card.setAttribute('aria-labelledby', q.id);
                  } else {
                    card.setAttribute('aria-label', 'Question from the assistant');
                  }

                  const list = document.createElement('div');
                  list.className = 'ask-user-options';
                  card.appendChild(list);

                  const _send = (text) => {
                    if (!text) return;
                    // Remove the card once answered — the choice is sent as a
                    // normal user message (and the question persists as the
                    // assistant text above), so the affordances are spent.
                    card.remove();
                    handleChatSubmit(null, text); // the picked option is sent as a normal user message
                  };

                  _opts.forEach((opt, i) => {
                    const label = (opt && opt.label) ? String(opt.label) : String(opt || '');
                    if (!label) return;
                    const descr = (opt && opt.description) ? String(opt.description) : '';
                    const row = document.createElement(multi ? 'label' : 'button');
                    row.className = 'ask-user-option';
                    if (multi) {
                      const cb = document.createElement('input');
                      cb.type = 'checkbox';
                      cb.value = label;
                      row.appendChild(cb);
                    }
                    const txt = document.createElement('span');
                    txt.className = 'ask-user-option-label';
                    txt.innerHTML = _emo(label);
                    row.appendChild(txt);
                    if (descr) {
                      const d = document.createElement('span');
                      d.className = 'ask-user-option-desc';
                      d.innerHTML = _emo(descr);
                      row.appendChild(d);
                    }
                    if (!multi) {
                      row.type = 'button';
                      row.addEventListener('click', () => _send(label));
                    }
                    list.appendChild(row);
                  });

                  // Free-text "Other" — type a custom answer + send (Enter or →).
                  const other = document.createElement('div');
                  other.className = 'ask-user-other';
                  const otherInput = document.createElement('input');
                  otherInput.type = 'text';
                  otherInput.className = 'styled-prompt-input ask-user-other-input';
                  otherInput.placeholder = multi ? 'Other (added to selection)…' : 'Other… (type your own answer)';
                  otherInput.setAttribute('aria-label', multi ? 'Add a custom option' : 'Type a custom answer');
                  const otherSend = document.createElement('button');
                  otherSend.type = 'button';
                  otherSend.className = 'ow-btn ow-btn-prominent ask-user-other-send';
                  otherSend.setAttribute('aria-label', 'Send answer');
                  otherSend.textContent = multi ? 'Send selection' : 'Send';
                  const _submit = () => {
                    const free = otherInput.value.trim();
                    if (multi) {
                      const picked = Array.from(card.querySelectorAll('.ask-user-option input:checked')).map(c => c.value);
                      if (free) picked.push(free);
                      if (picked.length) _send(picked.join(', '));
                    } else if (free) {
                      _send(free);
                    }
                  };
                  otherSend.addEventListener('click', _submit);
                  otherInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                      e.preventDefault();
                      _submit();
                    }
                  });
                  other.appendChild(otherInput);
                  other.appendChild(otherSend);
                  card.appendChild(other);

                  chatBox.appendChild(card);
                  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                  // Move focus to the card so keyboard/screen-reader users land on
                  // the question + choices when it appears.
                  try { card.focus(); } catch (_) {}
                }

              } else if (json.type === 'plan_update') {
                if (_isBg) continue;
                // Agent wrote back to the plan (ticked a step / revised). Update
                // the stored plan + live-refresh the docked plan window.
                const _pu = (json.data && json.data.plan) ? json.data.plan : '';
                if (_pu) _setStoredPlan(_pu);

              } else if (json.type === 'agent_step') {
                if (_isBg) continue;
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                _renderStream();
                // #829 turn-coalescing (coalesceRounds / oneBubblePerTurn — one "growing bubble"):
                // a NEW agent-loop round is starting, but ALL rounds of ONE player turn render into
                // ONE bubble that GROWS. FREEZE this round's reply/reasoning as a segment INSIDE the
                // SAME `roundHolder` bubble and let the next round append a fresh `.stream-content`
                // segment BELOW it — instead of minting a per-round `.msg-continuation` bubble (the
                // pre-#829 path: the per-round mount/hide/jump the reverted #822 also exhibited).
                // Reasoning stays in the segment's `.thinking-section` accordion and is NEVER spliced
                // into the reply body, so the F8 reply/reasoning channel split holds per round.
                _commitRoundSegment();
                _turnCoalesced = true;
                // Mark the tool thread as connected (the rail sits below the growing bubble).
                const _activeThread = document.querySelector('.agent-thread.streaming');
                if (_activeThread) {
                  _activeThread.classList.add('has-bottom');
                }
                // Reuse the SAME turn bubble — roundHolder / currentHolder / holder all STAY put (no
                // new `.msg-ai` mount). Its role+timestamp header, set at stream start, is the turn
                // header for the whole turn (with ONE bubble there is no #834 promotion to do). If a
                // pure-tool round hid the bubble (tool_start empty-branch), un-hide it — it is the one
                // growing bubble.
                if (roundHolder && roundHolder.style.display === 'none') roundHolder.style.display = '';
                currentToolBubble = null;
                roundFinalized = false;
                isThinking = false;
                _docFenceOpened = false;
                _docFenceContentStart = -1;
                // Fresh thinking-accordion refs so the NEXT round builds its OWN accordion; the
                // committed segment kept the previous round's accordion frozen in place.
                _liveThinkSection = null; _liveThinkContent = null; _liveThinkInner = null;
                _liveThinkHeader = null; _liveThinkSpinnerSlot = null; _liveThinkTimerEl = null;
                _liveThinkToggle = null; _liveThinkDomId = null;
                roundText = '';
                roundReplyText = '';        // F8: keep the split buffers in lockstep with roundText
                roundReasoningText = '';
                // Destroy any previous spinner before creating a new one — appended to the SAME body
                // while the next round's first text is awaited (a fresh `.stream-content` mints on the
                // first delta, below the frozen segment).
                if (spinner && spinner.element) spinner.destroy();
                const _coalBody = roundHolder.querySelector('.body');
                if (_coalBody && !chatState._researchingStreamIds.has(streamSessionId)) {
                  spinner = spinnerModule.create(_inProgressLabel('Generating response'), 'right', 'wave');
                  _coalBody.appendChild(spinner.createElement());
                  spinner.start();
                }
                if (streamingTTS) window.aiTTSManager._streamSentencesSent = 0;
                uiModule.scrollHistory();
              } else if (json.type === 'budget_exceeded') {
                if (_isBg) continue;
                _producedVisibleOutput = true;  // BUG 2: the budget notice IS a visible turn artifact
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                const budgetDiv = document.createElement('div');
                budgetDiv.style.cssText = 'font-size:11px;opacity:0.6;font-style:italic;padding:4px 8px;margin:4px 0;';
                budgetDiv.textContent = `Tool budget reached (${json.used}/${json.limit} calls). Agent stopped.`;
                const chatBox = document.getElementById('chat-history');
                chatBox.appendChild(budgetDiv);

              } else if (json.type === 'teacher_takeover') {
                if (_isBg) continue;
                _cancelThinkingTimer();
                _removeThinkingSpinner();
                // Finalize any in-flight bubble so the takeover banner
                // separates student attempt from teacher attempt.
                if (spinner && spinner.element) { try { spinner.destroy(); } catch(_){} spinner = null; }
                const chatBox = document.getElementById('chat-history');
                const banner = document.createElement('div');
                banner.className = 'teacher-takeover-banner';
                banner.style.cssText = 'margin:10px 0;padding:8px 12px;border-left:3px solid #c08a3e;background:rgba(192,138,62,0.08);font-size:12px;color:var(--fg);border-radius:4px;';
                const teacherName = json.teacher_model || 'teacher';
                const why = json.student_failure ? ` &mdash; <span style="opacity:0.7">${esc(json.student_failure)}</span>` : '';
                banner.innerHTML = `<strong>Teacher takeover:</strong> escalating to <code>${esc(teacherName)}</code>${why}`;
                chatBox.appendChild(banner);
                // Reset round bubble state so the teacher's first text starts a new bubble
                roundHolder = null;
                currentHolder = null;       // keep in lockstep with roundHolder (see the agent_step fix)
                roundText = '';
                roundReplyText = '';        // F8: keep the split buffers in lockstep with roundText
                roundReasoningText = '';
                roundFinalized = false;
                currentToolBubble = null;
                uiModule.scrollHistory();

              } else if (json.type === 'skill_saved') {
                if (_isBg) continue;
                const chatBox = document.getElementById('chat-history');
                const note = document.createElement('div');
                note.className = 'skill-saved-note';
                note.style.cssText = 'margin:6px 0;padding:6px 10px;border-left:3px solid #4a8a4a;background:rgba(74,138,74,0.07);font-size:12px;color:var(--fg);border-radius:4px;';
                note.innerHTML = `<strong>Skill learned:</strong> <code>${esc(json.name || '')}</code>${json.category ? ` <span style="opacity:0.6">[${esc(json.category)}]</span>` : ''}`;
                chatBox.appendChild(note);
                uiModule.scrollHistory();

              } else if (json.type === 'escalation_failed' || json.type === 'skill_save_failed') {
                if (_isBg) continue;
                const chatBox = document.getElementById('chat-history');
                const note = document.createElement('div');
                note.className = 'escalation-failed-note';
                note.style.cssText = 'margin:6px 0;padding:6px 10px;border-left:3px solid #8a4a4a;background:rgba(138,74,74,0.07);font-size:12px;color:var(--fg);border-radius:4px;';
                const label = json.type === 'escalation_failed' ? 'Teacher could not solve it' : 'Skill not saved';
                note.innerHTML = `<strong>${label}:</strong> <span style="opacity:0.75">${esc(json.reason || '')}</span>`;
                chatBox.appendChild(note);
                uiModule.scrollHistory();

              } else if (json.error) {
                // --- Backend error (timeout, connection issue, etc.) ---
                console.error('Stream error from backend:', json.error);
                if (_isBg) continue;
                _producedVisibleOutput = true;  // BUG 2: a surfaced error IS visible recourse already
                if (spinner && spinner.element) spinner.destroy();
                // B11 (2026-07-05): this is the FEPY-1 (#621) typed mid-stream `error` SSE — a bare
                // `data: {"error": ...}` frame (no `event: error`, no `status`), so it never reaches
                // the diegetic-line branch above and previously fell straight through to a raw
                // `[Error: <upstream message>]` string appended into THIS message's own `.body` —
                // i.e. rendered as if the narrator itself said it (exactly the I9 violation this fix
                // closes). Game build: the same canonical interruption line, same treatment
                // (`.body`, not a separate note) as the sibling branch above. Outside the game build
                // (the general assistant) keep the raw, informative text for debuggability.
                const errText = isGameBuild() ? _ENGINE_INTERRUPT_LINE : `[Error: ${json.error}]`;
                const errDiv = document.createElement('div');
                errDiv.style.cssText = 'color: var(--color-error); font-style: italic; padding: 4px 0;';
                errDiv.textContent = errText;
                roundHolder.querySelector('.body').appendChild(errDiv);
                uiModule.scrollHistory();
              }
            } catch (e) {
              console.error('Error parsing SSE data:', e);
            }
          }
        }
      }

      if (!_streamSawDone) {
        throw new Error('Stream closed before completion');
      }

      _renderStream();
      _cancelThinkingTimer();
      _removeThinkingSpinner();
      // Stop any thread pulse animations
      document.querySelectorAll('.agent-thread.streaming').forEach(t => t.classList.remove('streaming'));
      // --- Final render (skip if stream was ever backgrounded or currently in background) ---
      // Remove streaming class from all round bubbles
      holder.classList.remove('streaming');
      if (roundHolder && roundHolder !== holder) roundHolder.classList.remove('streaming');

      const _isBgFinal = (sessionModule.getCurrentSessionId() !== streamSessionId) || chatState._backgroundStreams.has(streamSessionId);
      if (!_isBgFinal) {
        finalMeta = sessionModule.getSessions().find(s => s.id === sessionModule.getCurrentSessionId());
        const _finalActualModel = metrics?.model || holder._actualModel || finalMeta?.model;
        const _finalRequestedModel = metrics?.requested_model || holder._requestedModel || finalMeta?.model || _finalActualModel;
        // Prepend character name if set
        var _charNameFinal = presetsModule.getCharacterName ? presetsModule.getCharacterName() : '';
        const roleEl = holder.querySelector('.role');
        if (roleEl) {
          _setRoleModelLabel(roleEl, _finalRequestedModel, _finalActualModel, {
            suffix: holder._roleSuffix,
            characterName: _charNameFinal || holder._characterName,
          });
        }
        // FEDEEP-2: scrub any reasoning/machinery that bled into plain content out of the cached
        // raw copy — `accumulated` is the MERGED stream buffer (reply + reasoning deltas) and this
        // cache feeds copy/regen/TTS, so a leak that never reached the rendered bubble must not
        // survive into it. Same chain processWithThinking's public-reply branch already runs.
        holder.dataset.raw = markdownModule.scrubMachineryForPersistence(accumulated);

        // Anti-stall: a turn that ran tools but ended with essentially no
        // final prose usually means the model stopped mid-task (the case
        // where you had to type "did you finish?"). Offer a one-click
        // Continue that resumes exactly where it left off — reuses the same
        // resume mechanism as the user-stop "[Message interrupted]" button.
        try {
          const _usedTools = holder.querySelector('.agent-thread-node');
          const _proseLen = (accumulated || '').replace(/<[^>]*>/g, '').trim().length;
          if (_usedTools && _proseLen < 24 && !holder.querySelector('.agent-continue-btn')) {
            const _stall = document.createElement('div');
            _stall.className = 'stopped-indicator';
            const _lbl = document.createElement('span');
            _lbl.style.cssText = 'font-style:italic;opacity:0.7;';
            _lbl.textContent = 'Paused mid-task';
            _stall.appendChild(_lbl);
            const _cont = document.createElement('button');
            _cont.className = 'continue-btn agent-continue-btn';
            _cont.title = 'Continue — pick up where it left off';
            _cont.textContent = '▸';
            _cont.addEventListener('click', () => {
              _stall.remove();
              handleChatSubmit(null, 'Continue — you stopped before finishing. Pick up exactly where you left off and complete the task.');
            });
            _stall.appendChild(_cont);
            (holder.querySelector('.body') || holder).appendChild(_stall);
          }
        } catch (_) {}

        // Clear streaming minHeight lock
        const _streamContent = roundHolder.querySelector('.stream-content');
        if (_streamContent) _streamContent.style.minHeight = '';

        if (_turnCoalesced) {
          // #829 turn-coalescing: the whole turn is ONE growing bubble of stacked frozen segments
          // (each committed at its agent_step). COMMIT ONLY the FINAL round's segment — the legacy
          // finalize below re-renders the whole `.body`, which would CLOBBER the earlier rounds'
          // frozen segments. Reasoning stays in each segment's own `.thinking-section` accordion.
          _commitRoundSegment();
          const _cf = roundHolder.querySelector('.body');
          // A trailing pure-tool round hides nothing (its empty segment is just dropped); if a
          // pure-tool round HAD hidden the bubble but earlier rounds left content, re-show the one
          // bubble so its accumulated narration stays visible.
          if (roundHolder.style.display === 'none'
              && _cf && _cf.querySelector('.round-seg, .stream-content, .thinking-section')) {
            roundHolder.style.display = '';
          }
          // Sources / findings attach to the ONE turn bubble (`_cf`), UNCONDITIONALLY and AFTER
          // the final-segment commit — so they SURVIVE an empty final round (a tail round that
          // called a tool and rendered no prose still drops its own segment, but the turn's
          // web_sources/research_sources/findings must NOT be lost with it). They ride the bubble,
          // not the dropped final segment. RAG is handled uniformly further below for both paths.
          if (_cf && _sourcesData) {
            const _cfWasExpanded = _sourcesExpanded || !!_cf.querySelector('.sources-content.expanded');
            const _cfSrc = document.createElement('div');
            _cfSrc.innerHTML = _buildSourcesBox(_sourcesData, _sourcesType, _cfWasExpanded);
            _cf.insertBefore(_cfSrc.firstChild || _cfSrc, _cf.firstChild);
          }
          if (_cf && _findingsData) _cf.insertAdjacentHTML('beforeend', chatRenderer.buildFindingsBox(_findingsData));
        } else if (_realignedBodyRendered) {
          // S2a realignment (#1664): the realign_body handler ALREADY rendered this bubble's corrected
          // (excised) body WITH the Thinking accordion rebuilt. Re-rendering here from the reply-only
          // roundReplyText would drop that accordion — so SKIP the body render (everything else in
          // finalize, incl. dataset.raw + RAG below, still runs). In-game realign turns carry no
          // web sources/findings, so nothing else is owed here.
        } else {
        // Finalize the last round's bubble — flatten stream-content wrapper for clean DOM.
        // F8: finalize the BODY from the reply-only buffer; reasoning lives in the accordion
        // already, so no extraction is needed (the old garbled-<think>/prefix dance is gone).
        const finalDisplay = stripToolBlocks(roundReplyText);
        // #828: re-run the SAME wrap classification the reload path (chatRenderer.addMessage)
        // applies, on the FINAL settled text, and feed the marker-stripped result into the
        // renders below — otherwise this settle would re-derive HTML from the raw `((...))`
        // text and stack processWithThinking's inner `.ooc-producer-aside` div on top of the
        // wrap-level `.msg-ooc-producer` styling, a double treatment reload never produces.
        const _finalOoc = chatRenderer.applyOocClass(roundHolder, finalDisplay.trim(), 'assistant');
        const finalDisplayText = _finalOoc.text;
        if (finalDisplay.trim()) {
          var _body4 = roundHolder.querySelector('.body');
          // Preserve sources expanded state before final render
          var _wasExpanded = _sourcesExpanded || !!(_body4 && _body4.querySelector('.sources-content.expanded'));

          // If thinking was collapsed in-place during streaming, a reply container exists.
          var _liveReplyEl = _body4 && _body4.querySelector('.live-reply-content');
          var _finalReply = _liveReplyEl ? finalDisplayText.trim() : '';
          if (_liveReplyEl && _finalReply) {
            // Render reply into the live-reply container (thinking bar already showing).
            // #762: the live thinking accordion is ALREADY in the DOM (its own caret).
            // If the reply buffer still carries a leftover inline <think> block,
            // processWithThinking would emit a SECOND accordion here — two stacked
            // thinking bars with two carets (different size/orientation). Drop any
            // leftover think block from the reply BEFORE rendering so exactly one
            // accordion (the live one above) remains; the caret is single + neutral.
            var _replySrc = _finalReply;
            if (/<think/i.test(_replySrc)) {
              _replySrc = (markdownModule.extractThinkingBlocks(_replySrc).content || '').trim();
            }
            // GAME BUILD: route through processWithThinking so the L6b reply-scrub runs —
            // the public bubble must never carry a reasoning preamble that bled into the
            // reply text (the thinking accordion already holds the reasoning separately).
            var _replyHtml = isGameBuild()
              ? markdownModule.processWithThinking(markdownModule.squashOutsideCode(_replySrc))
              : markdownModule.mdToHtml(markdownModule.squashOutsideCode(_replySrc));
            _liveReplyEl.innerHTML = _replyHtml;
            _liveReplyEl.classList.remove('live-reply-content');
            if (_sourcesData) {
              var _srcEl = document.createElement('div');
              _srcEl.innerHTML = _buildSourcesBox(_sourcesData, _sourcesType, _wasExpanded);
              _body4.insertBefore(_srcEl.firstChild || _srcEl, _body4.firstChild);
            }
            if (_findingsData) _body4.insertAdjacentHTML('beforeend', chatRenderer.buildFindingsBox(_findingsData));
          } else {
            // Full re-render (reply empty or no live-reply container)
            _body4.innerHTML = (_sourcesData ? _buildSourcesBox(_sourcesData, _sourcesType, _wasExpanded) : '')
              + markdownModule.processWithThinking(markdownModule.squashOutsideCode(finalDisplayText))
              + (_findingsData ? chatRenderer.buildFindingsBox(_findingsData) : '');
          }
        } else if (_sourcesHtml) {
          var _body4b = roundHolder.querySelector('.body');
          var _wasExpanded2 = _sourcesExpanded || !!(_body4b && _body4b.querySelector('.sources-content.expanded'));
          _body4b.innerHTML = _sourcesData ? _buildSourcesBox(_sourcesData, _sourcesType, _wasExpanded2) : _sourcesHtml;
        } else if (roundHolder !== holder) {
          // Check if there's thinking content worth showing
          const _thinkingOnly = markdownModule.extractThinkingBlocks(roundText);
          if (_thinkingOnly.thinkingBlocks?.length && !_thinkingOnly.content) {
            // Show thinking in a collapsed section even if no visible reply text
            const _body4c = roundHolder.querySelector('.body');
            if (_body4c) _body4c.innerHTML = markdownModule.processWithThinking(roundText);
          } else {
            roundHolder.style.display = 'none';
            // Thread above expected a bubble below — remove has-bottom since bubble is hidden
            const _lastThread = roundHolder.previousElementSibling;
            if (_lastThread && _lastThread.classList.contains('agent-thread')) {
              _lastThread.classList.remove('has-bottom');
            }
          }
        }
        }  // #829: end of the !_turnCoalesced legacy finalize branch


        if (window.hljs) {
          roundHolder.querySelectorAll('pre code').forEach((block) => {
            window.hljs.highlightElement(block);
          });
        }
        if (markdownModule.renderMermaid) markdownModule.renderMermaid(roundHolder);

        uiModule.scrollHistory();
        // Render RAG sources if present
        if (holder._ragSources && holder._ragSources.length) {
          const details = document.createElement('details');
          details.className = 'rag-sources';
          const summary = document.createElement('summary');
          summary.textContent = `Sources (${holder._ragSources.length} documents)`;
          details.appendChild(summary);
          holder._ragSources.forEach(src => {
            const item = document.createElement('div');
            item.className = 'rag-source-item';
            const _esc = uiModule.esc;
            item.innerHTML = `<strong>${_esc(src.filename)}</strong> <span class="rag-similarity">${(src.similarity * 100).toFixed(1)}%</span><div class="rag-snippet">${_esc(src.snippet)}</div>`;
            details.appendChild(item);
          });
          holder.querySelector('.body').appendChild(details);
        }

        // Hide first bubble if it has no visible text content (e.g. agent went straight to tools)
        if (holder !== roundHolder && holder.style.display !== 'none') {
          const _hBody = holder.querySelector('.body');
          const _hText = _hBody ? _hBody.textContent.trim() : '';
          if (!_hText) holder.style.display = 'none';
        }

        // Attach footer to the last visible bubble (roundHolder for multi-round agent, holder for single)
        const footerTarget = (roundHolder && roundHolder !== holder && roundHolder.style.display !== 'none') ? roundHolder : holder;
        footerTarget.appendChild(createMsgFooter(footerTarget));

        // F-A11Y-1: announce the COMPLETED reply ONCE for screen readers, at the SETTLED render
        // point. The transcript log is aria-live="off" (it streams token-by-token and would
        // otherwise flood AT with fragments). Announce against footerTarget — the SAME
        // last-visible-bubble resolution the footer uses — so a tool-only trailing round (empty
        // roundHolder) still announces the earlier round's real narration, not an empty bubble.
        // window.orwellAnnounce (js/a11y.js) reads the painted public reply and strips the reasoning
        // accordion, so reasoning is never spoken, into the dedicated #a11y-announcer polite region.
        // Fail-soft: absent helper ⇒ no-op.
        try { if (window.orwellAnnounce) window.orwellAnnounce(footerTarget); } catch (_e) {}
        // Capture any checklist this message produced as the current plan — both
        // the initial proposal AND restated progress during execution. Keeps the
        // stored plan (and the docked plan window) in sync with the latest state.
        if (accumulated && _CHECKLIST_RE.test(accumulated)) {
          _setStoredPlan(accumulated);
        }
        // Plan mode: the agent has proposed a plan — offer to approve & execute it.
        // Approving re-sends with plan_mode suppressed (full tools) for one turn.
        if (planTurn && accumulated.trim()) {
          const _planText = accumulated;
          const _runApproved = () => {
            _approveWrap.remove();
            _forcePlanOff = true;
            // Persist the approved plan for THIS chat so it's (a) re-sent and
            // pinned in context every execution turn, and (b) re-openable via the
            // plan-button menu. Do this BEFORE flipping the toggle, since the menu
            // intercept keys off a stored plan existing.
            _setStoredPlan(_planText);
            // Approving exits plan mode for good — turn it OFF directly (NOT via
            // the button's click, which would now open the plan menu instead of
            // toggling) so execution and every follow-up keep full write tools.
            try { if (window._setPlanMode) window._setPlanMode(false); } catch (_) {}
            // Show a clean bubble ("Approved the plan."); the full instruction goes to the model via the
            // headless override (no composer puppeteering).
            chatState._displayOverride = 'Approved the plan.';
            handleChatSubmit(null, 'Approved — execute the plan. The full approved checklist is pinned '
              + 'for you under "## ACTIVE PLAN"; do NOT go looking for it in tasks, notes, or '
              + 'memory. Work through it in order, and after each step call the update_plan tool '
              + 'with the full checklist and that step marked `- [x]`. Do the next unchecked item '
              + 'until all are done.');
          };
          var _approveWrap = document.createElement('div');
          _approveWrap.className = 'plan-approve-bar';
          const _approveBtn = document.createElement('button');
          _approveBtn.type = 'button';
          _approveBtn.className = 'plan-approve-btn';
          _approveBtn.textContent = 'Approve & Run';
          _approveBtn.addEventListener('click', _runApproved);
          // Open the plan in a draggable, side-dockable window (reuses the
          // shared modal framework). Approving from the window runs it too.
          const _openBtn = document.createElement('button');
          _openBtn.type = 'button';
          _openBtn.className = 'plan-open-btn';
          _openBtn.textContent = 'Open in window';
          _openBtn.addEventListener('click', () => {
            planWindowModule.openPlanWindow(_planText, _runApproved);
          });
          _approveWrap.appendChild(_approveBtn);
          _approveWrap.appendChild(_openBtn);
          footerTarget.appendChild(_approveWrap);
        }
        // Add "View Report" link for completed research
        if (chatState._researchingStreamIds.has(streamSessionId)) {
          _appendViewReportLink(footerTarget, streamSessionId);
        }
        // FEDEEP-2: the copy-cache and every TTS read-aloud path below consume the MERGED stream
        // buffer (`accumulated`), not the already-scrubbed rendered bubble — scrub it once here so
        // neither the cache nor anything spoken aloud can leak reasoning/machinery that bled into
        // plain content. No-op outside the game build (see scrubMachineryForPersistence).
        const _accumulatedForPersistence = markdownModule.scrubMachineryForPersistence(accumulated);
        // Also store raw on the footer target so copy/TTS work
        if (footerTarget !== holder) footerTarget.dataset.raw = _accumulatedForPersistence;
        if (addAITTSButton && accumulated && window.aiTTSManager?._provider !== 'disabled' && window.aiTTSManager?.available) {
          addAITTSButton(footerTarget, _accumulatedForPersistence);
        }
        // TTS auto-play: streaming mode flushes remaining text, non-streaming enqueues full message
        if (accumulated && window.aiTTSManager && window.aiTTSManager.autoPlay) {
          const ttsBtn = holder.querySelector('.ai-tts-button');
          if (ttsBtn) {
            var ICON_PLAY_TTS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>';
            var ICON_STOP_TTS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
            const resetFn = () => {
              ttsBtn.innerHTML = ICON_PLAY_TTS;
              ttsBtn.classList.remove('playing', 'loading');
              ttsBtn.style.color = '#6b7280';
              ttsBtn.title = 'Read aloud';
            };
            if (streamingTTS) {
              // Flush remaining partial sentence and attach the real button
              window.aiTTSManager.streamingEnd(_accumulatedForPersistence);
              window.aiTTSManager.streamingAttachButton(ttsBtn, resetFn);
              // If still playing sentences from the stream, show stop icon
              if (window.aiTTSManager.isPlaying || window.aiTTSManager._processing) {
                ttsBtn.innerHTML = ICON_STOP_TTS;
                ttsBtn.classList.add('playing');
                ttsBtn.style.color = '#ccc';
                ttsBtn.title = 'Stop';
              }
            } else {
              // Non-streaming fallback (autoPlay toggled mid-stream, etc.)
              window.aiTTSManager.enqueue(_accumulatedForPersistence, ttsBtn, resetFn);
            }
          }
        }
        if (metrics) {
          displayMetrics(footerTarget, metrics);
        }
        // Attach variant navigation if this was a regeneration
        _attachVariantNav(footerTarget);

        // Merge with previous stopped message if this was a continue
        if (chatState._pendingContinue) {
          const prevEl = chatState._pendingContinue;
          chatState._pendingContinue = null;
          const prevBody = prevEl.querySelector('.body');
          const newBody = footerTarget.querySelector('.body');
          if (prevBody && newBody && prevEl.parentNode) {
            // Merge: combine raw text with *(continued)* marker
            const oldRaw = prevEl.dataset.raw || '';
            const newRaw = footerTarget.dataset.raw || '';
            const mergedRaw = oldRaw + '\n\n*(continued)*\n\n' + newRaw;
            prevEl.dataset.raw = mergedRaw;
            // Re-render merged content
            prevBody.innerHTML = markdownModule.processWithThinking(
              markdownModule.squashOutsideCode(mergedRaw)
            );
            // Remove the new bubble and re-add footer to the merged one
            footerTarget.remove();
            const oldFooter = prevEl.querySelector('.msg-footer');
            if (oldFooter) oldFooter.remove();
            prevEl.appendChild(createMsgFooter(prevEl));
            if (window.hljs) {
              prevEl.querySelectorAll('pre code').forEach(block => window.hljs.highlightElement(block));
            }

            // Persist merge to server
            const sid = sessionModule.getCurrentSessionId();
            if (sid) {
              fetch(`${API_BASE}/api/session/${sid}/merge-last-assistant`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ separator: '\n\n*(continued)*\n\n' })
              }).catch(e => console.warn('merge-last-assistant failed:', e));
            }
          }
        }

        // BUG 2 (#985 P2-B) — the CLEAN-EMPTY-TURN terminal state. A [DONE] arrived with NO assistant
        // content (`accumulated === ''`), the server persisted nothing (`!_sawMessageSaved`, because its
        // `if full_response:` save is skipped when the final round only made a tool call), and the turn
        // produced no other visible artifact (no image / ask_user / budget / error). Pre-fix this hid the
        // empty bubble (the "no visible text" branch above) and NEVER offered recourse — the catch-based
        // _tryAutoRecover only fires on a THROWN error, and a clean [DONE] throws nothing. So the user's
        // message sat unanswered with no way forward. Render the SAME user-controlled Retry the
        // network-drop path builds (distinct copy: "no response" rather than "connection dropped"). Guard
        // against the user-cancel path (handled by the abort branch) and the continue/auto-recover path.
        const _turnWasCancelled = !!(chatState.currentAbort && chatState.currentAbort.signal && chatState.currentAbort.signal.aborted);
        // Guard: only when the holder is still IN the DOM. A continue-merge above can remove `holder`
        // (folding it into the prior bubble); rendering Retry into a detached node would be invisible.
        if (holder && holder.parentNode &&
            _isEmptyTurnNoSave({
              sawDone: _streamSawDone,
              sawSave: _sawMessageSaved,
              producedVisible: _producedVisibleOutput,
              accumulated,
              cancelled: _turnWasCancelled,
            })) {
          _renderStreamDropRetry(holder, streamSessionId, {
            label: "The narrator didn't respond. Your message was received — retry to continue.",
          });
        }

        // CASTING-RESUME-HANG Fix 3 — the reasoning-only casting hang (distinct from _isEmptyTurnNoSave
        // above: THERE `accumulated` is blank; HERE the model streamed a long thinking trace so
        // `accumulated` is NON-blank but the VISIBLE reply is empty). No truncation/interruption/step-limit
        // auto-continue catches a clean empty completion, so the post-photo resume interview just HANGS.
        // Fire exactly ONE bounded re-prompt (a hidden cue that only RE-ASKS the model — never engine-
        // authors content), scoped to the casting register, single-round-only (no tool node), and latched
        // so it can never loop. `roundReplyText` is the last round's reply-only buffer; gating on the
        // no-tool case makes it single-round, so it IS the whole turn's visible reply. NEEDS LIVE-MODEL
        // VERIFY (the stubbed gates never exercise a real reasoning-only completion).
        const _castingVisibleReply = stripToolBlocks(roundReplyText).trim();
        if (isGameBuild() && !isSeasonStarted() && _castingVisibleReply) {
          _castingEmptyRepromptSent = false;   // a real producer line landed — re-arm for a future hang
        }
        if (holder && holder.parentNode &&
            _isCastingEmptyReplyReprompt({
              gameBuild: isGameBuild(),
              seasonStarted: isSeasonStarted(),
              sawDone: _streamSawDone,
              cancelled: _turnWasCancelled,
              usedTools: _usedToolsThisTurn,   // turn-scoped flag — the tool rail is a SIBLING of holder, not inside it
              producedVisible: _producedVisibleOutput,
              visibleReply: _castingVisibleReply,
              // reasoning-present — derived from the DEDICATED reasoning channel `roundReasoningText`
              // (deltas with json.thinking truthy), NOT the merged `accumulated` (which carries reply
              // text + synthetic <think> delimiters, so `<think></think>` would falsely read as
              // reasoning). Keeps the reply/reasoning channel split intact (hard coding guideline —
              // never infer reasoning from the merged buffer) and gates the re-prompt on a REAL
              // thinking trace, so the reasoning-only hang self-recovers while a genuinely silent turn
              // stays on the clean-empty Retry path (review #1595).
              hadReasoning: !!(roundReasoningText && roundReasoningText.trim()),
              alreadyReprompted: _castingEmptyRepromptSent,
            })) {
          _castingEmptyRepromptSent = true;    // hard loop-guard: at most ONE auto re-prompt per streak
          const _repromptSid = streamSessionId;
          // Defer so this turn's `finally` (isStreaming / _sendInFlight / holder cleanup) settles first —
          // exactly as _tryAutoRecover defers its headless send. Drop it if the player has since switched
          // chats. Headless + hideUserBubble so the cue is never a visible player line.
          setTimeout(() => {
            try {
              if (_repromptSid && sessionModule.getCurrentSessionId() !== _repromptSid) return;
              handleChatSubmit(null, _CASTING_EMPTY_REPROMPT, { hideUserBubble: true });
            } catch (_) {}
          }, 50);
        }

        // #1785 (F8) — minimum-viable-turn gate: if the visible reply is below threshold or
        // dangling-markdown, re-trigger silently (headless, single bounded retry). Distinct from
        // the siblings above: the reply HAS content but it's degenerate (bare "The", unclosed **).
        _gateAndRetryBelowThresholdTurn({
          holder,
          streamSessionId,
          sawDone: _streamSawDone,
          cancelled: _turnWasCancelled,
          usedTools: _usedToolsThisTurn,
          producedVisible: _producedVisibleOutput,
          visibleReply: _castingVisibleReply,
        });
      } // end if (!_isBgFinal)

    } catch (err) {
      _renderStream();
      // Clean up any active spinner (e.g. "Generating response" during tool calls)
      if (spinner && spinner.element) spinner.destroy();
      _cancelThinkingTimer();
      _removeThinkingSpinner();
      document.querySelectorAll('.agent-thread.streaming').forEach(t => t.classList.remove('streaming'));
      // Check if this stream was running in background
      const _isBgCatch = (sessionModule.getCurrentSessionId() !== streamSessionId) || chatState._backgroundStreams.has(streamSessionId);

      if (_isBgCatch) {
        // Error happened while backgrounded — update map, don't touch DOM
        console.error('Background stream error:', err);
        var bgErr = chatState._backgroundStreams.get(streamSessionId);
        if (bgErr && bgErr.status === 'completed') {
          // [DONE] was already processed — this error is benign (e.g. reader.read() after close)
          // Don't override the completed status; just ensure the completed dot stays
          if (sessionModule && sessionModule.clearStreaming) {
            sessionModule.clearStreaming(streamSessionId);
          }
        } else if (bgErr) {
          bgErr.status = 'error';
          if (sessionModule && sessionModule.clearStreaming) {
            sessionModule.clearStreaming(streamSessionId);
          }
        }
      } else {
        // Stop streaming TTS on any error/abort
        if (streamingTTS && window.aiTTSManager) window.aiTTSManager.stop();

        if (chatState.currentAbort && chatState.currentAbort.signal.aborted) {
          const abortReason = chatState.currentAbort._reason || '';
          // Timeout-triggered aborts should remain visible instead of disappearing.
          if (timedOut || abortReason === 'timeout') {
            const timeoutMsg = _isAgent
              ? 'Agent response timed out. Try again, switch to a faster model, or reduce tool usage.'
              : 'Response timed out. Try again.';

            if (holder && !accumulated) {
              holder.querySelector('.body').innerHTML =
                `<div style="color: var(--color-error); font-style: italic; padding: 4px 0;">[${timeoutMsg}]</div>`;
            } else if (holder && accumulated) {
              const timeoutNote = document.createElement('div');
              timeoutNote.className = 'stopped-indicator';
              timeoutNote.innerHTML =
                `<span style="color: var(--color-error);">[${timeoutMsg}]</span>`;
              holder.querySelector('.body').appendChild(timeoutNote);
            }
            chatState.currentAbort = null;
            return;
          }

          if (abortReason === 'offline') {
            const offlineMsg = 'Endpoint offline — switch model or try again.';
            if (holder && !accumulated) {
              holder.querySelector('.body').innerHTML =
                `<div style="color: var(--color-error); font-style: italic; padding: 4px 0;">[${offlineMsg}]</div>`;
            } else if (holder && accumulated) {
              const offlineNote = document.createElement('div');
              offlineNote.className = 'stopped-indicator';
              offlineNote.innerHTML =
                `<span style="color: var(--color-error);">[${offlineMsg}]</span>`;
              holder.querySelector('.body').appendChild(offlineNote);
            }
            chatState.currentAbort = null;
            return;
          }

          if (abortReason === 'recovery') {
            const recoveryMsg = 'Streaming was interrupted after the tab went inactive. Partial output was preserved.';
            if (holder && !accumulated) {
              holder.querySelector('.body').innerHTML =
                `<div style="color: var(--color-error); font-style: italic; padding: 4px 0;">[${recoveryMsg}]</div>`;
            } else if (holder && accumulated) {
              const recoveryNote = document.createElement('div');
              recoveryNote.className = 'stopped-indicator';
              recoveryNote.innerHTML =
                `<span style="color: var(--color-error);">[${recoveryMsg}]</span>`;
              holder.querySelector('.body').appendChild(recoveryNote);
            }
            chatState.currentAbort = null;
            return;
          }

          // User-initiated stop (or browser navigation abort).
          // CodeRabbit fix: mark the turn as intentionally cancelled BEFORE the finally block runs,
          // so the premiere-recovery safety net (below) never auto-refires a hidden continuation the
          // player explicitly stopped (or that a closing/navigating tab can no longer show anyway).
          _orwellUserStoppedThisTurn = true;
          // Stopped before any text arrived — keep the bubble as a
          // "Cancelled by user" record (so it survives a refresh).
          if (holder && !accumulated) {
            _renderCancelledBubble(holder);
          }

          // But just in case the stop button didn't render it, render it here
          if (holder && accumulated && !currentHolder) {
            // FEDEEP-2: scrub the cached raw copy the same way as the natural-completion path.
            holder.dataset.raw = markdownModule.scrubMachineryForPersistence(accumulated);
            holder.querySelector('.body').innerHTML = markdownModule.processWithThinking(
              markdownModule.squashOutsideCode(accumulated)
            );

            if (window.hljs) {
              holder.querySelectorAll('pre code').forEach((block) => {
                window.hljs.highlightElement(block);
              });
            }

            const stoppedIndicator = document.createElement('div');
            stoppedIndicator.className = 'stopped-indicator';
            const stoppedLabel = document.createElement('span');
            stoppedLabel.textContent = '[Message interrupted]';
            stoppedIndicator.appendChild(stoppedLabel);
            const continueBtn = document.createElement('button');
            continueBtn.className = 'continue-btn';
            continueBtn.title = 'Continue';
            continueBtn.textContent = '\u25B8';
            continueBtn.addEventListener('click', () => {
              stoppedIndicator.remove();
              chatState._hideUserBubble = true;
              chatState._pendingContinue = holder;
              const cutoff = accumulated;
              handleChatSubmit(null, 'Your previous response was interrupted. It ended with:\n\n' + cutoff.slice(-500) + '\n\nDo NOT repeat what you already said. Continue exactly from where you were cut off.');
            });
            stoppedIndicator.appendChild(continueBtn);
            holder.querySelector('.body').appendChild(stoppedIndicator);

            // Tell server to mark this message as stopped
            const _sid2 = sessionModule.getCurrentSessionId();
            if (_sid2) fetch(`${API_BASE}/api/session/${_sid2}/mark-stopped`, { method: 'POST' }).catch(e => console.warn('mark-stopped failed:', e));

            if (!holder.querySelector('.msg-footer')) {
              holder.appendChild(createMsgFooter(holder));
            }

            uiModule.scrollHistory();
          }

          // Now clear the abort controller
          chatState.currentAbort = null;
        } else {
          console.error(err);
          // Stream died with a tool node still spinning. Its per-node tickers
          // (_elapsedTicker 50ms / _waveInterval 100ms) are normally cleared in
          // `tool_output`, which will never arrive now — without this sweep they
          // fire forever on the orphaned node (and auto-recover compounds it per
          // nudge). Safe here: auto-recover's new send is deferred 200ms, so no
          // fresh running nodes exist yet.
          document.querySelectorAll('.agent-thread-node.running').forEach(node => {
            if (node._waveInterval) { clearInterval(node._waveInterval); node._waveInterval = null; }
            if (node._elapsedTicker) { clearInterval(node._elapsedTicker); node._elapsedTicker = null; }
            node.classList.remove('running');
          });
          // #891 P0-2 (fetch-failure classification): the turn died at the NETWORK layer before ANY
          // byte arrived (`!accumulated`) on a real player turn (`_userMsgEl` — a visible user bubble;
          // headless machinery sends re-queue nothing). Classify honestly and RE-QUEUE the message
          // into the reload-durable outbox — 'queued — offline' status, backoff + online-drain —
          // instead of burning auto-recover nudges on a dead link. `needsDedupe` re-verifies against
          // /api/history before the re-send, so a POST that DID reach the server (reader died in the
          // preamble) can never double-deliver; the detached server run's reply arrives through the
          // normal resume/reconcile machinery. Capped per item (_OUTBOX_MAX_RETRIES) — past the cap,
          // _requeueOutboxItem returns false and the existing error surface speaks.
          let _requeuedOffline = false;
          if (!accumulated && _userMsgEl && _isNetworkSendFailure(err)) {
            _requeuedOffline = _requeueOutboxItem(_clientMsgId, msg, _userMsgEl, streamSessionId);
            if (!_requeuedOffline) {
              // #891 F-A7: the network-requeue cap (_OUTBOX_MAX_RETRIES) is spent — DON'T drop to the
              // raw "Error: …" surface (which reloads away). Mark the user bubble a DURABLE 'failed'
              // delivery (persisted 'state:failed', repaints on reload) with an explicit per-bubble
              // Retry, and suppress the generic error branch below.
              _requeuedOffline = _markSendFailedById(_clientMsgId, msg, _userMsgEl, streamSessionId);
            }
            if (_requeuedOffline) {
              // The empty reply shell (spinner holder) is noise for a turn that never left the device.
              try { if (holder && holder.parentNode) holder.remove(); } catch (_) {}
            }
          }
          // F3 (concurrent-session consistency): drop-recovery must key on the ABSENCE of a
          // COMPLETION event, not on a channel close. A transport close AFTER the turn is
          // server-confirmed complete — a `[DONE]` sentinel (`_streamSawDone`), a persisted
          // `message_saved` (`_sawMessageSaved`), or a DB id already stamped on the holder (also
          // the ADR-0008 `message-added` completion broadcast the observer adopts) — is NOT an
          // incomplete turn. The reply is already produced and PERSISTED, so a persisted assistant
          // message is treated as AUTHORITATIVE completion. Recovering it re-narrates finished
          // content: a duplicate reply + a player-visible "stream dropped …" machinery leak (the
          // confirmed live-bundle symptom: `finishReason:stop`, `ok:true`, full text, yet recovery
          // fired). Skip BOTH recovery and the generic error surface so the settled live content
          // stands and the finally's reconcile adopts it. (This is the reader's own "Stream closed
          // before completion" throw when `message_saved` arrived without a trailing `[DONE]`.)
          const _serverConfirmedDone = _streamSawDone || _sawMessageSaved ||
            !!(holder && holder.dataset && holder.dataset.dbId);
          // Stream died unexpectedly — the "silently died" case. Re-engage the
          // model immediately (no wait) with a completion handshake, up to the
          // cap. Only auto-recover from connection-class failures; deterministic
          // errors (unsupported tools, 4xx/5xx, parse failures) surface right away
          // instead of burning the nudge budget on a guaranteed-to-fail retry.
          if (!_requeuedOffline && !_serverConfirmedDone &&
              !(_isRecoverableStreamErr(err) && _tryAutoRecover(holder, accumulated, streamSessionId))) {
            const errorHolder = document.querySelector('.msg-ai:last-of-type .body');
            if (errorHolder) {
              let errMsg = `Error: ${err.message}`;
              // Add hint for tool-call errors
              if (err.message && (err.message.includes('tool') || err.message.includes('auto'))) {
                errMsg += '\n\nThis model may not support tools — try switching to Chat mode.';
              }
              typewriterInto(errorHolder, errMsg);
            }
          }
        }
      }
    } finally {
      clearResponseTimeout();
      clearProcessingProbe();
      // F-5 / N-10: a finished turn must never leave a header-only assistant bubble (see isEmptyAssistantBubble).
      try { pruneEmptyAssistantBubbles(document.getElementById('chat-history')); } catch (_) {}
      // #615: a mid-stream engine-tool error (e.g. a 409 stale-beat) can throw out of the reader
      // loop with a tool node still in `.running`. `tool_output` (which normally clears that node's
      // 50ms _elapsedTicker / 100ms _waveInterval) never arrives, so the ticker fires forever on the
      // orphaned node. The catch's `else` branch sweeps it, but only on the surfaced-error path —
      // a thrown error that is caught/handled elsewhere (or any unexpected exit) skips it. Sweep
      // here unconditionally as the backstop: clearing an already-cleared ticker is a no-op, and by
      // finally-time this turn's reader has ended so any still-`.running` node is genuinely orphaned.
      try {
        document.querySelectorAll('.agent-thread-node.running').forEach(node => {
          if (node._waveInterval) { clearInterval(node._waveInterval); node._waveInterval = null; }
          if (node._elapsedTicker) { clearInterval(node._elapsedTicker); node._elapsedTicker = null; }
          node.classList.remove('running');
        });
      } catch (_) {}
      // TX-2: a background-completed stream can leave isStreaming true and the never-cancelled
      // _textPauseTimer then mounts an orphan "Thinking" spinner into the now-FOREGROUND session.
      // Cancel the pending spinner timer + sweep any spinner unconditionally here — both are
      // idempotent no-ops when nothing is pending, so this is safe on every exit path.
      try { _cancelThinkingTimer(); _removeThinkingSpinner(); } catch (_) {}
      // P1 (OOBE cutover): safety net — never leave the "finalizing" indicator stuck if the turn
      // ended (or errored) without any narration token to clear it.
      if (_orwellFinalizingActive) {
        _orwellFinalizingActive = false;
        try { if (window._orwellFinalizing) window._orwellFinalizing.end(); } catch (_) {}
      }
      // 2026-07-16 audit item 3 (premiere-opener resilience), CodeRabbit-fixed 2026-07-17: reaching
      // here armed means createCharacter finalized THIS turn (confirmed `started && !createRefused`)
      // but the stream ended (normally, on error, or dropped) without a single REPLY token ever
      // landing to clear the latch — the exact silent-death shape a live playthrough hit (llmIo:
      // ok=False, no text). Auto-refire the move-in narration through the robust cue-backoff kernel
      // #967/#969 already use, rather than leaving the player to speak first. Rides its own
      // `_orwellPremiereRecoveryArmed` latch (see declaration) rather than `_orwellFinalizingActive`
      // above, so a failed/refused creation never fires it and a reasoning-only completion still does.
      // CodeRabbit follow-up: EXCEPT when the player themselves stopped this turn (or a browser
      // navigation aborted it) — `_orwellUserStoppedThisTurn`, set in the catch block's genuine
      // user-stop branch. An intentional cancel must never enqueue a hidden continuation the player
      // never asked for; the latch is still cleared so a later, unrelated silent-death turn starts
      // from a clean slate.
      if (_orwellPremiereRecoveryArmed) {
        _orwellPremiereRecoveryArmed = false;
        if (!_orwellUserStoppedThisTurn) {
          try { if (window._orwellPremiereContinueIfSilent) window._orwellPremiereContinueIfSilent(); } catch (_) {}
        }
      }
      // Streaming done — let screen readers announce the settled response.
      const _chatLogDone = document.getElementById('chat-history');
      if (_chatLogDone) _chatLogDone.setAttribute('aria-busy', 'false');
      // Staged-comp / forced-advance fix (audit 2026-06-20): a SILENT server-side advance (the FE's
      // error-correction when the model under-calls advanceGame) progresses the engine onto a NEW
      // player pending but emits NO visible tool result — so the per-tool G15 seam above never fires
      // and the decision card never arms in the open page (pre-fix it re-armed only on a reload). Nudge
      // THE shared dispatcher at turn-end so orwellDecision's rearmFromStatus pulls gameStatus.pending
      // and arms the card. Debounced + idempotent (coalesces with any per-tool dispatch this turn);
      // a no-op outside the game build (orwellGameChanged is undefined there).
      if (window.orwellGameChanged) window.orwellGameChanged('turn-settled');
      // ADR 0008 fix (audit 2026-06-21): the foreground reader loop has ENDED, so clear _streamSessionId.
      // It was set on stream START (~L603) and previously NEVER reset, so hasActiveStream() stayed
      // permanently true for this session — which made flushPendingReconcile's softReloadHistory re-defer
      // FOREVER (the chat.js:3619 `if (hasActiveStream(sessionId))` guard). Net effect: a tab that had sent
      // even one turn could NEVER live-reconcile a peer's concurrent write to that session until a reload
      // (the two-tabs-streaming-concurrently residual the ADR-0008 live verification found). Guarded to
      // `=== streamSessionId` so a newer stream's session isn't cleared by a late-settling old finally;
      // a backgrounded stream stays covered by _backgroundStreams in hasActiveStream.
      if (chatState._streamSessionId === streamSessionId) chatState._streamSessionId = null;
      // ADR 0008: read-your-writes. The turn has persisted, so reconcile the sender's optimistic
      // bubbles to the authoritative {id, seq} log (the adopt pass is cheap + flicker-free; it only
      // rebuilds if a PEER also wrote during this turn). Was: the sender never re-fetched, so its DOM
      // was a permanent local guess that drifted from other tabs. Deferred so the finally settles first.
      // (Now that _streamSessionId is cleared above, the setTimeout(0) callback sees hasActiveStream=false
      // and the deferred reconcile actually rebuilds.)
      // ADR 0012 (GAP 2): an error turn rendered the raw model error live, but the agent loop persists
      // a friendly fallback. Force the reconcile below to do a CONTENT rebuild (not just the id adopt)
      // so the sender's settled bubble becomes the SAME persisted text a peer/reload shows. softReload
      // is async + the fallback persists right before [DONE], so it's on disk by the time this runs.
      // softReloadHistory self-guards the forced rebuild (it only fires when the server actually has an
      // assistant message to converge to) so a hard fail that persisted NOTHING keeps its live error
      // feedback — we don't need the client to have observed the message_saved event (which a same-chunk
      // error→[DONE] can skip past the break).
      if (_streamHadError) chatState._forceRebuild.add(streamSessionId);
      // ADR 0012 (GAP 1): a PEER's run-started arrived for this session while THIS stream was in
      // flight, so the observer's `!hasActiveStream` guard deferred the live attach. Our stream has
      // now settled (_streamSessionId cleared above ⇒ hasActiveStream is false), so RE-ATTEMPT the
      // attach: subscribe() replays the peer run's buffer then live-tails, mirroring its turn in
      // lockstep instead of waiting on a later poll (the transient one-window-behind ±1). CHAINED
      // after the reconcile's softReloadHistory settles, so the peer's user turn is adopted first and
      // its reply attaches on top (matching sessionSync's "rebuild lands before the live bubble"
      // ordering). flushPendingPeerResume is a no-op in the common case (no peer resume deferred).
      try {
        setTimeout(() => {
          try {
            Promise.resolve(flushPendingReconcile(streamSessionId)).then(function () {
              try { flushPendingPeerResume(streamSessionId); } catch (_) {}
            });
          } catch (_) {}
        }, 0);
      } catch (_) {}
      // D2 clean up per-stream event counter so the next stream starts from 0.
      try { delete chatState._sseEventCount[streamSessionId]; } catch (_) {}
      // ADR 0012 §2.4: a loser-of-the-bind window POSTed under its own per-tab id but the run lived
      // under the canonical game session (server `canonical_session` event). Now that the stream has
      // settled, converge onto canonical so this window's history/SSE/HUD re-key onto the shared game
      // (a mid-stream selectSession would have reloaded history out from under the live bubble). Only
      // when we're actually on a different id, so it's a no-op for the already-converged common case.
      if (_adoptCanonicalAfterStream &&
          sessionModule.getCurrentSessionId &&
          sessionModule.getCurrentSessionId() !== _adoptCanonicalAfterStream) {
        try { setTimeout(() => { try { sessionModule.selectSession(_adoptCanonicalAfterStream, { keepSidebar: true }); } catch (_) {} }, 0); } catch (_) {}
      }
      // Always clean up research tracking regardless of background state
      chatState._researchingStreamIds.delete(streamSessionId);
      if (chatState._researchingStreamIds.size === 0) {
        var _rToggleCleanup = document.getElementById('research-toggle-btn');
        if (_rToggleCleanup) _rToggleCleanup.classList.remove('research-running');
      }

      // Only reset UI state if still on the stream's session and was never backgrounded
      const _isBgFinally = (sessionModule.getCurrentSessionId() !== streamSessionId) || chatState._backgroundStreams.has(streamSessionId);

      if (!_isBgFinally) {
        // Reset button to idle state
        updateSubmitButton('idle', submitBtn);

        // Re-enable message input; on mobile blur to dismiss keyboard.
        // J4-01: if a decision card is showing, focus it instead of the composer —
        // the post-stream cleanup must not steal focus from a binding decision the
        // player needs to act on. The composer is re-focused when the card is
        // confirmed or dismissed (the confirm handler calls box.focus()).
        if (messageInput) {
          messageInput.disabled = false;
          if (isNarrow()) {
            messageInput.blur();
          } else {
            var _pendingCard = document.getElementById('orwell-decision-card');
            if (_pendingCard) {
              try { _pendingCard.focus(); } catch (_) {}
            } else {
              messageInput.focus();
            }
          }
        }

        // Clear tracking variables
        currentAccumulated = '';
        currentHolder = null;
        currentSpinner = null;
        chatState._researchingStreamIds.delete(streamSessionId);
        // Clear research-running highlight if no more active research
        if (chatState._researchingStreamIds.size === 0) {
          var _rToggle2 = document.getElementById('research-toggle-btn');
          if (_rToggle2) _rToggle2.classList.remove('research-running');
        }
        _clearResearchTimer();

        // Re-enable research button and auto-untoggle after use
        // (skip if clarification round — keep toggle on for follow-up)
        const _el = uiModule.el;
        const _researchBtn = _el('research-toggle-btn');
        const _researchToggle = _el('research-toggle');
        if (_researchToggle && _researchToggle.checked) {
          _researchToggle.checked = false;
          Storage.setToggle('research', false);
        }
        if (_researchBtn) {
          _researchBtn.disabled = false;
          _researchBtn.classList.remove('active');
          _researchBtn.style.display = 'none';
        }
        // Also sync overflow and tool sidebar buttons
        const _overflowRes = _el('overflow-research-btn');
        if (_overflowRes) _overflowRes.classList.remove('active');
        const _toolRes = _el('tool-research-btn');
        if (_toolRes) _toolRes.classList.remove('active');

        // #985 P2-A: the turn has settled and `updateSubmitButton('idle')` above cleared `isStreaming`,
        // so DRAIN the next queued send (FIFO, one at a time). Deferred past this finally so the reconcile
        // / peer-resume chains settle first and the flushed send re-enters cleanly. A no-op when empty.
        try { setTimeout(() => { try { _flushSendOutbox(); } catch (_) {} }, 0); } catch (_) {}
      } else {
        // #971 — the turn settled while BACKGROUNDED, so the idle reset above was skipped and the button
        // (and the `isStreaming` flag) can be stranded on Stop for whatever session is now in the
        // foreground. Reconcile it to the true state: if this window is in fact looking at the settled
        // session, the button repairs to Send/upload-file; a still-live foreground stream is untouched.
        // Deferred so any selectSession/reconcile racing this finally settles first.
        try { setTimeout(() => { try { _syncSubmitButtonState(); } catch (_) {} }, 0); } catch (_) {}
      }

      // Research clarification timeout — if user doesn't reply within 5 min, show timeout
      if (holder && holder._roleSuffix === 'Research' && !chatState._researchingStreamIds.has(streamSessionId)) {
        var _timeoutSessionId = streamSessionId;
        var _timeoutTimer = setTimeout(async function() {
          // Check if research_pending is still active (user hasn't replied)
          try {
            var _box = document.getElementById('chat-history');
            if (_box && sessionModule.getCurrentSessionId() === _timeoutSessionId) {
              var _timeoutMsg = document.createElement('div');
              _timeoutMsg.className = 'msg msg-ai';
              _timeoutMsg.innerHTML = '<div class="role">Orwell</div><div class="body" style="opacity:0.6;font-style:italic;">Research clarification timed out. Toggle research again to start over.</div>';
              _box.appendChild(_timeoutMsg);
              uiModule.scrollHistory();
            }
          } catch(_te) {}
        }, 5 * 60 * 1000);
        // Cancel timeout if user sends a message
        var _origSubmit = window._researchTimeoutTimer;
        if (_origSubmit) clearTimeout(_origSubmit);
        window._researchTimeoutTimer = _timeoutTimer;
      }

      // Release Web Lock
      if (_webLockRelease) {
        _webLockRelease();
        _webLockRelease = null;
      }

      // Refresh session list after a delay (picks up auto-generated names)
      setTimeout(() => {
        if (sessionModule && sessionModule.loadSessions) {
          sessionModule.loadSessions();
        }
      }, 3000);
    }
  }

  // ── #985 P2-A / #891 / #830: SEND OUTBOX — the subsystem moved to chatOutbox.js (#1414 R3 PR6). ──
  // The enqueue / paint / persist / restore / confirm / requeue / dedupe / delivery-state / fold /
  // flush / aggregate-strip helpers + the boot-restore durability wiring (online/offline/pageshow)
  // now live in chatOutbox.js; chat.js calls them from handleChatSubmit (enqueue / offline-send /
  // network-requeue / mark-failed), the stream-settle finally (_flushSendOutbox), and the adopt pass
  // (_outboxConfirmDelivery) via the imports above — the dispatch stays the SOLE handleChatSubmit.

  /**
   * Abort current chat request
   */
  // stopServer=true ONLY for an explicit user Stop. The run is now DETACHED
  // (survives tab close / navigation), so the generic abort used by cleanup
  // paths (session switch, delete, reader teardown on tab close) must NOT stop
  // the server run — otherwise closing the tab would kill the background task,
  // defeating the whole point. Only the Stop button cancels the server run.
  export function abortCurrentRequest(stopServer = false) {
    if (chatState.currentAbort) {
      chatState.currentAbort.abort();
      // Don't set to null here - let catch block handle it
    }
    if (stopServer) {
      try {
        const _sid = chatState._streamSessionId
          || (window.sessionModule && window.sessionModule.getCurrentSessionId && window.sessionModule.getCurrentSessionId());
        if (_sid) {
          fetch(`/api/chat/stop/${encodeURIComponent(_sid)}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
        }
      } catch (_) {}
    }
  }

  /**
   * D2 — self-resume: reattach to the SAME server-buffered run after a mid-stream SSE drop,
   * painting continued tokens into the EXISTING holder (from_seq = _sseEventCount) so
   * no tokens are duplicated and no new user turn is submitted. Returns true if
   * self-resume attached, false to let the caller fall back to the old continuance path.
   */
  async function _trySelfResume(holder, accumulated, sessionId) {
    if (!sessionId || !holder || !accumulated) return false;
    const _runId = chatState._ownRunIds[sessionId];
    if (!_runId) return false;  // no known run for this session — can't self-resume

    const fromSeq = (chatState._sseEventCount && chatState._sseEventCount[sessionId]) || 0;
    let res;
    try {
      res = await fetch(`${API_BASE}/api/chat/resume/${encodeURIComponent(sessionId)}?from_seq=${fromSeq}`);
    } catch (e) {
      return false;  // network error — fall back
    }
    if (!res.ok || !res.body) return false;  // run no longer buffered — fall back

    // ── Self-resume attached — pipe into existing holder ──
    chatState._resumingStreams.add(sessionId);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let replyText = accumulated || '';
    let reasoningText = '';
    let gotDelta = false;
    let serverTs = null;
    let serverMoment = null;
    let savedDbId = null;
    let rich = false;
    let paintDirty = false;

    const bodyDiv = holder.querySelector('.body');
    const _liveState = {};
    const _liveRender = (t) => markdownModule.processWithThinking(markdownModule.squashOutsideCode(t));
    const renderDelta = () => {
      if (bodyDiv) _renderLiveStream(bodyDiv, replyText, reasoningText, _liveRender, _liveState, holder);
    };

    // Clean up any existing spinner in the holder
    try {
      const sp = bodyDiv && bodyDiv.querySelector('.spinner-container');
      if (sp) sp.remove();
    } catch (_) {}

    try {
      readLoop:
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') {
            if (paintDirty) { paintDirty = false; renderDelta(); }
            try { await reader.cancel(); } catch (_) {}
            break readLoop;
          }
          let json;
          try { json = JSON.parse(payload); } catch (_) { continue; }
          if (json.type === 'user_message') continue;  // Sender already rendered its own bubble
          if (json.delta) {
            if (json.thinking) reasoningText += json.delta;
            else replyText += json.delta;
            if (!gotDelta) { gotDelta = true; }
            paintDirty = true;
          } else if (json.type === 'message_saved') {
            if (typeof json.moment === 'string' && json.moment) serverMoment = json.moment;
            if (json.ts || serverMoment) { if (json.ts) serverTs = json.ts; _applyServerTimestamp(holder, serverTs, serverMoment); }
            if (json.id) { savedDbId = json.id; holder.dataset.dbId = json.id; }
          } else if (json.type === 'doc_stream_open' || json.type === 'doc_stream_delta') {
            rich = true;
          } else if (json.type === 'orwell_narrator') {
            // #1729 D2: match resumeStream pattern — persist season-scoped ALWAYS, gate tab-global
            // byline behind _activeNow so a background/resumed stream doesn't hijack the byline.
            if (json.name) {
              _persistNarratorForSession(sessionId, json.name);
              const _activeNow = !(sessionModule.getCurrentSessionId
                && sessionModule.getCurrentSessionId() !== sessionId);
              if (_activeNow) {
                setGameNarrator(json.name);
                _refreshLiveByline(holder);
              }
            }
          } else if (/^(tool_start|tool_output|tool_progress|agent_step|web_sources|rag_sources|research_progress|research_sources|research_findings|research_done)$/.test(json.type)) {
            rich = true;
          }
        }
        if (paintDirty) { paintDirty = false; renderDelta(); }
      }
    } catch (e) {
      // Second drop during self-resume — keep accumulated, cleanup below
    }

    chatState._resumingStreams.delete(sessionId);

    // Finalize in-place
    const onThisSession = sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId() === sessionId;
    if (onThisSession && !rich && replyText.trim() && bodyDiv) {
      bodyDiv.innerHTML = markdownModule.processWithThinking(markdownModule.squashOutsideCode(replyText));
      if (window.hljs) {
        try { bodyDiv.querySelectorAll('pre code').forEach(function(b){ window.hljs.highlightElement(b); }); } catch (_) {}
      }
      if (serverTs || serverMoment) _applyServerTimestamp(holder, serverTs, serverMoment);
      if (savedDbId) holder.dataset.dbId = savedDbId;
      holder.dataset.raw = markdownModule.scrubMachineryForPersistence(replyText);
      if (typeof createMsgFooter === 'function' && !holder.querySelector('.msg-footer')) {
        try { holder.appendChild(createMsgFooter(holder)); } catch (_) {}
      }
      try { uiModule.scrollHistory(); } catch (_) {}
      try { flushPendingReconcile(sessionId); } catch (_) {}
    } else if (onThisSession) {
      try { sessionModule.selectSession(sessionId); } catch (_) {}
    }

    return true;
  }

  // ── Stall watchdog ──────────────────────────────────────────────
  // Auto-recover a turn whose stream died (connection drop) or went silent:
  // preserve the partial, then re-submit a completion handshake by reusing the
  // existing continue/resume path. Returns false at the cap so the caller can
  // surface the failure instead of nudging forever.
  // Only auto-recover from connection-class failures (the genuine "silently
  // died" case). Deterministic errors — unsupported tools, HTTP 4xx/5xx, JSON
  // parse failures — will fail identically on retry, so surfacing them
  // immediately is both more honest and avoids wasting the nudge budget.
  function _isRecoverableStreamErr(err) {
    if (!err) return false;
    if (err.name === 'TypeError') return true;   // fetch/reader network failure
    const m = (err.message || '').toLowerCase();
    if (/\btool\b|unsupported|json|parse|\b4\d\d\b|\b5\d\d\b/.test(m)) return false;
    return /network|fetch|connection|reset|closed|aborted|stream|tim(?:e|ed)\s?out|econn|eof/.test(m);
  }

  function _tryAutoRecover(holder, accumulated, sessionId) {
    // D2: attempt self-resume FIRST when we have partial content and a known run.
    // Self-resume re-establishes the live SSE to the same server-buffered run instead of
    // submitting a new continuance turn. Fire-and-forget: _trySelfResume handles everything
    // (stream, paint, finalize) and is async — but _tryAutoRecover must return synchronously
    // (the caller gates on its return), so kick off the async work and return true immediately.
    if (accumulated && chatState._ownRunIds[sessionId]) {
      // Fire _trySelfResume asynchronously — it handles the fetch, streaming, and finalize.
      _trySelfResume(holder, accumulated, sessionId);
      return true;  // handled by self-resume attempt — caller must not render generic error
    }
    const tail = (accumulated || '').slice(-400);
    // PRODUCED NOTHING: the stream died before any token. Do NOT silently auto-resend — the old path
    // puppeteered the composer with a "stream dropped" prompt and `.send-btn.click()`, which frequently
    // stranded that text in the box (the click landed while the button was still in Stop mode). Surface
    // an honest, user-controlled Retry instead. Not gated by the auto-nudge cap (it's a human click).
    if (!tail) {
      _renderStreamDropRetry(holder, sessionId);
      return true; // handled — the caller must not also render a generic "stream closed" error
    }
    // PARTIAL TEXT: a mid-stream cut. Continuing is genuinely useful, so auto-continue ONCE — but via a
    // HEADLESS send (no composer write, no synthetic click, no stop/send race). Gated by the cap.
    if (chatState._autoNudges >= _AUTO_NUDGE_CAP) return false;
    chatState._autoNudges++;
    if (holder) {
      // FEDEEP-2: same raw-copy scrub as the natural-completion/user-stop paths.
      holder.dataset.raw = markdownModule.scrubMachineryForPersistence(accumulated);
      try {
        holder.querySelector('.body').innerHTML =
          markdownModule.processWithThinking(markdownModule.squashOutsideCode(accumulated));
      } catch (_) {}
    }
    const prompt = `The stream dropped before you finished. It ended with:\n\n${tail}\n\nIf the task is fully complete, reply with just: DONE. Otherwise continue exactly where you left off and finish it — do not repeat what you already wrote.`;
    // Defer so the dead stream's `finally` (currentAbort / isStreaming / holder cleanup) runs first.
    setTimeout(() => {
      if (sessionId && sessionModule.getCurrentSessionId() !== sessionId) return; // wrong chat now — drop it
      handleChatSubmit(null, prompt, { hideUserBubble: true, pendingContinue: holder, autoContinue: true });
    }, 50);
    return true;
  }

  // A visible, user-controlled retry for a stream that died before producing anything — the honest
  // replacement for the old composer-puppeteering auto-resend. The Retry button does a HEADLESS send
  // (the user's original message is already persisted server-side, so this just re-engages the model).
  // BUG 2 (#985 P2-B): the SAME control also serves the clean-empty-turn terminal state (a [DONE] with
  // no narration + no save) — passing `opts.label` swaps the message; the Retry mechanism is identical.
  function _renderStreamDropRetry(holder, sessionId, opts) {
    opts = opts || {};
    const target = holder && (holder.querySelector('.body') || holder);
    if (!target || target.querySelector('.stream-drop-retry')) return;
    // BUG 2: the empty-turn holder was hidden by the finalize ("no visible text" branch) — make it
    // visible again so the Retry control the player needs is actually on screen.
    if (holder && holder.style && holder.style.display === 'none') holder.style.display = '';
    const note = document.createElement('div');
    note.className = 'stream-drop-retry';
    note.style.cssText = 'display:flex;align-items:center;gap:8px;opacity:0.85;font-style:italic;';
    const label = document.createElement('span');
    label.textContent = opts.label || 'Connection dropped before any reply.';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'continue-btn';
    btn.textContent = 'Retry';
    btn.addEventListener('click', () => {
      if (sessionId && sessionModule.getCurrentSessionId() !== sessionId) return; // wrong chat now
      note.remove();
      handleChatSubmit(null, "Your previous reply didn't come through — please answer my last message.",
        { hideUserBubble: true, pendingContinue: holder });
    });
    note.appendChild(label);
    note.appendChild(btn);
    target.appendChild(note);
  }

  // (Removed FEJS-6: the dead stall-banner machinery + the deliberately-disabled
  // _startStallWatchdog/_stopStallWatchdog. The server-side stall detector +
  // auto-continue loop-breaker supersede the old "still working?" banner; see
  // CLAUDE.md "Front-end client conventions".)

  /** Show a "Cancelled by user" record in `holder` for THIS tab's live view only.
   *
   *  #1728 (D1/T2) — cancel = discard: a generation cancelled before any tokens streamed must
   *  NOT persist a durable assistant row. This used to `inject_messages` an empty
   *  `{stopped:true, cancelled:true}` placeholder "so the turn survives a refresh" — which is
   *  exactly the bug (a fresh bundle showed TWO such zero-length rows at one timestamp). There is
   *  nothing to survive a refresh WITH: the turn produced no content, so discarding it entirely
   *  (no DB row at all) is the correct "cancel" — not persisting an empty stand-in for it. The
   *  local indicator below is purely transient UI feedback for the tab that clicked Stop. */
  function _renderCancelledBubble(holder) {
    if (!holder) return;
    holder.dataset.raw = '';
    const body = holder.querySelector('.body');
    if (body) {
      body.innerHTML = '';
      const indicator = document.createElement('div');
      indicator.className = 'stopped-indicator';
      const label = document.createElement('span');
      label.style.fontStyle = 'italic';
      label.style.opacity = '0.7';
      label.textContent = '[Cancelled by user]';
      indicator.appendChild(label);
      body.appendChild(indicator);
    }
    if (typeof createMsgFooter === 'function' && !holder.querySelector('.msg-footer')) {
      holder.appendChild(createMsgFooter(holder));
    }
  }

  /**
   * Detach current stream to run in background instead of aborting.
   * Called when user switches sessions mid-stream.
   */
  export function detachCurrentStream(sessionId) {
    if (!chatState.isStreaming || !chatState.currentAbort) {
      // Not streaming — fall through to abort
      abortCurrentRequest();
      return;
    }
    // Store background stream state
    chatState._backgroundStreams.set(sessionId, {
      status: 'running',
      accumulated: currentAccumulated,
      sourcesHtml: '',
      findingsData: null,
      abortCtrl: chatState.currentAbort,
      query: currentHolder ? (currentHolder._researchQuery || '') : '',
      metrics: null,
    });
    // Mark session with pulsing dot in sidebar
    if (sessionModule && sessionModule.markStreaming) {
      sessionModule.markStreaming(sessionId);
    }
    // Clear local state WITHOUT aborting the fetch
    chatState.currentAbort = null;
    chatState.isStreaming = false;
    currentHolder = null;
    currentAccumulated = '';
    // Reset submit button so the new chat is ready to send
    const submitBtn = document.querySelector('.send-btn');
    if (submitBtn) updateSubmitButton('idle', submitBtn);
  }

  // _notifyStreamComplete and _insertStreamDoneToast now in chatStream.js
  var _notifyStreamComplete = chatStream.notifyStreamComplete;
  var _insertStreamDoneToast = chatStream.insertStreamDoneToast;

  // #1414 (R3 PR7): the cross-device RECONCILE / seq-order / peer-resume cluster (ADR 0008/0012)
  // — _historyMsgText / _serverMsgId / _isSkippableUserPrompt / _msgSeq / _insertBySeq /
  // _reorderBySeq / _isEmptyTurnNoSave / _visibleMsgCount / _isPendingOptimisticBubble /
  // _expectedVisibleBubbleCount / softReloadHistory / flushPendingReconcile / deferPeerResume /
  // flushPendingPeerResume — moved to chatReconcile.js (imported above, re-exported on the
  // chatModule public API below byte-identically). Behavior-preserving: chat.js still drives the
  // same call points (softReloadHistory at the stream-settle + adopt sites, flushPendingReconcile /
  // flushPendingPeerResume in the stream-end finally, _isEmptyTurnNoSave in the finalize) and
  // injects the three chat.js-internal deps the cluster reads — hasActiveStream (the SSE-reader
  // liveness helper), resumeStream (the R2 live-resume attach), and a () => API_BASE resolver —
  // through _setReconcileDeps, mirroring the PR2..PR6 injection pattern. The reconcile Sets stay
  // chatState-backed (PR0), so submit / outbox / reconcile serialize on ONE instance.

  /**
   * R2 (refactor-roadmap / ADR 0012 §3.3): the SHARED incremental live-stream renderer that BOTH
   * the sender (its `.live-reply-content` path) and the observer (resumeStream) feed, so two windows
   * on one game render the LIVE stream through the SAME machinery — `createStreamRenderer` (freeze
   * finalized blocks, re-render only the growing tail, token-fade) — not a per-delta full repaint.
   * The observer used to `contentDiv.innerHTML = processWithThinking(_combined())` on EVERY delta
   * (renderDelta) — a different live engine that unmounts+remounts the whole subtree per token, the
   * two-window "scratch and grind". This unifies it.
   *
   * The reasoning CHANNEL SPLIT is sacred and preserved BY CONSTRUCTION: `replyText` (the public
   * reply) feeds the incremental renderer into `.live-reply-content`; `reasoningText` lands ONLY in a
   * default-collapsed `.thinking-section` accordion above it — reasoning can NEVER paint in the public
   * reply container. (`stripToolBlocks` keeps not-yet-finalized tool syntax out of the reply, matching
   * the sender's `_renderStream`.)
   *
   * `render` is the canonical reply renderer the CALLER supplies (the same `processWithThinking ∘
   * squashOutsideCode` shape the sender's `_renderStream` feeds `createStreamRenderer`) — so this helper
   * never invents its own markdown path; it shares the caller's. `state` is a per-stream scratch object
   * the caller owns (`{}` initially); the helper hangs the accordion refs + the reply renderer off it
   * across delta calls. Idempotent + self-contained: it only ever writes its own children of
   * `contentDiv`.
   *
   * `wrap` (#828) is the outer `.msg` bubble — passed through to `chatRenderer.applyOocClass` so the
   * OBSERVER's bubble gets the SAME `.msg-ooc`/`.msg-ooc-producer` wrap classification the sender's
   * `_renderStream` applies, live, instead of only picking it up on a later reload.
   */
  function _renderLiveStream(contentDiv, replyText, reasoningText, render, state, wrap) {
    if (!contentDiv) return;
    const reasoning = (reasoningText || '').trim();
    // 1) Reasoning → a default-COLLAPSED live accordion at the top of the content. Created lazily the
    //    first time reasoning arrives; never placed in the reply container (the channel split).
    if (reasoning) {
      if (!state._thinkSection) {
        const sec = document.createElement('div');
        sec.className = 'thinking-section';
        const domId = 'resume-think-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        // M2-7 — game build reads the reasoning accordion as diegetic "Production notes".
        const _thinkLabel = isGameBuild() ? 'Production notes' : 'View thinking process';
        sec.innerHTML =
          '<div class="thinking-header" data-thinking-id="' + domId + '">' +
            '<div class="thinking-header-left"><span class="live-think-header-text">' + _thinkLabel + '</span></div>' +
            '<span class="thinking-toggle live-think-toggle" id="' + domId + '-toggle"></span>' +
          '</div>' +
          '<div class="thinking-content" id="' + domId + '"><div class="thinking-content-inner live-think-inner"></div></div>';
        contentDiv.insertBefore(sec, contentDiv.firstChild);
        state._thinkSection = sec;
        state._thinkInner = sec.querySelector('.live-think-inner');
      }
      if (state._thinkInner) {
        const t = reasoning.replace(/^\s*Thinking(?:\s+Process)?:\s*/i, '');
        state._thinkInner.innerHTML = markdownModule.mdToHtml(t);
      }
    }
    // 2) Reply → the SHARED incremental renderer into a dedicated `.live-reply-content` child (the same
    //    container class the sender's post-thinking reply path mounts), so the gate sees both windows
    //    mount the streaming container and stream through createStreamRenderer.
    const replySrcRaw = stripToolBlocks(replyText || '');
    if (!replySrcRaw.trim()) { uiModule.scrollHistory(); return; }
    // #828: classify the OBSERVER's wrap the SAME way the sender's `_renderStream` does, so a
    // producer/OOC turn picks up `.msg-ooc`/`.msg-ooc-producer` in BOTH windows the instant it
    // streams, not only the sender's — and feed the marker-stripped text through so `render`
    // (processWithThinking) doesn't ALSO wrap it in the inner `.ooc-producer-aside` div.
    const _liveOoc = chatRenderer.applyOocClass(wrap, replySrcRaw.trim(), 'assistant');
    const replySrc = _liveOoc.text;
    let replyEl = state._replyEl;
    if (!replyEl || !replyEl.isConnected || state._replyRendererOoc !== _liveOoc.ooc) {
      if (replyEl && replyEl.isConnected) replyEl.remove();
      replyEl = document.createElement('div');
      replyEl.className = 'live-reply-content';
      contentDiv.appendChild(replyEl);
      state._replyEl = replyEl;
      state._replyRendererOoc = _liveOoc.ooc;
      state._replyRenderer = createStreamRenderer(replyEl, { render, hljs: window.hljs });
    }
    state._replyRenderer.update(replySrc);
    uiModule.scrollHistory();
  }

  /**
   * F1 (concurrent-session consistency — the causal-inversion fix): render the prompting USER bubble
   * from the run buffer's LEADING `user_message` event, so an observer/mirror window shows the cause
   * (the player's message) BEFORE the effect (the reply). The live channel carries only the assistant
   * deltas; without this the reply could paint before its user turn.
   *
   * ONE dedup key per role (F2): the user message keys on `clientMsgId` (with the db id as a backstop).
   * If a bubble with that key already exists — the SENDER's own optimistic bubble, or a bubble a prior
   * reconcile already rendered — we do NOT create a second one; we only stamp the authoritative
   * {id, seq, clientMsgId} so the settle reconcile (softReloadHistory) adopts it with ZERO churn. A
   * peer window with no such bubble renders it, inserted BEFORE the reply holder (`beforeEl`) so cause
   * precedes effect; with no holder yet it lands in seq order. Skippable production-cue / continuation
   * prompts are filtered exactly as softReloadHistory does, so the live view never flashes a cue bubble
   * the reconcile would then remove. Returns the element (new or existing), or null when nothing renders.
   */
  export function renderObserverUserMessage(ev, opts) {
    opts = opts || {};
    const box = document.getElementById('chat-history');
    if (!box || !ev) return null;
    const cid = ev.clientMsgId || (ev.metadata && ev.metadata.client_msg_id) || null;
    const dbId = (ev.id != null && ev.id !== '') ? String(ev.id) : null;
    const _attr = (v) => String(v).replace(/["\\]/g, '\\$&');
    // Dedup by role key — clientMsgId first (the user's stable optimistic id), db id as backstop.
    let existing = null;
    if (cid) existing = box.querySelector('.msg[data-client-msg-id="' + _attr(cid) + '"]');
    if (!existing && dbId) existing = box.querySelector('.msg[data-db-id="' + _attr(dbId) + '"]');
    if (existing) {
      // Adopt the authoritative {id, seq} onto the bubble that already exists (the sender's optimistic
      // send, or a peer's earlier reconcile) so it is never re-rendered and the settle adopt is a no-op.
      if (dbId) existing.dataset.dbId = dbId;
      if (ev.seq != null) existing.dataset.seq = String(ev.seq);
      if (cid) existing.dataset.clientMsgId = cid;
      // #1785: the stream OBSERVED this row — release the outbox copy immediately
      if (cid) { try { _outboxConfirmDelivery(cid); } catch (_) {} }
      return existing;
    }
    const content = typeof ev.content === 'string' ? ev.content : '';
    // Same filter softReloadHistory applies — hidden production cues / interrupt prompts never show.
    if (_isSkippableUserPrompt(content)) return null;
    const meta = { _db_id: dbId, _seq: ev.seq, client_msg_id: cid };
    const elx = chatRenderer.addMessage('user', markdownModule.renderContent(content), null, meta);
    if (!elx) return null;
    // addMessage appends to the bottom; move the bubble AHEAD of the reply holder so the observer
    // renders cause-before-effect. With no holder pinned yet, place it in authoritative seq order.
    if (opts.beforeEl && opts.beforeEl.parentNode === box && opts.beforeEl !== elx) {
      box.insertBefore(elx, opts.beforeEl);
    } else {
      _insertBySeq(box, elx);
    }
    try { uiModule.scrollHistory(); } catch (_) {}
    return elx;
  }

  /**
   * Live-resume a chat run still streaming detached on the server (#2539).
   *
   * On session re-entry, GET /api/chat/resume/{id} replays the run's buffer then
   * streams live; reply tokens render as they arrive (R2: through the SAME shared
   * incremental renderer the sender uses — see `_renderLiveStream`). On completion
   * a plain text reply is finalized in place (canonical bubble via
   * chatRenderer.addMessage, no reload); a "rich" reply (tool calls, sources, doc
   * streaming, multi-round) is reloaded from the DB so its full render stays
   * faithful. Returns true if it attached, false to let the caller fall back to
   * spinner+poll.
   */
  export async function resumeStream(sessionId) {
    if (!sessionId) return false;
    if (hasActiveStream(sessionId)) return false;

    let res;
    try {
      res = await fetch(`${API_BASE}/api/chat/resume/${sessionId}`);
    } catch (e) {
      return false;
    }
    if (!res.ok || !res.body) return false;

    const box = document.getElementById('chat-history');
    if (!box) return false;

    // Block duplicate re-attach attempts while this reader is live. A dedicated
    // set (not _backgroundStreams) so checkBackgroundStream doesn't mistake this
    // for a same-tab POST stream and spawn its own spinner+poll on re-entry. Set BEFORE the first
    // paint below, so a `softReloadHistory` reconcile that races this attach sees `hasActiveStream`
    // and DEFERS past it (never rebuilds the DOM out from under the live holder mid-paint).
    chatState._resumingStreams.add(sessionId);

    const holder = document.createElement('div');
    holder.className = 'msg msg-ai';
    holder.dataset.liveHolder = '1'; // S17: see chatWsSplice._wsEnsureRound - an unfinalized observer holder is rebuilt at settle
    const meta = sessionModule.getSessions().find(s => s.id === sessionId);
    const roleLabel = _senderLabel(_shortModel(meta && meta.model));
    // ADR 0012 §2.2: the live bubble is created with a placeholder time, then RE-STAMPED from the
    // SERVER-minted timestamp the moment the replayed message_saved event arrives (serverTs below), so
    // an observer re-attaching to a live run reads the IDENTICAL time string as the sender and the
    // history reload — not its own `new Date()` at attach time.
    const roleTs = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    holder.innerHTML = '<div class="role">' + uiModule.esc(roleLabel) +
      ' <span class="role-timestamp">' + roleTs + '</span></div>' +
      '<div class="body"><div class="stream-content"></div></div>';
    _applyModelColor(holder.querySelector('.role'), meta && meta.model);
    holder._requestedModel = meta && meta.model;
    holder._actualModel = meta && meta.model;
    // #1626 increment 2: seed the explicit character label at creation (same source model_info reads)
    // so a mid-stream byline refresh preserves a preset NPC label instead of the producer name.
    holder._characterName = presetsModule.getCharacterName ? presetsModule.getCharacterName() : '';
    const contentDiv = holder.querySelector('.stream-content');
    box.appendChild(holder);

    const spinner = spinnerModule.create(_inProgressLabel('Generating response...'), 'right');
    holder.querySelector('.body').appendChild(spinner.createElement());
    spinner.start();
    uiModule.scrollHistory();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let replyText = '';      // public reply deltas
    let reasoningText = '';  // reasoning deltas (thinking:true) — kept OUT of the bubble
    let gotDelta = false;
    let leftSession = false;
    let metricsData = null;
    // ADR 0012 §2.2: the SERVER-minted message timestamp, captured off the replayed message_saved
    // event so the finalize renders the identical time string the sender/history do (not a local
    // attach-time `new Date()`).
    let serverTs = null;
    // M2-6: the beat's IN-WORLD moment string, captured off the replayed message_saved event so the
    // mirror's finalize-in-place carries it onto the canonical bubble (matching the reload render).
    let serverMoment = null;
    // F5 (dedup hardening): the SERVER-minted DB id, captured off the replayed message_saved event.
    // Stamped onto the finalized-in-place bubble below so the resumed reply carries its {db id} —
    // otherwise the finalize creates a db-id-LESS orphan that softReloadHistory's adopt pass cannot
    // match and its divergence check ignored, so a later reload left a DUPLICATE bubble (the audit's
    // "resume finalize-in-place can leave a db-id-less duplicate bubble"). With the id stamped, the
    // adopt pass matches it with ZERO churn — the streamed bubble keeps its single entrance.
    let savedDbId = null;
    // "Rich" responses (tool calls, sources, doc streaming, multi-round) need the
    // full canonical render, which is rebuilt from the saved DB record on reload.
    // Plain text replies can be finalized in place without a reload.
    let rich = false;
    // M1-1: per-chunk paint batching (see the delta branch) — deltas mark dirty; the
    // paint runs after each chunk's parts are processed, so a same-chunk dup-abort wins.
    let paintDirty = false;

    const cleanup = () => {
      try { spinner.destroy(); } catch (_) {}
      chatState._resumingStreams.delete(sessionId);
    };

    // Canonical combined source: reasoning wrapped in a CLOSED <think> block (so it renders
    // in the default-collapsed accordion and can NEVER leak into the public bubble) followed
    // by the clean reply. This is the SAME shape the primary stream path and the history
    // reload use, routed through the SAME renderer (processWithThinking) — so an observer tab
    // that re-attaches to a live run renders reasoning identically instead of dumping it raw
    // into the bubble. That divergence WAS the cross-session "reasoning leaks" hot mess.
    const _combined = () => {
      const reply = stripToolBlocks(replyText);
      return markdownModule.composeThinkSource(reasoningText, reply);
    };
    // R2 (ADR 0012 §3.3): render each live delta through the SHARED incremental renderer
    // (_renderLiveStream → createStreamRenderer), the SAME machinery the sender feeds — NOT a
    // per-delta `contentDiv.innerHTML = processWithThinking(...)` full repaint. The reasoning channel
    // split is preserved by construction (reply → .live-reply-content via the incremental renderer;
    // reasoning → a default-collapsed accordion, never the reply container). The settled finalize
    // still rebuilds the canonical bubble from _combined() below (one render path at rest).
    const _liveState = {};
    // The canonical reply renderer — the SAME `processWithThinking ∘ squashOutsideCode` shape the
    // sender's `_renderStream` feeds createStreamRenderer. Supplied to the shared `_renderLiveStream`
    // so the observer never invents its own markdown path (it shares the sender's), and any inline
    // <think>/operator-aside scrub the game build applies in processWithThinking runs here too.
    const _liveRender = (t) => markdownModule.processWithThinking(markdownModule.squashOutsideCode(t));
    const renderDelta = () => {
      _renderLiveStream(contentDiv, replyText, reasoningText, _liveRender, _liveState, holder);
    };

    try {
      readLoop:
      while (true) {
        // User left this session: stop rendering, the run continues server-side.
        if (sessionModule.getCurrentSessionId &&
            sessionModule.getCurrentSessionId() !== sessionId) {
          leftSession = true;
          try { await reader.cancel(); } catch (_) {}
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data: '));
          if (!line) continue;
          const payload = line.slice(6);
          if (payload === '[DONE]') {
            // Flush any deltas buffered earlier in THIS chunk before we break — otherwise a
            // terminal replay whose reply + `[DONE]` ride one burst would skip the chunk-end
            // paint batch and never mount the incremental container (ship-gate F5).
            if (paintDirty) { paintDirty = false; renderDelta(); }
            try { await reader.cancel(); } catch (_) {}
            break readLoop;
          }
          let json;
          try { json = JSON.parse(payload); } catch (_) { continue; }
          if (json.type === 'user_message') {
            // F1: the run buffer leads with the prompting user turn — render the OBSERVER's user
            // bubble BEFORE this reply holder so cause precedes effect. Idempotent + dedup-by-key
            // (clientMsgId / db id), so a reconcile that already rendered it is a no-op.
            try { renderObserverUserMessage(json, { beforeEl: holder }); } catch (_) {}
            continue;
          }
          if (json.delta) {
            // Route reasoning (thinking:true) to its own buffer so it lands in the collapsed
            // accordion, exactly like the primary stream path — never raw into the bubble.
            if (json.thinking) reasoningText += json.delta;
            else replyText += json.delta;
            if (!gotDelta) { gotDelta = true; try { spinner.destroy(); } catch (_) {} }
            // M1-1: paint per network CHUNK (after this parts-loop), not per delta — a
            // SETTLED run's replay arrives as one burst whose message_saved rides the same
            // chunk, so the own-echo dup-abort below runs before any content ever paints.
            paintDirty = true;
          } else if (json.type === 'doc_stream_open') {
            rich = true;
            if (documentModule) documentModule.streamDocOpen(json.title || '', json.lang || '');
          } else if (json.type === 'doc_stream_delta') {
            rich = true;
            if (documentModule && json.delta) documentModule.streamDocDelta(json.delta);
          } else if (json.type === 'orwell_narrator') {
            // #1626 increment 2: the MIRROR/resume stream carries this resumed session's producer name.
            // ALWAYS persist it SEASON-SCOPED (keyed to the resumed sessionId). Only touch the
            // tab-global byline + refresh the live bubble when this resumed session is the ACTIVE one —
            // a background resume must not hijack the byline the user is currently viewing. Fail-open.
            if (json.name) {
              _persistNarratorForSession(sessionId, json.name);
              const _activeNow = !(sessionModule.getCurrentSessionId
                && sessionModule.getCurrentSessionId() !== sessionId);
              if (_activeNow) {
                setGameNarrator(json.name);
                _refreshLiveByline(holder);
              }
            }
          } else if (json.type === 'metrics') {
            metricsData = json.data || metricsData;
          } else if (json.type === 'message_saved') {
            // M1-1 (audit A1) — CONVERGENCE KEY: the replayed message_saved carries the
            // server-minted DB id. A bubble with that id already in the DOM is one of two things:
            const _dup = json.id && box.querySelector('.msg[data-db-id="' + String(json.id).replace(/"/g, '') + '"]');
            if (_dup) {
              // (b) OBSERVER RECONCILE (ship-gate F5): a from-history render (selectSession /
              // softReloadHistory) already painted a STATIC bubble for a run this tab is only
              // MIRRORING (the sender settled before we finished attaching). Aborting here would
              // strand B on that non-incremental reconcile — the F5 "scratch and grind". Instead
              // REMOVE the static bubble and let this resume render the turn LIVE through the SHARED
              // incremental renderer (createStreamRenderer), then finalize-in-place re-stamping the
              // SAME db-id, so a later reconcile adopts it with ZERO churn (no duplicate).
              if (_dup.dataset && _dup.dataset.fromHistory === '1') {
                _dup.remove();
                // Commit to the LIVE mirror render NOW. The terminal replay arrives as one burst
                // whose trailing `[DONE]` `break`s out of the read loop BEFORE the chunk-end paint
                // batch — so a deferred paint would never fire and B would fall back to the static
                // finalize (the incremental container never mounts → the F5 miss). Paint the buffered
                // reply through the SHARED incremental renderer here, then fall through to capture
                // ts/id and keep tailing.
                paintDirty = false; renderDelta();
                // fall through — capture ts/id below, keep reading, and paint incrementally.
              } else {
                // (a) OWN-ECHO: this tab live-rendered + finalized the bubble via its own primary
                // POST stream (NOT from history). Finishing would paint a duplicate → abort by id,
                // never content-equality: drop the placeholder, keep the settled bubble.
                try { await reader.cancel(); } catch (_) {}
                cleanup();
                if (holder.parentNode) holder.remove();
                return true;
              }
            }
            // ADR 0012 §2.2: the run's persisted-message signal is in the replay buffer — capture its
            // server timestamp and re-stamp the live bubble so this observer reads the same time as
            // every other window. (json.id is the DB id; the finalize/reload carries it forward.)
            // M2-6: capture the in-world moment alongside the ts and re-stamp the mirror bubble.
            if (typeof json.moment === 'string' && json.moment) serverMoment = json.moment;
            if (json.ts || serverMoment) { if (json.ts) serverTs = json.ts; _applyServerTimestamp(holder, serverTs, serverMoment); }
            // F5 (dedup hardening): also capture the DB id so the finalize-in-place below stamps
            // data-db-id onto the canonical bubble (zero-churn adopt on a later reload, no duplicate).
            if (json.id) { savedDbId = json.id; holder.dataset.dbId = json.id; }
          } else if (json.type === 'tool_start' || json.type === 'tool_output' ||
                     json.type === 'tool_progress' || json.type === 'agent_step' ||
                     json.type === 'web_sources' || json.type === 'rag_sources' ||
                     json.type === 'research_progress' || json.type === 'research_sources' ||
                     json.type === 'research_findings' || json.type === 'research_done') {
            rich = true;
          }
        }
        // M1-1: flush this chunk's accumulated deltas in ONE paint (post-dup-check).
        if (paintDirty) { paintDirty = false; renderDelta(); }
      }
    } catch (e) {
      // Network drop or parse failure: fall through to the reload below.
    }

    cleanup();
    if (leftSession) { if (holder.parentNode) holder.remove(); return true; }

    const onThisSession = sessionModule.getCurrentSessionId &&
                          sessionModule.getCurrentSessionId() === sessionId;

    // Plain text reply: finalize in place. Replace the live bubble with a
    // canonical single message (markdown + footer actions + metrics) using the
    // same renderer history does. No history refetch, no end-of-stream flicker.
    // Pass the canonical <think>-wrapped source so addMessage's processWithThinking
    // splits reasoning → accordion and reply → bubble (matching the live render above).
    if (onThisSession && !rich && replyText.trim()) {
      if (holder.parentNode) holder.remove();
      const model = meta && meta.model;
      const meta_ = metricsData ? Object.assign({ model }, metricsData) : { model };
      // ADR 0012 §2.2: carry the server timestamp onto the canonical bubble so the finalize renders
      // the identical time string as the sender's bubble and the history reload (chatRenderer.addMessage
      // → roleTimestamp(metadata.timestamp)). Absent ⇒ roleTimestamp falls back to "now" (prior behavior).
      if (serverTs) meta_.timestamp = serverTs;
      // M2-6: carry the in-world moment so the finalized mirror bubble renders the same in-world stamp
      // as the sender + history reload (chatRenderer.addMessage → roleTimestamp(ts, metadata.game_moment)).
      if (serverMoment) meta_.game_moment = serverMoment;
      // F5 (dedup hardening): carry the DB id so the finalized bubble is data-db-id-stamped (addMessage
      // reads metadata._db_id). A later softReloadHistory then ADOPTS this bubble (id match) with ZERO
      // churn instead of leaving it an unmatchable orphan beside the canonical reload render (duplicate).
      if (savedDbId) meta_._db_id = savedDbId;
      chatRenderer.addMessage('assistant', _combined(), model, meta_);
      uiModule.scrollHistory();
      // F5 / ADR 0008: a reconcile that raced this live attach may have DEFERRED past it (it saw the
      // `_resumingStreams` lock and added to `_pendingReconcile` instead of rebuilding). Now that the
      // lock is released (cleanup) and the reply is finalized in place (db-id stamped), flush any such
      // pending reconcile so a MIRRORING observer still lands the sender's user turn in seq order — the
      // adopt pass claims this finalized bubble by id with zero churn, so there is no re-render / dup.
      try { flushPendingReconcile(sessionId); } catch (_) {}
      return true;
    }

    // Rich response (tools, sources, docs, multi-round) or user moved on:
    // reload from the DB for the full canonical render.
    if (holder.parentNode) holder.remove();
    if (onThisSession) sessionModule.selectSession(sessionId);
    else sessionModule.loadSessions();
    return true;
  }

  /**
   * Check for background streams when switching to a session.
   * Called after history loads on session switch.
   */
  export function checkBackgroundStream(sessionId) {
    if (!sessionId || !chatState._backgroundStreams.has(sessionId)) return;
    var entry = chatState._backgroundStreams.get(sessionId);

    if (entry.status === 'completed') {
      // Response is already saved to DB and will appear in history — just clean up
      chatState._backgroundStreams.delete(sessionId);
      return;
    }

    if (entry.status === 'error') {
      chatState._backgroundStreams.delete(sessionId);
      var box = document.getElementById('chat-history');
      if (box) {
        var errHolder = document.createElement('div');
        errHolder.className = 'msg msg-ai';
        errHolder.innerHTML = '<div class="body"><i style="color: var(--color-error);">[Background stream encountered an error]</i></div>';
        box.appendChild(errHolder);
      }
      return;
    }

    if (entry.status === 'running') {
      // Stream is still active — show a clean spinner, poll until done,
      // then reload history to show the final saved response.
      var box = document.getElementById('chat-history');
      if (!box) return;

      // Replay any doc content that was streamed in the background
      if (entry._docTitle != null && documentModule) {
        documentModule.streamDocOpen(entry._docTitle, entry._docLang || '');
        if (entry._docContent) {
          documentModule.streamDocDelta(entry._docContent);
        }
      }

      var holder = document.createElement('div');
      holder.className = 'msg msg-ai';
      var meta = sessionModule.getSessions().find(function(s) { return s.id === sessionId; });
      var roleLabel = _senderLabel(_shortModel(meta && meta.model));
      var roleTs = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      holder.innerHTML = '<div class="role">' + uiModule.esc(roleLabel) + ' <span class="role-timestamp">' + roleTs + '</span></div><div class="body"></div>';
      _applyModelColor(holder.querySelector('.role'), meta && meta.model);

      var bodyDiv = holder.querySelector('.body');
      var spinner = spinnerModule.create(_inProgressLabel('Response streaming in background'), 'right');
      bodyDiv.appendChild(spinner.createElement());
      spinner.start();

      box.appendChild(holder);
      uiModule.scrollHistory();

      // Poll map until stream finishes, then reload history
      var pollId = setInterval(function() {
        if (sessionModule.getCurrentSessionId() !== sessionId) {
          clearInterval(pollId);
          spinner.destroy();
          if (holder.parentNode) holder.remove();
          return;
        }
        // Update doc content while polling
        var curPoll = chatState._backgroundStreams.get(sessionId);
        if (curPoll && curPoll._docContent && documentModule) {
          documentModule.streamDocDelta(curPoll._docContent);
        }
        if (!curPoll || curPoll.status !== 'running') {
          clearInterval(pollId);
          spinner.destroy();
          if (holder.parentNode) holder.remove(); // Remove entire holder, not just spinner
          chatState._backgroundStreams.delete(sessionId);
          // Reload session to show the completed response — but only if the user
          // is still on it; don't yank them back from a new chat they opened.
          if (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId() === sessionId) {
            sessionModule.selectSession(sessionId);
          } else {
            sessionModule.loadSessions();
          }
        }
      }, 500);
    }
  }

  // Tag short single-line code blocks with .pre-compact so the CSS can
  // render the Run/Edit/Copy buttons as a slim row that doesn't make a
  // 1-line bash block taller than its own contents.
  function _markCompactPre(pre) {
    const code = pre.querySelector('code');
    if (!code) return;
    const txt = code.textContent || '';
    // Count visible lines — ignore trailing newline (common with fenced
    // blocks) and treat any empty extra line as not a real second line.
    const lines = txt.replace(/\n+$/, '').split('\n');
    const compact = lines.length <= 1 && txt.length < 200;
    pre.classList.toggle('pre-compact', compact);
  }
  function _scanCompactPres(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('pre').forEach(_markCompactPre);
  }
  // Global observer so any <pre> added anywhere in the app (chat stream,
  // chat re-renders, document library chat previews, slash commands,
  // research previews, etc.) gets tagged without each call site needing
  // to remember.
  (function _initCompactPreObserver() {
    if (window._cmpPreObserverWired) return;
    window._cmpPreObserverWired = true;
    _scanCompactPres(document.body);
    // ORW-157: once per frame over the nodes still attached (not per streamed token).
    const obs = new MutationObserver(frameBatched((muts) => {
      for (const n of liveAddedElements(muts)) {
        if (n.tagName === 'PRE') _markCompactPre(n);
        if (n.querySelectorAll) _scanCompactPres(n);
      }
    }));
    obs.observe(document.body, { childList: true, subtree: true });
  })();

  /**
   * Initialize event listeners
   */
  export function initListeners() {
    // Global event delegation for copy-code buttons
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.copy-code');
      if (!btn) return;
      e.stopPropagation();
      const code = btn.getAttribute('data-code');
      if (code && uiModule) {
        uiModule.copyToClipboard(code);
        // Visual feedback: swap the icon to a checkmark (regular size)
        // and add .copied which the CSS uses to flash green + pulse.
        // For slim/.pre-compact buttons the label text comes from a
        // CSS ::before — swap it via data-state so we don't break the
        // text-button layout.
        const origHTML = btn.innerHTML;
        const isCompact = !!btn.closest('pre.pre-compact');
        if (!isCompact) {
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        }
        btn.classList.add('copied');
        btn.dataset.state = 'copied';
        setTimeout(() => {
          if (!isCompact) btn.innerHTML = origHTML;
          btn.classList.remove('copied');
          delete btn.dataset.state;
        }, 1500);
      }
    });

    // Run code button delegation
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.run-code');
      if (!btn) return;
      e.stopPropagation();
      if (codeRunnerModule) codeRunnerModule.run(btn);
    });

    // Edit code button delegation — toggle contentEditable on the code element
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.edit-code');
      if (!btn) return;
      e.stopPropagation();
      const pre = btn.closest('pre');
      if (!pre) return;
      const codeEl = pre.querySelector('code');
      if (!codeEl) return;
      const isEditing = codeEl.contentEditable !== 'false' && codeEl.contentEditable !== 'inherit';
      if (isEditing) {
        // Save: exit edit mode, update data-code on copy/run buttons
        codeEl.contentEditable = 'false';
        codeEl.classList.remove('editing');
        pre.classList.remove('editing');
        const newCode = codeEl.textContent;
        const copyBtn = pre.querySelector('.copy-code');
        if (copyBtn) copyBtn.setAttribute('data-code', newCode);
        const runBtn = pre.querySelector('.run-code');
        if (runBtn) runBtn.setAttribute('data-code', newCode);
        // Swap icon back to pencil
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
        btn.title = 'Edit';
        btn.classList.remove('active');
      } else {
        // Enter edit mode. Firefox (especially on mobile) historically lacks
        // contentEditable="plaintext-only" — setting it there leaves the block
        // non-editable, so the tap "just gets a checkmark" with no way to type.
        // Fall back to "true" when plaintext-only didn't take.
        try { codeEl.contentEditable = 'plaintext-only'; } catch (_) { /* unsupported value */ }
        if (codeEl.contentEditable !== 'plaintext-only') codeEl.contentEditable = 'true';
        codeEl.classList.add('editing');
        pre.classList.add('editing');
        // preventScroll keeps the page from jumping to the codeblock when
        // focusing the editable on mobile — the browser would otherwise
        // scroll it into view above the keyboard, which reads as "auto-
        // scroll triggered by clicking Edit".
        try { codeEl.focus({ preventScroll: true }); } catch (_) { codeEl.focus(); }
        // Swap icon to checkmark
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        btn.title = 'Done editing';
        btn.classList.add('active');
      }
    });

    // Tapping a code block body (not its buttons) toggles the overlay
    // copy/edit/run buttons, which otherwise cover the text on mobile.
    document.addEventListener('click', (e) => {
      if (e.target.closest('.copy-code, .edit-code, .run-code')) return;
      const pre = e.target.closest('pre');
      if (!pre || !pre.querySelector('.copy-code')) return;
      // Don't hide while editing — the buttons (incl. the Done checkmark) matter.
      if (pre.classList.contains('editing')) return;
      pre.classList.toggle('buttons-hidden');
    });

    // Position copy/run buttons top or bottom based on viewport position
    // — DESKTOP ONLY. On mobile this was constantly retriggering on tap
    // (synthetic mouseenter) and made the buttons jump, so the user's
    // finger landed on the moved target. Keep them pinned at the top on
    // touch — no auto-repositioning.
    document.addEventListener('mouseenter', (e) => {
      if (window.matchMedia('(max-width: 768px)').matches) return;
      const pre = e.target.closest ? e.target.closest('pre') : null;
      if (!pre || pre.dataset.btnPosComputed) return;
      const rect = pre.getBoundingClientRect();
      const threshold = window.innerHeight * 0.35;
      const isBottom = rect.top < threshold;
      const copyBtn = pre.querySelector('.copy-code');
      if (copyBtn) copyBtn.classList.toggle('bottom', isBottom);
      const editBtn = pre.querySelector('.edit-code');
      if (editBtn) editBtn.classList.toggle('bottom', isBottom);
      const runBtn = pre.querySelector('.run-code');
      if (runBtn) runBtn.classList.toggle('bottom', isBottom);
      pre.dataset.btnPosComputed = '1';
    }, true);

    // #971 — reconcile the composer button whenever a game mutation lands. A backgrounded stream that
    // finished on another surface (or a peer-resumed run) can leave THIS window's button stuck on Stop;
    // `orwell:gamechanged` (the debounced freshness seam, fired on every mutating tool result + the
    // cross-device push) is the natural moment to repair it to the true streaming/idle state. Idempotent
    // (a no-op when the button already matches), and never disturbs a genuinely live foreground stream.
    window.addEventListener('orwell:gamechanged', () => {
      try { _syncSubmitButtonState(); } catch (_) {}
    });

    // Tab suspension recovery: when user tabs back in, check if stream froze
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // #971 — on tab return, FIRST repair a button left stuck on Stop by a stream that settled while
      // the tab was hidden/backgrounded (the `_isBgFinally` path never reset it). Cheap + idempotent;
      // runs even when not streaming, so the stuck-Stop case recovers the moment the user looks back.
      try { _syncSubmitButtonState(); } catch (_) {}
      if (!chatState.isStreaming) return;

      // Stream claims to be running — check if reader is actually alive
      const staleSince = Date.now() - _lastReaderActivity;
      if (staleSince < 20000) return; // Active recently, probably fine

      // Reader hasn't produced data in 5+ seconds after tab resume.
      // Give it a short grace period then recover.
      console.warn('[tab-recovery] Stream appears frozen (no activity for ' + Math.round(staleSince/1000) + 's). Recovering...');

      setTimeout(() => {
        // Re-check — maybe the reader woke up during the grace period
        if (!chatState.isStreaming) return;
        const stillStale = Date.now() - _lastReaderActivity;
        if (stillStale < 5000) return; // Came back to life

        console.warn('[tab-recovery] Stream confirmed dead. Aborting and reloading session.');

        // Abort the frozen stream, but preserve the visible bubble.
        if (chatState.currentAbort) {
          chatState.currentAbort._reason = 'recovery';
          chatState.currentAbort.abort();
        }
        chatState.isStreaming = false;

        // Release Web Lock
        if (_webLockRelease) {
          _webLockRelease();
          _webLockRelease = null;
        }

        // Reset UI state
        var _submitBtn = document.getElementById('submit');
        updateSubmitButton('idle', _submitBtn);
        var _msgInput = document.getElementById('message');
        if (_msgInput) _msgInput.disabled = false;
      }, 2000); // 2 second grace period
    });

    // On mobile, fade out welcome text when keyboard opens to prevent overlap
    if (isNarrow()) {
      const msgInput = document.getElementById('message');
      if (msgInput) {
        msgInput.addEventListener('focus', () => {
          const ws = document.getElementById('welcome-screen');
          if (ws && !ws.classList.contains('hidden')) {
            ws.classList.add('kb-hidden');
          }
        });
        msgInput.addEventListener('blur', () => {
          const ws = document.getElementById('welcome-screen');
          if (ws && !ws.classList.contains('hidden')) {
            // Delay re-show so tapping within chatbox doesn't flash
            setTimeout(() => {
              if (document.activeElement !== msgInput) {
                ws.classList.remove('kb-hidden');
              }
            }, 200);
          }
        });
      }
      // Smooth viewport resize when keyboard opens/closes
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
        });
        document.documentElement.style.setProperty('--vh', window.visualViewport.height + 'px');
      }
    }

    // If the browser discarded and restored this tab, reload the current session
    // so the user sees the server-saved partial response instead of a blank page
    if (document.wasDiscarded) {
      console.warn('[tab-recovery] Tab was discarded by browser — reloading session');
      setTimeout(() => {
        var _sid = sessionModule && sessionModule.getCurrentSessionId();
        if (_sid) sessionModule.selectSession(_sid);
      }, 500);
    }
  }

  /**
   * Regenerate response: truncate history to the user message before this AI message,
   * then re-submit that user message.
   */
  /**
   * Edit a user message: show an input, truncate to before it, resubmit the edited text.
   */
  // #1414 (R3 PR5): the per-message actions cluster — editUserMessage / resendUserMessage /
  // regenerateFrom / _attachVariantNav / _renderVariantNav / _switchVariant / _variantTagText /
  // forkFrom (and, below, deleteMessage / editAIMessage / rewriteWith / continueFrom) moved to
  // chatMessageActions.js (imported above, re-exported on the chatModule public API below).
  // Behavior-preserving. `_pendingRegenAttachments` STAYS here because handleChatSubmit reads and
  // clears it on the very next send (the regen/resend file-id hand-off); the moved regen/resend
  // writers set it through the injected setPendingRegenAttachments (see _setMessageActionsDeps at
  // module-eval below). `_pendingVariants` / `_pendingVariantLabel` moved with the cluster.
  let _pendingRegenAttachments = null;

  /**
   * Check for pending/completed research after page refresh or session switch.
   * If research is still running, show a spinner and poll until done.
   * If research is done, fetch result and render it.
   */
  export async function checkPendingResearch(sessionId) {
    if (!sessionId) return;
    // #1035 (F-8): deep research is a DROPPED vertical under the game build (trigger_research /
    // manage_research are not in the keep-set), so /api/research/status can only ever 404 here —
    // this poll fired once per session-select and spammed ~one 404 per turn. Skip it in the game
    // build; the full inherited workspace (ORWELL_GAME_BUILD=0) still polls normally.
    if (document.body && document.body.hasAttribute('data-game-build')) return;
    try {
      const res = await fetch(`${API_BASE}/api/research/status/${sessionId}`);
      if (!res.ok) return; // 404 = no research for this session
      const data = await res.json();

      if (data.status === 'done') {
        // Fetch and render the completed result
        _notifyResearchComplete(sessionId, data.query || '');
        if (sessionModule && sessionModule.clearResearching) sessionModule.clearResearching(sessionId);
        const resultRes = await fetch(`${API_BASE}/api/research/result/${sessionId}`, { method: 'POST' });
        if (resultRes.ok) {
          const resultData = await resultRes.json();
          if (resultData.result) {
            // Skip if history already has a research message for this session
            if (document.querySelector(`#chat-history .msg-ai[data-research-session="${sessionId}"]`)) return;

            var srcBox = '';
            if (resultData.sources && resultData.sources.length > 0) {
              srcBox = _buildSourcesBox(resultData.sources, 'research');
            }
            var findingsBox = chatRenderer.buildFindingsBox(resultData.raw_findings);
            var cleanResult = resultData.result;
            // Build DOM directly to avoid double-processing through addMessage
            chatRenderer.hideWelcomeScreen();
            var _box = document.getElementById('chat-history');
            if (_box) {
              var _wrap = document.createElement('div');
              _wrap.className = 'msg msg-ai';
              _wrap.dataset.researchSession = sessionId;
              var _role = document.createElement('div');
              _role.className = 'role';
              var _meta = sessionModule.getSessions().find(function(s) { return s.id === sessionId; });
              _role.textContent = _shortModel(_meta?.model);
              _applyModelColor(_role, _meta?.model);
              _role.appendChild(chatRenderer.roleTimestamp());
              var _body = document.createElement('div');
              _body.className = 'body';
              _body.innerHTML = srcBox + markdownModule.processWithThinking(
                markdownModule.squashOutsideCode(cleanResult)
              ) + findingsBox;
              _wrap.dataset.raw = cleanResult;
              _wrap.appendChild(_role);
              _wrap.appendChild(_body);
              _wrap.appendChild(chatRenderer.createMsgFooter(_wrap));
              _appendViewReportLink(_wrap, sessionId);
              _box.appendChild(_wrap);
              if (window.hljs) _wrap.querySelectorAll('pre code').forEach(function(b) { window.hljs.highlightElement(b); });
              uiModule.scrollHistory();
            }
          }
        }
        return;
      }

      if (data.status !== 'running') return;

      // Don't show reconnect UI if we've already switched away
      if (sessionModule.getCurrentSessionId() !== sessionId) return;

      // Research is still running — show reconnect UI with spinner
      const box = document.getElementById('chat-history');
      if (!box) return;

      const holder = document.createElement('div');
      holder.className = 'msg msg-ai research-reconnect';
      holder.dataset.researchSession = sessionId;
      const roleTs = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
      const agentMeta = sessionModule.getSessions().find(s => s.id === sessionModule.getCurrentSessionId());
      const agentModelLabel = _senderLabel(_shortModel(agentMeta?.model));
      holder.innerHTML = `<div class="role">${uiModule.esc(agentModelLabel)} <span class="role-timestamp">${roleTs}</span></div><div class="body"></div>`;
      _applyModelColor(holder.querySelector('.role'), agentMeta?.model);
      box.appendChild(holder);

      const bodyDiv = holder.querySelector('.body');
      const spinner = spinnerModule.create('Reconnecting to research...', 'right');
      bodyDiv.appendChild(spinner.createElement());
      spinner.start();

      // Update spinner with current progress if available
      function updateSpinnerFromProgress(progress) {
        if (!progress || !progress.phase) return;
        const rp = progress;
        if (rp.phase === 'probing') {
          spinner.updateMessage(`Verifying model: ${rp.model || '?'}`);
        } else if (rp.phase === 'planning') {
          spinner.updateMessage('Analyzing question & planning research strategy');
        } else if (rp.phase === 'searching') {
          const q = rp.queries ? `${rp.queries} queries` : '';
          const s = rp.total_sources ? ` · ${rp.total_sources} sources` : '';
          spinner.updateMessage(`Round ${rp.round || '?'}: Searching${q ? ' (' + q + ')' : ''}${s}`);
        } else if (rp.phase === 'reading') {
          spinner.updateMessage(rp.title ? `Reading: ${rp.title}` : `Round ${rp.round || '?'}: Reading ${rp.new_sources || ''} pages · ${rp.total_sources || 0} sources total`);
        } else if (rp.phase === 'analyzing') {
          spinner.updateMessage(`Round ${rp.round || '?'}: Analyzing ${rp.total_findings || 0} findings`);
        } else if (rp.phase === 'writing') {
          spinner.updateMessage(`Writing report · ${rp.total_sources || 0} sources`);
        }
      }

      updateSpinnerFromProgress(data.progress);
      chatState._researchingStreamIds.add(sessionId);
      if (sessionModule && sessionModule.markResearching) sessionModule.markResearching(sessionId);

      // Restore research timer from started_at
      if (data.started_at && spinner && spinner.element) {
        _researchStartTime = data.started_at * 1000;
        _researchAvgDuration = data.avg_duration || null;
        _researchTimerEl = document.createElement('div');
        _researchTimerEl.className = 'research-timer';
        _researchTimerEl.style.cssText = 'font-size:0.8em; opacity:0.6; margin-top:4px; font-family:var(--mono, monospace);';
        spinner.element.parentNode.insertBefore(_researchTimerEl, spinner.element.nextSibling);
        _researchTimerInterval = setInterval(() => {
          if (!_researchTimerEl) return;
          var elapsed = Math.floor((Date.now() - _researchStartTime) / 1000);
          var mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
          var ss = String(elapsed % 60).padStart(2, '0');
          var txt = mm + ':' + ss;
          if (_researchAvgDuration) {
            var avgM = String(Math.floor(_researchAvgDuration / 60)).padStart(2, '0');
            var avgS = String(Math.round(_researchAvgDuration % 60)).padStart(2, '0');
            txt += ' / avg ' + avgM + ':' + avgS;
          }
          _researchTimerEl.textContent = txt;
        }, 1000);
        // Reconnect synapse — seed it with whatever progress is already known
        try {
          _researchSynapse = createResearchSynapse(spinner.element.parentNode, {
            query: data.query || '',
            startedAt: _researchStartTime,
          });
          if (_researchSynapse.element && _researchTimerEl) {
            spinner.element.parentNode.insertBefore(_researchSynapse.element, _researchTimerEl);
          }
          if (data.progress) {
            _researchSynapse.setPhase(data.progress.phase, data.progress);
            if (typeof data.progress.round === 'number') _researchSynapse.setRound(data.progress.round);
            if (typeof data.progress.total_sources === 'number') _researchSynapse.setSourceCount(data.progress.total_sources);
          }
        } catch (e) { console.warn('synapse reconnect failed', e); }
      }

      // Poll for completion
      const pollInterval = setInterval(async () => {
        // Stop polling if user switched to a different session
        if (sessionModule.getCurrentSessionId() !== sessionId) {
          clearInterval(pollInterval);
          spinner.destroy();
          _clearResearchTimer();
          if (holder.parentNode) holder.remove();
          chatState._researchingStreamIds.delete(sessionId);
          if (chatState._researchingStreamIds.size === 0) {
            var _rToggleP = document.getElementById('research-toggle-btn');
            if (_rToggleP) _rToggleP.classList.remove('research-running');
          }
          return;
        }
        try {
          const pollRes = await fetch(`${API_BASE}/api/research/status/${sessionId}`);
          if (!pollRes.ok) {
            clearInterval(pollInterval);
            spinner.destroy();
            _clearResearchTimer();
            chatState._researchingStreamIds.delete(sessionId);
            if (sessionModule && sessionModule.clearResearching) sessionModule.clearResearching(sessionId);
            return;
          }
          const pollData = await pollRes.json();
          updateSpinnerFromProgress(pollData.progress);
          if (_researchSynapse && pollData.progress) {
            _researchSynapse.setPhase(pollData.progress.phase, pollData.progress);
            if (typeof pollData.progress.round === 'number') _researchSynapse.setRound(pollData.progress.round);
            if (typeof pollData.progress.total_sources === 'number') _researchSynapse.setSourceCount(pollData.progress.total_sources);
          }

          if (pollData.status !== 'running') {
            clearInterval(pollInterval);
            spinner.destroy();
            _clearResearchTimer();
            chatState._researchingStreamIds.delete(sessionId);
            if (sessionModule && sessionModule.clearResearching) sessionModule.clearResearching(sessionId);

            if (pollData.status === 'done') {
              _notifyResearchComplete(sessionId, data.query || '');
              const rRes = await fetch(`${API_BASE}/api/research/result/${sessionId}`, { method: 'POST' });
              if (rRes.ok) {
                const rData = await rRes.json();
                if (rData.result) {
                  var srcHtml = '';
                  if (rData.sources && rData.sources.length > 0) {
                    srcHtml = _buildSourcesBox(rData.sources, 'research');
                  }
                  var findingsHtml = chatRenderer.buildFindingsBox(rData.raw_findings);
                  bodyDiv.innerHTML = srcHtml + markdownModule.processWithThinking(
                    markdownModule.squashOutsideCode(rData.result)
                  ) + findingsHtml;
                  holder.dataset.raw = rData.result;
                  _appendViewReportLink(holder, sessionId);
                  if (window.hljs) {
                    holder.querySelectorAll('pre code').forEach(b => window.hljs.highlightElement(b));
                  }
                }
              }
            } else {
              bodyDiv.innerHTML = '<i style="color: var(--color-error);">[Research ' + pollData.status + ']</i>';
            }
          }
        } catch (e) {
          console.error('Research poll error:', e);
        }
      }, 2000);
    } catch (e) {
      // No research pending, that's fine
    }
  }

  /** Set a display override for the next user message bubble */
  export function setDisplayOverride(text) {
    chatState._displayOverride = text;
  }

  /** Hide the user bubble for the next submit (e.g. continue after stop) */
  export function setHideUserBubble() {
    chatState._hideUserBubble = true;
  }

  /**
   * Submit a HIDDEN production cue (no user bubble, no lingering composer text).
   *
   * The OOBE hand-off cues — the producers' opener (_orwellOpenGameAfterCasting) and the
   * post-photo resume (_orwellResumeAfterPhoto) — used to set #message.value then submit.
   * handleChatSubmit reads the value SYNCHRONOUSLY at call time (the `const msg =
   * el('message').value` capture near the top), but only CLEARS the textarea later, AFTER
   * several awaits (session materialize, upload, …). For that gap the cue text sat VISIBLE
   * in the composer — an ugly flash of an engine instruction the player should never read.
   *
   * This seam closes the gap: hide the bubble, write the cue, fire the submit (which captures
   * the value synchronously), then clear #message.value RIGHT AWAY in the same tick — the
   * submit already has the text, so clearing now never races it. Fail-open: any hiccup leaves
   * the composer usable (and never leaves a half-typed cue behind).
   */
  export function sendHiddenCue(text) {
    const box = uiModule.el ? uiModule.el('message') : document.getElementById('message');
    if (!box || typeof text !== 'string') return false;
    try {
      // Headless send: the cue goes straight to the model — no composer write, no synchronous-capture
      // race, no immediate-clear dance. The producers reach out with no player bubble.
      handleChatSubmit(null, text, { hideUserBubble: true });
      return true;
    } catch (_) {
      // Never leave the hide-bubble flag armed for a real next turn if the cue blew up.
      chatState._hideUserBubble = false;
      try { box.value = ''; } catch (__) {}
      return false;
    }
  }

  /** Set the AI element to merge with the next streamed response (continue after stop) */
  export function setPendingContinue(el) {
    chatState._pendingContinue = el;
  }

  // #1414 (R3 PR5): deleteMessage / editAIMessage / rewriteWith / continueFrom moved to
  // chatMessageActions.js (imported above, re-exported on the chatModule public API below).
  // Behavior-preserving; continueFrom re-enters the send via the injected handleChatSubmit.

  // #1414 (R3 PR3): openAttachment / _attachLang / the per-upload doc cache moved to
  // chatAttachments.js (imported above, re-exported on chatModule below). Behavior-preserving.

  // #1414 (R3 PR4): the WebSocket Phase-1 chat live-splice cluster (ADR 0017 §3) —
  // _wsChatActive / _wsResetRound / _wsPinRound / _wsEnsureRound / _onWsChatFrame /
  // _wsRegisterChat — moved to chatWsSplice.js (imported above). Behavior-preserving: chat.js
  // still drives the same call points (the up-frame reroute in handleChatSubmit pins the holder
  // via _wsPinRound and falls soft via _wsResetRound; the boot registration stays below), and
  // injects the three chat.js-internal deps the consumer reads — _renderLiveStream (the R2 render
  // seam), softReloadHistory (the settle reconcile), and _senderLabel (the single-source sender
  // label) — through _setWsSpliceDeps, mirroring the PR2/PR3 injection pattern.
  // #1414 (R3 PR7): inject the three chat.js-internal deps the reconcile cluster (chatReconcile.js)
  // reads — hasActiveStream (the SSE-reader liveness helper) + resumeStream (the R2 live-resume attach),
  // both hoisted function declarations that STAY here, and a () => API_BASE resolver (a chat.js-local
  // `let`, read live so softReloadHistory's /api/history fetch never sees a stale base). Mirrors the
  // PR2..PR6 injection pattern; module-eval, so hasActiveStream/resumeStream are hoisted.
  _setReconcileDeps({
    hasActiveStream: hasActiveStream,
    resumeStream: resumeStream,
    apiBase: () => API_BASE,
  });
  _setWsSpliceDeps({
    renderLiveStream: _renderLiveStream,
    softReloadHistory: softReloadHistory,
    senderLabel: _senderLabel,
    // Best-effort "responding…" spinner for the OBSERVER's fresh round on a peer run boundary (so the
    // mirror shows immediate feedback instead of a blank window). Mirrors the sender's spinner mount;
    // the delta branch destroys `round._spinner` on the first token.
    mountThinkingSpinner: (holder) => {
      try {
        if (!holder) return null;
        const sp = spinnerModule.create('Responding', 'right', 'wave');
        const body = holder.querySelector('.body');
        if (body && sp) { body.appendChild(sp.createElement()); sp.start(); }
        return sp;
      } catch (_) { return null; }
    },
    // F1: the observer's user-bubble renderer (cause-before-effect on the WS `chat` leg). Same
    // dedup-by-clientMsgId + skip-cue contract the SSE resume path uses.
    renderUserMessage: renderObserverUserMessage,
  });
  // #1414 (R3 PR5): inject the three chat.js-internal deps the message-actions cluster
  // (chatMessageActions.js) needs — handleChatSubmit (the headless send + stream loop, which STAYS
  // here), a () => API_BASE resolver (a chat.js-local `let`), and the setPendingRegenAttachments
  // hand-off (whose backing `let _pendingRegenAttachments` handleChatSubmit reads/clears on the next
  // send). Mirrors the PR2/PR3/PR4 injection pattern; module-eval, so handleChatSubmit is hoisted.
  _setMessageActionsDeps({
    handleChatSubmit: handleChatSubmit,
    apiBase: () => API_BASE,
    setPendingRegenAttachments: (v) => { _pendingRegenAttachments = v; },
  });
  if (typeof window !== 'undefined') {
    if (window.OrwellWs) _wsRegisterChat();
    else window.addEventListener('orwell:ws-ready', _wsRegisterChat, { once: true });
    // #1596 — the engine-restart / reconnect-run-gone reconcile. orwellWs emits `orwell:ws-resync`
    // when it heals a backwards beatSeq or reconnects onto a vanished run; the splice handler tears
    // down any wedged live holder, releases the dead stream lock, and rebuilds from history. A
    // DISTINCT event from `orwell:gamechanged` (the g15 single-dispatcher rule is untouched).
    window.addEventListener('orwell:ws-resync', _onWsResync);
    // orwellWs emits `orwell:ws-run-boundary` when it re-attaches to a genuinely-new run: the OBSERVER
    // resets its live round so the new run mounts a FRESH incremental container (mirror-parity) + shows
    // an immediate "responding…" spinner. DISTINCT from `orwell:gamechanged` (g15 rule untouched).
    window.addEventListener('orwell:ws-run-boundary', _onWsRunBoundary);
  }

  // Public API
  const chatModule = {
    init,
    initListeners,
    openAttachment,
    addMessage: chatRenderer.addMessage,
    displayMetrics: chatRenderer.displayMetrics,
    handleChatSubmit,
    abortCurrentRequest,
    detachCurrentStream,
    checkBackgroundStream,
    resumeStream,
    // F1 (concurrent-session consistency): the observer's leading-user-message renderer — exposed for
    // the two-window ordering browser gate (cause-before-effect) and the WS-splice injection.
    renderObserverUserMessage,
    hideWelcomeScreen: chatRenderer.hideWelcomeScreen,
    showWelcomeScreen: chatRenderer.showWelcomeScreen,
    checkPendingResearch,
    // #1626 increment 2: selectSession() invokes this once the active sid is known so the byline is
    // restored from the per-session map (the module-eval read is too early — currentSessionId is unset).
    orwellReapplyNarrator,
    getImageCost: chatRenderer.getImageCost,
    setDisplayOverride,
    setHideUserBubble,
    sendHiddenCue,
    // Shared so EVERY history-render path (chat.js softReloadHistory + sessions.js session/archive
    // loads) filters the same engine/onboarding control prompts — incl. "(Production cue …)". The
    // lists drifted before (chat.js had the cue case, sessions.js didn't) and leaked cues as "You"
    // bubbles; this is the one source of truth so that can't recur.
    isSkippableUserPrompt: _isSkippableUserPrompt,
    setPendingContinue,
    _pruneEmptyAssistantBubbles: pruneEmptyAssistantBubbles,
    regenerateFrom,
    forkFrom,
    editUserMessage,
    editAIMessage,
    resendUserMessage,
    deleteMessage,
    rewriteWith,
    continueFrom,
    _appendViewReportLink,
    hasActiveStream,
    noteRunStarted,   // #1087 (SSE self-echo double): classify a run-started edge as OUR own run vs a peer
    softReloadHistory,
    flushPendingReconcile,
    deferPeerResume,
    flushPendingPeerResume,
    _visibleMsgCount,   // F5 (dedup hardening): exposed for the reconcile-orphan browser gate
    _expectedVisibleBubbleCount, // mirror-toolturn fix: exposed for the reconcile-orphan browser gate
    _msgSeq,            // BUG 1 (ADR 0008 seq order): exposed for the render-order browser gate
    _insertBySeq,       // BUG 1: insert-by-seq choke point
    _reorderBySeq,      // BUG 1: non-destructive seq reorder (the reconcile corrector)
    _isEmptyTurnNoSave, // BUG 2 (#985 P2-B): clean-empty-turn predicate (browser gate)
    _isCastingEmptyReplyReprompt, // CASTING-RESUME-HANG Fix 3: reasoning-only casting re-prompt predicate (gate)
    _renderStreamDropRetry, // BUG 2: the user-controlled Retry control (browser gate)
    _enqueueSend,       // #985 P2-A: enqueue a send-while-streaming into the outbox (browser gate)
    _flushSendOutbox,   // #985 P2-A: drain the outbox FIFO at turn settle (browser gate)
    _sendOutbox: chatState._sendOutbox,        // #985 P2-A: the in-memory FIFO (inspected by the browser gate)
    _isStreaming: () => chatState.isStreaming, // #985 P2-A: read the live streaming flag in the browser gate
    _setOutboxDispatch,          // #985 P2-A: swap the flush dispatcher (browser gate; moved to chatOutbox.js, #1414 R3 PR6)
    _outboxAwaitingConfirm: chatState._outboxAwaitingConfirm,      // #891: dispatched-but-unconfirmed durable items (browser gate)
    _outboxFailed: chatState._outboxFailed,               // #891 F-A7: durable terminally-failed items (browser gate)
    _restoreOutboxFromStorage,   // #891: boot restore of the persisted queue (browser gate)
    _outboxConfirmDelivery,      // #891: server-row-observed delivery confirm (browser gate)
    _outboxTrackInflightSend,    // #891 order-stability: durable in-flight record for a direct send (browser gate)
    _outboxReleaseInflightSend,  // #891 order-stability: release a refused send's durable record (browser gate)
    _outboxHasBlockingSendFor,   // #891 order-stability: per-session FIFO gate for fresh sends (browser gate)
    _setDeliveryState,           // #891 F-A7: per-bubble delivery-state projection (browser gate)
    _markSendFailedById,         // #891 F-A7: mark a send terminally failed + durable (browser gate)
    _retryFailedSend,            // #891 F-A7: user-tapped Retry on a failed bubble (browser gate)
    _requeueOutboxItem,          // #891: network-failure requeue into the durable queue (browser gate)
    _persistOutbox,              // #891: persistence write point (browser gate)
    _dedupeOutboxAgainstServer,  // #891: pre-send at-most-once check (browser gate)
    _isNetworkSendFailure,       // #891: fetch-failure classifier (browser gate)
    _outboxPeekStorage,          // #891: read the persisted record (browser gate; moved to chatOutbox.js, #1414 R3 PR6)
    _updateOutboxStrip,          // #830: re-project the aggregate queue strip (browser gate)
    _syncSubmitButtonState,  // #971: reconcile the composer button to the true streaming state (browser gate)
    _foregroundStreamLive,   // #971: "is a turn genuinely streaming in the foreground" predicate (browser gate)
    _inProgressLabel,        // #986: the unified in-progress spinner label helper (browser gate)
    // #971 (browser gate only): force the internal stream flags so the button state machine can be
    // exercised across the {composer text × streaming} matrix without a real network stream. Test-only;
    // never called by app code. `sid` (the streaming session id) lets a test simulate a foreground vs.
    // backgrounded/settled run.
    _setStreamStateForTest: ({ streaming, hasAbort, sid } = {}) => {
      chatState.isStreaming = !!streaming;
      chatState.currentAbort = hasAbort ? (chatState.currentAbort || new AbortController()) : null;
      if (sid !== undefined) chatState._streamSessionId = sid;
    },
  };

  // Single delegated handler for tool-call fold/expand. One listener on
  // document.body covers every .agent-thread-node — running, completed,
  // streaming, history-rendered, compare-mode, all of them. Re-attaching
  // per-node listeners on every innerHTML rewrite was the source of the
  // "needs many clicks" bug.
  if (!window.__orwell_thread_click_bound) {
    document.body.addEventListener('click', (e) => {
      const header = e.target.closest('.agent-thread-header');
      if (!header) return;
      const node = header.closest('.agent-thread-node');
      if (!node) return;
      // L7: flat nodes (no expandable content) are plain labels — never toggle.
      if (node.classList.contains('agent-thread-node--flat')) return;
      node.classList.toggle('open');
    });
    window.__orwell_thread_click_bound = true;
  }

  export default chatModule;
  window.chatModule = chatModule;
