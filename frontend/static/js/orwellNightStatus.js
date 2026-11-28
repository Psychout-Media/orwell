// Orwell "Nightfall" gadget (ADR 0006 / feature 0066) — the at-a-glance read of the in-game night.
//
// Renders the engine's Vault-free time-of-day + who is AWAKE and available, day and night (state.awake,
// ORW-383; held back by the engine during a staged ceremony, so the last list stays shown), falling back to
// who has TURNED IN (state.asleep) for an older payload without `awake` - so the
// player can SEE the house thin out as it gets late — the visible face of the nightly sleep economy
// (the cost of going to bed early / the reward of being a night owl). AUGMENTS the chat, never replaces
// it (ADR 0003): no click-to-act, no bedtime button — the player turns in by SAYING so in prose; the
// engine grounds the narration. Present ONLY while the in-game clock is running (the ORWELL_TIME_OF_DAY
// feature is on, per the settings switch); silent otherwise.
//
//   • GET /api/orwell/state → { started, timeOfDay, awake?: [{ id, name }], asleep: [{ id, name }], ... }
//
// Fail-open everywhere: no gadget on empty / error / pre-game / clock-off.
(function () {
  "use strict";

  const POLL_MS = 25000;
  const ID = "orwell-night";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let timer = null;
  let _failures = 0;
  let _lastAwake = null;
  let _lastAnnounced = null; // A11Y-1: announce nightfall state only when it changes
  function _pollDelay() { return Math.min(POLL_MS * Math.pow(2, _failures), 120000); }

  // WS Phase-1 (§4): when the multiplexed socket is live the server PUSHES a `state`/`hud`
  // frame on every board change; platform.js relays it to the one `orwell:gamechanged`
  // dispatcher, which fires refreshNow() below. So we cancel the 25s periodic TIMER in WS
  // mode and stay edge-triggered (fail-soft: any doubt ⇒ keep polling). The fallback/SSE
  // path is unchanged and still polls.
  function _wsActive() {
    try { return !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive()); }
    catch (_) { return false; }
  }

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // The phase emoji IS the at-a-glance indicator (morning → late-night) — mirrors orwellStatusPanel.
  const TOD = {
    "morning": ["🌅", "Morning"],
    "afternoon": ["🌞", "Afternoon"],
    "evening": ["🌆", "Evening"],
    "night": ["🌙", "Night"],
    "late-night": ["🌌", "Late night"],
  };

  // #640: compose the OrwellGadget kit (the .og-* card chrome — header/body/empty-state, the
  // rail mount + content-driven visibility). Only this gadget's own inner CSS (the nightfall
  // label/quiet treatment) stays here; the card shell + header are the kit's. The kit's TITLE is
  // a static "Nightfall"; the dynamic time-of-day phase (🌅 Morning …) renders in the BODY.
  let _gadget = null;
  function ensureEl() {
    let el = document.getElementById(ID);
    if (el) return el;
    if (!document.getElementById("orwell-night-css")) {
      const st = document.createElement("style");
      st.id = "orwell-night-css";
      st.textContent = `
        #orwell-night .onight-phase {
          display: flex; align-items: center; gap: .4rem; margin: 0 0 .3rem;
          font-weight: 600; letter-spacing: .03em;
          color: color-mix(in srgb, var(--fg, #9cdef2) 78%, var(--panel, #111));
        }
        #orwell-night .onight-list { overflow-wrap: anywhere; }
        #orwell-night .onight-label { opacity: .6; }
        #orwell-night .onight-quiet { opacity: .6; font-style: italic; }`;
      document.head.appendChild(st);
    }
    // 0054: prefer the control-room gadget rail, beside the other ambient house gadgets (presence).
    _gadget = window.OrwellGadgetKit.create({ id: ID, title: "Time of day", icon: "🌙", ariaLabel: "Time of day" });
    const body = _gadget.ensure("orwell-presence");
    // A11Y-1: a live region is NOT the card root (re-rendering every poll would re-announce the
    // unchanged state). The phase line + the turned-in list + a hidden polite announcer (changes only).
    body.innerHTML = `<div class="onight-phase" data-role="phase"></div>` +
      `<div class="onight-list" data-role="body"></div>` +
      `<span data-role="announce" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);"></span>`;
    return _gadget.el;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function firstName(full) { return String(full || "").trim().split(/\s+/)[0] || ""; }

  function render(state) {
    const tod = state && state.started ? state.timeOfDay : null;
    // F6 (#1023): only BUILD the gadget once the in-game clock is actually running, so the "Nightfall"
    // card chrome is never baked into the DOM pre-game/clock-off (latent stale state). Pre-game we
    // simply leave it unmounted; if a prior render already created it, hide that node.
    if (!tod || !TOD[tod]) {
      const existing = document.getElementById(ID);
      if (existing && _gadget) { _gadget.hide(); existing.removeAttribute("title"); }
      _lastAnnounced = null;
      if (state) _lastAwake = null; // a real state that says no clock is running clears the list; a failed fetch (state null) keeps the last known one (review of #2678)
      return;
    }
    const el = ensureEl();
    const wb = window.OrwellWhen && window.OrwellWhen.band(state); // ORW-1162: the shared "when is it" source
    const [emoji, label] = wb ? wb : ((tod === "late-night" || tod === "morning") && state.earlyMorning === true) ? ["\u{1F305}", "Early morning"] : TOD[tod]; // ORW-392

    // PHASE LINE: the time-of-day indicator (emoji + label) at the top of the card body.
    el.querySelector("[data-role='phase']").innerHTML =
      '<span aria-hidden="true">' + emoji + "</span><span>" + esc(label) + "</span>";

    // BODY (ORW-383, Ryne): who is AWAKE and available, day and night - not "N have turned in". The engine's observable `awake` list (Vault-free names); an older payload without it falls back to the
    // turned-in list. The player is never listed.
    // The engine holds the awake list back while a ceremony is staged (its ids could carry the unrevealed outcome); keep showing the last one meanwhile.
    const awakeList = Array.isArray(state.awake) ? (_lastAwake = state.awake) : _lastAwake;
    const asleep = Array.isArray(state.asleep) ? state.asleep : [];
    const body = el.querySelector("[data-role='body']");
    if (awakeList) {
      if (!awakeList.length) {
        body.innerHTML = '<span class="onight-quiet">All the houseguests have turned in.</span>';
        el.removeAttribute("title");
      } else {
        const names = awakeList.map((p) => esc(firstName(p.name))).filter(Boolean).join(", ");
        body.innerHTML = '<span class="onight-label">Awake (' + awakeList.length + "):</span> " + names;
        el.setAttribute("title", awakeList.length + (awakeList.length === 1 ? " houseguest is" : " houseguests are") + " awake");
      }
    } else if (!asleep.length) {
      body.innerHTML = '<span class="onight-quiet">The whole house is still up.</span>';
      el.removeAttribute("title");
    } else {
      const names = asleep.map((p) => esc(firstName(p.name))).filter(Boolean).join(", ");
      body.innerHTML = '<span class="onight-label">Turned in (' + asleep.length + "):</span> " + names;
      el.setAttribute("title", asleep.length + (asleep.length === 1 ? " houseguest has" : " houseguests have") + " turned in for the night");
    }
    // A11Y-1: announce the nightfall phase + sleep summary ONLY when it changes (not every poll).
    const announce = awakeList
      ? (awakeList.length ? (label + "; awake: " + awakeList.map((p) => firstName(p.name)).filter(Boolean).join(", ")) : (label + "; all the houseguests have turned in"))
      : (asleep.length
        ? (label + "; turned in: " + asleep.map((p) => firstName(p.name)).filter(Boolean).join(", "))
        : (label + "; the whole house is still up"));
    if (announce !== _lastAnnounced) {
      const ann = el.querySelector("[data-role='announce']");
      if (ann) ann.textContent = announce;
      _lastAnnounced = announce;
    }
    _gadget.show();
  }

  async function tick() {
    try {
      if (document.hidden) return; // a hidden tab polls nothing (C18)
      const state = await getJSON("/api/orwell/state");
      render(state || null);
      _failures = 0;
    } catch (_) {
      _failures += 1;
      if (window.OrwellReport) window.OrwellReport.fail("night", "state-poll", _); // G11: fail open, never silent
      render(null); // fail OPEN: the gadget simply isn't there
    } finally {
      if (timer) { clearTimeout(timer); timer = null; }
      // In WS mode the `state`/`hud` push (via orwell:gamechanged → refreshNow) supersedes the
      // periodic poll — don't re-arm the timer, just stay edge-triggered.
      if (!_wsActive()) timer = setTimeout(tick, _pollDelay());
    }
  }

  function refreshNow() { _failures = 0; tick(); }

  ready(() => {
    // Only under the game build (the reduced surface) — the full workspace skips the gadget.
    if (document.body && document.body.dataset.gameBuild !== "1") return;
    tick();
    // Refresh on the shared game-changed signal (platform.js dispatches it after every engine-mutating
    // turn) so the house thins the moment the clock rolls and houseguests turn in.
    window.addEventListener("orwell:gamechanged", refreshNow);
    // WS Phase-1 (§4/§6): cancel the periodic poll the instant the socket goes live;
    // resume polling if it falls back to SSE. refreshNow re-arms the timer via tick()
    // (which only re-schedules while !_wsActive()).
    window.addEventListener("orwell:ws-active", () => { if (timer) { clearTimeout(timer); timer = null; } });
    window.addEventListener("orwell:ws-inactive", refreshNow);
    window.addEventListener("beforeunload", () => timer && clearTimeout(timer));
  });
})();
