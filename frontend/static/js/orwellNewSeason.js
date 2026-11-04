// Orwell "New season" surface (feature 0057, chunk 3) — the persistent post-season hand-off.
//
// The MOMENT the engine reports the season is over (moment === "post-season"), a persistent
// panel appears and STAYS PUT until the player actually starts the next season. It offers:
//   • KEEP the houseguest (the same person returns to a brand-new cast — 0056) vs RECREATE
//     (run casting from scratch) → POST /api/orwell/next-season {keep, confirm:true};
//   • the per-season PORTRAIT (keep / upload / regenerate) via the shared headshot studio
//     (G26/G27 — OrwellHeadshotStudio.mount).
// This SUBSUMES the 0056 FE keep/recreate UX.
//
// A gentle in-reunion nudge points the player at the button if they linger (the chip in the
// gadget rail / a soft pulse) so the path forward is never hidden.
//
// Built on the OrwellWindow kit (Lane F) — one window class, .ow-* family, slot placement,
// minimize-to-dock, Escape participation. Game-build gated; Vault-free (only public state +
// the player's own portrait). Fails OPEN: any error just leaves the chat untouched.
(function () {
  "use strict";

  function gameBuild() {
    return !!(document.body && document.body.hasAttribute("data-game-build"));
  }
  if (!gameBuild()) return;

  const WIN_ID = "orwell-new-season";
  const POLL_MS = 15000;
  // #780: monochrome icon language — the titlebar glyph is a mono inline SVG (currentColor),
  // never a full-color emoji. NEW = a "sparkle/fresh start"; EVICTED = a door (the terminal
  // hand-off). The kit renders these in the titlebar `icon` slot + the dock chip.
  const ICON_NEW = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8'/></svg>";
  const ICON_EVICTED = "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'/><polyline points='16 17 21 12 16 7'/><line x1='21' y1='12' x2='9' y2='12'/></svg>";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let _win = null;       // the live OrwellWindow instance, or null
  let _busy = false;     // a next-season call is in flight
  let _timer = null;
  let _mode = null;      // which surface is shown: null | "post-season" | "evicted" (LW10)

  async function jget(url) {
    try {
      const r = await fetch(url, { credentials: "same-origin" });
      return r.ok ? r.json() : null;
    } catch (_) { return null; }
  }

  // 0065 Phase 2: fire the next-season PORTRAIT warm. Best-effort, fail-open; the server endpoint is
  // idempotent AND gated off the Phase-1 char-data warm (declines until authoring ran, then waits for
  // it to finish) — exactly how startup gates portraits off cast authoring.
  function _warmNextSeasonPortraits() {
    try {
      fetch("/api/orwell/warm-portraits", { method: "POST", credentials: "same-origin" }).catch(() => {});
    } catch (_) {}
  }

  // The post-season gate: the engine's terminal state. moment === "post-season" is the same
  // signal the season retrospective / the engine's own gate uses (0048). We read it from the
  // Vault-free /state projection — never anything secret.
  async function isPostSeason() {
    const st = await jget("/api/orwell/state");
    return !!(st && st.started && st.moment === "post-season");
  }

  // Which hand-off surface (if any) the game state calls for:
  //   • "post-season" — the season is OVER (winner crowned): the keep/recast hand-off (0057).
  //   • "evicted"     — LW10 (audit 2026-06-21): the PLAYER was evicted PRE-JURY but the house plays on.
  //                     Their game is over; offer a clean "see how it ends" → fast-forward to the recap,
  //                     instead of leaving them to nudge the house forward a week at a time (0046).
  // Vault-free /state only. A juror (status "jury") keeps a finale role, so they are NOT swept here.
  async function gateState() {
    const st = await jget("/api/orwell/state");
    if (!st || !st.started) return null;
    if (st.finished || st.moment === "post-season") return "post-season";
    // E-1 (live rehearsal 2026-11-04): the pre-jury EVICTED player used to get a persistent "Evicted — your season is over / See how it ends" window here (LW10). Since 0133 the
    // evictee is walked through the exit-interview card and the spectator-choice card (watch / skip), which REPLACE that hand-off — and the window rendered ON TOP of
    // those cards (covering "Skip ahead" and Confirm), offered a second competing fast-forward, and told the player their season was over when they are back for the
    // finale. So no window is shown for an evicted player any more; the post-season hand-off above is unchanged. (`/api/orwell/conclude-season` stays for the API.)
    return null;
  }

  // ── the panel body ─────────────────────────────────────────────────────────
  function buildBody() {
    const wrap = document.createElement("div");
    wrap.className = "ons-body";
    if (!document.getElementById("orwell-new-season-css")) {
      const s = document.createElement("style");
      s.id = "orwell-new-season-css";
      s.textContent = `
        .ons-body { font-size: 13px; line-height: 1.5; max-width: 360px; }
        .ons-body .ons-lead { opacity: .9; margin-bottom: 10px; }
        .ons-body .ons-choices { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
        .ons-body .ons-btn { font: inherit; font-size: 12.5px; font-weight: 600;
          padding: 8px 14px; border-radius: 8px; cursor: pointer; border: 1px solid transparent;
          min-height: 44px; }
        .ons-body .ons-btn-primary { background: var(--accent, var(--accent-primary, #6d4aff)); color: var(--on-accent, #fff); }
        .ons-body .ons-btn-ghost { background: transparent; color: var(--fg, #cfd8e3);
          border-color: var(--border, #355a66); }
        .ons-body .ons-btn[disabled] { opacity: .55; cursor: default; }
        .ons-body .ons-hint { opacity: .6; font-size: 11.5px; margin-top: 6px; }
        .ons-body .ons-portrait { margin-top: 12px; padding-top: 10px;
          border-top: 1px solid var(--border, #355a66); }
        .ons-body .ons-portrait-h { font-size: 12px; opacity: .75; margin-bottom: 6px; font-weight: 600; }
        .ons-body .ons-msg { font-size: 12px; opacity: .8; margin-top: 8px; min-height: 1.2em; }
        .ons-body .ons-msg.ons-err { color: var(--red, #e06c75); opacity: 1; }
        /* #775 element-kit migration: the ons-btns compose .ow-btn (+ -prominent / -secondary);
           the kit owns frosted chrome (incl. the ghost button's hairline rim) — the retired
           frosted ons-btn-ghost border override lived here. The .ons-btn* rules above remain
           the Normal-tier (non-glass) fallback + the disabled state.
           #725: soften the portrait divider to the low-opacity WHITE hairline on the light glass. */
        body.theme-frosted .ons-body .ons-portrait { border-top-color: rgba(255,255,255,0.14); }`;
      document.head.appendChild(s);
    }

    wrap.innerHTML = `
      <div class="ons-lead">The season is over. When you're ready, walk back into a brand-new
        house — bring this houseguest back, or recast from scratch.</div>
      <div class="ons-choices">
        <button type="button" class="ow-btn ow-btn-prominent ons-btn ons-btn-primary" data-keep="1">Keep this houseguest</button>
        <button type="button" class="ow-btn ow-btn-secondary ons-btn ons-btn-ghost" data-keep="0">Recast from scratch</button>
      </div>
      <div class="ons-hint">Keep = the same person, a new cast. Recast = the casting interview runs again.</div>
      <div class="ons-portrait">
        <div class="ons-portrait-h">This season's portrait</div>
        <div class="ons-portrait-studio" id="ons-portrait-studio"></div>
      </div>
      <div class="ons-msg" id="ons-msg" role="status" aria-live="polite"></div>`;

    // The per-season portrait: keep / upload / regenerate via the shared studio (G26/G27).
    try {
      const studioHost = wrap.querySelector("#ons-portrait-studio");
      if (studioHost && window.OrwellHeadshotStudio && window.OrwellHeadshotStudio.mount) {
        window.OrwellHeadshotStudio.mount(studioHost, {});
      } else if (studioHost) {
        studioHost.textContent = "Portrait studio unavailable.";
      }
    } catch (_) {}

    const msg = wrap.querySelector("#ons-msg");
    // A11Y-2: errors on this irreversible season transition must reach a screen reader. The
    // message div is a polite live region; an error escalates to assertive so it is not deferred
    // behind the always-active chat stream (and the player doesn't re-POST a "stuck" action).
    const setMsg = (t, err) => { msg.setAttribute("aria-live", err ? "assertive" : "polite"); msg.textContent = t || ""; msg.classList.toggle("ons-err", !!err); };
    const buttons = wrap.querySelectorAll(".ons-btn");
    const setBusy = (b) => { _busy = b; buttons.forEach((btn) => { btn.disabled = b; }); };

    buttons.forEach((btn) => {
      btn.addEventListener("click", async () => {
        const keep = btn.dataset.keep === "1";
        // F-NEW-2 (Nielsen H5): "Recast from scratch" is irreversible — it discards
        // the player's entire houseguest identity and re-runs the casting interview.
        // Gate it behind the same styledConfirm used for the factory/progress resets.
        // (Keeping the houseguest is non-destructive, so it commits straight away.)
        if (!keep && window.styledConfirm) {
          const ok = await window.styledConfirm(
            "Recast from scratch?\n\nThis discards your current houseguest entirely — their identity, backstory and portrait — and runs the casting interview again from the start. This can't be undone.",
            { confirmText: "Recast", danger: true }
          );
          if (!ok) return;
        }
        startNextSeason(keep, setMsg, setBusy);
      });
    });
    return wrap;
  }

  async function startNextSeason(keep, setMsg, setBusy) {
    if (_busy) return;
    setBusy(true);
    setMsg(keep ? "Bringing your houseguest back…" : "Opening casting for a new houseguest…");
    try {
      const r = await fetch("/api/orwell/next-season", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keep: !!keep, confirm: true }),
      });
      const d = r.ok ? await r.json() : null;
      if (!r.ok || !d) {
        const err = (d && d.error) || "The house wouldn't open just yet — try again.";
        setMsg(err, true);
        setBusy(false);
        return;
      }
      // The new season committed. Tear the panel down, open a FRESH chat session (so the dead
      // season's transcript never rides as narrator context — E65), and let every surface refresh
      // through THE one shared dispatcher (platform.js orwellGameChanged — G15: never an ad-hoc
      // CustomEvent). The avatar refresh rides the same wave (the cast/portrait surfaces re-read).
      // This is a genuine season RESTART — arm the fresh-session split (the initial first-season
      // onboarding never reaches here, so it stays ONE continuous conversation).
      destroy();
      // 0065 Phase 2 — IMAGE WARM at the next-season CONFIRM: now that the player has committed to the
      // next season, kick the portrait warm. It is GATED OFF Phase 1 (the finale-day char-data warm)
      // server-side — `warm_portraits` declines until author warm has run, then waits for it to fully
      // finish before shooting a single face — exactly as STARTUP gates images off cast authoring.
      // Best-effort, fail-open: a decline (no Phase-1 warm) just leaves the route's own portrait
      // generation to own the faces.
      _warmNextSeasonPortraits();
      try { window._orwellMarkRestart && window._orwellMarkRestart(); } catch (_) {}
      try { window._orwellFreshSession && window._orwellFreshSession(); } catch (_) {}
      try { window.orwellGameChanged && window.orwellGameChanged("next-season"); } catch (_) {}
    } catch (e) {
      if (window.OrwellReport) window.OrwellReport.fail("new-season", "next-season", e);
      setMsg("The producers couldn't reach you — try again.", true);
      setBusy(false);
    }
  }

  // LW10: the pre-jury evicted player's terminal hand-off — a clear "your season is over" + a
  // one-click fast-forward to the finale (POST /api/orwell/conclude-season), which lands them on the
  // post-season recap + the keep/recast surface above. Reuses the same .ons-* styling as buildBody.
  function buildEvictedBody() {
    const wrap = document.createElement("div");
    wrap.className = "ons-body";
    wrap.innerHTML = `
      <div class="ons-lead">You've been evicted — your season is over. The house keeps playing without
        you. See how it all ends, then walk into a brand-new season.</div>
      <div class="ons-choices">
        <button type="button" class="ow-btn ow-btn-prominent ons-btn ons-btn-primary" id="ons-conclude">See how it ends</button>
      </div>
      <div class="ons-hint">Fast-forwards the rest of the season to the finale, then unlocks the recap
        and a fresh start.</div>
      <div class="ons-msg" id="ons-msg" role="status" aria-live="polite"></div>`;
    const msg = wrap.querySelector("#ons-msg");
    // A11Y-2: errors on this irreversible season transition must reach a screen reader. The
    // message div is a polite live region; an error escalates to assertive so it is not deferred
    // behind the always-active chat stream (and the player doesn't re-POST a "stuck" action).
    const setMsg = (t, err) => { msg.setAttribute("aria-live", err ? "assertive" : "polite"); msg.textContent = t || ""; msg.classList.toggle("ons-err", !!err); };
    const btn = wrap.querySelector("#ons-conclude");
    btn.addEventListener("click", async () => {
      if (_busy) return;
      // F-NEW-3 (Nielsen H5): "See how it ends" is one-way — it fast-forwards through
      // every remaining week to the finale and can't be undone. Confirm before committing.
      if (window.styledConfirm) {
        const ok = await window.styledConfirm(
          "See how it ends?\n\nThis fast-forwards the rest of the season straight to the finale — skipping every remaining week. You can't return to play them out. This can't be undone.",
          { confirmText: "Fast-forward", danger: true }
        );
        if (!ok) return;
      }
      _busy = true; btn.disabled = true; setMsg("Playing out the rest of the season…");
      try {
        const r = await fetch("/api/orwell/conclude-season", { method: "POST", credentials: "same-origin" });
        const d = r.ok ? await r.json() : null;
        if (!r.ok || !d) { setMsg((d && d.error) || "The feeds wouldn't fast-forward to the finale — try again.", true); _busy = false; btn.disabled = false; return; }
        // The season is now over → post-season. Let THE shared dispatcher (G15) refresh every surface;
        // refresh() then swaps this window for the keep/recast hand-off, and the retrospective unlocks.
        _busy = false;
        try { window.orwellGameChanged && window.orwellGameChanged("conclude-season"); } catch (_) {}
        refresh();
      } catch (e) {
        if (window.OrwellReport) window.OrwellReport.fail("new-season", "conclude-season", e);
        setMsg("Couldn't reach the producers — try again.", true); _busy = false; btn.disabled = false;
      }
    });
    return wrap;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────
  function show(mode) {
    mode = mode || "post-season";
    if (_mode === mode && (_win || document.getElementById(WIN_ID))) return;
    if (_win || document.getElementById(WIN_ID)) destroy(); // a state change: tear down the old surface
    if (!(window.OrwellWindowKit && window.OrwellWindowKit.create)) return; // kit not loaded
    _mode = mode;
    // #780: cohesive window-title contract — a Title-Case name + a MONOCHROME mono-SVG `icon`
    // (the kit renders `title` verbatim, so an emoji prefix lands as a full-color glyph that
    // clashes with the icon language). The door icon marks the evicted-player terminal hand-off.
    const evicted = mode === "evicted";
    _win = window.OrwellWindowKit.create({
      id: WIN_ID,
      title: evicted ? "Evicted" : "A New Season",
      icon: evicted ? ICON_EVICTED : ICON_NEW,
      slot: "bottom-right",
      slotKey: "new-season",
      // #894 (RESP-6): on the narrow tier present as a bottom SHEET (the proven Cast
      // recipe) — bottom-pinned, edge-to-edge, scroll-contained. This retires the old
      // RESP-6 defect (the window floated top-left with the live chat bleeding through
      // on the right, and the portrait-picker dropdown clipped behind the window's right
      // edge): a full-width sheet has no right edge to bleed past and the `<select>`
      // opens within the sheet width. Desktop keeps the bottom-right slot window.
      sheet: true,
      // Persistent: stays until the state moves on. Not closable; minimizable so the player can tuck
      // it away and keep lingering, then bring it back from the dock.
      closable: false,
      minimizable: true,
      draggable: true,
      content: evicted ? buildEvictedBody() : buildBody(),
    });
    _win.open();
    // F-NEW-13: this window has no × by design (it's the season hand-off; it auto-dismisses
    // when the state moves on). Explain the missing close affordance so it doesn't read as a
    // bug — minimize tucks it to the dock; it leaves on its own once you move forward.
    try {
      if (_win.el) {
        _win.el.title = "This stays until you move on — it closes itself once the next season begins. Minimize to tuck it away.";
      }
    } catch (_) {}
    nudge();
  }

  function destroy() {
    _mode = null;
    try { if (_win) _win.destroy(); } catch (_) {}
    _win = null;
    const stray = document.getElementById(WIN_ID);
    if (stray && stray.remove) stray.remove();
  }

  // Gentle in-reunion nudge: a soft pulse on the window (or its dock chip) so the path forward
  // is never hidden if the player lingers. TX-3: genuinely reduced-motion safe — WAAPI runs
  // regardless of the CSS media query, so gate it explicitly here.
  function nudge() {
    try {
      if (!_win || !_win.el) return;
      if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      _win.el.animate && _win.el.animate(
        [{ boxShadow: "0 0 0 0 transparent" },
         { boxShadow: "0 0 0 4px color-mix(in srgb, var(--accent, #6d4aff) 35%, transparent)" },
         { boxShadow: "0 0 0 0 transparent" }],
        { duration: 1400, iterations: 1 });
    } catch (_) {}
  }

  async function refresh() {
    const want = await gateState();   // null | "post-season" | "evicted"
    if (want === _mode) return;       // already in the right state
    if (!want) { destroy(); return; }
    show(want);                       // show() tears down any prior surface before swapping
  }

  function start() {
    refresh();
    if (_timer) clearInterval(_timer);
    const tick = async () => {
      if (!document.hidden) await refresh();
      _timer = setTimeout(tick, POLL_MS);
    };
    _timer = setTimeout(tick, POLL_MS);
  }

  window.addEventListener("orwell:gamechanged", refresh);
  // Seam for the headless gate / tests.
  window._orwellNewSeasonShow = show;
  window._orwellNewSeasonRefresh = refresh;

  ready(start);
})();
