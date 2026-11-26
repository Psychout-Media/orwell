// Orwell anchor slots — floating panels position by SLOT, never by coordinate
// (E91/S11; the Stream-S mechanism, part 2). One registry owns where game
// panels sit: each slot stacks its panels by MEASURED height (top slots stack
// down, bottom slots stack up), with safe-area insets, so no panel can encode
// assumptions about another's size — the D2 collision rule becomes structural.
//
// Drag (where a panel allows it) persists an OFFSET-FROM-SLOT, clamped to the
// viewport at restore (S11: a position saved at 2560px can't strand the panel
// off-screen at 1366px) and keyed per user+game (E71). On narrow viewports the
// slot engine stands down — the panels' shared sheet rules own the layout.
//
// E97 rides here too: one animation contract for every registered panel —
// fade+scale on open, the reverse on close — honoring prefers-reduced-motion.
//
// ── #752 [THE PERSISTENT-SURFACE STABILITY POLICY] ──────────────────────────
// NN/g's deepest critique of the glass UI was learnability: "nothing stayed where
// you left it." The rule this kit enforces, and that every persistent surface must
// honor:
//
//   PERSISTENT surfaces — the nav sidebar (#sidebar), the gadget rail
//   (#gadget-rail), and the Windows dock (#minimized-dock) — keep STABLE POSITIONS
//   across game-phase changes, the 20–30s poll / `orwell:gamechanged` refresh, and
//   page reloads. They do NOT relocate and do NOT replay an entrance/slide/fly
//   animation on those events — an entrance plays only on FIRST mount. Their
//   position/side/collapse/order is read from persisted state on load and re-applied
//   IDEMPOTENTLY (a re-run that finds the surface already in place is a no-op), so a
//   refresh or a reload lands them exactly where the player left them.
//
//   TRANSIENT surfaces — toasts, decision cards, sheets, and the floating game
//   windows registered HERE — animate in/out freely; that is their whole job. When
//   they animate, they do so FROM A STABLE ANCHOR (a slot, the dock chip), never by
//   shoving a persistent surface aside.
//
// This module is the geometry-persistence half of the policy for FLOATING windows
// (slot anchor + a clamped, persisted drag offset; `animateIn` fires only on a
// hidden→shown reveal, never on a restack). The persistent surfaces own their own
// CSS-flow positioning (sidebar-layout.js / orwellGadgetRail.js / modalManager.js)
// and their gamechanged/poll handlers are deliberately idempotent. The guard
// `frontend/tests/test_0752_persistent_surface_stability.py` source-pins the policy.
(function () {
  "use strict";

  const NARROW = window.matchMedia ? window.matchMedia("(max-width: 768px)") : { matches: false, addEventListener() {} };
  const REDUCED = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  const GAP = 10;
  const TOP_BASE = 52;     // below the app header
  const BOTTOM_BASE = 12;  // fallback only — the live value tracks the composer

  // #758: a top system-banner (orwellNotice.js, position:fixed) reserves its height as
  // --on-banner-inset on <body>. Slotted panels are viewport-fixed, so the body padding-top
  // can't move them — they must consume the inset themselves: every top anchor starts BELOW the
  // banner and the clamp band shrinks by it, so a top-slotted window sits below the banner AND
  // the stack compresses into the remaining viewport (never runs off the bottom). Read live
  // (default 0) so show/hide/copy-change are picked up; the banner broadcasts orwell:banner-inset
  // (listened to below) and a resize also re-stacks.
  function bannerInset() {
    try {
      const v = parseFloat(getComputedStyle(document.body).getPropertyValue("--on-banner-inset"));
      return Number.isFinite(v) && v > 0 ? v : 0;
    } catch (_) { return 0; }
  }

  // The composer is a fixed bottom bar; bottom-anchored slots (the presence strip,
  // the Windows dock) must clear it or they cover the textbox. init.js keeps
  // --composer-clearance synced to the composer's height (ResizeObserver) — the same
  // var the modal dock uses — so read it instead of pinning to a hardcoded 12px.
  function bottomBase() {
    // In the welcome (empty) state the composer is lifted ~30vh up the page, so a
    // bottom-anchored strip never collides with it — keep the small base there.
    // Only the active, bottom-pinned composer needs clearing.
    try {
      const cc = document.querySelector(".chat-container");
      if (cc && cc.classList.contains("welcome-active")) return BOTTOM_BASE;
    } catch (_) {}
    let v = 0;
    try { v = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue("--composer-clearance"), 10); } catch (_) {}
    return Number.isFinite(v) && v > BOTTOM_BASE ? v + 4 : BOTTOM_BASE;
  }

  // Game panels are viewport-fixed, but the persistent left rail (#sidebar) also occupies the
  // left edge — so a "top-left" slot pinned at the bare 14px safe-margin lands ON TOP of the
  // sidebar's controls and blocks them (S6-2: the cast window covered New Chat / Search / sort).
  // Inset left-anchored slots past the sidebar's LIVE right edge instead of hardcoding 240px, so
  // it tracks a resized/collapsed rail; fall back to 14 when there's no docked rail (the slot
  // engine already stands down under 768px, where the sidebar is a drawer, so this only runs wide).
  function leftBase() {
    try {
      const sb = document.getElementById("sidebar");
      if (sb) {
        const r = sb.getBoundingClientRect();
        const shown = r.width > 0 && getComputedStyle(sb).display !== "none";
        // Only inset when the rail actually hugs the left edge (a docked rail, not a collapsed
        // 0-width / off-edge state): clear its right edge plus the standard gap.
        if (shown && r.left <= 1 && r.right > 14) return Math.round(r.right) + GAP;
      }
    } catch (_) {}
    return 14;
  }

  // slot → [{ el, key, draggable }]
  // "top-center" anchors a focused dialog horizontally-centered under the header (the
  // (window.innerWidth - w) / 2 base branch already handles the centering, same as
  // bottom-center) — used by the OOBE cast-photo box so it is a centered, draggable
  // dialog without a per-window !important position hack fighting the slot math.
  const slots = { "top-right": [], "top-left": [], "top-center": [], "bottom-center": [], "bottom-right": [] };

  // Per-user key, fail-closed (R5/#1416): derived FRESH per call via window.orwellUserKey — the old
  // module-load `_user` cache read dataset.user before the boot script's auth confirm could set it,
  // so it also fixes a latent stale-empty-namespace bug. null ⇒ the slot offset is not persisted.
  function offsetKey(key) {
    return (window.orwellUserKey && window.orwellUserKey("orwell-slot-offset:" + key)) || null;
  }

  function loadOffset(key) {
    const k = offsetKey(key);
    if (!k) return null;
    try {
      const o = JSON.parse(localStorage.getItem(k) || "null");
      if (o && Number.isFinite(o.dx) && Number.isFinite(o.dy)) return o;
    } catch (_) {}
    return null;
  }
  function saveOffset(key, dx, dy) {
    const k = offsetKey(key);
    if (!k) return;
    try { localStorage.setItem(k, JSON.stringify({ dx, dy })); } catch (_) {}
  }

  function visible(el) {
    return el.isConnected && el.style.display !== "none" && el.offsetParent !== null
      || (el.isConnected && getComputedStyle(el).position === "fixed" && getComputedStyle(el).display !== "none");
  }

  // F2 (DWE audit): the restack must never fight a live drag. windowDrag moves
  // a panel by writing style.left/top per pointermove; the style observer below
  // used to restack on EVERY write, snapping the panel straight back to its
  // slot base — drag was dead and every saved offset was (0,0). While a
  // registered panel carries `modal-dragging` (windowDrag sets it for the whole
  // gesture), restacks stand down; the drag-end save then records the REAL drop
  // rect and the next restack applies it clamped (S11 unchanged).
  let _restacking = false;
  function dragInProgress() {
    for (const list of Object.values(slots)) {
      for (const { el } of list) if (el.classList && el.classList.contains("modal-dragging")) return true;
    }
    return false;
  }

  // Write a style prop only when the value actually changes. Restacks run off a
  // style MutationObserver, so every write must be IDEMPOTENT — a value that
  // ping-pongs between passes (the old base-then-offset two-phase write flipped
  // `left` auto→px every cycle once a real offset existed) re-queues mutation
  // records forever and busy-loops the page (F2 follow-up).
  function setStyle(el, prop, val) {
    if (el.style[prop] !== val) el.style[prop] = val;
  }

  // F3 (DWE audit / F-2 wave 1): the narrow tier is a SHEET HOST, not a
  // stand-down. Both top-slot panels used to pin themselves to top:44px with
  // per-panel !important CSS — with two visible (a finale staging while an
  // approach is live) they overlapped and occluded each other's controls.
  // Now the slot engine stacks every visible top-slot panel as a full-width
  // sheet by MEASURED height (the same rule it applies on desktop), one
  // column across both top slots; bottom slots keep their own narrow CSS.
  // R8 (audit resp-F6): on the narrow tier a top sheet must clear the mobile header CHROME (the
  // hamburger button), not just sit at the desktop TOP_BASE-8 (44px), which overlapped the menu
  // button by a few px. Track the LIVE hamburger bottom + GAP when it's shown (it already sits below
  // any top safe-area inset / notch, so clearing it inherently respects the inset); fall back to the
  // flush-under-header constant when there's no hamburger.
  function narrowTopBase() {
    let base = TOP_BASE - 8;
    try {
      const hb = document.getElementById("hamburger-btn");
      if (hb && getComputedStyle(hb).display !== "none") {
        const r = hb.getBoundingClientRect();
        if (r.height > 0) base = Math.max(base, Math.round(r.bottom) + GAP);
      }
    } catch (_) {}
    // #758: clear a top system-banner too — the mobile hamburger is itself offset below the
    // banner (style.css), so its measured bottom already clears it; the fallback constant adds
    // the inset directly for the no-hamburger case.
    return Math.max(base, (TOP_BASE - 8) + bannerInset());
  }

  function restackNarrowSheets() {
    let cursor = narrowTopBase(); // sheets sit below the mobile header chrome (R8)
    for (const name of ["top-left", "top-center", "top-right"]) {
      for (const entry of slots[name]) {
        const el = entry.el;
        if (!visible(el)) continue;
        setStyle(el, "position", "fixed");
        setStyle(el, "left", "0px");
        setStyle(el, "right", "0px");
        setStyle(el, "top", cursor + "px");
        setStyle(el, "bottom", "auto");
        setStyle(el, "transform", "none");
        cursor += (el.offsetHeight || 0) + GAP;
      }
    }
  }

  // ORW-993: the lowest y a window spanning [left, left+w] may reach. Normally the viewport bottom
  // (innerHeight tracks the visible viewport; the dvh twins in the kit CSS cover the same thing for
  // the first paint), but a PERSISTENT chrome bar the window would overlap horizontally - the sidebar
  // account bar (.sidebar-user-bar: avatar, name, settings) - is not covered by a floating window, so
  // the floor rises to that bar's top edge. Kit windows previously ran over it on a tall screen.
  function visibleBottom(left, w) {
    let bottom = window.innerHeight;
    try {
      const bar = document.querySelector(".sidebar-user-bar");
      if (bar) {
        const r = bar.getBoundingClientRect();
        const shown = r.width > 0 && r.height > 0 && getComputedStyle(bar).visibility !== "hidden";
        if (shown && left < r.right && left + w > r.left && r.top > 0) bottom = Math.min(bottom, r.top);
      }
    } catch (_) {}
    return bottom;
  }

  // Clamp a left/top pair into the viewport (S11/E91): a stacked window can NEVER
  // be positioned off-screen — top above the viewport, or left/right/bottom out of
  // view — no matter how many panels share a slot or how big the saved offset is.
  // When the panel FITS, the WHOLE of it is kept on-screen (pull left/top back so the
  // right/bottom edges land inside too) — so a viewport shrink re-anchors a dragged
  // panel fully into view. Only when the panel is itself bigger than the viewport do
  // we fall back to the sliver guarantee (≥200px of a tall panel's top, 4px margin).
  function clampPos(left, top, w, h) {
    // #758: the top floor is the banner inset + the 4px margin, never bare 4px — a clamped panel
    // can never be pulled up UNDER a top system-banner. The bottom edge is unchanged, so a tall
    // panel COMPRESSES into [inset+4, innerHeight-4] rather than overrunning the banner.
    const topFloor = 4 + bannerInset();
    const maxLeft = window.innerWidth - w - 4;
    const floorY = visibleBottom(left, w);  // ORW-993: viewport bottom, or the account bar's top
    const maxTop = floorY - h - 4;
    return {
      left: maxLeft >= 4 ? Math.max(4, Math.min(maxLeft, left))
        : Math.max(4, Math.min(window.innerWidth - 60 - 4, left)),       // wider than viewport
      top: maxTop >= topFloor ? Math.max(topFloor, Math.min(maxTop, top))
        : Math.max(topFloor, Math.min(floorY - Math.min(h, 200) - 4, top)),  // taller than viewport
    };
  }

  // Stack one slot: measured heights, gap, safe-area; the final position —
  // slot base PLUS any persisted drag offset, always clamped to the viewport — is
  // computed arithmetically and written ONCE as left/top, never via an intermediate
  // base write. EVERY placement (base stack or dragged) runs through clampPos so the
  // stacking cursor can never strand a panel off-screen (the D2/S11 collision rule).
  function fitHeight(el, name, w) {
    const base = name.endsWith("right") ? (window.innerWidth - 14 - w)
      : name.endsWith("left") ? leftBase() : (window.innerWidth - w) / 2;
    const cap = Math.max(120, Math.floor(visibleBottom(base, w) - (4 + bannerInset()) - 4));
    const explicit = parseFloat(el.style.height);
    if (Number.isFinite(explicit)) {
      if (explicit > cap) setStyle(el, "height", cap + "px");   // a resized window that no longer fits
    } else {
      setStyle(el, "maxHeight", cap + "px");
    }
  }

  function restackSlot(name) {
    if (NARROW.matches) { restackNarrowSheets(); return; } // F3: the sheet host owns narrow
    if (dragInProgress()) return; // F2: the gesture owns the position until drop
    const list = slots[name];
    // #758: top-anchored slots start BELOW a top system-banner (inset reserved on <body>); the
    // per-entry clampPos then keeps the whole stack inside [inset+4, innerHeight-4], compressing it.
    const safeT = TOP_BASE + bannerInset(), safeB = bottomBase();
    let cursor = name.startsWith("top") ? safeT : safeB;
    for (const entry of list) {
      const el = entry.el;
      if (!visible(el)) continue;
      const w = el.offsetWidth || 0;
      // ORW-993: a window is never taller than the visible space it opens in (viewport minus the
      // banner and any persistent chrome under it): cap its height BEFORE measuring so the body
      // scrolls inside the window instead of the window running off-screen / over the account bar.
      fitHeight(el, name, w);
      const h = el.offsetHeight || 0;
      let top = null, bottom = null;
      if (name.startsWith("top")) { top = cursor; cursor += h + GAP; }
      else { bottom = cursor; cursor += h + GAP; }

      setStyle(el, "position", "fixed");
      // Derive the slot's anchor coordinates numerically — no intermediate writes.
      const baseLeft = name.endsWith("right") ? (window.innerWidth - 14 - w)
        : name.endsWith("left") ? leftBase()
        : (window.innerWidth - w) / 2;
      const baseTop = top !== null ? top : (window.innerHeight - bottom - h);
      const off = entry.key ? loadOffset(entry.key) : null;
      const dx = off && Number.isFinite(off.dx) ? off.dx : 0;
      const dy = off && Number.isFinite(off.dy) ? off.dy : 0;
      const pos = clampPos(baseLeft + dx, baseTop + dy, w, h);
      setStyle(el, "left", pos.left + "px");
      setStyle(el, "top", pos.top + "px");
      setStyle(el, "right", "auto");
      setStyle(el, "bottom", "auto");
      setStyle(el, "transform", "none");
    }
  }

  function restackAll() { for (const name of Object.keys(slots)) restackSlot(name); }

  // E97: the shared open/close animation — visibility flips animate; reduced
  // motion disables (the class is inert under the media query in tokens css).
  function animateIn(el) {
    if (REDUCED.matches) return;
    el.classList.remove("orwell-anim-in");
    void el.offsetWidth; // restart
    el.classList.add("orwell-anim-in");
  }

  function register(el, slotName, opts) {
    const o = opts || {};
    if (!slots[slotName]) slotName = "top-right";
    slots[slotName].push({ el, key: o.key || null, draggable: !!o.draggable });
    el.classList.add("orwell-slotted");
    // Re-stack whenever this panel shows/hides or resizes — but never re-enter
    // off our own restack writes, and never while a drag owns the position (F2).
    try {
      let _wasHidden = el.style.display === "none";
      new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.attributeName === "style") {
            if (_restacking) return;
            const hidden = el.style.display === "none";
            if (!hidden && _wasHidden) animateIn(el); // animate on reveal, not on every write
            _wasHidden = hidden;
            if (el.classList.contains("modal-dragging")) return; // F2: drag in progress
            _restacking = true;
            try { restackAll(); } finally { _restacking = false; }
            return;
          }
        }
      }).observe(el, { attributes: true, attributeFilter: ["style"] });
    } catch (_) {}
    try { new ResizeObserver(() => restackSlot(slotName)).observe(el); } catch (_) {}
    restackSlot(slotName);
    return {
      /** Record a drag-end as an offset from the slot base (never while hidden). */
      saveDragOffset(rect) {
        if (!o.key || !visible(el)) return;
        // Re-derive the base by restacking with no offset, then diff. The whole
        // dance runs under the reentrancy guard so the style observer stays
        // quiet until the final clamped position is applied (F2).
        _restacking = true;
        try {
          // R5/#1416: offsetKey(o.key) is null when there is no data-user — guard so the null key
          // never reaches Web Storage (which would coerce it into a shared "null" namespace).
          const k = offsetKey(o.key);
          if (k) { try { localStorage.removeItem(k); } catch (_) {} }
          restackSlot(slotName);
          const base = el.getBoundingClientRect();
          saveOffset(o.key, rect.left - base.left, rect.top - base.top);
          restackSlot(slotName);
        } finally { _restacking = false; }
      },
      restack() { restackSlot(slotName); },
    };
  }

  window.addEventListener("resize", restackAll);
  // #758: a top system-banner appearing / disappearing / changing height shifts every top anchor —
  // a CSS-var change fires no event, so the banner broadcasts orwell:banner-inset on set/clear and
  // we re-stack (cheap; idempotent setStyle writes mean an unchanged inset is a no-op).
  window.addEventListener("orwell:banner-inset", restackAll);
  NARROW.addEventListener("change", () => {
    // Crossing the breakpoint re-lays out under the new tier's rules — the
    // sheet host on narrow (F3), slot anchors + offsets on wide.
    for (const list of Object.values(slots)) for (const { el } of list) {
      el.style.top = ""; el.style.bottom = ""; el.style.left = ""; el.style.right = ""; el.style.transform = "";
    }
    restackAll();
  });

  // ── RESP-7 (2026-07-03 pre-ship audit) — a live hard-stop DECISION card SUPPRESSES the stale
  // premiere WELCOME card ───────────────────────────────────────────────────────────────────────
  // The premiere welcome guide (#orwell-premiere-tutorial, orwellPremiereTutorial.js) and a binding
  // decision card (#orwell-decision-card, orwellDecision.js — a HARD STOP) are two INDEPENDENT
  // above-composer surfaces (the decision rides an OrwellSheet, the guide the OrwellNotice zone), so
  // nothing coordinated them: on a narrow phone both mount at once and bury the composer (audit
  // RESP-7 — welcome ~85→353 + decision ~361→735 of an 844px viewport). A binding decision OWNS the
  // moment, so while one is live the stale welcome card must stand down. We toggle a body flag and
  // hide the welcome card by CSS — fully REVERSIBLE: the instant the decision clears the flag drops
  // and the guide returns (the premiere module's own mount/remove lifecycle is untouched; its
  // element is merely display:none while suppressed). Mirrors the #933/#948 fab-vs-decision
  // mutual-exclusion precedent (orwellScrollBottom.js). Fail-open: any error ⇒ not suppressed.
  (function () {
    function ensureDecisionCss() {
      if (!document.createElement || !document.getElementById) return; // minimal DOM ⇒ no-op
      if (document.getElementById("orwell-slots-decision-css")) return;
      const st = document.createElement("style");
      st.id = "orwell-slots-decision-css";
      // While a binding decision (hard stop) is live, the premiere welcome guide stands down so the
      // two never co-mount and bury the composer on a narrow phone (RESP-7). The kit wrapper is
      // hidden too so no empty zone band lingers where the card was.
      st.textContent =
        "body.ow-decision-active #orwell-premiere-tutorial," +
        "body.ow-decision-active .on-card.on-guide.orwell-premiere-tutorial{display:none !important;}";
      (document.head || document.documentElement).appendChild(st);
    }
    // A decision card is "live" when it is mounted and actually shown — mirrors orwellScrollBottom's
    // decisionCardVisible() (the #948 mutual-exclusion). Fail-open ⇒ an error reads as "no decision".
    function decisionActive() {
      try {
        const card = document.getElementById("orwell-decision-card");
        if (!card || !document.body || !document.body.contains(card)) return false;
        if (card.hidden) return false;
        const cs = window.getComputedStyle ? window.getComputedStyle(card) : null;
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) return false;
        const r = card.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false; // mid-removal collapse ⇒ not shown
        return true;
      } catch (_) { return false; }
    }
    let _decOn = null, _decRaf = 0;
    function applyDecisionState() {
      _decRaf = 0;
      try {
        if (!document.body || !document.body.classList) return;
        ensureDecisionCss();
        const on = decisionActive();
        if (on === _decOn) return; // toggle the class only on a real flip
        _decOn = on;
        document.body.classList.toggle("ow-decision-active", on);
      } catch (_) { /* fail-open: no suppression if the DOM APIs aren't available (e.g. test stub) */ }
    }
    // The card mounts/unmounts on the same body-mutation cadence as streamed tokens, so coalesce to
    // one check per frame (the #933 rAF-coalescing lesson); the class toggle still fires only on a flip.
    function scheduleDecisionCheck() {
      if (_decRaf) return;
      _decRaf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(applyDecisionState);
    }
    function startDecisionWatch() {
      applyDecisionState();
      // The decision card lives OUTSIDE any slot (an OrwellSheet above the composer) and is .remove()'d
      // on dismiss / after a 4s "locked in", so watch the whole body subtree for its mount/unmount;
      // orwell:pending is the explicit fast signal, orwell:gamechanged a belt.
      try {
        if (typeof MutationObserver !== "undefined") {
          new MutationObserver(scheduleDecisionCheck)
            .observe(document.body, { childList: true, subtree: true });
        }
      } catch (_) {}
      window.addEventListener("orwell:pending", scheduleDecisionCheck);
      window.addEventListener("orwell:gamechanged", scheduleDecisionCheck);
    }
    if (document.body) startDecisionWatch();
    else document.addEventListener("DOMContentLoaded", startDecisionWatch, { once: true });
  })();

  window.OrwellSlots = { register, restackAll, visibleBottom };
})();
