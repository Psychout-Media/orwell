/* ORW-160: highlight.js (119 KB) is only needed once a code block exists. A game transcript has none, so load it on demand:
 * watch the chat for the first <pre><code>, load the library once, then highlight what is there. Every call site already guards on
 * `window.hljs`, so before the load nothing changes; after it they behave exactly as before. Classic script (no import). */
(function () {
  'use strict';
  var SRC = '/static/lib/highlight.min.js';
  var state = 'idle'; // idle -> loading -> loaded | failed
  function highlightAll() {
    try {
      if (!window.hljs) return;
      document.querySelectorAll('pre code:not(.hljs)').forEach(function (b) { window.hljs.highlightElement(b); });
    } catch (_) { /* never break the page for colouring */ }
  }
  function load() {
    if (state !== 'idle') return;
    if (window.hljs) { state = 'loaded'; return; }
    state = 'loading';
    var s = document.createElement('script');
    s.src = SRC;
    s.onload = function () { state = 'loaded'; highlightAll(); };
    s.onerror = function () { state = 'failed'; };
    document.head.appendChild(s);
  }
  function needed() { return !!document.querySelector('pre code'); }
  function check() { if (state === 'idle' && needed()) load(); }
  function start() {
    check();
    if (state !== 'idle') return;
    try {
      var queued = false;
      var mo = new MutationObserver(function () {
        if (queued) return;
        queued = true; // coalesce: a streaming reply mutates the DOM many times a second
        (window.requestAnimationFrame || setTimeout)(function () {
          queued = false;
          check();
          if (state !== 'idle') mo.disconnect(); // loaded/loading/failed: the existing call sites take over
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (_) { /* no MutationObserver: fall back to loading now */ load(); }
  }
  window.orwellLoadHighlight = load; // an explicit hook for any future code-viewer surface
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
