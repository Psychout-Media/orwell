// "See latest" scroll-to-bottom button (#538).
//
// A floating down-arrow that appears in the chat container ONLY when the reader has scrolled up
// away from the bottom (the chat already reasons about "near bottom" within 120px elsewhere — this
// reuses the same threshold). Clicking it re-enables auto-scroll and SMOOTH-scrolls to the newest
// message (instant under prefers-reduced-motion); it hides itself the moment the reader is back at
// the bottom. An optional unread badge counts how many messages landed while the reader was
// scrolled away, clearing on click / on reaching bottom. It is the SINGLE jump-to-bottom button —
// #887 retired the duplicate squircle (#scroll-bottom-btn) and this one absorbed its
// composer-anchored placement (sits just above the .chat-input-bar, recomputed on scroll/resize).
// #948: it is mutually exclusive with the decision card — a visible #orwell-decision-card
// hard-suppresses it (they share the above-composer slot and must never coexist).
//
// Pure FE, no engine/Vault coupling. Reduced-motion safe (the appear/disappear transition is
// dropped under prefers-reduced-motion). Fails open: any error simply leaves the button hidden.
(function () {
  "use strict";

  var NEAR_BOTTOM_PX = 120; // matches chat.js's "nearBottom" threshold
  var BTN_ID = "orwell-scroll-bottom";
  var _box = null;       // #chat-history (the scroll container)
  var _btn = null;
  var _bar = null;       // .chat-input-bar (the composer — we anchor just above it)
  var _unread = 0;
  var _lastMsgCount = 0;

  function chatBox() {
    if (_box && document.body.contains(_box)) return _box;
    _box = document.getElementById("chat-history");
    return _box;
  }

  function chatBar() {
    if (_bar && document.body.contains(_bar)) return _bar;
    _bar = document.querySelector(".chat-input-bar");
    return _bar;
  }

  function prefersReducedMotion() {
    try {
      return window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_) { return false; }
  }

  // #948: a decision card (#orwell-decision-card, orwellDecision.js) and this button are
  // MUTUALLY EXCLUSIVE by the owner's ruling — a card only appears when you're at the bottom and
  // this button only when you're NOT at the bottom, so they must never coexist (they overlap above
  // the composer, #933). Whenever a card is mounted AND visible, force-hide the button. Fail-open:
  // any error → not suppressed (the button behaves exactly as before).
  function decisionCardVisible() {
    try {
      var card = document.getElementById("orwell-decision-card");
      if (!card || !document.body.contains(card)) return false;
      if (card.hidden) return false;
      var cs = window.getComputedStyle ? window.getComputedStyle(card) : null;
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
      // A zero-size box is effectively not shown (e.g. mid-removal animation collapsed).
      var r = card.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      return true;
    } catch (_) { return false; }
  }

  // Generalizes #948: a FLOATING kit window (a non-docked .ow-window — the post-season retro or the
  // finale panel on a phone tier) that covers the button's slot also suppresses it, so the fab never
  // paints over a window the player is reading (responsive-matrix overlap at <=390px). Docked
  // windows live in the rail and never cover it. Fail-open: any error → not suppressed.
  function coveredByFloatingWindow(btn) {
    try {
      var b = btn.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return false;
      var wins = document.querySelectorAll(".ow-window:not(.ow-docked)");
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (w.hidden) continue;
        var cs = window.getComputedStyle ? window.getComputedStyle(w) : null;
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) continue;
        var r = w.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) return true;
      }
      return false;
    } catch (_) { return false; }
  }

  // Composer-anchored placement (ported from the retired #scroll-bottom-btn inline script,
  // #887): sit just above the .chat-input-bar, right-aligned, recomputed on scroll/resize so the
  // button never lands in a fixed spot that overlaps the decision card or the composer.
  function reposition() {
    var btn = _btn;
    var bar = chatBar();
    if (!btn) return;
    if (!bar) return; // no composer yet → leave defaults; reposition() reruns on resize/scroll
    var rect = bar.getBoundingClientRect();
    // The room strip (M3-1) sits directly above the composer: anchor above whichever is higher so
    // the fab never paints over the room chips (responsive-matrix overlap at <=390px).
    var top = rect.top;
    try {
      var strip = document.getElementById("orwell-room-strip");
      if (strip) {
        var sr = strip.getBoundingClientRect();
        var scs = getComputedStyle(strip);
        if (sr.height > 0 && sr.width > 0 && scs.display !== "none" && scs.visibility !== "hidden" &&
            sr.top < top && sr.bottom > top - 80) top = sr.top;
      }
    } catch (_) {}
    btn.style.bottom = (window.innerHeight - top + 16) + "px";
    btn.style.right = (window.innerWidth - rect.right + 8) + "px";
  }

  function nearBottom(box) {
    return (box.scrollHeight - box.scrollTop - box.clientHeight) < NEAR_BOTTOM_PX;
  }

  function ensureCss() {
    if (document.getElementById(BTN_ID + "-css")) return;
    var st = document.createElement("style");
    st.id = BTN_ID + "-css";
    st.textContent =
      // Composer-anchored: position:fixed + JS-set bottom/right (reposition()) anchor it just
      // above the .chat-input-bar — matching the retired squircle's placement (#887). The
      // bottom/right defaults below only apply before the first reposition() / if no composer.
      "#" + BTN_ID + " {" +
      "  position: fixed; right: 18px; bottom: 96px; z-index: 40;" +
      "  width: 38px; height: 38px; border-radius: 50%;" +
      "  display: flex; align-items: center; justify-content: center;" +
      "  background: color-mix(in srgb, var(--panel, #1b1b1b) 88%, transparent);" +
      "  color: var(--fg, #cfd8e3);" +
      // Neutral hairline (the kit's glass-rim border) — no accent hue on the outline, in any
      // state (#887). Only the unread badge keeps the sanctioned accent.
      "  border: 1px solid var(--ow-glass-rim-border, rgba(255,255,255,0.12));" +
      "  box-shadow: 0 2px 10px rgba(0,0,0,.35); cursor: pointer;" +
      // Hidden = visibility:hidden too (R-RSP-6 #1877): opacity:0 + pointer-events:none still left the
      // button keyboard-focusable and announced. visibility flips only AFTER the fade-out (delayed),
      // and immediately on show, so the fade animation is unchanged.
      "  opacity: 0; transform: translateY(6px); pointer-events: none; visibility: hidden;" +
      "  transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s; }" +
      "#" + BTN_ID + ".osb-show { opacity: .92; transform: translateY(0); pointer-events: auto;" +
      "  visibility: visible; transition-delay: 0s; }" +
      "#" + BTN_ID + ":hover { opacity: 1; }" +
      "#" + BTN_ID + ":focus-visible { opacity: 1; outline: none; box-shadow: 0 0 0 2px var(--ow-ios-blue, #0a84ff); }" + // A87: a visible keyboard ring
      "#" + BTN_ID + " svg { width: 18px; height: 18px; }" +
      "#" + BTN_ID + " .osb-badge {" +
      "  position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px;" +
      "  padding: 0 4px; border-radius: 999px; font: 600 max(11px, var(--fs-2xs, 11px))/16px 'Fira Code', ui-monospace, monospace;" +
      "  text-align: center; color: var(--on-accent, #fff);" +
      "  background: var(--accent, var(--red, #e06c75)); display: none; }" +
      "#" + BTN_ID + " .osb-badge.osb-has { display: block; }" +
      "@media (prefers-reduced-motion: reduce) {" +
      "  #" + BTN_ID + " { transition: none; transform: none; }" +
      "  #" + BTN_ID + ".osb-show { transform: none; } }";
    document.head.appendChild(st);
  }

  function ensureBtn() {
    if (_btn && document.body.contains(_btn)) return _btn;
    var container = document.getElementById("chat-container");
    if (!container) return null;
    ensureCss();
    _btn = document.createElement("button");
    _btn.id = BTN_ID;
    _btn.type = "button";
    _btn.setAttribute("aria-label", "Scroll to latest message");
    _btn.title = "See latest";
    _btn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>' +
      '<span class="osb-badge" aria-hidden="true"></span>';
    // Appended to chat-container; position:fixed + reposition() anchors it to the composer rect.
    container.appendChild(_btn);
    _btn.addEventListener("click", function () {
      try {
        if (window.uiModule && window.uiModule.setAutoScroll) window.uiModule.setAutoScroll(true);
        // Smooth-scroll to the newest message (#887). uiModule.scrollHistory() only animates the
        // last ~300px, so from far up we drive the scroll ourselves with the smooth path —
        // honoring prefers-reduced-motion (instant when reduced).
        var b = chatBox();
        if (b) {
          var top = b.scrollHeight - b.clientHeight;
          if (prefersReducedMotion()) {
            b.scrollTop = top;
          } else if (typeof b.scrollTo === "function") {
            b.scrollTo({ top: top, behavior: "smooth" });
          } else {
            b.scrollTop = top;
          }
        }
      } catch (_) {}
      clearUnread();
      update();
    });
    reposition();
    return _btn;
  }

  function setBadge(n) {
    var btn = ensureBtn();
    if (!btn) return;
    var badge = btn.querySelector(".osb-badge");
    if (!badge) return;
    if (n > 0) {
      badge.textContent = n > 99 ? "99+" : String(n);
      badge.classList.add("osb-has");
    } else {
      badge.textContent = "";
      badge.classList.remove("osb-has");
    }
  }

  function clearUnread() {
    _unread = 0;
    setBadge(0);
  }

  // rAF-coalesced update: the two MutationObservers below fire on EVERY streamed-token DOM
  // mutation (the body node is rebuilt per delta), and update() forces synchronous layout via
  // getBoundingClientRect (reposition + decisionCardVisible) + scrollHeight reads. Left uncoalesced
  // that is layout-thrash-during-streaming (FEDEEP-10 / TRANS-9: ~100+ badge/layout passes per
  // reply). Collapse a mutation burst to at most one layout pass per animation frame. Direct
  // user-driven calls (scroll/resize/click) still run update() immediately — they are not hot.
  var _rafPending = false;
  function scheduleUpdate() {
    if (_rafPending) return;
    _rafPending = true;
    var run = function () { _rafPending = false; update(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function update() {
    var box = chatBox();
    var btn = ensureBtn();
    if (!box || !btn) return;
    reposition();
    var hasContent = box.scrollHeight - box.clientHeight > NEAR_BOTTOM_PX;
    // #948: a visible decision card hard-suppresses the button — the two never coexist. This wins
    // over the scroll position so that even if a card mounts while the reader is scrolled up (which
    // would otherwise satisfy the show-condition), the button stays hidden. Unread stays counted so
    // the badge is correct once the card clears.
    var covered = coveredByFloatingWindow(btn);
    if (nearBottom(box) || !hasContent || decisionCardVisible() || covered) {
      btn.classList.remove("osb-show");
      if (!decisionCardVisible() && !covered) clearUnread();
    } else {
      btn.classList.add("osb-show");
    }
  }

  // Count messages that arrive while the reader is scrolled away → the unread badge.
  function watchNewMessages(box) {
    if (typeof MutationObserver === "undefined") return;
    try { _lastMsgCount = box.querySelectorAll(".msg").length; } catch (_) { _lastMsgCount = 0; }
    var mo = new MutationObserver(function () {
      var count;
      try { count = box.querySelectorAll(".msg").length; } catch (_) { count = _lastMsgCount; }
      if (count > _lastMsgCount && !nearBottom(box)) {
        _unread += (count - _lastMsgCount);
        setBadge(_unread);
      }
      _lastMsgCount = count;
      scheduleUpdate();
    });
    mo.observe(box, { childList: true, subtree: true });
  }

  // #948: re-check suppression whenever the decision card could appear/disappear. The card mounts
  // into a sheet/notice OUTSIDE #chat-history (so watchNewMessages can't see it), and it is
  // .remove()'d on dismiss — so watch the whole body subtree for the card's mount/unmount, and
  // also listen for orwell:pending (the event that drives the card) as a fast belt.
  function watchDecisionCard() {
    if (typeof MutationObserver === "undefined") return;
    try {
      var mo = new MutationObserver(function () { scheduleUpdate(); });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
    try { window.addEventListener("orwell:pending", update); } catch (_) {}
  }

  function start() {
    var box = chatBox();
    if (!box) return;
    ensureBtn();
    box.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", function () { reposition(); update(); });
    // Keep the button glued to the composer as it grows/shrinks (multi-line input, etc.).
    var bar = chatBar();
    if (bar && typeof ResizeObserver !== "undefined") {
      try { new ResizeObserver(reposition).observe(bar); } catch (_) {}
    }
    watchNewMessages(box);
    watchDecisionCard();
    // A floating window moving, resizing, changing sheet detent or rising never adds/removes DOM, so
    // the body observer can't see it — re-check coverage on the kit's own layout event.
    try { window.addEventListener("orwell:window-layout", scheduleUpdate); } catch (_) {}
    update();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
