// OrwellSheet — THE iOS-style bottom-sheet kit (#753, Genius #15/16/17). The FOURTH DWE kit,
// sibling to OrwellWindow (floating window band), OrwellGadget (control-room rail), and
// OrwellNotice (above-composer affordance zone). This one owns the BOTTOM-SHEET surface — an
// iOS UISheetPresentationController in CSS/JS: a panel that rises from the bottom of the
// viewport, snaps between DETENTS (medium + large), drags to a detent, swipes to dismiss, and
// goes OPAQUE as it climbs to full height (Apple's translucent-at-medium → solid-at-large).
//
// Built on the existing Liquid Glass kit material + tokens (the SAME --ow-glass-* / --win-* /
// --ow-ui-font family every other kit composes) so a sheet paints one visual language with the
// windows/notices/gadgets and the house themes (0052) hit it for free.
//
// The kit OWNS, in one place:
//   • DETENTS: medium + large snap heights (programmatic via .snap('medium'|'large') and
//     drag-to-nearest-detent on release). A non-dismissable detent floor (medium) and a full
//     detent (large). The detents are viewport fractions, clamped.
//   • OPAQUE-UP: the sheet is translucent glass at medium and interpolates toward an OPAQUE
//     solid fill as it approaches the large/full detent (a CSS custom property --ow-sheet-prog
//     0→1 the JS writes on every height change; the glass fill cross-fades to the solid panel).
//   • GRABBER + GESTURES: a grabber handle at the top; drag the grabber/header to move between
//     detents; drag DOWN past the medium detent → dismiss; tap the scrim → dismiss.
//   • A11Y TRIO: prefers-reduced-transparency → opaque fill at every detent; prefers-reduced-
//     motion → no slide/spring (instant snap); prefers-contrast → a hard rim. A focus-trap +
//     role="dialog"/aria-modal, focus-return to the opener, the 44px touch floor on the grabber
//     and controls, Escape-to-dismiss through the shared seam.
//
// PEEK-THROUGH, NOT REPLACE: a sheet at medium leaves the page (the chat) visible behind it
// through a LIGHT scrim — the chat stays MOUNTED and readable (the casting migration relies on
// this: the chat is never destroyed). An `anchored` sheet (the decision migration) renders as a
// NON-MODAL action-sheet pinned above the composer — no scrim, no inert background, the player
// keeps reading the room.
//
// Vault-free by construction: the kit only paints chrome + tracks detent/progress geometry — it
// never touches game state. g15: it NEVER dispatches `orwell:gamechanged` (the single dispatcher
// stays in platform.js); consumers that mutate game state call window.orwellGameChanged
// themselves (the decision migration does, exactly as the legacy card did).
//
// The seam every consumer + the headless gate use is window.OrwellSheetKit.create(opts).

(function () {
  "use strict";

  var REDUCED_MOTION = function () {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  };

  // Detent heights as a fraction of the (dynamic) viewport height. Medium ~ half the screen
  // (the chat peeks through above it); large ~ near-full (the studio). Clamped to a sane px
  // band so a tiny viewport doesn't collapse the sheet and a huge one doesn't float it.
  var DETENT_FRACTION = { medium: 0.52, large: 0.92 };
  var DETENT_MIN_PX = 220;          // never shorter than this (the grabber + a line of content)
  // The dismiss threshold: dragging the medium detent DOWN by more than this fraction of the
  // medium height (on release) dismisses instead of snapping back.
  var DISMISS_DRAG_FRACTION = 0.4;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Dynamic viewport height (tracks the keyboard/URL-bar-shrunk mobile viewport when available).
  function vh() {
    try {
      if (window.visualViewport && window.visualViewport.height) return window.visualViewport.height;
    } catch (_) {}
    return window.innerHeight || document.documentElement.clientHeight || 600;
  }

  // The px height for a named detent, clamped into a sane band for the current viewport.
  function detentPx(name) {
    var h = vh();
    var frac = DETENT_FRACTION[name] != null ? DETENT_FRACTION[name] : DETENT_FRACTION.medium;
    return Math.max(Math.min(DETENT_MIN_PX, h - 8), Math.round(h * frac));
  }

  // ── the one CSS family ──────────────────────────────────────────────────────
  // Theme-token driven (the house themes 0052 + the frost layer paint it for free), with literal
  // fallbacks for before style.css loads — mirroring orwellWindow.js's ensureCss() and the other
  // kits'. Built by STRING CONCATENATION (never a backtick template) so a stray backtick in a
  // comment can't blow up the template literal (the notice kit's documented footgun). The linked
  // stylesheet carries the SAME rules in its `.ow-sheet` region (kept in lock-step).
  function ensureCss() {
    if (document.getElementById("ow-sheet-css")) return;
    var st = document.createElement("style");
    st.id = "ow-sheet-css";
    st.textContent =
      // ── the scrim (modal sheets only) ─────────────────────────────────────────
      // A LIGHT scrim (lighter than a window modal's) so the chat PEEKS THROUGH behind a medium
      // sheet — the page recedes but is never blacked out (the casting migration relies on the
      // chat staying visibly mounted). reduced-motion strips the fade.
      ".ow-sheet-scrim {" +
      "  position: fixed; inset: 0; z-index: 1200;" +
      "  background: var(--ow-sheet-scrim-bg, rgba(0,0,0,.32));" +
      "  animation: ow-sheet-scrim-in .2s ease-out; }" +
      "@keyframes ow-sheet-scrim-in { from { opacity: 0; } to { opacity: 1; } }" +
      // ── the sheet panel ───────────────────────────────────────────────────────
      // Pinned to the bottom of the viewport, rising to its detent height. The TRANSLUCENT glass
      // is the kube ONE LIGHT GLASS (the same tokens every kit uses); the OPAQUE-UP solid fill is
      // cross-faded in via --ow-sheet-prog (0 at medium → 1 at large). Rounded TOP corners only.
      ".ow-sheet {" +
      "  position: fixed; left: 50%; bottom: 0; transform: translateX(-50%);" +
      "  z-index: 1201; width: 100%; max-width: 720px;" +
      "  display: flex; flex-direction: column;" +
      "  border-top-left-radius: var(--ow-glass-radius, 20px);" +
      "  border-top-right-radius: var(--ow-glass-radius, 20px);" +
      "  border: 1px solid var(--win-border, var(--border, #355a66)); border-bottom: none;" +
      "  background: var(--win-bg, var(--panel, #111)); color: var(--fg, #9cdef2);" +
      "  box-shadow: 0 -8px 40px rgba(0,0,0,.45);" +
      "  font-family: var(--ow-ui-font); font-size: var(--ow-fs-body, .875rem); line-height: 1.5;" +
      "  --ow-sheet-prog: 0;" +
      "  overflow: hidden; }" +
      // The slide-up entrance + the snap transition. The JS writes the inline height; the
      // transition glides it between detents. reduced-motion strips both (instant snap).
      ".ow-sheet { transition: height .32s cubic-bezier(.32,.72,0,1), background-color .2s ease; }" +
      ".ow-sheet.ow-sheet-dragging { transition: none; }" +   // 1:1 with the finger while dragging
      "@keyframes ow-sheet-in { from { transform: translate(-50%, 100%); } to { transform: translate(-50%, 0); } }" +
      "@keyframes ow-sheet-out { from { transform: translate(-50%, 0); } to { transform: translate(-50%, 100%); } }" +
      ".ow-sheet.ow-sheet-anim-in { animation: ow-sheet-in .34s cubic-bezier(.32,.72,0,1) both; }" +
      ".ow-sheet.ow-sheet-anim-out { animation: ow-sheet-out .26s cubic-bezier(.4,0,1,1) both; }" +
      // BL-046 (frosted sheet content-ready gate): mirror the orwellWindow sheet-mode fix — on
      // the frosted GLASS theme hold the body invisible until the open path clears the
      // `ow-sheet-content-pending` flag (removed on a painted frame + a hard timeout fallback,
      // so it can NEVER stay hidden), then fade it in, so the sheet never flashes an empty
      // translucent body while the backdrop-filter composites. Frosted-scoped; flat untouched.
      "body.theme-frosted .ow-sheet.ow-sheet-content-pending .ow-sheet-body { opacity: 0; }" +
      "body.theme-frosted .ow-sheet .ow-sheet-body { transition: opacity .18s ease; }" +
      "@media (prefers-reduced-motion: reduce) { .ow-sheet .ow-sheet-body { transition: none !important; } }" +
      // ── OPAQUE-UP: translucent glass at medium → solid at large ─────────────────
      // Under the glass theme the sheet is the ONE LIGHT GLASS, and a second layer (the solid
      // panel) cross-fades IN as --ow-sheet-prog climbs toward 1 (the large/full detent), exactly
      // like iOS's sheet going opaque as it approaches the top. Below the threshold it's glass.
      "@media (prefers-reduced-transparency: no-preference) {" +
      "  body.theme-frosted .ow-sheet {" +
      "    background-color: var(--ow-glass-light-color, rgba(255,255,255,.6));" +
      "    background-image: var(--ow-glass-light-fill, none);" +
      "    -webkit-backdrop-filter: blur(18px) saturate(180%);" +
      "    backdrop-filter: blur(18px) saturate(180%);" +
      "    color: #16191f; }" +
      // The opaque layer's opacity rides --ow-sheet-prog: a separate ::before so the backdrop blur
      // (which a background can't fade) stays glass while the solid color climbs in over it.
      "  body.theme-frosted .ow-sheet::before {" +
      "    content: \"\"; position: absolute; inset: 0; z-index: -1; pointer-events: none;" +
      "    background: var(--win-bg, var(--panel, #111));" +
      "    opacity: var(--ow-sheet-prog, 0); transition: opacity .2s ease;" +
      "    border-top-left-radius: inherit; border-top-right-radius: inherit; }" +
      // The ink darkens back toward the glass-on-light ink as the solid climbs in (legible on both).
      "  body.theme-frosted .ow-sheet { color: color-mix(in srgb, #16191f calc((1 - var(--ow-sheet-prog,0)) * 100%), var(--fg, #9cdef2)); }" +
      "}" +
      // A11Y: prefers-reduced-transparency → ALWAYS opaque (no glass, no progress cross-fade).
      "@media (prefers-reduced-transparency: reduce) {" +
      "  .ow-sheet { background: var(--win-bg, var(--panel, #111)) !important;" +
      "    -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }" +
      "  .ow-sheet::before { display: none !important; } }" +
      // A11Y: prefers-contrast → a hard, high-contrast rim (the soft glass rim is too faint).
      "@media (prefers-contrast: more), (forced-colors: active) {" +
      "  .ow-sheet { border-color: var(--fg, CanvasText) !important; border-width: 2px !important; }" +
      "  .ow-sheet-grabber span { background: var(--fg, CanvasText) !important; } }" +
      // ── the grabber handle ──────────────────────────────────────────────────────
      // The iOS pill. A 44px-tall hit region (WCAG 2.5.5) with a small visible pill inside, so
      // dragging it is the primary detent gesture. cursor:grab signals draggability.
      ".ow-sheet-grabber {" +
      "  position: relative; flex: 0 0 auto; min-height: 28px; padding-top: 8px;" +
      "  display: flex; align-items: flex-start; justify-content: center;" +
      "  cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none; }" +
      ".ow-sheet-grabber:active { cursor: grabbing; }" +
      ".ow-sheet-grabber span {" +
      "  display: block; width: 38px; height: 5px; border-radius: 3px;" +
      "  background: color-mix(in srgb, var(--fg, #9cdef2) 38%, transparent); }" +
      // A bigger invisible grab target around the pill (the 44px touch floor) without bloating it.
      ".ow-sheet-grabber::after { content: \"\"; position: absolute; left: 0; right: 0; top: 0; height: 44px; }" +
      // ── the header (title + close) ──────────────────────────────────────────────
      ".ow-sheet-head {" +
      "  flex: 0 0 auto; display: flex; align-items: center; gap: .5rem;" +
      "  padding: .15rem .9rem .5rem; touch-action: none; }" +
      ".ow-sheet-title {" +
      "  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" +
      "  font-size: var(--ow-fs-title, 1rem); font-weight: var(--ow-fw-semibold, 600); letter-spacing: -.01em; }" +
      ".ow-sheet-close {" +
      "  flex: 0 0 auto; min-width: 44px; min-height: 44px; padding: 0; margin: -.5rem -.4rem -.5rem 0;" +
      "  display: inline-flex; align-items: center; justify-content: center;" +
      "  border: none; background: none; color: inherit; cursor: pointer;" +
      "  opacity: .65; border-radius: 8px; font: inherit; font-size: 1.1rem; }" +
      ".ow-sheet-close:hover, .ow-sheet-close:focus-visible { opacity: 1; background: rgba(255,255,255,.1); }" +
      // ── the scrolling body ──────────────────────────────────────────────────────
      ".ow-sheet-body { flex: 1 1 auto; overflow: auto; -webkit-overflow-scrolling: touch;" +
      "  padding: 0 .9rem calc(.9rem + env(safe-area-inset-bottom, 0px)); }" +
      // WCAG 2.1.1 (Keyboard): the scroll body is focusable (tabindex=0, set in _build) so a
      // keyboard/SR user can Tab to it and arrow/PageDown/Space through content below the fold.
      // Neutral iOS-blue ring, consistent with the window kit.
      ".ow-sheet-body:focus-visible { outline: 2px solid var(--ow-ios-blue, #0a84ff); outline-offset: -2px; }" +
      // ── ANCHORED (non-modal action-sheet) placement ─────────────────────────────
      // A NON-MODAL sheet pinned above the composer (the decision migration). No scrim, no inert
      // background, no full-height detents — it's a deliberate action panel anchored to the
      // composer, sitting in the page flow so the player keeps reading the room. It reuses the
      // grabber/head/body chrome + the glass fill, but NOT the fixed-bottom/detent geometry.
      ".ow-sheet.ow-sheet-anchored {" +
      "  position: relative; left: auto; bottom: auto; transform: none;" +
      "  width: 100%; max-width: 760px; margin: 0 auto var(--space-2, .45rem);" +
      "  height: auto !important; z-index: auto; pointer-events: auto;" +
      // #1245 (VIS-1): this sheet mounts as a flex ITEM of #on-notice-zone (a max-height-capped
      // flex column with its own overflow-y:auto). Because the sheet itself sets overflow:hidden,
      // its flexbox automatic minimum size collapses to 0, so the zone's default flex-shrink:1
      // squeezed the sheet down to fit the zone's cap instead of letting the ZONE scroll around
      // it — guillotining the card's footer/Confirm on phone-390 with no way to reach it. Keep
      // this in lock-step with the linked-stylesheet copy in style.css.
      "  flex-shrink: 0;" +
      "  border-radius: var(--ow-glass-radius-inner, 14px); border: 1px solid var(--accent, var(--red, #e06c75));" +
      "  border-bottom: 1px solid var(--accent, var(--red, #e06c75));" +
      "  box-shadow: var(--win-shadow, 0 8px 32px rgba(0,0,0,.45)); }" +
      ".ow-sheet.ow-sheet-anchored .ow-sheet-grabber { min-height: 18px; padding-top: 6px; cursor: default; }" +
      ".ow-sheet.ow-sheet-anchored .ow-sheet-grabber::after { display: none; }" +   // not draggable
      ".ow-sheet.ow-sheet-anchored .ow-sheet-body { max-height: 60vh; max-height: 60dvh; }" +
      // anchored mount/unmount: a gentle rise+fade (the notice-zone motion), not a full slide-up.
      "@keyframes ow-sheet-anchored-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }" +
      ".ow-sheet.ow-sheet-anchored.ow-sheet-anim-in { animation: ow-sheet-anchored-in .22s cubic-bezier(.22,.61,.36,1) both; }" +
      // ── reduced motion strips every animation/transition ────────────────────────
      "@media (prefers-reduced-motion: reduce) {" +
      "  .ow-sheet, .ow-sheet.ow-sheet-anim-in, .ow-sheet.ow-sheet-anim-out," +
      "  .ow-sheet-scrim, .ow-sheet::before { animation: none !important; transition: none !important; } }";
    document.head.appendChild(st);
  }

  // ── the sheet ───────────────────────────────────────────────────────────────
  function OrwellSheet(opts) {
    if (!(this instanceof OrwellSheet)) return new OrwellSheet(opts);
    this.o = Object.assign({
      // id          — stable per-sheet element id (one instance per id at a time).
      // title       — the header heading text.
      // content     — Node | string mounted into the scrolling body.
      // detents     — ["medium","large"] (the snap set). The first is the open detent.
      // detent      — the detent to OPEN at (default the first in `detents`).
      // anchored    — true → a NON-MODAL action-sheet above the composer (no scrim/detents).
      //               false (default) → a modal bottom-sheet with detents + scrim + focus-trap.
      // dismissible — render the × + allow swipe/scrim/Escape dismiss (default true).
      // scrimDismiss/swipeDismiss — fine-grained gates (default true for a modal sheet).
      // role        — ARIA role (default 'dialog' for modal, 'group' for anchored).
      // onDetent(name) — fired when the sheet snaps to a detent.
      // onDismiss(reason) — fired after dismissal ('user'|'scrim'|'swipe'|'escape'|'api').
      id: "orwell-sheet",
      title: "",
      detents: ["medium", "large"],
      anchored: false,
      dismissible: true,
      scrimDismiss: true,
      swipeDismiss: true,
      onDetent: null,
      onDismiss: null,
    }, opts || {});
    if (!this.o.id) throw new Error("OrwellSheet needs an id");
    this.el = null;
    this.scrim = null;
    this.opener = null;
    this.detent = null;             // the current detent name (modal sheets)
    this._inerted = [];
    this._ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
    this._drag = null;              // live drag state
  }

  OrwellSheet.prototype._detents = function () {
    var d = (this.o.detents || []).filter(function (n) { return DETENT_FRACTION[n] != null; });
    return d.length ? d : ["medium"];
  };

  OrwellSheet.prototype._build = function () {
    ensureCss();
    var self = this;
    var anchored = !!this.o.anchored;
    var el = document.createElement("section");
    el.id = this.o.id;
    el.className = "ow-sheet" + (anchored ? " ow-sheet-anchored" : "");
    el.setAttribute("data-ow-sheet", "");
    el.setAttribute("role", this.o.role || (anchored ? "group" : "dialog"));
    if (this.o.title) el.setAttribute("aria-label", this.o.title);
    if (!anchored) el.setAttribute("aria-modal", "true");
    // #837: the sheet root is the SPAWN/focus-trap target — tabindex=-1 keeps it out of
    // the Tab order and (.ow-sheet:focus / [tabindex="-1"]:focus) ring-free on mount.
    el.setAttribute("tabindex", "-1");

    // The grabber handle (the iOS pill). Always rendered (it carries the detent meaning visually);
    // on an anchored sheet it is a non-interactive visual cap (CSS disables the drag target).
    var grab = document.createElement("div");
    grab.className = "ow-sheet-grabber";
    grab.setAttribute("aria-hidden", "true");
    grab.innerHTML = "<span></span>";

    // The header: title + (dismissible) the × close.
    var head = document.createElement("div");
    head.className = "ow-sheet-head";
    var title = document.createElement("span");
    title.className = "ow-sheet-title";
    title.setAttribute("role", "heading");
    title.setAttribute("aria-level", "2");
    title.textContent = this.o.title || "";
    head.appendChild(title);
    if (this.o.dismissible) {
      var x = document.createElement("button");
      x.type = "button"; x.className = "ow-sheet-close";
      x.textContent = "×";
      x.title = "Close";
      x.setAttribute("aria-label", "Close" + (this.o.title ? " — " + this.o.title : ""));
      x.addEventListener("click", function () { self.dismiss("user"); },
        this._ac ? { signal: this._ac.signal } : false);
      head.appendChild(x);
      this.closeBtn = x;
    }

    var body = document.createElement("div");
    body.className = "ow-sheet-body";
    // WCAG 2.1.1 (Keyboard): the sheet body scrolls (overflow:auto, detent-capped max-height), so
    // non-interactive content below the fold is unreachable without a pointer. tabindex=0 lets a
    // keyboard/SR user land on it (native arrow/PageDown/Space scroll) and — since _trapFocus's
    // query already matches [tabindex] — folds it into the sheet's focus trap. role=region + a
    // title-derived label names it in the accessibility tree.
    body.setAttribute("tabindex", "0");
    body.setAttribute("role", "region");
    body.setAttribute("aria-label", this.o.title ? this.o.title + " content" : "panel content");
    if (this.o.content instanceof Node) body.appendChild(this.o.content);
    else if (typeof this.o.content === "string") body.innerHTML = this.o.content;

    el.appendChild(grab); el.appendChild(head); el.appendChild(body);
    this.el = el; this.grabber = grab; this.head = head; this.body = body;

    // Detent gestures (modal sheets only): drag the grabber OR the header to move between detents;
    // release snaps to the nearest detent, or dismisses if dragged below the medium floor.
    if (!anchored) {
      this._wireDrag(grab);
      this._wireDrag(head);
    }
    return el;
  };

  // ── drag-to-detent + swipe-dismiss ───────────────────────────────────────────
  OrwellSheet.prototype._wireDrag = function (handle) {
    var self = this;
    var opt = this._ac ? { signal: this._ac.signal } : false;
    var optPassive = this._ac ? { signal: this._ac.signal, passive: false } : false;

    var onMove = function (e) {
      if (!self._drag) return;
      var y = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);
      if (y == null) return;
      var dy = y - self._drag.startY;
      if (Math.abs(dy) > 3) self._drag.moved = true;
      // Dragging DOWN (positive dy) shrinks the sheet; UP grows it. Clamp to [0, largeHeight].
      var maxH = detentPx("large");
      var h = Math.max(0, Math.min(maxH, self._drag.startH - dy));
      // 1:1 follow (reduced-motion already turns transitions off; the dragging class also does).
      self.el.style.height = h + "px";
      self._writeProgress(h);
      if (e.cancelable) { try { e.preventDefault(); } catch (_) {} }   // own the gesture, no page scroll
    };

    var onUp = function () {
      window.removeEventListener("pointermove", onMove, optPassive);
      window.removeEventListener("touchmove", onMove, optPassive);
      window.removeEventListener("pointerup", onUp, opt);
      window.removeEventListener("touchend", onUp, opt);
      window.removeEventListener("pointercancel", onUp, opt);
      self.el.classList.remove("ow-sheet-dragging");
      if (!self._drag) return;
      var h = self.el.getBoundingClientRect().height;
      var drag = self._drag; self._drag = null;
      if (!drag.moved) return;                          // a tap, not a drag — leave the detent
      self._settle(h);
    };

    var onDown = function (e) {
      // Don't start a drag from the close button (it has its own click).
      if (e.target && e.target.closest && e.target.closest(".ow-sheet-close")) return;
      var startY = (e.touches && e.touches[0] ? e.touches[0].clientY : e.clientY);
      if (startY == null) return;
      self._drag = { startY: startY, startH: self.el.getBoundingClientRect().height, moved: false };
      self.el.classList.add("ow-sheet-dragging");
      window.addEventListener("pointermove", onMove, optPassive);
      window.addEventListener("touchmove", onMove, optPassive);
      window.addEventListener("pointerup", onUp, opt);
      window.addEventListener("touchend", onUp, opt);
      window.addEventListener("pointercancel", onUp, opt);
    };

    handle.addEventListener("pointerdown", onDown, opt);
    handle.addEventListener("touchstart", onDown, optPassive);
  };

  // Decide where a released drag lands: dismiss (dragged well below medium), else snap to the
  // nearest available detent.
  OrwellSheet.prototype._settle = function (h) {
    var detents = this._detents();
    var medium = detentPx(detents[0]);
    // Swipe-dismiss: dragged down past the dismiss threshold below the smallest detent.
    if (this.o.swipeDismiss && this.o.dismissible &&
        h < medium * (1 - DISMISS_DRAG_FRACTION)) {
      this.dismiss("swipe");
      return;
    }
    // Snap to the nearest detent by px distance.
    var best = detents[0], bestD = Infinity;
    for (var i = 0; i < detents.length; i++) {
      var dpx = detentPx(detents[i]);
      var dist = Math.abs(dpx - h);
      if (dist < bestD) { bestD = dist; best = detents[i]; }
    }
    this.snap(best);
  };

  // Write the OPAQUE-UP progress: 0 at (or below) the medium detent, 1 at the large detent. Drives
  // --ow-sheet-prog, which the CSS uses to cross-fade the translucent glass to the solid fill.
  OrwellSheet.prototype._writeProgress = function (h) {
    if (!this.el) return;
    var detents = this._detents();
    var lo = detentPx(detents[0]);
    var hi = detentPx(detents[detents.length - 1]);
    var prog = (hi > lo) ? (h - lo) / (hi - lo) : 0;
    prog = Math.max(0, Math.min(1, prog));
    this.el.style.setProperty("--ow-sheet-prog", String(prog));
    this.el.dataset.owSheetProg = prog.toFixed(2);
  };

  // ── public detent API ─────────────────────────────────────────────────────────
  // Snap to a named detent (programmatic + the drag-release target). Sets the inline height the
  // CSS transition glides to; writes the opaque-up progress; fires onDetent.
  OrwellSheet.prototype.snap = function (name) {
    if (!this.el || this.o.anchored) return this;
    var detents = this._detents();
    if (detents.indexOf(name) === -1) name = detents[0];
    var h = detentPx(name);
    this.el.style.height = h + "px";
    this.el.dataset.owDetent = name;
    this.detent = name;
    this._writeProgress(h);
    if (typeof this.o.onDetent === "function") { try { this.o.onDetent(name); } catch (_) {} }
    return this;
  };

  OrwellSheet.prototype.currentDetent = function () { return this.detent; };

  // ── modal chrome (scrim + inert background + focus-trap) ───────────────────────
  // A LIGHT scrim so the chat peeks through; the rest of the page goes inert (the aria-modal
  // promise); Tab is trapped inside. An anchored sheet skips all of this (it's non-modal).
  OrwellSheet.prototype._mountModalChrome = function () {
    if (this.o.anchored || this.scrim) return;
    var self = this;
    var scrim = document.createElement("div");
    scrim.className = "ow-sheet-scrim";
    scrim.setAttribute("data-ow-sheet-scrim", this.o.id);
    if (this.o.scrimDismiss && this.o.dismissible) {
      scrim.addEventListener("click", function () { self.dismiss("scrim"); },
        this._ac ? { signal: this._ac.signal } : false);
    }
    document.body.insertBefore(scrim, this.el);
    this.scrim = scrim;
    this._inertBackground();
    this._trapFocus();
  };

  OrwellSheet.prototype._inertBackground = function () {
    this._inerted = [];
    var self = this;
    Array.prototype.forEach.call(document.body.children, function (n) {
      if (n === self.el || n === self.scrim || n.tagName === "SCRIPT" || n.tagName === "STYLE") return;
      if (!n.inert) { try { n.inert = true; self._inerted.push(n); } catch (_) {} }
    });
  };

  OrwellSheet.prototype._uninertBackground = function () {
    (this._inerted || []).forEach(function (n) { try { n.inert = false; } catch (_) {} });
    this._inerted = [];
  };

  OrwellSheet.prototype._trapFocus = function () {
    var self = this;
    this.el.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var all = self.el.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])");
      var f = Array.prototype.filter.call(all, function (n) {
        return !n.disabled && (n.offsetParent !== null || n === document.activeElement);
      });
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }, this._ac ? { signal: this._ac.signal } : false);
  };

  OrwellSheet.prototype._focusInto = function () {
    // #837: land on the ring-free sheet ROOT on spawn, NOT the first interactive control
    // (which would paint a focus ring the user never keyboard-asked for). The trap keeps
    // Tab inside; the first Tab reaches the first control and THAT rings (keyboard intent).
    try { this.el.focus({ preventScroll: true }); } catch (_) {}
  };

  // ── open / dismiss ──────────────────────────────────────────────────────────
  // BL-046: hold the frosted sheet body invisible until a frame has painted, so it never
  // flashes an empty translucent void while the backdrop-filter composites. FAIL-OPEN — the
  // pending class is always cleared by the rAF, backed by a hard timeout; a missed frame can
  // never leave a permanently-blank body. The visual effect is CSS-scoped to the frosted theme.
  OrwellSheet.prototype._gateContentReady = function (el) {
    el.classList.add("ow-sheet-content-pending");
    var revealed = false;
    var reveal = function () {
      if (revealed) return;
      revealed = true;
      el.classList.remove("ow-sheet-content-pending");
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(function () { requestAnimationFrame(reveal); });
    } else {
      reveal();
    }
    setTimeout(reveal, 400);
  };

  OrwellSheet.prototype.open = function (opener) {
    if (this.el && this.el.isConnected) return this;
    if (this._ac && this._ac.signal.aborted) this._ac = new AbortController();
    this.opener = opener || document.activeElement || null;
    var el = this.el || this._build();
    var anchored = !!this.o.anchored;

    if (anchored) {
      // Mount into the above-composer notice zone if available (so it stacks with the other
      // affordances), else above the composer bar, else body — the fail-open chain the other
      // kits use.
      var host = this._anchorHost();
      host.appendChild(el);
      this._gateContentReady(el);
      if (!REDUCED_MOTION()) {
        el.classList.add("ow-sheet-anim-in");
        el.addEventListener("animationend", function h() {
          el.classList.remove("ow-sheet-anim-in"); el.removeEventListener("animationend", h);
        }, { once: true });
      }
      _byId[this.o.id] = this;
      try { el.scrollIntoView({ block: "nearest" }); } catch (_) {}
      // Focus the sheet so keyboard/SR users land on the new action surface.
      el.setAttribute("tabindex", "-1");
      try { el.focus(); } catch (_) {}
      return this;
    }

    document.body.appendChild(el);
    _byId[this.o.id] = this;
    this._gateContentReady(el);
    // Open AT the chosen detent (set the height first so the slide-up lands at it).
    var openDetent = this.o.detent || this._detents()[0];
    this.snap(openDetent);
    if (!REDUCED_MOTION()) {
      el.classList.add("ow-sheet-anim-in");
      el.addEventListener("animationend", function h() {
        el.classList.remove("ow-sheet-anim-in"); el.removeEventListener("animationend", h);
      }, { once: true });
    }
    this._mountModalChrome();
    this._focusInto();
    return this;
  };

  // The anchored mount host: the OrwellNotice stacked zone → the composer bar's parent → body.
  OrwellSheet.prototype._anchorHost = function () {
    try {
      if (window.OrwellNoticeKit && typeof window.OrwellNoticeKit.ensureZone === "function") {
        return window.OrwellNoticeKit.ensureZone();
      }
    } catch (_) {}
    var bar = document.querySelector(".chat-input-bar") || document.getElementById("chat-bar");
    if (bar && bar.parentNode) {
      var wrap = document.createElement("div");
      bar.parentNode.insertBefore(wrap, bar);
      return wrap;
    }
    return document.body;
  };

  // Tear down (no dismissal record). reduced-motion-safe fade/slide-out.
  OrwellSheet.prototype.hide = function () {
    var el = this.el;
    if (!el || !el.isConnected) { this.el = null; return; }
    var self = this;
    var done = function () {
      try { if (el.isConnected) el.remove(); } catch (_) {}
      self._unmountModalChrome();
      if (self._ac) { try { self._ac.abort(); } catch (_) {} }
      delete _byId[self.o.id];
      // Focus return to the opener (audit F8 parity with the window kit).
      var opener = self.opener;
      if (typeof window._owReturnFocus === "function") {
        try { window._owReturnFocus(opener, document.body); } catch (_) {}
      } else if (opener && opener.isConnected && typeof opener.focus === "function") {
        try { opener.focus(); } catch (_) {}
      }
      self.el = null;
    };
    if (REDUCED_MOTION()) { done(); return; }
    el.classList.add("ow-sheet-anim-out");
    el.addEventListener("animationend", done, { once: true });
    setTimeout(done, 320);   // belt: fire even if animationend is missed
  };

  OrwellSheet.prototype._unmountModalChrome = function () {
    if (this.scrim) { try { this.scrim.remove(); } catch (_) {} this.scrim = null; }
    this._uninertBackground();
  };

  // Dismiss = hide + fire onDismiss(reason). reason ∈ {'user','scrim','swipe','escape','api'}.
  OrwellSheet.prototype.dismiss = function (reason) {
    if (!this.o.dismissible && reason !== "api") return;
    this.hide();
    if (typeof this.o.onDismiss === "function") {
      try { this.o.onDismiss(reason || "user"); } catch (_) {}
    }
  };

  OrwellSheet.prototype.isShown = function () { return !!(this.el && this.el.isConnected); };

  // Replace/return the scrolling body (the consumer fills it).
  OrwellSheet.prototype.setBody = function (content) {
    if (!this.body) this._build();
    if (content instanceof Node) { this.body.innerHTML = ""; this.body.appendChild(content); }
    else this.body.innerHTML = content == null ? "" : String(content);
    return this;
  };
  OrwellSheet.prototype.ensure = function () { this.open(); return this.body; };

  // ── Escape participation (parity with the window kit's dismissTop) ─────────────
  var _byId = {};
  function dismissTop() {
    var ids = Object.keys(_byId);
    for (var i = ids.length - 1; i >= 0; i--) {
      var s = _byId[ids[i]];
      if (!s || !s.el || !s.el.isConnected) { delete _byId[ids[i]]; continue; }
      if (s.o.anchored) continue;             // anchored sheets are non-modal — Escape skips them
      if (s.o.dismissible) { s.dismiss("escape"); return true; }
    }
    return false;
  }
  function openIds() { return Object.keys(_byId); }

  // Re-snap the open modal sheets on a viewport change (the detent px tracks the dynamic
  // viewport). Cheap; rAF-debounced; anchored sheets have no detent geometry to re-place.
  var _raf = 0;
  function onViewportResize() {
    if (_raf) return;
    _raf = (window.requestAnimationFrame || function (fn) { return setTimeout(fn, 120); })(function () {
      _raf = 0;
      Object.keys(_byId).forEach(function (id) {
        var s = _byId[id];
        if (s && s.el && s.el.isConnected && !s.o.anchored && s.detent) {
          try { s.snap(s.detent); } catch (_) {}
        }
      });
    });
  }
  window.addEventListener("resize", onViewportResize);
  try { if (window.visualViewport) window.visualViewport.addEventListener("resize", onViewportResize); } catch (_) {}

  // Inject the CSS at load (the .ow-sheet family is page-global chrome).
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureCss, { once: true });
  } else {
    ensureCss();
  }

  // The seam every consumer + the headless gate use (mirrors OrwellWindowKit / OrwellNoticeKit).
  window.OrwellSheetKit = {
    create: function (opts) { return new OrwellSheet(opts); },
    dismissTop: dismissTop,
    openIds: openIds,
    esc: esc,
  };
  window.OrwellSheet = OrwellSheet;
})();
