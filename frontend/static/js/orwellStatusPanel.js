// Orwell status panel — the game's standing readout, docked in the sidebar (E64).
//
// Polls the engine's public ceremony status (week / phase / HOH / nominees / veto)
// via GET /api/orwell/status and renders a permanent section inside #sidebar
// whenever a game is in progress. It shows ONLY ceremony-level public facts the
// engine projects — no stats, souls, or hidden state ever reach it (the Vault
// Wall holds on the engine side). It FAILS OPEN: if the engine is unreachable or
// no game is running, the section simply hides and never disturbs the chat.
//
// RULING (#3 / E64): this is not a window. No drag, no saved position, no
// minimize dock, no z-index — it is sidebar chrome, full sidebar width, below
// the session list; on mobile it lives in the sidebar drawer like everything
// else. Collapsible in place; the collapsed state persists per user+game (E71).
import { onNarrowChange } from './platform.js';

(function () {
  "use strict";

  const POLL_MS = 20000;
  const ID = "orwell-status";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let timer = null;

  async function fetchStatus() {
    const r = await fetch("/api/orwell/status", { credentials: "same-origin" });
    if (!r.ok) throw new Error("status " + r.status);
    return r.json();
  }

  // The roster (C21): names + status only — Vault-free, exactly what a houseguest sees on
  // the memory wall. Best-effort: if /state fails the panel still shows the ceremony rows.
  async function fetchState() {
    try {
      const r = await fetch("/api/orwell/state", { credentials: "same-origin" });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }

  // E71: panel client state is keyed per user + game (the player's name is the
  // closest stable public game discriminator the FE holds), so one account's
  // collapse/dismiss state never leaks into another's, or into season 2.
  let _gameKey = "";
  // Fail-closed (R5/#1416): _gameKey is null when there is no data-user identity (computeGameKey
  // returns null), so storageKey returns null and every collapse read/write below is SKIPPED
  // rather than written to a shared empty-user namespace.
  function storageKey(base) {
    return _gameKey ? base + ":" + _gameKey : null;
  }

  // F1 (G5 refresh-persistence audit / Lane G16): the collapse used to be
  // WRITTEN under the full per-user+game key but RESTORED under a half-built
  // one — _gameKey was only assigned mid-render (renderRoster), AFTER
  // ensurePanel()'s one-time boot read, so the persisted value was unreachable
  // forever and the E71 "persists per user+game" promise was silently broken.
  // The key is now derived from the payloads in hand BEFORE the panel build
  // (render() assigns it ahead of ensurePanel()), and the persisted collapse
  // re-applies whenever the key changes (game change / season 2) — E71
  // scoping intact.
  function computeGameKey(state) {
    // `name + ':' + user` via the shared per-user helper (R5/#1416) — null when no data-user.
    const name = (state && state.player && state.player.name) || "";
    return (window.orwellUserKey && window.orwellUserKey(name)) || null;
  }
  let _applyCollapsed = null;     // ensurePanel's setCollapsed, exposed for re-application
  let _collapseKeyApplied = null; // the _gameKey whose persisted collapse was last applied
  function reapplyPersistedCollapse() {
    if (!_applyCollapsed || _collapseKeyApplied === _gameKey) return;
    _collapseKeyApplied = _gameKey;
    const sk = storageKey("orwell-status-collapsed");
    if (!sk) return;
    try {
      _applyCollapsed(localStorage.getItem(sk) === "1");
    } catch (_) {}
  }

  // The player's OWN ceremony role from PUBLIC facts (HOH / on the block / veto) — derived by
  // id-comparison, never a "safe/target" read (0020). Returns "" when the player is just a
  // houseguest, or their out-of-game seat ("Evicted" / "Jury") when they're out.
  // #556 (launch-blocker): after an IN-SESSION next-season hand-off (S1→S2 with no page reload),
  // the engine's player.status could still read "evicted"/"jury" from the prior season, so an
  // ACTIVE player was falsely badged EVICTED for the whole new season (S1→S2 was only ever clean
  // because it involved a page reload). A player can only legitimately be out once an eviction has
  // actually happened THIS season: the season is finished, week > 1, or at least one houseguest is
  // already out. A pristine live season (not finished, week ≤ 1, nobody out) ⇒ the seat is stale.
  // GADGET-1: `commitStagedEviction` (the real vote-tally path) flips the evicted player's
  // seat to "evicted"/"jury" IMMEDIATELY, while `rollWeek()` (the week bump that would clear
  // the guard below) is deferred until AFTER the whole goodbye-message sequence resolves. So a
  // first-week player eviction landed mid-goodbye with week still 1 and no NPC yet out — exactly
  // the shape `seatStale` otherwise (correctly) treats as a carried-over stale S1→S2 status. The
  // engine's own `phase === "eviction"` is the tell that a REAL eviction is live/just resolved
  // this season, so it overrides the week/anyOut heuristic.
  function seatStale(status, state) {
    const finished = !!(status && status.finished);
    const week = (status && typeof status.week === "number") ? status.week : 0;
    const house = (state && Array.isArray(state.house)) ? state.house : [];
    const anyOut = house.some((h) => h && h.status && h.status !== "active");
    const phase = status && status.phase;
    return !(finished || week > 1 || anyOut || phase === "eviction");
  }

  // GADGET-2/SG-15: a nominee who wins the veto (or otherwise holds more than one role at once)
  // can legitimately carry multiple badges — the old single-string chain returned only the FIRST
  // match, so a nominee holding the veto (the single most decision-critical state: "you can save
  // yourself") never showed the "VETO" badge at all. Return every applicable badge.
  function selfBadge(status, state) {
    const me = state && state.player && state.player.id;
    const seat = state && state.player && state.player.status;
    if (seat === "evicted") return seatStale(status, state) ? [] : ["EVICTED"];
    if (seat === "jury") return seatStale(status, state) ? [] : ["JURY"];
    if (!me || !status) return [];
    const id = (c) => (c && typeof c === "object" ? c.id : c);
    const b = [];
    if (id(status.hoh) === me) b.push("HOH");
    if ((status.nominees || []).map(id).includes(me)) b.push("ON THE BLOCK");
    if (id((status.veto || {}).holder) === me) b.push("VETO");
    return b;
  }

  // SG-15: a phase-conditional seat CUE at eviction phase — the roles the eviction phase itself
  // creates (voter / tie-breaker / the-one-being-voted-on) had no board cue at all, so a
  // first-timer had no glanceable answer to "do I have anything to do right now?".
  function seatHint(status, state) {
    if (!status || status.phase !== "eviction") return "";
    const me = state && state.player && state.player.id;
    const seat = state && state.player && state.player.status;
    if (!me || seat !== "active") return "";
    const idOf = (c) => (c && typeof c === "object" ? c.id : c);
    if (idOf(status.hoh) === me) return "You break ties";
    const noms = Array.isArray(status.nominees) ? status.nominees.map(idOf) : [];
    if (noms.includes(me)) return "The House votes on you";
    return "You vote tonight";
  }

  // M2-3 (audit B2): pre-HOH board state — before the very first HOH exists (week 1, no HOH crowned
  // yet, season not over) the three "HOH — / Noms — / Veto —" rows are all dead em-dashes and read as
  // broken. Pure + Vault-free (a public board fact only), so it's node-testable in isolation.
  function isPreHoh(st) {
    return !!(st && !st.hoh && st.week === 1 && !st.finished);
  }

  // M2-3: the premiere's NOT-yet-met ids (the unlit tiles) — derived from the Vault-free premiere
  // projection's `remaining` set, keyed by houseguest id (name fallback). Pure + node-testable; reads
  // ONLY the public NamedRef (id/name), never a soul, number, or hidden field.
  function premiereUnmetIds(prem) {
    const out = [];
    if (!prem || typeof prem !== "object" || !Array.isArray(prem.remaining)) return out;
    for (const fi of prem.remaining) {
      const hg = fi && fi.houseguest;
      const k = hg && (hg.id != null ? hg.id : hg.name);
      if (k != null) out.push(String(k));
    }
    return out;
  }

  // ADR 0003 (the conversation is the game): a tile CLICK focuses the chat — it NEVER replaces it or
  // navigates. Scroll the composer into view and focus the input so the player can talk immediately.
  function focusChat() {
    try {
      const input = document.getElementById("message");
      if (!input) return;
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      input.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      input.focus();
    } catch (_) {}
  }

  // #640: compose the OrwellGadget kit (collapsible). The kit owns the card shell, the
  // collapsible header (role=button + chevron + the persisted/synced collapse), and the rail
  // mount. This panel's DYNAMIC header line (Week N / phase / time-of-day / stale-dot) renders
  // into the kit's TITLE slot — so the live readout still reads as the card title, exactly as
  // before — and everything else renders in the body. Only this gadget's own inner CSS stays here.
  let _gadget = null;
  function ensurePanel() {
    let el = document.getElementById(ID);
    if (el) return el;
    if (!document.getElementById("orwell-status-css")) {
      const st = document.createElement("style");
      st.id = "orwell-status-css";
      st.textContent = `
        /* the dynamic header line (Week / phase / tod / rest), rendered into the kit title slot */
        #orwell-status .os-ttl { display: flex; align-items: baseline; gap: .4rem; flex: 1; min-width: 0; flex-wrap: wrap; }
        #orwell-status .os-phase { opacity: .65; font-weight: 400; text-transform: capitalize; }
        #orwell-status .os-tod { opacity: .85; font-weight: 400; font-size: .92em; }
        #orwell-status .os-rest { opacity: .6; font-weight: 400; font-style: italic; margin-left: .45em; font-size: .9em; }
        /* SG-15: the phase-conditional eviction-night seat cue ("You vote tonight" / "You break
           ties" / "The House votes on you") — a lightweight, non-badge readout beside the self row. */
        #orwell-status .os-hint { opacity: .72; font-weight: 400; margin-left: .45em; font-size: .85em; }
        #orwell-status .os-row { display: flex; gap: .4rem; }
        #orwell-status .os-row .os-k { color: color-mix(in srgb, var(--fg, #9cdef2) 78%, var(--panel, #111)); min-width: 4.2em; }
        #orwell-status .os-row .os-v { flex: 1; }
        #orwell-status .os-noms { color: var(--red, #e06c75); }
        /* #759: NO accent hue on TEXT while glass is on. On the light glass material the
           nominees line must read as the same neutral dark chrome ink the rest of the glass
           HUD uses (#16191f) — not var(--red), which washes to an illegible light grey on
           the light glass (~2.2:1). The flash highlight (.os-changed) is a NON-text effect
           and is untouched. Normal (non-glass) tier keeps the accent. */
        body.theme-frosted #orwell-status .os-noms { color: #16191f; }
        /* TRANS-3: a brief delta highlight when a power row CHANGES (HOH / noms / veto /
           phase) so a ceremony reveal is never a silent text swap. Theme-token driven. */
        #orwell-status .os-changed {
          animation: os-row-flash 1.6s ease-out 1;
          border-radius: 4px;
        }
        @keyframes os-row-flash {
          0%   { background: color-mix(in srgb, var(--accent, #9cdef2) 42%, transparent); }
          100% { background: transparent; }
        }
        @media (prefers-reduced-motion: reduce) {
          /* No motion — a static tint that lingers then is cleared by the JS timeout. */
          #orwell-status .os-changed {
            animation: none;
            background: color-mix(in srgb, var(--accent, #9cdef2) 22%, transparent);
          }
        }
        /* Offline dot (U5): the feed reconnecting, not gone — last-known stays visible. */
        #orwell-status .os-stale { color: #e0a500; margin-left: .35rem; font-size: .7em; vertical-align: middle; }
        /* Memory wall (C21): the roster a real houseguest can see. Public facts only. */
        /* E-1: a WATCHING evictee's one control — re-opens the spectator-choice CARD (the confirm is on the card; skip is one-way). */
        #orwell-status .os-skip { margin: .15rem 0 .35rem; font: inherit; font-size: max(.8em, 11px); font-weight: 600; min-height: 32px; padding: .3em .8em;
          border-radius: 8px; cursor: pointer; border: 1px solid var(--border, #355a66); background: transparent; color: inherit; }
        #orwell-status .os-skip[disabled] { opacity: .55; cursor: default; }
        #orwell-status .os-you { margin: .35rem 0 .1rem; font-weight: 600; }
        /* S10 legibility floor: the self-role badge (HOH / ON THE BLOCK / VETO / JURY / EVICTED)
           must clear the ~11px crowding floor at EVERY viewport. The bare .72em rode the panel's em
           base down to ~8.9-10.2px across the matrix tiers (below the floor - the fe-responsive
           JURY-badge regression). A LITERAL 11px floor (not var(--fs-2xs): 0.6875rem itself dips
           below once the fluid/compact root shrinks) - exactly the sibling .os-roster-h pattern
           (max(.8em, 11px)) - so it never renders sub-floor while .72em still scales up on zoom.
           NOTE (KIT-F-04): byte-mirrored between orwellStatusPanel.js and orwellElements.js. */
        #orwell-status .os-you .os-badge {
          display: inline-block; margin-left: .4rem; padding: 0 .4em; border-radius: .5em;
          font-size: max(.72em, 11px); font-weight: 700; letter-spacing: .02em;
          background: var(--accent, var(--red, #e06c75)); color: var(--on-accent, #fff);
        }
        /* #955: the house TALLY only — "The House · N/N". The per-person name list was removed
           from the status panel (it duplicated the cast PHOTO gallery, which is now the single
           roster surface). This header keeps the at-a-glance attrition count; the names + faces
           live in the Cast Photos gadget (#orwell-cast), which docks under the night gadget. */
        #orwell-status .os-roster-h { opacity: .55; font-size: max(.8em, 11px); margin: .4rem 0 .15rem; }
        /* F4: the clean terminal/post-season state — shown instead of stale ceremony rows once the
           season is over (finished). */
        #orwell-status .os-done { margin: .2rem 0 .15rem; font-weight: 600; }
        #orwell-status .os-done .os-winner { color: var(--accent, var(--red, #e06c75)); }
        /* #759: same rule for the season WINNER name on the light glass — neutral dark ink,
           never the accent (which is illegible on the light glass). Non-glass tier keeps it. */
        body.theme-frosted #orwell-status .os-done .os-winner { color: #16191f; }
        /* J3-07/J3-08 (wayfinding): the PREMIERE objective + progress — the persistent answer to
           "why hasn't HOH started, and how far am I?". Shown only during the premiere (it is the
           current objective); the count is the player-mental-model NPC figure ("X of 15"). */
        #orwell-status .os-premiere { margin: .2rem 0 .25rem; }
        #orwell-status .os-prem-obj { font-weight: 600; }
        #orwell-status .os-prem-obj .os-prem-count {
          margin-left: .4rem; font-weight: 700;
          color: var(--accent, #9cdef2);
        }
        #orwell-status .os-prem-left { opacity: .7; font-size: .9em; margin-top: .1rem; }
        /* M2-3 (audit B2): the premiere cast STRIP — a Vault-free row of sixteen monogram tiles
           (the shared OrwellMonogram kit) that LIGHTS UP as the player meets the house (0/15 →
           15/15). It rides the ONE glass plane (no second slab); a not-yet-met tile reads unlit.
           Horizontal scroll so sixteen faces fit the sidebar; retires with the premiere block. */
        #orwell-status .os-prem-strip {
          display: flex; gap: .3rem; margin-top: .4rem; padding-bottom: .2rem;
          overflow-x: auto; overflow-y: hidden;
          scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.18) transparent;
        }
        /* An author display:flex overrides the UA [hidden]{display:none}, so pin the hidden state
           explicitly — an empty strip (no premiere / no cards) must not render as a blank flex row. */
        #orwell-status .os-prem-strip[hidden] { display: none !important; }
        #orwell-status .os-prem-strip::-webkit-scrollbar { height: 5px; }
        #orwell-status .os-prem-strip::-webkit-scrollbar-track { background: transparent; }
        #orwell-status .os-prem-strip::-webkit-scrollbar-thumb { background: rgba(255,255,255,.16); border-radius: 999px; }
        #orwell-status .os-tile {
          flex: 0 0 auto; width: 30px; height: 30px; padding: 0; border: 0; cursor: pointer;
          border-radius: 7px; overflow: hidden; background: transparent; position: relative;
          transition: opacity .28s ease, transform .14s ease, filter .28s ease;
        }
        /* #1638: the face inherits the tile's 7px radius via the .ow-portrait kit frame
           (.ow-portrait > .ow-mono-face { border-radius: inherit }) — the local override is gone. */
        #orwell-status .os-tile:hover { transform: translateY(-1px); }
        #orwell-status .os-tile:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--ow-ios-blue, #0a84ff); }
        /* the ONLY state a tile carries: met (lit) vs. not-yet-met (unlit) — the gate the strip visualizes. */
        #orwell-status .os-tile-unmet { opacity: .34; filter: grayscale(.7); }
        @media (prefers-reduced-motion: reduce) {
          #orwell-status .os-tile { transition: none; }
          #orwell-status .os-tile:hover { transform: none; }
        }
        /* WCAG 2.5.5 (Target Size) / the repo's 44px coarse-pointer floor: the premiere "meet the
           house" tiles are the player's FIRST interactive gesture on mobile, yet each visible tile is
           a dense 30×30 (sixteen across a scrollable strip) — well below the 44px floor every other
           control meets. Grow only the HIT area with an invisible ≥44px ::after (the same idiom as the
           window-kit titlebar controls in orwellWindow.js and the frosted traffic-lights) — the visible
           30px face is untouched. Two clip fixes make the ::after reachable in BOTH axes: the tile drops
           overflow:hidden (redundant — the .ow-mono-face clips its OWN portrait via its own
           overflow:hidden) so the ::after can escape the 30px box, and the strip gains ~7px padding on
           ALL sides so the ::after's ±7px overhang lands inside the strip's clip box on BOTH axes — the
           y-overhang isn't guillotined by overflow-y:hidden, AND the first/last tiles' x-overhang isn't
           clipped at the overflow-x scroll endpoints (CodeRabbit). The gap widens to 14px (2×7px overhang) so adjacent
           44px hit regions abut without intersecting. Touch only — desktop chrome stays compact. */
        @media (pointer: coarse) {
          #orwell-status .os-tile { overflow: visible; }
          #orwell-status .os-tile::after {
            content: ""; position: absolute; top: 50%; left: 50%;
            width: 44px; height: 44px; transform: translate(-50%, -50%);
          }
          #orwell-status .os-prem-strip { gap: 14px; padding: 7px; }
        }
        /* M2-3 (audit B2): the pre-HOH board line — before the first HOH exists (week 1, no HOH yet)
           the three dead "HOH — / Noms — / Veto —" rows read as broken. This single line replaces
           them until the first HOH crowns. */
        #orwell-status .os-prehoh { margin: .1rem 0 .15rem; opacity: .82; font-style: italic; }`;
      document.head.appendChild(st);
    }

    // Compose the kit (collapsible). persistCollapsed:false — this panel keeps its OWN E71
    // per-user+GAME collapse key (a richer scoping than the kit's per-user); the kit renders the
    // chevron + role=button header + toggle wiring + DOM state, and delegates persistence here.
    // 0054: the kit mounts into the rail (sidebar → body fallback). NB: this panel's legacy
    // fallback anchored after #sessions-section; the kit's fallback is the sidebar root — both
    // land it in the sidebar when there's no rail, which is all the E64 placement requires.
    _gadget = window.OrwellGadgetKit.create({
      id: ID, title: "House Status", ariaLabel: "Game status",
      collapsible: true, persistCollapsed: false,
      // E71: this panel owns a richer per-user+GAME collapse key than the kit's per-user one — so
      // it persists in the kit's onCollapse hook (fired on every header toggle), keyed to _gameKey.
      onCollapse: (on) => {
        const sk = storageKey("orwell-status-collapsed");
        if (sk) { try { localStorage.setItem(sk, on ? "1" : ""); } catch (_) {} }
      },
    });
    const body = _gadget.ensure();
    el = _gadget.el;
    // The DYNAMIC header line (Week / phase / tod / stale-dot) renders into the kit TITLE slot —
    // so the live readout still reads as the card title exactly as before. Replace the static title.
    const titleSlot = el.querySelector(".og-title");
    titleSlot.classList.add("os-ttl");
    titleSlot.removeAttribute("role"); titleSlot.removeAttribute("aria-level");
    titleSlot.innerHTML =
      '<span id="os-week">Week —</span>' +
      '<span class="os-phase" id="os-phase"></span>' +
      '<span class="os-tod" id="os-tod" hidden title="Time of day in the house"></span>' +
      '<span class="os-stale" id="os-stale" hidden title="Reconnecting to the feed…" aria-label="feed offline">●</span>';
    body.innerHTML = `
        <div class="os-done" id="os-done" hidden><span id="os-done-label"></span><span id="os-done-winner"></span></div>
        <div class="os-premiere" id="os-premiere" hidden>
          <div class="os-prem-obj">Move-in night<span class="os-prem-count" id="os-prem-count"></span></div>
          <div class="os-prem-strip" id="os-prem-strip" role="group" aria-label="The premiere cast — tap a face to talk in chat" hidden></div>
          <div class="os-prem-left" id="os-prem-left" hidden></div>
        </div>
        <div class="os-ceremony" id="os-ceremony">
          <div class="os-you" id="os-you">You<span class="os-badge" id="os-you-badge" hidden></span><span class="os-rest" id="os-you-rest" hidden title="How rested you are — your own read"></span><span class="os-hint" id="os-you-hint" hidden></span></div>
          <button type="button" class="os-skip" id="os-skip" hidden title="Re-open the skip-or-keep-watching card. Skipping is one-way: you confirm it on the card.">Skip ahead to the finale</button>
          <div class="os-prehoh" id="os-prehoh" hidden>First HOH tonight</div>
          <div id="os-board">
            <div class="os-row"><span class="os-k">HOH</span><span class="os-v" id="os-hoh">—</span></div>
            <div class="os-row"><span class="os-k">Noms</span><span class="os-v os-noms" id="os-noms">—</span></div>
            <div class="os-row"><span class="os-k">Veto</span><span class="os-v" id="os-veto">—</span></div>
          </div>
          <div class="os-row" id="os-last-evict-row" hidden><span class="os-k">Last out</span><span class="os-v" id="os-last-evict">—</span></div>
        </div>
        <div class="os-roster-h" id="os-roster-h" role="heading" aria-level="3">The House</div>
        <div id="os-announce" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);"></div>`;

    // Collapse persistence stays E71 per user+game — the kit drives the DOM (class + chevron +
    // aria-expanded/label) AND fires onCollapse above, which writes the per-game key. So this
    // setter is just _gadget.setCollapsed; a header toggle, a boot restore, and a season re-apply
    // all flow through the one path (and persist the right key).
    const setCollapsed = (on) => _gadget.setCollapsed(!!on);
    const _sk = storageKey("orwell-status-collapsed");
    try {
      if (_sk && localStorage.getItem(_sk) === "1") setCollapsed(true);
    } catch (_) {}
    // F1: the read above ran under the key render() computed BEFORE this build;
    // expose the setter + record the key so a later key change re-applies.
    _applyCollapsed = setCollapsed;
    _collapseKeyApplied = _gameKey;
    return el;
  }

  function hidePanel() {
    const el = document.getElementById(ID);
    if (el) el.style.display = "none";
  }

  // V3: engine phase enums are internal vocabulary — the HUD speaks the show's.
  const PHASE_LABELS = {
    "setup": "Move-in day", "premiere": "Premiere", "hoh-competition": "HOH competition",
    "nominations": "Nominations", "veto-competition": "Veto competition",
    "veto-ceremony": "Veto ceremony", "eviction": "Eviction night",
    "final-eviction": "Final eviction", "finale": "The finale", "jury": "Jury",
    "social": "A day in the house",
    // 0111 — a graceful label for the premiere's gathered champagne-circle whole-house event (kind),
    // so if any surface renders `whereabouts().houseEvent.kind` it reads the show's vocabulary.
    "champagne-circle": "Champagne circle",
    "twist-reveal": "A twist!", // GADGET-5: one of the 8 legal structural Beat values — was falling
                                 // through to a raw word-swap ("Twist reveal") on a sealed-twist night.
  };
  const phaseLabel = (p) => PHASE_LABELS[p] || String(p || "").replace(/-/g, " ");

  // ADR 0006 — the in-game clock. A simple time-of-day graphic (no 12/24h), morning → late night.
  const TOD_LABELS = {
    "morning": "🌅 Morning", "afternoon": "🌞 Afternoon", "evening": "🌆 Evening",
    "night": "🌙 Night", "late-night": "🌌 Late night",
  };
  const todLabel = (t) => TOD_LABELS[t] || "";

  // A3: announce only what CHANGED, in show terms — never a full re-read per poll.
  let _last = { phase: null, hoh: null, noms: null, veto: null, tod: null };
  // A76: the PART of day, spoken plain (no emoji) - the clock is visible to a screen-reader player too. Announced only when it changes (morning -> afternoon ...), never per message.
  const TOD_SPOKEN = { "morning": "Morning", "afternoon": "Afternoon", "evening": "Evening", "night": "Night", "late-night": "Late night" };

  // SG-14: the veto's aftermath (who was saved off the block, who was named in their place) is a
  // one-time diff between the pre-ceremony nominee pair and the post-ceremony pair — the engine's
  // own status projection only ever carries the CURRENT nominees + whether the veto was used, not
  // the "before" half of the swap. Tracked client-side from consecutive polls; reset once a new
  // week's veto is unused again.
  let _prevNominees = []; // [{id, name}] as of the LAST poll — the pre-swap pair when the swap lands
  let _prevVetoUsed = false;
  let _vetoAftermath = null; // { holder, saved, named } once computed for the live veto-use; else null

  // TRANS-3 (#627): the power-transition / ceremony reveal used to land as a silent
  // textContent swap (no crown drop, no row flash) — when the narrator under-calls
  // the change degraded to an invisible flip. Give the CHANGED HUD row a brief delta
  // highlight (the delta is already computed for the SR announce). The CSS is
  // prefers-reduced-motion-gated: a static tint with no motion under `reduce`.
  function flashRow(el, sel) {
    try {
      const node = el.querySelector(sel);
      if (!node) return;
      node.classList.remove("os-changed");
      void node.offsetWidth;            // restart the animation if it fires again quickly
      node.classList.add("os-changed");
      const clear = () => node.classList.remove("os-changed");
      node.addEventListener("animationend", clear, { once: true });
      setTimeout(clear, 2200);          // belt-and-suspenders (reduced-motion never fires animationend)
    } catch (_) {}
  }

  function announceDeltas(el, st, names) {
    const a = el.querySelector("#os-announce");
    if (!a) return;
    const msgs = [];
    const cur = {
      phase: phaseLabel(st.phase),
      hoh: names.hoh, noms: names.noms, veto: names.veto,
      tod: TOD_SPOKEN[st.timeOfDay] || null,
    };
    if (_last.phase !== null) {
      if (cur.tod && _last.tod && cur.tod !== _last.tod) { msgs.push(cur.tod + "."); flashRow(el, "#os-tod"); }
      if (cur.phase !== _last.phase) { msgs.push(cur.phase + "."); flashRow(el, "#os-phase"); }
      if (cur.hoh !== _last.hoh && cur.hoh !== "—") { msgs.push("Head of Household: " + cur.hoh + "."); flashRow(el, "#os-hoh"); }
      if (cur.noms !== _last.noms && cur.noms !== "—") { msgs.push("On the block: " + cur.noms + "."); flashRow(el, "#os-noms"); }
      if (cur.veto !== _last.veto && cur.veto !== "—") { msgs.push("Veto: " + cur.veto + "."); flashRow(el, "#os-veto"); }
    }
    _last = cur;
    if (msgs.length) a.textContent = msgs.join(" ");
  }

  function render(st) {
    if (st && st._state !== undefined) _gameKey = computeGameKey(st._state); // F1: key before the build
    const el = ensurePanel();
    reapplyPersistedCollapse();
    // No active game (engine reports week 0 / setup) → genuinely hide (not a hiccup).
    if (!st || typeof st.week !== "number" || st.week < 1) {
      _shown = false;
      _failures = 0;
      markStale(false);
      try { document.body.dataset.gameActive = ""; } catch (_) {} // E93: pre-game is OOC
      hidePanel();
      return;
    }
    _shown = true;
    try { document.body.dataset.gameActive = "1"; } catch (_) {} // E93: the record is live
    const name = (c) => (c && c.name) || "—";

    // F4(b): gate the rendered state on started && !finished. Once the season is OVER (the engine's
    // public over-signal), the live ceremony rows are stale — render a clean terminal state ("Season
    // complete — winner: <name>") instead of a frozen "Week N / Phase". The winner is the Vault-free
    // broadcast winner the status projection now carries.
    const done = !!st.finished;
    const ceremonyEl = el.querySelector("#os-ceremony");
    const doneEl = el.querySelector("#os-done");
    if (done) {
      el.querySelector("#os-week").textContent = "Season complete";
      el.querySelector("#os-phase").textContent = "";
      { const t = el.querySelector("#os-tod"); if (t) t.hidden = true; } // ADR 0006: no clock post-season
      if (ceremonyEl) ceremonyEl.hidden = true;
      const w = st.winner && st.winner.name;
      if (doneEl) {
        doneEl.hidden = false;
        // F6 (#1023): the terminal label is rendered FROM state here, never baked into the static
        // gadget template — so a pre-game/empty render of the gadget carries no stale "Season complete".
        const lbl = doneEl.querySelector("#os-done-label");
        if (lbl) lbl.textContent = "Season complete";
        doneEl.querySelector("#os-done-winner").innerHTML =
          w ? ' — winner: <span class="os-winner">' + esc(w) + "</span>" : "";
      }
      // F-NEW-11: the highest-stakes event must reach SR users — announce the result once
      // through the dedicated polite announcer (the winner is injected via innerHTML into a
      // non-live node, so without this the season's end is silent). Guard on a change so a
      // re-poll of the same finished state doesn't re-announce every cadence.
      if (_last.done !== true) {
        const a = el.querySelector("#os-announce");
        if (a) a.textContent = w ? ("Season complete. The winner is " + w + ".") : "Season complete.";
      }
      _last = { phase: null, hoh: null, noms: null, veto: null, done: true }; // reset deltas; result announced above
      if (st._state !== undefined) renderRoster(el, st, st._state);
      el.style.display = "block";
      return;
    }
    if (ceremonyEl) ceremonyEl.hidden = false;
    if (doneEl) doneEl.hidden = true;

    setText(el.querySelector("#os-week"), "Week " + st.week);
    setText(el.querySelector("#os-phase"), phaseLabel(st.phase));
    // ADR 0006: the in-game clock (ORWELL_TIME_OF_DAY is default-ON engine side and the FE setting time_of_day_enabled is True; absent timeOfDay ⇒ the chip simply stays hidden).
    { const todEl = el.querySelector("#os-tod"); const tod = todLabel(st.timeOfDay) + (todLabel(st.timeOfDay) && Number.isInteger(st.dayNumber) && st.dayNumber > 0 ? ", Day " + st.dayNumber : ""); // ORW-115: "Morning, Day 1" (time of day only, not minutes)
      if (todEl) { if (tod) { setText(todEl, tod); todEl.hidden = false; } else todEl.hidden = true; } }
    setText(el.querySelector("#os-hoh"), name(st.hoh));
    const idOf = (c) => (c && typeof c === "object" ? c.id : c);
    const nomRefs = Array.isArray(st.nominees) ? st.nominees : [];
    const noms = nomRefs.map((n) => n.name).filter(Boolean);
    setText(el.querySelector("#os-noms"), noms.length ? noms.join(", ") : "—");
    const veto = st.veto || {};
    const vetoUsedNow = !!veto.used;
    // SG-14: the veto's aftermath — diff the nominee pair the moment the veto flips to used, so
    // the board can say WHO was saved and WHO was named in their place, not just "used · holder".
    if (vetoUsedNow && !_prevVetoUsed) {
      const prevIds = _prevNominees.map((n) => n.id);
      const curIds = nomRefs.map(idOf);
      const savedNom = _prevNominees.find((n) => !curIds.includes(n.id));
      const namedNom = nomRefs.find((n) => !prevIds.includes(idOf(n)));
      _vetoAftermath = {
        holder: veto.holder ? veto.holder.name : "",
        saved: savedNom ? savedNom.name : "",
        named: namedNom ? namedNom.name : "",
      };
    } else if (!vetoUsedNow) {
      _vetoAftermath = null; // a new week's unused veto clears the last week's aftermath
    }
    _prevVetoUsed = vetoUsedNow;
    _prevNominees = nomRefs.map((n) => ({ id: idOf(n), name: n.name }));
    const showAftermath = vetoUsedNow && _vetoAftermath && _vetoAftermath.saved && _vetoAftermath.named &&
      (st.phase === "veto-ceremony" || st.phase === "eviction");
    const vetoText = showAftermath
      ? "used by " + (_vetoAftermath.holder || "—") + " — saved " + _vetoAftermath.saved + " · " + _vetoAftermath.named + " named"
      : veto.used
        ? "used" + (veto.holder ? " · " + veto.holder.name : "")
        : (veto.holder ? veto.holder.name : "—");
    setText(el.querySelector("#os-veto"), vetoText);
    // M2-3: pre-HOH board reframe — swap the three dead em-dash rows for a single "First HOH tonight"
    // line until the first HOH is crowned (the rows still exist + update underneath, just hidden).
    { const preHoh = isPreHoh(st);
      const boardEl = el.querySelector("#os-board");
      const preHohEl = el.querySelector("#os-prehoh");
      if (boardEl) boardEl.hidden = preHoh;
      if (preHohEl) preHohEl.hidden = !preHoh; }
    announceDeltas(el, st, {
      hoh: name(st.hoh),
      noms: noms.length ? noms.join(", ") : "—",
      veto: vetoText,
    });
    // SG-13: the last eviction's result + tally — a Vault-free, already-public broadcast fact
    // (the anonymized reveal, E12-safe) the status projection doesn't carry YET. Wired
    // defensively so it lights up the moment the engine adds `status.lastEviction` (an
    // engine-side addition out of scope for this pass); until then it stays hidden — never a
    // guess, never a fabricated tally.
    const lastEvictRow = el.querySelector("#os-last-evict-row");
    if (lastEvictRow) {
      const le = st.lastEviction;
      const evictee = le && le.evictee && (le.evictee.name || le.evictee);
      if (evictee) {
        setText(el.querySelector("#os-last-evict"), String(evictee) + (le.tally ? " · " + le.tally : ""));
        lastEvictRow.hidden = false;
      } else {
        lastEvictRow.hidden = true;
      }
    }
    if (st._state !== undefined) renderRoster(el, st, st._state);
    el.style.display = "block";
  }

  // PREMIERE — THE CHAMPAGNE CIRCLE (owner ruling 2026-07-14): the premiere gadget is now a pure,
  // Vault-free CAST ROSTER strip. The whole house is met at the champagne toast (feature 0111), so there
  // is NO "X of 15 met" progress counter and NO "still to meet" checklist — the introductions auto-happen
  // at the toast, in chat, not by milling about. Shown while the engine's `premiere` projection is present
  // (the premiere moment) and hidden the instant the first HOH begins (the engine drops the `premiere`
  // field). Public facets only — names + faces, never a number about a houseguest, a soul, or a standing.
  function renderPremiere(el, state) {
    const wrap = el.querySelector("#os-premiere");
    if (!wrap) return;
    const prem = state && state.premiere;
    // Present iff the engine is in the premiere moment — no `complete` gate (the roster shows throughout
    // the premiere, even though the whole house is met at the toast).
    if (!prem || typeof prem !== "object") { clearPremiereStrip(el); wrap.hidden = true; return; }
    // No progress count and no still-to-meet list — everyone is met at the toast. Keep the elements in the
    // DOM but empty/hidden; the roster strip is the only content now.
    const countEl = el.querySelector("#os-prem-count");
    if (countEl) countEl.textContent = "";
    const leftEl = el.querySelector("#os-prem-left");
    if (leftEl) { leftEl.textContent = ""; leftEl.hidden = true; }
    renderPremiereStrip(el, state); // the sixteen-tile cast roster strip
    wrap.hidden = false;
  }

  // M2-3 (audit B2): the PREMIERE CAST STRIP — a Vault-free row of sixteen monogram tiles (the shared
  // OrwellMonogram kit). Since the champagne circle meets the WHOLE house at the toast (feature 0111,
  // owner ruling 2026-07-14), this is now a pure cast ROSTER (every tile lit) — NOT a still-to-meet
  // tracker: the premiere projection's `remaining` set is empty, so the met-flag machinery below simply
  // lights every face. Each tile carries ONLY the public roster card (id/name/status) — no soul, number,
  // or hidden field. Clicking a tile FOCUSES the chat (ADR 0003: augments, never replaces). It lives
  // inside #os-premiere, so it appears throughout the premiere and retires the moment the first HOH
  // begins (the engine drops the `premiere` field). Keyed, idempotent upsert (no flicker).
  const _stripTiles = new Map(); // roster id -> tile button
  // Shared teardown: hide the strip and remove every tile (buttons + their click listeners). Called from
  // renderPremiereStrip AND from every renderPremiere hide/early-return path, so stale tiles never linger
  // in the hidden block when the premiere completes or becomes invalid.
  function clearPremiereStrip(el) {
    const strip = el && el.querySelector("#os-prem-strip");
    if (strip) strip.hidden = true;
    for (const [k, t] of Array.from(_stripTiles)) { t.remove(); _stripTiles.delete(k); }
  }
  function renderPremiereStrip(el, state) {
    const strip = el.querySelector("#os-prem-strip");
    if (!strip) return;
    const prem = state && state.premiere;
    // Roster shows throughout the premiere (champagne circle — the whole house is met at the toast); no
    // `complete` gate. Hidden only when premiere is absent (first HOH begun) or the monogram kit is missing.
    if (!prem || typeof prem !== "object" || !window.OrwellMonogram) {
      clearPremiereStrip(el);
      return;
    }
    // The full roster (player + house) — the same public cards the cast gallery renders. /state carries
    // no portrait ref here, so every tile is the id-seeded monogram (which is exactly the DoD).
    const cards = [];
    const p = state && state.player;
    if (p && p.name) cards.push({ id: p.id || "player", name: p.name, status: p.status || "active", isPlayer: true });
    const house = Array.isArray(state && state.house) ? state.house : [];
    const cardKeys = new Set(cards.map((c) => String(c.id))); // dedupe a repeated public-roster entry
    for (const h of house) {
      if (cards.length >= 16) break;                          // player + up to 15 houseguests = the 16-tile strip
      if (!h || !h.name) continue;
      const hk = String(h.id || h.name);
      if (cardKeys.has(hk)) continue;
      cardKeys.add(hk);
      cards.push({ id: h.id || h.name, name: h.name, status: h.status || "active", isPlayer: false });
    }
    if (!cards.length) {
      clearPremiereStrip(el);
      return;
    }
    const unmet = new Set(premiereUnmetIds(prem)); // the not-yet-lit tiles
    const seen = new Set();
    for (const card of cards) {
      const key = String(card.id);
      seen.add(key);
      const met = card.isPlayer || (!unmet.has(key) && !unmet.has(String(card.name))); // player always met; honor premiereUnmetIds' id-or-name key
      let tile = _stripTiles.get(key);
      if (!tile) {
        tile = document.createElement("button");
        tile.type = "button";
        tile.className = "os-tile ow-portrait ow-portrait-tile"; // #1638: kit frame + interactive tile
        tile.dataset.hgId = key;
        tile.addEventListener("click", focusChat); // ADR 0003: focus chat, never replace it
        _stripTiles.set(key, tile);
      }
      // #1324: a real persisted portrait when the shared OrwellMonogram cache (id→portrait,
      // refreshed off the ONE `orwell:gamechanged` dispatcher) has one on file, the designed
      // monogram otherwise (face()'s own sanctioned fallback) — never forced to monogram-only.
      const cached = window.OrwellMonogram.portraitFor ? window.OrwellMonogram.portraitFor(card.id) : null;
      // Repaint only when identity/status/met/portrait changed — a loaded tile is never rebuilt
      // (no flicker), but a portrait landing OR being regenerated mid-premiere DOES change the
      // sig so the tile upgrades (the URL itself is in the sig — portrait_ref cache-busts with a
      // per-cast epoch, so a re-shoot changes the URL; greptile review on #1328).
      const sig = card.name + "|" + card.status + "|" + (met ? "1" : "0") + "|" + ((cached && cached.portrait) || "");
      if (tile._owSig !== sig) {
        tile._owSig = sig;
        tile.innerHTML = "";
        tile.appendChild(window.OrwellMonogram.face(
          { id: card.id, name: card.name, status: card.status, portrait: cached && cached.portrait },
          { alt: card.name }));
        tile.classList.toggle("os-tile-unmet", !met); // the unlit gate (CSS pin)
        tile.classList.toggle("ow-portrait--muted-grey", !met); // #1638: the shared dim+desaturate modifier
        const you = card.isPlayer ? " (you)" : "";
        tile.setAttribute("aria-label", card.name + you + (met ? " — met" : " — not yet met") + ". Tap to talk in chat.");
        tile.title = card.name + (met ? "" : " — not yet met");
      }
    }
    // Drop vanished ids (defensive) and reconcile order (player first, then house order).
    for (const [k, t] of Array.from(_stripTiles)) {
      if (!seen.has(k)) { t.remove(); _stripTiles.delete(k); }
    }
    const desired = cards.map((c) => _stripTiles.get(String(c.id)));
    const cur = Array.from(strip.children);
    if (cur.length !== desired.length || desired.some((n, i) => cur[i] !== n)) {
      for (const n of desired) strip.appendChild(n);
    }
    strip.hidden = false;
  }

  // The head-count tally + the player's own public role badge. From getGameState().house[] + the
  // ceremony status. No numbers. #955: the per-person NAME LIST was removed — it duplicated the
  // cast PHOTO gallery (#orwell-cast), which is now the single roster surface. This keeps only the
  // at-a-glance attrition count ("The House · N/N"), the premiere objective, the self badge, and
  // the player's own rest cue.
  function renderRoster(el, st, state) {
    renderPremiere(el, state);
    // GADGET-2/SG-15: render EVERY applicable badge (a nominee holding the veto shows both).
    const badgeEl = el.querySelector("#os-you-badge");
    const badges = selfBadge(st, state);
    if (badges.length) { setText(badgeEl, badges.join(" · ")); badgeEl.hidden = false; }
    else { badgeEl.hidden = true; }

    // E-1: a WATCHING pre-jury evictee may re-open the skip-or-watch card (switching to skip is confirmed ON the card). Hidden for everyone else and while a card is open.
    const skipEl = el.querySelector("#os-skip");
    if (skipEl) {
      const pl = state && state.player;
      const show = !!(pl && pl.status === "evicted" && pl.spectator === "watch" && !(st && st.finished) && !(st && st.pending));
      skipEl.hidden = !show;
      if (!skipEl._owBound) {
        skipEl._owBound = true;
        skipEl.addEventListener("click", async () => {
          skipEl.disabled = true;
          try {
            await fetch("/api/orwell/spectator/raise", { method: "POST", credentials: "same-origin" });
            try { window.orwellGameChanged && window.orwellGameChanged("spectator-raise"); } catch (_) {}
          } catch (_) { /* the player can ask in chat instead */ }
          finally { skipEl.disabled = false; }
        });
      }
    }

    // SG-15: the phase-conditional eviction-night seat cue.
    const hintEl = el.querySelector("#os-you-hint");
    if (hintEl) {
      const hint = seatHint(st, state);
      if (hint) { setText(hintEl, hint); hintEl.hidden = false; }
      else { hintEl.hidden = true; }
    }

    // ADR 0006 §Principle 5: the player's OWN qualitative tiredness — a cue (never a number), and only
    // ever the player's own (no NPC's). Absent ⇒ hidden (the clock isn't running).
    const restEl = el.querySelector("#os-you-rest");
    if (restEl) {
      const rest = state && state.player && state.player.restStatus;
      if (rest) { restEl.textContent = "· " + rest; restEl.hidden = false; }
      else { restEl.hidden = true; }
    }

    // E71: key panel state to this user's game (same derivation as render()'s
    // pre-build assignment — computeGameKey is the single source, F1).
    _gameKey = computeGameKey(state);

    // #955: the house TALLY ("The House · N/N") — the at-a-glance attrition count. The names + faces
    // are the cast PHOTO gallery's job now (#orwell-cast), so this no longer renders a name list.
    const headEl = el.querySelector("#os-roster-h");
    const house = state && Array.isArray(state.house) ? state.house : null;
    if (!house) { headEl.style.display = "none"; return; }
    headEl.style.display = "";

    // player (if still active) counts as a houseguest, so the count matches the cast gallery's
    // active/total reading. No number about any houseguest crosses — just the head count.
    const playerActive = state.player && state.player.status === "active";
    const total = house.length + 1; // player + NPCs
    const activeCount = house.filter((h) => h.status === "active").length + (playerActive ? 1 : 0);
    setText(headEl, "The House · " + activeCount + "/" + total);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // TRANS-25: guard every plain HUD text write so an unchanged value never re-mutates the DOM
  // (the status HUD text nodes were wholesale-replaced on EVERY poll, unsynchronized with the
  // narration stream — a flicker/latch risk under concurrent updates). A no-op when the value
  // already matches; deterministically stable values are simply never touched again.
  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  // True once we've shown a real game at least once this session. Lets a transient engine
  // hiccup keep the last-known panel up (U5) instead of vanishing the player's only readout.
  let _shown = false;

  // C18: a hidden tab polls nothing; consecutive failures back the poll off (max 2 min).
  // E68: a SUCCESS resets the backoff — one blip must not degrade a live game to 2-minute polls.
  let _failures = 0;
  function _pollDelay() { return Math.min(POLL_MS * Math.pow(2, _failures), 120000); }

  // 4.1.3: false = feed believed connected (the default). Announce on a genuine FLIP only.
  let _staleAnnounced = false;
  function markStale(on) {
    const el = document.getElementById(ID);
    const dot = el && el.querySelector("#os-stale");
    if (dot) dot.hidden = !on;
    // WCAG 4.1.3 (Status Messages): the amber dot is a purely visual cue. Mirror the sibling HUD
    // deltas (announceDeltas → #os-announce) by pushing ONE polite line when the feed's connected
    // state actually FLIPS — never on every poll (a live region must not chatter), and never on the
    // initial connected state (no phantom "reconnected" on first load).
    const nextState = !!on;
    if (_staleAnnounced !== nextState) {
      _staleAnnounced = nextState;
      const a = el && el.querySelector("#os-announce");
      if (a) a.textContent = nextState ? "Reconnecting to the feed." : "Feed reconnected.";
    }
  }

  // M1-3 (audit A3): beatSeq catch-up. A gamechanged event can CLAIM a committed beat
  // (tool result / decision response); if our refetch reads an older beat, the read raced
  // the engine commit — the exact "goodbye card beside a board still reading HOH" lag.
  // Re-fetch briefly (bounded) until the read catches the claimed commit, instead of
  // rendering stale for a whole 20–30s poll interval. Poll cadence itself is unchanged.
  let _catchupTimer = null;
  let _catchupTries = 0;

  async function refresh(wantBeat) {
    let st;
    try {
      st = await fetchStatus();
    } catch (_) {
      // ENGINE HICCUP (not "no game"): if we've shown the panel, keep the last-known
      // values up and flag the feed as reconnecting — don't blink the readout out.
      if (window.OrwellReport) window.OrwellReport.fail("status-panel", "status-poll", _); // G11: fail open, never silent
      _failures += 1;
      if (_shown) markStale(true);
      else hidePanel();
      return;
    }
    _failures = 0; // E68: recovered — poll at full cadence again
    // G11 follow-up: a successful status poll is a confirmed engine contact — latch it so
    // any LATER fetch failure is reported as a genuine outage (INFO), not a startup race.
    if (window.OrwellReport && window.OrwellReport.markConnected) window.OrwellReport.markConnected();
    markStale(false);
    // Fold the roster in (best-effort, never blocks the ceremony rows on /state).
    st._state = (await fetchState()) || null;
    // M1-3: verify the read caught the claimed commit BEFORE painting. A read that raced the
    // engine commit (got < wantBeat) is known-stale — don't paint the stale HUD for a retry
    // interval and then correct it a beat later. Schedule the bounded catch-up refetch and
    // render only once the read is fresh (or the bounded retries are exhausted, so a beat that
    // never arrives still eventually renders the last read). The last-known panel stays up
    // meanwhile (we simply skip this paint).
    const want = Number(wantBeat);
    const got = Number(st && st.beatSeq != null ? st.beatSeq
      : (st._state && st._state.beatSeq != null ? st._state.beatSeq : NaN));
    if (Number.isFinite(want) && want > 0 && Number.isFinite(got) && got < want && _catchupTries < 3) {
      _catchupTries += 1;
      if (_catchupTimer) clearTimeout(_catchupTimer);
      _catchupTimer = setTimeout(() => refresh(want), 1000);
      return; // known-stale: don't paint; wait for the catch-up read to land
    }
    render(st);
    _catchupTries = 0;
  }

  // Seam for the headless browser gate: build + show the panel on demand.
  window._orwellStatusEnsure = () => { const el = ensurePanel(); el.style.display = "block"; return true; };

  // WS Phase-1 (§4): when the multiplexed socket is live the server PUSHES a `state`
  // frame on every board change; platform.js relays it to the one `orwell:gamechanged`
  // dispatcher, which triggers an edge refresh below. So we cancel the 20s periodic
  // TIMER in WS mode and stay edge-triggered (fail-soft: any doubt ⇒ keep polling).
  // The fallback/SSE path is unchanged and still polls.
  function _wsActive() {
    try { return !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive()); }
    catch (_) { return false; }
  }

  function start(wantBeat) {
    refresh(wantBeat);
    if (timer) clearInterval(timer);
    const tick = async () => {
      if (!document.hidden) await refresh();  // C18: no polling in a hidden tab
      // In WS mode the `state` push (via orwell:gamechanged) supersedes the poll —
      // don't re-arm the periodic timer, just stay edge-triggered.
      if (!_wsActive()) timer = setTimeout(tick, _pollDelay());
    };
    if (!_wsActive()) timer = setTimeout(tick, _pollDelay());
  }

  // Let onboarding (or any flow that changes the game) trigger an immediate refresh.
  window.orwellRefreshStatus = refresh;
  // F4(a): a turn elsewhere (run start/end) dispatches orwell:gamechanged — reconcile the HUD at
  // once instead of waiting out the ≤20s poll. Reset the backoff and re-arm the cadence so the next
  // scheduled poll counts from this fresh fetch (cancel/re-arm), not the stale in-flight tick.
  // M1-3: the event's beatSeq (when a seam supplied it) rides into refresh() so the panel
  // catch-up-fetches past a read-raced commit instead of rendering stale for a poll interval.
  window.addEventListener("orwell:gamechanged", (e) => {
    _failures = 0;
    // Cancel any in-flight catch-up retry: it was scheduled for an OLDER wanted-beat and would
    // otherwise fire after this NEWER event and refetch/paint against the stale wanted-beat.
    // Reset the attempt counter so this event's own catch-up gets its full bounded budget.
    if (_catchupTimer) { clearTimeout(_catchupTimer); _catchupTimer = null; }
    _catchupTries = 0;
    if (timer) { clearTimeout(timer); timer = null; }
    start(e && e.detail ? e.detail.beatSeq : undefined);
  });
  // WS Phase-1 (§4/§6): cancel the periodic poll the instant the socket goes live;
  // resume polling if it falls back to SSE. start() re-arms the timer only while
  // !_wsActive(), so re-running it after a downgrade restores the cadence.
  window.addEventListener("orwell:ws-active", () => { if (timer) { clearTimeout(timer); timer = null; } });
  window.addEventListener("orwell:ws-inactive", () => { _failures = 0; if (timer) { clearTimeout(timer); timer = null; } start(); });
  // The sidebar drawer handles narrow layouts; nothing to repark (E64). Kept as a
  // no-op subscription so a future narrow-specific treatment has its hook.
  onNarrowChange(() => {});

  ready(start);
})();
