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

/** { weeks: [asc unique], current, rowWeek: [chapter per row, carry-forward filled] } for a history array. */
export function chapterIndex(history) {
  const rows = Array.isArray(history) ? history : [];
  const raw = rows.map(chapterOfMessage);
  const first = raw.find((w) => w !== null);
  const rowWeek = [];
  let prev = first === undefined ? null : first;
  for (const w of raw) {
    if (w !== null) prev = w;
    rowWeek.push(prev);
  }
  // A transcript's weeks only ever move forward; take the running max so a stray stamp can never reopen an older chapter.
  let max = null;
  for (let i = 0; i < rowWeek.length; i++) {
    if (rowWeek[i] === null) continue;
    if (max === null || rowWeek[i] > max) max = rowWeek[i];
    rowWeek[i] = max;
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

/** The rows a history render/reconcile should use for this session. Also refreshes the bar. */
export function rowsFor(sessionId, history) {
  if (!_enabled() || !Array.isArray(history)) { updateBar(null, null); return history; }
  const idx = chapterIndex(history);
  if (idx.weeks.length < 2) { updateBar(null, null); return history; }
  let view = getView(sessionId);
  if (view !== 'current' && !idx.weeks.includes(view)) { _views.delete(sessionId); view = 'current'; }
  const want = view === 'current' ? idx.current : view;
  updateBar(sessionId, { weeks: idx.weeks, current: idx.current, viewing: want, isCurrent: want === idx.current });
  return history.filter((_, i) => idx.rowWeek[i] === want);
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
