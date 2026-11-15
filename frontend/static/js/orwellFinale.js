// Orwell finale surface (feature 0037 / C11) — the player-facing view of the staged jury vote,
// over the engine's Vault-free /api/orwell/finale route. A self-contained, fail-open sibling to
// orwellSocial.js: it shows ONLY while a finale is staging, renders ONLY what the route returns
// (finalists, stage, and the votes revealed SO FAR — never a pre-reveal tally or the winner), and
// never disturbs the chat if the engine is down. The binding finale decisions still flow through the
// chat agent's submitDecision seam; this panel just visualizes the reveal and offers composer-prefill
// shortcuts for the player's turn (mirroring how orwellSocial surfaces approaches).
//
//   • GET /api/orwell/finale → { finale: { stage, finalists[], asking, reveals[] } | null }
//
// Vault-free by construction (the engine withholds leans/tallies/manner/the pre-reveal winner);
// fail-open everywhere. Composes the window kit (Lane F wave 2); modalManager is
// only consulted for the minimized state the poll loop must respect.
import * as modalManager from "./modalManager.js";

(function () {
  "use strict";

  const POLL_FAST_MS = 5000;       // a finale is staging — poll briskly
  const POLL_SLOW_MS = 45000;      // no finale yet — a light heartbeat (E67/C18)
  const ID = "orwell-finale";
  const PLAYER_ID = "player";
  const ICON = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9H4.5a2.5 2.5 0 0 1 0-5H6'/><path d='M18 9h1.5a2.5 2.5 0 0 0 0-5H18'/><path d='M4 22h16'/><path d='M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22'/><path d='M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22'/><path d='M18 2H6v7a6 6 0 0 0 12 0V2Z'/></svg>";
  const STAGE_LABEL = { statements: "Opening statements", questions: "Jury questions", vote: "The jury votes", reveal: "The votes are read" };
  const APPEALS = [
    { id: "own-game", label: "Own my game" },
    { id: "mend", label: "Mend fences" },
    { id: "connect", label: "Connect personally" },
    { id: "discredit-rival", label: "Question my rival" },
  ];
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let timer = null;
  let _staging = false;            // a finale is currently live (drives the poll cadence)
  let _failures = 0;               // C18-style backoff on consecutive errors
  let _nextSeasonWarmed = false;   // 0065 Phase 1: the finale-day next-season char-data warm fired once
  function _pollDelay() {
    const base = _staging ? POLL_FAST_MS : POLL_SLOW_MS;
    return Math.min(base * Math.pow(2, _failures), 120000);
  }

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function isMinimized() {
    try { return modalManager.isMinimized && modalManager.isMinimized(ID); } catch (_) { return false; }
  }
  function hidePanel() {
    const el = document.getElementById(ID);
    if (!el) return;
    if (isMinimized()) { try { modalManager.restore(ID); } catch (_) {} }
    el.style.display = "none";
  }

  // F-2 wave 2 (DWE audit): the panel COMPOSES the window kit — chrome, drag,
  // minimize-to-dock, Escape, focus, and persistence come from OrwellWindow.
  // This module keeps only the finale content: stage, finalists, reveals, and
  // the composer-prefill move buttons.
  let _win = null;
  function ensureUI() {
    let el = document.getElementById(ID);
    if (el) return el;
    const content = document.createElement("div");
    content.innerHTML = `
      <style>
        #orwell-finale {
          width: 240px; display: none;
          /* #733: use the OrwellWindow kit TYPE (sans --ow-ui-font + the --ow-fs-body preset)
             so the Finale window reads consistent with every other kit window (cast roster,
             settings) — no bespoke mono/.74rem. The .ow-window root already supplies these, so
             this just affirms the inheritance; the numeric vote TALLY keeps --mono below (a
             tabular figure is the one place mono is intentional). */
          font-family: var(--ow-ui-font); font-size: var(--ow-fs-body, .875rem);
        }
        #orwell-finale .ofin-stage { opacity: .6; margin: 0 0 .4rem; letter-spacing: .03em; }
        #orwell-finale .ofin-final {
          display: flex; justify-content: space-between; gap: .4rem; margin-bottom: .5rem;
        }
        #orwell-finale .ofin-fin {
          flex: 1; text-align: center; background: rgba(255,255,255,.05);
          border: 1px solid var(--border, #355a66); border-radius: 8px; padding: .3rem .25rem;
        }
        #orwell-finale .ofin-fin b { display: block; color: var(--fg, #9cdef2); }
        /* #733: the numeric vote tally stays MONO (a tabular figure) — the one intentional
           mono use; the rest of the window now rides the kit's --ow-ui-font (above). */
        #orwell-finale .ofin-fin .ofin-tally { font-family: var(--mono, monospace); font-size: 1.1rem; opacity: .9; }
        #orwell-finale .ofin-hd { opacity: .6; margin: .5rem 0 .25rem; letter-spacing: .03em; }
        #orwell-finale .ofin-reveal { margin: .2rem 0; opacity: .9; display: flex; align-items: center; flex-wrap: wrap; gap: .3rem; }
        #orwell-finale .ofin-reveal b { color: var(--fg, #9cdef2); }
        /* Transient-animation audit (finale jury-reveal silent-pop): a newly-read vote row used to
           mount via a wholesale revWrap.innerHTML rebuild every poll — so each fresh vote appeared
           with NO entrance (the season's loudest beat landing as a silent text swap) and every prior
           row + its two portrait faces re-decoded each cadence. The visual path now APPENDS only
           genuinely-new rows and rides this short staged entrance (mirrors the orwellStatusPanel.js
           TRANS-3 flashRow + the ow-ceremony-reveal recipe), so each read-out vote lands with earned
           weight. Reduced-motion strips it to the original instant appearance. */
        #orwell-finale .ofin-reveal.ofin-reveal-in {
          animation: ofin-reveal-in .42s cubic-bezier(0.22, 0.61, 0.36, 1) both;
        }
        @keyframes ofin-reveal-in {
          0%   { opacity: 0; transform: translateY(5px); }
          100% { opacity: .9; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          #orwell-finale .ofin-reveal.ofin-reveal-in { animation: none; }
        }
        /* M3-4: the finalist card + reveal-row face — the OrwellMonogram kit's designed
           portrait-or-monogram tile, sized small and never the interactive target on its own
           (this panel's move buttons are the affordances; the face is presentation only). */
        #orwell-finale .ofin-fin .ofin-face {
          width: 28px; height: 28px; border-radius: 8px; overflow: hidden; margin: 0 auto .3rem;
          display: block;
        }
        #orwell-finale .ofin-reveal .ofin-face {
          width: 16px; height: 16px; border-radius: 4px; overflow: hidden; flex: none;
          display: inline-block; margin: 0;
        }
        #orwell-finale .ofin-move { margin-top: .5rem; }
        /* #775 element-kit migration: the finale move buttons now compose .ow-btn
           .ow-btn-secondary (the kit owns frosted chrome — ONE source of truth). This
           bespoke rule keeps ONLY the finale-specific LAYOUT (full-width, left-aligned
           list look, vertical rhythm) + the Normal-tier (non-glass) fallback chrome.
           The selector is intentionally un-prefixed (no #orwell-finale id) so the kit's
           body.theme-frosted .ow-btn rule wins on the glass tiers; the frosted-only
           chrome override below is retired (the kit supplies it). */
        .ofin-btn {
          /* J5-13: lift to the project tap floor (was ~27px) and bump the label off .74rem so the
             time-pressured finale move buttons are tappable + legible on coarse pointers. */
          width: 100%; cursor: pointer; border-radius: 8px; padding: .45rem .6rem; margin: .2rem 0; min-height: 44px;
          background: rgba(255,255,255,.05); color: inherit; border: 1px solid var(--border, #355a66);
          font-family: inherit; font-size: .82rem; text-align: left;
          /* the kit centers content; the finale list look is left-aligned full-width */
          justify-content: flex-start;
        }
        #orwell-finale .ofin-btn:hover { border-color: var(--accent, #e06c75); }
        /* #894 (RESP-3/5, #780-3): the narrow-tier presentation is the kit's #893 bottom
           sheet (sheet:true on the create() opts below) — edge-to-edge, detent-sized,
           scroll-contained body. Two consumer-level geometry overrides ride on top, both
           by #id specificity (the kit's presentation rules are class-scoped):
             1. WIDTH — the base #orwell-finale width:240px rule above out-ranks the kit's
                width:auto, so the sheet would render a narrow 240px slab; reset it so the
                sheet goes full-width.
             2. CLEAR THE COMPOSER (browser_smoke F3) — the kit pins the sheet bottom:0,
                which would BURY the composer ("the conversation is the game"; the Finale
                is non-modal and coexists with the composer for the vote-prefill). Lift the
                sheet's bottom above the composer via the live --composer-clearance var
                (init.js syncs it to the composer height + an 8px gap; the slot bottoms base
                off the same var), so f.bottom = composer.top - 8, and cap the height so
                even the full detent never overruns the top. The finalist content scrolls
                inside the kit's .ow-body.
           The docked-narrow case is unaffected (a docked window is in-flow; bottom/height
           are inert on a static element). */
        @media (max-width: 768px) {
          #orwell-finale {
            width: auto !important; max-width: none !important;
            bottom: var(--composer-clearance, 84px);
            max-height: calc(100dvh - var(--composer-clearance, 84px) - 24px);
          }
          /* ORW-77 (#1418): a LIVE decision card (juror-vote, finale statement/question) outranks the finale panel's BODY on a phone - the panel is a bottom sheet and covered the
             card. Layout chosen (the card's options: stack / collapse / nest): COLLAPSE the floating panel to its header while a card is live, so the finalists and tallies are one
             tap away (the header expands again the moment the card is answered or dismissed) but nothing sits on top of the card. Pure CSS - the card element is the signal, like the
             retro's rule - so no poll and no state to drift. A docked panel is rail-flow and never overlaps, so it is untouched. */
          body:has(#orwell-decision-card) #orwell-finale:not(.ow-docked) .ow-body { display: none !important; }
        }
        /* #725: soften the inner var(--border) strokes (finalist cards, move buttons) to the
           low-opacity WHITE hairline on the light glass — Apple defines glass by lensing, not a
           hard dark line. The :hover accent rim on the move buttons stays (transient interaction). */
        body.theme-frosted #orwell-finale .ofin-fin {
          border-color: rgba(255,255,255,0.14);
        }
      </style>
      <div class="ofin-stage" id="ofin-stage"></div>
      <div class="ofin-hd" id="ofin-asking" hidden></div>
      <div class="ofin-final" id="ofin-final"></div>
      <div class="ofin-hd" id="ofin-reveal-hd" style="display:none">The votes</div>
      <div id="ofin-reveals"></div>
      <div class="ofin-move" id="ofin-move"></div>
      <div id="ofin-announce" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);"></div>`;
    // The kit owns chrome, drag, dock, Escape, focus, and the ONE position
    // system (the clamped slot offset "finale" — the F5 dual-persistence era is
    // over; wave 1 shipped the stale-key cleanup, retired here).
    _win = window.OrwellWindowKit.create({
      // #780: monochrome icon language — no full-color emoji in the titlebar (the kit
      // renders `title` verbatim). The glyph is the mono SVG `icon` slot.
      id: ID, title: "The Finale", icon: ICON,
      slot: "top-left", slotKey: "finale", role: "complementary",
      // An ambient HUD parks (minimize); the finale exists while one is staging,
      // so it carries no close — a capability of the one kit cluster.
      minimizable: true, closable: false, draggable: true,
      // 0054 Phase 2: dockable into the control-room rail (default floating — a one-
      // line owner flip to defaultDocked:true). Docked, it rides the rail's single
      // mobile drawer + content-driven visibility (it self-hides when not staging).
      dockable: true, defaultDocked: false,
      // #894 (RESP-3/5, #780-3): on the narrow tier present as a bottom SHEET (the
      // proven Cast recipe — orwellCast.js) instead of a floating window that opens
      // top-left/clipped over the chat + composer. Non-modal windows opt in
      // explicitly; docked still wins (the rail owns docked placement).
      sheet: true,
      // #573 gesture unification: minimize now DOCKS the finale into the control room.
      // On the dock/undock re-home the kit keeps the SAME instance + content node but
      // rebuilds the element; re-assert the finale's display for the new mode (docked →
      // inline `flex` in the rail, floating → `block`) so a just-docked finale is visible
      // immediately — its content CSS defaults to `display:none`, so without this it would
      // dock invisibly and the rail would hide.
      onDock: () => { try { window._orwellFinaleEnsure && window._orwellFinaleEnsure(); } catch (_) {} },
      content,
    });
    _win.open();
    return document.getElementById(ID);
  }

  // Prefill the composer (never auto-send) — the chat agent reads it and calls submitDecision.
  function prefill(text) {
    const box = document.getElementById("message");
    if (!box) return;
    box.value = text;
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus();
  }

  // GADGET-15: mirror orwellDeals.js's `nameMapFrom`/`otherParty` pattern — resolve a NamedRef's
  // id against the roster (the SAME /state payload refresh() already fetches) before falling
  // back to the generic "A houseguest", instead of showing the fallback on every row whenever a
  // ref's own `name` wasn't populated at write time (finalist cards, vote reveals, vote buttons).
  function nameMapFrom(st) {
    const m = Object.create(null);
    if (!st || typeof st !== "object") return m;
    const p = st.player;
    if (p && typeof p === "object" && p.id != null && p.name) m[String(p.id)] = String(p.name);
    const house = Array.isArray(st.house) ? st.house : [];
    for (const hg of house) {
      if (hg && typeof hg === "object" && hg.id != null && hg.name) m[String(hg.id)] = String(hg.name);
    }
    return m;
  }
  // The roster map from the LAST /state fetch (refresh() refreshes it every poll, alongside the
  // finale fetch) — nameOf() reads it directly so render()'s own signature/call sites stay
  // untouched (a source-pinned convention gate matches `function render(finale) {` verbatim).
  let _nameById = Object.create(null);
  function nameOf(ref) {
    if (ref && ref.name) return ref.name;
    if (ref && ref.id != null && _nameById[String(ref.id)]) return _nameById[String(ref.id)];
    return "A houseguest";
  }
  // M3-4 (road-to-market): a lightweight roster-portrait cache — mirrors _nameById's fetch-and-
  // cache shape, but /state (the finale's own name source) carries no portrait ref, so this reads
  // the public roster route (id/name/status/portrait — the SAME public projection every cast
  // surface renders; Vault-free). Fire-and-forget from refresh() (below): a not-yet-warm or
  // failed cache simply leaves every face on the OrwellMonogram fallback and self-heals on the
  // next 5s/45s poll — it never blocks the finale panel.
  let _portraitById = Object.create(null);
  async function _refreshRosterCache() {
    try {
      const r = await fetch("/api/orwell/roster", { credentials: "same-origin" });
      if (!r.ok) return;
      const data = await r.json();
      const roster = Array.isArray(data && data.roster) ? data.roster : [];
      const map = Object.create(null);
      for (const hg of roster) {
        if (hg && hg.id != null) map[String(hg.id)] = { portrait: hg.portrait || null, status: hg.status || "active" };
      }
      _portraitById = map;
    } catch (_) { /* fail open — every face renders the monogram fallback */ }
  }
  // The finale jury reveal rows carry faces (M3-4): a small OrwellMonogram face (portrait, or the
  // monogram fallback) for a NamedRef — null when the kit or the ref is unavailable, so callers can
  // skip appending it (fails open; text-only rows are still fully correct).
  function faceEl(ref) {
    if (!ref || !window.OrwellMonogram) return null;
    const cached = ref.id != null ? _portraitById[String(ref.id)] : null;
    const el = window.OrwellMonogram.face(
      { id: ref.id, name: nameOf(ref), status: (cached && cached.status) || "active",
        portrait: cached && cached.portrait },
      { alt: nameOf(ref) }
    );
    el.classList.add("ofin-face");
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  // A reveal row's faces read _portraitById at BUILD time; the roster cache fills async, so a face
  // can mount as a monogram fallback and then need refreshing once its portrait lands. This signature
  // captures each person's portrait availability so an append-only row can be rebuilt ONLY when it
  // actually changed (no per-poll churn) — the reveal-row counterpart of the finalist-card _finSig.
  function _faceSig(ref) {
    if (!ref) return "";
    const c = ref.id != null ? _portraitById[String(ref.id)] : null;
    return String(ref.id != null ? ref.id : nameOf(ref)) + "|" + ((c && c.portrait) || "") + "|" + ((c && c.status) || "active");
  }
  function _revFaceSig(r) {
    return _faceSig(r && r.juror) + "!" + _faceSig(r && r.votedFor);
  }
  // Transient-animation audit: play the reveal-row entrance once, then strip the marker (a lingering
  // class would re-fire on any later className touch). Mirrors orwellStatusPanel.js's flashRow — the
  // setTimeout belt clears it under prefers-reduced-motion (where animationend never fires).
  function _animateIn(node) {
    try {
      node.classList.add("ofin-reveal-in");
      const clear = () => node.classList.remove("ofin-reveal-in");
      node.addEventListener("animationend", clear, { once: true });
      setTimeout(clear, 1200);
    } catch (_) {}
  }
  // A stable identity for a finalist card so a poll reuses its node (and its decoded portrait) rather
  // than rebuilding it — the face re-decodes ONLY when the portrait/status genuinely lands/changes.
  function _finSig(f) {
    const cached = f && f.id != null ? _portraitById[String(f.id)] : null;
    return [String((f && f.id) || nameOf(f)), (cached && cached.portrait) || "", (cached && cached.status) || "active"].join("|");
  }
  // Build one reveal row (juror → voted-for, each with a face) — shared by the first-render sync and
  // the append-only during-session path so the two never drift.
  function _buildRevealRow(r) {
    const line = document.createElement("div");
    line.className = "ofin-reveal";
    line.setAttribute("data-rev-facesig", _revFaceSig(r)); // so a later portrait landing can refresh this row (append-only rows aren't otherwise revisited)
    // M3-4: each reveal row carries the juror's + the voted-for finalist's face (portrait, or the
    // OrwellMonogram fallback) beside their name — built via DOM (not innerHTML) so the faces slot
    // in at the right reading-order position; aria-hidden keeps them decorative.
    const jFace = faceEl(r.juror);
    if (jFace) line.appendChild(jFace);
    const jB = document.createElement("b"); jB.textContent = nameOf(r.juror);
    line.appendChild(jB);
    line.appendChild(document.createTextNode(" votes for "));
    const vFace = faceEl(r.votedFor);
    if (vFace) line.appendChild(vFace);
    const vB = document.createElement("b"); vB.textContent = nameOf(r.votedFor);
    line.appendChild(vB);
    return line;
  }
  // The VISUAL mirror of _lastRevealCount (which drives the aria-live announce). Kept separate so the
  // two stay decoupled: the visual path appends new rows + animates them, the aria path announces.
  // -1 = nothing mounted this page session yet; the first render syncs the already-read reveals
  // WITHOUT an entrance (a reload mid-reveal must not replay every vote's animation).
  let _shownRevealCount = -1;
  // -1 = not yet rendered this page load. The FIRST render (live OR after a refresh) syncs
  // the count WITHOUT announcing — otherwise a reload mid-finale re-announced every vote
  // already on screen through the aria-live region (reload-persistence audit). Only reveals
  // that land DURING this page session are announced.
  let _lastRevealCount = -1;
  // A11Y-3: the stage label is NO LONGER its own aria-live region (#ofin-stage re-announced the
  // UNCHANGED stage name every ~5s poll during jury questioning, drowning out the streamed Q&A /
  // vote reveals on the SAME-priority hidden #ofin-announce region). Instead we announce a stage
  // CHANGE once, through the one hidden #ofin-announce region — tracking the last announced stage
  // so a re-poll of the same stage stays silent. null = nothing announced yet this page session;
  // the first render syncs WITHOUT announcing (mirrors _lastRevealCount), so a reload mid-finale
  // never re-announces the stage already on screen.
  let _lastStage = null;

  function render(finale) {
    const el = ensureUI();
    // 0054 Phase 2 + #573 gesture unification: when docked, the finale lives in the
    // control-room rail. Set an EXPLICIT inline `display:flex` (never "" — the finale's
    // own `#orwell-finale{display:none}` ID rule out-ranks the `.ow-docked` class rule,
    // so clearing the inline display would leave a docked finale invisible and hide the
    // rail; inline `flex` beats the ID rule AND matches the .ow-docked flex-column layout).
    // Floating shows as a block as before.
    const _wasHidden = !el.style.display || el.style.display === "none";
    if (_win && _win.isDocked && _win.isDocked()) el.style.display = "flex";
    else if (!isMinimized()) el.style.display = "block";
    // #780 (finale opens flush top-left, clipped): the finale's content CSS defaults to
    // `display:none`, so the slot restack at open() SKIPS it (an invisible entry is not
    // stacked) and it sits at the CSS-default 0,0 — its red traffic-light clipped under
    // the viewport edge. The moment it becomes visible, re-run the slot stack so it
    // anchors to its `top-left` base (below the banner, past the sidebar). Idempotent.
    if (_wasHidden && el.style.display && el.style.display !== "none") {
      try { window.OrwellSlots && window.OrwellSlots.restackAll && window.OrwellSlots.restackAll(); } catch (_) {}
    }

    const finalists = Array.isArray(finale.finalists) ? finale.finalists : [];
    const reveals = Array.isArray(finale.reveals) ? finale.reveals : [];
    const stageLabel = STAGE_LABEL[finale.stage] || "The finale";
    document.getElementById("ofin-stage").textContent = stageLabel;
    // GADGET-9: name WHICH juror is asking during the "questions" stage — the engine already
    // projects it (`GameSession.ts` `asking: NamedRef | null`), but nothing in this panel ever
    // read it, so the per-juror mechanic CLAUDE.md calls out ("takes one question per juror") had
    // no visible progress readout at all.
    const askingEl = document.getElementById("ofin-asking");
    if (askingEl) {
      const askingName = finale.asking ? nameOf(finale.asking) : "";
      if (askingName) { askingEl.textContent = "Asking: " + askingName; askingEl.hidden = false; }
      else { askingEl.hidden = true; }
    }
    // A11Y-3: announce a stage TRANSITION (not the unchanged stage on every poll) through the one
    // hidden #ofin-announce region, alongside any fresh vote reveals below. Skip the very first
    // sync of this page session (mirrors _lastRevealCount) so a reload mid-finale never re-announces.
    const stageChanged = _lastStage !== null && finale.stage !== _lastStage;
    _lastStage = finale.stage;

    // Finalists + a tally of the REVEALED votes only (never a pre-reveal total or the winner).
    const tally = {};
    for (const r of reveals) { const id = r.votedFor && r.votedFor.id; if (id) tally[id] = (tally[id] || 0) + 1; }
    // Finalist cards: reconcile by finalist id (not a wholesale `finWrap.innerHTML` rebuild every
    // poll) so the portrait face + card node survive — only the live tally text moves each reveal,
    // and the face re-decodes ONLY when its portrait actually lands (see _finSig). This kills the
    // per-cadence face churn the transient-animation audit flagged.
    const finWrap = document.getElementById("ofin-final");
    const finHave = new Map();
    Array.prototype.forEach.call(finWrap.children, (node) => {
      const k = node.getAttribute("data-fin-key");
      if (k != null) finHave.set(k, node);
    });
    const finWant = new Set();
    let finRef = null;
    for (let i = finalists.length - 1; i >= 0; i--) {
      const f = finalists[i];
      const key = String((f && f.id) || nameOf(f));
      const sig = _finSig(f);
      finWant.add(key);
      let card = finHave.get(key);
      if (!card || card.getAttribute("data-fin-sig") !== sig) {
        const stale = card; // the prior card for this key (e.g. before its portrait landed), still in finWrap
        card = document.createElement("div");
        card.className = "ofin-fin";
        card.setAttribute("data-fin-key", key);
        card.setAttribute("data-fin-sig", sig);
        const face = faceEl(f); // M3-4: the finalist card carries a face
        if (face) card.appendChild(face);
        const b = document.createElement("b"); b.textContent = nameOf(f);
        const t = document.createElement("span"); t.className = "ofin-tally";
        card.appendChild(b); card.appendChild(t);
        finHave.set(key, card);
        // REPLACE the stale node in place (its key is still wanted, so the cleanup below won't drop it) —
        // else insertBefore(card, finRef) mounts the fresh card BESIDE the old one → duplicate finalist
        // card on a signature change (portrait landing). Mirrors orwellCastPin/RoomStrip replaceChild.
        if (stale && stale.parentNode) stale.parentNode.replaceChild(card, stale);
      }
      // the tally is the one thing that changes every reveal — update the persistent node's text only
      const t = card.querySelector(".ofin-tally");
      if (t) {
        const n = String(tally[f.id] || 0);
        if (t.textContent !== n) t.textContent = n;
        t.setAttribute("aria-label", String(tally[f.id] || 0) + " votes"); // J5-14: the bare number has no accessible meaning
      }
      // insert a freshly-built card (not yet a child) OR move one out of position; a correctly
      // placed reused card is left untouched (its portrait face is not re-decoded).
      if (card.parentNode !== finWrap || card.nextSibling !== finRef) finWrap.insertBefore(card, finRef);
      finRef = card;
    }
    finHave.forEach((node, k) => { if (!finWant.has(k)) node.remove(); });

    // The reveal, in the order the engine read it (revealed votes only). New reveals
    // are ANNOUNCED politely (E67): the vote reading is the season's loudest moment.
    // A11Y-3: a stage TRANSITION rides the SAME hidden polite region (announced once, on change),
    // so a screen reader hears "Jury questions." once — never re-read every poll — and the fresh
    // vote reveals join the same announcement when both land together.
    const ann = document.getElementById("ofin-announce");
    if (ann) {
      const parts = [];
      if (stageChanged) parts.push(stageLabel + ".");
      if (_lastRevealCount >= 0 && reveals.length > _lastRevealCount) {
        reveals.slice(_lastRevealCount)
          .forEach((r) => parts.push(nameOf(r.juror) + " votes for " + nameOf(r.votedFor) + "."));
      }
      if (parts.length) ann.textContent = parts.join(" ");
    }
    _lastRevealCount = reveals.length;
    const revWrap = document.getElementById("ofin-reveals");
    document.getElementById("ofin-reveal-hd").style.display = reveals.length ? "block" : "none";
    // Reveal rows are APPEND-ONLY across the reveal stage (the engine reads votes in a fixed order),
    // so reuse the rows already mounted — keeping their decoded faces — and add only genuinely-new
    // votes. The first render of this page session syncs the already-read votes WITHOUT an entrance
    // (a reload mid-reveal must not replay every animation); later polls animate each fresh vote in
    // so the season's loudest beat lands with earned weight instead of a silent innerHTML pop.
    if (_shownRevealCount < 0 || reveals.length < _shownRevealCount) {
      // first sync this session, OR the set shrank/reset (a new season's finale) — rehydrate from
      // scratch, no entrance (nothing "landed" this frame).
      revWrap.innerHTML = "";
      for (const r of reveals) revWrap.appendChild(_buildRevealRow(r));
    } else if (reveals.length > _shownRevealCount) {
      // votes read since the last render — append + animate only those.
      for (let i = _shownRevealCount; i < reveals.length; i++) {
        const line = _buildRevealRow(reveals[i]);
        revWrap.appendChild(line);
        _animateIn(line);
      }
    }
    _shownRevealCount = reveals.length;
    // Append-only rows read _portraitById at BUILD time, but the roster cache fills async
    // (_refreshRosterCache kicked from refresh()), so a row first mounted before its portrait landed
    // would keep its monogram fallback forever — later same-length polls skip the block above. Refresh
    // any EXISTING row whose face signature changed (a portrait landed): rebuild it in place, keyed so
    // an unchanged row is never re-decoded (no churn) and with NO entrance (a portrait swap is not a
    // new-vote beat). Positional: child i corresponds to reveals[i] (the engine's fixed read order).
    Array.prototype.slice.call(revWrap.children).forEach((row, i) => {
      const r = reveals[i];
      if (!r || typeof row.getAttribute !== "function") return;
      if (row.getAttribute("data-rev-facesig") === _revFaceSig(r)) return;
      revWrap.replaceChild(_buildRevealRow(r), row);
    });

    // The player's turn (composer-prefill shortcuts; the chat agent submits the binding decision).
    const playerIsFinalist = finalists.some((f) => f && f.id === PLAYER_ID);
    const move = document.getElementById("ofin-move");
    move.innerHTML = "";
    const addBtn = (label, text) => {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "ow-btn ow-btn-secondary ofin-btn"; btn.textContent = label;
      // A11Y-10: visible label keeps the emoji/arrow; the accessible name strips leading glyphs so
      // a screen reader reads "Vote for X", not "ballot box with ballot Vote for X".
      btn.setAttribute("aria-label", label.replace(/^[^\p{L}\p{N}]+/u, "").trim() || label);
      btn.addEventListener("click", () => prefill(text));
      move.appendChild(btn);
    };
    if (playerIsFinalist && finale.stage === "statements") {
      addBtn("✍ Give your opening statement", "I give my opening statement to the jury: ");
    } else if (playerIsFinalist && finale.stage === "questions") {
      // #616: prefill the HUMAN label, not the raw kebab id (e.g. "discredit-rival") — the id is
      // machinery and must never land in the player's visible composer.
      for (const a of APPEALS) addBtn("→ " + a.label, `I answer the jury by making my "${a.label}" case.`);
    } else if (!playerIsFinalist && finale.stage === "vote") {
      for (const f of finalists) addBtn("🗳 Vote for " + nameOf(f), `I cast my jury vote for ${nameOf(f)}.`);
    }
  }

  async function refresh() {
    // Issue 2: GATE the finale poll on a STARTED game. Pre-game there is no finale to stage, and
    // hitting /finale before casting only logged `[orwell] finale failed: no active game` every
    // poll. /state is the cheap, always-available game-active read every panel shares.
    let st;
    try {
      st = await getJSON("/api/orwell/state");
      if (!st || st.started === false) { _staging = false; _failures = 0; hidePanel(); return; }
    } catch (_) {
      // /state itself failed (an engine blip): don't escalate to a finale fetch — back off and hide.
      _failures += 1;
      hidePanel();
      return;
    }
    let finale = null;
    if (_win && _win.setLoading) _win.setLoading(true); // non-blocking refresh hint over the last reveals
    try {
      const data = await getJSON("/api/orwell/finale");
      finale = data && data.finale;
      _failures = 0;
    } catch (_) {
      _failures += 1; // engine down → fail open (hide) + back the poll off (E67)
      if (window.OrwellReport) window.OrwellReport.fail("finale", "finale-poll", _); // G11: fail open, never silent
      finale = null;
    } finally {
      if (_win && _win.setLoading) _win.setLoading(false);
    }
    _staging = !!finale;
    // 0065 Phase 1 — FINALE DAY BEGINS: the instant a finale starts staging (the current season is
    // nearing its close), kick the NEXT season's char-data warm so the deep cast profiles are warming
    // in advance of when they're needed. Fire-and-forget + idempotent server-side (the endpoint just
    // ARMS a background poll that lands once the player confirms the next season). Once per finale.
    if (_staging && !_nextSeasonWarmed) {
      _nextSeasonWarmed = true;
      _warmNextSeason();
    }
    if (!finale) { hidePanel(); return; }
    // GADGET-15: resolve names against the SAME /state roster already fetched above (public
    // NamedRef-shaped facts — no extra call, no Vault data).
    _nameById = nameMapFrom(st);
    // M3-4: fire-and-forget the portrait cache refresh — render() uses whatever is already
    // cached (fills in on the NEXT poll if this is the very first finale render this session),
    // so a slow/failed roster read never delays the finale panel.
    _refreshRosterCache();
    render(finale);
  }

  // 0065 Phase 1: fire the finale-day next-season char-data warm. Best-effort, fail-open; the server
  // endpoint is idempotent (a re-fire is a no-op while the poll is armed). Images are a SEPARATE warm
  // fired at the next-season confirm (orwellNewSeason.js), gated off this one finishing.
  function _warmNextSeason() {
    try {
      fetch("/api/orwell/prewarm-next-season", { method: "POST", credentials: "same-origin" }).catch(() => {});
    } catch (_) {}
  }

  // WS Phase-1 (§4): when the multiplexed socket is live the server PUSHES a `state`
  // frame on every board change; platform.js relays it to the one `orwell:gamechanged`
  // dispatcher, which triggers refresh() below. So we cancel the periodic poll TIMER in
  // WS mode and stay edge-triggered (fail-soft: any doubt ⇒ keep polling). The fallback/
  // SSE path is unchanged and still polls — INCLUDING the latency-sensitive 5s staging
  // cadence, which is only ever suspended when WS is genuinely active.
  function _wsActive() {
    try { return !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive()); }
    catch (_) { return false; }
  }

  function start() {
    refresh();
    if (timer) clearTimeout(timer);
    const tick = async () => {
      if (!document.hidden) await refresh(); // E67/C18: a hidden tab polls nothing
      // In WS mode the `state` push (via orwell:gamechanged) supersedes the poll —
      // don't re-arm the periodic timer, just stay edge-triggered.
      if (!_wsActive()) timer = setTimeout(tick, _pollDelay());
    };
    if (!_wsActive()) timer = setTimeout(tick, _pollDelay());
  }

  // Seam for the headless gate (F3 and the finale's own F-2 wave): build + show on demand.
  window._orwellFinaleEnsure = () => {
    const el = ensureUI();
    // #573: docked → inline `flex` beats the finale's own `#orwell-finale{display:none}` ID
    // rule (a plain "" would fall through to it and leave the docked finale invisible).
    if (_win && _win.isDocked && _win.isDocked()) el.style.display = "flex";
    else if (!isMinimized()) el.style.display = "block";
    // #780: re-anchor once visible (see render()) so the headless/explicit show lands on
    // the slot base rather than the clipped CSS-default 0,0.
    if (el.style.display && el.style.display !== "none") {
      try { window.OrwellSlots && window.OrwellSlots.restackAll && window.OrwellSlots.restackAll(); } catch (_) {}
    }
    return true;
  };
  window.orwellRefreshFinale = refresh;
  window.addEventListener("orwell:gamechanged", refresh);
  // WS Phase-1 (§4/§6): cancel the periodic poll the instant the socket goes live; resume
  // polling (including the brisk 5s staging cadence) if it falls back to SSE. start() re-arms
  // the timer only while !_wsActive(), so re-running it after a downgrade restores the cadence.
  window.addEventListener("orwell:ws-active", () => { if (timer) { clearTimeout(timer); timer = null; } });
  window.addEventListener("orwell:ws-inactive", () => { _failures = 0; if (timer) { clearTimeout(timer); timer = null; } start(); });
  ready(start);
})();
