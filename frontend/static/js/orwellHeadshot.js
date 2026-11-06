// Orwell headshot studio (features G26/G27/G28) — the player's OWN portrait + account avatar.
//
// Make your houseguest's portrait (and your account profile pic) from a photo of yourself:
//   • exact  — your photo, cropped to your face, used as-is (no AI);
//   • studio — AI recreates you in the house style; you GENERATE 3 OPTIONS AT A TIME and pick
//              one, regenerate for a fresh set (indefinitely), or upload a different photo.
// Finalizing sets it as your houseguest portrait AND your account avatar (the circle updates at
// once, via `orwell:avatarchanged`).
//
// The STUDIO (`window.OrwellHeadshotStudio.mount(bodyEl)`) is reusable — the pre-game casting
// card mounts it (game-build, state.started===false), and Settings → Account mounts the same
// thing (G28). Vault-safe: only the player's own image, never game state. Fail-open.
(function () {
  "use strict";

  const ID = "orwell-headshot";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  async function jget(url) {
    try { const r = await fetch(url, { credentials: "same-origin" }); return r.ok ? r.json() : null; }
    catch (_) { return null; }
  }

  function ensureCss() {
    if (document.getElementById("orwell-headshot-css")) return;
    const s = document.createElement("style");
    s.id = "orwell-headshot-css";
    s.textContent = `
      /* P1 OOBE overhaul: the pre-game casting headshot is a PROPER OrwellWindow (composes the
         .ow-* kit). No close/minimize chrome — its two EXITS are in the body (finalize a photo or
         "Skip for now").
         Placement: it is a FOCUSED onboarding dialog, so it rides the "top-center" slot — the slot
         engine centers it horizontally under the header AND owns its drag offset, so it is
         draggable-but-not-resizeable WITHOUT a per-window !important position pin (the old hack
         hard-pinned left/top/transform with !important, which beat the drag's inline writes and
         made the titlebar a dead grip — a movable-looking but static window). Width/z-index here
         carry NO position props (left/top/transform), so the slot's inline geometry and the drag
         both apply unobstructed. */
      #${ID} {
        width: 480px; max-width: min(92vw, 480px);
        z-index: 1000;  /* above the slotted HUD, below true modals */
      }
      /* R1 (audit resp-F1): on the narrow sheet tier the slot host pins left:0/right:0 to make a
         full-width sheet; the desktop fixed width + max-width fought that and left a one-sided ~26-31px
         right gutter. Drop them <=768px so the sheet goes flush edge-to-edge. */
      @media (max-width: 768px) {
        #${ID} { width: auto; max-width: none; }
      }
      /* R4 (audit resp-F2): dvh tracks the keyboard-shrunk mobile viewport so the lowest exit
         ("Skip for now") stays above the fold; vh first as the fallback for engines without dvh. */
      #${ID} > .ow-body { max-height: min(62vh, calc(100vh - var(--ow-headshot-top-clear, 120px)));
        max-height: min(62dvh, calc(100dvh - var(--ow-headshot-top-clear, 120px))); }
      /* the ONE instruction lives in the window body — no duplicate banner/placeholder copy */
      #${ID} .hs-lead { margin: 0 0 10px; font-size: 12.5px; line-height: 1.5;
        color: color-mix(in srgb, var(--fg, #cfd8e3) 88%, transparent); }
      #${ID} .hs-lead b { font-weight: 700; }
      /* the studio body — shared by the casting window AND Settings (scoped to the class) */
      .ow-headshot-studio { font-size: 13px; }
      .ow-headshot-studio .hs-msg { opacity: .75; font-size: 12px; }
      .ow-headshot-studio .hs-actions { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
      /* #1638 total kit migration (OWN-3): the studio's action buttons ARE the kit — .ow-btn +
         the right variant (prominent / secondary / plain / destructive), NO legacy .hs-btn pill
         remains. The kit is the ONE source of truth for button chrome on ALL three tiers: glass
         fills + capsule + 44px floor + dark ink under frosted/glass, and a solid token-driven
         expression on the flat tier (the KIT-N-01..10 rules in style.css). The old .hs-btn /
         .hs-btn-ghost fallback rules are therefore deleted as dead CSS; the file-picker keeps
         .hs-filebtn ONLY for its 44px tap-target pin (below). */
      /* OWN-5 (2026-07-14 theme audit) + INT-6 (a11y): disabled actions use the app's
         established OPAQUE disabled treatment — the VM-17 pattern (style.css ~21453): a FIXED
         muted fill (#d6d6d9) + a FIXED darker ink (#57575c, measured 4.95:1) + cursor
         not-allowed at FULL opacity. Fixed colors, never transparent/opacity composites: the
         old transparent-fill + 55%-alpha-ink treatment read as ambiguous grey-on-grey (the
         OWN-5 sighting), and opacity-dimming collapses contrast over glass (the measured VM-17
         failure). Inside kit windows under frosted the shared style.css VM-17 rule already
         paints these exact values; this rule makes the SAME state hold on flat, in the Settings
         modal, and any non-window mount. The .ow-headshot-studio .ow-btn[disabled] selector
         (0,3,0) out-specifies the kit's 0.42-opacity .ow-btn:disabled rule (0,2,0) on every
         tier (KIT-OV-2: the opaque treatment is the measured, HIG-correct one) and restores
         pointer-events so the not-allowed cursor actually shows. NOTE: no backticks in this
         comment block — it lives inside this file's own template-literal CSS string, and a
         literal backtick here would terminate it early. */
      .ow-headshot-studio .ow-btn[disabled] {
        opacity: 1; cursor: not-allowed; pointer-events: auto;
        background: #d6d6d9;
        color: #57575c;
        border-color: transparent;
        box-shadow: none; transform: none;
      }
      /* INT-5 (a11y fix, WCAG 3.3.2): the disabled-hint line explaining WHY the two action
         buttons are inert — orwellDecision.js's disabledHintFor() already solved this exact
         problem for decision cards; this reuses the same quiet-caption + aria-describedby pattern. */
      .ow-headshot-studio .hs-hint { opacity: .75; font-size: 11.5px; font-style: italic; flex-basis: 100%; margin-top: 2px; }
      .ow-headshot-studio .hs-hint[hidden] { display: none; }
      .ow-headshot-studio .hs-preview { width: 92px; height: 92px; border-radius: 8px; flex: none;
        border: 1px solid var(--border, #355a66);
        /* 0114: was a hardcoded #0d0f14 — a foreign-polarity dark tile that stayed a near-black
           box on the light theme regardless of the active theme's --panel. Token-driven, same
           fallback the sibling .hs-cand.hs-loading/.hs-broken rules already use below. */
        background: var(--panel, #11151c) center/cover no-repeat;
        display: flex; align-items: center; justify-content: center; font-size: 28px; opacity: .85; }
      .ow-headshot-studio .hs-row { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
      .ow-headshot-studio .hs-opts { flex: 1; min-width: 220px; display: flex; flex-direction: column; gap: 8px; }
      /* The file control is a themed BUTTON (a <label for>) over a visually-hidden native
         input — the bare OS "Choose File / No file chosen" text otherwise clipped to
         "No fil…chosen" on mobile (UX audit J1-08). The input keeps its id/handler/accept/
         aria and stays operable; selection state shows in the preview thumbnail. */
      .ow-headshot-studio .hs-file-native { position: absolute; width: 1px; height: 1px;
        overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
      /* F3: the file-picker is a <label> (not a <button>), so the coarse-pointer tap floor in
         responsive-tokens.css never reaches it — pin the 44px HIG tap target here (WCAG 2.5.5). */
      .ow-headshot-studio .hs-filebtn { display: inline-flex; align-items: center; align-self: flex-start;
        min-height: var(--tap-min); box-sizing: border-box; }
      /* SR-only live region for portrait status ("Generating…", "Upload failed", offline) — J1-27. */
      .ow-headshot-studio .hs-live { position: absolute; width: 1px; height: 1px; overflow: hidden;
        clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
      .ow-headshot-studio .hs-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 6px 0 2px; }
      /* Portrait tiles are real <button>s (keyboard/SR operable — UX audit J1-26); reset native chrome. */
      .ow-headshot-studio .hs-cand { position: relative; aspect-ratio: 1; border-radius: 8px; overflow: hidden; cursor: pointer;
        border: 2px solid transparent;
        /* OWN-4 (2026-07-14 theme audit): height:auto is LOAD-BEARING. The tiles are <button>s,
           and the app-wide reset (style.css ~1892: button height 32px; + the coarse-pointer
           44px floor) puts an EXPLICIT height on them — and aspect-ratio only applies when a
           dimension is auto, so the declared square collapsed into ~4.5:1 letterbox strips
           (measured 144.5x32 at 1440, 116x44 at 390: faces cropped to forehead/eye bands).
           height:auto re-arms the aspect-ratio; width comes from the grid track. */
        height: auto;
        /* 0114: token-driven idle tile (was a hardcoded #0d0f14 — see .hs-preview above). */
        background: var(--panel, #11151c) center/cover no-repeat;
        padding: 0; margin: 0; font: inherit; width: 100%; -webkit-appearance: none; appearance: none; }
      /* OWN-5 (2026-07-14 theme audit): the SELECTED tile must be unmistakable. The old
         accent border-color was silently CLOBBERED under frosted by the generic
         .ow-window .ow-body button rule (border + box-shadow at (0,3,2) specificity), so no
         visible selection affordance survived — measured: the .sel border computed to the same
         18%-fg hairline as an unselected tile. Use the kit's system-blue ring pattern instead
         (--ow-ios-blue, 3px — the fixed accessibility blue, same family as the kit focus ring
         and the selected-pill fix): OUTLINE is untouched by the generic rule on every tier,
         and the border-color doubles it where it survives (flat). Declared BEFORE the
         :focus-visible rule below so keyboard focus stays visually distinct. */
      .ow-headshot-studio .hs-cand.sel {
        border-color: var(--ow-ios-blue, #0a84ff);
        outline: 3px solid var(--ow-ios-blue, #0a84ff);
        outline-offset: 1px;
      }
      .ow-headshot-studio .hs-cand img { width: 100%; height: 100%; object-fit: cover; display: block; }
      /* J3-15: a token-driven skeleton so an in-flight or broken thumbnail reads as "loading",
         not a broken-image glyph. The shimmer plays while the tile carries .hs-loading (set until
         the <img> fires load); a hard error swaps to .hs-broken (static placeholder, no shimmer).
         Tokens (--panel / --border) keep it on-theme; reduced-motion freezes the sweep. */
      .ow-headshot-studio .hs-cand.hs-loading,
      .ow-headshot-studio .hs-libitem.hs-loading {
        background: linear-gradient(100deg,
          color-mix(in srgb, var(--panel, #11151c) 88%, transparent) 30%,
          color-mix(in srgb, var(--border, #355a66) 60%, var(--panel, #11151c)) 50%,
          color-mix(in srgb, var(--panel, #11151c) 88%, transparent) 70%);
        background-size: 200% 100%; animation: hsSkeleton 1.1s ease-in-out infinite;
      }
      .ow-headshot-studio .hs-cand.hs-loading img,
      .ow-headshot-studio .hs-libitem.hs-loading img { opacity: 0; }
      .ow-headshot-studio .hs-cand.hs-broken,
      .ow-headshot-studio .hs-libitem.hs-broken {
        background: color-mix(in srgb, var(--panel, #11151c) 92%, var(--border, #355a66)); }
      @keyframes hsSkeleton { from { background-position: 200% 0; } to { background-position: -200% 0; } }
      @media (prefers-reduced-motion: reduce) {
        .ow-headshot-studio .hs-cand.hs-loading,
        .ow-headshot-studio .hs-libitem.hs-loading { animation: none;
          background: color-mix(in srgb, var(--panel, #11151c) 88%, var(--border, #355a66)); } }
      /* #1638: focus is the fixed kit system-blue (was a --brand-color drift) — the same accessibility
         blue .hs-cand.sel and the .ow-portrait-tile focus ring use. */
      .ow-headshot-studio .hs-cand:focus-visible, .ow-headshot-studio .hs-libpick:focus-visible {
        outline: 2px solid var(--ow-ios-blue, #0a84ff); outline-offset: 2px; }
      .ow-headshot-studio .hs-lib { margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border, #355a66); }
      .ow-headshot-studio .hs-libstrip { display: flex; gap: 8px; flex-wrap: wrap; }
      .ow-headshot-studio .hs-libitem { position: relative; width: 56px; height: 56px; border-radius: 8px; overflow: hidden;
        border: 2px solid transparent;
        /* 0114: token-driven idle tile (was a hardcoded #0d0f14 — see .hs-preview above). */
        background: var(--panel, #11151c) center/cover no-repeat; flex: none; }
      .ow-headshot-studio .hs-libitem.cur { border-color: var(--ow-ios-blue, #0a84ff); }
      .ow-headshot-studio .hs-libpick { position: absolute; inset: 0; padding: 0; margin: 0; border: none;
        background: none; cursor: pointer; -webkit-appearance: none; appearance: none; }
      .ow-headshot-studio .hs-libitem img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .ow-headshot-studio .hs-libdel { position: absolute; top: 1px; right: 1px; width: 20px; height: 20px; line-height: 18px;
        border-radius: 50%; border: none; cursor: pointer; font-size: 13px; padding: 0; z-index: 1;
        display: inline-flex; align-items: center; justify-content: center;
        /* #1644 (rendered audit §2): white × over a LIGHT portrait thumbnail through the old .6
           scrim composited to ~2.55:1 (white-on-grey). Deepen the scrim + add a dark glyph halo so
           the × clears AA over ANY thumbnail (light face or dark). */
        background: rgba(0,0,0,.78); color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.9);
        opacity: 0; transition: opacity .12s; }
      /* keyboard/touch users have no hover — reveal the delete on focus-within too. */
      .ow-headshot-studio .hs-libitem:hover .hs-libdel,
      .ow-headshot-studio .hs-libitem:focus-within .hs-libdel { opacity: 1; }
      /* J2-06: on a coarse/touch pointer the overlay can't rely on hover and the small glyph
         falls below the project tap-target floor — give it a 44x44 hit area (kept visible on
         touch since there's no hover to reveal it) without bloating the compact desktop UI. */
      @media (hover: none) and (pointer: coarse) {
        .ow-headshot-studio .hs-libdel { width: 44px; height: 44px; line-height: 42px;
          font-size: 18px; opacity: 1; background: rgba(0,0,0,.82); }
      }
      @media (prefers-reduced-motion: reduce) { .ow-headshot-studio .hs-libdel { transition: none; } }
      /* "Choose Your Character" pill — a competition-style CTA. #913: it is now PINNED above the
         composer (the OrwellNotice "guide" zone, like the decision card), not appended inline into
         the chat history where it scrolled away and orphaned. Clicking it opens the cast-photo box
         (which no longer auto-opens). Matches the decision-card accent pill (rounded, --accent,
         ≥44px tap target). When mounted via the kit, #orwell-choose-character is the .on-card host:
         center the button inside the kit body. The legacy in-stream fallback wrapper carries the
         same id, so center its direct button too. */
      #orwell-choose-character > .hs-choose-btn { margin: 4px auto; display: block; }
      #orwell-choose-character .on-body { display: flex; justify-content: center; }
      #orwell-choose-character .on-body > .hs-choose-btn { margin: 0; }
      /* #775 element-kit migration (owner request): the "Choose Your Character" pill composes the
         kit's .ow-btn .ow-btn-prominent — a liquid-glass PROMINENT CTA (the kit is the ONE source of
         truth for the glass chrome). This bespoke rule keeps ONLY the pill-specific SHAPE (the wide
         capsule radius + the slightly larger/heavier label that makes it read as a competition CTA)
         + the Normal-tier (non-glass) fallback chrome. UN-PREFIXED, so the kit's
         body.theme-frosted .ow-btn-prominent rule wins the chrome on the glass tiers. */
      .hs-choose-btn {
        font: inherit; font-size: 14px; font-weight: 700; letter-spacing: .02em;
        padding: 10px 22px; border-radius: 999px; cursor: pointer; min-height: 44px;
        /* Normal-tier fallback (the kit, frosted-only, supplies the glass look): */
        background: var(--brand-color, var(--accent, #e06c75)); color: var(--on-accent, var(--bg, #111));
        border: 1px solid transparent; box-shadow: 0 2px 10px rgba(0,0,0,.25);
        transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
      }
      .hs-choose-btn:active { transform: translateY(1px); }
      @media (prefers-reduced-motion: reduce) { .hs-choose-btn { transition: none; } }
      /* #725: the studio also embeds in GLASS hosts (Settings modal, the New-Season window),
         where its var(--border) strokes become HARD dark lines on the light glass. Apple glass is
         lensing, not a hard stroke — soften them to the low-opacity WHITE hairline ONLY in a glass
         context. The OPAQUE casting window (#orwell-headshot — a solid LIGHT plate, painted by
         style.css's F-S2-A/OWN-3 rule) is EXCLUDED: on an opaque light surface a dark hairline is
         the correct stroke (the same reasoning as the #orwell-retro terminal window). */
      body.theme-frosted .ow-window:not(#orwell-headshot) .ow-headshot-studio .hs-preview,
      body.theme-frosted .ow-window:not(#orwell-headshot) .ow-headshot-studio .hs-lib,
      body.theme-frosted .modal-content .ow-headshot-studio .hs-preview,
      body.theme-frosted .modal-content .ow-headshot-studio .hs-lib {
        border-color: rgba(255,255,255,0.14);
      }
      /* ── OWN-3 (2026-07-14 theme audit, #1638) — the casting dialog's light polarity ──
         The opaque near-white PLATE + dark chrome ink now live at the ROOT in style.css
         (the F-S2-A rule near ~19610, mirroring #orwell-retro), NOT here: this file no longer
         injects an !important counter-fight against a style.css dark-slab rule (that pattern is
         deleted — style.css paints the window LIGHT directly, and the kit's blanket dark-ink
         rules then apply with no id-scoped ink exception needed). See style.css §F-S2-A. */`;
    document.head.appendChild(s);
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ── the reusable studio: mount the state machine into any container ─────────
  // opts.onSummary(text) — optional, for a host that shows a status chip (the casting card).
  function buildStudio(body, opts) {
    ensureCss();
    opts = opts || {};
    body.classList.add("ow-headshot-studio");

    const st = { file: null, fileUrl: null, candidates: [], selected: null, busy: false, library: [] };
    let _msg = "";
    let status = { present: false, finalized: false, mode: null };
    // J1-27: a singleton SR live region on <body> (survives render()'s innerHTML rebuilds) so
    // portrait status — "Generating 3 studio options…", "Upload failed", "photo service offline" —
    // is announced to screen readers, not just shown visually in the rebuilt .hs-msg nodes.
    let _live = document.getElementById("hs-live-region");
    if (!_live) {
      _live = document.createElement("div");
      _live.id = "hs-live-region";
      _live.setAttribute("role", "status");
      _live.setAttribute("aria-live", "polite");
      _live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;";
      document.body.appendChild(_live);
    }
    const msg = (m) => { _msg = m || ""; try { _live.textContent = m || ""; } catch (_) {} };
    const setBusy = (b) => { st.busy = b; render(); };
    const summary = (t) => { try { opts.onSummary && opts.onSummary(t); } catch (_) {} };
    // L3: the host card must stay open while options/results are showing — generated
    // photos should never collapse out of view. The host passes this; Settings doesn't.
    const ensureOpen = () => { try { opts.ensureOpen && opts.ensureOpen(); } catch (_) {} };
    // L4: on the pre-game casting card, picking a headshot DISMISSES the picker and hands
    // off into the game (the host unmounts the card + opens the producers' first turn).
    // Returns true when the host took over, so we skip painting the "finalized" state that
    // would keep covering the logo. Settings → Account passes nothing and stays in place.
    const handoff = () => { try { return !!(opts.onFinalized && opts.onFinalized()); } catch (_) { return false; } };
    // OOBE re-sequence (2026-06-20): on the pre-game casting box ONLY, the photo is OPTIONAL — the
    // host wires onSkip to record {status:"skipped"} + resume the interview. Settings → Account
    // passes nothing, so no skip affordance renders there (the avatar is a real, kept choice there).
    const canSkip = typeof opts.onSkip === "function";
    const skip = () => { try { opts.onSkip && opts.onSkip(); } catch (_) {} };
    function avatarChanged() { try { window.dispatchEvent(new CustomEvent("orwell:avatarchanged")); } catch (_) {} }

    async function upload(mode) {
      if (!st.file) return false;
      setBusy(true);
      try {
        const fd = new FormData(); fd.append("file", st.file); fd.append("mode", mode);
        const r = await fetch("/api/orwell/portrait/intake", { method: "POST", credentials: "same-origin", body: fd });
        const d = r.ok ? await r.json() : null;
        st.busy = false;
        if (!d || !d.ok) { msg(d && d.error ? d.error : "That image couldn't be used — try another."); render(); return false; }
        return true;
      } catch (e) {
        if (window.OrwellReport) window.OrwellReport.fail("headshot", "upload", e);
        st.busy = false; msg("Upload failed — the photo service is offline."); render(); return false;
      }
    }

    async function useExact() {
      const ok = await upload("exact");
      if (ok) { avatarChanged(); st.candidates = []; st.selected = null; await refreshStatus(); }
    }

    async function studioGenerate() {
      if (st.file) { const ok = await upload("reference"); if (!ok) return; st.file = null; }
      setBusy(true); msg("Generating 3 studio options…");
      try {
        const r = await fetch("/api/orwell/portrait/studio/generate", { method: "POST", credentials: "same-origin" });
        const d = r.ok ? await r.json() : null;
        st.busy = false;
        if (d && d.generated > 0) { st.candidates = d.candidates; st.selected = null; msg("Pick your favorite — or generate 3 more."); ensureOpen(); }
        else { msg((d && d.reason) || "Couldn't generate options — the photo service may be offline (check Settings)."); }
      } catch (e) {
        if (window.OrwellReport) window.OrwellReport.fail("headshot", "studio", e);
        st.busy = false; msg("The photo service is offline right now.");
      }
      render();
    }

    async function finalizeSelected() {
      if (st.selected === null || st.selected === undefined) return;
      setBusy(true);
      try {
        const r = await fetch("/api/orwell/portrait/studio/finalize", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ index: st.selected }) });
        const d = r.ok ? await r.json() : null;
        st.busy = false;
        if (d && d.ok) {
          avatarChanged(); st.candidates = []; st.selected = null;
          if (handoff()) return; // L4: picker dismissed, game taking over — don't repaint
          await refreshStatus();
        } else { msg("Couldn't set that option — try again."); render(); }
      } catch (e) { st.busy = false; msg("The photo service is offline right now."); render(); }
    }

    async function removeAll() {
      try { await fetch("/api/orwell/portrait/intake", { method: "DELETE", credentials: "same-origin" }); } catch (_) {}
      st.file = null; st.fileUrl = null; st.candidates = []; st.selected = null;
      avatarChanged(); msg("Removed."); await refreshStatus();
    }

    async function refreshStatus() {
      status = (await jget("/api/orwell/portrait/intake")) || status;
      const lib = await jget("/api/orwell/portrait/library");
      st.library = (lib && lib.headshots) || [];
      // G32: a generated-but-unpicked photoset must survive a refresh/new session. The
      // candidate images persist server-side (intake reports the count) — rebuild the picker
      // from that count so the options reappear, instead of dropping to the upload chooser.
      if (!status.finalized && (status.candidates || 0) > 0 && !st.candidates.length) {
        st.candidates = Array.from({ length: status.candidates },
          (_, i) => ({ index: i, ref: "/api/orwell/portrait/studio/candidate/" + i }));
        ensureOpen(); // L3: restored options reappear expanded, never tucked away
      }
      render();
    }

    // G30: pick a cached headshot — it becomes the current avatar + season portrait.
    async function selectFromLibrary(id) {
      setBusy(true);
      try {
        const r = await fetch("/api/orwell/portrait/library/select", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        st.busy = false;
        if (r.ok) {
          avatarChanged(); status.finalized = true;
          if (handoff()) return; // L4: picking a cached headshot hands off into the game too
          await refreshStatus();
        } else { msg("Couldn't use that one — try again."); render(); }
      } catch (e) { st.busy = false; msg("The photo service is offline right now."); render(); }
    }
    async function deleteFromLibrary(id) {
      try { await fetch("/api/orwell/portrait/library/" + encodeURIComponent(id), { method: "DELETE", credentials: "same-origin" }); } catch (_) {}
      await refreshStatus();
    }

    // The cached-headshots strip — shown above every state so a past portrait is always one tap away.
    function libraryHtml() {
      if (!st.library.length) return "";
      return `<div class="hs-lib"><div class="hs-msg" style="margin-bottom:6px">Your headshots — tap one to use it</div>
        <div class="hs-libstrip">${st.library.map((h) =>
          `<div class="hs-libitem hs-loading is-loading ow-portrait${h.current ? " cur" : ""}">
             <button type="button" class="hs-libpick" data-pick="${esc(h.id)}" aria-pressed="${h.current ? "true" : "false"}" aria-label="${h.current ? "Current headshot" : "Use this saved headshot"}"><img src="${esc(h.ref)}" alt=""></button><button type="button" class="hs-libdel" data-del="${esc(h.id)}" title="Remove" aria-label="Remove headshot">×</button></div>`).join("")}</div></div>`;
    }
    // J3-15: drive each thumbnail's skeleton/broken state off its <img>'s real load result, so a
    // slow or failed portrait reads as "loading"/placeholder instead of a broken-image glyph. The
    // tile (.hs-cand / .hs-libitem) mounts with .hs-loading; load clears it, error swaps .hs-broken.
    function wireThumbStates(root) {
      (root || document).querySelectorAll(".hs-cand.hs-loading img, .hs-libitem.hs-loading img").forEach((img) => {
        const tile = img.closest(".hs-cand, .hs-libitem");
        if (!tile) return;
        // #1638: toggle BOTH the legacy hs-* classes AND the shared kit .is-loading/.is-broken so the
        // .ow-portrait state chrome activates alongside the (test-pinned) J3-15 skeleton.
        const done = () => { tile.classList.remove("hs-loading", "is-loading"); };
        const failed = () => { tile.classList.remove("hs-loading", "is-loading"); tile.classList.add("hs-broken", "is-broken"); };
        // An already-decoded image never fires load/error again — including a CACHED FAILURE
        // (complete but naturalWidth===0), which must resolve to broken, not stay is-loading.
        if (img.complete) { (img.naturalWidth > 0 ? done : failed)(); return; }
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", failed, { once: true });
      });
    }
    function wireLibrary() {
      wireThumbStates(body); // J3-15: skeleton/broken state for the saved-headshots strip too
      body.querySelectorAll("[data-pick]").forEach((d) => d.addEventListener("click", (e) => {
        if (e.target && e.target.closest("[data-del]")) return; // the × handles itself
        selectFromLibrary(d.dataset.pick);
      }));
      body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation(); deleteFromLibrary(b.dataset.del);
      }));
    }

    function render() {
      summary(status.finalized ? "set ✓" : (st.candidates.length ? "pick an option" : "make your portrait"));
      if (st.busy) { body.innerHTML = `<div class="hs-msg">${esc(_msg || "Working…")}</div>`; return; }
      const lib = libraryHtml();

      if (status.finalized) {
        // Auto-hand-off: if the gate ever renders an ALREADY-finalized headshot — set on this
        // device, set on another device/tab, or already set on a reload — dismiss the picker and
        // open the game, instead of leaving the "set" card stuck open over the chat. (A fresh set
        // via finalizeSelected/selectFromLibrary already hands off; this also covers the
        // mount/refresh-with-already-set path, which is what left it stuck.) In Settings → Account
        // no onFinalized is wired, so handoff() is a no-op and the set card stays put to manage it.
        if (handoff()) return;
        body.innerHTML = lib + `
          <div class="hs-row">
            <div class="hs-preview ow-portrait" style="background-image:url('/api/orwell/avatar?t=${Date.now()}')"></div>
            <div class="hs-opts"><div>Your headshot is set — it's your houseguest portrait and your profile pic.</div>
              <div class="hs-actions">
                <button type="button" class="ow-btn ow-btn-secondary" id="hs-redo">Make another</button>
                <button type="button" class="ow-btn ow-btn-destructive" id="hs-remove">Remove</button>
                <span class="hs-msg">${esc(_msg)}</span>
              </div></div></div>`;
        body.querySelector("#hs-redo").addEventListener("click", () => { status.finalized = false; render(); });
        body.querySelector("#hs-remove").addEventListener("click", removeAll);
        wireLibrary();
        return;
      }

      if (st.candidates.length) {
        body.innerHTML = lib + `
          <div>${esc(_msg || "Pick your favorite — or generate 3 more.")}</div>
          <div class="hs-grid">${st.candidates.map((c, _n) =>
            `<button type="button" class="hs-cand hs-loading is-loading ow-portrait ow-portrait-tile${st.selected === c.index ? " sel is-selected" : ""}" data-i="${c.index}" aria-pressed="${st.selected === c.index ? "true" : "false"}" aria-label="Portrait option ${_n + 1}"><img src="${esc(c.ref)}" alt=""></button>`).join("")}</div>
          <div class="hs-actions">
            <button type="button" class="ow-btn ow-btn-prominent" id="hs-use" ${st.selected === null ? "disabled" : ""}>Use this one</button>
            <button type="button" class="ow-btn ow-btn-secondary" id="hs-more">Generate 3 more</button>
            <button type="button" class="ow-btn ow-btn-secondary" id="hs-new">Upload a different photo</button>
          </div>`;
        wireThumbStates(body);
        body.querySelectorAll(".hs-cand").forEach((d) => d.addEventListener("click", () => { st.selected = parseInt(d.dataset.i, 10); render(); }));
        body.querySelector("#hs-use").addEventListener("click", finalizeSelected);
        body.querySelector("#hs-more").addEventListener("click", studioGenerate);
        body.querySelector("#hs-new").addEventListener("click", () => { st.candidates = []; st.selected = null; st.file = null; render(); });
        wireLibrary();
        return;
      }

      const previewBg = st.fileUrl ? `style="background-image:url('${st.fileUrl}')"` : "";
      body.innerHTML = lib + `
        <div class="hs-msg" style="margin-bottom:8px">${st.library.length ? "…or make a new one from a photo of yourself." : "Make your houseguest's portrait — and your profile pic — from a photo of yourself."}</div>
        <div class="hs-row">
          <div class="hs-preview ow-portrait" ${previewBg}>${st.fileUrl ? "" : "👤"}</div>
          <div class="hs-opts">
            <label class="hs-filebtn ow-btn ow-btn-secondary" for="hs-file">${st.file ? "Choose a different photo" : "Choose a photo of yourself"}</label>
            <input type="file" id="hs-file" class="hs-file-native" accept="image/*" aria-label="Choose a photo of yourself">
            <div class="hs-actions">
              <button type="button" class="ow-btn ow-btn-prominent" id="hs-studio" ${st.file ? "" : "disabled"} aria-describedby="hs-hint">Make AI studio portraits</button>
              <button type="button" class="ow-btn ow-btn-secondary" id="hs-exact" ${st.file ? "" : "disabled"} aria-describedby="hs-hint">Use photo as-is</button>
              ${canSkip ? `<button type="button" class="ow-btn ow-btn-plain" id="hs-skip">Skip for now</button>` : ""}
              <div class="hs-hint" id="hs-hint" ${st.file ? "hidden" : ""}>Choose a photo above to enable these.</div>
            </div>
            <div class="hs-msg" id="hs-msg2">${esc(_msg)}</div>
          </div></div>`;
      const fi = body.querySelector("#hs-file");
      fi.addEventListener("change", () => {
        st.file = fi.files && fi.files[0];
        if (st.fileUrl) { try { URL.revokeObjectURL(st.fileUrl); } catch (_) {} }
        st.fileUrl = st.file ? URL.createObjectURL(st.file) : null;
        render();
      });
      body.querySelector("#hs-studio").addEventListener("click", studioGenerate);
      body.querySelector("#hs-exact").addEventListener("click", useExact);
      // OOBE re-sequence: the optional "Skip for now" — only on the pre-game casting box (onSkip set).
      const skipBtn = body.querySelector("#hs-skip");
      if (skipBtn) skipBtn.addEventListener("click", skip);
      wireLibrary();
    }

    refreshStatus();
    return { refresh: refreshStatus };
  }

  // expose the reusable studio for Settings → Account (G28)
  window.OrwellHeadshotStudio = { mount: buildStudio };

  // ── the pre-game casting WINDOW (composes the .ow-* kit) ─────────────────────
  // OOBE re-sequence (2026-06-20): the cast-photo box is a PROPER OrwellWindow that pops up
  // MID-interview, right after the producers ask about the photo (route() gates on
  // state.casting.missing including "castPhoto" + a rendered producer turn). It is OPTIONAL:
  // the player uploads/generates a photo OR clicks "Skip for now"; either way it records the
  // step, the box disappears, and the interview resumes. The chat is NOT locked behind it
  // (orwellChatGate.js no longer hard-locks for the photo). The window keeps no close/minimize
  // chrome (the in-body "Skip for now" + finalize are the two exits) and stays centered.
  const CAST_ICON =
    "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' " +
    "stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
    "<path d='M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z'/>" +
    "<circle cx='12' cy='13' r='3.5'/></svg>";

  let _win = null; // the kit window instance (one at a time)

  function buildBody() {
    const body = document.createElement("div");
    // The ONE clear instruction — consolidated here, in the window. OOBE re-sequence: the photo
    // is OPTIONAL and the producers just asked about it, so the copy frames it as a quick,
    // skippable step rather than a hard prerequisite. OWN-6 (2026-07-14 theme audit): the body
    // copy no longer re-opens with "Your cast photo." — the titlebar already says exactly that
    // ("Your Cast Photo"); keep only the informative remainder.
    const lead = document.createElement("p");
    lead.className = "hs-lead";
    lead.innerHTML =
      "Upload a photo of yourself or generate one with AI — or skip for now and add one " +
      "later. Either way the interview picks right back up.";
    const studioHost = document.createElement("div");
    body.appendChild(lead);
    body.appendChild(studioHost);
    return { body, studioHost };
  }

  function mount() {
    if (_win || document.getElementById(ID)) return;
    if (!window.OrwellWindowKit || !window.OrwellWindowKit.create) return; // kit not ready → fail open
    ensureCss();
    const { body, studioHost } = buildBody();
    // L1: while the casting window is mounted, drop the welcome-screen's 30vh composer
    // lift so the composer docks normally (never hangs mid-screen) and the splash tips
    // are suppressed underneath. The flag is scoped to the game build in game-trim.css.
    try { document.body.classList.add("ow-casting-headshot-open"); } catch (_) {}
    // R7 (audit anim-F4): the box now owns the splash suppression — drop the welcome→box HANDOFF
    // bridge class (set by orwellOnboarding on welcome-dismiss to keep the splash hidden through the
    // gap). Continuity holds: ow-onboarding-bridge out, ow-casting-headshot-open in, no flash.
    try { document.body.classList.remove("ow-onboarding-bridge"); } catch (_) {}
    // Compose the kit. No close/minimize chrome — the two EXITS are in the body (finalize a photo
    // or "Skip for now"), so there is no half-open dead state. It rides the "top-center" slot so it
    // is a horizontally-centered dialog the player can DRAG out of the way (the grip is live), but
    // it is NOT resizeable (a fixed-size onboarding box). The kit owns the chrome, titlebar, focus,
    // and the .ow-* family; the slot owns centering (the box re-centers — no persisted offset, D1).
    _win = window.OrwellWindowKit.create({
      id: ID, title: "Your Cast Photo", icon: CAST_ICON,
      // Two audit lanes converge on this dialog:
      //  • A1/J1-25 (Lane A): modal:true — aria-modal + focus-trap + inert background + a backdrop
      //    scrim, so focus can't escape into the chat and the live narration recedes behind a dim
      //    instead of competing for figure.
      //  • D1 + State-5/6 (Lane B): the player's explicit ask — it must be MOVEABLE (draggable) but
      //    NOT resizeable, centered (top-center slot), and ALWAYS re-center (no slotKey + persistLayout
      //    false ⇒ a drag persists no offset and never syncs geometry across reloads/devices).
      // The result is a centered, draggable MODAL that re-centers. The two in-body exits (finalize /
      // "Skip for now") are the only ways out.
      slot: "top-center", role: "dialog", persistLayout: false, modal: true,
      minimizable: false, closable: false, draggable: true, resizable: false,
      minWidth: 320, minHeight: 240,
      content: body, focus: true,
    });
    _win.open();
    // Mount the reusable studio into the window body.
    buildStudio(studioHost, {
      // No persistent "set ✓" chip in the casting window — the titlebar carries the title and the
      // window hands off on finalize/skip, so nothing lingers above the composer.
      onSummary: function () {},
      ensureOpen: function () {},        // a window is always "open" — nothing to expand
      onFinalized: onCastingHeadshotChosen, // record {uploaded} + resume the interview
      onSkip: onCastingPhotoSkipped,        // OOBE re-sequence: record {skipped} + resume (pre-game box only)
    });
  }

  // OOBE re-sequence (2026-06-20): the player finalized their cast photo MID-interview. The photo is
  // OPTIONAL and does NOT gate the chat or createCharacter — so this no longer "opens the game".
  // Instead: record the photo step with the engine (POST /api/orwell/casting/photo {status:"uploaded"}
  // — idempotent; a sibling lane builds the route), tear the box down, then fire the RESUME cue so
  // the producers acknowledge and continue the interview. Returns true so the studio stops
  // repainting its own "finalized" state behind the teardown.
  function onCastingHeadshotChosen() {
    _photoHandledLocally = true;   // R5: the player acted — never re-trap them on a lagged POST
    teardownWindow();
    recordPhotoStep("uploaded");
    try {
      if (window._orwellResumeAfterPhoto) window._orwellResumeAfterPhoto();
    } catch (_) { /* fail open — the chat composer is still the way in */ }
    return true;
  }

  // Record the cast-photo step with the engine so it leaves state.casting.missing on every device.
  // Idempotent + fail-open: the photo is optional, so a failed POST must never wedge the interview —
  // the engine also drops "castPhoto" from `missing` once the portrait intake is finalized, so an
  // uploaded photo still clears even if this call hiccups. The resume cue fires regardless.
  function recordPhotoStep(status, attempt) {
    attempt = attempt || 0;
    try {
      fetch("/api/orwell/casting/photo", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: status }),
      }).then(function (r) {
        if (r && !r.ok) throw new Error("casting/photo " + r.status);
        // Nudge every surface to re-read state.casting (the box closes everywhere on the next route).
        try { if (window.orwellGameChanged) window.orwellGameChanged("casting-photo:" + status); } catch (_) {}
      }).catch(function () {
        // R5 (audit anim-F2): a failed/lagged POST left castPhoto in `missing`. Retry with backoff so
        // the step still clears engine-side; meanwhile the _photoHandledLocally latch keeps the box
        // closed so the player is never trapped behind it.
        if (attempt < 3) setTimeout(function () { recordPhotoStep(status, attempt + 1); }, 800 * (attempt + 1));
      });
    } catch (_) { /* fail open */ }
  }

  // OOBE re-sequence: the player chose to SKIP the cast photo. Same shape as the finalize path but
  // records {status:"skipped"} — the engine drops "castPhoto" from `missing`, so the box closes and
  // never re-prompts. Then resume the interview. (No portrait was set; the player can still add one
  // later via Settings → Account.)
  function onCastingPhotoSkipped() {
    _photoHandledLocally = true;   // R5: the player acted — never re-trap them on a lagged POST
    teardownWindow();
    recordPhotoStep("skipped");
    try {
      if (window._orwellResumeAfterPhoto) window._orwellResumeAfterPhoto();
    } catch (_) { /* fail open */ }
    return true;
  }

  function teardownWindow() {
    if (_win) { try { _win.destroy(); } catch (_) {} _win = null; }
    const el = document.getElementById(ID);
    if (el) el.remove();
    // R6 (audit anim-F3): clear the splash-suppression class HERE, not only in unmount(). The
    // skip/finalize exits call teardownWindow() directly; without this the welcome splash stayed
    // pinned opacity:0 in the gap before the next route()→unmount() (and indefinitely if the box
    // wrongly re-mounted on a failed POST — now prevented by the R5 latch).
    try { document.body.classList.remove("ow-casting-headshot-open"); } catch (_) {}
  }

  function unmount() {
    teardownWindow();
    removePill();   // Thing 2: clear the "Choose Your Character" pill when the step is done/closed
    try { document.body.classList.remove("ow-casting-headshot-open"); } catch (_) {}
  }

  // OOBE re-sequence (2026-06-20): is there a rendered producer turn yet? The photo box must follow
  // the producers' question, never precede it — so we only reveal it once an assistant turn is on
  // screen (chatRenderer uses .msg.msg-ai). Mirrors orwellOnboarding._conversationHasAssistantTurn.
  function _conversationHasAssistantTurn() {
    try {
      const hist = document.getElementById("chat-history");
      if (hist && hist.querySelector(".msg.msg-ai")) return true;
    } catch (_) {}
    return false;
  }

  // OOBE re-sequence: the box reveals MID-interview, so route() must be able to fire even when the
  // box is NOT yet mounted (the opener has to render first). This flag keeps the background poll
  // alive through the whole pre-game window (set true while pre-game, false once a season starts),
  // so the box pops the moment the producer turn lands even if no event reaches this tab.
  let _maybePregame = true;
  // R5 (audit anim-F2): a session-local latch set the moment the player uploads OR skips the cast
  // photo. route() consults it so a lagged/failed recordPhotoStep POST (the engine still lists
  // castPhoto in `missing`) cannot re-mount the box and TRAP the player. Resets on reload — if the
  // engine genuinely never cleared the step, the box reappears next load and they can act again.
  let _photoHandledLocally = false;

  // Thing 2: the cast-photo box no longer AUTO-opens. Instead, once the producer's opener has
  // rendered, route() surfaces a competition-style "Take your cast photo" pill in the chat
  // (M2-4: one verb set across the entry journey — Enter the house → Take your cast photo →
  // Meet the house; the old RPG-speak "Choose Your Character" broke the diegetic register)
  // (right after that message). The box opens only when the player clicks the pill — then the
  // pill is removed. This keeps the box from popping unbidden over the live narration.
  const PILL_ID = "orwell-choose-character";
  let _pillNotice = null;   // #913: the OrwellNotice kit instance hosting the pill above the composer.
  // #913: the pill used to be appended INLINE into #chat-history, so as the casting conversation
  // grew it scrolled out of the focal zone and orphaned in the backlog as a dead CTA. PIN it above
  // the composer instead — the same stacked OrwellNotice zone the decision card and the game guide
  // use (.chat-input-bar anchor) — so it stays in view for the whole casting step and tears down
  // cleanly. Fail-open to the legacy in-stream append only if the kit/anchor is unavailable (the
  // CTA must always reach the player).
  function showPill() {
    if (_win || document.getElementById(ID)) return;        // box already open ⇒ no pill
    if (document.getElementById(PILL_ID)) return;           // pill already shown
    // Inject the pill CSS BEFORE the button is in the DOM — otherwise it paints once with default
    // browser styling (a small, left-aligned plain button) and only snaps to the centered accent
    // pill when ensureCss() later runs from the box mount. ensureCss() is idempotent, so calling it
    // here costs nothing on repeat and kills that "two looks" flash. (live walkthrough, 2026-06-21)
    ensureCss();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ow-btn ow-btn-prominent hs-choose-btn";
    btn.textContent = "Take your cast photo";
    btn.setAttribute("aria-label", "Take your cast photo — open the photo booth");
    btn.addEventListener("click", () => { removePill(); mount(); });

    const hasKit = !!(window.OrwellNoticeKit && document.querySelector(".chat-input-bar"));
    if (hasKit) {
      // Pin into the above-composer notice zone (kind "guide" — a non-blocking prompt, not a
      // hard-stop decision). dismissible:false — the pill is removed by route() / a skip, not a × .
      _pillNotice = window.OrwellNoticeKit.create({
        id: PILL_ID,
        kind: "guide",
        title: "",
        dismissible: false,
        persistDismiss: false,
      });
      const host = _pillNotice.ensure();
      const head = _pillNotice.el && _pillNotice.el.querySelector(".on-head");
      if (head) head.style.display = "none";   // no heading — just the centered CTA
      host.appendChild(btn);
      return;
    }
    // Fail-open: the legacy in-stream placement (kit/anchor unavailable). Still wrapped so the
    // existing #orwell-choose-character CSS + the removePill() lookup keep working.
    const hist = document.getElementById("chat-history");
    if (!hist) return;
    const wrap = document.createElement("div");
    wrap.id = PILL_ID;
    wrap.appendChild(btn);
    hist.appendChild(wrap);
    try { hist.scrollTop = hist.scrollHeight; } catch (_) {}
  }
  function removePill() {
    // Tear down whichever host the pill used (kit notice or the legacy in-stream wrapper).
    if (_pillNotice) { try { _pillNotice.hide(); } catch (_) {} _pillNotice = null; }
    const p = document.getElementById(PILL_ID); if (p) p.remove();
  }

  async function route() {
    const gameBuild = document.body && document.body.hasAttribute("data-game-build");
    if (!gameBuild) { _maybePregame = false; return; }
    const st = await jget("/api/orwell/state");
    // Track the pre-game window for the background poll: keep polling while pre-game (so a not-yet-
    // mounted box can still appear after the opener), stop once the game is underway. A null/
    // unreadable state keeps polling (fail toward checking again), but never blocks anything.
    _maybePregame = !(st && st.started === true);
    // OOBE re-sequence: the photo box is pre-game ONLY, and it is no longer the FIRST step / a hard
    // gate — it is a mid-interview, OPTIONAL box. Reveal it only when ALL hold:
    //   • pre-game (started === false), AND
    //   • the engine still wants the cast-photo step — state.casting.missing includes "castPhoto"
    //     (the engine is the authority; once the FE POSTs uploaded/skipped, the step leaves
    //     `missing` and every device closes the box), AND
    //   • a producer turn has already rendered (.msg.msg-ai) so the box FOLLOWS the producers'
    //     question and never auto-mounts at page load before the interview opens.
    // Anything else (started season, no casting object, castPhoto handled, no producer turn yet)
    // ⇒ the box is closed. Drive it from the SYNCED canonical state, not per-tab local state.
    if (!(st && st.started === false)) { unmount(); return; }
    const casting = st && st.casting;
    const missing = (casting && Array.isArray(casting.missing)) ? casting.missing : [];
    const photoWanted = missing.indexOf("castPhoto") !== -1;
    if (!photoWanted) {
      // The cast-photo step is handled (uploaded or skipped, here or on another device) — close the
      // box everywhere. Don't re-fire any cue: the resume cue fires once at finalize/skip time.
      unmount();
      return;
    }
    if (_photoHandledLocally) {
      // R5 (audit anim-F2): the player already uploaded/skipped this session; the engine just hasn't
      // dropped castPhoto from `missing` yet (a lagged/failed POST — recordPhotoStep is retrying).
      // Keep the box CLOSED rather than re-mounting it on top of the player — never a trap.
      unmount();
      return;
    }
    if (!_conversationHasAssistantTurn()) {
      // The producers haven't reached out yet — don't surface the pill before the question. We'll
      // re-route on orwell:gamechanged (and the light poll) once the opener renders.
      unmount();
      return;
    }
    // Thing 2: surface the "Choose Your Character" pill (the box opens on click), NOT the box.
    showPill();
  }

  window.addEventListener("orwell:gamechanged", route);
  // 0064: a photo finalized on THIS or ANOTHER device flips intake.finalized — re-route so the gate
  // closes everywhere. `avatarchanged` fires locally on finalize; the cross-device path is the
  // canonical-session sync re-dispatching `orwell:gamechanged` on a `game-updated` ping, plus the
  // light poll below catches the case where no event reaches this tab.
  window.addEventListener("orwell:avatarchanged", route);
  // A bounded background re-check. It must do two jobs now: (1) close the box everywhere within a
  // few seconds when the photo step is handled on another device (the old job), AND (2) OPEN the box
  // once the producer turn renders during the pre-game interview, even if no event reaches this tab
  // (the new mid-interview reveal). So it re-routes while the box is mounted OR while we're still in
  // the pre-game window. Cheap state reads; a no-op once the season is underway (_maybePregame false).
  // ORW-143: this 4 s poll was un-gated: it re-read /api/orwell/state from hidden tabs and stacked a
  // new request on top of one still in flight (about 210 of the 660 state reads measured on prod in
  // 14 minutes of casting). Skip while the tab is hidden or a previous route() is still running.
  let _routeInFlight = false;
  setInterval(async function () {
    if (document.hidden || _routeInFlight) return;
    if (_win || document.getElementById(ID) || _maybePregame) {
      _routeInFlight = true;
      try { await route(); } catch (_) { /* route() is fail-open */ } finally { _routeInFlight = false; }
    }
  }, 4000);

  // IMMEDIATE reveal (live walkthrough, 2026-06-21): the producer's opener calls no game-mutating
  // tool, so `orwell:gamechanged` never fires for it — the pill used to wait out the 4s poll, so the
  // message sat there button-less for up to four seconds ("it thinks too hard before serving the
  // button"). Watch the chat transcript instead: a TRAILING debounce means route() fires ~400ms
  // after the LAST streamed token — i.e. the instant the producer's message settles, not mid-stream —
  // so the "Choose Your Character" button follows the message like a prompt in its own body. Cheap
  // and self-limiting: it only schedules while pre-game, and disconnects once a season starts.
  (function watchTranscriptForOpener() {
    const hist = document.getElementById("chat-history");
    if (!hist || typeof MutationObserver === "undefined") return;
    let t = null;
    const obs = new MutationObserver(function () {
      if (!_maybePregame) { obs.disconnect(); return; }   // season underway ⇒ stop watching
      if (_win || document.getElementById(ID) || document.getElementById(PILL_ID)) return; // box/pill up already
      if (t) clearTimeout(t);
      t = setTimeout(route, 400);                          // fire after the stream settles
    });
    obs.observe(hist, { childList: true, subtree: true, characterData: true });
  })();

  // #913: VERBAL-SKIP belt. The authoritative removal is route() (the engine drops "castPhoto" from
  // casting.missing once the model calls updateCasting({castPhoto:"skipped"}) → gamechanged → route
  // → unmount → removePill). But the model RELIABLY UNDER-CALLS that tool (the project's recurring
  // gap): on a plain "skip the photo" it often just acknowledges in prose, leaving the step in
  // `missing` and the pill pinned as a dead CTA. This belt watches the transcript for the player
  // verbally declining the photo and removes the pill immediately — a client-side error-correction
  // of the model's omission (never engine-authored content; the engine stays the source of truth,
  // and recordPhotoStep("skipped") still fires to clear the step for real). Pre-game only.
  const SKIP_RE = /\b(?:skip|no photo|without a photo|don'?t want (?:a|the|my) photo|maybe later|not now)\b/i;
  const PHOTO_RE = /\b(?:photo|picture|headshot|portrait|pic|image)\b/i;
  function _looksLikeVerbalPhotoSkip(text) {
    if (!text) return false;
    const t = String(text);
    // "skip"/"maybe later" already imply the current step; require the photo noun only for the
    // weaker "no"/"not now" phrasings to avoid false positives on unrelated chatter.
    if (/\b(?:skip|maybe later)\b/i.test(t)) return true;
    return SKIP_RE.test(t) && PHOTO_RE.test(t);
  }
  (function watchTranscriptForVerbalSkip() {
    const hist = document.getElementById("chat-history");
    if (!hist || typeof MutationObserver === "undefined") return;
    const obs = new MutationObserver(function () {
      if (!_maybePregame) { obs.disconnect(); return; }     // season underway ⇒ stop watching
      if (!document.getElementById(PILL_ID)) return;        // no pill up ⇒ nothing to clear
      if (_win || document.getElementById(ID)) return;      // box open ⇒ the box owns the skip
      const last = hist.querySelector(".msg-user:last-of-type");
      if (!last) return;
      if (_looksLikeVerbalPhotoSkip(last.textContent || "")) {
        _photoHandledLocally = true;                        // R5: the player acted — don't re-trap
        removePill();                                       // immediate: the dead CTA is gone now
        try { recordPhotoStep("skipped"); } catch (_) {}    // clear the step engine-side for real
      }
    });
    obs.observe(hist, { childList: true, subtree: true, characterData: true });
  })();

  ready(route);
})();
