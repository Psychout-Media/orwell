// M3-1 — the room strip (idea 1): a slim strip of portrait chips for who is in the player's
// CURRENT room, mounted directly above the composer. AUGMENTS the chat (ADR 0003 §4/§7): the
// chips are INERT — no click-to-act, no scene-starting affordance (M3-6 adds the dossier door
// later). The player still mills and talks in PROSE; this is a visual "who's here" ground,
// mirroring the "Where You Are" rail gadget (orwellPresence.js) but as faces, not names, and
// scoped to ROOM presence only (no nearby rooms).
//
// #642: composes the OrwellNotice kit (window.OrwellNoticeKit) for its above-composer anchor —
// the ONE stacked zone every such affordance shares (the convention gate test_on_notice_kit.py
// forbids a NEW module from hand-rolling its own DOM anchor beside the composer bar). kind:
// "guide" (the ambient, title-less, low-key skin orwellChatHint.js also uses) with dismissible:
// false — this is a persistent ambient strip, never a dismissible notice. Only this module's OWN
// inner CSS (the chip grid) stays here; the card shell/anchor/stacking/theming are the kit's.
//
// Renders ONLY the Vault-free whereabouts().present roster (id/name), the public roster's
// portrait/status facets (0051), the public ceremony roles (M2-2 badges), and the observable
// `asleep` set (ADR 0006) — never a stat, relationship, or hidden element.
//
//   • GET /api/orwell/state        → { started, asleep: [{id,name}] } — gates + turned-in set
//   • GET /api/orwell/whereabouts  → { whereabouts: { room, present:[{id,name}] } } | null
//   • GET /api/orwell/roster       → { roster: [{id,name,status,portrait}] } — portrait lookup
//   • GET /api/orwell/status       → the public ceremony board — OrwellMonogram.rolesFrom()
//
// Fail-open everywhere: any fetch failure or pre-game collapses the strip (no chips, no error).
(function () {
  "use strict";

  const POLL_MS = 25000;
  const ID = "orwell-room-strip";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let timer = null;
  let _failures = 0;
  // ORW-151: tick() makes four sequential requests, and every orwell:gamechanged starts a new one,
  // so two refreshes can overlap and finish out of order. Only the NEWEST tick may render; a stale
  // one that resolves late is dropped instead of repainting an older room over a newer one.
  let _tickSeq = 0;
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

  // ── the pure diff helper (node-unit-tested) ─────────────────────────────────────────
  // "Dimming on exit": a chip that drops out of `present` is NOT removed immediately — it is
  // held for ONE more render cycle at a dimmed "leaving" phase, then dropped. Pure (no DOM/
  // fetch/closures over module state) so a node harness can drive it directly against the
  // PREVIOUS chip map.
  //   prev: Map<key, { person, phase: 'here'|'leaving' }> (the chip map from the last render)
  //   present: array of { id?, name }  — this cycle's whereabouts().present
  // Returns { chips: [{ key, person, phase }], next: Map } — `chips` is display order (everyone
  // HERE first, then anyone LEAVING); `next` is the chip map to pass in as `prev` next cycle.
  function _diffPresence(prev, present) {
    const keyOf = (p) =>
      (p && p.id != null && p.id !== "" ? "id:" + p.id : "nm:" + String((p && p.name) || ""));
    const list = Array.isArray(present) ? present : [];
    const next = new Map();
    const currentKeys = new Set();
    list.forEach((p) => {
      const k = keyOf(p);
      currentKeys.add(k);
      next.set(k, { person: p, phase: "here" });
    });
    const leavingKeys = [];
    (prev || new Map()).forEach((entry, k) => {
      if (currentKeys.has(k)) return; // still here — the fresh "here" entry above wins
      if (entry && entry.phase === "here") {
        next.set(k, { person: entry.person, phase: "leaving" }); // just left — one dimmed cycle
        leavingKeys.push(k);
      }
      // phase === "leaving" already ⇒ its grace cycle is over; drop (not carried into `next`)
    });
    const chips = list.map((p) => ({ key: keyOf(p), person: p, phase: "here" }));
    leavingKeys.forEach((k) => chips.push({ key: k, person: next.get(k).person, phase: "leaving" }));
    return { chips, next };
  }

  function firstName(full) { return String(full || "").trim().split(/\s+/)[0] || ""; }

  // Only the chip grid — the card shell/anchor/dismiss/animation/theming are the kit's (#642).
  function ensureCss() {
    if (document.getElementById("orwell-room-strip-css")) return;
    const st = document.createElement("style");
    st.id = "orwell-room-strip-css";
    st.textContent = `
      /* ORW-246b (live, phone width): the notice zone is a height-capped scroller, and a tall card (the premiere welcome guide) above the strip pushed it out of view - it existed but sat clipped below the card.
         Lead the zone with it (order:-1). NOT sticky: a sticky strip overlapped a tall decision card when the zone scrolled (responsive-matrix face-grid overlap at 320/390). */
      #orwell-room-strip { order: -1; flex: 0 0 auto; }
      #orwell-room-strip .ors-row {
        display: flex; gap: 10px; align-items: flex-start; flex-wrap: nowrap;
        overflow-x: auto; overflow-y: hidden;
        -webkit-overflow-scrolling: touch; scrollbar-width: thin;
      }
      #orwell-room-strip .ors-chip {
        flex: 0 0 auto; width: 52px; display: flex; flex-direction: column;
        align-items: center; gap: 3px; transition: opacity .6s ease;
      }
      #orwell-room-strip .ors-chip-leaving { opacity: .35; }
      /* Transient-animation audit (dead leaving-fade): the chip's opacity .6s transition above
         + the one-cycle "leaving" grace phase were designed to fade a departing occupant 1.0 → .35,
         but render() used to rebuild EVERY chip as a fresh node each poll — a node born at .35 has
         nothing to interpolate from, so the fade never fired. The keyed reconcile (render) now
         TOGGLES .ors-chip-leaving on the PERSISTENT chip node, so the .6s fade actually runs. New
         arrivals get a brief enter fade; reduced-motion strips both to an instant (static) state. */
      #orwell-room-strip .ors-chip-enter {
        animation: ors-chip-in .45s cubic-bezier(0.22, 0.61, 0.36, 1) both;
      }
      @keyframes ors-chip-in {
        0%   { opacity: 0; transform: translateY(4px); }
        100% { opacity: 1; transform: none; }
      }
      @media (prefers-reduced-motion: reduce) {
        #orwell-room-strip .ors-chip { transition: none; }
        #orwell-room-strip .ors-chip-enter { animation: none; }
      }
      #orwell-room-strip .ors-face-wrap {
        width: 40px; height: 40px; border-radius: 10px; overflow: hidden;
        box-shadow: 0 1px 3px rgba(0,0,0,.35);
      }
      #orwell-room-strip .ors-face-wrap .ow-mono-face { border-radius: 10px; }
      #orwell-room-strip .ors-moon {
        position: absolute; left: -2px; top: -2px; font-size: .58rem; line-height: 1;
        background: rgba(10,14,20,.78); border-radius: 50%; padding: 2px 3px;
      }
      #orwell-room-strip .ors-name {
        font-size: .65rem; line-height: 1.15; text-align: center; max-width: 52px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .82;
      }
      /* ORW-246c: the empty-room chip owns an OPAQUE dark pill + light ink. The ambient notice card is glass, so inherited ink composited over whatever wallpaper sits behind it (dark ink on teal measured 3.63:1
         in the a11y matrix; even black cannot clear 4.5 on that teal, only light ink can). A solid pill makes the contrast independent of theme and wallpaper (~15:1). */
      #orwell-room-strip .ors-alone {
        display: inline-block; font-size: .85rem; padding: .15rem .65rem; border-radius: 999px;
        background: #14181f; color: #f2f5f8; opacity: 1;
      }
      @media (max-width: 480px) {
        #orwell-room-strip .ors-row { gap: 6px; }
        #orwell-room-strip .ors-chip { width: 42px; }
        #orwell-room-strip .ors-face-wrap { width: 32px; height: 32px; }
        #orwell-room-strip .ors-name { display: none; }
      }
    `;
    document.head.appendChild(st);
  }

  // The kit notice instance (a title-less "guide"-kind card — the ambient look orwellChatHint.js
  // also uses). Built lazily; mounted/unmounted per render (never shown empty — DoD: collapses
  // gracefully pre-game, never a hollow bordered box).
  let _notice = null;
  function ensureNotice() {
    if (_notice) return _notice;
    if (!window.OrwellNoticeKit) return null; // kit not loaded yet — fail open, try again next tick
    _notice = window.OrwellNoticeKit.create({
      id: ID, kind: "guide", title: "", role: "group",
      dismissible: false, persistDismiss: false,
    });
    return _notice;
  }

  function titleFor(person, opts) {
    let t = (person && person.name) || "";
    if (opts && opts.asleep) t += " — turned in for the night";
    if (opts && opts.leaving) t += " — just left the room";
    return t;
  }

  // The one shared face builder — composes OrwellMonogram.face() (M2-2) so a portrait-less
  // houseguest reads as the designed monogram, never a flat placeholder, and a public ceremony
  // role composites its badge exactly as the cast window/decision cards do.
  function faceFor(person, rosterById, roles, asleep) {
    const rc = person && person.id != null ? rosterById.get(person.id) : null;
    const card = {
      id: (person && (person.id != null ? person.id : person.name)) || "?",
      name: person && person.name,
      status: (rc && rc.status) || "active",
      portrait: rc ? rc.portrait : null,
    };
    const role = roles ? (roles[card.id] || (person && roles[person.name]) || null) : null;
    const faceEl = window.OrwellMonogram
      ? window.OrwellMonogram.face(card, { role: role, alt: card.name })
      : document.createElement("span");
    if (asleep) {
      faceEl.insertAdjacentHTML(
        "beforeend",
        '<span class="ors-moon" aria-hidden="true" title="Turned in for the night">🌙</span>',
      );
    }
    return faceEl;
  }

  let _chipState = new Map(); // the room's chip map, carried across renders

  // A stable visual signature for a chip's FACE — a change (portrait landed, turned in, role badge)
  // means the face must be rebuilt; identity itself is carried by the reconcile key (c.key), so an
  // unchanged occupant reuses its exact node (and decoded portrait) across polls.
  function _chipSig(person, asleep, roles, rosterById) {
    const rc = person && person.id != null ? rosterById.get(person.id) : null;
    const role = roles ? (roles[person && (person.id != null ? person.id : person.name)] || (person && roles[person.name]) || "") : "";
    return [(rc && rc.portrait) || "", (rc && rc.status) || "active", role, asleep ? "1" : "0"].join("|");
  }
  // Build a chip node (face + first-name label). Leaving/entrance state is applied by the reconcile
  // on the PERSISTENT node so CSS transitions/animations fire; this only assembles the content.
  function buildChip(person, asleep, roles, rosterById) {
    const chip = document.createElement("div");
    chip.className = "ors-chip";
    const faceWrap = document.createElement("div");
    faceWrap.className = "ors-face-wrap";
    faceWrap.appendChild(faceFor(person, rosterById, roles, asleep));
    chip.appendChild(faceWrap);
    const label = document.createElement("span");
    label.className = "ors-name";
    label.textContent = firstName(person && person.name);
    chip.appendChild(label);
    return chip;
  }
  // Transient-animation audit: play a chip's enter fade once, then strip the marker (mirrors the
  // finale/flashRow pattern). Reduced-motion is CSS-gated (animation:none); the setTimeout belt
  // clears the class there since animationend never fires.
  function _animateEnter(node) {
    try {
      node.classList.add("ors-chip-enter");
      const clear = () => node.classList.remove("ors-chip-enter");
      node.addEventListener("animationend", clear, { once: true });
      setTimeout(clear, 1000);
    } catch (_) {}
  }

  // ctx: { room, present, roster, roles, asleep } — or null/incomplete to collapse the strip.
  function render(ctx) {
    const notice = ensureNotice();
    if (!notice) return;
    if (!ctx || !ctx.room || !Array.isArray(ctx.present)) {
      _chipState = new Map();
      if (notice.isShown()) notice.hide(); // pre-game / no room ⇒ fully unmounted, never a hollow card
      return;
    }

    const { chips, next } = _diffPresence(_chipState, ctx.present);
    _chipState = next;
    if (!chips.length) {
      // ORW-246 (Ryne, phone playtest: "not accurate or always present"): the strip stays during play. An empty room reads "Just you here" instead of unmounting the whole strip, so a lone player
      // still gets the same ground ("nobody is with me") and the strip never blinks out between rooms.
      ensureCss();
      const aloneBody = notice.ensure();
      if (notice.el) {
        const head = notice.el.querySelector(".on-head");
        if (head) head.style.display = "none";
        notice.el.setAttribute("aria-label", "Who's in the room with you");
      }
      if (aloneBody) {
        let alone = aloneBody.querySelector(".ors-alone");
        if (!alone) {
          aloneBody.innerHTML = "";
          alone = document.createElement("div");
          alone.className = "ors-alone";
          alone.textContent = "Just you here";
          aloneBody.appendChild(alone);
        }
      }
      return;
    }

    const rosterById = new Map();
    (ctx.roster || []).forEach((h) => { if (h && h.id != null) rosterById.set(h.id, h); });
    const asleepIds = new Set();
    (ctx.asleep || []).forEach((p) => {
      if (!p) return;
      if (p.id != null) asleepIds.add(p.id);
      if (p.name) asleepIds.add(p.name);
    });

    ensureCss();
    const body = notice.ensure(); // mounts (idempotent) into the shared above-composer zone
    if (notice.el) {
      // Title-less ambient strip (mirrors orwellChatHint.js): no heading row, just the chips.
      const head = notice.el.querySelector(".on-head");
      if (head) head.style.display = "none";
      if (!notice.el.hasAttribute("aria-label")) {
        notice.el.setAttribute("aria-label", "Who's in the room with you");
      }
    }

    // Keyed chip reconcile (not a fresh `.ors-row` + `body.innerHTML = ""` rebuild every poll): keep
    // a PERSISTENT row and reuse each chip node across polls, so (a) toggling .ors-chip-leaving on the
    // surviving node lets the CSS `transition: opacity .6s` actually fire (the dead leaving-fade the
    // transient-animation audit flagged), and (b) face <img>s are not re-decoded on the 25s poll.
    let row = body.querySelector(".ors-row");
    if (!row) {
      row = document.createElement("div");
      row.className = "ors-row";
      body.innerHTML = "";
      body.appendChild(row);
    }
    const have = new Map();
    Array.prototype.forEach.call(row.children, (node) => {
      const k = node.getAttribute("data-ors-key");
      if (k != null) have.set(k, node);
    });
    const want = new Set();
    let ref = null;
    for (let i = chips.length - 1; i >= 0; i--) {
      const c = chips[i];
      const leaving = c.phase === "leaving";
      const asleep = asleepIds.has(c.person && c.person.id) || asleepIds.has(c.person && c.person.name);
      const sig = _chipSig(c.person, asleep, ctx.roles, rosterById);
      want.add(c.key);
      let chip = have.get(c.key);
      let fresh = false;
      if (!chip || chip.getAttribute("data-ors-sig") !== sig) {
        // brand-new occupant, or a face-affecting change (portrait landed / turned in / role badge):
        // (re)build the chip node — a genuine content change is the one time a face re-decode is right.
        const old = chip;
        fresh = !old;
        chip = buildChip(c.person, asleep, ctx.roles, rosterById);
        chip.setAttribute("data-ors-key", c.key);
        chip.setAttribute("data-ors-sig", sig);
        if (old && old.parentNode) old.parentNode.replaceChild(chip, old);
        have.set(c.key, chip);
      }
      // TOGGLE the leaving state on the PERSISTENT node so the .6s fade interpolates from its current
      // opacity — the whole point of the one-cycle "leaving" grace phase the diff already computes.
      chip.classList.toggle("ors-chip-leaving", leaving);
      chip.title = titleFor(c.person, { asleep: asleep, leaving: leaving });
      if (fresh && !leaving) _animateEnter(chip); // a brand-new arrival fades in (reduced-motion: instant)
      // place the node directly before `ref` (its correct next sibling): insert a freshly-built chip
      // (not yet a child) OR move one out of position; a correctly-placed reused chip is left alone.
      // `before`/`append` (never insertBefore-on-the-composer-bar; anti-fragmentation gate).
      if (chip.parentNode !== row || chip.nextSibling !== ref) { if (ref) ref.before(chip); else row.append(chip); }
      ref = chip;
    }
    // occupants no longer in the diff (their leaving grace cycle has ended) drop out
    have.forEach((node, k) => { if (!want.has(k)) node.remove(); });
  }

  async function tick() {
    const mySeq = ++_tickSeq;
    const superseded = () => mySeq !== _tickSeq; // ORW-151: a newer tick started; never repaint stale data
    try {
      if (document.hidden) return; // a hidden tab polls nothing (C18)
      const state = await getJSON("/api/orwell/state");
      if (superseded()) return;
      if (!state || !state.started) { render(null); _failures = 0; return; }
      const whereData = await getJSON("/api/orwell/whereabouts");
      if (superseded()) return;
      const w = whereData ? whereData.whereabouts : null;
      if (!w || !w.room) { render(null); _failures = 0; return; }

      // Portraits + role badges are enhancements over the bare NamedRef chips — a failure on
      // either never blanks the strip (it just falls back to designed monograms/no badge).
      // ORW-246: the roster + status reads are independent of each other, so run them TOGETHER (they used to queue one behind the other, so a slow status read held the whole strip a few seconds behind the engine).
      let roster = [];
      let roles = {};
      await Promise.all([
        getJSON("/api/orwell/roster").then((d) => { roster = (d && Array.isArray(d.roster)) ? d.roster : []; }).catch(() => { /* fall back to monograms */ }),
        getJSON("/api/orwell/status").then((statusData) => { roles = (window.OrwellMonogram && statusData) ? window.OrwellMonogram.rolesFrom(statusData) : {}; }).catch(() => { /* fall back to no role badges */ }),
      ]);

      if (superseded()) return;
      render({ room: w.room, present: w.present, roster: roster, roles: roles, asleep: state.asleep });
      _failures = 0;
    } catch (_) {
      if (superseded()) return;
      _failures += 1;
      if (window.OrwellReport) window.OrwellReport.fail("roomstrip", "poll", _); // G11: fail open, never silent
      // ORW-246: a failed poll (a blip, a 409, a slow engine) KEEPS the last-known strip instead of blanking it - stale for one cycle beats gone. Only a never-shown strip stays absent.
    } finally {
      if (timer) { clearTimeout(timer); timer = null; }
      // In WS mode the `state`/`hud` push (via orwell:gamechanged → refreshNow) supersedes the
      // periodic poll — don't re-arm the timer, just stay edge-triggered.
      if (!_wsActive()) timer = setTimeout(tick, _pollDelay());
    }
  }

  // An immediate refresh that resets the poll cadence — driven by the shared game-changed signal.
  function refreshNow() {
    _failures = 0;
    tick();
  }

  ready(() => {
    // Only under the game build (the reduced surface) — the full workspace skips the strip.
    if (document.body && document.body.dataset.gameBuild !== "1") return;
    tick();
    // LISTEN only — the one shared debounced dispatcher lives in platform.js (g15). This module
    // never dispatches `orwell:gamechanged` itself.
    window.addEventListener("orwell:gamechanged", refreshNow);
    // WS Phase-1 (§4/§6): cancel the periodic poll the instant the socket goes live;
    // resume polling if it falls back to SSE. refreshNow re-arms the timer via tick()
    // (which only re-schedules while !_wsActive()).
    window.addEventListener("orwell:ws-active", () => { if (timer) { clearTimeout(timer); timer = null; } });
    window.addEventListener("orwell:ws-inactive", refreshNow);
    window.addEventListener("beforeunload", () => timer && clearTimeout(timer));
  });
})();
