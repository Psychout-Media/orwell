// orwellGadgetRail (0054) — the control-room gadget rail.
//
// A right-side collapsible column that hosts the live house HUD. The status panel, deals,
// "where you are", the pinned cast and the docked Phase-2 windows (finale / cast / retro)
// mount INTO #gadget-rail-body instead of the nav sidebar. Game-build only; shown only while
// a season is active. Collapses to a thin icon strip on desktop and slides over as a drawer on
// narrow. The side can be swapped with the nav sidebar. State (collapsed / side / per-user
// order — not the mobile open flag) persists in localStorage.
//
// ── ONE SOURCE OF TRUTH: the GADGET REGISTRY ──────────────────────────────────
// Both views — the expanded rail and the collapsed icon strip — DERIVE from a single
// declarative registry (think a Home Assistant dashboard config). Each gadget is one entry
// with a STABLE id (its element id in #gadget-rail-body), an icon, a Title-Case title, and a
// canonical order. Gadgets self-mount their own element into the rail body and self-gate their
// own visibility (display:none when empty); the registry maps id → {icon, title, order}. The
// strip is rebuilt from the registry filtered to the gadgets actually mounted-and-visible, in
// the rail's current visual order — so a collapsed icon can never mismatch or outlive its
// gadget, and clicking it acts on THAT gadget (expand + scroll-to + focus). New gadgets are
// added by appending one registry row; nothing else needs to change.
(function () {
  "use strict";
  function gameBuild() { return !!(document.body && document.body.hasAttribute("data-game-build")); }
  if (!gameBuild()) return;  // never in the full inherited workspace

  var COLLAPSE_KEY = "orwell-gadget-rail-collapsed";
  var SIDE_KEY = "orwell-gadget-side";
  var rail = document.getElementById("gadget-rail");
  var opener = document.getElementById("gadget-rail-open");
  if (!rail) return;

  // ── THE GADGET REGISTRY (declarative, single source of truth) ───────────────
  // id        — the gadget's element id inside #gadget-rail-body (stable contract).
  // icon      — the glyph shown in the collapsed strip + the gadget's title affordance.
  // title     — Title-Case label (tooltip / aria-label on the strip icon).
  // order     — canonical stacking position; the inline `order` we apply (drag-reorder,
  //             persisted per-user, overrides this). Lower = higher in the column.
  // Every gadget that mounts into the rail MUST have a row here; that is what keeps the two
  // views in lock-step. (NPC approach-intent is deliberately NOT a gadget — approaches come
  // through chat, owner ruling 2026-06-18.)
  // #955: the EXPANDED cast photo gallery is the roster and docks directly UNDER the
  // Nightfall (time-of-day) gadget. Keep these orders in sync with the CSS fallback in
  // style.css (.gadget-rail-body > #... { order: }).
  var REGISTRY = [
    { id: "orwell-status",   icon: "📋", title: "House Status",   order: 1 },
    { id: "orwell-deals",    icon: "🤝", title: "Your Deals",     order: 2 },
    { id: "orwell-presence", icon: "🧭", title: "Where You Are",  order: 3 },
    { id: "orwell-night",    icon: "🌙", title: "Nightfall",      order: 4 },
    { id: "orwell-cast",     icon: "🎬", title: "The Cast",       order: 5 },
    { id: "orwell-cast-pin", icon: "👥", title: "Pinned Cast",    order: 6 },
    { id: "orwell-finale",   icon: "🏆", title: "The Finale",     order: 7 },
    { id: "orwell-retro",    icon: "📼", title: "Season Recap",   order: 8 },
  ];
  var REG_BY_ID = {};
  REGISTRY.forEach(function (g) { REG_BY_ID[g.id] = g; });

  // ── SVG LINE ICONS (#8/#9) ────────────────────────────────────────────────
  // The condensed strip used literal EMOJI (📋 clipboard, 🧭 compass, …), which break the
  // app's SVG line-icon visual language (owner report). Render proper stroke icons instead:
  // 24×24 viewBox, fill:none, stroke:currentColor, weight 2, round caps — identical to the
  // #gadget-rail-open glyph in index.html and the rest of the kit's iconography. Keyed by
  // gadget id; the registry `icon` emoji stays as the accessibility-free TOOLTIP fallback only
  // (aria-label carries the real name). Adding a gadget: add an icon here too.
  function _svg(inner) {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
           ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
           inner + '</svg>';
  }
  var SVG_ICON = {
    // clipboard / production notes (House Status)
    "orwell-status": _svg('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>'),
    // handshake → two clasped hands, simplified (Your Deals)
    "orwell-deals": _svg('<path d="M11 17l-2.5 2.5a1.8 1.8 0 0 1-2.6-2.6L9 13.4"/><path d="M13 7l2.5-2.5a1.8 1.8 0 0 1 2.6 2.6L15 10"/><path d="M8.5 12.5l3 3M11.5 9.5l3 3"/>'),
    // two people (Pinned Cast)
    "orwell-cast-pin": _svg('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3 3 0 0 1 0 5M21 20a6 6 0 0 0-4-5.7"/>'),
    // compass (Where You Are)
    "orwell-presence": _svg('<circle cx="12" cy="12" r="9"/><path d="M16 8l-2.5 5.5L8 16l2.5-5.5z"/>'),
    // moon (Nightfall)
    "orwell-night": _svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
    // trophy (The Finale)
    "orwell-finale": _svg('<path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3"/><path d="M10 13.5V17M14 13.5V17M8 20h8"/>'),
    // clapperboard (The Cast)
    "orwell-cast": _svg('<rect x="3" y="8" width="18" height="12" rx="1"/><path d="M3 8l2.5-4 4 2 4-2 4 2"/><path d="M5.5 4L8 8M9.5 6L12 10"/>'),
    // film reel (Season Recap)
    "orwell-retro": _svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>')
  };
  // Registry-declared ids, in canonical order — the base sequence the strip + inline `order`
  // both derive from (the per-user saved order, when present, takes precedence).
  function registryIds() {
    return REGISTRY.slice().sort(function (a, b) { return a.order - b.order; })
      .map(function (g) { return g.id; });
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  var body = document.getElementById("gadget-rail-body");
  var strip = document.getElementById("gadget-rail-strip");

  // ── restore persisted layout ──────────────────────────────────────────────
  function applyCollapsed(c) {
    rail.setAttribute("data-collapsed", c ? "true" : "false");
    var t = document.getElementById("gadget-rail-toggle");
    if (t) { t.setAttribute("aria-expanded", c ? "false" : "true");
      t.title = c ? "Expand the control room" : "Collapse the control room"; }
    if (c) { exitEdit(); syncStrip(); }  // collapsing: leave edit mode (if any) + match the strip
  }
  function applySide(side) {
    if (side === "left") document.body.setAttribute("data-gadget-side", "left");
    else document.body.removeAttribute("data-gadget-side");
  }
  applyCollapsed(lsGet(COLLAPSE_KEY) === "1");
  // The nav sidebar OWNS the layout side now (its _syncRailSideCore mirrors the dock to the
  // OPPOSITE edge — one source of truth, so the dock + sidebar can't desync). Defer to it;
  // fail soft to our own stored side if the sidebar module isn't up yet (it overrides on
  // its own init sync).
  if (window.syncRailSide) window.syncRailSide();
  else applySide(lsGet(SIDE_KEY) === "left" ? "left" : "right");

  // ── controls ────────────────────────────────────────────────────────────
  function toggleCollapsed() {
    var c = rail.getAttribute("data-collapsed") !== "true";
    applyCollapsed(c); lsSet(COLLAPSE_KEY, c ? "1" : "0");
  }
  function expand() { applyCollapsed(false); lsSet(COLLAPSE_KEY, "0"); }
  function toggleSide() {
    // The dock + nav sidebar are a PAIR on opposite edges. Swap through the SIDEBAR (the
    // single source of truth); its _syncRailSideCore mirrors the dock to the opposite edge
    // and moves the hamburger along. (Was: flip data-gadget-side alone → the sidebar slid
    // over via flex order but its hamburger stayed stranded over the moved dock = the
    // overlapping "sideways caret under the hamburger".)
    if (window._orwellToggleSidebarSide) { window._orwellToggleSidebarSide(); return; }
    var left = document.body.getAttribute("data-gadget-side") !== "left";  // fail-soft
    applySide(left ? "left" : "right"); lsSet(SIDE_KEY, left ? "left" : "right");
  }
  // M1-5 (audit A5): the open mobile drawer sits over a SCRIM — one modal layer, the chat
  // dimmed beneath, tap-scrim closes. Created lazily, torn down on close; desktop never
  // sees it (openDrawer is drawer-mode only).
  function _scrim() {
    var s = document.getElementById("grail-scrim");
    if (!s) {
      s = document.createElement("div");
      s.id = "grail-scrim";
      s.className = "grail-scrim";
      s.addEventListener("click", closeDrawer);
      document.body.appendChild(s);
    }
    return s;
  }
  function openDrawer() {
    rail.classList.add("grail-open"); rail.style.removeProperty("bottom");
    if (opener) opener.setAttribute("hidden", "");
    _scrim().classList.add("grail-scrim-on");
  }
  function closeDrawer() {
    rail.classList.remove("grail-open"); _refreshOpener();
    var s = document.getElementById("grail-scrim");
    if (s) s.classList.remove("grail-scrim-on");
  }

  var _toggle = document.getElementById("gadget-rail-toggle");
  if (_toggle) _toggle.addEventListener("click", toggleCollapsed);
  var _swap = document.getElementById("gadget-rail-swap");
  if (_swap) _swap.addEventListener("click", toggleSide);
  var _close = document.getElementById("gadget-rail-close");
  if (_close) _close.addEventListener("click", closeDrawer);
  if (opener) opener.addEventListener("click", openDrawer);

  // Focus a specific gadget: expand the rail (desktop strip click) and bring the gadget into
  // view, then move focus to it. On mobile the body is already open, so we just scroll/focus.
  function focusGadget(id) {
    expand();
    var el = document.getElementById(id);
    if (!el) return;
    // After expand the body becomes scrollable; defer so layout settles first.
    window.requestAnimationFrame(function () {
      try { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (_) {}
      // a brief highlight so the eye lands on the right gadget. TX-5: cancel any in-flight flash and
      // restart the animation (re-adding a present class won't restart a CSS animation), so a rapid
      // repeat focus re-flashes instead of being cut short by the previous click's timer.
      if (el._grailFlashTimer) clearTimeout(el._grailFlashTimer);
      el.classList.remove("grail-focus-flash");
      void el.offsetWidth; // force reflow so the keyframes can re-trigger
      el.classList.add("grail-focus-flash");
      el._grailFlashTimer = setTimeout(function () { el.classList.remove("grail-focus-flash"); el._grailFlashTimer = null; }, 900);
      // #837: this is a CLICK-driven deep-link, not keyboard Tab — land focus on the
      // ring-free gadget CONTAINER so it does NOT paint the .og-head :focus-visible ring on
      // arrival. A temporary tabindex=-1 makes the card a programmatic-focus target (out of
      // the Tab order, ring-free via [tabindex="-1"]:focus); cleaned up on blur so it never
      // collides with edit-mode's own tabindex management. A keyboard Tab to the header still
      // rings (keyboard intent preserved).
      try {
        var hadTab = el.hasAttribute("tabindex");
        if (!hadTab) {
          el.setAttribute("tabindex", "-1");
          el.addEventListener("blur", function clean() {
            if (!el.classList.contains("grail-dragging")) el.removeAttribute("tabindex");
            el.removeEventListener("blur", clean);
          }, { once: true });
        }
        el.focus({ preventScroll: true });
      } catch (_) { try { el.focus(); } catch (_) {} }
    });
  }

  // tap outside the drawer closes it (mobile). Escape dismissal flows through ui.js's
  // single arbiter (the F3 ratchet forbids per-surface Escape handlers) — the × button +
  // tap-outside cover the drawer's close paths.
  document.addEventListener("click", function (e) {
    if (!rail.classList.contains("grail-open")) return;
    if (rail.contains(e.target) || (opener && opener.contains(e.target))) return;
    closeDrawer();
  });

  // ── the COLLAPSED ICON STRIP — derived from the registry, 1:1 with live gadgets ──
  // The strip is rebuilt from the registry, filtered to the gadgets that are actually
  // mounted-and-visible right now, in the rail's CURRENT visual order (so a per-user drag
  // reorder reflects in the strip too). Each icon carries its gadget id and acts on THAT
  // gadget — never a blanket expand, never an icon for a gadget that isn't showing.
  function _elVisible(el) {
    if (!el) return false;
    try { return getComputedStyle(el).display !== "none"; } catch (_) { return true; }
  }
  // The ids of currently mounted-and-visible registry gadgets, in the rail's visual order.
  function activeGadgetIds() {
    return currentOrderIds().filter(function (id) {
      return REG_BY_ID[id] && _elVisible(document.getElementById(id));
    });
  }
  function syncStrip() {
    if (!strip) return;
    var ids = activeGadgetIds();
    // Rebuild only when the set/order actually changed (cheap idempotent guard; avoids
    // thrashing focus or the DOM under the MutationObserver).
    if (strip.dataset.gadgetIds === ids.join(",")) return;
    strip.dataset.gadgetIds = ids.join(",");
    strip.textContent = "";
    ids.forEach(function (id) {
      var g = REG_BY_ID[id];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "grail-ico ow-btn ow-btn-icon";
      b.setAttribute("data-grail-gadget", id);
      b.title = g.title;
      b.setAttribute("aria-label", g.title);
      // #8/#9: render the SVG line icon (consistent with the app's icon language); fall back to
      // the registry emoji only if an id somehow lacks an SVG entry (keeps a label visible).
      if (SVG_ICON[id]) b.innerHTML = SVG_ICON[id];
      else b.textContent = g.icon;
      b.addEventListener("click", function () { focusGadget(id); });
      strip.appendChild(b);
    });
  }

  // ── visibility is CONTENT-DRIVEN (robust; no status-fetch race) ────────────
  // The HUD gadgets self-gate: they set display:none when they have nothing to show and
  // display:block when a game is live. The rail shows exactly when at least one gadget
  // has visible content (a child whose OWN computed display isn't none — that holds even
  // while the rail itself is hidden), and hides when the rail is empty. This is what the
  // browser-smoke keep-set drives (it injects chips, then expects the rail visible).
  function _isNarrow() { return window.matchMedia("(max-width: 768px)").matches; }
  // #573 B — RAIL UNIFICATION: the "Windows" chip dock (modalManager) is homed into #gadget-rail
  // in the game build, as a SIBLING of #gadget-rail-body. A minimized window's chip must keep the
  // control room open (or a parked window would be stranded behind the content-driven hide when no
  // gadget has content), so the dock's presence counts as content. It is a rail CHILD but NOT a
  // body child, so it never enters the gadget order/drag/strip machinery below.
  function _dockHasParkedChips() {
    var d = document.getElementById("minimized-dock");
    return !!(d && rail.contains(d) && d.classList.contains("ow-has-rows"));
  }
  function _hasContent() {
    if (_dockHasParkedChips()) return true;   // #573 B: a parked window's chip keeps the rail open
    if (!body) return false;
    return Array.prototype.some.call(body.children, function (c) {
      return _elVisible(c);
    });
  }
  function _refreshOpener() {
    if (!opener) return;
    var show = !rail.hasAttribute("hidden") && _isNarrow() && !rail.classList.contains("grail-open");
    if (show) opener.removeAttribute("hidden"); else opener.setAttribute("hidden", "");
  }
  // ── #740: the COMPOSER-OVERLAP GUARD ───────────────────────────────────────
  // The composer (.chat-input-bar) is "the conversation is the game" — it must never be
  // occluded by a rail/pin card. The desktop rail is an in-FLOW flex column (clears the
  // composer by construction) and the mobile drawer is a deliberate full-height slide-over
  // (you open it ON PURPOSE; tap-outside / × close it). The bug class this guards is a rail
  // that has somehow gone FLOATING (computed position fixed/absolute) yet is NOT the open
  // drawer — e.g. an orphaned/half-styled state — and so its card sits over the composer
  // bottom-right. In that case lift it to clear the composer's top edge. A purely in-flow
  // rail (the normal desktop case) and the intentionally-open drawer are both left alone, so
  // this is a no-op in every healthy state. Done in JS (no style.css edit) and idempotent.
  function _composerRect() {
    var c = document.querySelector(".chat-input-bar");
    if (!c) return null;
    var cs = window.getComputedStyle(c);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    var r = c.getBoundingClientRect();
    return (r.width > 0 && r.height > 0) ? r : null;
  }
  function _intersects(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }
  function _clearGuard() {
    rail.style.removeProperty("bottom");
    // Only release the `top` override if WE set it (auto) — never stomp a real inline top.
    if (rail.style.top === "auto") rail.style.removeProperty("top");
  }
  function guardComposerOverlap() {
    if (!rail || rail.hasAttribute("hidden")) return;
    // The mobile drawer is a deliberate modal overlay — opening it over the composer is the
    // intended behavior (it is dismissed by tap-outside / ×), so never fight it.
    if (rail.classList.contains("grail-open")) { _clearGuard(); return; }
    var cs;
    try { cs = window.getComputedStyle(rail); } catch (_) { return; }
    var floating = cs.position === "fixed" || cs.position === "absolute";
    if (!floating) { _clearGuard(); return; } // in-flow column: can't overlap
    var comp = _composerRect();
    if (!comp) { _clearGuard(); return; }
    var rr = rail.getBoundingClientRect();
    if (rr.width <= 0 || rr.height <= 0) return;
    if (_intersects(rr, comp)) {
      // Lift the floating rail so its bottom clears the composer's top edge (+ a small gap).
      // Anchor by `bottom` (and release any `top`, or top would win on a fixed element and the
      // bottom we set would be ignored — the rail would stay painting over the composer).
      var clear = Math.max(0, Math.round(window.innerHeight - comp.top) + 8);
      rail.style.top = "auto";
      rail.style.bottom = clear + "px";
    } else {
      _clearGuard();
    }
  }

  function syncVisibility() {
    if (_hasContent()) rail.removeAttribute("hidden");
    else { rail.setAttribute("hidden", ""); rail.classList.remove("grail-open"); }
    _refreshOpener();
    syncStrip();  // the strip must always track what's mounted-and-visible
    guardComposerOverlap();  // #740: never let a floating rail card sit over the composer
  }
  if (body && window.MutationObserver) {
    // ORW-157: already scoped to #gadget-rail-body (NOT document.body, as the audit first read it), so a streamed
    // token does not wake it; but its callback ran forced-layout reads (getComputedStyle per gadget,
    // getBoundingClientRect) SYNCHRONOUSLY on every batch (a gadget refreshing its card fires a burst). Coalesce
    // to at most one sync per animation frame. The 4 s fallback + events below are unchanged.
    var _railSyncRaf = 0;
    var _railSyncTimer = 0;
    var _railSyncRun = function () {
      if (!_railSyncRaf && !_railSyncTimer) return;
      if (_railSyncRaf && window.cancelAnimationFrame) window.cancelAnimationFrame(_railSyncRaf);
      clearTimeout(_railSyncTimer);
      _railSyncRaf = 0; _railSyncTimer = 0;
      syncVisibility();
    };
    var _obs = new MutationObserver(function () {
      if (_railSyncRaf || _railSyncTimer) return;
      if (window.requestAnimationFrame) _railSyncRaf = window.requestAnimationFrame(_railSyncRun);
      _railSyncTimer = setTimeout(_railSyncRun, 120);
    });
    _obs.observe(body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["style", "class", "hidden"] });
  }
  window.addEventListener("orwell:gamechanged", syncVisibility);
  // #573 B: modalManager fires this when the parked-chip set changes (a window minimized/restored/
  // closed) so the control room reveals a freshly-parked chip and re-hides once the last one clears.
  window.addEventListener("orwell:dock-changed", syncVisibility);
  window.addEventListener("resize", function () { _refreshOpener(); guardComposerOverlap(); });
  setInterval(syncVisibility, 4000);  // belt-and-suspenders fallback
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", syncVisibility, { once: true });
  } else { syncVisibility(); }

  // ── L13: drag-reorder the rail gadgets (persisted, keyboard-accessible) ─────
  // The gadgets self-mount into #gadget-rail-body and lay out by `order`. The registry
  // supplies the canonical base order (as inline `order`); a per-user drag reorder overrides
  // it and persists under 'orwell-gadget-order:<user>'. After any reorder the collapsed strip
  // re-derives, so the strip order follows the rail order. Reordering never touches a gadget's
  // own content or focus.
  // Per-user key, fail-closed (R5/#1416): null when there is no data-user identity, so the order
  // is not persisted to a shared "" namespace (the synced 0064 layout store, keyed server-side by
  // the authed session, remains the cross-device source of truth regardless).
  function _orderKey() {
    return (window.orwellUserKey && window.orwellUserKey("orwell-gadget-order")) || null;
  }
  function loadOrder() {
    var k = _orderKey();
    if (!k) return [];
    try { var v = JSON.parse(lsGet(k) || "null"); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
  }
  function saveOrder(ids) {
    var k = _orderKey();
    if (k) lsSet(k, JSON.stringify(ids));   // offline/seed fallback (per-device)
    // #637: the SYNCED value is the source of truth — persist the order through the 0064 layout
    // store (LWW, fanned out via `layout-changed`) so it crosses devices and mirrors between two
    // windows. localStorage stays as the offline fallback the synced value lands into.
    try {
      window.dispatchEvent(new CustomEvent("orwell:window-layout",
        { detail: { id: "gadget-rail", state: { order: Array.isArray(ids) ? ids.slice() : [] } } }));
    } catch (_) {}
  }

  // #637: apply a synced order arriving from the layout store (initial seed OR a peer window).
  // Land it into the local fallback key WITHOUT re-emitting (saveOrder would echo), then re-apply.
  var _applyingSyncedOrder = false;
  function applySyncedOrder(ids) {
    if (_applyingSyncedOrder || !Array.isArray(ids) || !ids.length) return;
    var cur = loadOrder();
    if (JSON.stringify(cur) === JSON.stringify(ids)) { applyOrder(); return; }  // already in step
    _applyingSyncedOrder = true;
    try {
      var k = _orderKey();
      if (k) lsSet(k, JSON.stringify(ids));
      applyOrder();
      syncStrip();
    } finally { _applyingSyncedOrder = false; }
  }
  function _onSyncedLayout(e) {
    var d = e && e.detail;
    if (!d || d.windowId !== "gadget-rail" || !d.state) return;
    if (Array.isArray(d.state.order)) applySyncedOrder(d.state.order);
  }
  window.addEventListener("orwell:layout-seed", _onSyncedLayout);     // initial GET /layout
  window.addEventListener("orwell:layout-changed", _onSyncedLayout);  // a peer window / device

  function gadgets() {
    if (!body) return [];
    return Array.prototype.filter.call(body.children, function (c) { return c.id; });
  }

  // Apply the order as inline `order`. Precedence: the per-user saved order first, then the
  // registry's canonical order for anything unsaved, then anything else (non-registry probes)
  // after that — all stable and 1-based so CSS `order` rules never fight us.
  function applyOrder() {
    var saved = loadOrder();
    var canon = registryIds();
    function rank(id) {
      var i = saved.indexOf(id);
      if (i !== -1) return i + 1;                 // saved: 1..N (highest precedence)
      var j = canon.indexOf(id);
      if (j !== -1) return 100 + j;               // registry order: after saved
      return 900;                                  // unknown (e.g. a test probe): last
    }
    gadgets().forEach(function (el) { el.style.order = String(rank(el.id)); });
  }

  // The current visual order of gadget ids (by computed `order`, then DOM order).
  function currentOrderIds() {
    var list = gadgets();
    return list
      .map(function (el, idx) { return { id: el.id, ord: parseFloat(getComputedStyle(el).order) || 0, idx: idx }; })
      .sort(function (a, b) { return a.ord - b.ord || a.idx - b.idx; })
      .map(function (e) { return e.id; });
  }

  // Persist + apply a new full order (the public seam + the drop/keyboard paths).
  function reorder(ids) {
    var present = gadgets().map(function (el) { return el.id; });
    // keep only real gadget ids, then append any present gadget the caller omitted
    var clean = ids.filter(function (id) { return present.indexOf(id) !== -1; });
    present.forEach(function (id) { if (clean.indexOf(id) === -1) clean.push(id); });
    saveOrder(clean);
    applyOrder();
    syncStrip();  // the collapsed strip follows the new order
  }

  // Move one gadget id before/after another (keyboard + drop helper).
  function moveRelative(dragId, targetId, after) {
    var order = currentOrderIds();
    var from = order.indexOf(dragId);
    if (from === -1) return;
    order.splice(from, 1);
    var to = order.indexOf(targetId);
    if (to === -1) to = order.length;
    order.splice(after ? to + 1 : to, 0, dragId);
    reorder(order);
  }
  function nudge(id, dir) {
    var order = currentOrderIds();
    var i = order.indexOf(id);
    if (i === -1) return;
    var j = i + dir;
    if (j < 0 || j >= order.length) return;
    var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    reorder(order);
  }

  // ── Rearrange ("edit") mode — iOS jiggle / Home-Assistant dashboard-edit, for touch + mouse ──
  // The old per-gadget hover grip floated over each gadget's bottom-left and BLOCKED its content
  // (and HTML5 drag-and-drop never worked on touch). Instead: a deliberate edit mode you ENTER
  // (long-press a gadget, or the header's ⠿ Rearrange button), in which gadgets WIGGLE and the
  // WHOLE gadget is grab-draggable via Pointer Events (one code path for touch + mouse). Content
  // interaction is suspended while editing (you're rearranging, not using, the gadgets). Exit with
  // the Done toggle, Escape, or a tap outside. Keyboard a11y: in edit mode gadgets are focusable and
  // ↑/↓ move them. No persistent overlay ⇒ the overlap is gone by construction.
  var _edit = false;
  var _editBtn = document.getElementById("gadget-rail-rearrange");
  var _drag = null;                                   // active drag { id, el, pointerId }
  var _lp = null, _lpTimer = null;                    // long-press arming
  var LP_MS = 480, MOVE_TOL = 10;

  function _canEdit() { return rail.getAttribute("data-collapsed") !== "true" && gadgets().length > 1; }

  function enterEdit() {
    if (_edit || !_canEdit()) return;
    _edit = true;
    rail.setAttribute("data-edit", "true");
    if (_editBtn) { _editBtn.setAttribute("aria-pressed", "true"); _editBtn.title = "Done rearranging"; }
    gadgets().forEach(function (el) { el.tabIndex = 0; });
  }
  function exitEdit() {
    if (!_edit) return;
    _edit = false;
    rail.removeAttribute("data-edit");
    if (_editBtn) { _editBtn.setAttribute("aria-pressed", "false"); _editBtn.title = "Rearrange gadgets"; }
    _clearDrag();
    gadgets().forEach(function (el) { el.removeAttribute("tabindex"); el.classList.remove("grail-dragging"); });
  }
  function toggleEdit() { _edit ? exitEdit() : enterEdit(); }
  if (_editBtn) _editBtn.addEventListener("click", function (e) { e.stopPropagation(); toggleEdit(); });

  function _gadgetOf(node) {
    while (node && node !== body && node.parentNode !== body) node = node.parentNode;
    return (node && node.parentNode === body && node.id) ? node : null;
  }
  function _gadgetFromPoint(x, y) {
    // #798: while dragging, the grabbed gadget is translated UNDER the finger (transform +
    // z-index:5), so a naive elementFromPoint here returns the DRAGGED gadget itself — the
    // hit-test never sees the gadget being hovered, so `over === _drag.el` every time and the
    // drop never reorders. Make the dragged element transparent to hit-testing for the probe so
    // elementFromPoint resolves to the gadget BENEATH it.
    var lifted = (_drag && _drag.el) ? _drag.el : null;
    var prevPE = lifted ? lifted.style.pointerEvents : null;
    if (lifted) lifted.style.pointerEvents = "none";
    var hit;
    try { hit = document.elementFromPoint(x, y); }
    finally { if (lifted) { if (prevPE) lifted.style.pointerEvents = prevPE; else lifted.style.removeProperty("pointer-events"); } }
    var g = _gadgetOf(hit);
    if (g && (!lifted || g !== lifted)) return g;
    // Pointer is in a gap (inter-gadget margin / rail padding) — resolve to the nearest gadget by
    // vertical center so a drop between gadgets still reorders. Skip the dragged gadget itself so
    // we resolve to a real drop TARGET (otherwise the nearest is the grabbed card = a no-op).
    var best = null, bestD = Infinity;
    Array.prototype.forEach.call(body.children, function (c) {
      if (!c.id) return;
      if (lifted && c === lifted) return;
      var r = c.getBoundingClientRect();
      var d = Math.abs((r.top + r.bottom) / 2 - y);
      if (d < bestD) { bestD = d; best = c; }
    });
    return best;
  }
  function _clearDropHints() {
    Array.prototype.forEach.call(body.children, function (c) { c.classList.remove("grail-drop-into"); });
  }
  // #654 — settle/snap the dropped gadget back into its slot: clear the follow-finger
  // translate and run the brief settle transition (.grail-settling), then strip both the
  // drag + settle classes once it has landed. Reduced motion ⇒ no settle animation, just
  // an immediate reset (the CSS .grail-settling rule is no-op'd under reduce).
  function _settleDrop(el) {
    if (!el) return;
    el.style.removeProperty("--grail-dy");
    el.classList.remove("grail-dragging");
    el.classList.add("grail-settling");
    if (el._grailSettleTimer) clearTimeout(el._grailSettleTimer);
    el._grailSettleTimer = setTimeout(function () {
      el.classList.remove("grail-settling");
      el._grailSettleTimer = null;
    }, 220);
  }
  function _clearDrag(settle) {
    if (_drag) {
      try { _drag.el.releasePointerCapture(_drag.pointerId); } catch (_) {}
      if (settle) _settleDrop(_drag.el);
      else { _drag.el.style.removeProperty("--grail-dy"); _drag.el.classList.remove("grail-dragging"); }
    }
    _clearDropHints();
    _drag = null;
  }
  function _beginDrag(el, e) {
    // PICK-UP: capture the grab origin so the move can translate the gadget under the
    // finger; lifting (scale + shadow) is the .grail-dragging treatment.
    _drag = { id: el.id, el: el, pointerId: e.pointerId, startY: e.clientY };
    el.classList.remove("grail-settling");
    if (el._grailSettleTimer) { clearTimeout(el._grailSettleTimer); el._grailSettleTimer = null; }
    el.style.setProperty("--grail-dy", "0px");
    el.classList.add("grail-dragging");
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
  }

  body.addEventListener("pointerdown", function (e) {
    if (e.button != null && e.button > 0) return;       // primary button / touch / pen only
    var el = _gadgetOf(e.target);
    if (!el) return;
    if (_edit) { _beginDrag(el, e); return; }            // already editing → grab to drag
    // Not editing: arm a long-press, but never hijack a tap on a real control.
    if (e.target.closest('button, a, input, textarea, select, label, [role="button"], [contenteditable]')) return;
    _lp = { x: e.clientX, y: e.clientY };
    clearTimeout(_lpTimer);
    _lpTimer = setTimeout(function () { _lpTimer = null; if (_lp) { _lp = null; enterEdit(); } }, LP_MS);
  });
  body.addEventListener("pointermove", function (e) {
    if (_lp && (Math.abs(e.clientX - _lp.x) > MOVE_TOL || Math.abs(e.clientY - _lp.y) > MOVE_TOL)) {
      clearTimeout(_lpTimer); _lpTimer = null; _lp = null;   // moved → a scroll, not a long-press
    }
    if (!_drag) return;
    e.preventDefault();
    // MOVE: the grabbed gadget tracks the finger 1:1 via --grail-dy (no transition while
    // dragging, set in CSS), so it visibly follows the touch as it moves up/down the rail.
    _drag.el.style.setProperty("--grail-dy", (e.clientY - _drag.startY) + "px");
    var over = _gadgetFromPoint(e.clientX, e.clientY);
    _clearDropHints();
    if (over && over !== _drag.el) over.classList.add("grail-drop-into");
  });
  function _endPointer(e) {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
    _lp = null;
    if (!_drag) return;
    var over = _gadgetFromPoint(e.clientX, e.clientY);
    if (over && over !== _drag.el && over.id) {
      var r = over.getBoundingClientRect();
      moveRelative(_drag.id, over.id, e.clientY > r.top + r.height / 2);
    }
    _clearDrag(true);  // DROP: settle/snap back into the slot
  }
  body.addEventListener("pointerup", _endPointer);
  body.addEventListener("pointercancel", function () {
    if (_lpTimer) { clearTimeout(_lpTimer); _lpTimer = null; }
    _lp = null; _clearDrag(true);
  });
  // Keyboard reorder while editing (accessible): arrows move the focused gadget; Esc leaves.
  body.addEventListener("keydown", function (e) {
    if (!_edit) return;
    var el = _gadgetOf(e.target);
    if (!el) return;
    if (e.key === "ArrowUp") { e.preventDefault(); nudge(el.id, -1); el.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); nudge(el.id, 1); el.focus(); }
  });
  // Leave edit mode on a pointer down outside the rail (iOS: tap the wallpaper). Escape is NOT
  // handled here — it flows through ui.js's single arbiter (F3 ratchet); Done / tap-outside exit.
  document.addEventListener("pointerdown", function (e) {
    if (_edit && !rail.contains(e.target)) exitEdit();
  }, true);

  function ensureDragCss() {
    if (document.getElementById("grail-drag-css")) return;
    var st = document.createElement("style");
    st.id = "grail-drag-css";
    st.textContent =
      ".gadget-rail-body > * { position: relative; }" +
      // EDIT MODE: a gentle iOS-style wiggle + grab affordance; gadget CONTENT goes inert so a drag
      // never taps into a gadget. No persistent overlay — nothing covers content during normal use.
      '.gadget-rail[data-edit="true"] .gadget-rail-body > * {' +
      "  animation: grail-wiggle .34s ease-in-out infinite; cursor: grab;" +
      "  touch-action: none; -webkit-user-select: none; user-select: none; }" +
      // stagger the wiggle so they don't move in lockstep (more alive / iOS-like)
      '.gadget-rail[data-edit="true"] .gadget-rail-body > *:nth-child(2n) { animation-delay: -.11s; }' +
      '.gadget-rail[data-edit="true"] .gadget-rail-body > *:nth-child(3n) { animation-delay: -.21s; }' +
      '.gadget-rail[data-edit="true"] .gadget-rail-body > * > * { pointer-events: none; }' +
      // #654 — touch reorder PICK-UP → MOVE → DROP. The grabbed gadget lifts (scale + lift
      // shadow), then follows the finger via the JS-set --grail-dy translate; transition is
      // OFF while dragging so it tracks the pointer 1:1. On release .grail-settling animates
      // the lift away as it lands back in its slot (the snap/settle).
      ".grail-dragging { animation: none !important; opacity: .92; cursor: grabbing;" +
      "  transform: translateY(var(--grail-dy, 0px)) scale(1.04); z-index: 5;" +
      "  box-shadow: 0 14px 32px rgba(0,0,0,.45); transition: none; }" +
      ".grail-settling { transition: transform .2s cubic-bezier(.22,.61,.36,1), box-shadow .2s ease;" +
      "  transform: translateY(0) scale(1); box-shadow: none; z-index: 5; }" +
      ".grail-drop-into { outline: 2px dashed color-mix(in srgb, var(--accent, #e06c75) 75%, transparent);" +
      "  outline-offset: -2px; border-radius: 10px; }" +
      "@keyframes grail-wiggle { 0%,100% { transform: rotate(-.55deg); } 50% { transform: rotate(.55deg); } }" +
      // a brief highlight when a collapsed strip icon focuses its gadget
      ".grail-focus-flash { animation: grail-focus-flash .9s ease; }" +
      "@keyframes grail-focus-flash { 0%,100% { box-shadow: none; } 20%,60% {" +
      "  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #e06c75) 60%, transparent); } }" +
      // reduced motion: no wiggle — a steady dashed outline signals 'editable' instead — and
      // the touch-reorder lift/move/settle drops its scale + settle transition (#654): the
      // grabbed gadget still follows the finger (the translate is the functional drag cue) but
      // never scales or springs.
      "@media (prefers-reduced-motion: reduce) {" +
      '  .gadget-rail[data-edit="true"] .gadget-rail-body > * { animation: none;' +
      "    outline: 1px dashed color-mix(in srgb, var(--fg) 35%, transparent); outline-offset: -2px; }" +
      "  .grail-dragging { transform: translateY(var(--grail-dy, 0px)); }" +
      "  .grail-settling { transition: none; transform: translateY(0); } }" +
      // the collapsed icon-strip is never editable here
      '.gadget-rail[data-collapsed="true"] .gadget-rail-body > * { animation: none; }';
    document.head.appendChild(st);
  }

  function decorateAll() {
    if (!body) return;
    ensureDragCss();
    applyOrder();
    syncStrip();
    // If the rail collapsed or dropped below 2 gadgets while editing, leave edit mode cleanly.
    if (_edit && !_canEdit()) exitEdit();
    // Keep gadgets focusable for keyboard reorder while a fresh one mounts mid-edit.
    if (_edit) gadgets().forEach(function (el) { if (!el.hasAttribute("tabindex")) el.tabIndex = 0; });
  }

  // keep handles + order applied as gadgets mount/unmount
  if (body && window.MutationObserver) {
    var _reobs = new MutationObserver(function () { decorateAll(); });
    _reobs.observe(body, { childList: true });
  }
  window.addEventListener("orwell:gamechanged", decorateAll);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", decorateAll, { once: true });
  } else { decorateAll(); }

  // ── width drag-resize (desktop, persisted + clamped) ───────────────────────
  // A thin grab-handle on the rail's INNER edge (the chat-facing edge) drives the
  // rail's `--gadget-rail-width` (applied inline on #gadget-rail). The width is
  // clamped to a sane range and persisted under WIDTH_KEY. Honors side-swap: on the
  // right the handle is on the LEFT edge and dragging LEFT widens; under side-swap the
  // rail is on the LEFT, the handle is on its RIGHT edge, and dragging RIGHT widens.
  // The handle is hidden (CSS) when collapsed and on the mobile drawer.
  var WIDTH_KEY = "orwell-gadget-rail-width";
  var MIN_W = 220;
  function maxW() { return Math.min(520, Math.round(window.innerWidth * 0.40)); }
  function clampW(w) {
    var hi = maxW();
    var lo = Math.min(MIN_W, hi);  // never let min exceed max on tiny viewports
    if (!isFinite(w)) return null;
    return Math.max(lo, Math.min(hi, Math.round(w)));
  }
  function readSavedWidth() {
    var raw = lsGet(WIDTH_KEY);
    if (raw == null) return null;
    var n = parseFloat(raw);
    if (!isFinite(n)) return null;   // reject NaN / garbage
    return clampW(n);
  }
  function applyWidth(w) {
    var c = clampW(w);
    if (c == null) return;
    rail.style.setProperty("--gadget-rail-width", c + "px");
    _syncResizeAria(c);
  }
  // F-NEW-9: keep the slider's reported value (+ its viewport-relative max) in sync with the
  // current rail width so AT announces the real number as the player nudges/drags it.
  function _syncResizeAria(c) {
    if (!resizeHandle) return;
    var w = clampW(c == null ? currentWidth() : c);
    if (w == null) return;
    resizeHandle.setAttribute("aria-valuenow", String(w));
    resizeHandle.setAttribute("aria-valuemax", String(maxW()));
    resizeHandle.setAttribute("aria-valuetext", w + " pixels");
  }
  function persistWidth(w) {
    var c = clampW(w);
    if (c == null) return;
    lsSet(WIDTH_KEY, String(c));
  }

  // restore the saved width on init (no-op when nothing valid is stored → CSS default)
  (function restoreWidth() {
    var w = readSavedWidth();
    if (w != null) applyWidth(w);
  })();

  // the handle element (created here so the markup stays minimal)
  var resizeHandle = null;
  function ensureResizeHandle() {
    if (resizeHandle && rail.contains(resizeHandle)) return resizeHandle;
    resizeHandle = document.createElement("div");
    // #1638 G7: dual-class — the `.ow-resize-handle` KIT primitive owns the grip LOOK (hit strip,
    // 2px neutral glass-rim bar, system-blue focus); `.gadget-rail-resize-handle` keeps only the
    // consumer's edge anchor + hide-when-collapsed overrides.
    resizeHandle.className = "ow-resize-handle gadget-rail-resize-handle";
    // F-NEW-9: this handle is keyboard-OPERATED (arrows nudge the width), so it is a slider,
    // not a non-interactive separator. role="slider" + the value range lets AT announce the
    // current width and that it's adjustable.
    resizeHandle.setAttribute("role", "slider");
    resizeHandle.setAttribute("aria-orientation", "vertical");
    resizeHandle.setAttribute("aria-label", "Resize the control room");
    resizeHandle.setAttribute("aria-valuemin", String(MIN_W));
    resizeHandle.setAttribute("tabindex", "0");
    rail.appendChild(resizeHandle);
    wireResize(resizeHandle);
    _syncResizeAria();
    return resizeHandle;
  }

  function isResizable() {
    // desktop only, and not while collapsed to the icon strip
    if (_isNarrow()) return false;
    if (rail.getAttribute("data-collapsed") === "true") return false;
    return true;
  }
  function railLeftSide() {
    return document.body.getAttribute("data-gadget-side") === "left";
  }
  function currentWidth() {
    return rail.getBoundingClientRect().width || 300;
  }

  function wireResize(handle) {
    var dragging = false;
    var startX = 0;
    var startW = 0;
    function onMove(e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      // On the RIGHT (handle on the left edge): dragging LEFT (dx<0) widens.
      // Under side-swap on the LEFT (handle on the right edge): dragging RIGHT (dx>0) widens.
      var next = railLeftSide() ? startW + dx : startW - dx;
      applyWidth(next);
    }
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      rail.classList.remove("grail-resizing");
      handle.classList.remove("is-active");   // #1638 G7: drop the kit bar-paint on release/cancel/abort
      try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", endDrag);
      handle.removeEventListener("pointercancel", endDrag);
      persistWidth(currentWidth());
    }
    handle.addEventListener("pointerdown", function (e) {
      if (!isResizable()) return;
      if (e.button != null && e.button !== 0) return;  // primary button only
      dragging = true;
      startX = e.clientX;
      startW = currentWidth();
      rail.classList.add("grail-resizing");
      handle.classList.add("is-active");   // #1638 G7: paint the kit active-drag bar
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", endDrag);
      handle.addEventListener("pointercancel", endDrag);
      e.preventDefault();
    });
    // keyboard a11y: arrows nudge the width (sense follows the side so it feels natural)
    handle.addEventListener("keydown", function (e) {
      if (!isResizable()) return;
      var step = e.shiftKey ? 32 : 12;
      var dir = 0;
      if (e.key === "ArrowLeft") dir = -1;
      else if (e.key === "ArrowRight") dir = 1;
      else return;
      e.preventDefault();
      // widen = grow toward the chat: LEFT on the right-side rail, RIGHT under side-swap
      var grow = railLeftSide() ? dir > 0 : dir < 0;
      var next = currentWidth() + (grow ? step : -step);
      applyWidth(next);
      persistWidth(currentWidth());
    });
  }

  ensureResizeHandle();
  // re-clamp the stored width if the viewport shrinks (max is viewport-relative)
  window.addEventListener("resize", function () {
    if (_isNarrow()) return;
    var w = clampW(currentWidth());
    if (w != null) { applyWidth(w); persistWidth(w); }
  });

  // ── #894 (RESP-15): DRAWER-ONLY HUD on the narrow tier ──────────────────────
  // On desktop the HUD lives in the docked rail, and a dockable kit window (The Cast /
  // The Finale / Season Recap) can be pulled OUT of the rail into a floating window via
  // its titlebar undock (⇱) toggle. On a phone that floating path is a second, confusing
  // HUD entry that occludes the chat — so disable the undock-to-float affordance on the
  // narrow tier: a HUD window docked in the drawer STAYS in the drawer, which makes the
  // drawer the single HUD surface. The dock-IN direction (⇲ — a floating/sheet window
  // docking INTO the rail) is deliberately left intact, since that only reduces surfaces.
  // CSS-only + idempotent: no kit-JS change (the rail owns the presentation of its own
  // docked children under #gadget-rail-body); the undock button is the kit's `.ow-dock`.
  function ensureNarrowHudCss() {
    if (document.getElementById("grail-narrow-hud-css")) return;
    var st = document.createElement("style");
    st.id = "grail-narrow-hud-css";
    st.textContent =
      "@media (max-width: 768px) {" +
      "  #gadget-rail-body .ow-docked .ow-dock { display: none !important; }" +
      "}";
    document.head.appendChild(st);
  }
  ensureNarrowHudCss();

  // public seam (the headless gate + any future control surface)
  window.OrwellGadgetRail = {
    reorder: reorder,
    currentOrder: currentOrderIds,
    // the registry + the live derivations (for the headless 1:1 assertion)
    registry: REGISTRY.map(function (g) { return { id: g.id, icon: g.icon, title: g.title, order: g.order }; }),
    activeGadgets: activeGadgetIds,
    stripGadgets: function () {
      if (!strip) return [];
      return Array.prototype.map.call(strip.querySelectorAll("[data-grail-gadget]"),
        function (b) { return b.getAttribute("data-grail-gadget"); });
    },
    focusGadget: focusGadget,
    // #740: re-run the composer-overlap guard on demand (the responsive-matrix gate calls this).
    guardComposerOverlap: guardComposerOverlap,
  };
})();
