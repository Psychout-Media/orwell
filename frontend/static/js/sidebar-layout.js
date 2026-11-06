import { isNarrow } from './platform.js';
// ============================================
// Sidebar Layout — icon rail, hamburger cycling, mobile backdrop & swipe
// ============================================

let _syncRailSideFn = null;

/**
 * Get the current syncRailSide function reference.
 * Needed because it gets patched after initial setup.
 */
export function syncRailSide() {
  if (_syncRailSideFn) _syncRailSideFn();
}

/**
 * Initialize sidebar layout: icon rail, hamburger cycling, mobile backdrop, swipe gestures.
 * @param {Object} Storage - Storage module
 * @param {Object} opts
 * @param {Object} opts.documentModule - Document module (for swapSide)
 * @param {Function} opts._closeCompareIfActive
 * @param {Function} opts._deactivateIncognito
 * @param {Object} opts.presetsModule
 * @param {Object} opts.sessionModule
 * @param {Function} opts.el - Element lookup helper
 * @param {*} opts._defaultChat - Default chat config
 * @param {Function} opts._syncResearchIndicator
 */
export function initSidebarLayout(Storage, opts) {
  const {
    documentModule, _closeCompareIfActive, _deactivateIncognito,
    presetsModule, sessionModule, el, _defaultChat, _syncResearchIndicator
  } = opts;

  // ── Icon rail + sidebar toggle ──
  const iconRail = document.getElementById('icon-rail');
  const hamburgerBtn = document.getElementById('hamburger-btn');

  function _syncRailSideCore() {
    const sidebar = document.getElementById('sidebar');
    const isRight = !!(sidebar && sidebar.classList.contains('right-side'));
    // SINGLE SOURCE OF TRUTH for the layout side: the gadget dock is the nav sidebar's
    // PAIR on the OPPOSITE edge. Mirror it here (sidebar-right ⟹ dock-left) so BOTH swap
    // entry points — the ⇄ dock button and a shift-click on the hamburger — move BOTH
    // columns together and the hamburger always follows the sidebar. Before this, ⇄ slid
    // the sidebar over via flex `order` but left its hamburger stranded over the relocated
    // dock (the "sideways caret under the hamburger" overlap). Runs even with no icon rail.
    if (isRight) document.body.setAttribute('data-gadget-side', 'left');
    else document.body.removeAttribute('data-gadget-side');
    if (!iconRail) return;
    const sidebarHidden = sidebar.classList.contains('hidden');
    const railHidden = iconRail.classList.contains('rail-hidden');
    const isMobileMini = iconRail.classList.contains('mobile-mini');
    iconRail.classList.toggle('right-side', isRight);
    // On mobile mini mode, JS already set inline styles — don't touch
    if (isMobileMini) {
      // Just update side positioning
      if (isRight) {
        iconRail.style.left = 'auto';
        iconRail.style.right = '0';
      } else {
        iconRail.style.left = '0';
        iconRail.style.right = 'auto';
      }
    } else {
      iconRail.style.display = (sidebarHidden && !railHidden) ? '' : 'none';
    }
    // Hamburger is always visible — just update body classes for CSS layout adjustments
    if (hamburgerBtn) {
      document.body.classList.toggle('hamburger-right', isRight);
      document.body.classList.toggle('hamburger-left', !isRight);
      document.body.classList.toggle('hamburger-only', sidebarHidden && railHidden);
      document.body.classList.toggle('sidebar-collapsed', sidebarHidden);
    }
    // Keep incognito button clear of hamburger
    const incogBtn = document.getElementById('incognito-btn');
    if (incogBtn) {
      if (isRight && sidebarHidden) {
        incogBtn.style.right = '48px';
      } else {
        incogBtn.style.right = '';
      }
    }
  }

  // Set initial reference and expose globally
  _syncRailSideFn = _syncRailSideCore;
  window.syncRailSide = syncRailSide;

  // ── #637: the panel SIDE is a synced, last-write-wins field of the 0064 layout store ──
  // The side persists locally (Storage.KEYS.SIDEBAR_SIDE) as the offline/seed fallback, but the
  // SYNCED value (id "panel" {side}) is the source of truth: it crosses devices and mirrors live
  // between two windows via the same `orwell:window-layout` → PATCH → `layout-changed` seam the kit
  // uses. #552 stands: mobile reads the persisted side READ-ONLY (no swap), so a remote side still
  // applies on mobile — it just can't be flipped there.
  let _applyingSyncedSide = false;
  function _curSide() {
    const sb = document.getElementById('sidebar');
    return sb && sb.classList.contains('right-side') ? 'right' : 'left';
  }
  function _emitSide(side) {
    if (_applyingSyncedSide) return;   // never echo a remote apply back out
    try {
      window.dispatchEvent(new CustomEvent('orwell:window-layout',
        { detail: { id: 'panel', state: { side: side === 'right' ? 'right' : 'left' } } }));
    } catch (_) {}
  }
  function _applySyncedSide(side) {
    if (side !== 'left' && side !== 'right') return;
    if (_applyingSyncedSide) return;
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    const wantRight = side === 'right';
    if (sb.classList.contains('right-side') === wantRight) return;   // already in step
    _applyingSyncedSide = true;
    try {
      sb.classList.toggle('right-side', wantRight);
      try { Storage.set(Storage.KEYS.SIDEBAR_SIDE, side); } catch (_) {}
      syncRailSide();
      if (documentModule && documentModule.swapSide) { try { documentModule.swapSide(); } catch (_) {} }
    } finally { _applyingSyncedSide = false; }
  }
  function _onSyncedLayoutSide(e) {
    const d = e && e.detail;
    if (!d || d.windowId !== 'panel' || !d.state) return;
    _applySyncedSide(d.state.side);
  }
  window.addEventListener('orwell:layout-seed', _onSyncedLayoutSide);     // initial GET /layout
  window.addEventListener('orwell:layout-changed', _onSyncedLayoutSide);  // a peer window / device

  // Restore sidebar side preference
  if (Storage.get(Storage.KEYS.SIDEBAR_SIDE) === 'right') {
    document.getElementById('sidebar').classList.add('right-side');
  }
  syncRailSide();

  // The ONE layout-side swap: flip the nav sidebar to the other edge. _syncRailSideCore
  // mirrors the gadget dock to the OPPOSITE edge and moves the hamburger with it, so the
  // ⇄ dock button and a shift-click on the hamburger both swap BOTH columns cleanly (no
  // stranding). The ⇄ button (orwellGadgetRail) calls this so there is ONE swap path.
  function toggleSidebarSide() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    // #552 — side-swap is a DESKTOP power-feature. On a narrow viewport the two
    // swap entry points (shift-click + the ⇄ dock button) plus the mobile open
    // path disagreed, so a tap appeared to flip sides "randomly" and there is no
    // room for both edges anyway. Disable swap entirely on mobile; the last
    // desktop-configured side stays persisted and is applied read-only on mobile.
    if (isNarrow()) return;
    sidebar.classList.toggle('right-side');
    try { Storage.set(Storage.KEYS.SIDEBAR_SIDE, sidebar.classList.contains('right-side') ? 'right' : 'left'); } catch (_) {}
    syncRailSide();
    if (documentModule && documentModule.swapSide) { try { documentModule.swapSide(); } catch (_) {} }
    _emitSide(_curSide());   // #637: fan the new side out (synced, LWW)
  }
  try { window._orwellToggleSidebarSide = toggleSidebarSide; } catch (_) {}

  // In-sidebar toggle button — same behavior as hamburger
  const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
  if (sidebarToggleBtn) {
    sidebarToggleBtn.addEventListener('click', (e) => {
      if (hamburgerBtn) hamburgerBtn.click();
    });
  }

  // New chat buttons — same as clicking brand
  const chatNewBtn = document.getElementById('chat-new-btn');
  const sidebarNewChat = document.getElementById('sidebar-new-chat-btn');
  [chatNewBtn, sidebarNewChat].forEach(btn => {
    if (btn) btn.addEventListener('click', () => {
      const brandBtn = document.getElementById('sidebar-brand-btn');
      if (brandBtn) brandBtn.click();
    });
  });

  // Hamburger cycles: full sidebar → mini → off → full
  // Shift-click swaps sidebar side
  let _userToggledSidebar = false;
  let _wasAutoCollapsed = false;

  // Deliberate "open the sidebar" used by the mobile swipe gesture (wired at
  // module scope). It MUST set _userToggledSidebar so the auto-collapse
  // MutationObserver doesn't immediately re-hide it (the swipe was opening it,
  // then checkSidebarAutoCollapse re-added .hidden because this flag was unset
  // — looked like nothing happened). Mirrors the hamburger's mobile-open path.
  window._odyOpenSidebar = function(side) {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    // On mobile, never open the sidebar while Compare is running — the panes
    // own the screen and stray gestures (swipe, dragging a dock chip to the X)
    // were popping it open. Blocking the open helper covers every path.
    const cc = document.getElementById('chat-container');
    if (isNarrow() && cc && cc.classList.contains('compare-active')) return;
    _userToggledSidebar = true;
    // #552 — the swipe gesture used to pick (and PERSIST) the side from the swipe
    // DIRECTION, which silently mutated the configured side and made the hamburger
    // jump. On mobile we now honor the persisted side READ-ONLY: open on whatever
    // edge was last configured (on desktop), never mutate it from a swipe. On
    // desktop the explicit `side` arg is still honored + persisted.
    if (!isNarrow() && (side === 'left' || side === 'right')) {
      const wantRight = side === 'right';
      if (sidebar.classList.contains('right-side') !== wantRight) {
        sidebar.classList.toggle('right-side', wantRight);
        try { Storage.set(Storage.KEYS.SIDEBAR_SIDE, side); } catch (_) {}
        if (documentModule && documentModule.swapSide) { try { documentModule.swapSide(); } catch (_) {} }
        _emitSide(side);   // #637: fan the new side out (synced, LWW)
      }
    }
    const backdrop = document.getElementById('sidebar-backdrop');
    if (isNarrow() && iconRail) { iconRail.classList.remove('mobile-mini'); iconRail.style.cssText = ''; }
    sidebar.classList.remove('hidden');
    if (backdrop && isNarrow()) backdrop.classList.add('visible');
    syncRailSide();
  };

  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sidebar = document.getElementById('sidebar');
      if (e.shiftKey) {
        toggleSidebarSide();   // the ONE swap path (mirrors the dock + moves the hamburger)
        return;
      }

      _userToggledSidebar = true;
      const isSidebarVisible = !sidebar.classList.contains('hidden');

      if (isNarrow()) {
        // Mobile: full sidebar ↔ hidden — simple toggle, no mini rail
        const backdrop = document.getElementById('sidebar-backdrop');
        if (iconRail) { iconRail.classList.remove('mobile-mini'); iconRail.style.cssText = ''; }

        if (isSidebarVisible) {
          // Closing sidebar
          sidebar.classList.add('hidden');
          if (backdrop) backdrop.classList.remove('visible');
        } else {
          // #552 — the hamburger used to FORCE the sidebar to the right on every
          // mobile open, overriding the player's last-configured side and making
          // the side state inconsistent (the "random flip"). Honor the persisted
          // side read-only instead: open on whatever edge `right-side` already
          // reflects (restored from SIDEBAR_SIDE at init), never mutate it here.
          syncRailSide();
          // Opening sidebar — blur keyboard first, then open after layout settles
          if (document.activeElement && document.activeElement !== document.body
              && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) {
            document.activeElement.blur();
            // Wait for keyboard dismiss to settle, then open
            setTimeout(() => {
              sidebar.classList.remove('hidden');
              if (backdrop) backdrop.classList.add('visible');
              syncRailSide();
            }, 250);
          } else {
            sidebar.classList.remove('hidden');
            if (backdrop) backdrop.classList.add('visible');
          }
        }
        syncRailSide();
        return;
      }

      // Desktop: full sidebar ↔ mini (icon rail) — simple toggle
      if (isSidebarVisible) {
        sidebar.classList.add('hidden');
      } else {
        _wasAutoCollapsed = false;
        iconRail.classList.remove('rail-hidden');
        sidebar.classList.remove('hidden');
      }
      syncRailSide();
    });
  }

  // Icon rail section clicks — open sidebar and scroll to section
  if (iconRail) {
    iconRail.addEventListener('click', (e) => {
      const btn = e.target.closest('.icon-rail-btn');
      if (!btn || btn.id === 'rail-new-session' || btn.id === 'rail-delete-session' || btn.id === 'rail-search-btn' || btn.id === 'rail-settings' || btn.id === 'rail-admin') return;
      const sectionId = btn.dataset.section;
      if (!sectionId) return;
      const sidebar = document.getElementById('sidebar');
      sidebar.classList.remove('hidden');
      syncRailSide();
      const section = document.getElementById(sectionId);
      if (section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        section.classList.remove('collapsed');
      }
    });
  }

  // Auto-collapse sidebar when window gets small or chat area is squeezed
  const AUTO_COLLAPSE_WIDTH = 700;
  const MIN_CHAT_WIDTH = 380; // collapse sidebar if chat gets narrower than this

  function checkSidebarAutoCollapse() {
    if (_userToggledSidebar) return;
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const isHidden = sidebar.classList.contains('hidden');

    // Check if chat area is too narrow (e.g. sidebar + doc panel both open).
    // BUT — if a tile-snapped modal exists, IT is what's making chat narrow,
    // and that's the user's explicit choice. Don't auto-collapse the sidebar
    // in response, or we get a reactive loop: snap → narrow chat → hide
    // sidebar → safe-rect changes → reclamp modal → new chat width → ...
    const chatContainer = document.querySelector('.chat-container');
    const hasTileSnapped = document.querySelector('.modal-content[data-_tile-zone], .research-pane[data-_tile-zone]');
    const chatTooNarrow = chatContainer && chatContainer.offsetWidth < MIN_CHAT_WIDTH && !isHidden && !hasTileSnapped;

    if ((window.innerWidth < AUTO_COLLAPSE_WIDTH || chatTooNarrow) && !isHidden) {
      sidebar.classList.add('hidden');
      _wasAutoCollapsed = true;
      syncRailSide();
    } else if (window.innerWidth >= AUTO_COLLAPSE_WIDTH && isHidden && _wasAutoCollapsed) {
      // Only restore if chat won't be too narrow
      sidebar.classList.remove('hidden');
      void document.body.offsetWidth; // reflow
      if (chatContainer && chatContainer.offsetWidth < MIN_CHAT_WIDTH) {
        sidebar.classList.add('hidden');
      } else {
        _wasAutoCollapsed = false;
      }
      syncRailSide();
    }
  }

  window.addEventListener('resize', () => {
    _userToggledSidebar = false; // allow auto-collapse on actual resize
    requestAnimationFrame(checkSidebarAutoCollapse);
  });
  // Also re-check when doc panel toggles
  new MutationObserver(() => requestAnimationFrame(checkSidebarAutoCollapse))
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // Auto-collapse on initial load if window is small
  if (window.innerWidth < AUTO_COLLAPSE_WIDTH) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.classList.contains('hidden')) {
      sidebar.classList.add('hidden');
      _wasAutoCollapsed = true;
      syncRailSide();
    }
  }

  // ── Mobile sidebar backdrop + swipe-to-close ──
  // Backdrop overlay: tapping it closes the sidebar
  const mobileBackdrop = document.createElement('div');
  mobileBackdrop.id = 'sidebar-backdrop';
  document.body.appendChild(mobileBackdrop);

  function updateMobileBackdrop() {
    if (!isNarrow()) { mobileBackdrop.classList.remove('visible'); return; }
    const sb = document.getElementById('sidebar');
    const rail = document.getElementById('icon-rail');
    const sidebarOpen = sb && !sb.classList.contains('hidden');
    const miniOpen = rail && rail.classList.contains('mobile-mini');
    mobileBackdrop.classList.toggle('visible', sidebarOpen || miniOpen);
  }

  // Snapshot whether a kit menu/popover (OrwellMenuKit / OrwellPopoverKit,
  // #1638) is open at PRESS time. The kit's outside-click dismissal runs in the
  // click CAPTURE phase (bindMenuDismiss), so it detaches the .ow-popover before
  // this backdrop handler's bubble-phase runs — a live query there would already
  // be null and race away. pointerdown fires before the click while the surface
  // is still mounted, so the flag captures the pre-dismissal truth.
  window._owPopoverOpenAtPress = false;
  document.addEventListener('pointerdown', () => {
    window._owPopoverOpenAtPress = !!document.querySelector('.ow-popover');
  }, true);

  // Suppress sidebar close briefly after dropdown actions
  window._suppressSidebarClose = false;
  mobileBackdrop.addEventListener('click', (e) => {
    if (window._suppressSidebarClose) return;
    // Don't close while a session is being renamed inline — the rename input
    // lives inside the sidebar, and a backdrop tap (e.g. to dismiss the
    // keyboard) would otherwise kick the user out mid-rename.
    if (document.querySelector('.session-rename-input')) return;
    // A kit menu/popover was open when this tap began — the FIRST backdrop tap
    // dismisses THAT menu (via the kit's own capture-phase outside-click seat),
    // never the sidebar. Consume the flag so the SECOND tap (nothing open) falls
    // through and closes the sidebar. stopPropagation keeps the sibling
    // document-level outside-click handler (below) from closing the sidebar on
    // this same tap — that handler keys on e.target (the backdrop, not the menu),
    // so it can't tell a menu was open; only this snapshot can. (#1638)
    if (window._owPopoverOpenAtPress) {
      window._owPopoverOpenAtPress = false;
      e.stopPropagation();
      return;
    }
    const sb = document.getElementById('sidebar');
    if (sb && !sb.classList.contains('hidden')) {
      sb.classList.add('hidden');
    }
    mobileBackdrop.classList.remove('visible');
    syncRailSide();
  });

  // Patch syncRailSide to also update backdrop
  const _origSyncRailSideCore = _syncRailSideCore;
  _syncRailSideFn = function() { _origSyncRailSideCore(); updateMobileBackdrop(); };
  window.syncRailSide = syncRailSide;

  // Swipe sidebar toward edge to close
  const sidebar = document.getElementById('sidebar');
  if (sidebar && 'ontouchstart' in window) {
    let _swStartX = 0, _swStartY = 0, _swSwiping = false;
    sidebar.addEventListener('touchstart', (e) => {
      if (e.target.closest('.list-item')) { _swSwiping = false; return; }
      _swStartX = e.touches[0].clientX;
      _swStartY = e.touches[0].clientY;
      _swSwiping = true;
    }, { passive: true });
    sidebar.addEventListener('touchmove', (e) => {
      if (!_swSwiping) return;
      const dx = e.touches[0].clientX - _swStartX;
      const dy = Math.abs(e.touches[0].clientY - _swStartY);
      if (dy > 40) { _swSwiping = false; return; }
      const isRight = sidebar.classList.contains('right-side');
      if ((!isRight && dx < -60) || (isRight && dx > 60)) {
        _swSwiping = false;
        const _backdrop = document.getElementById('sidebar-backdrop');
        if (_backdrop) _backdrop.classList.remove('visible');
        sidebar.classList.add('hidden');
        syncRailSide();
      }
    }, { passive: true });
    sidebar.addEventListener('touchend', () => { _swSwiping = false; }, { passive: true });
  }

  // ── Click outside sidebar / icon rail to close (mobile only) ──
  document.addEventListener('click', (e) => {
    if (!isNarrow()) return; // desktop keeps sidebar open
    const sb = document.getElementById('sidebar');
    const rail = document.getElementById('icon-rail');
    // Ignore clicks on elements removed from DOM (e.g. session list re-render during folder toggle)
    if (!e.target.isConnected) return;
    // Ignore clicks on the sidebar, icon rail, or hamburger button itself
    if (e.target.closest('#sidebar') || e.target.closest('#icon-rail') || e.target.closest('#hamburger-btn')) return;
    // Ignore clicks inside modals or the chat input area
    if (e.target.closest('.modal') || e.target.closest('.input-bar') || e.target.closest('#message')) return;
    // Ignore clicks on session/folder dropdowns and the styled prompt
    // overlay — they're body-level elements logically tied to a sidebar
    // action (e.g. "Move to folder → New Folder…"), so closing the
    // sidebar when the user clicks one yanks the action mid-flight. The kit
    // menu/popover surface (.ow-popover, #1638) is body-level too — a tap
    // inside it must count as "inside" and never close the sidebar.
    if (e.target.closest('.ow-popover, .session-dropdown, .folder-submenu, #styled-prompt-overlay, #styled-confirm-overlay')) return;
    // Close full sidebar if open (with animation)
    if (sb && !sb.classList.contains('hidden')) {
      const backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.classList.remove('visible');
      sb.classList.add('hidden');
      syncRailSide();
      return;
    }
    // Close mobile-mini icon rail overlay if open
    if (rail && rail.classList.contains('mobile-mini')) {
      rail.classList.remove('mobile-mini');
      rail.style.cssText = '';
      const backdrop = document.getElementById('sidebar-backdrop');
      if (backdrop) backdrop.classList.remove('visible');
      syncRailSide();
    }
  });

  // ── Mobile: close sidebar/rail when a tool button is tapped ──
  // The user expects the sidebar to get out of the way the moment a tool
  // window opens — otherwise the modal lands behind the sidebar on phones.
  // We remember whether the sidebar was open at the moment the tool was
  // tapped so we can re-open it when the tool's modal is dismissed; that
  // way clicking around the app doesn't leave the sidebar permanently
  // shut.
  let _sidebarWasOpenBeforeTool = false;
  let _railWasOpenBeforeTool = false;
  document.addEventListener('click', (e) => {
    if (!isNarrow()) return;
    const btn = e.target.closest('[id^="tool-"], [id^="rail-"]');
    if (!btn) return;
    setTimeout(() => {
      const sb = document.getElementById('sidebar');
      const rail = document.getElementById('icon-rail');
      const backdrop = document.getElementById('sidebar-backdrop');
      let changed = false;
      if (sb && !sb.classList.contains('hidden')) {
        _sidebarWasOpenBeforeTool = true;
        sb.classList.add('hidden');
        changed = true;
      }
      if (rail && rail.classList.contains('mobile-mini')) {
        _railWasOpenBeforeTool = true;
        rail.classList.remove('mobile-mini');
        rail.style.cssText = '';
        changed = true;
      }
      if (changed) {
        if (backdrop) backdrop.classList.remove('visible');
        syncRailSide();
      }
    }, 0);
  });

  // When a tool is dismissed by swiping it down (ui.js fires `modal-dismissed`),
  // don't bounce the sidebar back open — the swipe should just dismiss the tool.
  // Button-close still restores the prior sidebar state (no event fired there).
  window.addEventListener('modal-dismissed', () => {
    _sidebarWasOpenBeforeTool = false;
    _railWasOpenBeforeTool = false;
  });

  // ── Mobile: when a tool modal closes, restore the sidebar/rail to
  // whatever state it was in before the tool was opened. ──
  // We watch every .modal for the .hidden class going on, and if our
  // remembered "sidebar-was-open" flag is set, undo the auto-close.
  if (isNarrow()) {
    const _restoreSidebar = () => {
      const sb = document.getElementById('sidebar');
      const rail = document.getElementById('icon-rail');
      const backdrop = document.getElementById('sidebar-backdrop');
      // Skip if any modal is still visible (.modal without .hidden) — we only
      // restore once the user is back to bare chat. A tool swiped DOWN to a
      // dock chip is minimized (display:none via .modal-minimized), not closed
      // — it's still "around", so don't bounce the sidebar open behind it. Only
      // a full close (no minimized modal, no dock chips) should restore.
      const anyOpen = [...document.querySelectorAll('.modal')]
        .some(m => (!m.classList.contains('hidden') && getComputedStyle(m).display !== 'none')
                   || m.classList.contains('modal-minimized'));
      const anyDocked = document.querySelectorAll('.minimized-dock-chip').length > 0;
      if (anyOpen || anyDocked) {
        // A tool is still minimized/docked. The user has left the "launched
        // from the sidebar" context — drop the restore intent so that later
        // FULLY closing the tool (e.g. dragging its chip to the trash) doesn't
        // bounce the sidebar open. (The modal-dismissed listener that normally
        // clears these gets blocked by modalManager's stopImmediatePropagation.)
        _sidebarWasOpenBeforeTool = false;
        _railWasOpenBeforeTool = false;
        return;
      }
      if (_sidebarWasOpenBeforeTool && sb && sb.classList.contains('hidden')) {
        sb.classList.remove('hidden');
        if (backdrop) backdrop.classList.add('visible');
      }
      if (_railWasOpenBeforeTool && rail && !rail.classList.contains('mobile-mini')) {
        rail.classList.add('mobile-mini');
      }
      _sidebarWasOpenBeforeTool = false;
      _railWasOpenBeforeTool = false;
      if (_sidebarWasOpenBeforeTool || _railWasOpenBeforeTool) syncRailSide();
    };
    const _modalObs = new MutationObserver((muts) => {
      let triggered = false;
      for (const m of muts) {
        if (m.type !== 'attributes' || m.attributeName !== 'class') continue;
        const t = m.target;
        if (!(t instanceof HTMLElement) || !t.classList) continue;
        if (t.classList.contains('modal')) { triggered = true; break; }
      }
      if (triggered) setTimeout(_restoreSidebar, 50);
    });
    _modalObs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }

  // (Mobile swipe-to-open-sidebar is wired at MODULE scope — see
  // _initChatSwipeToOpenSidebar() at the bottom of this file — so it attaches
  // independently of this init function completing.)
}

// ── Mobile: swipe horizontally on the splash/chat to open the sidebar ──
// Wired at MODULE scope (not inside initSidebarLayout) so a throw anywhere in
// that init can't drop this listener. Bound on `document` so it catches the
// touch regardless of which child element is under the finger. touchmove is
// NON-passive and calls preventDefault() once the gesture is locked
// horizontal — without that, Firefox (and others) treat the horizontal swipe
// as their own scroll/navigation gesture and our handler never gets to act.
function _initChatSwipeToOpenSidebar() {
  if (window.__odySwipeWired) return;
  window.__odySwipeWired = true;

  // Areas where a horizontal drag means something else (their own scroll/drag).
  const EXCLUDE = [
    '#sidebar', '#icon-rail', '.modal', '.input-bar', '#message',
    '#minimized-dock', '.minimized-dock-chip',
    'pre', 'table', '.agent-tool-output', '.agent-thread-cmd',
    'input', 'textarea', 'select',
  ].join(', ');

  let sx = 0, sy = 0, track = false, decided = false;

  const reset = () => { track = false; decided = false; };

  document.addEventListener('touchstart', (e) => {
    reset();
    if (!isNarrow()) return;
    if (!e.touches || e.touches.length !== 1) return;
    const sb = document.getElementById('sidebar');
    if (sb && !sb.classList.contains('hidden')) return; // already open
    // Only in the chat / empty-chat view. Not when a document or PDF is open
    // (body.doc-view), notes is open (body.notes-view), or a tool modal is up.
    if (document.body.classList.contains('doc-view') ||
        document.body.classList.contains('notes-view')) return;
    // Not while Compare is running — it takes over #chat-container with its own
    // panes/scroll, and the swipe-to-open-sidebar gesture gets in the way there.
    const cc = document.getElementById('chat-container');
    if (cc && cc.classList.contains('compare-active')) return;
    const anyModalOpen = [...document.querySelectorAll('.modal')].some(
      m => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none');
    if (anyModalOpen) return;
    const t = e.target;
    if (t && t.closest && t.closest(EXCLUDE)) return;
    // The gesture must start within the chat area itself.
    if (!(t && t.closest && t.closest('#chat-container'))) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    track = true;
  }, { passive: true, capture: true });

  document.addEventListener('touchmove', (e) => {
    if (!track) return;
    if (!e.touches || !e.touches.length) return;
    const dx = e.touches[0].clientX - sx;
    const dy = e.touches[0].clientY - sy;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (!decided) {
      if (adx < 10 && ady < 10) return;          // not enough travel to judge
      if (ady > adx) { track = false; return; }   // vertical-dominant → let it scroll
      decided = true;                             // locked into a horizontal swipe
    }
    // Claim the gesture from the browser so it doesn't scroll/navigate instead.
    if (e.cancelable) e.preventDefault();
    if (adx >= 40) {
      track = false;
      // Direction picks the side (per user preference): swipe LEFT → sidebar
      // on the left, swipe RIGHT → sidebar on the right. dx<0 is a leftward
      // finger motion; mapping it to 'right' (and dx>0 to 'left') is what makes
      // it feel correct in practice.
      const side = dx < 0 ? 'right' : 'left';
      // Use the deliberate-open helper (sets _userToggledSidebar so the
      // auto-collapse observer doesn't instantly re-hide it). Fall back to a
      // plain unhide if the helper isn't wired yet.
      if (typeof window._odyOpenSidebar === 'function') {
        window._odyOpenSidebar(side);
      } else {
        const sb = document.getElementById('sidebar');
        if (sb) { sb.classList.remove('hidden'); try { syncRailSide(); } catch (_) {} }
      }
    }
  }, { passive: false, capture: true });

  document.addEventListener('touchend', reset, { passive: true, capture: true });
  document.addEventListener('touchcancel', reset, { passive: true, capture: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initChatSwipeToOpenSidebar);
} else {
  _initChatSwipeToOpenSidebar();
}

// ── H4: the collapsed rail derives every icon from its expanded row ──
// User ruling: "The icons in the collapsed sidebar don't match the expanded
// sidebar and always must." The rail used to be a second, hand-maintained
// icon set — which drifted. Now there is ONE icon per nav entry: the expanded
// row's svg. Static rail buttons declare their source row via
// data-rail-source in index.html (and ship no svg of their own); the game
// chrome that JS injects later (Diary Room / Cast / the status HUD) gets a
// rail mirror created here with the same cloned icon and a visibility that
// follows the row's game gating. A MutationObserver over #sidebar re-clones
// on any change, so the two states can never drift again.
//
// Wired at MODULE scope (like the swipe gesture above) so a throw elsewhere
// in initSidebarLayout can't drop it.

const RAIL_MIRRORS = [
  // Expanded rows injected at runtime → rail buttons created to match.
  // `activate` forwards the rail click to the row itself (these actions work
  // without opening the sidebar); `section` instead rides the existing rail
  // click-handler that opens the sidebar and scrolls to the element.
  { rail: 'rail-diary-room', source: 'sidebar-diary-room-btn', activate: true },
  { rail: 'rail-cast', source: 'sidebar-cast-btn', activate: true },
  // M4-2: the Memory Wall button (orwellMemoryWall.js) — beside Cast, game-gated, has its own svg
  // (no `fallback` → the "exactly one fallback" H4 gate stays green; the rail clones the row's icon).
  // NB: 'rail-memory' is TAKEN — index.html ships a static Brain/Memory tool button under that id
  // (data-rail-source="tool-memory-btn"); reusing it hijacked that button's icon + gating and broke
  // the H4 icon-parity smoke. This entry must keep its own unique id.
  { rail: 'rail-memory-wall', source: 'sidebar-memory-btn', activate: true },
  {
    rail: 'rail-game-status', source: 'orwell-status', section: 'orwell-status',
    iconSel: '.os-hdr svg',
    // The status HUD's header carries no svg of its own (it leads with live
    // text). Until it grows one — at which point the clone path adopts it
    // automatically — the watching eye stands in. A fallback is allowed ONLY
    // where there is no expanded icon to mirror; never duplicate a row's icon.
    fallback: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M2 16Q9 7 16 7Q23 7 30 16Q23 25 16 25Q9 25 2 16Z"/><circle cx="16" cy="16" r="4.5" fill="currentColor" stroke="none"/></svg>',
  },
];

function _cloneRowIcon(svg) {
  const clone = svg.cloneNode(true);
  clone.removeAttribute('style');  // row-specific nudges (left:-2px, opacity)
  clone.removeAttribute('class');  // .sidebar-action-icon / .section-icon
  clone.setAttribute('width', '16');
  clone.setAttribute('height', '16');
  clone.setAttribute('aria-hidden', 'true');
  return clone;
}

function _setRailIcon(btn, srcSvg) {
  const next = _cloneRowIcon(srcSvg);
  const cur = btn.querySelector(':scope > svg');
  if (cur && cur.outerHTML === next.outerHTML) return; // already in step
  if (cur) cur.replaceWith(next);
  // First child, so appended extras (badges, loading spinners) survive.
  else btn.insertBefore(next, btn.firstChild);
}

// #796: is an expanded sidebar source ROW effectively visible? An entry can be hidden
// three ways: inline display:none on itself (Customize-UI per-tool toggles / admin
// feature flags), a hidden SECTION ancestor via CSS (the game build hides whole
// sections — #email-section / #tools-section), or a hidden user-bar. We must measure
// this INDEPENDENTLY of the sidebar's own collapse: the rail is shown precisely WHEN the
// sidebar is collapsed (.sidebar.hidden), and that collapse cascades display:none onto
// inner containers (e.g. `.sidebar.hidden .sidebar-user-bar`) — a layout artifact, not a
// genuine hide. So we lift the `.hidden` class off the sidebar for the duration of the
// measurement (synchronous, no paint between toggle + restore ⇒ no flicker), then walk
// computed display/visibility up to the .sidebar root.
function _rowVisible(src) {
  if (!src) return false;
  const sidebar = document.getElementById('sidebar');
  const wasHidden = sidebar && sidebar.classList.contains('hidden');
  if (wasHidden) sidebar.classList.remove('hidden');
  let visible = true;
  try {
    let node = src;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('sidebar')) break; // the nav root
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') { visible = false; break; }
      node = node.parentElement;
    }
  } finally {
    if (wasHidden) sidebar.classList.add('hidden');
  }
  return visible;
}

export function syncRailIcons() {
  const rail = document.getElementById('icon-rail');
  if (!rail) return;

  // 1. Declared static buttons — clone the source row's icon svg AND mirror the
  // row's visibility. (#796: the rail must show the SAME SET the expanded sidebar
  // shows, not just the same glyphs. The game build / Customize-UI hides tool rows
  // via inline display:none; without this, the collapsed rail kept showing icons —
  // e.g. Calendar / Compare / Email — for entries the expanded sidebar had hidden.)
  // Buttons whose source row sets display:none follow it; a present, shown row un-hides
  // the rail button. The dynamic indicators (rail-chats / rail-documents) own their own
  // show/hide and so are skipped here — they carry no source-row gating contract.
  const DYNAMIC_OWN_VIS = new Set(['rail-chats', 'rail-documents']);
  rail.querySelectorAll('.icon-rail-btn[data-rail-source]').forEach((btn) => {
    const src = document.getElementById(btn.dataset.railSource);
    const spec = RAIL_MIRRORS.find((m) => m.rail === btn.id);
    const svg = src && src.querySelector((spec && spec.iconSel) || 'svg');
    if (svg) _setRailIcon(btn, svg);
    // RAIL_MIRRORS-managed injected entries set their own visibility in pass 2;
    // the dynamic indicators manage theirs. Everything else mirrors its row.
    if (!spec && !DYNAMIC_OWN_VIS.has(btn.id)) {
      btn.style.display = _rowVisible(src) ? '' : 'none';
    }
  });

  // 2. Injected game chrome — create the mirror, keep icon + gating in step.
  const sep = rail.querySelector('.rail-separator');
  let anchor = sep || document.getElementById('rail-delete-session');
  for (const spec of RAIL_MIRRORS) {
    const src = document.getElementById(spec.source);
    let btn = document.getElementById(spec.rail);
    if (!src) {
      if (btn) btn.style.display = 'none'; // source row left the DOM
      continue;
    }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = spec.rail;
      btn.className = 'icon-rail-btn ow-btn ow-btn-icon';
      btn.dataset.railSource = spec.source;
      if (spec.section) btn.dataset.section = spec.section;
      const label = src.title || src.getAttribute('aria-label') || '';
      if (label) {
        btn.title = label;
        btn.setAttribute('aria-label', label);
      }
      if (spec.activate) {
        btn.addEventListener('click', () => {
          const row = document.getElementById(spec.source);
          if (row) row.click();
        });
      }
      // Mirror the sidebar's order: Diary Room / Cast in the core cluster,
      // the status entry after the Chats indicator (the expanded HUD sits
      // below the session list).
      const after = spec.section ? (document.getElementById('rail-chats') || anchor) : anchor;
      if (after) after.after(btn);
      else rail.appendChild(btn);
      if (!spec.section) anchor = btn;
      const svg = src.querySelector(spec.iconSel || 'svg');
      if (!svg && spec.fallback) btn.innerHTML = spec.fallback;
    }
    // (Icons for mirrors with a source svg are cloned by pass 1 next sync —
    // do it now too so a fresh button never renders empty.)
    const svg = src.querySelector(spec.iconSel || 'svg');
    if (svg) _setRailIcon(btn, svg);
    // The row's game gating is the rail's too (hidden until a game exists). Use the
    // collapse-aware check (#796) so the sidebar's own collapse — present whenever the
    // rail is shown — doesn't read as the row being hidden.
    btn.style.display = _rowVisible(src) ? '' : 'none';
  }

  // 3. a11y (WCAG 4.1.2): the rail buttons are icon-only — `title` alone is not a
  // reliable accessible name, so mirror a real NAME into aria-label, same single-
  // source rule as the icon. Prefer the expanded source row's name (its aria-label
  // or title); fall back to the button's own title for the entries that own their
  // glyph (the delete ✕ / the open-document indicator). Idempotent, and re-runs
  // with the MutationObserver so a renamed row keeps the rail name in step.
  rail.querySelectorAll('.icon-rail-btn').forEach((btn) => {
    const src = btn.dataset.railSource && document.getElementById(btn.dataset.railSource);
    const name = (src && (src.getAttribute('aria-label') || src.title))
      || btn.getAttribute('aria-label') || btn.title || '';
    if (name && btn.getAttribute('aria-label') !== name) btn.setAttribute('aria-label', name);
  });
}

function _initRailIconSource() {
  if (window.__odyRailIconsWired) return;
  window.__odyRailIconsWired = true;
  window._railIconsSync = syncRailIcons; // test/debug seam
  try { syncRailIcons(); } catch (_) {}
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || typeof MutationObserver === 'undefined') return;
  let queued = false;
  const queue = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      try { syncRailIcons(); } catch (_) {}
    }, 50);
  };
  // The rail lives OUTSIDE #sidebar, so our own writes never re-trigger this.
  new MutationObserver(queue).observe(sidebar, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initRailIconSource);
} else {
  _initRailIconSource();
}
