// Orwell deals surface (feature 0039 — the player's tracked promises) — SIDEBAR CHROME, a
// self-contained, fail-open sibling to orwellSocial.js / orwellStatusPanel.js.
//
// Big Brother is promises kept and broken. The engine already projects the player's OWN deals,
// Vault-free, on the game-state route (GameStateView.deals — DealLedger.forParty(PLAYER)): the
// FACT and status only (parties, kind, terms, open|kept|broken), NEVER a relationship number and
// NEVER an NPC-to-NPC deal (those stay sealed in the Vault). That projection had no consumer — the
// player could promise someone the world in chat but had nowhere to GLANCE at what they were on
// the hook for. This is that glance, and nothing more: a read-only tracker.
//
//   • GET the game-state route → { started, deals: [{ id, parties[], kind, terms, status }] }
//
// AUGMENTS the chat, never replaces it (ADR 0003): deals are still STRUCK in conversation (the
// GM's make-a-deal lever); this panel only reflects the ledger the engine keeps. Content-driven
// (it shows nothing when the player holds no deals — no empty box), game-build gated, fail-open.

(function () {
  "use strict";

  const POLL_MS = 20000;
  const ID = "orwell-deals";
  const ready = (fn) =>
    document.readyState === "loading"
      ? document.addEventListener("DOMContentLoaded", fn, { once: true })
      : fn();

  let timer = null;
  let _failures = 0;
  let _shown = false; // kept a real game's panel up through a transient hiccup (U5)
  function _pollDelay() { return Math.min(POLL_MS * Math.pow(2, _failures), 120000); }

  // WS Phase-1 (§4): when the multiplexed socket is live the server PUSHES a `state` frame on
  // every board change; platform.js relays it to the one `orwell:gamechanged` dispatcher, which
  // triggers an edge refresh below. So we cancel the 20s periodic TIMER in WS mode and stay
  // edge-triggered (fail-soft: any doubt ⇒ keep polling). The fallback/SSE path still polls.
  function _wsActive() {
    try { return !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive()); }
    catch (_) { return false; }
  }

  // The engine's deal kinds (src/ports/GameSession.ts MakeDealReq.kind) → player-facing label.
  // No number, no lean — just what KIND of promise it is.
  // SG-12: "target-other" is a ONE-WAY spare-the-partner promise (`src/domain/deal.ts`
  // `conditionFor("target-other")` — no commitment to target anyone jointly). "Shared target"
  // read as a promise of joint offense the mechanics can't represent; "Protection pact" names
  // what the deal actually is.
  const KIND_LABEL = {
    "safety": "Safety",
    "vote": "Vote",
    "final-two": "Final 2",
    "target-other": "Protection pact",
    "comp-throw": "Comp throw",
    "veto-save": "Veto save",
    "protect-third": "Third-party pact",
    "conditional": "If-on-the-block pact",
    "information": "Keep-me-posted pact",
    "package": "Package deal",
  };
  // The status carries the whole drama: a promise still live, one honored, one betrayed.
  // F-NEW-12: each status carries a non-color GLYPH alongside its label, so open-vs-kept
  // is distinguished by shape (not the green-vs-blue border alone) for protan/deutan + SR
  // users (WCAG 1.4.1 / 4.1.3). The glyph is decorative-redundant to the text label.
  const STATUS_META = {
    open:   { cls: "odl-open",   tag: "active",  glyph: "•", hint: "Still standing" },
    kept:   { cls: "odl-kept",   tag: "kept",    glyph: "✓", hint: "Honored" },
    broken: { cls: "odl-broken", tag: "broken",  glyph: "✕", hint: "Broken" },
  };

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function hidePanel() {
    const el = document.getElementById(ID);
    if (el) el.style.display = "none";
  }

  // #640: compose the OrwellGadget kit (the .og-* card chrome + the rail mount + content-driven
  // visibility). The card shell + header ("🤝 Your Deals") are the kit's; only this gadget's own
  // inner CSS (the deal-row treatment) stays here. Display is CONTENT-DRIVEN by render().
  let _gadget = null;
  function ensureSection() {
    let el = document.getElementById(ID);
    if (el) return el;
    if (!document.getElementById("orwell-deals-css")) {
      const st = document.createElement("style");
      st.id = "orwell-deals-css";
      st.textContent = `
        #orwell-deals .odl-row {
          display: flex; align-items: flex-start; gap: .4rem; margin: .3rem 0;
          background: rgba(255,255,255,.05); border: 1px solid var(--border, #355a66);
          border-radius: 8px; padding: .3rem .45rem;
          border-left: 3px solid var(--border, #355a66);
        }
        /* the status drives the left accent rail — no number leaks, just kept / open / broken */
        #orwell-deals .odl-open   { border-left-color: color-mix(in srgb, #4caf50 70%, var(--border, #355a66)); }
        #orwell-deals .odl-kept   { border-left-color: color-mix(in srgb, #2196f3 70%, var(--border, #355a66)); opacity: .85; }
        #orwell-deals .odl-broken { border-left-color: color-mix(in srgb, #e0564a 75%, var(--border, #355a66)); opacity: .7; }
        #orwell-deals .odl-body { flex: 1; min-width: 0; }
        #orwell-deals .odl-who { color: var(--fg, #9cdef2); font-weight: 600; }
        #orwell-deals .odl-kind {
          font-size: var(--fs-2xs); opacity: .7; text-transform: uppercase; letter-spacing: .04em;
        }
        #orwell-deals .odl-terms {
          opacity: .82; margin-top: .1rem; white-space: normal; overflow-wrap: anywhere;
        }
        #orwell-deals .odl-tag {
          flex: 0 0 auto; font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: .05em;
          opacity: .65; padding-top: .1rem;
        }
        #orwell-deals .odl-broken .odl-terms { text-decoration: line-through; }
        /* #725: on the LIGHT glass the var(--border) stroke resolves to a HARD dark line.
           Apple defines glass by lensing, not a hard stroke — soften the row outline + its
           neutral left rail to a low-opacity WHITE hairline (the status accents keep their hue). */
        body.theme-frosted #orwell-deals .odl-row {
          border-color: rgba(255,255,255,0.14);
          border-left-color: rgba(255,255,255,0.14);
        }`;
      document.head.appendChild(st);
    }
    // Mount into the control-room gadget rail (0054), under the status panel (anchor).
    _gadget = window.OrwellGadgetKit.create({ id: ID, title: "Your Deals", icon: "🤝", ariaLabel: "Your deals" });
    const body = _gadget.ensure("orwell-status");
    body.innerHTML = `<div id="odl-list"></div>`;
    return _gadget.el;
  }

  // Build an id → name map from the SAME /state payload the deals ride on (state.player +
  // state.house, both public NamedRef-shaped). Audit CA-9/IA-11/INT-4/FLOW-8: a deal party whose
  // own `name` wasn't populated at write time rendered as the generic "A houseguest" for EVERY row,
  // making the whole tracker useless. The roster is already in-hand here, so resolve the party id
  // against it before falling back — no extra fetch, no Vault data (names are public roster facts).
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

  // GADGET-11: DealView.kind is a looser `string` than the write-side MakeDealReq union
  // (`src/ports/GameSession.ts`), so a legacy/cross-version save or a future kind outside the
  // four known values has no type-system guarantee. Mirror orwellRetrospective.js's own
  // `humanizeStoryType` precedent — never let a raw kebab-case machinery string reach the
  // player-facing "Your Deals" gadget verbatim.
  function humanizeKind(kind) {
    const words = String(kind || "").split(/[-_:/]+/).filter(Boolean);
    if (!words.length) return "Deal";
    return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }

  // The other party (deals are always player + one houseguest); never render the player's own row.
  function otherParty(deal, nameById) {
    const ps = Array.isArray(deal.parties) ? deal.parties : [];
    const them = ps.find((p) => p && p.id !== "player");
    if (them) {
      if (them.name) return them.name;
      // Resolve against the roster carried on the same /state payload before the generic fallback.
      if (nameById && them.id != null && nameById[String(them.id)]) return nameById[String(them.id)];
    }
    return "A houseguest";
  }

  function render(deals, nameById) {
    ensureSection();
    const list = Array.isArray(deals) ? deals : [];
    const wrap = document.getElementById("odl-list");
    wrap.innerHTML = "";
    if (!list.length) { _gadget.hide(); return; } // content-driven: no deals, no box
    // Live promises first, then settled ones (kept/broken) for the record.
    const order = { open: 0, kept: 1, broken: 2 };
    const sorted = list.slice().sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
    for (const d of sorted) {
      const meta = STATUS_META[d.status] || STATUS_META.open;
      const row = document.createElement("div");
      row.className = "odl-row " + meta.cls;
      row.title = meta.hint;
      const body = document.createElement("div");
      body.className = "odl-body";
      const who = document.createElement("span");
      who.className = "odl-who"; who.textContent = otherParty(d, nameById);
      const kind = document.createElement("span");
      kind.className = "odl-kind"; kind.textContent = " · " + (KIND_LABEL[d.kind] || humanizeKind(d.kind));
      const terms = document.createElement("div");
      terms.className = "odl-terms"; terms.textContent = d.terms || "";
      body.appendChild(who); body.appendChild(kind);
      if (d.terms) body.appendChild(terms);
      const tag = document.createElement("span");
      tag.className = "odl-tag"; tag.textContent = (meta.glyph ? meta.glyph + " " : "") + meta.tag;
      row.appendChild(body); row.appendChild(tag);
      wrap.appendChild(row);
    }
    _gadget.show();
  }

  // Test/headless seam: drive the panel without a live engine (mirrors _orwellSocialDrive…).
  window._orwellDealsEnsure = () => { ensureSection(); return true; };
  window._orwellDealsDrive = (deals, st) => { render(deals || [], nameMapFrom(st)); const w = document.getElementById("odl-list"); return w ? w.querySelectorAll(".odl-row").length : 0; };

  async function refresh() {
    let st;
    try {
      st = await getJSON("/api/orwell/state");
    } catch (_) {
      if (window.OrwellReport) window.OrwellReport.fail("deals", "state-poll", _); // G11: fail open, never silent
      _failures += 1;
      if (!_shown) hidePanel(); // only hide if we never had a game up
      return;
    }
    _failures = 0;
    if (!(st && st.started)) { _shown = false; hidePanel(); return; }
    _shown = true;
    render(st.deals, nameMapFrom(st));
  }

  function start() {
    refresh();
    if (timer) clearInterval(timer);
    const tick = async () => {
      if (!document.hidden) await refresh(); // C18: a hidden tab polls nothing
      // In WS mode the `state` push (via orwell:gamechanged) supersedes the poll —
      // don't re-arm the periodic timer, just stay edge-triggered.
      if (!_wsActive()) timer = setTimeout(tick, _pollDelay());
    };
    if (!_wsActive()) timer = setTimeout(tick, _pollDelay());
  }

  window.orwellRefreshDeals = refresh;
  window.addEventListener("orwell:gamechanged", refresh);
  // WS Phase-1 (§4/§6): cancel the periodic poll the instant the socket goes live; resume
  // polling if it falls back to SSE. start() re-arms the timer only while !_wsActive(), so
  // re-running it after a downgrade restores the cadence.
  window.addEventListener("orwell:ws-active", () => { if (timer) { clearTimeout(timer); timer = null; } });
  window.addEventListener("orwell:ws-inactive", () => { _failures = 0; if (timer) { clearTimeout(timer); timer = null; } start(); });
  ready(() => {
    if (document.body && document.body.dataset.gameBuild !== "1") return; // game-build gated
    start();
    window.addEventListener("beforeunload", () => timer && clearTimeout(timer));
  });
})();
