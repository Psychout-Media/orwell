// Orwell cast roster (feature 0051 / C-FE) — a "who is who" reference panel.
//
// A standing sidebar button (alongside New Chat / Search / Diary Room, shown while a game is
// active) opens a roster panel: each houseguest's persisted portrait (or a graceful placeholder
// when none), their name, and their current status (active / jury / evicted). Evicted houseguests
// stay on the roster, visually dimmed.
//
// Vault-free by construction: it renders ONLY what GET /api/orwell/roster returns — name, status,
// and a portrait ref — which the route builds from the engine's Vault-free public projection. No
// stat, relationship, or hidden element ever reaches this surface. ADR 0003: it AUGMENTS the chat
// (a companion reference), never replaces an interaction; the game plays identically with no
// portraits (the placeholder + name + status card). Fail-open everywhere.
//
// G22: portraits STREAM in. Generation is a server-side background job — faces land one by one
// over several seconds — so the panel polls FAST while the roster reports a run in flight and
// upgrades each card IN PLACE (keyed by roster id) the moment its face lands. The old shape
// (a fixed 30s poll + a wholesale grid rebuild every tick) made the window feel dead: finished
// portraits sat unseen for up to half a minute, then all popped at once while every already-
// loaded image re-mounted (flicker).
(function () {
  "use strict";

  const BTN_ID = "sidebar-cast-btn";
  const PANEL_ID = "orwell-cast";
  // G22: adaptive poll cadence — FAST while a generation run is still landing portraits
  // (the roster reports imagesAvailable with portraitsPresent < portraitsTotal), the idle
  // cadence once the set is complete or no image provider is configured.
  const POLL_MS = 30000;
  const FAST_POLL_MS = 3500;

  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let _open = false;
  let _roles = {};          // M2-2: id -> public ceremony role (badges), refreshed with the roster
  let _timer = null;        // the ONE roster poll timer (a self-rescheduling setTimeout — G22)
  let _pollDelay = POLL_MS; // recomputed from the freshest roster counters after every render
  let _imagesAvailable = false;

  // ORW-165: roster/status come from the shared game-state store (one fetch + one snapshot for every panel).
  async function getJSON(url) {
    const kind = { "/api/orwell/roster": "roster", "/api/orwell/status": "status", "/api/orwell/state": "state" }[url];
    if (kind) return window.OrwellGame.get(kind);
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // --- the sidebar button (standing chrome, game-gated) -------------------------

  function ensureButton() {
    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;
    // Anchor next to the Diary Room button if present, else Search, else New Chat.
    const anchor = document.getElementById("sidebar-diary-room-btn")
      || document.getElementById("sidebar-search-btn")
      || document.getElementById("sidebar-new-chat-btn");
    if (!anchor || !anchor.parentElement) return null;
    btn = document.createElement("div");
    btn.className = "list-item";
    btn.id = BTN_ID;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.title = "Cast — the houseguests";
    // J2-19: give SR users the same descriptive name as the icon-rail twin (`#rail-cast` carries
    // aria-label="Cast — the houseguests"); without it the accessible name is just the text "Cast".
    btn.setAttribute("aria-label", "Cast — the houseguests");
    btn.style.display = "none"; // shown while a game is active
    btn.innerHTML = `
      <svg class="sidebar-action-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <span class="grow">Cast</span>`;
    const open = () => togglePanel(true);
    btn.addEventListener("click", open);
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    anchor.parentElement.insertBefore(btn, anchor.nextSibling);
    return btn;
  }

  async function refreshGate() {
    const btn = ensureButton();
    if (!btn) return;
    try {
      const st = await window.OrwellGame.get("state"); // ORW-165: the shared store's snapshot (non-ok rejects => the catch leaves the button as is)
      // L15: a 5xx/non-ok is a TRANSIENT engine hiccup (e.g. the per-user queue is busy
      // committing portraits) — leave the button as it is. Only a definitive, parseable
      // state answers the live/not-live question; an unreadable one never hides the cast or
      // closes an open panel (which is what made generation look like a dropped connection).
      if (!st || typeof st.started !== "boolean") return; // ambiguous → leave as-is
      const live = !!st.started;
      btn.style.display = live ? "" : "none";
      if (!live && _open) togglePanel(false);
    } catch (_) { /* engine hiccup: leave the button as it was (fail-open) */ }
  }

  // --- the panel ----------------------------------------------------------------

  // G10 (DWE / Lane G): the roster COMPOSES the window kit — it is a companion
  // reference (its own doc-comment), so it is a normal non-modal window: kit
  // titlebar (close + minimize), drag, slot placement, Escape-parks, dock chip,
  // and the one visual language. The old bespoke full-screen modal scrim and
  // hidden-attribute toggling are gone (an author display:flex rule silently
  // defeated that attribute — the close button never worked; root cause
  // recorded in the Lane G ledger).
  let _win = null;
  function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    const content = document.createElement("div");
    content.innerHTML = `
      <style>
        /* L11: a smaller, sensible default so the cast window doesn't dominate
           the screen — it is resizeable from any edge/corner (kit), and the
           chosen size persists under winsize-orwell-cast. */
        #orwell-cast {
          width: min(360px, 92vw);
          font-family: var(--mono, monospace);
          /* #894: the cast window is the responsive context for the gallery — columns-per-page
             adapt to ITS width (docked-in-rail narrow vs. a widened float), not the viewport. */
          container-type: inline-size;
          container-name: oc-win;
          /* #977 (regression fix): container-type:inline-size applies INLINE-SIZE CONTAINMENT —
             the element's width is computed WITHOUT regard to its contents. The kit's resize-cap
             (#896, windowResize.js naturalContentWidth) measures the window at width:max-content
             to learn how wide the content genuinely wants; a size-contained box reports ~0 there, so
             the cap collapsed to min(content~0, viewport) = the kit minimum and the window could no
             longer be dragged wider (the gallery's responsive @container reflow itself stayed intact —
             only the OUTER window stopped growing, which froze the reflow at the default 2 columns).
             contain-intrinsic-size is the standard companion to size containment: it supplies the
             placeholder size a contained box reports for intrinsic sizing, so naturalContentWidth
             reads a real "this gallery can use up to ~720px" want (covering the 1->4-column @container
             range below, the widest breakpoint being >=620px) WITHOUT pinning the live floor — the
             kit's inline width still governs the rendered size, so the window resizes freely from the
             kit minimum up to this content cap and the gallery reflows column-count as it grows. */
          contain-intrinsic-size: auto 720px;
        }
        /* M4-1 (audit C4 — the "2×2-dots" finding): the cast roster is a FULL, wrapping grid —
           every houseguest visible without paging (the window body scrolls VERTICALLY, via the
           kit's own .ow-body overflow:auto rule, when the roster outgrows the visible height).
           --oc-cols keeps driving columns-per-row (responsive via the SAME @container tiers
           below — narrower at a docked-in-rail width, wider on a widened float), just as a WRAP
           row count instead of a page-column count; the keyed in-place upsert + deterministic
           reorder (appendChild() in tier order) is untouched — flow direction/wrap is purely a
           layout property, the DOM order is identical. */
        #orwell-cast .oc-grid {
          --oc-cols: 2;
          --oc-gap: .6rem;
          display: grid;
          grid-template-columns: repeat(var(--oc-cols), 1fr);
          gap: var(--oc-gap);
        }
        /* M3-6-ready: every cast tile is a door — the whole card is a keyboard-operable
           button that opens the M4-1 dossier for that houseguest (see makeCard() below). */
        #orwell-cast .oc-hg {
          text-align: center; cursor: pointer; border-radius: 10px; padding: .1rem;
          transition: background-color .15s ease;
        }
        #orwell-cast .oc-hg:hover, #orwell-cast .oc-hg:focus-visible {
          background: rgba(255,255,255,.06);
        }
        #orwell-cast .oc-hg:focus-visible {
          outline: none; box-shadow: 0 0 0 2px var(--ow-ios-blue, #0a84ff);
        }
        /* #894/M4-1: intelligently responsive columns-per-row — keyed off the WINDOW width
           (container query), so a docked-in-rail narrow cast stays a single column, the normal
           float shows 2, and a widened float shows 3+. Never letterboxed. */
        @container oc-win (max-width: 240px) {
          #orwell-cast .oc-grid { --oc-cols: 1; }
        }
        @container oc-win (min-width: 480px) {
          #orwell-cast .oc-grid { --oc-cols: 3; }
        }
        @container oc-win (min-width: 620px) {
          #orwell-cast .oc-grid { --oc-cols: 4; }
        }
        /* #1638: aspect-ratio / radius / overflow now come from the shared .ow-portrait kit frame;
           the radius token pins the cast tier's 10px, the face/img inherit it. */
        #orwell-cast .oc-portrait {
          --ow-portrait-radius: 10px; width: 100%;
          background: rgba(255,255,255,.05); border: 1px solid var(--border, #355a66);
          display: flex; align-items: center; justify-content: center;
        }
        /* OWN-9: the photo LAYERS OVER the monogram base (setPortrait mounts both while a
           real portrait is in flight) — absolute so the monogram beneath keeps the square
           box; border-radius rides the holder's overflow:hidden clip. */
        #orwell-cast .oc-portrait img {
          width: 100%; height: 100%; object-fit: cover;
          position: absolute; inset: 0;
        }
        /* …and stays INVISIBLE until decoded (the reveal seam drops the class), so a slow,
           hung, or failing portrait request shows the designed monogram — never a bare grey
           holder, alt text, or the broken-image glyph. */
        #orwell-cast .oc-portrait img.oc-img-pending { opacity: 0; }
        /* G22: a just-landed face fades in gently… */
        @keyframes ocFadeIn { from { opacity: 0; } to { opacity: 1; } }
        #orwell-cast .oc-portrait img.oc-justin { animation: ocFadeIn .35s ease; }
        /* …unless the player prefers reduced motion. */
        @media (prefers-reduced-motion: reduce) {
          #orwell-cast .oc-portrait img.oc-justin { animation: none; }
        }
        #orwell-cast .oc-ph { font-size: 1.6rem; opacity: .45; }
        /* OWN-9: the no-kit legacy initial consumes the --oc-mono-hue tint again (the M2-2
           refactor had orphaned the var — no rule read it, so the kit-less fallback rendered
           a grey letter-tile). Deterministic name→hue; theme-independent (frosted AND flat). */
        #orwell-cast .oc-ph.oc-mono-fallback {
          display: flex; align-items: center; justify-content: center;
          background: linear-gradient(135deg,
            hsl(var(--oc-mono-hue, 200) 55% 34%), hsl(var(--oc-mono-hue, 200) 60% 17%));
          color: hsl(var(--oc-mono-hue, 200) 30% 94%);
          font-weight: 800;
        }
        /* J2-15 → M2-2: the per-houseguest placeholder is now the DESIGNED monogram from the
           shared OrwellMonogram kit (id-seeded gradient + pattern + initials — audit B3 killed
           the flat letter-rectangles). This block keeps only holder sizing; the template lives
           in orwellMonogram.js so the cast window, rail chips, and decision cards render the
           same card. Vault-free: seeded from the public id/name only. */
        #orwell-cast .oc-ph.oc-monogram { width: 100%; height: 100%; opacity: 1; display: block; }
        #orwell-cast .oc-portrait { position: relative; } /* M2-2: anchors the role badge */
        /* RESP-20 (#894): a portrait-LESS card must not dominate the mobile viewport. On the
           narrow tier the designed-monogram placeholder is capped to a compact, centered
           thumbnail — the docked rail can render a ≤240px 1-column tile, i.e. a viewport-filling
           gradient block. Real generated portraits are NOT capped (they lack .oc-portrait-ph):
           audit RESP-20 — "smaller placeholder tiles on narrow; reserve large tiles for real
           images". The flag rides setPortrait, so a card that streams in its face un-caps itself. */
        @media (max-width: 768px) {
          #orwell-cast .oc-portrait.oc-portrait-ph { max-width: min(88px, 26vw); margin-inline: auto; }
        }
        #orwell-cast .oc-name { margin-top: .35rem; font-size: .78rem; line-height: 1.25; word-break: break-word; }
        #orwell-cast .oc-name b { color: var(--fg, #9cdef2); }
        #orwell-cast .oc-status {
          margin-top: .15rem; font-size: var(--fs-2xs); letter-spacing: .04em; opacity: .65; text-transform: uppercase;
        }
        #orwell-cast .oc-hg.oc-out { opacity: .5; }
        /* L16: the ONLY monochrome state is EVICTION. An active OR jury houseguest
           keeps full-color portrait; an evicted one renders grayscale/monotone.
           (Jury is still dimmed via oc-out, just not desaturated.) */
        #orwell-cast .oc-hg.oc-evicted .oc-portrait img,
        #orwell-cast .oc-hg.oc-evicted .oc-portrait .ow-mono-svg { filter: grayscale(1); }
        #orwell-cast .oc-empty { opacity: .65; font-size: .8rem; line-height: 1.5; padding: .4rem 0; }
        /* L12: pin/un-pin the cast window into the right-side gadget rail. */
        #orwell-cast .oc-toolbar { display: flex; justify-content: flex-end; margin-bottom: .5rem; }
        /* #769 / #771 — the Compact-pin control is a FIRST-CLASS kit button. The markup
           carries .ow-btn .ow-btn-secondary, so on the glass tier it inherits the kit's
           shared material (translucent veil, specular rim, soft float shadow, dark legible
           chrome ink, NO accent on the label) by construction. This .oc-pin block carries
           only the pin-SPECIFIC overrides: the small Normal-tier control (no .ow-btn base
           exists off-glass), a sensible compact size, the monochrome glyph, and the
           toggled/active states. Apple-restrained: a small neutral capsule, not a tinted CTA. */
        #orwell-cast .oc-pin {
          cursor: pointer;
          /* #771 — a kit control uses the Apple UI SANS stack (exactly like every .ow-btn),
             NOT the cast window's inherited monospace. The stray font:inherit pulled in the
             window's ui-monospace face, so the pill read as a terminal chip amid the glass —
             the single biggest "reads as off". Pin the sans family here so BOTH the glass tier
             (.ow-btn already sets it) and the off-glass Normal tier are consistent. Routes
             through the canonical --ow-ui-font token (#696/#709 coherence), never a bespoke stack. */
          font-family: var(--ow-ui-font, sans-serif);
          font-size: .75rem; font-weight: 600; letter-spacing: -0.01em; line-height: 1;
          color: #16191f; background: rgba(255,255,255,.30);
          border: 1px solid color-mix(in srgb, #16191f 10%, transparent); border-radius: 999px;
          padding: .34rem .72rem .34rem .56rem; min-height: 30px;
          display: inline-flex; align-items: center; gap: .38rem;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 1px 2px rgba(0,0,0,.10);
          transition: background-color .18s ease, box-shadow .18s ease,
                      transform .14s cubic-bezier(.34,1.56,.64,1), filter .18s ease, color .18s ease;
        }
        #orwell-cast .oc-pin:hover { background: rgba(255,255,255,.42); transform: translateY(-1px); }
        #orwell-cast .oc-pin:active { transform: translateY(0) scale(.97); filter: brightness(.97); }
        #orwell-cast .oc-pin:focus-visible {
          outline: none;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.5), 0 0 0 2px var(--ow-ios-blue, #0a84ff);
        }
        /* toggled: when the roster is currently pinned (aria-pressed), the control reads as an
           ENGAGED glass plate — "lit up, filled in" by LUMINOSITY (a brighter luminous veil) +
           a thin system-blue ring, never an opaque dark slab with light text (#771: the old
           92%-black plate + white monospace broke the glass character — that WAS the "reads as
           off"). Accent lives on the RING only; the label keeps the dark chrome ink (#726
           no-accent-on-text). The ring rides the box-shadow so it survives the frosted
           border-softening override below. */
        #orwell-cast .oc-pin[aria-pressed="true"] {
          background:
            linear-gradient(to bottom, rgba(255,255,255,0.30), transparent 70%),
            rgba(255,255,255,0.52);
          color: #16191f;
          border-color: color-mix(in srgb, var(--ow-ios-blue, #0a84ff) 60%, transparent);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.7),
                      0 0 0 1px color-mix(in srgb, var(--ow-ios-blue, #0a84ff) 55%, transparent),
                      0 1px 3px rgba(0,0,0,.14);
        }
        #orwell-cast .oc-pin[aria-pressed="true"] .oc-pin-ic { opacity: 1; }
        /* The 44px coarse-pointer tap floor (WCAG 2.5.5) is owned in style.css (the RESP-1/2
           @media (hover:none) and (pointer:coarse) block already lifts .oc-pin to 44px) — one
           source of truth, so it isn't duplicated here. */
        /* #769: the pin icon is a MONOCHROME inline SVG (currentColor) — kit glyph language,
           no full-color emoji. flex-shrink:0 keeps it crisp beside the label. */
        #orwell-cast .oc-pin .oc-pin-ic { flex-shrink: 0; opacity: .8; }
        #orwell-cast .oc-pin:hover .oc-pin-ic { opacity: 1; }
        #orwell-cast .oc-actions { margin-top: .8rem; display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
        #orwell-cast .oc-backfill-note { font-size: .72rem; opacity: .65; line-height: 1.4; }
        /* Narrow: the slot engine's sheet host owns the position; just fit. */
        @media (max-width: 768px) {
          #orwell-cast { width: auto !important; max-width: none !important; }
        }
        /* #725: on the LIGHT glass var(--border) is a HARD dark stroke. Apple defines glass
           by lensing, not a hard line — soften every inner stroke (portrait holders, the pin)
           to the low-opacity WHITE hairline the windows/notices carry. */
        body.theme-frosted #orwell-cast .oc-portrait,
        body.theme-frosted #orwell-cast .oc-pin {
          border-color: rgba(255,255,255,0.14);
        }
      </style>
      <div class="oc-toolbar">
        <button type="button" class="oc-pin ow-btn ow-btn-secondary" id="oc-pin" aria-pressed="false" title="Compact pin — dock the cast roster into the control-room rail"><svg class="oc-pin-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22"/><path d="M9 4h6l-1 8 3 3H7l3-3-1-8z"/></svg><span>Compact pin</span></button>
      </div>
      <div class="oc-grid" id="oc-grid"></div>
      <div class="oc-empty" id="oc-empty" style="display:none"></div>
      <div class="oc-actions" id="oc-actions" style="display:none">
        <button type="button" class="ow-btn ow-btn-secondary" id="oc-backfill">Generate cast portraits</button>
        <span class="oc-backfill-note" id="oc-backfill-note"></span>
      </div>`;
    _win = window.OrwellWindowKit.create({
      // #780: monochrome icon language — no full-color emoji in the titlebar (the kit
      // renders `title` verbatim). The glyph is the mono SVG `icon` slot below.
      id: PANEL_ID, title: "The Cast",
      icon: "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><circle cx='9' cy='7' r='4'/><path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/></svg>",
      slot: "top-left", slotKey: "cast", role: "complementary",
      minimizable: true, closable: true, draggable: true,
      // 0054 Phase 2: the FULL roster docks into the control-room rail (the kit's
      // ⇲ titlebar toggle). This is the full-content docked window; the L12 "compact
      // pin" (two portraits) below stays a separate, lighter affordance. Default
      // floating; the poll keeps running across a dock re-home (onClose is suppressed).
      dockable: true, defaultDocked: false,
      // #893: on phones the full roster presents as a bottom SHEET (grabber +
      // medium/full detents + swipe-dismiss) via the kit's sheet presentation
      // mode — non-modal windows opt in explicitly; docked still wins, and the
      // desktop tier keeps the floating slot window.
      sheet: true,
      content,
      onClose: () => {
        _win = null; _open = false;
        if (_timer) { clearTimeout(_timer); _timer = null; }
        _cards.clear(); // the kit tore the panel DOM down — drop the detached card nodes
      },
      onDock: () => {
        // A re-home keeps the SAME instance AND the same content node (with its grid,
        // cards, and the #oc-pin/#oc-backfill listeners intact — they're plain
        // listeners on nodes the kit re-appends, not kit-AbortController ones). Just
        // refresh so the (now-docked or now-floating) panel shows live content.
        if (_open) refreshRoster().then(scheduleNextPoll);
      },
    });
    _win.open(document.getElementById(BTN_ID) || undefined);
    const el2 = document.getElementById(PANEL_ID);
    el2.querySelector("#oc-backfill").addEventListener("click", requestBackfill);
    // L12: pin the cast window into the gadget rail (the rail gadget owns the
    // pinned state + render; this just toggles it and the window dismisses itself).
    const pinBtn = el2.querySelector("#oc-pin");
    if (pinBtn) {
      // #771 — reflect the live pinned state on the toggle (aria-pressed drives the
      // toggled visual + tells AT this is a two-state control). The full window is only
      // ever open while UN-pinned (pinning dismisses it), so this normally reads "false";
      // we still source it from the gadget so the semantics are correct, not assumed.
      try {
        const pinned = !!(window.OrwellCastPin && window.OrwellCastPin.isPinned());
        pinBtn.setAttribute("aria-pressed", pinned ? "true" : "false");
      } catch (_) {}
      pinBtn.addEventListener("click", () => {
        if (window.OrwellCastPin) window.OrwellCastPin.setPinned(true);
        pinBtn.setAttribute("aria-pressed", "true");
      });
    }
    return el2;
  }

  function statusLabel(s) {
    if (s === "jury") return "Jury";
    if (s === "evicted") return "Evicted";
    if (s === "winner") return "Winner";
    return ""; // M2-2: the default state carries no caption — labels mark EXCEPTIONS only
  }

  // --- the G9 manual lever: backfill missing portraits -------------------------
  // Shown only when a provider is configured (imagesAvailable) AND active houseguests
  // still show placeholders — e.g. a season created before 0051 shipped, or a prior
  // generation run that failed. POSTs the debounced backfill route; never blocks.

  async function requestBackfill() {
    const el = ensurePanel();
    const btn = el.querySelector("#oc-backfill");
    const note = el.querySelector("#oc-backfill-note");
    btn.disabled = true;
    note.textContent = "Requesting…";
    try {
      const r = await fetch("/api/orwell/portraits/backfill", {
        method: "POST", credentials: "same-origin",
      });
      const data = r.ok ? await r.json() : null;
      if (data && data.kicked) {
        const n = Array.isArray(data.missing) ? data.missing.length : 0;
        note.textContent = "Generating " + n + " portrait" + (n === 1 ? "" : "s") +
          " in the background — they'll appear here as they land.";
      } else if (data && !data.available) {
        note.textContent = "No portrait model connected — the game plays on without portraits. An admin can connect one in Settings.";
      } else if (data && !(data.missing || []).length) {
        note.textContent = "Nothing missing — every active houseguest has a portrait.";
      } else {
        note.textContent = "A generation run started recently — give it a few minutes, then try again.";
      }
    } catch (_) {
      if (window.OrwellReport) window.OrwellReport.fail("cast", "backfill-post", _); // G11: fail open, never silent
      note.textContent = "The portrait service is offline right now.";
    }
    // Re-enable after a beat (the server debounces regardless — this just avoids mashing).
    setTimeout(() => { btn.disabled = false; }, 5000);
  }

  // --- G22: keyed, incremental render -------------------------------------------
  // One card element per roster id, upserted in place across polls: a face that just
  // landed fades into its OWN card and nothing else is touched — untouched cards (and
  // their loaded <img> nodes) are never rebuilt, so nothing flickers or refetches.

  const _cards = new Map(); // roster id → { el, holder, nameB, statusEl, name, status, portrait }

  // J2-15: a stable hue (0–359) from the houseguest's NAME only — public, Vault-free, and the
  // same on every render so a card's placeholder tint never flickers between polls. A small FNV-ish
  // string hash keeps it deterministic without pulling in any dependency.
  function nameHue(name) {
    let h = 2166136261;
    const s = name || "";
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h % 360;
  }

  function cardKey(hg) {
    // The roster route always sets a stable `id` (player → engine id or "player";
    // NPC → engine id or name); the name fallback here is purely defensive.
    const id = hg && hg.id != null && hg.id !== "" ? hg.id : (hg && hg.name);
    return id == null ? "" : String(id);
  }

  function setPortrait(entry, url, justLanded) {
    // Called ONLY on a real transition (placeholder→url, a changed url, url→gone):
    // the same src is never re-assigned, so a loaded face never reloads.
    entry.portrait = url || null;
    entry.holder.textContent = "";
    // J2-15: until a portrait (0051) backfills, a single shared 👤 silhouette made the
    // "meet 15 distinct people" payoff read as interchangeable placeholders. Render a
    // per-houseguest monogram instead — the name's initial over a deterministic tint
    // derived from the name (NOT any hidden/Vault attribute) — so every card is visibly
    // its own person from the first frame. Pure presentation; zero new data.
    //
    // OWN-9: the designed monogram is now ALSO the base layer while a real portrait is
    // still IN FLIGHT. The old shape mounted the <img> alone, so a slow / hung / failing
    // portrait route (mid-generation churn, an epoch-rotated ?v= ref still regenerating,
    // a wedged engine) left every tile a bare grey .oc-portrait holder — the whole window
    // read as a grid of grey squares (the owner-reported "cast window renders grey").
    // Now the monogram is the tile's face in EVERY non-photo state, and the photo reveals
    // over it only once genuinely decoded (the reveal seam below), which then drops the
    // monogram layer so a loaded card's holder keeps exactly one face (+ badge).
    const ph = document.createElement("span");
    ph.className = "oc-ph oc-monogram";
    // M2-2: the designed template (id-seeded gradient + pattern + initials) from the shared
    // kit; the legacy flat initial stays only as the no-kit fallback so the card never blanks
    // (oc-mono-fallback carries the --oc-mono-hue tint — the M2-2 refactor had orphaned the
    // hue var with no consuming rule, leaving that path a grey letter-tile).
    if (window.OrwellMonogram) {
      ph.innerHTML = window.OrwellMonogram.svg({ id: entry.id, name: entry.name });
    } else {
      const nm = (entry.name || "").trim();
      ph.classList.add("oc-mono-fallback");
      ph.textContent = nm ? nm[0].toUpperCase() : "?";
      ph.style.setProperty("--oc-mono-hue", String(nameHue(nm)));
    }
    entry.holder.appendChild(ph);
    if (!url) {
      // RESP-20 (#894): flag the holder as portrait-LESS so the narrow tier can cap it
      // to a compact thumbnail (a docked ≤240px rail otherwise gives a 1-column, ~240px
      // viewport-filling gradient block). A real face (the img branch below) drops the
      // flag, so a card that streams in its portrait snaps back to the full tile.
      entry.holder.classList.add("oc-portrait-ph");
      syncBadge(entry);
      return;
    }
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = entry.name;
    // The OWN-9 reveal seam: the img mounts INVISIBLE (oc-img-pending — the monogram base
    // shows through) and turns visible only once its bytes decoded, so neither the empty
    // pending box, the alt text, nor the broken-image glyph ever paints as the tile.
    img.className = "oc-img-pending";
    // Photo decoded ⇒ the monogram loading-base retires (one face per card — the
    // browser-smoke "no placeholder glyph on provider-on cards" gate). Idempotent:
    // a url re-transition may have already wiped the holder before a timer fires.
    const retire = () => { if (ph.isConnected) ph.remove(); };
    let revealed = false;
    const reveal = () => {
      if (revealed) return; // load can follow a synchronous cache-hot reveal — run once
      revealed = true;
      img.classList.remove("oc-img-pending");
      if (justLanded) {
        // The G22 arrival fade (reduced-motion guarded in the CSS above); drop the
        // class once played so a later grid re-order can't replay it.
        img.classList.add("oc-justin");
        img.addEventListener("animationend", () => img.classList.remove("oc-justin"), { once: true });
        // Crossfade: the monogram stays BENEATH the .35s arrival fade (fading in over
        // the bare grey holder is the OWN-9 look again), then retires on animationend.
        // The timer is a generous BACKSTOP only — reduced-motion's animation:none never
        // emits animationend (the photo is fully visible instantly, so the leftover base
        // is invisible and the timer is pure DOM cleanup), and a frame-throttled tab can
        // freeze the fade at its first (transparent) frame, where an eager timer would
        // retire the base and re-open the grey window this fix closes.
        img.addEventListener("animationend", retire, { once: true });
        setTimeout(retire, 2000);
      } else {
        retire(); // first paint / cache-hot: no fade, the photo simply replaces the base
      }
    };
    img.onload = reveal;
    // The placeholder fallback, as ever — and the entry forgets the url, so a
    // transient miss (the file landing a beat after the manifest) heals next poll.
    img.onerror = () => setPortrait(entry, null, false);
    img.src = url;
    // A cache-hot image can already be decoded synchronously after the src write.
    if (img.complete && img.naturalWidth > 0) reveal();
    // RESP-20 (#894): a real face keeps the FULL tile — drop the portrait-less cap flag.
    entry.holder.classList.remove("oc-portrait-ph");
    entry.holder.appendChild(img);
    syncBadge(entry); // M2-2: the role badge composites on portraits and monograms alike
  }

  // M2-2: one badge slot per card, bottom-right of the portrait holder. Role precedence and
  // markup come from the shared kit; this only reconciles the DOM to entry.role.
  function syncBadge(entry) {
    if (!entry || !entry.holder) return;
    const cur = entry.holder.querySelector(".ow-mono-badge");
    const role = entry.role || null;
    if (!role) { if (cur) cur.remove(); return; }
    const want = "ow-mono-badge-" + role;
    if (cur && cur.classList.contains(want)) return; // already right
    if (cur) cur.remove();
    if (window.OrwellMonogram) {
      window.OrwellMonogram.ensureCss();
      entry.holder.insertAdjacentHTML("beforeend", window.OrwellMonogram.badgeSvg(role));
    }
  }

  function makeCard(hg) {
    const out = hg.status && hg.status !== "active";
    const evicted = hg.status === "evicted"; // L16: grayscale only on eviction
    const card = document.createElement("div");
    // #1638 frame-only migration: the card door adopts the kit interactive-tile chrome and the
    // holder adopts the kit frame — the hand-rolled two-layer reveal seam (oc-img-pending / ocFadeIn
    // + manual badge composite) is DELIBERATELY kept (owner ruling §6.1), so only the frame moves.
    card.className = "oc-hg ow-portrait-tile" + (out ? " oc-out" : "") + (evicted ? " oc-evicted" : "");
    const holder = document.createElement("div");
    holder.className = "oc-portrait ow-portrait";
    const nameEl = document.createElement("div");
    nameEl.className = "oc-name";
    const nameB = document.createElement("b");
    nameB.textContent = hg.name == null ? "" : String(hg.name);
    nameEl.appendChild(nameB);
    if (hg.isPlayer) nameEl.appendChild(document.createTextNode(" (you)"));
    const statusEl = document.createElement("div");
    statusEl.className = "oc-status";
    statusEl.textContent = statusLabel(hg.status);
    statusEl.hidden = !statusEl.textContent; // M2-2: no empty caption row
    card.appendChild(holder);
    card.appendChild(nameEl);
    card.appendChild(statusEl);
    const entry = {
      el: card, holder, nameB, statusEl,
      id: cardKey(hg),
      name: hg.name == null ? "" : String(hg.name),
      status: hg.status || "active",
      role: _roles[cardKey(hg)] || _roles[hg.name] || null, // M2-2: role by id, name-keyed fallback (status may name-key)
      portrait: null,
    };
    // M4-1 (idea 12 / M3-6-ready): every cast tile is a DOOR into that houseguest's
    // dossier — the shared handler `window.OrwellDossier.open`. Keyboard-operable (role
    // button, tabindex 0, an accessible name, Enter/Space) so it isn't a mouse-only click
    // target. entry.id/entry.name are read live at open() time (a closure over `entry`,
    // not a copied value), so this stays correct even after updateCard() renames the tile.
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.setAttribute("aria-label", "Open " + (entry.name || "houseguest") + "'s dossier");
    const openDossier = () => {
      if (window.OrwellDossier) window.OrwellDossier.open(entry.id, card);
    };
    card.addEventListener("click", openDossier);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDossier(); }
    });
    // First paint of a brand-new card: no fade — the fade marks a portrait ARRIVING
    // on a card the player is already looking at.
    setPortrait(entry, hg.portrait || null, false);
    return entry;
  }

  function updateCard(entry, hg) {
    const status = hg.status || "active";
    if (status !== entry.status) {
      entry.status = status;
      entry.el.classList.toggle("oc-out", !!(hg.status && hg.status !== "active"));
      entry.el.classList.toggle("oc-evicted", hg.status === "evicted"); // L16
      entry.statusEl.textContent = statusLabel(hg.status);
      entry.statusEl.hidden = !entry.statusEl.textContent; // M2-2
    }
    const name = hg.name == null ? "" : String(hg.name);
    if (name !== entry.name) {
      entry.name = name; entry.nameB.textContent = name;
      entry.el.setAttribute("aria-label", "Open " + (name || "houseguest") + "'s dossier");
    }
    const url = hg.portrait || null;
    if (url !== entry.portrait) setPortrait(entry, url, !!url); // the stream moment
    const role = _roles[cardKey(hg)] || _roles[hg.name] || null; // M2-2 (name-keyed fallback, like the pin)
    if (role !== entry.role) { entry.role = role; syncBadge(entry); }
  }

  function render(data) {
    // A roster fetch begun while the panel was OPEN can resolve AFTER the player closed it (the
    // close stops the poll, but an in-flight request still settles). render() must NOT resurrect a
    // closed window — ensurePanel() would re-mount #orwell-cast, leaving a slotted, focused panel
    // overlapping the sidebar (it intercepted #session-sort-btn in CI). If we're closed, drop the
    // stale result; the next open re-fetches fresh.
    if (!_open) return;
    const el = ensurePanel();
    const grid = el.querySelector("#oc-grid");
    const empty = el.querySelector("#oc-empty");
    const roster = (data && Array.isArray(data.roster)) ? data.roster : [];
    _imagesAvailable = !!(data && data.imagesAvailable);
    // M1-9 (audit A9): the last completed run's honest verdict from the roster payload —
    // a 0-of-N run must flip the copy to a failure the player can act on, never an
    // eternal "Generating…" spinner over a provider that is not producing images.
    const _lastRunFailing = !!(data && data.portraitLastRun && data.portraitLastRun.failing);

    // G22 + L15: the adaptive cadence. The server reports a LIVE generation record
    // (`generation: {total, done, active}`) while a run is in flight — when present it is
    // authoritative (poll fast while `active`). Otherwise fall back to the G20 portrait
    // counters (provider configured + total > present). Either way each face shows up within a
    // few seconds. A `stale` payload (the route served the last-good roster because a state read
    // timed out during heavy generation) NEVER blanks the cast — the keyed upsert keeps the
    // existing faces and we keep polling fast so the real set lands.
    const total = (data && typeof data.portraitsTotal === "number") ? data.portraitsTotal : null;
    const present = (data && typeof data.portraitsPresent === "number") ? data.portraitsPresent : null;
    const gen = data && data.generation && typeof data.generation === "object" ? data.generation : null;
    const runActive = !!(gen && gen.active);
    const generating = runActive ||
      (_imagesAvailable && total != null && present != null && total > present);
    _pollDelay = (generating || data.stale) ? FAST_POLL_MS : POLL_MS;

    const actions = el.querySelector("#oc-actions");
    if (!roster.length) {
      // The empty state (pre-season / a reset) — the ONLY path that empties the
      // grid; a populated roster only ever upserts cards in place. A `stale` payload
      // always carries the last good cards, so it never reaches here.
      for (const entry of _cards.values()) entry.el.remove();
      _cards.clear();
      empty.style.display = "";
      empty.textContent = "The cast hasn't moved in yet.";
      if (actions) actions.style.display = "none";
      return;
    }
    empty.style.display = "none";

    // G9: offer the retry lever when a provider is configured but active houseguests
    // still show placeholders (pre-0051 seasons / failed generation runs).
    const missing = roster.filter(
      (hg) => (!hg.status || hg.status === "active") && !hg.portrait
    );
    if (actions) {
      actions.style.display = (_imagesAvailable && missing.length) ? "" : "none";
      // G20 + L15: standing completeness copy — the background reconciler verifies and
      // retries the set; this row reports the live remainder. Prefer the live run record
      // ("Generating N of M…") when a run is active, else the rendered-roster remainder.
      if (_imagesAvailable && missing.length) {
        const note = el.querySelector("#oc-backfill-note");
        if (note) {
          if (gen && gen.active && gen.total) {
            note.textContent = "Generating " + Math.min(gen.done, gen.total) + " of " +
              gen.total + " portrait" + (gen.total === 1 ? "" : "s") + "…";
          } else if (_lastRunFailing) {
            // M1-9: honest failure copy — no run is active and the last one landed nothing.
            note.textContent = "Portraits aren't landing — the portrait service may need reconnecting (Settings).";
          } else {
            note.textContent = "Generating " + missing.length + " remaining…" +
              (total != null && present != null ? " (" + present + "/" + total + " done)" : "");
          }
        }
      }
    }

    // Active first (player flagged), then jury, then evicted — keeps the live house
    // on top. sort() is stable, so within a tier the server's order (player first)
    // holds across polls: the grid order is keyed and deterministic.
    const order = { active: 0, jury: 1, evicted: 2 };
    const sorted = roster.slice().sort((a, b) =>
      (order[a.status] ?? 3) - (order[b.status] ?? 3));

    // The keyed upsert: add new ids, upgrade changed cards in place, drop vanished
    // ids (defensive), and keep the tier order by MOVING live nodes when it drifts —
    // appendChild relocates an element without re-mounting it, so a loaded portrait
    // never reloads.
    const seen = new Set();
    const desired = [];
    for (const hg of sorted) {
      const key = cardKey(hg);
      if (!key || seen.has(key)) continue; // defensive: unkeyable / duplicate rows
      seen.add(key);
      let entry = _cards.get(key);
      if (entry) updateCard(entry, hg);
      else { entry = makeCard(hg); _cards.set(key, entry); }
      desired.push(entry.el);
    }
    for (const [key, entry] of Array.from(_cards)) {
      if (!seen.has(key)) { entry.el.remove(); _cards.delete(key); }
    }
    const current = Array.from(grid.children);
    if (current.length !== desired.length || desired.some((node, i) => current[i] !== node)) {
      for (const node of desired) grid.appendChild(node);
    }
    // M4-1: no paging affordance to re-derive — every card is already in the grid; the
    // window body (the kit's `.ow-body { overflow: auto }`) scrolls vertically on its own.
  }

  // Poll backoff (perf/resilience): consecutive failures widen the cadence so a slow/502-ing engine
  // late-game is not hammered every 30s — the keyed upsert keeps the last-good cast on screen meanwhile.
  let _failures = 0;
  const BACKOFF_CEIL_MS = 120000;

  async function refreshRoster() {
    // Non-blocking loading affordance: the window already shows its last-good cast (keyed upsert) —
    // this just signals a refresh is in flight, so a slow fill never reads as a frozen/blank window.
    if (_win && _win.setLoading) _win.setLoading(true);
    try {
      // M2-2: the ceremony status rides beside the roster — the badge role map (hoh/nominees/
      // veto/winner, all public board facts). Fail-soft: no status ⇒ no badges, never no cast.
      const [data, st] = await Promise.all([
        getJSON("/api/orwell/roster"),
        getJSON("/api/orwell/status").catch(() => null),
      ]);
      _roles = (window.OrwellMonogram && st) ? window.OrwellMonogram.rolesFrom(st) : {};
      render(data);
      _failures = 0; // recovered: the next render() restores the adaptive cadence
    } catch (_) {
      // Fail open: keep whatever's shown; an empty first load shows the empty-state copy.
      if (window.OrwellReport) window.OrwellReport.fail("cast", "roster-fetch", _); // G11: fail open, never silent
      _failures++;
      const el = document.getElementById(PANEL_ID);
      if (el && !el.querySelector("#oc-grid").children.length) {
        el.querySelector("#oc-empty").style.display = "";
        el.querySelector("#oc-empty").textContent = "The cast list is offline right now.";
      }
    } finally {
      if (_win && _win.setLoading) _win.setLoading(false);
    }
  }

  // WS Phase-1 (§4): when the multiplexed socket is live the server PUSHES a `state`/`hud`
  // frame on every board change; platform.js relays it to the one `orwell:gamechanged`
  // dispatcher, which already re-runs refreshGate + refreshRoster below. So both cast polls
  // (the 20s gate poll and the adaptive open-roster poll) stand down in WS mode and stay
  // edge-triggered (fail-soft: any doubt ⇒ keep polling). The fallback/SSE path is unchanged
  // and still polls — including the FAST cadence while portraits stream in.
  function _wsActive() {
    try { return !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive()); }
    catch (_) { return false; }
  }
  // The 20s gate poll (button show/hide) as a managed interval, so WS mode can suspend it.
  let _gateTimer = null;
  function startGatePoll() {
    if (_gateTimer) { clearInterval(_gateTimer); _gateTimer = null; }
    if (!_wsActive()) _gateTimer = setInterval(refreshGate, 20000);
  }

  // G22: ONE self-rescheduling poll timer. The next delay is recomputed from the
  // freshest roster (render() above) after each refresh — fast while portraits are
  // landing, the idle cadence once the set is complete — and the timer is always
  // cleared before it is re-armed, so cadence flips and re-entrant arms can never
  // stack pollers. A hidden tab skips the fetch but keeps the loop alive for when
  // the player returns; closing the panel stops it (onClose clears, and a cleared
  // panel never re-arms).
  function scheduleNextPoll() {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    if (!_open) return;
    // In WS mode the `state`/`hud` push (via orwell:gamechanged) supersedes the poll — the
    // immediate refreshRoster still runs, but don't re-arm the periodic timer.
    if (_wsActive()) return;
    // Under a run of failures, back off exponentially (capped) on TOP of the adaptive cadence — a
    // late-game engine that 502s a roster read should not be re-hit every 30s. A success resets it.
    const delay = _failures > 0
      ? Math.min(Math.max(_pollDelay, POLL_MS) * Math.pow(2, _failures), BACKOFF_CEIL_MS)
      : _pollDelay;
    _timer = setTimeout(async () => {
      _timer = null;
      if (_open && !document.hidden) await refreshRoster();
      scheduleNextPoll();
    }, delay);
  }

  function togglePanel(open) {
    if (open) {
      const existed = !!document.getElementById(PANEL_ID);
      const el = ensurePanel();
      _open = true;
      // G16/F2 (refresh-persistence audit): when ensurePanel() just MOUNTED the
      // window and the kit honored a persisted parked flag (the player parked it
      // last page-life), it lives in the dock — leave it parked; its dock chip
      // restores it. An explicit toggle on an ALREADY-LIVE minimized window
      // still restores, exactly as before. (The display write matters too:
      // modalManager's launcher-agnostic observer treats any un-hide of a
      // minimized window as a restore, which would silently un-park it.)
      const bootParked = !existed && _win && _win.isMinimized && _win.isMinimized();
      if (!bootParked) {
        // Docked: clear the inline display so the .ow-docked flex-column rule applies
        // (an inline `block` would break the kit's docked layout); the rail shows it.
        // Floating: un-hide + restore/raise as before.
        if (_win && _win.isDocked && _win.isDocked()) {
          el.style.display = "";
        } else {
          el.style.display = "block";
          if (_win) { _win.restore(); _win.raise(); }
        }
      }
      // G22: refresh now, then poll on the adaptive cadence that refresh computed.
      refreshRoster().then(scheduleNextPoll);
    } else if (_win) {
      _win.close(); // kit close: fly-away, teardown, focus-return (onClose resets state)
    }
  }

  // Seam for the headless gate (mirrors the other panels).
  window._orwellCastEnsure = () => { togglePanel(true); return true; };
  // L12: the pin gadget closes the floating window when the player docks the cast.
  window._orwellCastClose = () => { if (_win) togglePanel(false); };

  // Public hooks (mirrors the other orwell panels): refresh on a game change — and
  // re-arm the poll so a cadence change (say, a fresh season that is generating its
  // portraits) takes effect NOW, not at the old timer's next tick.
  window.orwellRefreshCast = () => { if (_open) refreshRoster().then(scheduleNextPoll); };
  window.addEventListener("orwell:gamechanged", () => {
    refreshGate();
    if (_open) refreshRoster().then(scheduleNextPoll);
  });
  // WS Phase-1 (§4/§6): cancel both polls the instant the socket goes live; resume them if
  // it falls back to SSE (startGatePoll/scheduleNextPoll re-arm only while !_wsActive()).
  window.addEventListener("orwell:ws-active", () => {
    if (_gateTimer) { clearInterval(_gateTimer); _gateTimer = null; }
    if (_timer) { clearTimeout(_timer); _timer = null; }
  });
  window.addEventListener("orwell:ws-inactive", () => {
    refreshGate();
    startGatePoll();
    if (_open) refreshRoster().then(scheduleNextPoll);
  });

  ready(() => {
    refreshGate();
    startGatePoll();
  });
})();
