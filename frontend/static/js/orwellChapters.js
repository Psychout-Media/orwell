// static/js/orwellChapters.js
//
// ORW-275 (Lane B half): WEEK CHAPTERS. A played game is one transcript underneath (one canonical session, nothing deleted or split), but the
// screen shows ONE game week at a time: the current week by default, with the earlier weeks one tap away in a small bar above the chat.
// That keeps a long game from rebuilding thousands of bubbles on every open/reconcile.
//
// This module is PURE except for the bar and a per-session view map. The two history choke points (sessions.js selectSession and
// chatReconcile.js softReloadHistory) call `rowsFor(sessionId, history)` and render only those rows; everything downstream (adopt pass,
// seq reorder, converged/diverged check, rebuild) therefore works on the chapter's rows and stays self-consistent. With fewer than two
// chapters (casting, a first week, any non-game chat) `rowsFor` returns the SAME array untouched and no bar is shown (byte-identical).
//
// Chapter key: `metadata.week` (int, stamped by the engine side) when present, else the "Week N" in `metadata.game_moment`
// ("Week 2 · Veto competition · Evening"). A row with neither inherits the previous row's chapter (leading ones, e.g. casting, inherit the first).

const WEEK_RE = /\bWeek\s+(\d+)\b/i;

/** The chapter (game week) a stored message belongs to, or null when it carries neither a numeric week nor a game moment. */
export function chapterOfMessage(msg) {
  const md = msg && msg.metadata;
  if (!md) return null;
  if (Number.isInteger(md.week) && md.week >= 0) return md.week;
  if (typeof md.game_moment === 'string') {
    const m = WEEK_RE.exec(md.game_moment);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** True for the numeric, engine-stamped week (authoritative) as opposed to a "Week N" parsed out of game_moment text. */
function _hasNumericWeek(msg) {
  const md = msg && msg.metadata;
  return !!md && Number.isInteger(md.week) && md.week >= 0;
}

/** { weeks: [asc unique], current, rowWeek: [chapter per row, carry-forward filled] } for a history array.
 * A numeric `metadata.week` is honoured as stamped, which is how the eviction-night goodnight reply (saved AFTER the new week's chapter row but stamped with the OLD week)
 * stays at the end of the week it closes. Every other row (parsed from game_moment, or carrying nothing) takes the running maximum, so a stray older text stamp can never
 * reopen an earlier chapter. */
export function chapterIndex(history) {
  const rows = Array.isArray(history) ? history : [];
  const raw = rows.map(chapterOfMessage);
  const firstIdx = raw.findIndex((w) => w !== null);
  const rowWeek = [];
  let max = firstIdx === -1 ? null : raw[firstIdx];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (w !== null && _hasNumericWeek(rows[i])) {
      rowWeek.push(w);                       // authoritative stamp: keep it, but never lower the running maximum
      if (max === null || w > max) max = w;
    } else {
      if (w !== null && (max === null || w > max)) max = w;
      rowWeek.push(max);
    }
  }
  const weeks = Array.from(new Set(rowWeek.filter((w) => w !== null))).sort((a, b) => a - b);
  return { weeks, current: weeks.length ? weeks[weeks.length - 1] : null, rowWeek };
}

/** Chapters apply only when the transcript spans at least two game weeks. */
export function chaptersActive(history) {
  return chapterIndex(history).weeks.length >= 2;
}

/** The rows to render for `view` ('current' or a week number). Same array back when chapters are not active. */
export function sliceForView(history, view) {
  const idx = chapterIndex(history);
  if (idx.weeks.length < 2) return history;
  const want = view === 'current' || view == null || !idx.weeks.includes(view) ? idx.current : view;
  return history.filter((_, i) => idx.rowWeek[i] === want);
}

// ── per-session view state (a plain map; the viewer's own choice, never persisted) ───────────────────────────────
const _views = new Map();
export function getView(sessionId) { return _views.has(sessionId) ? _views.get(sessionId) : 'current'; }
export function setView(sessionId, view) {
  if (view === 'current' || view == null) _views.delete(sessionId); else _views.set(sessionId, view);
  try { window.dispatchEvent(new CustomEvent('orwell:chapter-view', { detail: { sessionId, view: getView(sessionId) } })); } catch (_) { /* no window in tests */ }
}

/** Kill switch for the viewer: localStorage['orwell.chapters'] === '0' turns the feature off (whole transcript, no bar). */
function _enabled() {
  try { return !(typeof localStorage !== 'undefined' && localStorage.getItem('orwell.chapters') === '0'); } catch (_) { return true; }
}

/** The rows a history render/reconcile should use for this session. Also refreshes the bar and the "show earlier" button. */
export function rowsFor(sessionId, history) {
  if (!_enabled() || !Array.isArray(history)) { updateBar(null, null); updateMore(null); return history; }
  const idx = chapterIndex(history);
  if (idx.weeks.length < 2) { updateBar(null, null); return windowRows(sessionId, 'all', history); }
  let view = getView(sessionId);
  if (view !== 'current' && !idx.weeks.includes(view)) { _views.delete(sessionId); view = 'current'; }
  const want = view === 'current' ? idx.current : view;
  updateBar(sessionId, { weeks: idx.weeks, current: idx.current, viewing: want, isCurrent: want === idx.current });
  return windowRows(sessionId, String(want), history.filter((_, i) => idx.rowWeek[i] === want));
}

// ── ORW-161: bounded history render ──────────────────────────────────────────────────────────────────────────────
// Even inside one chapter (or a non-game chat) a long transcript rebuilt every bubble on every open/reconcile. Past WINDOW_MAX rows only the newest WINDOW_INIT are rendered, with a
// "Show earlier messages" button above the chat that reveals WINDOW_STEP more per tap. The window is ANCHORED on a row's `seq` (not "the last N"), so a new message appends below
// without pushing the oldest bubble out: the rendered id order stays a plain prefix-free match of the rows and the reconcile's converged check keeps its zero-churn contract.
// A row without an integer seq, or a transcript of at most WINDOW_MAX rows, returns the SAME array untouched (byte-identical to before).
export const WINDOW_MAX = 80;
export const WINDOW_INIT = 50;
export const WINDOW_STEP = 60;
const _anchors = new Map(); // `${sessionId}|${view}` -> the seq of the oldest rendered row

function _seqOf(m) { return m && Number.isInteger(m.seq) ? m.seq : null; }

/** Pure: the window over `rows` for an optional anchor seq. Returns { rows, hidden, anchor } (anchor null = nothing windowed). */
export function windowOver(rows, anchor) {
  if (!Array.isArray(rows)) return { rows, hidden: 0, anchor: null };
  let from = 0;
  if (anchor != null) {
    from = rows.findIndex((m) => { const q = _seqOf(m); return q !== null && q >= anchor; });
    if (from < 0) from = 0;
  } else if (rows.length > WINDOW_MAX) {
    from = rows.length - WINDOW_INIT;
  }
  if (from <= 0) return { rows, hidden: 0, anchor: null };
  const q = _seqOf(rows[from]);
  if (q === null) return { rows, hidden: 0, anchor: null };
  return { rows: rows.slice(from), hidden: from, anchor: q };
}

export function windowRows(sessionId, view, rows) {
  const key = sessionId + '|' + view;
  const w = windowOver(rows, _anchors.has(key) ? _anchors.get(key) : null);
  if (w.anchor == null) { updateMore(null); return rows; } // an anchor of -1 ("show all") stays stored so a long chat the viewer fully expanded is not re-windowed
  _anchors.set(key, w.anchor);
  updateMore({ sessionId, key, hidden: w.hidden, rows, anchor: w.anchor });
  return w.rows;
}

/** Reveal WINDOW_STEP more older rows (or all, when fewer remain) and ask the shared reconcile to re-render. */
export function showEarlier(sessionId, key, rows, anchor) {
  const at = rows.findIndex((m) => _seqOf(m) === anchor);
  const to = Math.max(0, (at < 0 ? 0 : at) - WINDOW_STEP);
  const q = to > 0 ? _seqOf(rows[to]) : null;
  _anchors.set(key, q == null ? -1 : q);
  try {
    const box = document.getElementById('chat-history');
    if (box && typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(() => { mo.disconnect(); setTimeout(() => { box.scrollTop = 0; }, 50); });
      mo.observe(box, { childList: true });
      setTimeout(() => mo.disconnect(), 4000);
    }
    window.dispatchEvent(new CustomEvent('orwell:chapter-view', { detail: { sessionId, view: getView(sessionId) } }));
  } catch (_) { /* no window in tests */ }
}

const MORE_ID = 'orwell-history-more';
export function updateMore(info) {
  if (typeof document === 'undefined') return;
  let btn = document.getElementById(MORE_ID);
  if (!info) { if (btn) btn.remove(); return; }
  const box = document.getElementById('chat-history');
  if (!box || !box.parentNode) return;
  if (!btn) {
    btn = _h('button', 'ow-history-more');
    btn.id = MORE_ID;
    btn.type = 'button';
    box.parentNode.insertBefore(btn, box);
  }
  btn.textContent = 'Show earlier messages (' + info.hidden + ')';
  btn.onclick = () => showEarlier(info.sessionId, info.key, info.rows, info.anchor);
}

// ── the bar ──────────────────────────────────────────────────────────────────────────────────────────────────────
const BAR_ID = 'orwell-chapter-bar';

function _h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

export function updateBar(sessionId, info) {
  if (typeof document === 'undefined') return;
  const box = document.getElementById('chat-history');
  let bar = document.getElementById(BAR_ID);
  if (!info) { if (bar) bar.remove(); return; }
  if (!box || !box.parentNode) return;
  if (!bar) {
    bar = _h('div', 'ow-chapter-bar');
    bar.id = BAR_ID;
    bar.setAttribute('role', 'navigation');
    bar.setAttribute('aria-label', 'Game weeks');
    box.parentNode.insertBefore(bar, box);
  }
  bar.dataset.sessionId = sessionId;
  bar.dataset.viewing = String(info.viewing);
  bar.textContent = '';
  if (info.isCurrent) {
    bar.appendChild(_h('span', 'ow-chapter-title', 'Week ' + info.viewing));
  } else {
    bar.appendChild(_h('span', 'ow-chapter-title', 'Reading Week ' + info.viewing));
    const back = _h('button', 'ow-chapter-back', 'Back to current week');
    back.type = 'button';
    back.dataset.action = 'current';
    back.addEventListener('click', () => setView(sessionId, 'current'));
    bar.appendChild(back);
  }
  const past = info.weeks.filter((w) => w !== info.viewing);
  if (past.length) {
    const label = info.isCurrent ? 'Past weeks' : 'Other weeks';
    const sel = _h('select', 'ow-chapter-select');
    sel.setAttribute('aria-label', label);
    sel.appendChild(Object.assign(_h('option', '', label), { value: '' }));
    for (const w of past.slice().reverse()) {
      const o = _h('option', '', w === info.current ? 'Week ' + w + ' (current)' : 'Week ' + w);
      o.value = String(w);
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      const w = parseInt(sel.value, 10);
      setView(sessionId, w === info.current ? 'current' : w);
    });
    bar.appendChild(sel);
  }
}

/**
 * While the viewer is reading a PAST week, any NEW live message (their own send, a mirrored window's reply, a streaming holder) would be appended under that old week.
 * Watch the chat box once: a new non-history bubble while viewing a past week snaps the view back to the current week (the listener in chatReconcile.js re-renders it).
 * Bubbles painted from history carry `data-from-history`, so our own rebuilds never trigger this.
 */
let _guardInstalled = false;
export function installLiveGuard(getCurrentSessionId) {
  if (_guardInstalled || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  const box = document.getElementById('chat-history');
  if (!box) return;
  _guardInstalled = true;
  new MutationObserver((muts) => {
    const sid = getCurrentSessionId && getCurrentSessionId();
    if (!sid || getView(sid) === 'current') return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n && n.nodeType === 1 && n.classList && n.classList.contains('msg') && !(n.dataset && n.dataset.fromHistory)) {
          setView(sid, 'current');
          return;
        }
      }
    }
  }).observe(box, { childList: true });
}

/** The recap card shown for the week-chapter boundary row (metadata {kind:'week-chapter', week, recap:{evicted:string[], hoh:string|null, standing:string}}). Vault-free strings only; `esc` escapes. */
export function weekChapterCardHtml(md, esc) {
  const e = typeof esc === 'function' ? esc : (x) => String(x);
  const r = (md && md.recap) || {};
  const out = Array.isArray(r.evicted) ? r.evicted.filter((x) => typeof x === 'string' && x) : [];
  const parts = ['<div class="ow-week-card"><div class="ow-week-card-title">Week ' + e(String(md && md.week)) + '</div>'];
  if (out.length) parts.push('<div class="ow-week-card-line"><strong>Out:</strong> ' + out.map(e).join(', ') + '</div>');
  if (typeof r.hoh === 'string' && r.hoh) parts.push('<div class="ow-week-card-line"><strong>Head of Household:</strong> ' + e(r.hoh) + '</div>');
  if (typeof r.standing === 'string' && r.standing) parts.push('<div class="ow-week-card-line">' + e(r.standing) + '</div>');
  parts.push('</div>');
  return parts.join('');
}
