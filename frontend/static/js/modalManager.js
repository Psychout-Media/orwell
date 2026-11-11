/**
 * ModalManager — unified open/minimize/close behavior for tool modals.
 *
 * Goals:
 *  - Tab-down (swipe) and the `_` button MINIMIZE: modal hidden, JS state preserved.
 *  - The ✕ button CLOSES: tears down via the registered closeFn.
 *  - Sidebar/rail click handler: closed → open, minimized → restore, open → minimize.
 *  - Rail icon shows a "minimized" badge when state is held.
 *
 * Usage from a tool module:
 *
 *   import * as Modals from './modalManager.js';
 *
 *   // After building the modal element and adding it to the body:
 *   Modals.register('gallery-modal', {
 *     railBtnId: 'tool-gallery-btn',
 *     restoreFn: () => { ...whatever the tool needs to do when un-hiding... },
 *     closeFn:   () => { ...full teardown — remove modal element etc... },
 *   });
 *
 *   // From the sidebar/rail button click handler:
 *   if (!Modals.toggle('gallery-modal')) {
 *     // No registered modal — build and open it fresh.
 *     openGallery();
 *   }
 */

import { previewZoneAt, clearPreview, snapModalToZone } from './tileManager.js';
import { suspendDock, resumeDock, clearRightDock, applyEdgeDock } from './modalSnap.js';
import { dismissOrRemove } from './escMenuStack.js';
import { isNarrow } from './platform.js';

const _state = new Map(); // id -> { restoreFn, closeFn, railBtnId, isMinimized, restoreMinHeight }

const _rememberedDockKey = (id) => `orwell-modal-remembered-dock-${id}`;
function _rememberDock(id, side) {
  if (!id || !side) return;
  try { localStorage.setItem(_rememberedDockKey(id), side); } catch (_) {}
}
function _forgetDock(id) {
  if (!id) return;
  try { localStorage.removeItem(_rememberedDockKey(id)); } catch (_) {}
}
function _getRememberedDock(id) {
  try {
    const side = localStorage.getItem(_rememberedDockKey(id));
    return (side === 'left' || side === 'right') ? side : null;
  } catch (_) {
    return null;
  }
}
function _applyRememberedDock(id) {
  const side = _getRememberedDock(id);
  if (!side) return;
  const modal = document.getElementById(id);
  if (!modal || modal.classList.contains('hidden') || modal.classList.contains('modal-minimized')) return;
  try { applyEdgeDock(modal, side); } catch (e) { console.warn('apply remembered dock failed', e); }
}

// Surface a tool window to the top of the stack. ONE z-authority (Lane G14 /
// DWE audit F9b): ui.js's Escape-arbiter counter (window._owPromoteModal —
// plain inline z, 1000s, the same ladder pickTopModal reads) is the single
// stacking authority for the whole .modal family. This used to be a second
// counter here (a 300s ladder stamped with bang-priority): a minimized
// window held that stale stamp for its whole parked life, every dock restore
// wrote z three times, and the final order only survived because ui.js's
// body-wide observer always got the last write. Kit windows (.ow-window —
// NOT .modal) are deliberately untouched: the kit re-asserts its own 500–980
// band in raise()/_afterDockRestore().
function _bringToFront(modal) {
  if (!modal || !modal.classList || !modal.classList.contains('modal')) return;
  if (typeof window._owPromoteModal === 'function') {
    window._owPromoteModal(modal);
    return;
  }
  // Fallback (ui.js not loaded): the same shared ladder by inspection — top
  // inline z across the .modal family + 1, starting above the static CSS
  // band (base .modal = 250, cookbook/theme = 260). Plain inline only.
  let top = 999;
  document.querySelectorAll('.modal').forEach((m) => {
    const z = parseInt(m.style.zIndex, 10);
    if (Number.isFinite(z) && z > top) top = z;
  });
  modal.style.zIndex = String(top + 1);
}

function _emitModalOpened(id, modal) {
  try {
    window.dispatchEvent(new CustomEvent('orwell:modal-opened', {
      detail: { id, modal },
    }));
  } catch (_) {}
}

function _captureRestoreHeight(modal, state) {
  if (!modal || !state) return;
  const content = modal.querySelector('.modal-content');
  if (!content) return;
  if (modal.id === 'email-lib-modal'
      && (modal.classList.contains('modal-left-docked')
          || modal.classList.contains('email-snap-left')
          || document.body.classList.contains('email-doc-split-active'))) {
    delete state.restoreMinHeight;
    return;
  }
  const rect = content.getBoundingClientRect();
  if (!rect || rect.height < 120) return;
  const maxHeight = Math.max(180, window.innerHeight - 24);
  const minHeight = modal.id === 'email-lib-modal' && !isNarrow()
    ? Math.min(560, maxHeight)
    : 0;
  state.restoreMinHeight = `${Math.round(Math.max(minHeight, Math.min(rect.height, maxHeight)))}px`;
}

function _applyRestoreHeight(modal, state) {
  if (!modal || !state?.restoreMinHeight) return;
  const content = modal.querySelector('.modal-content');
  if (!content) return;
  const maxHeight = Math.max(180, window.innerHeight - 24);
  const requested = parseInt(state.restoreMinHeight, 10);
  const minHeight = modal.id === 'email-lib-modal' && !isNarrow()
    ? Math.min(560, maxHeight)
    : 0;
  const height = Number.isFinite(requested) ? Math.max(minHeight, Math.min(requested, maxHeight)) : null;
  if (height) content.style.minHeight = `${height}px`;
}

function _setBadge(btnIds, on) {
  if (!btnIds) return;
  const ids = Array.isArray(btnIds) ? btnIds : [btnIds];
  for (const id of ids) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('rail-minimized', on);
  }
}

// ── Bottom dock — visible chip per minimized modal ──

const _LABELS = {
  'cookbook-modal':    { label: 'Cookbook',  icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>' },
  'calendar-modal':    { label: 'Calendar',  icon: 'M3 4h18v18H3zM16 2v4M8 2v4M3 10h18' },
  'gallery-modal':     { label: 'Gallery',   icon: 'M3 3h18v18H3zM8.5 8.5l3 3M21 15l-5-5L5 21' },
  'tasks-modal':       { label: 'Tasks',     icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' },
  'doclib-modal':      { label: 'Library',   icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2zM9 7h6M9 11h4' },
  // Full SVG markup (not a single path-d) — the rounded-lobe brain needs
  // three sub-paths, which the dock renderer supports when the icon string
  // contains '<'.
  'memory-modal':      { label: 'Brain',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/></svg>' },
  'notes-panel':       { label: 'Notes',     icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3h10l4 4v14H5z"/><path d="M15 3v5h5"/><path d="M8 17.5 15.5 10l2.5 2.5L10.5 20H8z"/></svg>' },
  'email-lib-modal':   { label: 'Email',     icon: 'M2 4h20v16H2zM22 7l-9.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7' },
  // The Prompt window (characters / inject / group). Syringe = "prompt" icon,
  // matching its title bar. Full SVG markup (multi-path) per the dock renderer.
  'custom-preset-modal': { label: 'Prompt',  icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 2 4 4"/><path d="m17 7 3-3"/><path d="M19 9 8.7 19.3c-1 1-2.5 1-3.4 0l-.6-.6c-1-1-1-2.5 0-3.4L15 5"/><path d="m9 11 4 4"/><path d="m5 19-3 3"/><path d="m14 4 6 6"/></svg>' },
  'research-overlay':  { label: 'Research',  icon: 'M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0M21 21l-4.35-4.35M11 8L11 14M8 11L14 11' },
  'theme-modal':       { label: 'Theme',     icon: 'M12 2a10 10 0 1 0 10 10c0-1-1-2-2-2h-2a2 2 0 0 1 0-4h1a2 2 0 0 0 0-4 10 10 0 0 0-7-2zM7.5 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM12 7.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM16.5 12a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z' },
  'compare-model-overlay': { label: 'Compare',  icon: 'M8 3v18M16 3v18M3 8h5M16 16h5' },
  'settings-modal':    { label: 'Settings',  icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.4.4.62.94.6 1.51V11a2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' },
  'ge-shortcuts-modal':{ label: 'Shortcuts', icon: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10' },
  // Virtual id — the doc editor pane isn't a modal, but it minimizes to a
  // chip via the same dock infrastructure.
  'doc-panel':         { label: 'Document', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8' },
};

// #573 B — RAIL UNIFICATION (WAY-7 / J2-09/04/05): the ONE parked-window destination in the
// GAME BUILD is the control-room gadget rail — so both a MINIMIZED window (its "Windows" chip)
// and a DOCKED window (0054 Phase 2) now live in the single control room, closing the two-
// destinations split the audit tracked. This is a THIN ALIAS: minimize/restore semantics are
// unchanged (same chip, same ids, same #minimized-dock element) — only the chip strip's HOME
// moves. The chip dock is homed as a SIBLING of #gadget-rail-body (below the scrolling gadgets
// + the collapsed icon strip), NOT inside the body: the body is display:none when the rail
// collapses, and its children are the rail's draggable/orderable GADGETS — a sibling stays out
// of BOTH, so a parked chip is never hidden by a collapse and is never mistaken for a gadget.
// The full inherited build (no rail) keeps the legacy nav-sidebar "Windows" cluster verbatim.
// (Gesture unification — minimize == dock — is the next increment; the finale/cast chip-park
// refresh-persistence gate (G16) still pins the chip path, so it stays intact here.)
function _homeDock(dock) {
  const rail = document.getElementById('gadget-rail');
  if (rail) {
    if (dock.parentElement !== rail) rail.appendChild(dock);   // the control room is the ONE dock home
    return;
  }
  // FULL BUILD (no rail): the legacy nav-sidebar "Windows" cluster (E95 / ruling #10) — unchanged.
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) { if (dock.parentElement !== document.body) document.body.appendChild(dock); return; }
  if (dock.parentElement === sidebar) return;                  // already homed in the sidebar
  const userBar = sidebar.querySelector('.sidebar-user-bar');
  if (userBar) sidebar.insertBefore(dock, userBar);            // above the user bar (bottom of the sidebar)
  else sidebar.appendChild(dock);
}

function _ensureDock() {
  let dock = document.getElementById('minimized-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.id = 'minimized-dock';
    // E95 (ruling #10): minimized windows dock as rows in a "Windows" cluster — never as
    // chips parked over the chatbox.
    dock.innerHTML = '<div class="minimized-dock-hd">Windows</div><div class="minimized-dock-rows"></div>';
  }
  _homeDock(dock);   // #573 B: (re-)home into the control-room rail (game build) or the sidebar (full build)
  return dock;
}

// #573 B: the parked-chip set changed — let the gadget rail re-run its content-driven
// visibility so a freshly-parked chip reveals the (otherwise-empty) control room, and the last
// restored/closed chip lets it hide again. A DISTINCT event from the g15 game-changed freshness
// signal (whose sole dispatcher stays platform.js); orwellGadgetRail.js listens for this and
// never re-mints it. No-op in the full build (no rail listens). NB: the dock still re-renders ONLY
// on a real dock mutation (minimize/restore/close) — this fires FROM _renderDock, not a poll (#752).
function _notifyDockChanged() {
  try { window.dispatchEvent(new CustomEvent('orwell:dock-changed')); } catch (_) {}
}

// Manual order users can rearrange via drag.
let _dockOrder = [];
// Per-chip free-floating position (mobile only). When set, the chip renders
// at this absolute viewport position instead of inside the dock flex layout.
const _chipPositions = new Map(); // modalId -> { left, top }
// User-dragged position of the dock pad itself (both desktop and mobile).
// Remembered across minimize→restore→minimize cycles so the dock reappears
// where the user last parked it instead of snapping back to bottom-center.
// null means "use the CSS default position".
let _dockPos = null; // { left, top } | null
// Snapshot of which ids had a rendered chip after the last _renderDock pass.
// Lets us detect "a brand-new chip just arrived" so we can re-dock the
// existing free-positioned chain to absorb the newcomer.
const _renderedChipIds = new Set();

// ── Persistence (mobile dock + free-chip positions) ──
const _DOCK_STORAGE_KEY = 'orwell.mobileDockState.v1';
let _dockStateLoaded = false;

function _saveDockState() {
  // The dock-pad position is remembered on every platform. The per-chip
  // free-float positions are still a mobile-only gesture, so we only have
  // entries to persist there on touch layouts — but writing the (empty)
  // map on desktop is harmless.
  try {
    const state = {
      dockPos: _dockPos,
      chips: Object.fromEntries(_chipPositions),
    };
    localStorage.setItem(_DOCK_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function _loadDockState() {
  if (_dockStateLoaded) return;
  _dockStateLoaded = true;
  try {
    const raw = localStorage.getItem(_DOCK_STORAGE_KEY);
    if (!raw) return;
    const state = JSON.parse(raw);
    if (state.chips && typeof state.chips === 'object') {
      for (const [id, pos] of Object.entries(state.chips)) {
        if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
          // Clamp to current viewport in case orientation/size changed
          const left = Math.max(4, Math.min(window.innerWidth - 44, pos.left));
          const top  = Math.max(4, Math.min(window.innerHeight - 44, pos.top));
          _chipPositions.set(id, { left, top });
        }
      }
    }
    // Dock position — accept the new {left,top} shape, and fall back to the
    // legacy dockLeft/dockTop strings written by older builds.
    let dp = state.dockPos;
    if (!dp && state.dockLeft && state.dockTop) {
      dp = { left: parseFloat(state.dockLeft), top: parseFloat(state.dockTop) };
    }
    if (dp && Number.isFinite(dp.left) && Number.isFinite(dp.top)) {
      // Clamp into the current viewport so a saved spot from a larger
      // window doesn't strand the dock off-screen.
      _dockPos = {
        left: Math.max(8, Math.min(window.innerWidth - 60, dp.left)),
        top:  Math.max(8, Math.min(window.innerHeight - 40, dp.top)),
      };
    }
  } catch {}
}

// Push the remembered dock position onto the live element. Called on every
// render because the empty-dock branch wipes inline styles via cssText='',
// which would otherwise drop the position the moment the dock clears.
function _applyDockPos(dock) {
  if (!_dockPos) return;
  dock.style.left = `${_dockPos.left}px`;
  dock.style.top = `${_dockPos.top}px`;
  dock.style.right = 'auto';
  dock.style.bottom = 'auto';
  dock.style.transform = 'none';
}

function _renderDock() {
  const dock = document.getElementById('minimized-dock');
  if (!dock) return;
  const minimizedIds = [..._state.entries()].filter(([_, s]) => s.isMinimized).map(([id]) => id);
  // On mobile we ALSO keep chips around for any modal that's been
  // free-positioned on screen — even while it's open — so the chip acts as
  // a persistent toggle (tap to minimize, tap again to restore).
  const allIds = Array.from(new Set(minimizedIds)); // E95: minimized only — no floating chips
  // Keep _dockOrder for every modal still alive in _state — even when it's
  // currently restored (not in allIds). That way re-minimizing a chip lands
  // back in its original slot instead of being pushed to the right edge.
  // Ids only fall out of _dockOrder once the modal is fully closed
  // (close() → _state.delete()).
  _dockOrder = _dockOrder.filter(id => _state.has(id));
  for (const id of allIds) {
    if (!_dockOrder.includes(id)) _dockOrder.push(id);
  }

  // Capture any custom data-* attributes (e.g. data-tab-num) BEFORE we
  // remove old chips, so they can be restored on the rebuilt chips.
  // Without this, external systems that stamp attributes on chips
  // (like emailLibrary's slot-number badge) see the attribute wiped on
  // every re-render — most visibly after a chain drag, when chips are
  // at body level and get swept by the next render.
  const oldData = new Map();
  document.querySelectorAll('.minimized-dock-chip').forEach(c => {
    const id = c.dataset.modalId;
    if (!id) return;
    const data = {};
    for (const a of c.attributes) {
      if (a.name.startsWith('data-') && a.name !== 'data-modal-id') {
        data[a.name] = a.value;
      }
    }
    if (Object.keys(data).length) oldData.set(id, data);
  });

  // Sweep any free-positioned chips currently on <body> first — they'll be
  // recreated below if still alive, but if _dockOrder ended up empty (e.g.
  // the chain close-all just finished) we need to clear them here too.
  // Previously this sweep only ran in the non-empty branch, leaving the
  // last-rendered chip orphaned on body after the final close.
  document.querySelectorAll('body > .minimized-dock-chip').forEach(c => c.remove());

  // _dockOrder keeps every alive modal's slot (so order is stable across
  // restore→minimize cycles), but we only render chips for ids currently
  // in allIds (minimized or persistent).
  const renderIds = _dockOrder.filter(id => allIds.includes(id));

  // If a brand-new chip is joining and the existing chips are already
  // free-positioned at body level (e.g. previously chain-dropped), the
  // new chip would land in the dock by itself — visually unlinking the
  // group. Collapse everyone back into the dock so the chain stays
  // together as a single group at the new size.
  if (!renderIds.length) {
    // F1 (DWE audit): dock visibility is CLASS-driven. The old inline
    // `display:''` reveal fell back to the base CSS `display:none` (the U3
    // sidebar-rows rule), so the dock was invisible WHILE holding chips and a
    // minimized window had no pointer path back.
    dock.classList.remove('ow-has-rows');
    dock.style.removeProperty('display');
    const rows0 = dock.querySelector('.minimized-dock-rows');
    if (rows0) rows0.innerHTML = '';
    _notifyDockChanged();   // #573 B: no chips left — let the rail re-hide if it was only showing for the dock
    return;
  }

  // FLIP: capture old positions
  const oldRects = new Map();
  dock.querySelectorAll('.minimized-dock-chip').forEach(c => {
    oldRects.set(c.dataset.modalId, c.getBoundingClientRect());
  });

  dock.classList.add('ow-has-rows');
  dock.style.removeProperty('display');
  const rows = dock.querySelector('.minimized-dock-rows') || dock;
  rows.innerHTML = '';
  for (const id of renderIds) {
    const meta = _LABELS[id] || { label: id, icon: '' };
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'minimized-dock-chip';
    // #752 [PERSISTENT-SURFACE STABILITY]: the dock is a PERSISTENT surface — only a
    // genuinely NEW chip plays the entrance animation. _renderDock rebuilds ALL chip rows
    // (rows.innerHTML='') on any change to the minimized set, so an unconditional
    // dock-chip-in (now gated to .chip-entering in style.css) would re-fly every already-
    // docked chip on every minimize/restore/close. _renderedChipIds still holds the PREVIOUS
    // pass's ids here (it's repopulated at the end), so a chip absent from it is the
    // transient newcomer that should animate; the survivors hold position (the FLIP transform
    // below reflows them smoothly).
    if (!_renderedChipIds.has(id)) chip.classList.add('chip-entering');
    chip.dataset.modalId = id;
    chip.title = `Restore ${meta.label}`;
    // Restore any external data-* attributes the previous chip carried
    // (e.g. emailLibrary's data-tab-num slot-number badge).
    const prevAttrs = oldData.get(id);
    if (prevAttrs) {
      for (const [name, val] of Object.entries(prevAttrs)) {
        chip.setAttribute(name, val);
      }
    }
    // icon can be either a path-d string (built-in modals) or a complete
    // <svg>...</svg> markup (custom registrants like FX popups).
    const iconHtml = (typeof meta.icon === 'string' && meta.icon.includes('<'))
      ? meta.icon
      : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${meta.icon}"/></svg>`;
    chip.innerHTML = `
      ${iconHtml}
      <span class="minimized-dock-label">${meta.label}</span>
      <span class="minimized-dock-x" title="Close">×</span>
    `;
    chip.addEventListener('click', (e) => {
      if (chip._wasDragging) { chip._wasDragging = false; return; }
      if (e.target.classList.contains('minimized-dock-x')) {
        e.stopPropagation();
        close(id);
        return;
      }
      // Tap toggles: if the modal is currently minimized, restore it. If
      // it's already open (chip is being kept around because it was free-
      // positioned on mobile), minimize it.
      const s = _state.get(id);
      if (s && !s.isMinimized) {
        minimize(id);
      } else {
        restore(id);
      }
    });
    // E95: a plain sidebar row — icon + name, click restores; no drag.
    const st = _state.get(id);
    if (st && !st.isMinimized) chip.classList.add('chip-active');
    rows.appendChild(chip);
  }

  // FLIP: animate from old → new positions (skipped under prefers-reduced-motion
  // — the E97 contract applies to dock motion too; DWE audit note).
  const _reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!_reduced) dock.querySelectorAll('.minimized-dock-chip').forEach(c => {
    const oldRect = oldRects.get(c.dataset.modalId);
    if (!oldRect) return;
    const newRect = c.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (dx || dy) {
      c.style.transform = `translate(${dx}px, ${dy}px)`;
      c.style.transition = 'none';
      requestAnimationFrame(() => {
        c.style.transition = 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)';
        c.style.transform = '';
      });
    }
  });

  // Snapshot which ids are rendered now so the next render can tell when
  // a brand-new chip is joining.
  _renderedChipIds.clear();
  for (const id of renderIds) _renderedChipIds.add(id);
  _notifyDockChanged();   // #573 B: a chip parked — reveal the control room so it's never stranded
}

// (Removed #573 A0: ~700 lines of dead modalManager chip chain-physics —
// _wireChipDrag and its trash-zone/chain/free-drag helpers had no caller
// since E95 replaced draggable chips with static dock rows.)

// Tracks which _LABELS entries were created by `register(..., {label, icon})`
// (vs. the built-in static ones). Only these should be removed in
// `unregister` — built-in labels stay for the lifetime of the page.
const _customLabelIds = new Set();

export function register(id, { restoreFn, closeFn, railBtnId, sidebarBtnId, label, icon } = {}) {
  // railBtnId can be a single id or an array; we accept both rail and sidebar separately too.
  const btnIds = [];
  if (railBtnId) btnIds.push(...(Array.isArray(railBtnId) ? railBtnId : [railBtnId]));
  if (sidebarBtnId) btnIds.push(...(Array.isArray(sidebarBtnId) ? sidebarBtnId : [sidebarBtnId]));
  _state.set(id, {
    restoreFn: restoreFn || (() => {}),
    closeFn:   closeFn   || (() => {}),
    btnIds,
    isMinimized: false,
    restoreMinHeight: '',
  });
  // Auto-stack: whichever modal becomes visible last sits on top of any
  // already-open modals. The various tool open() functions (gallery,
  // memory/brain, tasks, etc.) all just toggle `.hidden` or `display` —
  // observe both and bump the z-index on the visible→hidden→visible
  // transition. Idempotent on re-register.
  const _modalEl = document.getElementById(id);
  if (_modalEl && !_modalEl._mmAutoStackObs) {
    const _isVisible = () => !_modalEl.classList.contains('hidden')
        && getComputedStyle(_modalEl).display !== 'none';
    _modalEl._mmAutoStackLast = _isVisible();
    _modalEl._mmLastHidden = _modalEl.classList.contains('hidden');
    _modalEl._mmLastInlineDisplay = _modalEl.style.display;
    const obs = new MutationObserver(() => {
      // G2 (launcher-agnostic restore): when ANY code path un-hides this
      // modal while its minimized state is held — e.g. the settings gear
      // calls the tool's own open(), which just removes `.hidden` — run the
      // REAL restore path (clear .modal-minimized, the dock chip, badges and
      // state) instead of leaving a window that looks open but is
      // display:none + pointer-events:none under `.modal-minimized`. The
      // detection is transition-based (hidden → un-hidden, or the inline
      // display turned visible) so the minimize paths themselves — which add
      // `.hidden`/`.modal-minimized` — never trip it.
      const nowHidden = _modalEl.classList.contains('hidden');
      const nowDisplay = _modalEl.style.display;
      const unHid = _modalEl._mmLastHidden && !nowHidden;
      const displayedInline = !!nowDisplay && nowDisplay !== 'none'
          && nowDisplay !== _modalEl._mmLastInlineDisplay;
      _modalEl._mmLastHidden = nowHidden;
      _modalEl._mmLastInlineDisplay = nowDisplay;
      if ((unHid || displayedInline)
          && _state.get(id)?.isMinimized
          && _modalEl.classList.contains('modal-minimized')) {
        restore(id);
        // restore() just mutated class/style itself — resync the trackers to
        // the restored state so the re-entrant callback diffs cleanly.
        _modalEl._mmLastHidden = _modalEl.classList.contains('hidden');
        _modalEl._mmLastInlineDisplay = _modalEl.style.display;
        _modalEl._mmAutoStackLast = _isVisible();
        return;
      }
      const vis = _isVisible();
      if (vis && !_modalEl._mmAutoStackLast) {
        _bringToFront(_modalEl);
        _applyRememberedDock(id);
        _emitModalOpened(id, _modalEl);
      }
      _modalEl._mmAutoStackLast = vis;
    });
    obs.observe(_modalEl, { attributes: true, attributeFilter: ['class', 'style'] });
    _modalEl._mmAutoStackObs = obs;
    // If it's already visible at register time (e.g. modal opened before
    // register completes), bump it once now too.
    if (_modalEl._mmAutoStackLast) {
      _bringToFront(_modalEl);
      _applyRememberedDock(id);
      _emitModalOpened(id, _modalEl);
    }
  }
  // Allow callers to supply their own chip label/icon (path d="..." or
  // full <svg>...</svg>) so ephemeral things like FX popups can dock
  // into the same chain without needing an entry in the built-in
  // _LABELS table. Track the id so `unregister` can drop the entry
  // and avoid an unbounded-growth leak (v2 review HIGH-3).
  if (label || icon) {
    _LABELS[id] = { label: label || id, icon: icon || '' };
    _customLabelIds.add(id);
  }
  // If a docked window was minimized and its chip was closed, reopen the
  // window in the same side dock next time. Defer until the caller finishes
  // removing `.hidden` / applying initial display styles.
  if (_getRememberedDock(id)) {
    requestAnimationFrame(() => requestAnimationFrame(() => _applyRememberedDock(id)));
  }
}

export function unregister(id) {
  const s = _state.get(id);
  if (s) _setBadge(s.btnIds, false);
  _state.delete(id);
  _chipPositions.delete(id);
  // Drop any per-popup _LABELS entry created at register-time.
  if (_customLabelIds.has(id)) {
    delete _LABELS[id];
    _customLabelIds.delete(id);
  }
  // Also prune the dock-order list so a re-rendered dock doesn't try
  // to draw a chip for a now-dead id.
  const idx = _dockOrder.indexOf(id);
  if (idx >= 0) _dockOrder.splice(idx, 1);
  _saveDockState();
  _renderDock();
}

export function isRegistered(id)  { return _state.has(id); }
export function isMinimized(id)   { return _state.get(id)?.isMinimized === true; }

export function minimize(id) {
  // Lazy-register if a known modal isn't yet registered (e.g. user clicked `_`
  // on a tool that doesn't pre-register itself).
  if (!_state.has(id) && _AUTO_WIRE[id]) _autoRegister(id);
  const s = _state.get(id);
  if (!s) return false;
  // The id may refer to a virtual tool (e.g. the document panel) that has no
  // actual modal element — in that case we just track the minimized state
  // and let the chip drive restore/close via the registered functions.
  const modal = document.getElementById(id);
  if (modal) {
    _captureRestoreHeight(modal, s);
    // If this window is edge-docked (right/left), SUSPEND the dock: release
    // the body push so the chat returns to full width while the window is
    // minimized, but keep the dock so restoring the chip snaps it back in.
    if (modal.classList.contains('modal-right-docked')
        || modal.classList.contains('modal-left-docked')
        || modal.classList.contains('email-snap-left')) {
      try { suspendDock(modal); } catch (e) { console.warn('suspendDock on minimize failed', e); }
    }
    modal.classList.add('hidden');
    modal.classList.add('modal-minimized');
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.remove('sheet-ready', 'modal-closing');
      content.style.transform = '';
      content.style.transition = '';
      content.style.animation = '';
    }
  }
  s.isMinimized = true;
  _setBadge(s.btnIds, true);
  _ensureDock();
  _renderDock();
  return true;
}

export function restore(id) {
  const s = _state.get(id);
  if (!s) return false;
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('hidden', 'modal-minimized');
    // G2 interop: the legacy app.js minimize dock marks windows with its own
    // `minimized` class (display:none !important). When both systems engaged
    // on the same `_` click, a restore through THIS path must scrub that
    // class too — otherwise the window stays invisible after a "successful"
    // restore.
    modal.classList.remove('minimized');
    modal.style.display = '';
    _applyRestoreHeight(modal, s);
    // Surface above any already-open tool window — restoring from the dock
    // should bring this tool to the front, not leave it stuck behind one with
    // a higher static z-index.
    _bringToFront(modal);
    // If the window was edge-docked when minimized, re-apply the dock so the
    // chat nudges back in and the window returns exactly where it was.
    try { resumeDock(modal); } catch (e) { console.warn('resumeDock on restore failed', e); }
    _emitModalOpened(id, modal);
  }
  s.isMinimized = false;
  _setBadge(s.btnIds, false);
  // Intentionally don't clear _chipPositions here: on mobile a free-
  // positioned chip is meant to act as a persistent toggle that stays
  // visible alongside the open modal, so the user can re-collapse it with
  // one tap. The chip only goes away when the modal is fully closed (see
  // close() above, which does delete the position).
  _renderDock();
  try { s.restoreFn(); } catch (e) { console.error('restoreFn:', e); }
  return true;
}

/**
 * If the modal is currently MINIMIZED, restore it and return true.
 * Otherwise return false so the caller falls through to its own
 * open/close handling. We deliberately do NOT minimize on toggle —
 * that's the `_` button's job, not the rail/sidebar button's job.
 */
export function toggle(id) {
  const s = _state.get(id);
  if (!s) return false;
  const modal = document.getElementById(id);
  if (!modal) { _state.delete(id); return false; }
  if (s.isMinimized) return restore(id);
  return false;
}

/** Full close — calls closeFn (which should tear down DOM + state) and unregisters. */
export function close(id) {
  const s = _state.get(id);
  if (!s) return;
  const modalBeforeClose = document.getElementById(id);
  const contentBeforeClose = modalBeforeClose?.querySelector?.('.modal-content');
  const suspendedDockSide = contentBeforeClose?._dockSuspended
    || (modalBeforeClose?.classList?.contains('modal-left-docked') ? 'left'
        : modalBeforeClose?.classList?.contains('modal-right-docked') ? 'right'
          : null);
  const shouldRememberDock = s.isMinimized && !!suspendedDockSide;
  if (shouldRememberDock) _rememberDock(id, suspendedDockSide);
  else _forgetDock(id);
  try { s.closeFn(); } catch (e) { console.error('closeFn:', e); }
  // Some tools (cookbook) animate their close over ~250ms before adding
  // .hidden. If the user re-opens the tool before that finishes, open()
  // sees the modal as "still visible" and takes its no-op early-return
  // path — making the tool feel unresponsive. Force the modal into a
  // fully-closed state synchronously so subsequent open() calls always
  // hit the real open path.
  const modal = document.getElementById(id);
  if (modal) {
    // Tear down the live dock push/classes before hiding. If this close came
    // from a minimized dock chip, the side was persisted above and register()
    // will intentionally re-apply it on the next open.
    if (modal.classList.contains('modal-right-docked') || modal.classList.contains('modal-left-docked')) {
      try { clearRightDock(modal); } catch (e) { console.warn('clearRightDock on close failed', e); }
    }
    modal.classList.add('hidden');
    modal.classList.remove('modal-minimized');
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.remove('modal-closing', 'sheet-ready');
      content.style.transform = '';
      content.style.transition = '';
      content.style.animation = '';
      content.style.opacity = '';
    }
  }
  _setBadge(s.btnIds, false);
  _state.delete(id);
  _chipPositions.delete(id);
  _saveDockState();
  _renderDock();
}

/** Inject a minimize (`_`) button next to the close button in a modal.
 * Skips if a minimize button already exists (any class containing "minimize"). */
export function injectMinimizeButton(modal, modalId) {
  const header = modal.querySelector('.modal-header');
  if (!header) return;
  if (header.querySelector('.modal-minimize-btn, .minimize-btn, [data-minimize]')) {
    // An existing minimize button is present — wire it to the manager instead
    const existing = header.querySelector('.minimize-btn, [data-minimize]');
    if (existing && !existing.dataset._modalsBound) {
      existing.dataset._modalsBound = '1';
      existing.addEventListener('click', (e) => {
        e.stopPropagation();
        minimize(modalId);
      }, true);
    }
    return;
  }
  const closeBtn = header.querySelector('.close-btn, .modal-close');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'modal-minimize-btn';
  btn.title = 'Minimize';
  btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="18" x2="19" y2="18"/></svg>';
  // Anchor the _/X pair to the right edge regardless of the header's
  // justify-content. Some headers (cookbook) use `space-between`, which
  // would otherwise distribute three children as left/center/right and
  // strand the `_` in the middle. `margin-left:auto` eats the free space
  // to the left so `_` + close sit snug at the right.
  btn.style.flexShrink = '0';
  btn.style.marginLeft = 'auto';
  if (closeBtn) {
    // The close button may carry its own left margin (e.g. compare's inline
    // "margin-left:8px") meant to separate it from the title when it stood
    // alone. Now that `_` sits to its left, that margin becomes a stray gap
    // between the two buttons — zero it. The minimize button's own
    // margin-right (2px, from .modal-minimize-btn) provides the gap.
    closeBtn.style.marginLeft = '0';
    closeBtn.style.flexShrink = '0';
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    minimize(modalId);
  });
  if (closeBtn && closeBtn.parentNode) closeBtn.parentNode.insertBefore(btn, closeBtn);
  else header.appendChild(btn);
}

// ── Auto-wire fallback for modals not explicitly registered ──
// Maps modal-id → { rail btn id, sidebar btn id }. Used to auto-register any
// modal that gets swipe-dismissed so the rail/sidebar shows the badge and
// clicking the same button restores it. Tools that need rebuild-on-restore
// can still register explicitly with custom restoreFn/closeFn.
const _AUTO_WIRE = {
  'cookbook-modal':       { rail: 'rail-cookbook',  sidebar: 'tool-cookbook-btn' },
  'calendar-modal':       { rail: 'rail-calendar',  sidebar: 'tool-calendar-btn' },
  'gallery-modal':        { rail: 'rail-gallery',   sidebar: 'tool-gallery-btn' },
  'tasks-modal':          { rail: 'rail-tasks',     sidebar: 'tool-tasks-btn' },
  'doclib-modal':         { rail: 'rail-archive',   sidebar: 'tool-library-btn' },
  'memory-modal':         { rail: null,             sidebar: 'tool-memory-btn' },
  'notes-panel':          { rail: 'rail-notes',     sidebar: 'tool-notes-btn' },
  // Email already has its own #email-unread-dot inline next to the title —
  // don't add a second modalManager badge that lands at the right edge.
  'email-lib-modal':      { rail: null,             sidebar: null },
  'research-overlay':     { rail: 'rail-research',  sidebar: 'tool-research-btn' },
  'theme-modal':          { rail: null,             sidebar: 'tool-theme-btn' },
  // G2: the user-bar gear (#user-bar-settings) is a settings launcher too —
  // listing it lets the capture-phase click interceptor below restore a
  // minimized settings window even when the click never reaches the tool's
  // own open() (belt #1; the auto-stack observer's launcher-agnostic heal in
  // register() is belt #2 and covers launchers nobody listed).
  'settings-modal':       { rail: null,             sidebar: ['tool-settings-btn', 'user-bar-settings'] },
  'compare-model-overlay':{ rail: 'rail-compare',   sidebar: 'tool-compare-btn' },
  'ge-shortcuts-modal':   { rail: null,             sidebar: null },
  // Prompt window opens from the overflow menu (no rail/sidebar button), but
  // wiring it here makes tab-down use the new .minimized-dock-chip instead of
  // the legacy .modal-dock-item.
  'custom-preset-modal':  { rail: null,             sidebar: null },
};

function _autoRegister(id) {
  if (_state.has(id)) return _state.get(id);
  const wire = _AUTO_WIRE[id];
  if (!wire) return null;
  // Default close: try to invoke the tool's own close button (so it tears down
  // properly), then hide as a fallback.
  register(id, {
    railBtnId: wire.rail,
    sidebarBtnId: wire.sidebar,
    closeFn: () => {
      const m = document.getElementById(id);
      if (!m) return;
      const closeBtn = m.querySelector('.close-btn, .modal-close, [data-close]');
      if (closeBtn) {
        closeBtn.click();
      } else {
        m.classList.add('hidden');
        m.style.display = 'none';
      }
    },
    restoreFn: () => {},
  });
  return _state.get(id);
}

// Watch the document for tool modals being added/shown and inject the `_`
// button next to the close button. We do NOT pre-register here — only inject
// the button. Registration happens when the modal is actually minimized,
// either via the `_` button click or via swipe-dismiss.
function _scanAndWire() {
  for (const id of Object.keys(_AUTO_WIRE)) {
    const modal = document.getElementById(id);
    if (!modal) continue;
    injectMinimizeButton(modal, id);
  }
}
// ORW-162: this used to be a 1 s setInterval that woke the page every second forever. The scan only has to run when a modal element is ADDED
// to the document, so watch child-list changes (rAF-coalesced) instead. Static modals are wired by the initial scan below.
let _scanQueued = false;
function _queueScan() {
  if (_scanQueued) return;
  _scanQueued = true;
  (window.requestAnimationFrame || setTimeout)(() => { _scanQueued = false; _scanAndWire(); });
}
try {
  const _scanObserver = new MutationObserver(_queueScan);
  const _observeBody = () => _scanObserver.observe(document.body, { childList: true, subtree: true });
  if (document.body) _observeBody(); else document.addEventListener('DOMContentLoaded', _observeBody);
} catch (_) { setInterval(_scanAndWire, 1000); /* no MutationObserver: keep the old polling */ }
// First scan after DOM ready
if (document.readyState !== 'loading') {
  setTimeout(_scanAndWire, 100);
} else {
  document.addEventListener('DOMContentLoaded', () => setTimeout(_scanAndWire, 100));
}

// Tools that survive a swipe-down as a dock chip. Anything else falls
// through to the legacy close handler and goes away entirely.
const _SWIPE_DOWN_MINIMIZES = new Set([
  'cookbook-modal',
  'calendar-modal',
  'email-lib-modal',
]);
// Same idea but matched by id prefix — so dynamically-created modals
// (per-email reader tabs) survive swipe-down too.
const _SWIPE_DOWN_MINIMIZES_PREFIX = ['email-reader-'];

function _clearEmailSplitAfterMinimize() {
  document.body.classList.remove('email-doc-split-active', 'email-front');
  document.documentElement.style.removeProperty('--email-doc-split-left-x');
  document.documentElement.style.removeProperty('--email-doc-split-email-w');
  document.documentElement.style.removeProperty('--email-doc-split-right-x');
  const docPane = document.getElementById('doc-editor-pane');
  if (docPane) {
    [
      'position', 'left', 'right', 'top', 'bottom', 'width', 'max-width',
      'height', 'z-index', 'transform',
    ].forEach(prop => docPane.style.removeProperty(prop));
  }
  const divider = document.getElementById('doc-divider');
  if (divider) divider.style.display = '';
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  setTimeout(() => window.dispatchEvent(new Event('resize')), 80);
}

// Re-route swipe-dismiss to minimize-rather-than-close — but only for the
// allowlisted tools above. For every other modal, return early so the
// default close handler runs and the modal goes away.
// Close any open body-mounted popups (kebab dropdowns, split-button menus,
// etc.) when the cookbook modal is swiped away. Otherwise the dropdowns
// stay floating in the middle of the page with no anchor.
window.addEventListener('modal-dismissed', (e) => {
  const id = e.detail?.id;
  if (id === 'cookbook-modal') {
    document.querySelectorAll(
      '.cookbook-task-dropdown, .cookbook-gpu-split-menu, .hwfit-cached-dropdown, .cookbook-saved-menu, .cookbook-dep-menu'
    ).forEach(dismissOrRemove);
  }
});

window.addEventListener('modal-dismissed', (e) => {
  const id = e.detail?.id;
  if (!id) return;
  if (!_SWIPE_DOWN_MINIMIZES.has(id) && !_SWIPE_DOWN_MINIMIZES_PREFIX.some(p => id.startsWith(p))) return;
  // Auto-register if it's a known tool modal
  if (!_state.has(id)) _autoRegister(id);
  const s = _state.get(id);
  if (!s) return;
  s.isMinimized = true;
  _setBadge(s.btnIds, true);
  const modal = document.getElementById(id);
  if (modal) {
    const isEmailModal = id === 'email-lib-modal' || id.startsWith('email-reader-');
    if (modal.classList.contains('modal-right-docked')
        || modal.classList.contains('modal-left-docked')
        || modal.classList.contains('email-snap-left')) {
      try { suspendDock(modal); } catch (err) { console.warn('suspendDock on dismissed failed', err); }
    }
    if (isEmailModal) _clearEmailSplitAfterMinimize();
    modal.classList.add('modal-minimized');
  }
  _ensureDock();
  _renderDock();
  // Stop legacy listeners that reset internal `_open` state
  e.stopImmediatePropagation();
});

// Capture-phase intercept: if user clicks a sidebar/rail button whose
// associated modal is currently MINIMIZED, restore it and stop the click
// before the tool's own toggle handler runs (which would try to re-open or
// close it).
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[id]');
  if (!btn) return;
  const btnId = btn.id;
  for (const [modalId, s] of _state.entries()) {
    if (!s.isMinimized) continue;
    if (s.btnIds.includes(btnId)) {
      restore(modalId);
      e.stopImmediatePropagation();
      e.preventDefault();
      return;
    }
  }
}, true);

export default { register, unregister, isRegistered, isMinimized, minimize, restore, toggle, close, injectMinimizeButton };
