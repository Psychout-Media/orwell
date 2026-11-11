// OrwellWindow — THE window kit (Lane F / F-1; DWE audit Phase 2).
//
// One base class + one CSS family (.ow-window / .ow-titlebar / .ow-controls /
// .ow-body + state modifiers) that every panel, modal, and popover composes —
// replacing the per-panel reimplementations the 2026-06-11 DWE audit censused
// (3 drag engines, 7 geometry-key schemes, 6 chrome builders, 5+ Escape paths,
// 2 z escalators). The kit OWNS, in one place:
//
//   • registration: OrwellSlots (placement) + modalManager (minimize/dock chip)
//   • drag (windowDrag) with an EXPLICIT clamp — never trust cursor physics
//   • one z-authority for the window band (modals stay above; banner above all)
//     + click-to-front + a visible focused state (audit F9)
//   • minimize-to-dock with the ruling-#19 fly-out toward the dock and a
//     fly-away on close; restore mirrors minimize with a fly-IN from the dock,
//     and open keeps the E97 fade+scale (open↔close and minimize↔restore are
//     mirror-image motions); prefers-reduced-motion strips ALL of it (audit F4)
//   • ONE geometry-persistence scheme: the slot offset, clamped at restore
//     (S11/E91) — kit windows never mint their own position keys (audit F5)
//   • focus management: focus-return to the opener on close (audit F8),
//     keyboard move on the titlebar — arrows move, Shift+arrows resize where
//     enabled, Home re-docks to the slot base (audit F10)
//   • Escape participation through ui.js's single arbiter (audit F7): menus
//     dismiss first, then the top kit window parks/closes, then modals
//   • teardown: one AbortController; destroy() leaves no listeners, no node
//
// Migration waves (Lane F / F-2) move each existing surface onto this class
// and DELETE its bespoke code in the same PR. New windows MUST compose the kit
// (the F-3 ratchet pins it).
import * as Modals from './modalManager.js';
import { makeWindowDraggable } from './windowDrag.js';
import { makeWindowResizable, windowMaxWidth } from './windowResize.js';
import { isNarrow, onNarrowChange } from './platform.js';

// A2 (#573, DWE audit F9): the kit no longer owns a PRIVATE z counter. The kit's
// non-modal band (the old `_zTop` 500–980) is now allocated by THE single window
// authority `window.OrwellZ` (ui.js), the same monotonic tick the .modal family
// and the kit's modal tier draw from — so "topmost / focused" has one source of
// truth across kit windows AND legacy modals/overlays. The band offsets in OrwellZ
// keep kit windows structurally below modals (no more agreement-by-numeric-gap).
// Fallback (ui.js not yet loaded): a local band counter preserves the old behavior.
const Z_BASE = 500;          // the window band: above the legacy panel stamps
const Z_CEIL = 980;          //   (modalManager's 300s), below modals (1000+)
let _zFallback = Z_BASE;     // used ONLY when window._owNextWindowZ is absent
const _stack = [];           // open, un-minimized kit windows, bottom → top

// Allocate the next kit-window z through the single authority when present, else
// the local fallback band. On a fallback renormalize the open stack is re-laid in
// order (mirroring OrwellZ's restack hook) so stacking order survives the wrap.
function nextWindowZ() {
  if (typeof window._owNextWindowZ === 'function') {
    return window._owNextWindowZ((apply) => apply(_stack.filter((w) => !w.o.modal).map((w) => w.el)));
  }
  if (_zFallback >= Z_CEIL) {
    _zFallback = Z_BASE;
    for (const w of _stack) { if (!w.o.modal && w.el) w.el.style.zIndex = String(++_zFallback); }
  }
  return ++_zFallback;
}

// ── opt-in modal tier (audit J1-25 / J1-23) ────────────────────────────────
// A kit window created with `modal:true` becomes a PROPER modal dialog: a backdrop
// scrim + a focus-trap + an inert background + aria-modal — the welcome-modal pattern
// (orwellOnboarding.js) generalized onto the kit, WITHOUT forcing it on the floating/
// lingering windows. This is exactly the "per-window `modal` option" the UX audit
// deferred J1-25 to (UX-AUDIT-LOG.md:191): the cast-photo dialog let focus escape into
// the chat and floated over live narration with no scrim. It sits at the modal tier
// (the legacy .modal family is 1000+): the scrim just under, the window just above, so
// a modal kit window clears the kit band (500-980) AND its own scrim.
const Z_MODAL_SCRIM = 1000;
const Z_MODAL = 1001;

// ── #870: the modal STACK manager (modal-over-modal coordination) ───────────
// A single modal was correct (J1-25/J1-23: scrim + inert + focus-trap + aria-modal).
// The gap (#870, a P1 lockup): two LIVE modals at once. The onboarding "Production
// needs the feeds" window is modal:true; its "Choose models" opens Settings, ALSO
// modal:true — so two modals were mounted together. Each one independently (1) inerted
// EVERY body child except its own el + scrim (so modal A inerted modal B → B is dead),
// and (2) drew a scrim at a shared fixed z — A's scrim could sit at/over B. Result:
// the second modal renders stacked/dimmed and is non-interactive (the lockup).
//
// The fix is ONE ordered modal stack the kit owns (bottom → top). On open a modal
// PUSHES; on close it POPS. From the stack we recompute, top-down:
//   • z: each modal's window draws a fresh monotonic modal z (via the single OrwellZ
//     authority), and its scrim sits one below — so a later modal is STRICTLY above an
//     earlier one (window + scrim both). No shared fixed z.
//   • inert: only the TOP modal is interactive. The page AND every lower modal go inert;
//     the top modal + its own scrim stay live. Inert is recomputed from the CURRENT top
//     on every push/pop, and each modal remembers ONLY the nodes IT set inert, so a pop
//     never un-inerts a node the new top still needs inert.
//   • focus: only the top modal traps focus; closing returns focus to the previous top.
// Single-modal behavior is byte-equivalent: with one modal the stack has one entry, the
// recompute inerts exactly "every body child except el + scrim" (the old all-or-nothing),
// the scrim/z land where they used to, and teardown un-inerts that same set.
const _modalStack = [];   // live modal OrwellWindow instances, bottom → top
// The exact set of nodes the kit has currently forced inert for the modal stack. Tracked
// HERE (not per-modal) so the inert state is always recomputed from the live TOP — a pop
// can never un-inert a node a lower modal still needs inert, because we recompute the whole
// set from scratch against the new top each time. Only nodes the kit itself set inert are
// ever released (a node that was already inert for another reason is left untouched).
const _modalInerted = new Set();

// ── #925: orphaned-scrim sweep (the modal scrim is the kit's exclusive node) ─
// A modal mounts a full-viewport backdrop `.ow-scrim` ([data-ow-scrim="<id>"]) in
// _mountModalChrome and removes it in _unmountModalChrome. The reported lockup (#925):
// a scrim can be left behind — its window torn down by a path that bypassed the kit's
// teardown, or a same-id modal collision desyncing the manager registry — and a lingering
// full-viewport scrim intercepts ALL pointer events, so the Settings gear and other modals
// become unclickable. The two flaky FE gates (test_h2b_all_model_pools /
// test_h2h3_settings) hit this: their converging dismiss+click loop can never converge while
// a scrim outlives its window.
//
// The kit creates scrims in EXACTLY one place (_mountModalChrome), one per modal instance, so
// a scrim is LEGITIMATE only while its owning modal is still a live stack entry. This sweep
// removes any `.ow-scrim` that is NOT the `_scrim` of a modal currently in _modalStack whose
// window element is still connected to the DOM — i.e. a genuinely orphaned scrim, never a live
// modal's. It is a no-op in the normal single-modal case (the one live scrim is kept). Called
// from _recomputeModalStack (every push/pop/raise) AND at the top of dismissTop, so an orphan
// is always swept on the next dismiss/recompute even if some teardown path missed it.
function _sweepOrphanScrims() {
  // The set of scrim nodes that genuinely belong to a live modal (on the stack + window connected).
  const live = new Set();
  for (const w of _modalStack) {
    if (w && w._scrim && w.el && w.el.isConnected) live.add(w._scrim);
  }
  // A NON-modal sheet-scrim (scrim:true) is NOT on the modal stack, so protect any live
  // registered window's scrim too — otherwise this sweep (which runs on every modal
  // recompute AND at the top of dismissTop) would wrongly reap a valid non-modal backdrop.
  // (_byId is the open-window registry; empty until the first open, so this is a no-op at load.)
  for (const w of _byId.values()) {
    if (w && w._scrim && w.el && w.el.isConnected) live.add(w._scrim);
  }
  let scrims;
  try { scrims = document.querySelectorAll('.ow-scrim, [data-ow-scrim]'); } catch (_) { return; }
  scrims.forEach((s) => {
    if (live.has(s)) return;                              // a live modal's scrim — never touch it
    try { s.remove(); } catch (_) {}                      // orphan: window gone (or never tracked) — sweep it
  });
}

// Recompute the inert + scrim/z layering for the WHOLE modal stack from its current order.
// The TOP modal (its window + its own scrim) is the ONLY interactive surface; the rest of
// the page AND every LOWER modal (window + scrim) go inert. Called on every push (open) and
// pop (close) so the live set always reflects the current top.
//
// Single-modal equivalence: with one modal in the stack, `keep` = {el, scrim}, so this
// inerts exactly "every top-level body child except the window + its scrim" — byte-identical
// to the old all-or-nothing `_inertBackground`.
function _recomputeModalStack() {
  // #925: drop any orphaned scrim FIRST so the inert/keep computation below never preserves a
  // dead scrim (and so a missed teardown is corrected on the very next recompute).
  _sweepOrphanScrims();
  const top = _modalStack[_modalStack.length - 1] || null;
  // 1. z/scrim layering: re-stamp every modal bottom → top so a later modal's window AND
  //    scrim sit strictly above an earlier one. raise() draws a fresh monotonic modal z and
  //    pins the scrim one below; iterating in stack order keeps the relative ordering.
  for (const w of _modalStack) { try { w._stampModalZ(); } catch (_) {} }
  // 2. inert: release the kit's previous inert set, then inert everything except the top
  //    modal's window + its own scrim. Recomputing from scratch is what makes this
  //    stack-aware — the new top's surface is the single thing left live.
  _modalInerted.forEach((n) => { try { n.inert = false; } catch (_) {} });
  _modalInerted.clear();
  if (!top) return;
  const keep = new Set([top.el, top._scrim].filter(Boolean));
  Array.from(document.body.children).forEach((n) => {
    if (keep.has(n) || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return;
    if (!n.inert) { try { n.inert = true; _modalInerted.add(n); } catch (_) {} }
  });
}

const REDUCED = () =>
  !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

// ── the one CSS family ────────────────────────────────────────────────────
// The window FRAME (bg / border / radius / shadow) and the titlebar TYPE
// (size / weight / tracking) come from the shared --win-* tokens defined
// once in style.css :root (Lane G4) — the SAME tokens the legacy modal
// family (.modal-content / .modal-header h4) consumes, so kit windows and
// the settings/theme/tool modals paint one visual language and per-theme
// overrides (the 0052 house presets, the frost layer) hit both families at
// once. The fallbacks below only cover style.css not having loaded. The
// titlebar COLOR stays var(--fg) by design — see the :root token note
// (the modal family's var(--red) header fails AA on some palettes).
function ensureCss() {
  if (document.getElementById('ow-window-css')) return;
  const st = document.createElement('style');
  st.id = 'ow-window-css';
  st.textContent = `
    .ow-window {
      position: fixed; z-index: ${Z_BASE};
      min-width: 180px; max-width: 64vw;
      background: var(--win-bg, var(--panel, #111)); color: var(--fg, #9cdef2);
      border: 1px solid var(--win-border, var(--border, #355a66));
      border-radius: var(--win-radius, 10px);
      box-shadow: var(--win-shadow, 0 8px 32px rgba(0,0,0,.45));
      /* Shared type system (#709): sans family + body PRESET for the window content. */
      font-family: var(--ow-ui-font); font-size: var(--ow-fs-body, .875rem); line-height: 1.45;
      /* NB (A6): do NOT clip the frost by hiding overflow on this root — combined with the
         10px border-radius it clips the rounded-corner pointer region and defeats the L11
         corner-resize grab (which arms 2px from the corner; CI browser-smoke caught it). The
         frosted-top cohesion instead rides the L34 frost rules in style.css: this .ow-window
         ROOT carries the single backdrop-filter, and the .ow-titlebar is transparent with NO
         filter of its own — so the whole window frosts as one continuous glass surface. (A6
         FIXED 2026-06-19: the titlebar previously carried its OWN backdrop-filter, which
         re-blurred the root's already-frosted glass and composited the top strip to a
         mismatched shade — the "frost breaks at the top" band. Never re-add a child filter or
         a blind overflow clip here.) */
    }
    /* #794 [THE fly-in fix]: kit windows own their GEOMETRY via the slot system, which
       writes inline left/top/width/height that must take effect INSTANTLY — on open it
       clamps + re-centres, on drag/resize it tracks the pointer, on a viewport change it
       re-anchors. A legacy .modal-family rule in style.css adds the kit ids settings-modal
       and theme-modal to a group carrying "transition: left .25s, width .25s" (meant to
       glide those modals with the sidebar collapse). That leaks onto these kit windows and
       turns the open-time re-anchor into a visible 0.25s SLIDE — the reported "fly in, then
       move to centre" two-step (the slot sets the centred left, the transition animates the
       element sliding to it). Kit geometry is never a transition: neutralise the
       left/top/width/height transitions on every .ow-window. The !important is required to
       beat the offending rule's ID specificity; it pins ONLY the geometry longhands — hover
       / focus / colour / scale transitions keep their own (non-geometry) timing. */
    .ow-window {
      transition-property: opacity, transform, background-color, border-color, box-shadow, backdrop-filter, -webkit-backdrop-filter !important;
    }
    /* L11: once a window carries an explicit height (the player resized it, or a
       persisted size was restored), let it become a flex column so the body
       grows to fill it instead of staying pinned to its content height. The
       windowResize helper sets inline width/height + maxWidth/maxHeight:none. */
    .ow-window.window-resizing, .ow-window[style*="height"] {
      display: flex; flex-direction: column;
    }
    .ow-window.window-resizing > .ow-body, .ow-window[style*="height"] > .ow-body {
      flex: 1 1 auto; max-height: none;
    }
    .ow-window.ow-focused {
      /* #729: the focused-window ring is NEUTRAL, never the theme red/accent (the glass chrome
         is colorless). A focused window reads via a brighter LUMINOUS rim + a deeper float
         shadow, not a hued border. (style.css refines the rim per glass tier under
         body.theme-frosted.) */
      border-color: color-mix(in srgb, #ffffff 38%, var(--win-border, var(--border, #355a66)));
      box-shadow: 0 12px 36px rgba(0,0,0,.5);
    }
    /* ── J1-25 / J1-23: the opt-in modal backdrop ─────────────────────────────
       Mounted behind a modal:true window. The dim restores figure/ground (the dialog
       is the figure, the page recedes — closing J1-04/J1-23 where the cast-photo card
       floated over live narration with no backdrop); with the focus-trap + inert
       background + aria-modal the JS adds, the window is a proper modal dialog.
       reduced-motion strips the fade. */
    .ow-scrim {
      position: fixed; inset: 0; z-index: ${Z_MODAL_SCRIM};
      background: var(--ow-scrim-bg, rgba(0,0,0,.55));
      animation: ow-scrim-in .18s ease-out;
    }
    @keyframes ow-scrim-in { from { opacity: 0; } to { opacity: 1; } }
    /* the scrim's reduced-motion strip rides the shared A7 block below (one @media) */
    .ow-titlebar {
      display: flex; align-items: center; gap: .4rem;
      padding: .45rem .55rem .35rem .7rem;
      cursor: move; user-select: none; -webkit-user-select: none;
      border-radius: var(--win-radius, 10px) var(--win-radius, 10px) 0 0;
    }
    /* #729: NEUTRAL focus ring (system-blue), never the theme red/accent — the glass chrome
       carries no accent HUE. (Matches the gadget-header ring; system-blue is the one sanctioned
       focus tint.) */
    .ow-titlebar:focus-visible { outline: 2px solid var(--ow-ios-blue, #0a84ff); outline-offset: -2px; }
    .ow-title {
      flex: 1; min-width: 0;
      font-size: var(--win-titlebar-fs, 1rem);
      font-weight: var(--win-titlebar-weight, 600);
      letter-spacing: var(--win-titlebar-ls, -0.03em);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ow-controls { display: flex; gap: 2px; flex-shrink: 0; }
    /* .ow-dismiss: non-window dismissible surfaces (strips, banners, panels —
       ruling-#3/#4-class chrome) adopt the SAME control affordance without
       becoming windows (audit F6 tail). */
    .ow-controls button, .ow-dismiss {
      min-width: 24px; min-height: 24px; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border: none; background: none; color: inherit; cursor: pointer;
      opacity: .6; border-radius: 6px; font: inherit; font-size: var(--fs-sm, .8rem);
    }
    .ow-controls button:hover, .ow-controls button:focus-visible,
    .ow-dismiss:hover, .ow-dismiss:focus-visible { opacity: 1; background: rgba(255,255,255,.08); }
    /* #911: the minimize control is ALWAYS rendered (the macOS cluster keeps its shape — see
       the build comment), but a non-minimizable window's disabled placeholder must NOT show its
       raw '–' glyph in the legacy (non-frosted) chrome — that bare en-dash read as a mystery
       "first button" on the setup wizard. The frosted theme greys it to a glyphless disc
       (style.css); here the legacy fallback simply hides the disabled placeholder so only
       functional controls render. (Scoped :not(.theme-frosted) so the frosted disc still shows.) */
    body:not(.theme-frosted) .ow-controls .ow-min[disabled] { display: none; }
    /* Same treatment for the (2026-07-16) greyed zoom/dock placeholder on a non-dockable
       window: the legacy/flat chrome never grew the constant-3-light macOS cluster (that
       treatment is frosted-only), so its disabled placeholder stays hidden too. */
    body:not(.theme-frosted) .ow-controls .ow-dock[disabled] { display: none; }
    /* Coarse-pointer (touch) sizing — Apple-proportionate titlebar chrome. The kit
       controls carry the tap-exempt class (set where they're built) so they ESCAPE the
       global responsive-tokens.css coarse floor (button:not(.tap-exempt) -> 44px), which
       otherwise inflates these dense titlebar glyph controls into 44px boxes that DOMINATE
       a ~44px titlebar (the owner-reported "giant buttons" on Settings/Theme). The titlebar
       row owns the spacing slop, so a 32px control is comfortably tappable WITHOUT
       ballooning — the proportionate middle between the 24px base (too small for touch) and
       the blanket 44px floor (titlebar-dominating). The frosted theme keeps its own
       12px-disc + invisible 44px ::after hit region (style.css, higher specificity). */
    @media (pointer: coarse) {
      .ow-controls button, .ow-dismiss { min-width: 32px; min-height: 32px; position: relative; }
      /* F-TOUCH-1 (HIG "Provide ample touch targets… at least 44×44 pt"): the VISIBLE
         titlebar control stays a proportionate 32px (no giant buttons dominating a ~44px
         titlebar — the #893 intent), but an invisible >=44px ::after extends the HIT area to
         the 44pt floor on coarse pointers. This mirrors the frosted traffic-light disc's own
         hit region (style.css body.theme-frosted .ow-controls button::after) into the
         legacy/non-frosted chrome, where the hit box otherwise stayed 32px. The frosted
         rule's higher specificity keeps owning the frosted theme; this closes the gap in the
         non-frosted theme. Appearance unchanged — only the tap target grows. */
      .ow-controls button::after, .ow-dismiss::after {
        content: ""; position: absolute; top: 50%; left: 50%;
        width: 44px; height: 44px; transform: translate(-50%, -50%);
      }
      /* CodeRabbit: each 32px control's centered 44px ::after overhangs its box by (44-32)/2 = 6px
         per edge. At the default 2px gap the adjacent 44px hit regions overlap by 10px, so a tap
         near a shared boundary resolves to whichever control is later in the DOM (close beats
         minimize → accidental close). Widen the coarse-pointer gap to >=12px (>= 2*6) so the 44px
         regions abut without intersecting. Visible 32px buttons + the 44px ::after are unchanged. */
      .ow-controls { gap: 12px; }
    }
    /* R4 (audit resp-F2): dvh tracks the dynamic (keyboard/URL-bar-shrunk) mobile viewport so a
       window's lowest controls don't fall below the fold when the soft keyboard opens; vh first
       as the fallback for engines without dvh. */
    .ow-body { padding: .4rem .7rem .6rem; overflow: auto; max-height: min(70vh, 560px); max-height: min(70dvh, 560px); }
    /* WCAG 2.1.1 (Keyboard): the scroll body is focusable (tabindex=0, set in _build) so a
       keyboard/SR user can Tab to it and use arrows/PageDown/Space to read non-interactive
       content below the fold. Ring matches the kit's neutral iOS-blue focus ring (titlebar). */
    .ow-body:focus-visible { outline: 2px solid var(--ow-ios-blue, #0a84ff); outline-offset: -2px; }
    /* ── A7 [ruling #19] — the Windows-7 fly-out family ───────────────────────
       The animation CONTRACT exposes DISTINCT minimize vs. close keyframes, both
       DRIVEN (not pure transitions) so the CSS itself names the two motions; the
       JS sets the fly vector via --ow-fly-x/-y. open keeps the E97 fade+scale.
       prefers-reduced-motion strips ALL of it (the @media block below). */
    @keyframes ow-open { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: scale(1); } }
    @keyframes ow-minimize {
      from { opacity: 1; transform: translate(0, 0) scale(1); }
      to   { opacity: 0; transform: translate(var(--ow-fly-x, 0), var(--ow-fly-y, 0)) scale(.12); }
    }
    @keyframes ow-close {
      from { opacity: 1; transform: scale(1); }
      to   { opacity: 0; transform: scale(.9); }
    }
    /* ow-restore is the MIRROR of ow-minimize: the window flies back IN from the
       dock chip (starts AT the dock — translated + scaled-down + faded) and lands
       at identity, so minimize↔restore read as one reversible motion (open↔close
       already mirror via ow-open/ow-close). Same fly-vector contract (--ow-fly-x/-y,
       set by _afterDockRestore to the dock delta); the keyframe owns the motion. */
    @keyframes ow-restore {
      from { opacity: 0; transform: translate(var(--ow-fly-x, 0), var(--ow-fly-y, 0)) scale(.12); }
      to   { opacity: 1; transform: translate(0, 0) scale(1); }
    }
    .ow-anim-open { animation: ow-open .18s ease-out; }
    /* pronounced Win7 easing on the minimize fly-out; a quicker fade on close */
    .ow-anim-minimize { animation: ow-minimize .27s cubic-bezier(.5,-0.2,.4,1) forwards; }
    .ow-anim-close { animation: ow-close .18s cubic-bezier(.45,.05,.55,.95) forwards; }
    /* the restore fly-IN mirrors the minimize fly-OUT (reversed easing/duration) */
    .ow-anim-restore { animation: ow-restore .27s cubic-bezier(.6,0,.5,1.2); }
    @media (prefers-reduced-motion: reduce) {
      .ow-anim-open, .ow-anim-minimize, .ow-anim-close, .ow-anim-restore, .ow-scrim { animation: none; }
    }
    /* ── 0054 Phase 2 — DOCKED kit mode ───────────────────────────────────────
       A docked window mounts its WHOLE element as a child of #gadget-rail-body
       (full-content "docked kit mode", not a compact summary). It opts OUT of the
       slot geometry system entirely: static flow position, no drag, no resize, no
       fixed z — so F5's ONE-position-system invariant holds (docked = NO geometry,
       never a second scheme). The rail owns visibility (content-driven), order
       (drag-reorder), collapse, and the single mobile drawer. The titlebar frost
       (L34) and the .ow-* chrome family ride along unchanged. */
    .ow-window.ow-docked {
      position: static !important; z-index: auto !important;
      width: auto !important; max-width: none !important; min-width: 0 !important;
      left: auto !important; top: auto !important; right: auto !important; bottom: auto !important;
      transform: none !important;
      margin: var(--space-2, .4rem) 0 0; box-shadow: none;
      display: flex; flex-direction: column;
    }
    .ow-window.ow-docked > .ow-titlebar { cursor: default; }
    /* #871: a NON-draggable window (modal:true centered dialogs, fixed/pinned panels — anything
       created with draggable:false) must NOT advertise the grab/move cursor on its titlebar: it
       lies, implying a drag that can't happen. The base .ow-titlebar carries cursor:move for the
       common draggable case; the kit stamps .ow-no-drag on the root when draggable is off
       (mirroring how the "Drag to move" tooltip is already gated in _build), so the titlebar falls
       back to the default cursor. (The docked rule above + the ≤768px rule below cover the OTHER
       non-draggable cases — a window that IS draggable but where context disables drag.) */
    .ow-window.ow-no-drag > .ow-titlebar { cursor: default; }
    .ow-window.ow-docked > .ow-body { max-height: none; }
    /* R2 (audit resp-F4): on the mobile sheet tier the kit drag is disabled (windowDrag mobileSkip
       768), so the titlebar must NOT advertise cursor:move — a dead affordance that lies on touch.
       The matching "Drag to move" tooltip is suppressed below the same threshold in JS (_build). */
    @media (max-width: 768px) {
      .ow-window:not(.ow-docked) > .ow-titlebar { cursor: default; }
      /* ── A8 (ship-blocker) — the narrow SHEET HOST must not be clipped ─────────
         orwellSlots.js's restackNarrowSheets() (audit F3: "the narrow tier is a SHEET
         HOST, not a stand-down") already writes left:0 / right:0 on every top-slotted
         kit window under this SAME breakpoint, stacking each one edge-to-edge full
         width. But this file's base .ow-window rule (above) carries the DESKTOP
         max-width: 64vw with no mobile override — CSS's abs-pos over-constraint
         resolution (left+width+right all non-auto) then keeps left and DISCARDS
         right, so every kit window rendered as a ~64vw sliver pinned to the left
         edge (theme picker: zero visible swatches; every other window: the same
         clipped sliver — a single root cause, audit 2026-06-11-dwe-window-audit.md).
         Relaxing max-width here lets the slot engine's edge-to-edge stretch actually
         resolve (no clamp, so no over-constraint: width becomes the full space
         between the left:0/right:0 anchors, deterministically — no property gets
         discarded). Docked windows are exempt (already max-width:none !important
         above; no side-margin geometry applies to rail-flow content). This is a
         KIT-level fix (orwellWindow.js ensureCss()) — every window composing
         OrwellWindow gets it for free, per the F-3 anti-fragmentation ratchet (no
         per-window CSS patches). Pinned: frontend/tests/test_a8_mobile_window_kit.py. */
      .ow-window:not(.ow-docked) {
        max-width: none; min-width: 0;
      }
    }
    /* ── #893 / #753: SHEET presentation mode (the phone tier) ────────────────
       On narrow viewports a kit window PRESENTS as an iOS-style bottom sheet —
       the same OrwellWindow instance, chrome, focus/aria semantics (modal scrim
       + stack + trap + focus-return all unchanged), with sheet GEOMETRY instead
       of the floating slot geometry: bottom-pinned, edge-to-edge, a grabber,
       medium/full detents, drag-between-detents and drag-to-dismiss. This is a
       PRESENTATION MODE of the ONE window kit (F-3 ratchet; avoid F-CHROME-1 II:
       never a parallel window family) — the visual/gesture language is kept in
       lock-step with the sibling OrwellSheet kit (orwellSheet.js, the non-window
       action-sheet surface). Sheet mode opts OUT of the slot/drag/resize
       geometry system entirely (F5: sheet = detent classes, never a second
       persisted-position scheme — no geometry key is ever written). */
    .ow-window.ow-sheet-mode {
      left: 0; right: 0; top: auto; bottom: 0;
      width: auto; max-width: none; min-width: 0;
      border-radius: var(--win-radius, 10px) var(--win-radius, 10px) 0 0;
      border-left: none; border-right: none; border-bottom: none;
      display: flex; flex-direction: column;
      box-shadow: 0 -10px 40px rgba(0,0,0,.5);
      /* safe-area: the home-indicator inset pads the sheet's own bottom so the
         lowest controls stay reachable above the gesture bar (#893). */
      padding-bottom: env(safe-area-inset-bottom, 0px);
      overflow: hidden;
    }
    /* Detents — class-owned heights (dvh tracks the keyboard/URL-bar-shrunk mobile
       viewport; vh first as the fallback). Kept in lock-step with sheetDetentPx()
       below and with orwellSheet.js's DETENT_FRACTION (medium = 0.52 — the SAME
       fraction, so the window-sheet and the action-sheet rise to the same height;
       CodeRabbit #1378). The full detent clears the notch (safe-area-inset-top). */
    .ow-window.ow-sheet-mode.ow-detent-medium { height: min(52vh, 640px); height: min(52dvh, 640px); }
    .ow-window.ow-sheet-mode.ow-detent-full {
      height: calc(100vh - 16px);
      height: calc(100dvh - max(env(safe-area-inset-top, 0px), 16px));
    }
    /* Scroll containment: the body scrolls INSIDE the sheet; overscroll never
       chains into (or rubber-bands) the page behind it. */
    .ow-window.ow-sheet-mode > .ow-body {
      flex: 1 1 auto; max-height: none; overflow: auto;
      overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
    }
    /* The grabber — the iOS pill. A small visible pill inside a 44px invisible
       hit region (WCAG 2.5.5), the primary detent-drag handle. aria-hidden: it is
       a touch affordance; keyboard/AT users dismiss via the titlebar × / Escape. */
    .ow-window.ow-sheet-mode > .ow-grabber {
      flex: 0 0 auto; position: relative; min-height: 22px; padding-top: 8px;
      display: flex; align-items: flex-start; justify-content: center;
      cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
    }
    .ow-window.ow-sheet-mode > .ow-grabber:active { cursor: grabbing; }
    .ow-window.ow-sheet-mode > .ow-grabber span {
      display: block; width: 38px; height: 5px; border-radius: 3px;
      background: color-mix(in srgb, var(--fg, #9cdef2) 38%, transparent);
    }
    .ow-window.ow-sheet-mode > .ow-grabber::after {
      content: ""; position: absolute; left: 0; right: 0; top: 0; height: 44px;
    }
    /* The titlebar doubles as a drag handle (touch-action:none so the gesture is
       ours); no move cursor — the sheet has no XY drag. Square its bottom radius
       against the sheet's flat body. */
    .ow-window.ow-sheet-mode > .ow-titlebar { cursor: default; touch-action: none; }
    /* 1:1 with the finger while dragging (kills every transition), then a short
       height glide on release to the settled detent. The settle rule must out-rank
       the base .ow-window transition-property pin (#794) — two classes + !important. */
    .ow-window.ow-sheet-mode.ow-sheet-dragging { transition: none !important; }
    .ow-window.ow-sheet-mode.ow-sheet-settling {
      transition-property: height !important;
      transition-duration: .26s; transition-timing-function: cubic-bezier(.32,.72,0,1);
    }
    /* Entrance/exit: the slide-up rise + slide-down dismiss (reduced-motion strips
       both in the shared @media block below — instant mount/unmount). */
    @keyframes ow-sheet-mode-in { from { transform: translateY(100%); } to { transform: translateY(0); } }
    @keyframes ow-sheet-mode-out { from { transform: translateY(0); } to { transform: translateY(100%); } }
    .ow-anim-sheet-in { animation: ow-sheet-mode-in .32s cubic-bezier(.32,.72,0,1); }
    .ow-anim-sheet-out { animation: ow-sheet-mode-out .24s cubic-bezier(.4,0,1,1) forwards; }
    @media (prefers-reduced-motion: reduce) {
      .ow-anim-sheet-in, .ow-anim-sheet-out { animation: none; }
      .ow-window.ow-sheet-mode.ow-sheet-settling { transition: none !important; }
    }
    /* BL-046 (frosted mobile sheet content-ready gate): on the frosted GLASS theme a
       freshly-mounted sheet can present an EMPTY translucent body for a beat while the
       backdrop-filter composites and the content paints (audit: ≥1.2s of blank body;
       live-repro owed). Hold the body invisible until the open path clears the
       "ow-sheet-content-pending" flag (removed on the next painted frame, with a hard
       timeout fallback so it can NEVER stay hidden), then fade it in. Scoped to the
       FROSTED sheet body only — the flat sheet (verified correct, "sheets done right")
       is untouched; reduced-motion snaps instead of fading. */
    body.theme-frosted .ow-window.ow-sheet-mode.ow-sheet-content-pending > .ow-body { opacity: 0; }
    body.theme-frosted .ow-window.ow-sheet-mode > .ow-body { transition: opacity .18s ease; }
    @media (prefers-reduced-motion: reduce) {
      .ow-window.ow-sheet-mode > .ow-body { transition: none !important; }
    }
    /* the dock/undock toggle reads as a quieter control than min/close */
    .ow-controls .ow-dock { font-size: .9rem; }
    /* ── loading affordance (perf/resilience) ─────────────────────────────────
       A NON-blocking refresh indicator the kit owns: a window opens IMMEDIATELY
       with its last-good (or placeholder) content and shows a thin top progress
       sliver + a quiet titlebar "·refreshing" hint while a slow /state fill is in
       flight — never a blank 30-45s hang. Purely additive overlay: it never hides
       the body, so a reused last-good snapshot stays visible underneath. reduced-
       motion stills the sliver to a static tint. */
    .ow-window.ow-loading > .ow-body { position: relative; }
    .ow-window.ow-loading > .ow-body::before {
      content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px;
      background: linear-gradient(90deg,
        transparent, var(--accent, #e06c75) 40%, var(--accent, #e06c75) 60%, transparent);
      background-size: 240% 100%; animation: ow-load-sweep 1.1s linear infinite;
      pointer-events: none; z-index: 2;
    }
    /* The hint is visible UI text, so it keeps the --fs-2xs floor (~11px): .7em of a 13px title was 9.1px, and the responsive
       matrix's crowding sweep failed whenever a slow fill (>200ms, TRANS-10) put the hint on screen at capture time (ORW-229). */
    .ow-title .ow-load-hint {
      margin-left: .4rem; font-size: max(.7em, var(--fs-2xs, .6875rem)); font-weight: 400; opacity: .55;
      letter-spacing: 0; white-space: nowrap;
    }
    @keyframes ow-load-sweep {
      from { background-position: 120% 0; } to { background-position: -120% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      .ow-window.ow-loading > .ow-body::before {
        animation: none; background: var(--accent, #e06c75); opacity: .5;
      }
    }
  `;
  document.head.appendChild(st);
}

// #758: a top system-banner (orwellNotice.js, position:fixed) reserves its height on <body> as
// --on-banner-inset. Kit windows are position:fixed, so the body padding-top can't move them — the
// kit consumes the inset directly: the clamp top floor starts BELOW the banner and the window's
// max-height shrinks by it, so a top-slotted window sits under the banner AND the stack COMPRESSES
// into the remaining viewport (it never runs off the bottom). Read live (default 0); the banner
// broadcasts orwell:banner-inset, which re-runs the global re-clamp below.
function bannerInset() {
  try {
    const v = parseFloat(getComputedStyle(document.body).getPropertyValue('--on-banner-inset'));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (_) { return 0; }
}

// Explicit viewport clamp (audit note on norm c: never rely on cursor physics).
function clampPos(left, top, w, h) {
  const margin = 4;
  const topFloor = margin + bannerInset();  // #758: never clamp a window UP under a top banner
  return {
    left: Math.max(margin, Math.min(window.innerWidth - Math.max(w, 60) - margin, left)),
    top: Math.max(topFloor, Math.min(window.innerHeight - Math.min(h, 200) - margin, top)),
  };
}

function flyTargetRect() {
  // Where minimize flies to: the window's own dock chip if rendered, else the
  // dock, else the sidebar's bottom corner (the dock's home).
  const dock = document.getElementById('minimized-dock');
  if (dock && dock.getBoundingClientRect().height > 0) return dock.getBoundingClientRect();
  const sb = document.getElementById('sidebar');
  if (sb) { const r = sb.getBoundingClientRect(); return { left: r.left + 16, top: r.bottom - 48, width: 32, height: 24 }; }
  return { left: 16, top: window.innerHeight - 48, width: 32, height: 24 };
}

// ── #893: sheet-mode detent geometry (the phone tier) ──────────────────────
// The px height a named detent resolves to RIGHT NOW — used by the drag-release
// settle logic; the resting heights are class-owned in ensureCss() (dvh-based)
// and these MUST stay in lock-step with those rules (and with orwellSheet.js's
// DETENT_FRACTION, so the window-sheet and the action-sheet feel identical).
// visualViewport tracks the keyboard/URL-bar-shrunk mobile viewport when present.
function sheetVh() {
  try {
    if (window.visualViewport && window.visualViewport.height) return window.visualViewport.height;
  } catch (_) {}
  return window.innerHeight || document.documentElement.clientHeight || 600;
}
// The resolved top safe-area inset (notch), so the JS settle target for the FULL
// detent lands exactly where the class-owned CSS height (100dvh − max(inset, 16px))
// will rest — a flat 16px would OVERSHOOT on notched phones and visibly snap back
// when the class takes over (CodeRabbit #1378). env() is only resolvable through
// the style system, so read it off a hidden probe once and cache; the cache is
// invalidated on viewport resize (rotation moves the notch).
let _safeTopPx = -1;
function safeAreaTopPx() {
  if (_safeTopPx >= 0) return _safeTopPx;
  let v = 0;
  try {
    const p = document.createElement('div');
    p.style.position = 'fixed';
    p.style.top = '0';
    p.style.left = '0';
    p.style.width = '0';
    p.style.pointerEvents = 'none';
    p.style.visibility = 'hidden';
    p.style.height = 'env(safe-area-inset-top, 0px)';
    document.documentElement.appendChild(p);
    v = p.getBoundingClientRect().height || 0;
    p.remove();
  } catch (_) { v = 0; }
  _safeTopPx = v;
  return v;
}
function sheetDetentPx(name) {
  const h = sheetVh();
  // full: 100dvh − max(safe-area-inset-top, 16px) — mirrors the .ow-detent-full rule.
  if (name === 'full') return Math.max(220, h - Math.max(16, safeAreaTopPx()));
  // medium: the SAME 0.52 fraction as orwellSheet.js's DETENT_FRACTION.medium (lock-step),
  // capped at the CSS rule's 640px.
  return Math.max(220, Math.min(Math.round(h * 0.52), 640));
}
// Drag-to-dismiss: released below (1 - this fraction) of the medium detent →
// dismiss instead of snapping back (same threshold as orwellSheet.js).
const SHEET_DISMISS_FRACTION = 0.4;

// ── parked-state persistence (G5 refresh-persistence audit F2 / Lane G16) ──
// Parked means parked: modalManager's minimized registry is in-memory, so a
// refresh used to snap every parked window back open (and lose its dock
// chip). The kit persists a per-window parked flag — keyed per user,
// mirroring the slot-offset scheme ('orwell-slot-offset:<key>:<user>') —
// set on minimize(), cleared on a dock restore and on close/teardown.
// open() consults it and mounts a previously-parked window DIRECTLY into
// the dock (chip rendered, panel hidden, no open animation — no flash, no
// raise, no focus steal).
function parkedKey(id) {
  // R5/#1416b: per-user via the shared fail-closed helper — 'orwell-win-parked:<id>:<user>' when
  // there is an identity (or ':local' under an explicit no-auth signal), else null so the caller
  // SKIPS persistence rather than sharing a namespace across users.
  return (window.orwellUserKey && window.orwellUserKey('orwell-win-parked:' + id)) || null;
}
function loadParked(id) {
  var k = parkedKey(id);
  try { return !!k && localStorage.getItem(k) === '1'; } catch (_) { return false; }
}
function saveParked(id, on) {
  var k = parkedKey(id);
  if (!k) return;                       // no identity ⇒ skip (never a shared-namespace write)
  try {
    if (on) localStorage.setItem(k, '1');
    else localStorage.removeItem(k);
  } catch (_) {}
}

// ── docked-state persistence (0054 Phase 2) ───────────────────────────────
// Per-window, per-user — mirroring orwellCastPin's 'orwell-cast-pinned:<user>'
// key pattern so docked-vs-floating survives a reload exactly like the rail's
// other persisted layout. Default is floating unless `defaultDocked` flips it.
function dockedKey(id) {
  // R5/#1416b: per-user via the shared fail-closed helper — 'orwell-<id>-docked:<user>' (or
  // ':local' under an explicit no-auth signal), else null so the caller SKIPS persistence.
  return (window.orwellUserKey && window.orwellUserKey('orwell-' + id + '-docked')) || null;
}
function loadDocked(id, dflt) {
  const k = dockedKey(id);
  try {
    const v = k && localStorage.getItem(k);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch (_) {}
  return !!dflt;
}
function saveDocked(id, on) {
  const k = dockedKey(id);
  if (!k) return;                       // no identity ⇒ skip (never a shared-namespace write)
  try { localStorage.setItem(k, on ? '1' : '0'); } catch (_) {}
}

// ── 0064 Part F: cross-device layout sync ──────────────────────────────────
// A live registry of open kit windows by id, so a remote layout change (from
// another of the user's devices, delivered via the canonical session's SSE
// channel → orwellLayoutSync.js) can be applied to the matching window. Capture
// works the other way: each local geometry/state change emits an
// `orwell:window-layout` CustomEvent that orwellLayoutSync debounces into a
// PATCH /api/orwell/layout. Self-echo is suppressed both by an `origin` token
// (in the sync module) and by the `_applyingRemote` guard here (so applying a
// remote change never re-emits it). Fail-open everywhere: with the sync module
// absent, the kit behaves exactly as before (localStorage-only).
const _byId = new Map();

function emitWindowLayout(id, state) {
  if (!id || !state) return;
  try { window.dispatchEvent(new CustomEvent('orwell:window-layout', { detail: { id, state } })); } catch (_) {}
}

// The seam orwellLayoutSync calls to apply a remote change to a live window.
function applyRemoteLayout(id, state) {
  const w = _byId.get(id);
  if (w && typeof w._applyLayout === 'function') { w._applyLayout(state); return true; }
  return false;
}
try { window._orwellApplyRemoteLayout = applyRemoteLayout; } catch (_) {}

// Seed a synced layout (from another device, via orwellLayoutSync) into the kit. The kit owns its
// OWN persistence keys (audit F5 / the F-3 ratchet: ONE position system) — so the geometry/state
// keys are written HERE, through the kit's existing helpers, never minted by the sync module. We
// pre-write min/dock/size so the kit's existing restore lands them at first mount, stash the blob
// for seed-on-open, and apply to any already-open window now.
function seedLayout(windows) {
  const w = windows || {};
  try { window._orwellLayoutSeed = window._orwellLayoutSeed || {}; } catch (_) {}
  Object.keys(w).forEach((id) => {
    const st = w[id] || {};
    try { window._orwellLayoutSeed[id] = Object.assign(window._orwellLayoutSeed[id] || {}, st); } catch (_) {}
    if (typeof st.minimized === 'boolean') saveParked(id, st.minimized);   // kit's own parked key
    if (typeof st.docked === 'boolean') saveDocked(id, st.docked);         // kit's own docked key
    if (typeof st.w === 'number' && typeof st.h === 'number') {
      try { localStorage.setItem('winsize-' + id, JSON.stringify({ w: Math.round(st.w), h: Math.round(st.h) })); } catch (_) {}
    }
    applyRemoteLayout(id, st);  // a live window catches up immediately
  });
}
try { window._orwellSeedLayout = seedLayout; } catch (_) {}

export class OrwellWindow {
  /**
   * opts: { id, title, icon, slot='top-right', slotKey=null, role='complementary',
   *         draggable=true, minimizable=true, closable=true, resizable=true,
   *         minWidth=240, minHeight=160,
   *         content (Node|string), focus=false, onClose, onMinimize, onRestore,
   *         dockable=false, defaultDocked=false, onDock, sheet='auto', scrim=false }
   *
   * 0054 Phase 2 — DOCKED kit mode. A `dockable` window renders a dock/undock
   * toggle in its titlebar and persists the choice per user (`orwell-<id>-docked:
   * <user>`). Docked, the whole window mounts as a child of `#gadget-rail-body`
   * (full-content "docked kit mode"): NO position:fixed, NO drag, NO resize, NO
   * slot-key (it OPTS OUT of the slot-offset geometry system — F5's one-position-
   * system invariant holds: docked = no geometry, never a second scheme), and NO
   * minimize-to-dock (the rail owns visibility/order/collapse/mobile-drawer). The
   * default is FLOATING (set `defaultDocked:true` to flip — a one-line owner choice).
   *
   * L11: every kit window is user-resizeable from any EDGE and any CORNER on
   * desktop (the shared windowResize helper — edge-proximity grips, not injected
   * handles), with the chosen size persisted per window under the kit's one
   * `winsize-<id>` key (the same clamped scheme the settings/tool modals use).
   * Mobile (≤768px, the sheet/drawer tier) skips edge-resize by design — the
   * sheet host owns the geometry there. Opt a window out with resizable:false.
   *
   * #893 / #753 — SHEET presentation mode (`sheet: 'auto'|true|false`, default
   * 'auto'). On the narrow tier a kit window PRESENTS as an iOS-style bottom
   * sheet: bottom-pinned + edge-to-edge, a grabber, medium/full detents
   * (drag-between, `setDetent()`/`currentDetent()`), drag-to-dismiss (closable
   * windows only), safe-area insets, slide-up/-down motion, and scroll
   * containment on the body — while the window SEMANTICS are unchanged (the
   * same modal scrim/stack/focus-trap/aria-modal, Escape via the ui.js arbiter,
   * focus-return, minimize-to-dock, onClose). 'auto' sheets exactly the
   * modal:true dialogs; `sheet:true` opts a non-modal window in (the Cast
   * roster); `sheet:false` forbids it. Sheet mode opts OUT of slot/drag/resize
   * geometry entirely (F5: the detent classes own the height — no geometry key
   * is ever minted), and crossing the breakpoint re-homes the window through
   * the same teardown+rebuild hinge the dock toggle uses.
   *
   * `scrim` (default false) — a NON-modal sheet may mount the sheet's dimming
   * backdrop (the shared `.ow-scrim`) with `scrim:true` while staying non-modal
   * (no aria-modal / focus-trap / inert background / modal z-tier): the backdrop
   * rides one z BELOW the sheet window. Only honored while presenting as a sheet
   * (the narrow tier). A modal window's scrim is implied by modal:true.
   */
  constructor(opts) {
    // A modal:true dialog (settings, etc.) must CENTER, not pin to the top-right HUD
    // slot — opening a scrim'd dialog flush against the right edge reads as a "snap
    // to the right" bug. Non-modal HUD windows keep the top-right default. An explicit
    // `slot` in opts still wins (e.g. the headshot dialog passes top-center itself).
    const _defaultSlot = (opts && opts.modal) ? 'top-center' : 'top-right';
    this.o = Object.assign({ slot: _defaultSlot, role: 'complementary',
      draggable: true, minimizable: true, closable: true, resizable: true,
      minWidth: 240, minHeight: 160, focus: false,
      // persistLayout (default true): a window's geometry rides the 0064 cross-device layout sync
      // AND is re-applied from the seed on open. A transient one-shot dialog (the OOBE cast-photo
      // box, audit D1) sets it false so it ALWAYS re-centers — never carrying a dragged offset
      // across reloads or devices for the season.
      persistLayout: true,
      // #893: SHEET presentation on the narrow tier. 'auto' (default) → a modal:true
      // dialog presents as a bottom sheet on phones; true → this window sheets on
      // narrow even when non-modal (the Cast window opts in); false → never sheets.
      sheet: 'auto',
      // scrim (default false): a NON-modal sheet may opt into the sheet's dimming backdrop
      // (the shared .ow-scrim) with scrim:true — the scrim mounts, but the window STAYS
      // non-modal: no aria-modal, no focus-trap, no inert background, no modal z-tier. The
      // backdrop just rides one z below the sheet window (raise() layers it) so the sheet is
      // never covered by its own dim. Only honored while the window presents AS a sheet (the
      // narrow tier) — see the `this._sheet && this.o.scrim` gate in open(). A modal window's
      // scrim is implied by modal:true (the full modal chrome), so scrim is redundant there.
      scrim: false,
      dockable: false, defaultDocked: false, modal: false }, opts);
    if (!this.o.id || !this.o.title) throw new Error('OrwellWindow needs id + title');
    this.ac = new AbortController();
    this.opener = null;
    this.el = null;
    this._slot = null;
    // 0054 Phase 2: docked-vs-floating is resolved per OPEN (the toggle close()s
    // then open()s, so the kit rebuilds in the chosen mode). Seed from persistence.
    this._docked = this.o.dockable && loadDocked(this.o.id, this.o.defaultDocked);
    // #893: sheet-vs-floating is ALSO resolved per open (open() re-resolves, and the
    // narrow-breakpoint listener re-homes a live window when the tier flips).
    this._sheet = this._resolveSheet();
  }

  /** #893: does THIS window present as a bottom sheet right now? A per-open
   *  decision, like docked-vs-floating — never a live geometry mutation. Docked
   *  wins (the rail owns docked placement); otherwise sheet mode requires the
   *  narrow tier, then: `sheet:true` forces it, `sheet:false` forbids it, and
   *  the 'auto' default sheets exactly the modal dialogs (Settings/Theme/the
   *  casting box), leaving non-modal HUD panels on the slot engine's existing
   *  narrow sheet host (orwellSlots.js restackNarrowSheets) unless they opt in. */
  _resolveSheet() {
    if (this._docked) return false;
    if (!isNarrow()) return false;
    if (this.o.sheet === true) return true;
    if (this.o.sheet === false) return false;
    return !!this.o.modal;
  }

  _build() {
    ensureCss();
    const docked = this._docked;
    const sheet = !docked && this._sheet;   // #893: sheet presentation (phone tier)
    const el = document.createElement('div');
    el.id = this.o.id;
    // #871: a non-draggable, non-docked window (e.g. a centered modal:true dialog) carries
    // .ow-no-drag so its titlebar drops the grab/move cursor (a docked window is already covered
    // by .ow-docked). Gated on the same `draggable` flag that suppresses the "Drag to move" tooltip.
    el.className = 'ow-window' + (docked ? ' ow-docked' : '') + (this.o.draggable ? '' : ' ow-no-drag')
      + (sheet ? ' ow-sheet-mode ow-detent-medium' : '');
    el.setAttribute('data-ow-window', '');
    if (docked) el.setAttribute('data-ow-docked', '');
    if (sheet) { el.setAttribute('data-ow-sheet-mode', ''); el.dataset.owDetent = 'medium'; }
    // J1-25: a modal window is a dialog whose background it PROMISES is inert (the
    // aria-modal contract) — default the role up to 'dialog' and stamp aria-modal.
    const role = (this.o.modal && this.o.role === 'complementary') ? 'dialog' : this.o.role;
    el.setAttribute('role', role);
    el.setAttribute('aria-label', this.o.title);
    if (this.o.modal) el.setAttribute('aria-modal', 'true');
    // #837: the root is the SPAWN/focus-trap target (focused on mount so AT/keyboard
    // users land inside the new window) — tabindex=-1 keeps it OUT of the Tab order and
    // the global .ow-window:focus rule keeps it ring-free. The keyboard ring lives on the
    // titlebar (tabindex=0) which a Tab user genuinely reaches.
    el.setAttribute('tabindex', '-1');
    const tb = document.createElement('div');
    tb.className = 'ow-titlebar';
    tb.setAttribute('tabindex', '0');
    // R2 (audit resp-F4): below the mobileSkip (768) tier the drag is disabled, so don't advertise
    // "Drag to move" — it would lie on touch (the cursor:move is suppressed by the matching media
    // query). A window born wide and resized narrow keeps the tooltip; the cursor still corrects.
    tb.title = (this.o.draggable && !docked && !isNarrow()) ? 'Drag to move · arrows to nudge' : '';
    // F-A11Y-4 (HIG "don't rely on hover-only cues"): the keyboard-move ("arrows to nudge")
    // affordance was carried ONLY by `title=`, which never surfaces on touch and is unreliable
    // for AT. Expose the move keys through aria-keyshortcuts — the well-supported ARIA attribute
    // built for exactly this (unlike draft aria-description; see orwellSeasonProgress.js J4-14) —
    // so the affordance reaches the accessibility tree, not just a desktop hover tooltip. Gated
    // on the same keyboard-move availability (floating + draggable) that _onTitlebarKey acts on;
    // Home (restack) is only advertised when the window is slotted, matching that handler.
    // (#893: a sheet has no XY move — no keyboard-move affordance to advertise.)
    if (this.o.draggable && !docked && !sheet) {
      let keys = 'ArrowUp ArrowDown ArrowLeft ArrowRight';
      if (this.o.slotKey) keys += ' Home';
      tb.setAttribute('aria-keyshortcuts', keys);
    }
    const title = document.createElement('span');
    title.className = 'ow-title';
    title.textContent = this.o.title;
    const controls = document.createElement('div');
    controls.className = 'ow-controls';
    // 0054 Phase 2: the dock/undock toggle. It flips the persisted flag and re-opens in
    // the other mode — ONE position system, so a mode change is a teardown + rebuild,
    // never a live geometry mutation.
    // macOS traffic-light cluster (frosted theme): close=red + minimize=yellow + a THIRD
    // (green) light, ALWAYS rendered so the cluster keeps its authentic constant 3-light
    // shape (real macOS renders inert lights GREYED, never omits them — corpus README).
    // On a DOCKABLE window the green light is the real, functional dock/undock toggle. On
    // a NON-dockable window it is an inert, greyed, glyphless placeholder (the "zoom"
    // slot — mirrors the yellow minimize light's own disabled-placeholder pattern below).
    // The kit's non-frosted glyph fallback hides BOTH disabled placeholders via CSS
    // (`body:not(.theme-frosted) .ow-controls button[disabled]`), so the legacy look
    // still shows only functional controls — this three-light treatment is frosted-only.
    {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ow-dock tap-exempt';
      if (this.o.dockable) {
        const docked = this._docked;
        b.setAttribute('aria-label', docked ? 'Float this window' : 'Dock to the control room');
        b.title = docked ? 'Float (undock from the control room)' : 'Dock to the control room';
        b.textContent = docked ? '⇱' : '⇲';  // undock (pop out) vs. dock (tuck in)
        b.addEventListener('click', (e) => { e.stopPropagation(); this.toggleDock(); }, { signal: this.ac.signal });
      } else {
        b.setAttribute('aria-label', 'Zoom (unavailable)');
        b.title = '';
        b.disabled = true;
      }
      controls.appendChild(b);
    }
    // Minimize-to-dock is a FLOATING affordance; a docked window lives in the rail
    // and never minimizes to the chip dock (the rail owns its visibility/collapse).
    // The YELLOW light is ALWAYS rendered so the cluster keeps its shape — a
    // non-minimizable window just gets a greyed/inert yellow disc.
    const canMin = this.o.minimizable && !this._docked;
    {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ow-min tap-exempt';
      b.setAttribute('aria-label', canMin ? 'Minimize' : 'Minimize (unavailable)');
      b.title = canMin ? 'Minimize' : '';
      b.textContent = '–';
      if (!canMin) { b.disabled = true; }
      else { b.addEventListener('click', (e) => { e.stopPropagation(); this.minimize(); }, { signal: this.ac.signal }); }
      controls.appendChild(b);
    }
    if (this.o.closable) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ow-close tap-exempt';
      b.setAttribute('aria-label', 'Close'); b.title = 'Close';
      b.textContent = '×';
      b.addEventListener('click', (e) => { e.stopPropagation(); this.close(); }, { signal: this.ac.signal });
      controls.appendChild(b);
    }
    // NB (superseded 2026-07-16, Apple Genius rendered-parity G-nit): the green/zoom light was
    // PREVIOUSLY omitted entirely on non-dockable windows (owner ruling: it crowded the centered
    // title at thin widths and was inert everywhere no window opted it on). Real macOS never
    // omits an inert light — it greys it — so the cluster now ALWAYS renders three lights (built
    // above): a functional green dock toggle on dockable windows, a greyed inert placeholder
    // otherwise. The thin-width crowding concern doesn't reapply — the greyed disc carries no
    // glyph text to widen the cluster, identical footprint to the functional green light.
    tb.appendChild(title); tb.appendChild(controls);
    const body = document.createElement('div');
    body.className = 'ow-body';
    // WCAG 2.1.1 (Keyboard): .ow-body is overflow:auto with a max-height, so when its content is
    // non-interactive (Memory Wall, Retrospective, Deals…) a keyboard-only / SR user has no way to
    // scroll below the fold. tabindex=0 lets Tab land on it (native arrow/PageDown/Space scroll)
    // and — since _trapFocus's query already matches [tabindex] — folds it into the focus trap.
    // role=region + a title-derived label names it in the accessibility tree.
    body.setAttribute('tabindex', '0');
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', this.o.title ? this.o.title + ' content' : 'panel content');
    if (this.o.content instanceof Node) body.appendChild(this.o.content);
    else if (typeof this.o.content === 'string') body.innerHTML = this.o.content;
    // #893: the sheet grabber — the iOS pill above the titlebar (44px hit region in
    // CSS). aria-hidden: it is the TOUCH detent handle; keyboard/AT flows keep the
    // titlebar ×/Escape. Both the grabber and the titlebar drive the detent drag.
    let grab = null;
    if (sheet) {
      grab = document.createElement('div');
      grab.className = 'ow-grabber';
      grab.setAttribute('aria-hidden', 'true');
      grab.innerHTML = '<span></span>';
      el.appendChild(grab);
    }
    el.appendChild(tb); el.appendChild(body);
    this.el = el; this.titlebar = tb; this.body = body;

    // 0054 Phase 2: a docked window opts OUT of drag, resize, slot geometry, the
    // raise/z-band, and the keyboard-move handler — it is static rail flow, and the
    // rail owns its placement. Everything below the guard is FLOATING-only chrome.
    if (docked) return el;

    // click-to-front (capture so any inner click raises first) — audit F9
    el.addEventListener('pointerdown', () => this.raise(), { capture: true, signal: this.ac.signal });

    // keyboard move / resize / re-dock on the titlebar — audit F10
    tb.addEventListener('keydown', (e) => this._onTitlebarKey(e), { signal: this.ac.signal });

    // #893: sheet mode wires the DETENT drag (grabber + titlebar) and opts OUT of
    // the floating XY drag + edge-resize entirely — the sheet owns its geometry
    // (F5: no slot, no persisted offset, no winsize write in sheet mode).
    if (sheet) {
      this._wireSheetDrag(grab);
      this._wireSheetDrag(tb);
      return el;
    }
    if (this.o.draggable) {
      makeWindowDraggable(el, {
        content: el, header: tb,
        enableDock: false, enableFullscreen: false, enableResize: false,
        skipSelector: 'button, input, select, textarea',
        onDragEnd: ({ rect }) => this._persist(rect),
      });
    }
    // (resize capture for 0064 is wired in the makeWindowResizable call below)
    // L11: pointer edge/corner resize from the kit — every .ow-* window inherits
    // it (sane min/max, clamped to the viewport, persisted under winsize-<id>).
    // mobileSkip 768 keeps the sheet/drawer tier untouched. Its capture-phase
    // mousedown pre-empts the titlebar drag only when the grab lands on a border.
    if (this.o.resizable) {
      makeWindowResizable(el, {
        mobileSkip: 768,
        minWidth: this.o.minWidth, minHeight: this.o.minHeight,
        storageKey: 'winsize-' + this.o.id,
        isLocked: () => this.isMinimized(),
        // 0064: capture a user resize for cross-device sync (suppressed while APPLYING a remote one).
        onResizeEnd: ({ rect }) => {
          if (this._applyingRemote) return;
          this._emit({ w: Math.round(rect.width), h: Math.round(rect.height) });
        },
      });
    }
    return el;
  }

  /** 0064/D1: emit a layout change for cross-device sync — suppressed while APPLYING a remote
   *  change (no echo loop) AND when this window opts OUT of layout persistence (`persistLayout:
   *  false` — a transient one-shot dialog that must always re-center). One funnel for every site. */
  _emit(state) {
    if (this._applyingRemote || this.o.persistLayout === false) return;
    emitWindowLayout(this.o.id, state);
  }

  _persist(rect) {
    // ONE scheme: the slot offset, clamped at restore (S11). Clamp at SAVE too.
    const c = clampPos(rect.left, rect.top, rect.width, rect.height);
    if (c.left !== rect.left || c.top !== rect.top) {
      this.el.style.left = c.left + 'px'; this.el.style.top = c.top + 'px';
      rect = this.el.getBoundingClientRect();
    }
    // D1: a non-persistent dialog (persistLayout:false) carries no slot key, so saveDragOffset is a
    // no-op for it — it re-centers on the next restack instead of remembering a dragged offset.
    if (this._slot) this._slot.saveDragOffset(rect);
    // 0064: capture the new position for cross-device sync (gated by _emit).
    this._emit({ x: Math.round(rect.left), y: Math.round(rect.top) });
  }

  /** 0064: apply a layout change that arrived from another of the user's devices. Sets
   *  `_applyingRemote` so the resulting state changes don't re-emit (no echo loop). Floating
   *  geometry only (docked windows have no geometry — F5). Fail-open; never throws. */
  _applyLayout(state) {
    if (!state || typeof state !== 'object') return;
    this._applyingRemote = true;
    try {
      if (typeof state.docked === 'boolean' && this.o.dockable && state.docked !== this._docked) {
        this.toggleDock();
      }
      if (typeof state.minimized === 'boolean' && !this._docked) {
        if (state.minimized && !this.isMinimized()) this.minimize();
        else if (!state.minimized && this.isMinimized()) this.restore();
      }
      // Don't yank geometry out from under an ACTIVE local resize (spec F: defer during a live
      // gesture). min/dock still apply; the geometry re-syncs on the gesture's own end-emit.
      const gestureActive = document.body.classList.contains('window-resizing-active');
      // #893: a sheet-presented window has no floating geometry to apply — a remote
      // x/y/w/h is a DESKTOP layout fact; min/dock state above still applies.
      if (this.el && !this._docked && !this._sheet && !gestureActive) {
        if (typeof state.w === 'number' && typeof state.h === 'number') {
          // #896: a width synced from another device clamps to the SAME max cap as a local resize —
          // min(content, viewport−margin). Clear maxWidth FIRST so windowMaxWidth reads the true
          // content want (not the 64vw CSS cap). A remote window from a wider screen lands bounded.
          this.el.style.maxWidth = 'none'; this.el.style.maxHeight = 'none';
          const wCap = windowMaxWidth(this.el, this.o.minWidth);
          this.el.style.width = Math.min(Math.max(this.o.minWidth, state.w), wCap) + 'px';
          this.el.style.height = Math.max(this.o.minHeight, Math.min(state.h, window.innerHeight)) + 'px';
          try { localStorage.setItem('winsize-' + this.o.id, JSON.stringify({ w: Math.round(state.w), h: Math.round(state.h) })); } catch (_) {}
        }
        if (typeof state.x === 'number' && typeof state.y === 'number') {
          const r = this.el.getBoundingClientRect();
          const c = clampPos(state.x, state.y, r.width, r.height);
          this.el.style.left = c.left + 'px'; this.el.style.top = c.top + 'px';
          this.el.style.right = 'auto'; this.el.style.bottom = 'auto'; this.el.style.transform = 'none';
          if (this._slot) this._slot.saveDragOffset(this.el.getBoundingClientRect());
        }
      }
    } catch (_) {}
    this._applyingRemote = false;
  }

  // Re-anchor + clamp this window into the CURRENT viewport (the global resize
  // listener calls this for every open, un-minimized, non-docked window). Cheap:
  // one rect read, at most a few style writes. Docked windows are skipped by the
  // caller (the rail owns them); minimized ones are skipped too (hidden, no point).
  //   1. slotted windows re-run the slot re-clamp (restackSlot already clamps,
  //      post-#345) so they re-anchor + clamp into the new viewport;
  //   2. a floating/dragged window clamps its raw left/top via clampPos;
  //   3. a window now LARGER than the viewport shrinks to fit (viewport − 8),
  //      respecting its own minWidth/minHeight, then re-clamps its position.
  _reclamp() {
    // #893: sheet geometry is CSS-owned (bottom-pinned, dvh detent heights track the
    // viewport natively) — nothing to re-clamp.
    if (!this.el || this._docked || this._sheet || this.isMinimized()) return;
    if (this.el.style.display === 'none') return;
    // 3. Shrink-to-fit FIRST so the post-shrink size drives the position clamp.
    const r0 = this.el.getBoundingClientRect();
    const inset = bannerInset();  // #758: subtract a top banner so a tall window COMPRESSES to fit
    // #896: width ceiling = the shared max cap min(content, viewport−margin) (not a bare viewport−8).
    const maxW = window.innerWidth - 8;
    const maxH = window.innerHeight - inset - 8;
    const widthCeil = windowMaxWidth(this.el, this.o.minWidth);
    if (r0.width > widthCeil) {
      this.el.style.maxWidth = 'none';
      this.el.style.width = Math.max(this.o.minWidth, widthCeil) + 'px';
    }
    if (r0.height > maxH) {
      this.el.style.height = Math.max(this.o.minHeight, maxH) + 'px';
      this.el.style.maxHeight = 'none';
    }
    // 1. Slotted: let the slot engine re-anchor + clamp (it runs clampPos itself).
    if (this._slot) { this._slot.restack(); }
    // 2. Clamp this window's own position into the viewport. clampPos only guarantees a
    //    SLIVER stays on-screen; on a viewport SHRINK we want the WHOLE window in view when
    //    it fits, so pull left/top back so right/bottom land inside the margin.
    const m = 4;
    const topFloor = m + inset;  // #758: the top floor clears the banner
    const r = this.el.getBoundingClientRect();
    let left = Math.max(m, Math.min(window.innerWidth - r.width - m, r.left));
    let top = Math.max(topFloor, Math.min(window.innerHeight - r.height - m, r.top));
    if (left < m) left = m;            // wider than the viewport (already min-clamped above) — pin left
    if (top < topFloor) top = topFloor; // taller than the viewport — pin just below the banner
    if (Math.abs(left - r.left) > 0.5 || Math.abs(top - r.top) > 0.5) {
      this.el.style.left = left + 'px'; this.el.style.top = top + 'px';
      this.el.style.right = 'auto'; this.el.style.bottom = 'auto'; this.el.style.transform = 'none';
    }
  }

  _onTitlebarKey(e) {
    const STEP = 16;
    const dirs = { ArrowLeft: [-STEP, 0], ArrowRight: [STEP, 0], ArrowUp: [0, -STEP], ArrowDown: [0, STEP] };
    if (e.key === 'Home' && this._slot && this.o.slotKey) {
      e.preventDefault();
      // R5/#1416b: per-user via the shared fail-closed helper; null-guarded so a missing identity
      // skips the removeItem rather than coercing a null key into a shared 'null' namespace.
      const k = window.orwellUserKey && window.orwellUserKey('orwell-slot-offset:' + this.o.slotKey);
      if (k) { try { localStorage.removeItem(k); } catch (_) {} }
      this._slot.restack();
      return;
    }
    const d = dirs[e.key];
    if (!d) return;
    // #893: a sheet has no XY position or free size — its geometry is the detent
    // classes. Arrow move/resize are floating-only affordances.
    if (this._sheet) return;
    // CodeRabbit: the Arrow-key nudge is a MOVE affordance — only draggable windows may be moved.
    // Gate it on `this.o.draggable` (the same flag that gates the aria-keyshortcuts + "arrows to
    // nudge" tooltip), so a draggable:false dialog can't be nudged even though Home (restack) and
    // other titlebar keys stay handled.
    if (!this.o.draggable) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    if (e.shiftKey && this.o.resizable) {
      // #896: keyboard resize honors the SAME max cap as pointer resize — never grow a window past
      // min(content, viewport−margin) (only enforce the cap when GROWING width, so a shrink from an
      // already-oversized restored size still works). Floor stays the keyboard's own 200px.
      const want = r.width + d[0];
      const wCap = (d[0] > 0) ? Math.max(r.width, windowMaxWidth(this.el, this.o.minWidth)) : Infinity;
      const w = Math.max(200, Math.min(wCap, window.innerWidth - 8, want));
      const h = Math.max(120, Math.min(window.innerHeight - 8, r.height + d[1]));
      this.el.style.width = w + 'px'; this.el.style.height = h + 'px';
      return;
    }
    const c = clampPos(r.left + d[0], r.top + d[1], r.width, r.height);
    this.el.style.left = c.left + 'px'; this.el.style.top = c.top + 'px';
    this.el.style.right = 'auto'; this.el.style.bottom = 'auto'; this.el.style.transform = 'none';
    this._persist(this.el.getBoundingClientRect());
  }

  // ── #893: sheet-mode gestures (detent drag + drag-to-dismiss) ──────────────
  // Mirrors orwellSheet.js's _wireDrag/_settle contract so the window-sheet and
  // the action-sheet feel identical: 1:1 height follow while dragging (the
  // .ow-sheet-dragging class kills transitions), release snaps to the nearest
  // detent (a short height glide via .ow-sheet-settling), and a deep downward
  // drag DISMISSES — gated on `closable` (the casting box, closable:false, can
  // re-detent but never be swiped away; its in-body exits stay the only way out).
  _wireSheetDrag(handle) {
    if (!handle) return;
    const sig = { signal: this.ac.signal };
    const sigP = { signal: this.ac.signal, passive: false };
    const onMove = (e) => {
      if (!this._sheetDrag || !this.el) return;
      const y = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
      if (y == null) return;
      const dy = y - this._sheetDrag.startY;
      if (Math.abs(dy) > 3) this._sheetDrag.moved = true;
      // Down (positive dy) shrinks the sheet; up grows it. Clamp to [0, full].
      const h = Math.max(0, Math.min(sheetDetentPx('full'), this._sheetDrag.startH - dy));
      this.el.style.height = h + 'px';
      if (e.cancelable) { try { e.preventDefault(); } catch (_) {} }  // own the gesture — no page scroll
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (this.el) this.el.classList.remove('ow-sheet-dragging');
      const drag = this._sheetDrag; this._sheetDrag = null;
      if (!drag || !drag.moved || !this.el) return;   // a tap, not a drag — keep the detent
      this._settleSheet(this.el.getBoundingClientRect().height);
    };
    const onDown = (e) => {
      // Never start a drag from an interactive control (the titlebar ×/– have their own clicks).
      if (e.target && e.target.closest && e.target.closest('button, input, select, textarea, a, [role="button"]')) return;
      const y = (e.touches && e.touches[0]) ? e.touches[0].clientY : e.clientY;
      if (y == null || !this.el) return;
      this._sheetDrag = { startY: y, startH: this.el.getBoundingClientRect().height, moved: false };
      this.el.classList.add('ow-sheet-dragging');
      window.addEventListener('pointermove', onMove, sigP);
      window.addEventListener('touchmove', onMove, sigP);
      window.addEventListener('pointerup', onUp, sig);
      window.addEventListener('touchend', onUp, sig);
      window.addEventListener('pointercancel', onUp, sig);
    };
    handle.addEventListener('pointerdown', onDown, sig);
    handle.addEventListener('touchstart', onDown, sigP);
  }

  // Where a released drag lands: dismiss (dragged well below the medium floor,
  // closable windows only), else snap to the nearest detent by px distance.
  _settleSheet(h) {
    const medium = sheetDetentPx('medium');
    if (this.o.closable && h < medium * (1 - SHEET_DISMISS_FRACTION)) {
      this.el.style.height = '';   // the exit slide owns the motion, not the drag height
      this.close();
      return;
    }
    const full = sheetDetentPx('full');
    this.setDetent(Math.abs(full - h) < Math.abs(medium - h) ? 'full' : 'medium');
  }

  /** #893: snap a sheet-presented window to a named detent ('medium'|'full').
   *  The resting height is CLASS-owned (ensureCss detent rules); a release glide
   *  bridges from the drag's inline height to the target, then hands the height
   *  back to the class. No-op for floating/docked presentation. */
  setDetent(name) {
    if (!this.el || !this._sheet) return this;
    const n = name === 'full' ? 'full' : 'medium';
    this.el.classList.toggle('ow-detent-full', n === 'full');
    this.el.classList.toggle('ow-detent-medium', n !== 'full');
    this.el.dataset.owDetent = n;
    if (!REDUCED() && this.el.style.height) {
      const target = sheetDetentPx(n);
      this.el.classList.add('ow-sheet-settling');
      requestAnimationFrame(() => { if (this.el) this.el.style.height = target + 'px'; });
      setTimeout(() => {
        if (!this.el) return;
        this.el.classList.remove('ow-sheet-settling');
        this.el.style.height = '';   // the detent class owns the resting height
      }, 300);
    } else {
      this.el.style.height = '';
    }
    return this;
  }

  /** The active detent name while sheet-presented, else null. */
  currentDetent() {
    return (this._sheet && this.el) ? (this.el.dataset.owDetent || 'medium') : null;
  }

  /** True while this window is presented as a bottom sheet (#893, phone tier). */
  isSheet() { return !!this._sheet; }

  // #893: crossing the narrow breakpoint re-homes an open window into the
  // presentation the new tier resolves (floating ↔ sheet) — a teardown + rebuild
  // through the SAME _rehoming hinge the dock toggle uses (one position system,
  // never a live geometry mutation). Minimized windows are left alone (hidden;
  // they re-resolve on their next real open) and a mid-close fade is respected.
  _rehomeForViewport() {
    if (!this.el || !this.el.isConnected || this._docked || this._closeTimer) return;
    if (this.isMinimized()) return;
    const want = this._resolveSheet();
    if (want === !!this._sheet) return;
    const opener = this.opener;
    this._rehoming = true;
    try { Modals.close(this.o.id); } finally { this._rehoming = false; }
    this.open(opener);
  }

  // ── J1-25 modal chrome (the per-window `modal` option) ─────────────────────
  // Mounts the backdrop scrim, traps Tab inside the window, PUSHES onto the kit's
  // modal stack, and recomputes the stack so the rest of the page AND every lower
  // modal go inert with this one as the live top (the aria-modal promise). Mirrors
  // the welcome modal's exemplary pattern (orwellOnboarding.js). #870: modal-over-
  // modal is coordinated by the stack — opening a 2nd modal makes it the interactive
  // top with the 1st inert beneath; closing restores the 1st.
  _mountModalChrome() {
    if (this._scrim) return;
    const scrim = document.createElement('div');
    scrim.className = 'ow-scrim';
    scrim.setAttribute('data-ow-scrim', this.o.id);
    scrim.style.zIndex = String(Z_MODAL_SCRIM);
    // Insert behind the (already-mounted) window so DOM order matches the z order.
    document.body.insertBefore(scrim, this.el);
    this._scrim = scrim;
    // A NON-modal sheet with `scrim:true` mounts ONLY the dimming backdrop — no modal
    // stack, no focus-trap, no inert background, no aria-modal. It stays non-modal; raise()
    // (called right after in open()) layers this scrim one z BELOW the sheet window so the
    // sheet is never covered by its own dim. The scrim is still torn down by _teardown →
    // _unmountModalChrome (this._scrim removal is unconditional there) and is protected from
    // the orphan sweep because _sweepOrphanScrims also treats any live registered window's
    // scrim as legitimate (not just modal-stack entries).
    if (!this.o.modal) return;
    if (_modalStack.indexOf(this) === -1) _modalStack.push(this);   // #870: become the top
    this._trapFocus();
    _recomputeModalStack();   // #870: inert page + lower modals; this one is the live top
  }

  _unmountModalChrome() {
    const i = _modalStack.indexOf(this);
    if (i !== -1) _modalStack.splice(i, 1);                          // #870: pop
    if (this._scrim) { try { this._scrim.remove(); } catch (_) {} this._scrim = null; }
    // #870: recompute against the NEW top — releases this modal's contribution to the inert
    // set and re-inerts everything except whatever modal is now on top (or fully un-inerts the
    // page when the stack is empty). Stack-aware: a node a lower modal still needs inert stays inert.
    _recomputeModalStack();
  }

  // #870: re-stamp THIS modal's z + scrim z from the single OrwellZ ladder. Called per-modal
  // by _recomputeModalStack in stack order so a later modal lands strictly above an earlier one
  // (window + scrim both). Fallback to the fixed tier when ui.js's ladder isn't loaded.
  _stampModalZ() {
    if (!this.o.modal || !this.el) return;
    const z = (typeof window._owNextModalZ === 'function') ? window._owNextModalZ() : Z_MODAL;
    this.el.style.zIndex = String(z);
    if (this._scrim) this._scrim.style.zIndex = String(z - 1);
  }

  // Back-compat shims (audit J1-25; #870). The kit no longer hand-inerts per-modal — the modal
  // stack owns the inert set and recomputes it from the live top. These remain because
  // orwellOnboarding.js calls win._inertBackground()/_uninertBackground() directly (its old
  // "lift inert to open Settings, then re-inert" dance). They now simply re-run the stack
  // recompute, so the live top is always honored regardless of which one a consumer pokes.
  _inertBackground() { _recomputeModalStack(); }
  _uninertBackground() { _recomputeModalStack(); }

  // Keep Tab inside the window so focus can't escape into the (inert) page — the
  // J1-25 defect was "focus escapes into chat; Escape landed on body". Listener is
  // bound to the AbortController so teardown removes it.
  _trapFocus() {
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const all = this.el.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      const f = Array.prototype.filter.call(all, (n) => !n.disabled && (n.offsetParent !== null || n === document.activeElement));
      if (!f.length) { e.preventDefault(); return; }       // nothing focusable → stay put
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }, { signal: this.ac.signal });
  }

  // Move focus INTO the dialog on open so it lands inside the modal, never on body
  // (J1-25). #837: focus the ring-free ROOT (tabindex=-1) on spawn — NOT the first
  // interactive control, which would paint a focus ring the user never keyboard-asked
  // for. The trap keeps Tab inside; the user's first Tab reaches the first control and
  // THAT rings (keyboard intent). A text input the player is meant to type in is the one
  // legit auto-focus exception, and the consuming panels own that decision themselves.
  _focusIntoModal() {
    try { (this.el || this.titlebar).focus({ preventScroll: true }); } catch (_) {}
  }

  open(opener) {
    // TX-1: a re-open during the close fade must cancel the pending teardown and clear the
    // latched close-animation class — otherwise finish() would tear THIS window down and the
    // .ow-anim-close end-state would leave it invisible.
    if (this._closeTimer) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    if (this.el) this.el.classList.remove('ow-anim-close', 'ow-anim-sheet-out');
    if (this.el && this.el.isConnected) { this.restore(); return this; }
    // #925: same-id collision guard. modalManager._state and this kit's _byId/getElementById are
    // ALL keyed by window id, so two DIFFERENT live instances sharing an id desync the registry:
    // closing one unregisters the id for BOTH, stranding the other's window + scrim forever (the
    // orphan-scrim lockup — a full-viewport scrim then eats every click). A new open() for an id a
    // DIFFERENT instance still owns must therefore destroy that prior instance first (synchronous
    // teardown removes its scrim + node + stack/registry entries) so this open is the sole owner.
    // The onboarding flow's async re-mounts (route() re-firing on orwell:models-changed) are the
    // real-world source of such a collision. (Same instance re-opening was handled just above.)
    const _prior = _byId.get(this.o.id);
    if (_prior && _prior !== this) { try { _prior.destroy(); } catch (_) {} }
    this.opener = opener || document.activeElement || null;
    // A prior _teardown() aborted this.ac; a fresh open (incl. the dock toggle's
    // re-open) needs a live controller so _build's listeners actually attach.
    if (this.ac.signal.aborted) this.ac = new AbortController();
    // #893: sheet-vs-floating is a per-OPEN resolution (like docked) — the viewport
    // tier may have changed since construction / the last open.
    this._sheet = this._resolveSheet();
    const el = this._build();
    _byId.set(this.o.id, this);                                            // 0064: live registry for remote apply
    this._emit({ open: true }); // 0064/D1: capture open state (gated)
    // 0054 Phase 2: a docked window mounts straight into #gadget-rail-body (the
    // rail owns visibility/order/collapse/mobile-drawer). NO slot register, NO
    // dock-chip register, NO z-band raise — docked = no geometry, the F5 invariant
    // holds. The consuming panel's own content-driven display:none decides when the
    // rail shows it (its existing MutationObserver). Body fallback if no rail yet.
    if (this._docked) {
      const railBody = document.getElementById('gadget-rail-body');
      (railBody || document.body).appendChild(el);
      if (this.o.focus) this.el.focus({ preventScroll: true }); // #837: ring-free root, not the titlebar
      return this;
    }
    document.body.appendChild(el);
    // #893: a sheet-presented window opts OUT of the slot geometry system entirely
    // (bottom-pinned, class-owned detent heights — F5: sheet = no slot, no offset,
    // never a second persisted-position scheme).
    if (window.OrwellSlots && !this._sheet) {
      this._slot = window.OrwellSlots.register(el, this.o.slot,
        { key: this.o.slotKey || null, draggable: this.o.draggable });
      // FLY-IN FIX (#794) belt-and-braces: register() runs ONE synchronous restackSlot that
      // measures the element BEFORE the just-mounted .ow-body content has fully laid out, so the
      // first centred left can be computed against a stale width. Force a synchronous reflow
      // (read offsetWidth) and re-restack so the centred left is correct against the real,
      // now-stable width BEFORE the open-animation class is added below — the window is at its
      // final spot from the first frame. (THE root fix for the visible "fly right, then move to
      // centre" slide is the geometry-transition suppression in ensureCss — see the .ow-window
      // transition-property rule above; this just removes the one-frame measurement wobble.)
      // Cheap: one layout read + idempotent setStyle writes that no-op when nothing moved.
      if (this._slot && typeof this._slot.restack === 'function') {
        void el.offsetWidth;     // force synchronous layout of the freshly-mounted content
        this._slot.restack();    // re-anchor with the now-correct measured width, pre-animation
      }
    }
    Modals.register(this.o.id, {
      label: this.o.title, icon: this.o.icon || '',
      restoreFn: () => this._afterDockRestore(),
      closeFn: () => this._teardown(),
    });
    // F2 (G5 audit / G16): a window the player parked stays parked across a
    // refresh — mount straight into the minimized state (dock chip, panel
    // hidden; no open animation, no raise, no focus steal), exactly as if the
    // minimize had happened this page-life. The dock chip (or an explicit
    // restore) brings it back and durably un-parks it.
    if (this.o.minimizable && loadParked(this.o.id)) {
      this._displayBeforeMin = el.style.display;
      Modals.minimize(this.o.id);
      el.style.display = 'none';
      return this;
    }
    if (!REDUCED()) {
      // #893: a sheet RISES from the bottom edge (the slide-up entrance); a floating
      // window keeps the E97 fade+scale. reduced-motion strips both.
      const animCls = this._sheet ? 'ow-anim-sheet-in' : 'ow-anim-open';
      el.classList.add(animCls);
      setTimeout(() => el.classList.remove(animCls), this._sheet ? 360 : 220);
    }
    // BL-046: gate the frosted sheet body reveal on a painted frame so it never flashes an
    // empty translucent void during mount/composite (see the CSS above). Runs regardless of
    // reduced-motion (the CSS strips the fade there) and is FAIL-OPEN — the class is always
    // removed by the rAF, backed by a hard timeout, so a missed frame can't leave a blank body.
    if (this._sheet) {
      el.classList.add('ow-sheet-content-pending');
      let _bl046Revealed = false;
      const _revealSheetBody = () => {
        if (_bl046Revealed) return;
        _bl046Revealed = true;
        el.classList.remove('ow-sheet-content-pending');
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => requestAnimationFrame(_revealSheetBody));
      } else {
        _revealSheetBody();
      }
      setTimeout(_revealSheetBody, 400);
    }
    // J1-25: a modal window mounts its backdrop scrim + inerts the background + traps
    // focus BEFORE the raise (which pins it to the modal tier above the scrim).
    // A NON-modal sheet that opted into `scrim:true` also mounts the scrim here — but
    // _mountModalChrome mounts ONLY the dimming backdrop for it (no trap/inert/stack);
    // raise() layers that scrim one z below the sheet window.
    if (this.o.modal || (this._sheet && this.o.scrim)) this._mountModalChrome();
    this.raise();
    if (this.o.modal) this._focusIntoModal();
    else if (this.o.focus) this.el.focus({ preventScroll: true }); // #837: ring-free root, not the titlebar
    // 0064 Part F: apply a synced layout seed from another device once layout settles. min/dock/size
    // also restore via localStorage (the kit's existing load); this additionally covers POSITION and
    // keeps a just-opened window consistent with a change made elsewhere while it was closed.
    // D1: a non-persistent dialog ignores any synced seed — it must always open centered, never
    // re-applying a position dragged in a past session / on another device.
    if (this.o.persistLayout !== false) try {
      const seed = window._orwellLayoutSeed && window._orwellLayoutSeed[this.o.id];
      if (seed) requestAnimationFrame(() => { if (this.el) this._applyLayout(seed); });
    } catch (_) {}
    return this;
  }

  raise() {
    if (!this.el || this._docked) return;  // a docked window has no z-band / focus stack
    const i = _stack.indexOf(this);
    if (i !== -1) _stack.splice(i, 1);
    _stack.push(this);
    // J1-25: a modal window is pinned to the modal tier (just above its scrim), never
    // the kit band — and it is excluded from the band renormalization below.
    // A2 (#573, DWE audit F9): ONE z-authority. Draw the modal z from ui.js's single
    // monotonic counter (window._owNextModalZ) when present, so a kit modal and a
    // legacy .modal can never out-climb each other (the old fixed Z_MODAL=1001 lost to
    // a legacy modal once _zCounter passed it). Fallback to the fixed tier if ui.js
    // hasn't loaded. The scrim follows just under whatever the window lands on.
    if (this.o.modal) {
      // #870: a raise() on a modal makes it the live top of the modal stack — move it to
      // the top of the stack and recompute (z + scrim layering + inert). _recomputeModalStack
      // re-stamps every modal in order via _stampModalZ, so this one lands strictly highest.
      const mi = _modalStack.indexOf(this);
      if (mi !== -1) {
        if (mi !== _modalStack.length - 1) { _modalStack.splice(mi, 1); _modalStack.push(this); }
        _recomputeModalStack();
      } else {
        // Not yet on the stack (raised before _mountModalChrome in open()) — stamp z directly;
        // _mountModalChrome will push + recompute right after.
        this._stampModalZ();
      }
    } else {
      // A2: the non-modal band is allocated by the single authority (window.
      // _owNextWindowZ in ui.js), which advances the SAME global tick the modal
      // ladder uses and renormalizes the open kit stack at the band ceiling.
      this.el.style.zIndex = String(nextWindowZ());
      // A non-modal sheet scrim (scrim:true) rides just UNDER this window in the kit
      // band, so the sheet is never covered by its own dimming backdrop (a non-modal
      // scrim gets no modal z-tier). Re-run on every raise so click-to-front keeps the
      // ordering. this._scrim here is ONLY the non-modal sheet-scrim case (a modal draws
      // its z via the branch above; a plain window has no scrim).
      if (this._scrim) {
        const wz = parseInt(this.el.style.zIndex, 10);
        this._scrim.style.zIndex = String((Number.isFinite(wz) ? wz : Z_BASE) - 1);
      }
    }
    for (const w of _stack) w.el && w.el.classList.toggle('ow-focused', w === this);
  }

  minimize() {
    if (!this.el || this._docked) return;  // docked windows live in the rail, no chip dock
    // #573 GESTURE UNIFICATION (window-system audit Direction B): a DOCKABLE window's minimize
    // IS the dock — ONE gesture, ONE destination (the control-room rail). Route through the dock
    // (mount the full window into the rail) instead of parking a compact chip in a separate
    // "Windows" strip; the chip-park path below is now exclusively for NON-dockable kit windows.
    // minimize() is only ever reached while FLOATING (the yellow control is gated on !_docked and
    // we early-return above when docked), so this is always a plain float→dock re-home. Escape
    // (dismissTop) and a remote-layout minimize both funnel here too, so a dockable window tucks
    // into the rail consistently however it was triggered; restore is the dock's own undock (⇱)
    // toggle — one gesture back out, the same single destination.
    if (this.o.dockable) { this.toggleDock(); return; }
    saveParked(this.o.id, true); // F2 (G16): parked means parked — survive a refresh (non-dockable)
    this._emit({ minimized: true });  // 0064/D1
    const i = _stack.indexOf(this);
    if (i !== -1) _stack.splice(i, 1);
    this.el.classList.remove('ow-focused');
    // Capture the pre-minimize inline display so restore can put it BACK —
    // clearing to '' would fall through to a consumer's own CSS (e.g. a panel
    // whose stylesheet defaults to display:none), reproducing the F1 bug class
    // one layer up.
    this._displayBeforeMin = this.el.style.display;
    const done = () => {
      this.el.classList.remove('ow-anim-minimize');
      this.el.style.removeProperty('--ow-fly-x'); this.el.style.removeProperty('--ow-fly-y');
      Modals.minimize(this.o.id);            // chip renders; F1 makes the dock visible
      this.el.style.display = 'none';        // kit windows aren't .modal — hide explicitly
      try { this.o.onMinimize && this.o.onMinimize(); } catch (_) {}
    };
    if (REDUCED()) { done(); return; }
    // A7 [ruling #19]: the Win7 fly-out — scale-down + translate along the path to
    // the dock row, driven by the dedicated ow-minimize keyframe (the fly vector is
    // handed to it via --ow-fly-x/-y so the keyframe owns the motion, one contract).
    const from = this.el.getBoundingClientRect();
    const to = flyTargetRect();
    const dx = (to.left + (to.width || 32) / 2) - (from.left + from.width / 2);
    const dy = (to.top + (to.height || 24) / 2) - (from.top + from.height / 2);
    this.el.style.setProperty('--ow-fly-x', dx + 'px');
    this.el.style.setProperty('--ow-fly-y', dy + 'px');
    this.el.classList.add('ow-anim-minimize');
    setTimeout(done, 280);
  }

  _afterDockRestore() {
    // modalManager.restore removed .hidden/.modal-minimized and stamped ITS z —
    // re-show (the exact pre-minimize inline display, never '' — see minimize),
    // then re-assert the kit band so stacking stays one authority.
    this.el.style.display = this._displayBeforeMin || '';
    // F2 (G16): a window that mounted straight into the dock (boot-parked)
    // never had a real pre-minimize display captured, and '' can fall through
    // to a consumer stylesheet's display:none (the finale defaults hidden) —
    // a dock restore must always yield a VISIBLE window.
    if (getComputedStyle(this.el).display === 'none') this.el.style.display = 'block';
    saveParked(this.o.id, false); // F2 (G16): an explicit restore un-parks durably
    this._emit({ minimized: false });  // 0064/D1
    this.el.style.transform = ''; this.el.style.opacity = '';
    if (this._slot) this._slot.restack();
    this.raise();
    // A7 [ruling #19] mirror: a restore is the fly-IN that reverses minimize's
    // fly-OUT — the window flies back from the dock chip to its place. Computed
    // AFTER restack/raise so the delta targets the FINAL geometry. The keyframe
    // owns the motion (same --ow-fly-x/-y contract); reduced-motion skips it.
    if (!REDUCED()) {
      try {
        const from = flyTargetRect();                 // the dock chip (the fly-out's target)
        const to = this.el.getBoundingClientRect();    // where the window lands
        const dx = (from.left + (from.width || 32) / 2) - (to.left + to.width / 2);
        const dy = (from.top + (from.height || 24) / 2) - (to.top + to.height / 2);
        this.el.style.setProperty('--ow-fly-x', dx + 'px');
        this.el.style.setProperty('--ow-fly-y', dy + 'px');
        this.el.classList.add('ow-anim-restore');
        setTimeout(() => {
          if (!this.el) return;
          this.el.classList.remove('ow-anim-restore');
          this.el.style.removeProperty('--ow-fly-x');
          this.el.style.removeProperty('--ow-fly-y');
        }, 290);
      } catch (_) {}
    }
    try { this.o.onRestore && this.o.onRestore(); } catch (_) {}
  }

  restore() { if (!this._docked) Modals.restore(this.o.id); }

  /** True while this window is parked in the dock (modalManager's registry). */
  isMinimized() { return !this._docked && Modals.isMinimized(this.o.id); }

  /** True while this window is rendered docked into the gadget rail (0054 Phase 2). */
  isDocked() { return !!this._docked; }

  /** Show/hide the non-blocking refresh affordance (perf/resilience). A window opens
   *  immediately with its last-good/placeholder content; while a slow /state fill is in
   *  flight the body shows a thin top sliver and the titlebar a quiet "·refreshing" hint —
   *  the underlying content is NEVER hidden, so a reused last-good snapshot stays readable.
   *  Idempotent and safe before/after open() (it no-ops if the chrome isn't built yet). */
  setLoading(on) {
    if (!this.el) return;
    this.el.classList.toggle('ow-loading', !!on);
    const title = this.titlebar && this.titlebar.querySelector('.ow-title');
    if (!title) return;
    const dropHint = () => {
      const h = title.querySelector('.ow-load-hint');
      if (h) h.remove();
    };
    // TRANS-10: a fast (deterministic/local ~20-40ms) poll mounted+removed "· refreshing" within a
    // single frame — a visible micro-flash AND a repeated aria-live announcement every poll cycle.
    // Only reveal the hint if the refresh is still in flight after a short threshold, so ordinary
    // fast polls never flash or announce; a genuinely slow fill still surfaces it.
    if (on) {
      if (title.querySelector('.ow-load-hint') || this._loadHintTimer) return;
      this._loadHintTimer = setTimeout(() => {
        this._loadHintTimer = null;
        if (!this.el || !this.el.classList.contains('ow-loading')) return;
        if (title.querySelector('.ow-load-hint')) return;
        const hint = document.createElement('span');
        hint.className = 'ow-load-hint';
        hint.textContent = '· refreshing';
        hint.setAttribute('aria-live', 'polite');
        title.appendChild(hint);
      }, 200);
    } else {
      if (this._loadHintTimer) { clearTimeout(this._loadHintTimer); this._loadHintTimer = null; }
      dropHint();
    }
  }

  /** Toggle docked↔floating: persist the flag, tear down, and re-open in the new
   *  mode. ONE position system (F5) — a mode change is a rebuild, never a live
   *  geometry mutation. A docked window registers no dock chip, so close() here
   *  just tears it down directly. */
  toggleDock() {
    if (!this.o.dockable) return;
    const next = !this._docked;
    saveDocked(this.o.id, next);
    this._emit({ docked: next });  // 0064/D1
    const opener = this.opener;
    // A dock toggle is a RE-HOME, not a dismissal: suppress the consumer's onClose
    // (it resets the module's _win reference — which we keep, since it's the same
    // instance) and Modals.unregister so the re-open is clean. The _rehoming guard
    // makes _teardown skip onClose; we still abort listeners + drop the old node.
    this._rehoming = true;
    try {
      if (this._docked) this._teardown();
      else Modals.close(this.o.id);  // closeFn → _teardown() (guarded)
    } finally { this._rehoming = false; }
    this._docked = next;
    // Re-open immediately in the new mode (no fly animation — it's a re-home, not a
    // dismissal). A docked window self-gates visibility; a floated one raises.
    this.open(opener);
    try { this.o.onDock && this.o.onDock(next); } catch (_) {}
    return this;
  }

  close() {
    if (!this.el) return;
    // A docked window isn't in modalManager — tear it down directly (no chip, no
    // fly-to-dock: it lives in the rail flow).
    if (this._docked) { this._teardown(); return; }
    const finish = () => { this._closeTimer = null; Modals.close(this.o.id); };   // closeFn → _teardown()
    if (REDUCED()) { finish(); return; }
    // #893: a sheet SLIDES back down off the bottom edge (mirror of the rise-in).
    if (this._sheet) {
      this.el.classList.add('ow-anim-sheet-out');
      this._closeTimer = setTimeout(finish, 260);
      return;
    }
    // A7 [ruling #19]: scale+fade fly-away on close (the dedicated ow-close keyframe).
    this.el.classList.add('ow-anim-close');
    // TX-1: track the fade timer so a re-open() during the ~190ms fade can cancel it —
    // otherwise the pending finish() tears down the freshly re-opened window, and the
    // latched .ow-anim-close leaves it invisible. open() clears this + strips the class.
    this._closeTimer = setTimeout(finish, 190);
  }

  _teardown() {
    const i = _stack.indexOf(this);
    if (i !== -1) _stack.splice(i, 1);
    _byId.delete(this.o.id);  // 0064: drop from the live registry
    this._unmountModalChrome();  // J1-25: remove the scrim + un-inert the page (no-op if not modal)
    saveParked(this.o.id, false); // F2 (G16): a closed window forgets its parked state
    this.ac.abort();
    const opener = this.opener;
    // A2: capture whether focus was inside this window BEFORE removing it, so the
    // shared focus-return helper can apply the same "only if focus is still inside
    // (or fell to body)" rule the .modal family uses. Removing this.el drops any
    // inner focus to <body>, which the helper also treats as safe to return.
    const focusWasInside = !!(this.el && document.activeElement && this.el.contains(document.activeElement));
    if (this.el) { this.el.remove(); this.el = null; }
    // A dock-toggle re-home keeps the same instance + the module's _win reference,
    // so skip the consumer's onClose reset and the focus-return (open() refocuses).
    if (this._rehoming) return;
    // 0064: a genuine close (not a dock re-home) syncs the closed state to other devices.
    this._emit({ open: false, minimized: false });
    try { this.o.onClose && this.o.onClose(); } catch (_) {}
    // audit F8 / A2 (#573): focus returns to the opener through THE single
    // focus-return helper (window._owReturnFocus, ui.js) shared with the .modal
    // family — one implementation of the restore rule, no drift. Fallback to a
    // direct focus when ui.js hasn't loaded (keeps the old behavior).
    if (typeof window._owReturnFocus === 'function') {
      window._owReturnFocus(opener, focusWasInside ? document.body : null);
    } else if (opener && opener.isConnected && typeof opener.focus === 'function') {
      try { opener.focus(); } catch (_) {}
    }
  }

  destroy() { this._teardown(); Modals.unregister(this.o.id); }
}

// Escape participation (audit F7): ui.js's single arbiter calls this between
// the menu stack and the modal pass. Top kit window parks (minimizable) or
// closes; returns true when it consumed the key.
//
// #870: when ANY modal is open, Escape closes EXACTLY the TOP modal (the modal stack's
// last entry) — never a lower modal, never a non-modal window behind it. A modal owns the
// foreground (it inerts the page + every lower modal), so it always outranks the non-modal
// pass. This keeps the "one thing per press, top-down" contract for modal-over-modal.
export function dismissTop() {
  // #925: sweep any orphaned scrim BEFORE the dismiss pass. If a previous teardown left a scrim
  // behind (window gone, scrim lingering and intercepting every click), this removes it on the
  // next Escape/dismiss so the page becomes interactive again even if no live modal remains. It
  // only ever removes a scrim whose owning modal is genuinely gone — a live modal's scrim stays.
  _sweepOrphanScrims();
  for (let i = _modalStack.length - 1; i >= 0; i--) {
    const w = _modalStack[i];
    if (!w.el || !w.el.isConnected || w.el.style.display === 'none') { _modalStack.splice(i, 1); continue; }
    if (w.o.minimizable) w.minimize(); else w.close();
    return true;
  }
  for (let i = _stack.length - 1; i >= 0; i--) {
    const w = _stack[i];
    if (!w.el || !w.el.isConnected || w.el.style.display === 'none') { _stack.splice(i, 1); continue; }
    if (w.o.minimizable) w.minimize(); else w.close();
    return true;
  }
  return false;
}

export function stackIds() { return _stack.map((w) => w.o.id); }

// ── viewport re-clamp on browser resize (DWE windowing tail) ───────────────
// The kit clamps on open/drag/resize, and the slot engine re-clamps every entry
// on its own 'resize' listener (post-#345). The remaining gap: a FLOATING/dragged
// kit window had no path to re-clamp when the BROWSER viewport shrinks, so it could
// strand partially off-screen until touched. ONE global, rAF-debounced listener
// over the open-window stack closes it — for every OPEN, un-minimized, non-docked
// window: re-anchor + clamp (slotted via restackSlot, floating via clampPos) and
// shrink any window now larger than the viewport to fit. Cheap (one frame coalesces
// a resize-drag burst, no per-window listeners to tear down) and it leaves docked
// windows (the rail owns them) and minimized ones (hidden) alone.
let _reclampRaf = 0;
function reclampOpenWindows() {
  _reclampRaf = 0;
  // Snapshot: _reclamp() may write styles that re-enter the slot observer; iterate
  // a copy so a concurrent splice (a window closing mid-pass) can't skip entries.
  for (const w of _stack.slice()) {
    try { w._reclamp(); } catch (_) {}
  }
}
function onViewportResize() {
  // #893 (CodeRabbit #1378): a viewport change can be a rotation — the notch moves,
  // so the cached safe-area-inset-top must be re-probed on the next detent settle.
  _safeTopPx = -1;
  if (_reclampRaf) return;
  _reclampRaf = (window.requestAnimationFrame || ((fn) => setTimeout(fn, 120)))(reclampOpenWindows);
}
window.addEventListener('resize', onViewportResize);
// #893: crossing the narrow breakpoint re-homes every open kit window into the
// presentation the new tier resolves (floating ↔ bottom sheet) — a teardown +
// rebuild through the same _rehoming hinge the dock toggle uses, so there is
// never a live geometry mutation between the two systems (F5).
onNarrowChange(() => {
  for (const w of Array.from(_byId.values())) { try { w._rehomeForViewport(); } catch (_) {} }
});
// #758: a top system-banner show/hide/copy-change shifts the available top band — re-clamp every
// open window through the SAME rAF-debounced pass (so a banner appearing pushes a top-slotted
// window below it and compresses the stack; disappearing lets it climb back). The banner
// (orwellNotice.js) broadcasts orwell:banner-inset on set/clear.
window.addEventListener('orwell:banner-inset', onViewportResize);

// The .ow-* family is page-global chrome (the .ow-dismiss affordance is used by
// non-window surfaces that may render before any window exists) — inject at load.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ensureCss, { once: true });
} else {
  ensureCss();
}

// The seam every consumer + the headless gate use.
window.OrwellWindowKit = {
  create: (opts) => new OrwellWindow(opts),
  dismissTop,
  stackIds,
};
