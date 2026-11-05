// Orwell "Where you are" gadget (feature 0049 / C28 / L26+L14) — the AMBIENT ground for
// lingering play.
//
// Renders the engine's Vault-free whereabouts() — the player's room + who's with them, and the
// VISIBLE adjacent rooms (the engine only ever returns the player's room + rooms one step away,
// so this is fog-of-war by construction). It AUGMENTS the chat and never replaces it
// (ADR 0003 §4/§7): no click-to-move, no button that starts a scene or advances the game — the
// player still mills, asks "who's here?", and talks in PROSE; the engine grounds the narration.
//
//   • GET /api/orwell/state        → gate on an active game (started)
//   • GET /api/orwell/whereabouts  → { whereabouts: { room, present[], nearby[{room, present[]}] } } | null
//
// L26 redesign:
//   HEADER = the room you're in + who's with you, FIRST NAMES — "Kitchen — Keith, John, Joe"
//            (or "Kitchen — alone" when no one is present).
//   BODY   = the VISIBLE nearby rooms from your perspective — each room that HAS people, with its
//            houseguests' first names — "Living Room: Mary, Sam". Empty/out-of-view rooms are
//            omitted entirely; "No one nearby." when nothing adjacent has anyone.
//
// L14 (subsumed): FIRST names only, disambiguated as "First L." when two distinct people across
// the WHOLE current view share a first name (so the same person reads consistently everywhere).
// See _displayNames — the single name-formatting helper (node-unit-tested in
// test_l26_whereabouts.py).
//
// Fail-open everywhere: no gadget on empty/error/pre-game.
(function () {
  "use strict";

  const POLL_MS = 25000;
  const ID = "orwell-presence";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let timer = null;
  let _failures = 0;
  let _lastAnnounced = null; // A11Y-1: last SR-announced header line, to announce only on change
  function _pollDelay() { return Math.min(POLL_MS * Math.pow(2, _failures), 120000); }

  // WS Phase-1 (§4): when the multiplexed socket is live, the server PUSHES a `hud`
  // frame the instant whereabouts change; platform.js relays it to the one
  // `orwell:gamechanged` dispatcher, which fires refreshNow() below. So we cancel the
  // 25s periodic TIMER in WS mode and stay edge-triggered (fail-soft: any doubt ⇒
  // keep polling). The fallback/SSE path is unchanged and still polls.
  function _wsActive() {
    try { return !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive()); }
    catch (_) { return false; }
  }

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function roomLabel(room) {
    // "living-room" → "Living Room" (the engine's ids are kebab-case room names).
    // A lone trailing letter is a room identifier, not a word ("bedroom-b"), so it
    // must read "Bedroom B", not "Bedroom b" — title case otherwise.
    const s = String(room || "").replace(/-/g, " ").trim();
    if (!s) return s;
    return s
      .split(" ")
      .map((w) =>
        w.length === 1
          ? w.toUpperCase()
          : w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  // ── the single name-formatting helper (L14, unit-tested) ───────────────────
  // Given the WHOLE current whereabouts view (the present list plus every nearby room's present
  // list), format a person's display name as a FIRST name only — disambiguating any first name
  // shared by 2+ DISTINCT people anywhere in the view as "First L." (the last name's initial),
  // so the same person reads consistently everywhere. Self-contained — only String/Array/Map
  // primitives — so a node harness can extract and exercise it directly.
  //
  //   people: array of { id?, name } from every visible list (present + all nearby).
  //   returns: { format(person) → string }.
  function _displayNames(people) {
    const list = Array.isArray(people) ? people : [];
    const firstOf = (full) => String(full || "").trim().split(/\s+/)[0] || "";
    const initialOf = (full) => {
      const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
      return parts.length > 1 ? parts[parts.length - 1].charAt(0).toUpperCase() : "";
    };
    // identity key: prefer a stable id; else the full name (so one person listed in two rooms
    // is counted ONCE, while two same-named strangers with no id are still two people).
    const idOf = (p) =>
      (p && p.id != null && p.id !== "" ? "id:" + p.id : "nm:" + String((p && p.name) || ""));

    // Count DISTINCT people per first name across the whole view.
    const peopleByFirst = new Map();   // first → Set<identity key>
    for (const p of list) {
      const f = firstOf(p && p.name);
      if (!f) continue;
      if (!peopleByFirst.has(f)) peopleByFirst.set(f, new Set());
      peopleByFirst.get(f).add(idOf(p));
    }

    function format(p) {
      const f = firstOf(p && p.name);
      if (!f) return String((p && p.name) || "").trim();
      const distinct = peopleByFirst.get(f);
      if (distinct && distinct.size > 1) {
        const init = initialOf(p && p.name);
        return init ? f + " " + init : f;  // no last name to split on ⇒ bare first name
      }
      return f;
    }
    return { format };
  }

  // A51: one qualitative chip per in-room houseguest from the engine's closed tell word (flag ORWELL_NPC_TELLS; absent => unchanged). Words only: no band, number or cause; the caller passes only `w.present` (never nearby/tracked). Pure, node-testable.
  function _joinWithTells(list, format) {
    const TELL_LABEL = { withdrawn: "withdrawn", tearful: "close to tears", snapping: "on edge", "brittle-calm": "too calm", giddy: "giddy", "warm-open": "relaxed", guarded: "guarded", restless: "restless" };
    return (list || []).map((p) => {
      const n = format(p);
      const lab = p && typeof p.tell === "string" && Object.prototype.hasOwnProperty.call(TELL_LABEL, p.tell) ? TELL_LABEL[p.tell] : "";
      return n && lab ? n + " (" + lab + ")" : n;
    }).filter(Boolean).join(", ");
  }

  // Flatten every visible person (present + all nearby + tracked beliefs) into one list — the dedup
  // scope, so a tracked houseguest reads with the same first-name disambiguation as everyone on screen.
  function _allPeople(w) {
    const out = [];
    ((w && w.present) || []).forEach((p) => out.push(p));
    ((w && w.nearby) || []).forEach((n) => ((n && n.present) || []).forEach((p) => out.push(p)));
    ((w && w.tracked) || []).forEach((t) => out.push(t)); // 0077: tracked beliefs share the dedup scope
    return out;
  }

  // #640: compose the OrwellGadget kit (the .og-* card chrome + the rail mount + content-driven
  // visibility). The kit's static TITLE is "Where You Are" (the registry label); the dynamic
  // "Room — who's with you" line + the nearby rooms render in the card BODY. Only this gadget's
  // own inner CSS (the room/quiet treatment) stays here.
  let _gadget = null;
  function ensureEl() {
    let el = document.getElementById(ID);
    if (el) return el;
    if (!document.getElementById("orwell-presence-css")) {
      const st = document.createElement("style");
      st.id = "orwell-presence-css";
      st.textContent = `
        #orwell-presence .opres-here {
          color: color-mix(in srgb, var(--fg, #9cdef2) 78%, var(--panel, #111));
          margin: 0 0 .3rem; font-weight: 600; letter-spacing: .03em;
          overflow-wrap: anywhere;
        }
        #orwell-presence .opres-nearby { overflow-wrap: anywhere; }
        #orwell-presence .opres-room { display: block; }
        #orwell-presence .opres-room .opres-r {
          color: color-mix(in srgb, var(--fg, #9cdef2) 70%, var(--panel, #111));
        }
        #orwell-presence .opres-quiet { opacity: .6; font-style: italic; }
        #orwell-presence .opres-tracked { display: block; margin-top: .3rem; opacity: .82; overflow-wrap: anywhere; }
        #orwell-presence .opres-conspicuous {
          display: block; margin-top: .3rem; font-style: italic; overflow-wrap: anywhere;
          color: color-mix(in srgb, var(--accent, #e0b341) 80%, var(--fg, #9cdef2));
        }`;
      document.head.appendChild(st);
    }
    // 0054: prefer the control-room gadget rail (under the status HUD when present).
    _gadget = window.OrwellGadgetKit.create({ id: ID, title: "Where You Are", icon: "🧭", ariaLabel: "Where you are" });
    const body = _gadget.ensure("orwell-status");
    // A11Y-1: do NOT make the card root a live region — re-writing head/body every 25s poll would
    // re-announce the unchanged room to a screen reader 2-3x/min. A dedicated hidden child gets only
    // the CHANGED header string (the #os-announce delta pattern from orwellStatusPanel).
    body.innerHTML = `<div class="opres-here" data-role="head"></div>` +
      `<div class="opres-nearby" data-role="body"></div>` +
      `<span data-role="announce" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);"></span>`;
    return _gadget.el;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function render(w) {
    const el = ensureEl();
    if (!w || !w.room) { _gadget.hide(); _lastAnnounced = null; return; }
    el.dataset.room = w.room;

    // One dedup scope across the whole visible view (present + every nearby room).
    const names = _displayNames(_allPeople(w));
    const join = (list) => (list || []).map((p) => names.format(p)).filter(Boolean).join(", ");

    const joinWithTells = (list) => _joinWithTells(list, (p) => names.format(p));

    // HEADER: the room you're in (+ your corner of a big room, 0077) + who's with you — or "alone".
    const present = Array.isArray(w.present) ? w.present : [];
    const here = present.length ? joinWithTells(present) : "alone";
    const roomName = roomLabel(w.room) + (w.zone ? " · " + String(w.zone).replace(/-/g, " ") : "");
    const headLine = roomName + " — " + here;
    // TRANS-26: guard the write — the head text was wholesale-replaced on EVERY ~25s poll even
    // when nothing changed, a pure DOM-churn/flicker-risk mutation under concurrent updates.
    const headEl = el.querySelector("[data-role='head']");
    if (headEl && headEl.textContent !== headLine) headEl.textContent = headLine;
    // A11Y-1: announce ONLY when the line actually changed (not on every poll).
    if (headLine !== _lastAnnounced) {
      const ann = el.querySelector("[data-role='announce']");
      if (ann) ann.textContent = headLine;
      _lastAnnounced = headLine;
    }

    // BODY: the VISIBLE nearby rooms that HAVE people, each with first names; then the 0077 layers.
    const rooms = (Array.isArray(w.nearby) ? w.nearby : [])
      .filter((n) => n && n.present && n.present.length);
    const body = el.querySelector("[data-role='body']");
    const parts = [];
    if (!rooms.length) {
      // FLOW-9/VM-18/CA-18: the header lists who's in YOUR room; this body line is scoped to the
      // ADJACENT rooms. The old "No one nearby." read as a flat contradiction directly beneath a
      // populated room roster ("15 people here / no one nearby"). Name the scope so the two lines
      // read as different questions (who's with you vs. who's in the next rooms).
      parts.push('<span class="opres-quiet">The nearby rooms are quiet.</span>');
    } else {
      parts.push(rooms
        .map((n) =>
          '<span class="opres-room"><span class="opres-r">' + esc(roomLabel(n.room)) +
          ':</span> ' + esc(join(n.present)) + "</span>")
        .join(""));
    }
    // 0077 TRACKED: who you watched slip behind a closed door — a BELIEF, flagged when it's gone stale.
    // Fog-of-war by construction: the engine only sends houseguests the player actually witnessed go in.
    const tracked = (Array.isArray(w.tracked) ? w.tracked : []).filter((t) => t && t.name && t.room);
    if (tracked.length) {
      parts.push('<span class="opres-tracked"><span class="opres-r">Seen heading off:</span> ' +
        tracked.map((t) =>
          esc(names.format(t)) + " → " + esc(roomLabel(t.room)) + (t.stale ? " (a while ago)" : ""))
          .join(", ") + "</span>");
    }
    // 0077 CONSPICUOUSNESS: "two alone too long" — already Vault-free player-facing prose from the engine.
    const conspic = (Array.isArray(w.conspicuous) ? w.conspicuous : []).filter(Boolean);
    if (conspic.length) {
      parts.push(conspic
        .map((c) => '<span class="opres-conspicuous">' + esc(c) + "</span>")
        .join(""));
    }
    // TRANS-26: same guard for the nearby-rooms body — a full node-swap on every poll regardless
    // of whether presence actually changed (desktop-18-streaming.dom.json: `opres-here`/
    // `opres-nearby` both `+1 -1` mid-stream). A cheap string compare skips the identical rebuild.
    const html = parts.join("");
    if (body.innerHTML !== html) body.innerHTML = html;
    _gadget.show();
  }

  async function tick() {
    try {
      if (document.hidden) return; // a hidden tab polls nothing (C18)
      const state = await getJSON("/api/orwell/state");
      if (!state || !state.started) { render(null); return; }
      const data = await getJSON("/api/orwell/whereabouts");
      render(data ? data.whereabouts : null);
      _failures = 0;
    } catch (_) {
      _failures += 1;
      if (window.OrwellReport) window.OrwellReport.fail("presence", "whereabouts-poll", _); // G11: fail open, never silent
      render(null); // fail OPEN: the gadget simply isn't there
    } finally {
      if (timer) { clearTimeout(timer); timer = null; }
      // In WS mode the `hud` push (via orwell:gamechanged → refreshNow) supersedes the
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
    // Only under the game build (the reduced surface) — the full workspace skips the gadget.
    if (document.body && document.body.dataset.gameBuild !== "1") return;
    tick();
    // Refresh on the shared game-changed signal (platform.js dispatches it after every
    // engine-mutating turn — AND on every WS `hud` push, §4) so the room/co-presence
    // updates the moment the player moves.
    window.addEventListener("orwell:gamechanged", refreshNow);
    // WS Phase-1 (§4/§6): cancel the periodic poll the instant the socket goes live;
    // resume polling if it falls back to SSE. refreshNow re-arms the timer via tick()
    // (which only re-schedules while !_wsActive()).
    window.addEventListener("orwell:ws-active", () => { if (timer) { clearTimeout(timer); timer = null; } });
    window.addEventListener("orwell:ws-inactive", refreshNow);
    window.addEventListener("beforeunload", () => timer && clearTimeout(timer));
  });
})();
