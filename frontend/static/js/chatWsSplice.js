// static/js/chatWsSplice.js

/**
 * #1414 (R3 PR4): the WebSocket Phase-1 chat live-splice cluster (ADR 0017 /
 * websocket-phase1-protocol.md §3).
 *
 * The next extraction from the chat.js god-object (docs/REFACTOR-ROADMAP.md, R3), building on
 * PR0 (chatState.js) + PR1 (chatScrollEdges.js) + PR2 (chatSubmitButton.js) + PR3
 * (chatAttachments.js). Moved VERBATIM from chat.js — behavior-preserving, no logic change:
 *   - _wsChatActive() — is the socket live? (dormant when the flag is off).
 *   - _wsResetRound() / _wsPinRound(round) — the per-run live-render round lifecycle.
 *   - _wsEnsureRound() — lazily mount/find the live WS bubble to render inbound frames into.
 *   - _onWsChatFrame(frame) — the persistent inbound consumer for `chat` `event` frames.
 *   - _wsRegisterChat() — register the consumer with OrwellWs once it is available.
 *
 * This cluster was already isolated behind `_wsRegisterChat` in chat.js; it holds ONE inbound
 * consumer and the transient live-render round state (`_wsRound`/`_wsRichRun`) — both module-
 * local here. The only cross-cluster hand-off is the SENDER's up-frame pin: chat.js's
 * handleChatSubmit creates the streaming holder, then pins it as the WS render target. An ES
 * imported binding is read-only, so chat.js calls `_wsPinRound({...})` here instead of
 * reassigning `_wsRound` directly (the SSE observer/peer path still mounts its own holder via
 * `_wsEnsureRound`).
 *
 * Deps that STAY in chat.js and are read here through an injected resolver (the same
 * `_setOutboxDispatch` / `_setAttachmentsApiBase` pattern as PR2/PR3 — chat.js calls
 * `_setWsSpliceDeps({...})` once at module-eval):
 *   - `_renderLiveStream` — the SHARED incremental renderer (ADR 0015 / R2 render seam). NOT a
 *     second engine; the socket path renders through the exact same function the SSE path uses.
 *     It lives in chat.js (the R2 seam) — inject, never move.
 *   - `softReloadHistory` — the idempotent, seq-aware settle reconcile (the reconcile cluster,
 *     a later R3 PR) — inject.
 *   - `_senderLabel` — the SINGLE SOURCE for an AI message's sender label (game build ⇒ the
 *     narrator, never the raw model). Inject so the single-source contract holds.
 * `chatState._streamSessionId` (the active-stream lock) is read/written through the shared
 * chatState singleton (PR0). `_shortModel` and the incremental renderer's markdown come from
 * importable modules (chatRenderer / markdown).
 *
 * chat.js imports the four call points it still drives (`_wsChatActive`, `_wsResetRound`,
 * `_wsPinRound`, `_wsRegisterChat`) plus `_setWsSpliceDeps`, and keeps the boot registration
 * (`window.OrwellWs ? _wsRegisterChat() : addEventListener('orwell:ws-ready', …)`) at its own
 * init site exactly as before. None of these functions are on the `chatModule` public API and
 * none are called cross-file, so the export object stays byte-identical.
 *
 * Dual-load idempotent (#1399 generalized): the only module-level mutable state is the transient
 * live-render round (`_wsRound`/`_wsRichRun`), set only during an active WS stream; a second
 * evaluation would start a fresh null round, which is harmless (the same stance as the sibling
 * modules). Imported BY chat.js only (never app.js / an html shell), so there is a single module
 * record in practice.
 */

import sessionModule from './sessions.js';
import uiModule from './ui.js';
import markdownModule from './markdown.js';
import chatRenderer from './chatRenderer.js';
import { chatState } from './chatState.js';

// shortModel is a chatRenderer helper (same binding chat.js uses).
const _shortModel = chatRenderer.shortModel;

// ── chat.js-internal deps injected at module-eval (see the header) ────────────────
// _renderLiveStream (R2 render seam) + softReloadHistory (reconcile) + _senderLabel
// (the single-source sender label) all stay in chat.js; chat.js injects them through
// `_setWsSpliceDeps`. Safe no-op defaults keep a bare test import inert.
let _renderLiveStream = () => {};
let _softReloadHistory = async () => {};
let _senderLabel = (modelLabel) => (modelLabel || '');
// Mount a "responding…" thinking spinner into an observer round's holder (best-effort UX). chat.js owns
// the spinner module + label; injected so a bare test import stays inert. Returns a handle with
// `.destroy()` (or null). Default is a no-op → the incremental render is unaffected if it's absent.
let _mountThinkingSpinner = () => null;
// F1 (concurrent-session consistency): render the observer's USER bubble from the run buffer's leading
// `user_message` frame, so window B shows the prompting message before its reply. The renderer lives in
// chat.js (it composes chatRenderer + the reconcile seq/skip helpers); inject it, defaulting to a no-op
// so a bare test import stays inert.
let _renderUserMessage = () => null;
export function _setWsSpliceDeps(deps) {
  if (!deps) return;
  if (deps.renderLiveStream) _renderLiveStream = deps.renderLiveStream;
  if (deps.softReloadHistory) _softReloadHistory = deps.softReloadHistory;
  if (deps.senderLabel) _senderLabel = deps.senderLabel;
  if (deps.mountThinkingSpinner) _mountThinkingSpinner = deps.mountThinkingSpinner;
  if (deps.renderUserMessage) _renderUserMessage = deps.renderUserMessage;
}

// ── WebSocket Phase-1 chat splice (ADR 0017 / websocket-phase1-protocol.md §3) ──
//
// When OrwellWs is live, the player's turn goes UP as a `turn` frame (the reroute in
// handleChatSubmit) and the reply comes back as `chat` `event` frames — the SAME
// replay-then-tail broadcast both the sender and a peer window receive. We render
// those frames through the SAME shared incremental renderer the SSE path uses
// (`_renderLiveStream` → `createStreamRenderer`, ADR 0015) — NOT a second engine —
// and we keep the reasoning split VERBATIM (§3.4): a delta with `d.thinking` truthy
// lands in the reasoning accordion, never the public reply body.  This is the exact
// `roundReplyText`/`roundReasoningText` contract, socket-side.
//
// Dormant when the flag is off (`isActive()` false): the fetch/SSE path stays
// byte-identical, so F1–F5, g15, and the reasoning-scrub gate are untouched. Full
// live finalize/dedup runs after the server route (claude/ws-phase1-server) lands.
export function _wsChatActive() {
  try { return !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive()); }
  catch (_) { return false; }
}

// The live WS round render target. When the sender fires a turn we pin its
// already-created streaming holder here (via _wsPinRound) so the inbound consumer renders into
// it — the sender's own turn. A peer/observer window has no pinned holder and mounts
// its own live bubble, exactly as resumeStream does for the SSE mirror.
let _wsRound = null;   // { holder, contentDiv, state, reply, reasoning, sessionId, clientMsgId, _spinner }
// Is the CURRENT run tool-rich (multi-round)? A rich run's narration spans N rounds that history
// reconstructs as N bubbles (chatRenderer "Agent multi-bubble reconstruction"), so its ONE live WS
// holder must never be adopted at settle — it would keep round 1..N merged in a single bubble
// beside (or in place of) the reconstruction, the mirror-toolturn divergence. Same contract as the
// SSE observer's rich resume (resumeStream rich=true: discard the live holder, reload). Reset per
// run at `done` (frames arrive in run order, `done` last).
let _wsRichRun = false;
const _wsLiveRender = (t) => markdownModule.processWithThinking(markdownModule.squashOutsideCode(t));
export function _wsResetRound() { _wsRound = null; _wsRichRun = false; }

// Pin the sender's already-created streaming holder as the live WS render target. chat.js's
// handleChatSubmit calls this (an ES imported binding is read-only, so it can't reassign _wsRound
// itself). The inbound consumer then renders reply frames into the pinned holder and runs the
// settle on `done`.
export function _wsPinRound(round) { _wsRound = round; }

export function _wsEnsureRound() {
  if (_wsRound && _wsRound.holder && _wsRound.holder.isConnected) return _wsRound;
  const box = document.getElementById('chat-history');
  if (!box) return null;
  const holder = document.createElement('div');
  holder.className = 'msg msg-ai';
  const roleLabel = _senderLabel(_shortModel(sessionModule.getCurrentModel && sessionModule.getCurrentModel()));
  const roleTs = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  holder.innerHTML = '<div class="role">' + uiModule.esc(roleLabel) +
    ' <span class="role-timestamp">' + roleTs + '</span></div>' +
    '<div class="body"><div class="stream-content"></div></div>';
  box.appendChild(holder);
  _wsRound = { holder: holder, contentDiv: holder.querySelector('.stream-content'),
               state: {}, reply: '', reasoning: '',
               sessionId: (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || null };
  // #1570 — the OBSERVER/peer live render (window B mirroring a peer's turn) mounts ITS OWN holder
  // here; the SENDER pins its holder via `_wsPinRound` and already holds `chatState._streamSessionId`.
  // Without a lock on B, `hasActiveStream(sid)` is FALSE, so a racing `softReloadHistory` (fired by a
  // `state` edge / `orwell:gamechanged`) REBUILDS the turn destructively and B lands on the static
  // reconcile path instead of this shared incremental renderer — the mirror-parity race that trips
  // `bUsesIncrementalRenderer=false`. Register the session as an active resume stream so the reconcile
  // DEFERS to the live render; released at `done` (and on a resync teardown). Mirrors resumeStream's
  // `_resumingStreams` re-attach lock (both are "a live reader owns this session's render right now").
  try { if (_wsRound.sessionId) chatState._resumingStreams.add(_wsRound.sessionId); } catch (_) {}
  uiModule.scrollHistory();
  return _wsRound;
}

// #1596 — the engine restarted mid-stream (power outage): `orwellWs` detected its committed beatSeq
// went BACKWARDS, or a reconnect found the run we were tailing GONE, and emitted `orwell:ws-resync`.
// A wedged live render will NEVER receive its `done` (the run is dead), so its holder sits half-painted
// and its active-stream lock keeps a reconcile permanently deferred. Break the wedge: tear the stale
// holder down, RELEASE the lock (so the reconcile below is not deferred by `hasActiveStream`), then
// rebuild from the authoritative history (idempotent — a converged session is a cheap no-op). This is a
// DISTINCT window event, not `orwell:gamechanged`, so the g15 single-dispatcher rule is untouched.
export function _onWsResync(ev) {
  const reason = (ev && ev.detail && ev.detail.reason) || 'unknown';
  const sid = (ev && ev.detail && ev.detail.canonicalId) ||
              (window.OrwellWs && window.OrwellWs.canonicalId && window.OrwellWs.canonicalId()) ||
              (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId()) || null;
  const round = _wsRound;
  const wasWedged = !!(round && round.holder);
  // #1599 — a resync is the AUTO-CORRECTION of a real interruption (engine restart mid-stream). It is
  // not a routine event: log it at WARN with disposition (reason + whether a wedged holder was torn
  // down) so the heal is observable, never silent. A42: it also raises the RED health event (a correction is not a cloak).
  try { if (window.OrwellReport) window.OrwellReport.fail('ws:resync-heal', String(reason), wasWedged ? 'tore down a wedged live holder' : 'no wedged holder', { red: true, corrected: 'history reconcile' }); } catch (_) {}
  try {
    console.warn('[chatWsSplice #1596] ws-resync (' + reason + ') — reconciling from history' +
      (wasWedged ? '; tore down a wedged live holder' : '') + ' (auto-corrected).');
  } catch (_) {}
  if (round && round._spinner) { try { round._spinner.destroy(); } catch (_) { /* best-effort DOM cleanup */ } }
  if (round && round.holder) { try { round.holder.remove(); } catch (_) { /* best-effort DOM cleanup */ } }
  _wsResetRound();
  // Release the active-stream lock whether it was pinned to the canonical id OR the tab's OWN
  // round.sessionId (Greptile #1609): after canonical adoption those DIFFER, and the sender lock in
  // `chatState._streamSessionId` holds `round.sessionId` (from `_wsPinRound`). Clearing only on `sid`
  // would leave `hasActiveStream(round.sessionId)` true, so the history reconcile keeps deferring and
  // the wedge remains. Release both, and drop both from the resuming-streams set.
  const pinnedSid = round && round.sessionId;
  if (sid) { try { chatState._resumingStreams.delete(sid); } catch (_) { /* Set may be absent in a bare test import */ } }
  if (pinnedSid && pinnedSid !== sid) { try { chatState._resumingStreams.delete(pinnedSid); } catch (_) { /* best-effort */ } }
  if (chatState._streamSessionId && (chatState._streamSessionId === sid || chatState._streamSessionId === pinnedSid)) {
    chatState._streamSessionId = null;
  }
  if (sid) {
    // A reconcile that THROWS is a real render failure — surface it (never swallow), then let the next
    // reconcile trigger retry. A42: it also raises the RED health event (uncorrected until a later reconcile succeeds).
    Promise.resolve().then(() => _softReloadHistory(sid)).catch((e) => {
      try { if (window.OrwellReport) window.OrwellReport.fail('ws:resync-reconcile-failed', 'ReconcileThrew', (e && e.message) || String(e), { red: true }); } catch (_) {}
      try { console.error('[chatWsSplice #1596] ws-resync history reconcile FAILED for ' + sid + ':', e); } catch (_) {}
    });
  }
}

// orwellWs re-attached to a genuinely-NEW run (`orwell:ws-run-boundary`; reconcile-by-id already applied
// upstream, so this fires ONCE per new run, never on a stale replay). The OBSERVER must start a FRESH
// live round for it: the server started a new per-run buffer and cancelled the old chat channel, so the
// new run's replayed deltas are about to arrive — if the PRIOR run's holder is still `_wsRound`, those
// deltas render into it (`_wsEnsureRound` reuses a connected holder) and B never mounts a fresh streaming
// container → the mirror-parity WS-leg `incrementalStream=false` divergence, AND a mid-stream "responding…"
// gap where the mirror sits blank until the first delta. Reset the round here so the new run mounts its
// OWN holder, and mount that holder + a thinking spinner IMMEDIATELY so window B shows live feedback the
// instant the peer's turn starts (bounding the blank window to edge-propagation, not first-delta time).
//
// Guard: skip when THIS window is the active SENDER — it pinned its own round via `_wsPinRound` and
// settles it on its own `done`; resetting here would tear the sender's own live bubble down. The sender
// holds `chatState._streamSessionId`; the observer never does. Mirrors the SSE observer's `!_isOwnRun`
// filter (sessionSync.js), which is why the SSE leg never had this divergence.
export function _onWsRunBoundary() {
  try { if (chatState._streamSessionId) return; } catch (_) { /* observer path only */ }
  const prior = _wsRound;
  const priorRich = _wsRichRun;   // capture BEFORE _wsResetRound() clears it
  if (prior && prior.holder) {
    // Settle the PRIOR observer round like a synthetic `done`: release the #1570 live-render lock (so a
    // reconcile of the prior run isn't deferred) and reset.
    const priorSid = prior.sessionId ||
                     (window.OrwellWs && window.OrwellWs.canonicalId && window.OrwellWs.canonicalId()) || null;
    if (prior._spinner) { try { prior._spinner.destroy(); } catch (_) { /* best-effort */ } }
    // A RICH (multi-round tool) run's live holder holds rounds 1..N MERGED — never adoptable (history
    // reconstructs the run as N bubbles). Discard it, mirroring the `done` branch: otherwise
    // softReloadHistory's orphan detection sees the merged holder mismatch the N-bubble reconstruction
    // and forces a full DESTRUCTIVE rebuild instead of the cheap adopt path (avoidable churn — exactly
    // the case this PR's interrupt-mid-tail scenario can hit). A plain (single-round) run's holder is
    // adoptable by {id, seq}, so it stays in the DOM and its own settle/history reconcile adopts it.
    if (priorRich) { try { prior.holder.remove(); } catch (_) { /* best-effort DOM cleanup */ } }
    _wsResetRound();
    if (priorSid) { try { chatState._resumingStreams.delete(priorSid); } catch (_) { /* Set may be absent in a bare import */ } }
  }
  // Mount the fresh round NOW (before the first delta) so the mirror shows immediate "responding…"
  // feedback instead of a blank window; the new run's deltas then render into this same holder.
  const round = _wsEnsureRound();
  if (round && round.holder && !round._spinner) {
    try { round._spinner = _mountThinkingSpinner(round.holder); } catch (_) { /* best-effort UX only */ }
  }
}

// The persistent inbound consumer — registered ONCE, drives every `chat` event frame.
// F-2/F-4/T0-3 — the production CHYRON on the WebSocket leg. The SSE loop (chat.js) dispatches
// `orwell:announcements` from (a) the OWED `{"announcements":[…]}` event the agent loop emits for a beat the
// FE pre-resolved and (b) an advanceGame/submitDecision tool result. This consumer is the default transport
// (ORWELL_WS_TRANSPORT default-ON, #1357) and had NO branch for either, so on WS the engine's authoritative
// chyron never rendered — while the T0-3 hard-drop rail had already removed the model's restatement of the
// same fact (A-15 rehearsal 2026-11-03: 0 announcement events over ~40 turns). `_renderChyronBatch` dedups
// by announcement id, so a frame seen on both legs can never double-render.
function _dispatchAnnouncements(list) {
  if (!Array.isArray(list) || !list.length) return;
  try { window.dispatchEvent(new CustomEvent('orwell:announcements', { detail: { announcements: list } })); } catch (_) {}
}

export function _onWsChatFrame(frame) {
  const d = (frame && frame.d) || {};
  if (Array.isArray(d.announcements)) { _dispatchAnnouncements(d.announcements); return; }
  // F1 (concurrent-session consistency): the run buffer leads with the prompting USER turn (seq 0),
  // so it arrives BEFORE any assistant delta. Render the observer's user bubble AHEAD of the reply
  // holder (`_wsRound.holder` if a run-boundary already pre-mounted it, else it lands in seq order and
  // the reply holder mounts after). The SENDER's own bubble already exists → the renderer dedups by
  // clientMsgId and only stamps {id, seq} (never a duplicate). Cause-before-effect on the WS leg too.
  if (d.type === 'user_message') {
    try { _renderUserMessage(d, { beforeEl: (_wsRound && _wsRound.holder) || null }); } catch (_) {}
    return;
  }
  // A tool/agent-round marker ⇒ this run is RICH (multi-round). The WS splice renders the whole
  // run into one holder (it has no per-round bubble machinery), so flag it — the `done` branch
  // discards the merged holder and lets softReloadHistory rebuild the N-bubble reconstruction.
  if (d.type === 'agent_step' || d.type === 'tool_start' || d.type === 'tool_output' || d.type === 'tool_progress') {
    _wsRichRun = true;
    // The model's own advanceGame/submitDecision result carries the same Vault-free `announcements` (chat.js seam).
    if (d.type === 'tool_output' && (d.tool === 'advanceGame' || d.tool === 'submitDecision')) {
      try { const _adv = JSON.parse(d.output || '{}'); _dispatchAnnouncements(_adv && _adv.announcements); } catch (_) {}
    }
    return;
  }
  if (typeof d.delta === 'string') {
    const round = _wsEnsureRound();
    if (!round) return;
    if (round._spinner) { try { round._spinner.destroy(); } catch (_) {} round._spinner = null; }
    // The reasoning CHANNEL SPLIT is sacred (§3.4): thinking → the accordion, the
    // clean reply → the body. `_renderLiveStream` places reasoning in a default-
    // collapsed `.thinking-section` and the reply in `.live-reply-content` — reasoning
    // can NEVER paint in the public reply container, by construction.
    if (d.thinking) round.reasoning += d.delta;
    else            round.reply += d.delta;
    _renderLiveStream(round.contentDiv, round.reply, round.reasoning, _wsLiveRender, round.state, round.holder);
    return;
  }
  if (d.type === 'message_saved') {
    // Stamp the server db id so the settle reconcile adopts THIS bubble with zero
    // churn (mirrors resumeStream's savedDbId — no db-id-less duplicate).
    if (_wsRound && _wsRound.holder && d.id != null) _wsRound.holder.dataset.dbId = String(d.id);
    // M2-6: the beat's IN-WORLD moment rides the same event (chat_routes) — show it on the
    // LIVE mirror bubble too, so window B reads "Week 1 · Eviction night" during the stream
    // exactly like the sender + the reload render (chatRenderer.roleTimestamp), instead of the
    // wall clock until the settle reconcile. Wall clock demoted to hover/dataset (parity, ADR
    // 0012). Absent moment ⇒ untouched (neutral wall-clock stamp). Timestamps are excluded from
    // the mirror-parity transcript diff, so this is presentation-only.
    if (_wsRound && _wsRound.holder && typeof d.moment === 'string' && d.moment.trim()) {
      var _ts = _wsRound.holder.querySelector('.role-timestamp');
      if (_ts) {
        // Demote the wall clock to hover/dataset BEFORE swapping the visible text to the moment,
        // the SAME way chat.js _applyServerTimestamp / chatRenderer.js roleTimestamp do: prefer the
        // SERVER-minted `d.ts` (the message_saved frame carries it) so the hover reads identically
        // across windows; fall back to the bubble's existing wall-clock text if `ts` is absent/bad.
        var _wd = d.ts ? new Date(d.ts) : null;
        if (_wd && !isNaN(_wd.getTime())) {
          _ts.title = _wd.toLocaleString();
          _ts.dataset.wallClock = _wd.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else {
          _ts.dataset.wallClock = _ts.textContent;
        }
        _ts.textContent = d.moment.trim();
        _ts.classList.add('role-timestamp-moment');
      }
    }
    return;
  }
  if (d.done) {
    // Terminal sentinel (maps `[DONE]`, §3.2). Release the live holder and run the
    // settle reconcile from history — the SAME idempotent, seq-aware softReloadHistory
    // the SSE path settles through; it adopts the streamed bubble by {id, seq}.
    const round = _wsRound;
    const rich = _wsRichRun;
    const sid = (round && round.sessionId) ||
                (window.OrwellWs && window.OrwellWs.canonicalId && window.OrwellWs.canonicalId()) ||
                (sessionModule.getCurrentSessionId && sessionModule.getCurrentSessionId());
    if (round && round._spinner) { try { round._spinner.destroy(); } catch (_) {} }
    // A RICH (multi-round) run's live holder holds rounds 1..N MERGED — never adoptable (history
    // reconstructs the turn as N bubbles). Discard it; the reload below rebuilds the real shape.
    // Mirrors the SSE observer's rich resume contract (mirror-toolturn parity, #1087).
    if (rich && round && round.holder) { try { round.holder.remove(); } catch (_) {} }
    _wsResetRound();
    // #1570 — release the OBSERVER live-render lock (added in _wsEnsureRound) so the settle reconcile
    // below can actually rebuild. Harmless no-op for the SENDER (it never took the resuming lock).
    if (sid) { try { chatState._resumingStreams.delete(sid); } catch (_) {} }
    if (sid && chatState._streamSessionId === sid) chatState._streamSessionId = null; // release the active-stream lock
    if (sid) { try { _softReloadHistory(sid); } catch (_) {} }
    return;
  }
}

export function _wsRegisterChat() {
  try { if (window.OrwellWs && window.OrwellWs.onFrame) window.OrwellWs.onFrame('chat', _onWsChatFrame); }
  catch (_) {}
}
