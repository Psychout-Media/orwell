// static/js/ui.js

/**
 * UI utilities for toasts, modals, scrolling, and user feedback
 */

import themeModule from './theme.js';
import * as Modals from './modalManager.js';
import spinnerModule from './spinner.js';
import { registerMenuDismiss, dismissTopMenu, dismissOrRemove } from './escMenuStack.js';
import { isNarrow } from './platform.js';

let autoScrollEnabled = true;
let hoveredToggleCard = null;
let hoveredToggleWindow = null;
let hoveredDockChip = null;
let _lastPointerClientX = null;
let _lastPointerClientY = null;

// Smooth scroll state
let _scrollRafId = null;
let _scrollBox = null;

function _isTextEditingTarget(target) {
  const el = target && target.nodeType === 1 ? target : target?.parentElement;
  return !!(el && el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
}

function _targetEl(target) {
  return target && target.nodeType === 1 ? target : target?.parentElement || null;
}

const SPACE_CARD_SELECTOR = [
  '#email-lib-modal .doclib-card',
  '#doclib-modal .doclib-card',
  '#doclib-modal .doclib-chat-row',
  '#memory-modal .doclib-card',
  '#tasks-modal .task-card',
  '#tasks-modal .task-log-row',
  '#research-overlay [data-job-id]',
  '#cookbook-modal .doclib-card',
  '.email-reader-tab-modal .doclib-card',
  '.email-window-modal .doclib-card',
].join(', ');

const SPACE_BLOCKED_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '.recipient-chip',
  '.doclib-card-dropdown',
  '.email-card-dropdown',
  '.task-log-row-actions',
  '.modal-header',
].join(', ');

function _visibleModalForSpace(win) {
  const modal = win?.closest?.('.modal[id]');
  if (!modal || modal.classList.contains('hidden') || modal.classList.contains('modal-minimized')) return null;
  return modal;
}

function _isSpaceVisible(el) {
  if (!el || !document.contains(el)) return false;
  if (el.closest?.('.modal.hidden, .modal.modal-minimized, [hidden]')) return false;
  return true;
}

function _spaceWindowId(win) {
  if (!win || !document.contains(win)) return null;
  const modal = _visibleModalForSpace(win);
  if (modal && Modals.isRegistered(modal.id)) return modal.id;
  if (win.closest?.('.doc-editor-pane') && Modals.isRegistered('doc-panel') && !Modals.isMinimized('doc-panel')) return 'doc-panel';
  return null;
}

function _windowAtPointer() {
  if (_lastPointerClientX == null || _lastPointerClientY == null) return null;
  const x = _lastPointerClientX;
  const y = _lastPointerClientY;
  const candidates = [
    ...document.querySelectorAll('.modal:not(.hidden):not(.modal-minimized) .modal-content'),
    ...document.querySelectorAll('.doc-editor-pane'),
  ].filter(el => {
    if (!document.contains(el)) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  });
  if (!candidates.length) return null;
  return candidates.reduce((top, el) => {
    const mz = parseInt(getComputedStyle(el.closest('.modal') || el).zIndex, 10) || 0;
    const tz = parseInt(getComputedStyle(top.closest('.modal') || top).zIndex, 10) || 0;
    return mz >= tz ? el : top;
  });
}

function _containsPointer(el) {
  if (!el || _lastPointerClientX == null || _lastPointerClientY == null) return false;
  const r = el.getBoundingClientRect();
  return _lastPointerClientX >= r.left && _lastPointerClientX <= r.right
    && _lastPointerClientY >= r.top && _lastPointerClientY <= r.bottom;
}

function _closeHoveredWindow() {
  let win = _windowAtPointer();
  if (!win) {
    try {
      const underPointer = document.elementFromPoint(_lastPointerClientX, _lastPointerClientY);
      win = underPointer?.closest?.('.modal:not(.hidden):not(.modal-minimized) .modal-content, .doc-editor-pane') || null;
    } catch {}
  }
  if (!win) win = hoveredToggleWindow;
  if (!win || !document.contains(win)) return false;
  const modalForWin = win.closest?.('.modal[id]');
  if (modalForWin?.id === 'email-lib-modal') {
    const closeBtn = document.getElementById('email-lib-close') || modalForWin.querySelector('.close-btn');
    if (closeBtn) {
      try { closeBtn.click(); return true; } catch {}
    }
    try { modalForWin.remove(); return true; } catch {}
  }
  const id = _spaceWindowId(win);
  if (id && Modals.isRegistered(id)) {
    Modals.close(id);
    return true;
  }
  const modal = _visibleModalForSpace(win);
  if (!modal) return false;
  const closeBtn = modal.querySelector('.close-btn, .modal-close, .modal-close-btn, [data-action="close"]');
  if (closeBtn) {
    try { closeBtn.click(); return true; } catch {}
  }
  try { modal.classList.add('hidden'); return true; } catch {}
  return false;
}

function _spaceIsBlocked(e, surface) {
  const target = _targetEl(e.target);
  if (!target) return false;
  if (_isTextEditingTarget(target)) return !surface || surface.contains(target);
  const blocked = target.closest?.(SPACE_BLOCKED_SELECTOR);
  return !!(blocked && (!surface || surface.contains(blocked)));
}

function _activateSpaceCard(card) {
  if (!card || !document.contains(card)) return false;
  if (card.matches('#tasks-modal .task-card')) {
    const titleRow = card.querySelector('.memory-item-title')?.closest('div');
    if (titleRow) {
      titleRow.click();
      return true;
    }
  }
  card.dataset.spaceToggle = '1';
  card.click();
  setTimeout(() => {
    try { delete card.dataset.spaceToggle; } catch {}
  }, 0);
  return true;
}

function _initHoverCardSpaceToggle() {
  if (document._orwellHoverCardSpaceToggle) return;
  document._orwellHoverCardSpaceToggle = true;
  document.addEventListener('pointerover', (e) => {
    _lastPointerClientX = e.clientX;
    _lastPointerClientY = e.clientY;
    const chip = e.target?.closest?.('.minimized-dock-chip[data-modal-id]');
    if (chip) hoveredDockChip = chip;
    const card = e.target?.closest?.(SPACE_CARD_SELECTOR);
    if (card) hoveredToggleCard = card;
    const win = e.target?.closest?.('.modal:not(.hidden):not(.modal-minimized) .modal-content, .doc-editor-pane');
    if (win) hoveredToggleWindow = win;
  }, true);
  document.addEventListener('pointermove', (e) => {
    _lastPointerClientX = e.clientX;
    _lastPointerClientY = e.clientY;
  }, true);
  document.addEventListener('pointerout', (e) => {
    const next = e.relatedTarget;
    if (hoveredDockChip && (!next || !hoveredDockChip.contains(next))) hoveredDockChip = null;
    if (hoveredToggleCard && (!next || !hoveredToggleCard.contains(next))) hoveredToggleCard = null;
    if (hoveredToggleWindow && (!next || !hoveredToggleWindow.contains(next))) hoveredToggleWindow = null;
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    if (hoveredToggleCard && _isSpaceVisible(hoveredToggleCard)) {
      if (_spaceIsBlocked(e, hoveredToggleCard)) return;
      e.preventDefault();
      _activateSpaceCard(hoveredToggleCard);
      return;
    }
    if (hoveredDockChip && document.contains(hoveredDockChip)) {
      if (_spaceIsBlocked(e, hoveredDockChip)) return;
      const id = hoveredDockChip.dataset.modalId;
      if (id && Modals.isRegistered(id)) {
        e.preventDefault();
        Modals.restore(id);
      }
      return;
    }
    const id = _spaceWindowId(hoveredToggleWindow);
    if (!id) return;
    if (_spaceIsBlocked(e, hoveredToggleWindow)) return;
    e.preventDefault();
    Modals.minimize(id);
  }, true);
}

_initHoverCardSpaceToggle();

/**
 * Copy text to clipboard
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied');
  }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Copied');
  }
}

// #951 — the unified toast. showToast/showError now route through the OrwellNotice kit's
// "toast" placement so an ephemeral confirmation shares the SAME chrome/icon/dismiss/motion/a11y
// contract as every banner/notice (the "Reconnecting to Big Brother…" banner family). The kit owns
// the corner host, the slide-in/out, swipe-to-dismiss, and reduced-motion safety. Toasts stay
// EPHEMERAL (auto-dismiss) — only the look is unified, not WHAT triggers each one. The public
// showToast/showError API is unchanged (88 callers): same args, same behaviour.
//
// A single reused kit notice (one toast at a time, like the legacy singleton #toast). The kit
// replaces the prior toast card when a new one shows, so we keep one instance and re-skin it.
let _toastNotice = null;
function _ensureToastNotice() {
  if (_toastNotice) return _toastNotice;
  if (!window.OrwellNoticeKit) return null;
  _toastNotice = window.OrwellNoticeKit.create({
    id: 'orwell-toast',
    kind: 'toast',
    placement: 'toast',
    severity: 'info',
    // a toast is transient — never persist/sync a "dismissed forever" bit (it must reappear next
    // time), and never render the persistent × by default (it auto-dismisses); an action toast
    // adds its own dismiss affordance in the body (Undo + ×), matching the legacy behaviour.
    dismissible: false,
    persistDismiss: false,
  });
  return _toastNotice;
}

/**
 * Show success toast message. Routed through the OrwellNotice kit (#951) — same API as before.
 */
export function showToast(msg, durationOrOpts) {
  let duration = 1200, actionLabel = null, onAction = null, actionHint = null, actionIcon = null, leadingIcon = null;
  if (typeof durationOrOpts === 'object' && durationOrOpts) {
    duration = durationOrOpts.duration || 5000;
    actionLabel = durationOrOpts.action;
    onAction = durationOrOpts.onAction;
    actionHint = durationOrOpts.actionHint || null;
    actionIcon = durationOrOpts.actionIcon || null;
    leadingIcon = durationOrOpts.leadingIcon || null;
  } else if (typeof durationOrOpts === 'number') {
    duration = durationOrOpts;
  }

  const n = _ensureToastNotice();
  if (!n) return; // kit absent (degraded/headless) — fail-open, no toast

  // The leading icon maps onto the kit's ONE monochrome icon language: a 'check' success glyph
  // (severity:success → the kit's mono check), or the spinner whirlpool (a live in-progress cue
  // the kit's static icon set doesn't cover, so it goes into the body as a node).
  const severity = leadingIcon === 'check' ? 'success' : 'info';

  // Build the body: the message text, then (optionally) the action affordance column + a dismiss ×,
  // exactly like the legacy toast — but inside the kit card's .on-body.
  const body = document.createElement('span');
  body.style.cssText = 'display:inline-flex;align-items:center;gap:0;';
  if (leadingIcon === 'spinner') {
    const wp = spinnerModule.createWhirlpool(14);
    const icon = wp.element;
    icon.classList.add('toast-whirlpool');
    icon.style.cssText = 'width:14px;height:14px;margin:0 8px 0 0;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;';
    body.appendChild(icon);
  }
  const textSpan = document.createElement('span');
  textSpan.textContent = msg;
  body.appendChild(textSpan);

  let hasAction = false;
  if (actionLabel && onAction) {
    hasAction = true;
    const stack = document.createElement('span');
    stack.style.cssText = 'display:inline-flex;flex-direction:column;align-items:center;gap:1px;margin-left:10px;line-height:1;';
    const btn = document.createElement('button');
    // Trust the icon string (only set internally) — never accept caller-controlled HTML otherwise.
    if (actionIcon) {
      btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:5px;">${actionIcon}<span></span></span>`;
      btn.querySelector('span span').textContent = actionLabel;
    } else {
      btn.textContent = actionLabel;
    }
    btn.style.cssText = 'padding:2px 10px;border:1px solid var(--fg);border-radius:4px;background:none;color:var(--fg);cursor:pointer;font-size:12px;pointer-events:auto;display:inline-flex;align-items:center;';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      n.hide();
      onAction();
    });
    stack.appendChild(btn);
    // Keyboard-shortcut hints are meaningless on touch — skip on mobile.
    if (actionHint && !isNarrow()) {
      const hint = document.createElement('span');
      hint.textContent = actionHint;
      hint.style.cssText = 'font-size:9px;opacity:0.55;letter-spacing:0.4px;text-transform:uppercase;font-family:var(--mono, monospace);margin-top:1px;pointer-events:none;';
      stack.appendChild(hint);
    }
    body.appendChild(stack);
    // A small × to dismiss without taking the action (mirrors the legacy action-toast ×).
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', `Dismiss — ${msg}`);
    closeBtn.title = 'Dismiss';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'margin-left:8px;padding:0;width:20px;height:20px;line-height:1;border:none;background:none;color:var(--fg);opacity:0.55;cursor:pointer;font-size:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;pointer-events:auto;';
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.55'; });
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      n.hide();
    });
    body.appendChild(closeBtn);
  }

  // Re-skin the kit card: severity (→ icon + tint), a glyph-free title (toasts have none — the body
  // carries the message), the body content, and the ephemeral auto-dismiss timer. An action toast
  // needs pointer-events so its button is clickable — the kit card re-enables them; we make the host
  // not swallow clicks by leaving the card pointer-events:auto (the kit card already is).
  n.o.autoDismissMs = duration;
  n.update({ severity, title: '', body });
  n.show();
}

/**
 * Show error toast message. Routed through the OrwellNotice kit (#951) — red severity + assertive.
 */
export function showError(msg) {
  const n = _ensureToastNotice();
  if (!n) return;
  n.o.autoDismissMs = 3000;
  const body = document.createElement('span');
  body.textContent = msg;
  n.update({ severity: 'error', title: '', body });
  n.show();
}

/**
 * Smooth-scroll chat history to bottom using rAF lerp.
 * Throttled during streaming so it doesn't fight user scrolling.
 */
let _scrollThrottleTimer = null;
export function scrollHistory() {
  if (!autoScrollEnabled) return;
  if (!_scrollBox) {
    _scrollBox = document.getElementById('chat-history');
  }
  // Throttle: only start a new scroll animation every 500ms
  if (_scrollThrottleTimer) return;
  _scrollThrottleTimer = setTimeout(() => { _scrollThrottleTimer = null; }, 500);
  if (!_scrollRafId) {
    _scrollRafId = requestAnimationFrame(_smoothScrollStep);
  }
}

function _smoothScrollStep() {
  const box = _scrollBox;
  if (!box || !autoScrollEnabled) {
    _scrollRafId = null;
    return;
  }
  const target = box.scrollHeight - box.clientHeight;
  const current = box.scrollTop;
  const diff = target - current;

  // If user scrolled up significantly, don't force them down
  if (diff > 300) {
    _scrollRafId = null;
    return;
  }

  if (diff <= 1) {
    box.scrollTop = target;
    _scrollRafId = null;
    return;
  }

  // Lerp: gentle catch-up
  const factor = isNarrow() ? 0.4 : 0.2;
  box.scrollTop = current + diff * factor;
  _scrollRafId = requestAnimationFrame(_smoothScrollStep);
}

/**
 * Instant scroll to bottom — use for non-streaming contexts
 * like loading history or switching sessions.
 */
export function scrollHistoryInstant() {
  if (!_scrollBox) {
    _scrollBox = document.getElementById('chat-history');
  }
  if (_scrollBox) {
    _scrollBox.scrollTop = _scrollBox.scrollHeight;
  }
}

/**
 * Enable/disable auto-scroll
 */
export function setAutoScroll(enabled) {
  autoScrollEnabled = enabled;
}

/**
 * Get auto-scroll state
 */
export function getAutoScroll() {
  return autoScrollEnabled;
}

/**
 * Auto-resize textarea based on content
 */
export function autoResize(textarea) {
  const lineHeight = parseInt(getComputedStyle(textarea).lineHeight);
  const isMobile = isNarrow();
  const maxHeight = isMobile ? 150 : lineHeight * 8;

  // Use a hidden clone to measure without disrupting the real textarea
  let clone = textarea._resizeClone;
  if (!clone) {
    clone = textarea.cloneNode(false);
    clone.style.cssText = getComputedStyle(textarea).cssText;
    clone.style.position = 'absolute';
    clone.style.visibility = 'hidden';
    clone.style.height = '0';
    clone.style.transition = 'none';
    clone.style.overflow = 'hidden';
    clone.style.pointerEvents = 'none';
    clone.style.zIndex = '-1';
    textarea.parentNode.appendChild(clone);
    textarea._resizeClone = clone;
  }
  clone.style.width = textarea.offsetWidth + 'px';
  clone.value = textarea.value;
  clone.style.height = '0';
  const newHeight = Math.min(Math.max(clone.scrollHeight, lineHeight), maxHeight);
  textarea.style.height = newHeight + 'px';
  textarea.style.overflow = newHeight >= maxHeight ? 'auto' : 'hidden';
}

/**
 * Debounce function for performance
 */
export function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const later = () => {
      timeout = null;
      func.apply(this, args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Get element by ID (utility helper)
 */
export function el(id) {
  return document.getElementById(id);
}

// ── #660 (DWE / HIG F-CHROME-1): styledConfirm + styledPrompt compose the
// OrwellWindow kit's `modal:true` tier (backdrop scrim + focus-trap + inert
// background + aria-modal + one z-authority + Escape via ui.js's single arbiter),
// per the 2026-06-23 window-kit coverage audit §5 step 4. They no longer hand-roll
// a bespoke `.modal` / `.modal-content` root (the class-B holdout). Behavior is
// preserved exactly: the Promise<boolean> / Promise<string|null> shapes, the
// button labels + danger styling, default→cancel, focus/scrim/Escape close, and
// focus-return on close (the kit owns opener capture + return).
//
// The kit is loaded at module eval (orwellWindow.js sets window.OrwellWindowKit),
// so it is present by the time any user gesture calls these; the native
// confirm()/prompt() fallback below is a belt-and-braces fail-open only.

// Small helper: attach a one-shot click-to-cancel handler to a kit modal's scrim
// (the kit's scrim is non-dismissing by default; the legacy dialogs closed on a
// backdrop click, so we preserve that "scrim close" affordance). The scrim carries
// [data-ow-scrim="<id>"] and is torn down with the window, so the listener is GC'd.
function _wireScrimClose(id, onScrim) {
  const scrim = document.querySelector('[data-ow-scrim="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
  if (scrim) scrim.addEventListener('click', onScrim);
}

/**
 * Styled confirm dialog — replaces native browser confirm().
 * Returns a Promise<boolean> (true on confirm; false on cancel / Escape / scrim / ×).
 * Composes the OrwellWindow kit (`modal:true`) — see the #660 note above.
 */
export function styledConfirm(message, { confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const Kit = typeof window !== 'undefined' ? window.OrwellWindowKit : null;
    if (!Kit || !Kit.create) { resolve(window.confirm(message)); return; }   // fail-open

    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    // Body: the message + a footer with the cancel/confirm buttons. The buttons compose the
    // element kit — the `.ow-btn` base plus the `.ow-btn-destructive` (danger) / `.ow-btn-prominent`
    // (default confirm) variant — so styling is ancestry-independent; the message + footer
    // layout is inlined so nothing depends on the retired `.modal-*` container styling.
    const box = document.createElement('div');
    const msg = document.createElement('p');
    msg.id = 'styled-confirm-msg';
    msg.textContent = message;
    msg.style.cssText = 'margin:8px 0 14px;color:var(--fg);font-size:0.92rem;line-height:1.45;white-space:pre-line;';
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding-top:10px;margin-top:4px;border-top:1px solid var(--border);';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.id = 'styled-confirm-cancel';
    cancelBtn.className = 'ow-btn';
    cancelBtn.textContent = cancelText;
    const okBtn = document.createElement('button');
    okBtn.type = 'button'; okBtn.id = 'styled-confirm-ok';
    okBtn.className = danger ? 'ow-btn ow-btn-destructive' : 'ow-btn ow-btn-prominent';
    okBtn.textContent = confirmText;
    footer.appendChild(cancelBtn); footer.appendChild(okBtn);
    box.appendChild(msg); box.appendChild(footer);

    // Compose the kit: a centered (top-center slot), non-resizable, non-minimizable
    // modal micro-dialog that always re-centers (persistLayout:false). Escape is owned
    // by ui.js's arbiter → OrwellWindowKit.dismissTop() (no bespoke handler); the ×
    // (closable) and Escape both settle to `false` via onClose.
    const win = Kit.create({
      id: 'styled-confirm-overlay', title: 'Confirm',
      modal: true, minimizable: false, resizable: false, closable: true,
      draggable: false, persistLayout: false,
      minWidth: 300, minHeight: 120,
      content: box,
      onClose: () => settle(false),
    });

    const cancel = () => { settle(false); win.close(); };
    okBtn.addEventListener('click', () => { settle(true); win.close(); });
    cancelBtn.addEventListener('click', cancel);
    // ArrowLeft/ArrowRight toggle focus between the two buttons (preserved). Tab is
    // trapped by the kit's modal focus-trap.
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
      }
    });

    win.open();
    _wireScrimClose('styled-confirm-overlay', cancel);   // backdrop click → cancel
    try { okBtn.focus(); } catch {}
  });
}

/**
 * Styled text-input prompt — drop-in replacement for window.prompt().
 * Resolves to the trimmed string the user typed, or null on Cancel / Escape / scrim / ×.
 * Composes the OrwellWindow kit (`modal:true`) — see the #660 note above.
 */
export function styledPrompt(message, {
  title = 'Name',
  defaultValue = '',
  placeholder = '',
  confirmText = 'Save',
  cancelText = 'Cancel',
  maxLength = 80,
} = {}) {
  return new Promise(resolve => {
    const Kit = typeof window !== 'undefined' ? window.OrwellWindowKit : null;
    if (!Kit || !Kit.create) {   // fail-open to the native prompt (same value shape)
      const r = window.prompt(message || title, defaultValue || '');
      resolve(r === null ? null : r.trim()); return;
    }

    let settled = false;
    const settle = (result) => { if (!settled) { settled = true; resolve(result); } };

    // Body: an optional message + the text input + a footer with cancel/confirm.
    const box = document.createElement('div');
    if (message) {
      const msg = document.createElement('p');
      msg.id = 'styled-prompt-msg';
      msg.textContent = message;
      msg.style.cssText = 'margin:2px 0 0;color:var(--fg);font-size:0.92rem;line-height:1.45;white-space:pre-line;';
      box.appendChild(msg);
    }
    const input = document.createElement('input');
    input.type = 'text'; input.id = 'styled-prompt-input';
    input.className = 'ow-field';
    input.value = defaultValue || '';
    input.placeholder = placeholder || '';
    input.maxLength = maxLength;
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding-top:10px;margin-top:8px;border-top:1px solid var(--border);';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.id = 'styled-prompt-cancel';
    cancelBtn.className = 'ow-btn';
    cancelBtn.textContent = cancelText;
    const okBtn = document.createElement('button');
    okBtn.type = 'button'; okBtn.id = 'styled-prompt-ok';
    okBtn.className = 'ow-btn ow-btn-prominent';
    okBtn.textContent = confirmText;
    footer.appendChild(cancelBtn); footer.appendChild(okBtn);
    box.appendChild(input); box.appendChild(footer);

    const win = Kit.create({
      id: 'styled-prompt-overlay', title: title || 'Name',
      modal: true, minimizable: false, resizable: false, closable: true,
      draggable: false, persistLayout: false,
      minWidth: 320, minHeight: 140,
      content: box,
      onClose: () => settle(null),
    });

    const ok = () => { settle((input.value || '').trim()); win.close(); };
    const cancel = () => { settle(null); win.close(); };
    okBtn.addEventListener('click', ok);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); ok(); }
    });

    win.open();
    _wireScrimClose('styled-prompt-overlay', cancel);   // backdrop click → cancel
    requestAnimationFrame(() => { try { input.focus(); input.select(); } catch {} });
  });
}

// Lookup table for esc(); hoisted out of the replace callback so it is
// allocated once rather than per matched character.
const _ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/**
 * HTML-escape a string to prevent XSS.
 * Canonical implementation — other modules should use uiModule.esc() instead of local copies.
 */
export function esc(s) {
  return (s || '').replace(/[&<>"']/g, (m) => _ESC_MAP[m]);
}

// ── Mobile: suppress synthetic click/mousedown on backdrop ──
// When a touch starts inside .modal-content, set a flag so that
// synthetic mouse events on the backdrop are ignored.
let _touchInsideModal = false;
if ('ontouchstart' in window) {
  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.modal-content')) {
      _touchInsideModal = true;
    }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    // Clear after a short delay — synthetic click fires ~300ms after touchend
    setTimeout(() => { _touchInsideModal = false; }, 400);
  }, { passive: true });
}

/**
 * Check if a backdrop dismiss should be suppressed on mobile.
 * Other modules can call this to guard their own backdrop handlers.
 */
export function isTouchInsideModal() {
  return _touchInsideModal;
}

// Close floating dropdowns/popups on scroll to prevent them drifting
function _initScrollDismiss() {
  const chatHistory = document.getElementById('chat-history');
  if (chatHistory) {
    chatHistory.addEventListener('scroll', () => {
      chatHistory.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));
      document.querySelectorAll('.ctx-popup').forEach(dismissOrRemove);
    }, { passive: true });
  } else {
    // Retry once if element doesn't exist yet
    setTimeout(_initScrollDismiss, 500);
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initScrollDismiss);
} else {
  _initScrollDismiss();
}

/**
 * Returns the SVG string for an empty-state icon. `kind` is one of
 * 'smiley' | 'sad' | 'neutral'. The returned <svg> has NO inline style —
 * callers wrap with `<span style="vertical-align:-3px;margin-left:6px;">…</span>`
 * (or similar) to keep the per-site visual nudge they need.
 */
export function emptyStateIcon(kind) {
  const SVG_OPEN = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const SVG_CLOSE = '</svg>';
  let inner;
  switch (kind) {
    case 'sad':
      inner = '<circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>';
      break;
    case 'neutral':
      inner = '<circle cx="12" cy="12" r="10"/><line x1="8" y1="15" x2="16" y2="15"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>';
      break;
    case 'smiley':
    default:
      inner = '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>';
      break;
  }
  return SVG_OPEN + inner + SVG_CLOSE;
}

const uiModule = {
  copyToClipboard,
  showToast,
  showError,
  styledConfirm,
  styledPrompt,
  scrollHistory,
  scrollHistoryInstant,
  setAutoScroll,
  getAutoScroll,
  autoResize,
  debounce,
  el,
  esc,
  isTouchInsideModal,
  emptyStateIcon,
  registerMenuDismiss
};

export default uiModule;

// Expose the styled confirm globally so any module can replace the native
// browser confirm() with the themed dialog — even files that don't import
// uiModule. Usage: `if (!await window.styledConfirm(msg, { danger:true })) return;`
if (typeof window !== 'undefined') {
  window.styledConfirm = styledConfirm;
}

// ── Mobile: clear enter animation so inline transform works for dragging ──
// The CSS `animation: sheet-enter ... forwards` holds the final transform,
// blocking any inline style changes. We clear it once the animation completes.
if ('ontouchstart' in window || isNarrow()) {
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'sheet-enter' &&
        (e.target.classList.contains('modal-content') || e.target.id === 'theme-popup')) {
      e.target.classList.add('sheet-ready');
    }
  });
  // When a modal is re-shown, remove sheet-ready so the enter animation plays again
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'class') {
        const modal = m.target;
        if (modal.classList.contains('modal') && !modal.classList.contains('hidden')) {
          const content = modal.querySelector('.modal-content') || modal.querySelector('#theme-popup');
          if (content) {
            content.classList.remove('sheet-ready', 'modal-closing');
          }
        }
      }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
}

// ── Mobile swipe-down-to-dismiss for bottom sheet modals ──
// Finger-following drag with velocity-based dismiss.
// Works from grab handle, header, OR anywhere on the sheet when content is scrolled to top.
if ('ontouchstart' in window) {
  const DISMISS_THRESHOLD = 50;    // px — dismiss if dragged past this
  const VELOCITY_THRESHOLD = 0.3;  // px/ms — fast flick dismisses even below threshold
  const RUBBER_RESISTANCE = 0.35;  // drag resistance when pulling up past origin

  let _swipeTarget = null;
  let _startY = 0, _startX = 0;
  let _lastY = 0, _lastT = 0;
  let _velocity = 0;
  let _dragging = false;    // true once we've committed to a vertical drag
  let _cancelled = false;   // true if horizontal movement detected

  // Close any floating dropdowns/menus that hang off body via position:fixed.
  // Called when a swipe-dismiss gesture starts so the menu doesn't orphan over
  // the page after the sheet slides away.
  function _closeFloatingDropdownsForSwipe() {
    document.querySelectorAll(
      '.email-card-dropdown, .hwfit-cached-dropdown, .cookbook-saved-menu, .cookbook-dep-menu'
    ).forEach(d => {
      if (d._anchor) d._anchor.classList.remove('cookbook-menu-active', 'reader-more-active');
      // Registered menus tear down through their own dismiss (releasing the
      // Escape-stack entry); unregistered ones (email/dep) just get removed.
      dismissOrRemove(d);
    });
  }

  document.addEventListener('touchstart', (e) => {
    // Match .modal-content or #theme-popup (which acts as modal-content but uses its own ID)
    const content = e.target.closest('.modal-content') || e.target.closest('#theme-popup');
    if (!content) return;

    // The image editor owns all touches inside its container so the user
    // can paint / move layers / draw selections without the modal trying
    // to interpret it as a swipe-to-dismiss gesture. Skip the swipe init
    // entirely when the touch starts inside the editor area.
    if (e.target.closest('.gallery-editor, .gallery-editor-container')) return;
    // Internal vertical drag handles (e.g. the calendar's cal-splitter that
    // resizes the day-detail pane) consume vertical touches themselves. If
    // we don't bail here, the swipe-dismiss path also tracks the touch and
    // slides the whole modal down as the user drags the handle. The
    // [data-no-swipe-dismiss] hook lets other components opt out the same
    // way without having to hard-code their selector here.
    if (e.target.closest('.cal-splitter, [data-no-swipe-dismiss]')) return;

    // Only allow swipe-dismiss from header or grab handle (top 48px)
    const isHeader = !!e.target.closest('.modal-header');
    const isButton = !!e.target.closest('button, input, select, label');
    if (isHeader && isButton) return; // let button clicks through
    const touch = e.touches[0];
    const contentRect = content.getBoundingClientRect();
    const isGrabZone = (touch.clientY - contentRect.top) < 48;
    // Also allow swipe-dismiss from anywhere on the sheet when it's already
    // scrolled to the top — feels natural and matches iOS bottom-sheet UX.
    const isAtScrollTop = content.scrollTop <= 0;

    if (!isHeader && !isGrabZone && !isAtScrollTop) return; // body touches → let native scroll handle it

    _swipeTarget = content;
    // Ensure CSS animation is cleared so inline transform works
    content.classList.add('sheet-ready');
    content.style.animation = 'none';
    _startY = touch.clientY;
    _startX = touch.clientX;
    _lastY = _startY;
    _lastT = e.timeStamp;
    _velocity = 0;
    _dragging = false;
    _cancelled = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!_swipeTarget || _cancelled) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - _startX);
    const dy = touch.clientY - _startY;

    // First few pixels: decide if this is horizontal scroll or content scroll
    if (!_dragging) {
      if (dx > 40 && dx > Math.abs(dy) * 2) {
        _swipeTarget.style.transform = '';
        _swipeTarget = null;
        _cancelled = true;
        return;
      }
      if (Math.abs(dy) > 8) {
        // Find the nearest scrollable ancestor of the touch point
        let scrollEl = e.target;
        while (scrollEl && scrollEl !== _swipeTarget) {
          if (scrollEl.scrollHeight > scrollEl.clientHeight + 1) {
            const ov = getComputedStyle(scrollEl).overflowY;
            if (ov === 'auto' || ov === 'scroll') break;
          }
          scrollEl = scrollEl.parentElement;
        }
        const hasScroller = scrollEl && scrollEl !== _swipeTarget;
        // If touch is inside a scrollable child, let native scroll handle it
        if (hasScroller) {
          _swipeTarget.style.transform = '';
          _swipeTarget = null;
          _cancelled = true;
          return;
        }
        // If swiping up and modal-content itself is scrollable, let native handle it
        if (dy < 0 && _swipeTarget.scrollHeight > _swipeTarget.clientHeight + 1) {
          _swipeTarget.style.transform = '';
          _swipeTarget = null;
          _cancelled = true;
          return;
        }
        // If swiping down but content isn't at the top, let native scroll
        if (dy > 0 && _swipeTarget.scrollTop > 0) {
          _swipeTarget.style.transform = '';
          _swipeTarget = null;
          _cancelled = true;
          return;
        }
        _dragging = true;
        _swipeTarget.style.transition = 'none';
        _swipeTarget.style.willChange = 'transform';
        // A swipe is starting — close any floating menus/dropdowns so they
        // don't orphan over the page once the sheet slides away. Covers the
        // email reader More menu, cookbook serve kebab + saved-configs, and
        // anything else hanging off body via _anchor.
        _closeFloatingDropdownsForSwipe();
      } else {
        return;
      }
    }

    // Track velocity (exponential moving average)
    const dt = e.timeStamp - _lastT;
    if (dt > 0) {
      const instantV = (touch.clientY - _lastY) / dt;
      _velocity = _velocity * 0.6 + instantV * 0.4;
    }
    _lastY = touch.clientY;
    _lastT = e.timeStamp;

    e.preventDefault();
    if (dy > 0) {
      _swipeTarget.style.transform = `translateY(${dy}px)`;
    } else {
      const rubberDy = dy * RUBBER_RESISTANCE;
      _swipeTarget.style.transform = `translateY(${rubberDy}px)`;
    }
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (!_swipeTarget || !_dragging) {
      _swipeTarget = null;
      return;
    }
    const el = _swipeTarget;
    _swipeTarget = null;

    const dy = _lastY - _startY;
    const shouldDismiss = dy > DISMISS_THRESHOLD || (dy > 20 && _velocity > VELOCITY_THRESHOLD);

    el.style.willChange = '';

    if (shouldDismiss) {
      // Animate out — use remaining distance to calculate duration
      const remaining = el.offsetHeight - dy;
      const speed = Math.max(Math.abs(_velocity), 0.8); // min speed
      const duration = Math.min(Math.max(remaining / speed, 120), 300);
      el.style.transition = `transform ${duration}ms cubic-bezier(0.2, 0, 0.4, 1)`;
      el.style.transform = 'translateY(100%)';
      setTimeout(() => {
        const modal = el.closest('.modal');
        if (modal) {
          modal.classList.add('hidden');
          // Some modals (calendar, email library) toggle visibility via
          // inline display style which would override .hidden — clear it
          // so the modal is actually dismissed.
          modal.style.display = '';
          document.querySelectorAll('#settings-menu-list .list-item.active').forEach(i => i.classList.remove('active'));
          // Notify modules so they can sync internal open-state flags
          window.dispatchEvent(new CustomEvent('modal-dismissed', { detail: { id: modal.id } }));
          // Swiping a tool away to reveal a new/empty chat replays the welcome
          // "splash" reveal — the same nice effect notes gives on dismiss.
          // Only when the welcome screen is already the active state (new chat),
          // so we never cover a chat that has messages.
          const ws = document.getElementById('welcome-screen');
          if (ws && !ws.classList.contains('hidden')) {
            window.chatModule?.showWelcomeScreen?.();
          }
        }
        el.classList.remove('sheet-ready');
        el.style.transform = '';
        el.style.transition = '';
        el.style.animation = '';
      }, duration + 10);
    } else {
      // Snap back with spring-like easing
      el.style.transition = 'transform 0.25s cubic-bezier(0.2, 0.9, 0.3, 1.05)';
      el.style.transform = '';
      setTimeout(() => { el.style.transition = ''; el.style.animation = ''; }, 260);
    }
  }, { passive: true });
}

// ---- Bring modal to front on click ----
{
  let topModalZ = 250;
  document.addEventListener('mousedown', (e) => {
    const modalContent = e.target.closest('.modal-content');
    if (!modalContent) return;
    const modal = modalContent.closest('.modal');
    if (!modal) return;
    topModalZ += 1;
    modal.style.zIndex = topModalZ;
  });

  // Backdrop tap to close — delegated for all modals
  document.addEventListener('mousedown', (e) => {
    if (_touchInsideModal) return; // suppress synthetic events from content scrolling
    if (!e.target.classList.contains('modal')) return;
    const modal = e.target;
    if (modal.classList.contains('hidden')) return;
    const content = modal.querySelector('.modal-content');
    if (content) {
      content.classList.add('modal-closing');
      content.addEventListener('animationend', () => {
        modal.classList.add('hidden');
        content.classList.remove('modal-closing');
      }, { once: true });
      setTimeout(() => {
        if (!modal.classList.contains('hidden')) {
          modal.classList.add('hidden');
          content.classList.remove('modal-closing');
        }
      }, 300);
    } else {
      modal.classList.add('hidden');
    }
  });
}

// ── Mobile: keep focused inputs visible above the keyboard ──
// When an input inside a modal gets focus on mobile, the OS keyboard
// covers the bottom half of the screen. The browser is supposed to
// scroll the input into view, but in bottom-sheet modals with their
// own scrolling container that often fails — the user types blind.
// Scroll the input into the middle of the still-visible viewport
// after the keyboard has had a moment to animate in.
if ('ontouchstart' in window || isNarrow()) {
  let _kbScrollTimer = null;
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const tag = el.tagName;
    const isText = tag === 'INPUT' || tag === 'TEXTAREA' ||
                   (tag === 'DIV' && el.isContentEditable);
    if (!isText) return;
    // Inputs of type button/checkbox/radio/range/etc. don't summon a keyboard
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (['button','submit','reset','checkbox','radio','range','color','file','image'].includes(t)) return;
    }
    if (_kbScrollTimer) clearTimeout(_kbScrollTimer);
    // The keyboard typically takes 200–300ms to slide up; do the scroll
    // after that so we know the final visible viewport height.
    _kbScrollTimer = setTimeout(() => {
      _kbScrollTimer = null;
      // Skip the scroll if the input is already visible inside the
      // current viewport (with a small comfort margin). Otherwise every
      // re-focus — including the programmatic refocus that happens when
      // a typeahead input rebuilds the DOM on every keystroke — would
      // re-scroll the modal and yank the page up and down as the user
      // types.
      try {
        const r = el.getBoundingClientRect();
        const vh = (window.visualViewport?.height) || window.innerHeight;
        const margin = 24;
        const fullyVisible = r.top >= margin && r.bottom <= vh - margin;
        if (fullyVisible) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch {
        try { el.scrollIntoView(); } catch {}
      }
    }, 300);
  });
}

// ── Global Escape arbiter: close exactly one thing per press ──
// Priority: expanded library card → open chat thinking block → topmost modal.
// Runs capture-phase + stopImmediatePropagation so per-modal ESC listeners
// never also fire (which would otherwise close several modals at once).
if (!window._odyEscExpandGuard) {
  window._odyEscExpandGuard = true;

  // Auto-promote any modal that becomes visible to the top of the z-stack.
  // Every modal shares `z-index: 250` from the base `.modal` rule, so visual
  // stacking falls back to DOM order — which is unpredictable (cookbook is
  // a static HTML node, calendar gets appended once and stays, compare and
  // research get re-appended on each open). Result: opening compare AFTER
  // cookbook can render compare UNDER it. Bumping the z-index on every
  // open guarantees most-recently-opened wins both visually AND for ESC.
  // A2 (#573, DWE audit F9): THE single z/focus authority for the whole window
  // system — both the legacy .modal family AND the OrwellWindow kit's non-modal
  // band draw from this ONE object. Before this, there were two disconnected
  // counters: ui.js's `_zCounter` (1000+, the .modal ladder) and the kit's
  // private `_zTop` (500–980, orwellWindow.js). "Topmost / focused" was decided
  // by two sources that agreed only by the convention of a numeric gap — a kit
  // window raised after a modal could climb into the modal's range with no
  // structural floor stopping it. OrwellZ fixes that structurally:
  //   • ONE monotonic tick (`_tick`) — every raise (window OR modal) advances it,
  //     so "most recently focused, across every surface" is globally unambiguous.
  //   • TWO bands enforce the family ordering by construction (banner > modal >
  //     window, per the DWE audit): a modal's z always lands ≥ MODAL_FLOOR, a kit
  //     window's z always lands in [WINDOW_FLOOR, MODAL_FLOOR), so a modal can
  //     NEVER be painted under a kit window regardless of which was touched last.
  //   • The kit-band tick saturates one below the modal floor and renormalizes
  //     (the kit's old `_zTop` ceiling behavior, now owned here) so it can't leak
  //     across the gap; the modal band is unbounded upward (statics live above it).
  const OrwellZ = (() => {
    const WINDOW_FLOOR = 500;   // kit non-modal band floor (was orwellWindow.js Z_BASE)
    const WINDOW_CEIL = 980;    // kit band ceiling before renormalize (was Z_CEIL)
    const MODAL_FLOOR = 1000;   // .modal family + kit modal tier floor
    let _tick = MODAL_FLOOR;    // the one monotonic counter; modal z == _tick
    let _winTick = WINDOW_FLOOR; // kit-band sub-cursor, saturated below MODAL_FLOOR
    return {
      // Allocate the next modal z. Monotonic, unbounded upward — the .modal
      // ladder and the kit's modal:true windows both call this, so they share
      // one ladder and can never out-climb each other.
      nextModalZ() { return ++_tick; },
      // Allocate the next kit-window z. Advances the SAME global tick (so focus
      // order is one truth) but maps into the kit band, renormalizing the open
      // kit stack when it would touch the modal floor. `restack(els)` re-lays the
      // currently-open kit windows bottom→top so a renormalize keeps their order.
      nextWindowZ(restack) {
        _tick++;
        if (_winTick >= WINDOW_CEIL) {
          _winTick = WINDOW_FLOOR;
          if (typeof restack === 'function') {
            try { restack((els) => els.forEach((el) => { if (el) el.style.zIndex = String(++_winTick); })); } catch (_) {}
          }
        }
        return ++_winTick;
      },
      // The current top of the modal ladder (for the re-entry guard below).
      modalTop() { return _tick; },
    };
  })();
  const _isVisible = (m) => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none';
  const _promote = (m) => {
    if (!m?.classList?.contains('modal') || !_isVisible(m)) return;
    // Re-entry guard: setting style.zIndex itself fires the observer that
    // calls us back. Skip if this element is already pinned to the top
    // (matches the current modal ladder top) so we don't spin into a loop.
    const cur = parseInt(m.style.zIndex, 10) || 0;
    if (cur === OrwellZ.modalTop()) return;
    m.style.zIndex = String(OrwellZ.nextModalZ());
  };
  // Expose the single allocator for both families. The kit draws its MODAL tier
  // from `_owNextModalZ` (so a kit modal and a legacy .modal share one ladder)
  // and its NON-MODAL band from `_owNextWindowZ` (so the kit band rides the same
  // global tick — one source of truth for "topmost / focused", with the band
  // offsets keeping modals structurally above kit windows).
  window._owNextModalZ = () => OrwellZ.nextModalZ();
  window._owNextWindowZ = (restack) => OrwellZ.nextWindowZ(restack);
  window.OrwellZ = OrwellZ;
  // Lane G14 (DWE audit F9b): this counter is the ONE z-authority for the
  // whole .modal family — the same ladder pickTopModal reads for Escape.
  // modalManager's _bringToFront defers here instead of stamping its own
  // second counter (the old _modalTopZ 300s, written with !important), so
  // visual order, dock-restore order, and Escape order can never disagree.
  window._owPromoteModal = _promote;
  // F8 / A2 (#573, DWE audit F9): ONE focus-return implementation for the whole
  // window system. Closing a surface returns focus to its opener, but ONLY when
  // focus still sits inside the closing surface or fell to <body> (never yank it
  // from somewhere the user has since moved it). Before A2 there were TWO copies
  // of this rule — this observer's `_restoreFocus` (the .modal family) and the
  // kit's own copy in orwellWindow.js `_teardown` — that could drift. The kit now
  // delegates to this single helper (window._owReturnFocus); the .modal observer
  // calls it with the closing modal as the "inside" container.
  const _returnFocus = (opener, container) => {
    if (!opener || !opener.isConnected || typeof opener.focus !== 'function') return;
    const active = document.activeElement;
    if (active && active !== document.body && container && container.contains && container.contains(active)) {
      // focus is still inside the closing surface → safe to return it
    } else if (active && active !== document.body) {
      return;  // the user moved focus elsewhere — don't yank it back
    }
    try { opener.focus(); } catch {}
  };
  window._owReturnFocus = _returnFocus;
  const _restoreFocus = (m) => {
    const opener = m._owOpener;
    m._owOpener = null;
    _returnFocus(opener, m);
  };
  const _trackVisibility = (m) => {
    if (!m?.classList?.contains('modal')) return;
    const vis = _isVisible(m);
    if (vis && !m._owWasVisible) {
      const a = document.activeElement;
      if (a && a !== document.body && !m.contains(a)) m._owOpener = a;
    } else if (!vis && m._owWasVisible) {
      _restoreFocus(m);
    }
    m._owWasVisible = vis;
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(n => { if (n.nodeType === 1) { _promote(n); _trackVisibility(n); } });
      else if (m.type === 'attributes' && m.target?.classList?.contains('modal')) { _promote(m.target); _trackVisibility(m.target); }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  document.querySelectorAll('.modal').forEach((m) => { _promote(m); m._owWasVisible = _isVisible(m); });

  const pickTopModal = () => {
    const modals = [...document.querySelectorAll('.modal')].filter(_isVisible);
    if (!modals.length) return null;
    return modals.reduce((top, m) =>
      (parseInt(getComputedStyle(m).zIndex, 10) || 0) >= (parseInt(getComputedStyle(top).zIndex, 10) || 0)
        ? m : top
    );
  };

  // AXE-8 (WCAG 2.1.2 No Keyboard Trap / 2.4.3 Focus Order): the legacy `.modal` family
  // (Brain/memory, Cookbook, custom-preset — anything that never migrated onto the
  // OrwellWindow kit) had no Tab-cycling trap, unlike `orwellWindow.js`'s own
  // `_trapFocus()` (settings-modal). Generalized here into the ONE shared `.modal`
  // observer so every member of the family gets it at once, matching the kit's pattern:
  // Tab/Shift+Tab cycles within the topmost visible modal instead of escaping into the
  // (visually-behind, but not actually inert) page content.
  const _focusableIn = (container) => Array.prototype.filter.call(
    container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    (n) => !n.disabled && (n.offsetParent !== null || n === document.activeElement)
  );
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    const top = pickTopModal();
    if (!top || !top.contains(document.activeElement)) return;
    const focusable = _focusableIn(top);
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;

    // Focused-context-first (DWE; Lane F wave 3): a surface marked
    // data-ow-escape-scope owns Escape while the event originates inside it
    // (e.g. the decision card's dismiss-only handler). The arbiter stands down
    // and lets the surface's own listener act.
    if (e.target && e.target.closest && e.target.closest('[data-ow-escape-scope]')) return;

    // Find the single thing to close, in priority order. The first hit wins.
    // Important: if a thinking block is open we MUST handle it ourselves and
    // not fall through to closing a modal — even if its header is missing
    // (the live-stream chat rebuilds thinking DOM mid-stream so the header
    // can briefly be absent). Toggling the `expanded` class directly is the
    // fallback so ESC never bypasses the thinking block to hit a modal.
    if (_closeHoveredWindow()) {
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    // Transient ad-hoc menus (dropdowns / context popups) live outside the
    // .modal system and register a dismiss callback in escMenuStack. Close the
    // most-recently-opened one first — so a menu opened over a modal dismisses
    // before the modal — and do it BEFORE the text-input guard below, since a
    // menu may own the focused input (e.g. a search dropdown).
    if (dismissTopMenu()) {
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    // Kit windows (Lane F / DWE audit F7, ordering fixed in wave 3): a visible
    // MODAL outranks every non-modal window (it owns the higher z band), so the
    // top kit window parks on Escape only when no modal is open — menus, then
    // modals, then windows.
    if (!pickTopModal() && window.OrwellWindowKit && window.OrwellWindowKit.dismissTop()) {
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    // OrwellSheet (#753): a modal bottom-sheet (the casting sheet) is a dialog at the sheet z-band
    // — Escape dismisses the top open one, after menus + kit windows but before the settings modal.
    // Anchored (non-modal) sheets — the decision action-sheet — deliberately skip Escape here (the
    // decision card owns its OWN card-scoped Escape-to-dismiss). The kit returns false when no modal
    // sheet is open, so this never swallows Escape from the rest of the chain.
    if (window.OrwellSheetKit && window.OrwellSheetKit.dismissTop()) {
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    // #553: a visible Settings kit modal (.ow-window) dismisses on Escape with DIALOG semantics —
    // from any focused field, like the old bespoke handler. This runs BEFORE the input guard below
    // (which would otherwise swallow ESC whenever a settings input/select has focus). Inner
    // integration/email edit form closes first; otherwise the window closes via its kit ×.
    const _settingsWin = document.getElementById('settings-modal');
    if (_settingsWin && _settingsWin.classList.contains('ow-window') && _isVisible(_settingsWin)) {
      const innerForm = _settingsWin.querySelector('#unified-intg-form, #set-email-accounts-form');
      if (innerForm && innerForm.style.display !== 'none' && innerForm.children.length > 0) {
        e.preventDefault(); e.stopImmediatePropagation();
        innerForm.style.display = 'none'; innerForm.innerHTML = '';
        return;
      }
      const owClose = _settingsWin.querySelector('.ow-close');
      if (owClose) { e.preventDefault(); e.stopImmediatePropagation(); try { owClose.click(); } catch {} return; }
    }
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const expanded = document.querySelector('.doclib-card-expanded');
    const think = document.querySelector('.thinking-content.expanded');
    if (expanded) {
      e.stopImmediatePropagation(); e.preventDefault();
      try { expanded.click(); } catch {}
      return;
    }
    if (think) {
      e.stopImmediatePropagation(); e.preventDefault();
      const thinkHeader = think.closest('.thinking-section')?.querySelector('.thinking-header[data-thinking-id]');
      if (thinkHeader) { try { thinkHeader.click(); } catch {} }
      else {
        // No header found — collapse the content directly.
        try { think.classList.remove('expanded'); } catch {}
      }
      return;
    }
    const galleryEditor = document.getElementById('gallery-editor-container');
    const galleryModal = galleryEditor?.closest('.modal');
    const galleryEditing = !!(
      galleryEditor &&
      galleryModal &&
      !galleryModal.classList.contains('hidden') &&
      getComputedStyle(galleryEditor).display !== 'none' &&
      galleryEditor.querySelector('.gallery-editor')
    );
    if (galleryEditing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const settingsModal = document.getElementById('settings-modal');
    if (settingsModal && _isVisible(settingsModal)) {
      const innerForm = settingsModal.querySelector('#unified-intg-form, #set-email-accounts-form');
      if (innerForm && innerForm.style.display !== 'none' && innerForm.children.length > 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        innerForm.style.display = 'none';
        innerForm.innerHTML = '';
        return;
      }
    }
    const topModal = pickTopModal();
    if (!topModal) return;
    const closeBtn = topModal.querySelector('.close-btn, .modal-close-btn, [data-action="close"]');
    e.stopImmediatePropagation();
    e.preventDefault();
    if (closeBtn) { try { closeBtn.click(); } catch {} }
    else { try { topModal.classList.add('hidden'); } catch {} }
  }, true);
}
