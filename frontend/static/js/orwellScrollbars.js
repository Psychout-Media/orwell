/* orwellScrollbars.js — Apple-style macOS OVERLAY scrollbars for the OrwellWindow kit.
 *
 * The CSS (style.css, the "APPLE OVERLAY SCROLLBARS (window kit)" region) gives the kit's
 * scroll container (`.ow-window .ow-body`) a thin, rounded, translucent, OVERLAY scrollbar
 * that does not consume layout width. But pure CSS cannot reproduce macOS's
 * auto-hide-on-idle + reveal-on-scroll/hover + hover-expand affordance — so this module
 * decorates the EXISTING DOM and toggles two classes the CSS keys off:
 *
 *   .ow-scrolling     → the thumb is visible (set on scroll AND on hover over the scroll area;
 *                       cleared ~1.1s after both scrolling and hover stop)
 *   .ow-scroll-hover  → the pointer is over the thumb track edge → the thumb widens/darkens
 *                       (the macOS "expand" affordance)
 *
 * It NEVER edits orwellWindow.js (a concurrent agent owns the kit). It queries the kit's
 * scroll bodies, wires the listeners, and watches for new windows via a MutationObserver.
 * prefers-reduced-motion is honoured by the CSS (no fade transition → the reveal is instant).
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  var SCROLL_SELECTOR = '.ow-window .ow-body';
  var IDLE_MS = 1100;               // macOS fades the bar ~1–1.5s after activity stops
  var EDGE_PX = 22;                 // pointer within this band of the right/bottom edge = "over the thumb"
  var WIRED = '__owScrollbarsWired';

  function clearIdle(el) {
    if (el.__owIdleTimer) {
      clearTimeout(el.__owIdleTimer);
      el.__owIdleTimer = null;
    }
  }

  // Reveal the thumb now; schedule the idle fade-out unless the pointer is still hovering.
  function reveal(el) {
    el.classList.add('ow-scrolling');
    clearIdle(el);
    el.__owIdleTimer = setTimeout(function () {
      // Only hide if the pointer isn't lingering over the scroll area.
      if (!el.__owHover) el.classList.remove('ow-scrolling');
    }, IDLE_MS);
  }

  function onScroll(e) {
    reveal(e.currentTarget);
  }

  function onPointerEnter(e) {
    var el = e.currentTarget;
    el.__owHover = true;
    el.classList.add('ow-scrolling');
    clearIdle(el);
  }

  function onPointerLeave(e) {
    var el = e.currentTarget;
    el.__owHover = false;
    el.classList.remove('ow-scroll-hover');
    reveal(el); // start the idle countdown now that hover ended
  }

  // Widen/darken the thumb when the pointer hovers near the scrollbar edge (the macOS expand).
  function onPointerMove(e) {
    var el = e.currentTarget;
    var rect = el.getBoundingClientRect();
    var nearRight = (rect.right - e.clientX) <= EDGE_PX && (rect.right - e.clientX) >= 0;
    var nearBottom = (rect.bottom - e.clientY) <= EDGE_PX && (rect.bottom - e.clientY) >= 0;
    var overThumb = (nearRight && el.scrollHeight > el.clientHeight) ||
                    (nearBottom && el.scrollWidth > el.clientWidth);
    el.classList.toggle('ow-scroll-hover', overThumb);
    if (overThumb) {
      el.classList.add('ow-scrolling');
      clearIdle(el);
    }
  }

  function wire(el) {
    if (!el || el[WIRED]) return;
    el[WIRED] = true;
    el.__owHover = false;
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointerenter', onPointerEnter);
    el.addEventListener('pointerleave', onPointerLeave);
    el.addEventListener('pointermove', onPointerMove, { passive: true });
  }

  function scan(root) {
    var scope = (root && root.querySelectorAll) ? root : document;
    var nodes = scope.querySelectorAll(SCROLL_SELECTOR);
    for (var i = 0; i < nodes.length; i++) wire(nodes[i]);
    // A freshly-added node may itself BE a scroll body (matches, not contains).
    if (root && root.matches && root.matches(SCROLL_SELECTOR)) wire(root);
  }

  function init() {
    scan(document);
    // Kit windows mount/unmount dynamically — observe and decorate new bodies.
    if (typeof MutationObserver === 'function') {
      // ORW-157: one pass per animation frame over the still-attached added nodes (not per streamed token).
      var _sbQueue = [];
      var _sbPending = false;
      var _sbRun = function () {
        if (!_sbPending) return;
        _sbPending = false;
        var recs = _sbQueue; _sbQueue = [];
        for (var i = 0; i < recs.length; i++) {
          var added = recs[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (n && n.nodeType === 1 && n.isConnected) scan(n);
          }
        }
      };
      var mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) _sbQueue.push(records[i]);
        if (_sbPending) return;
        _sbPending = true;
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(_sbRun);
        setTimeout(_sbRun, 120);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      window.__owScrollbarsObserver = mo;
    }
  }

  // Expose for tests / manual re-scan.
  window.owScrollbarsScan = scan;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
