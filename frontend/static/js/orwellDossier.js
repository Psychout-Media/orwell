// Orwell houseguest dossier (feature M4-1 / road-to-market audit C4 + idea 12) — cast tiles were
// dead ends: a portrait told you a name and a status and nothing else. This is the "who is this
// person, and what has actually happened between us" surface: public persona + met/last-seen +
// WITNESSED history beats + public deals/alliances with the player — facts and sources ONLY,
// never a weight/number/hidden edge (the Vault Wall; the player forms their own reads).
//
// Vault-free by construction: the ENTIRE render is driven by ONE fetch,
// `GET /api/orwell/dossier/{id}` (routes/orwell_routes.py `orwell_dossier`), which itself only
// ever returns an explicit field allowlist built from the engine's public projections
// (getGameState + getVisibleStateFor) — see that route's module-level comment for the argument.
// This module never reads any OTHER game-state source, so it cannot introduce a leak on its own.
//
// Composes the OrwellWindow kit (F-3 anti-fragmentation ratchet — new windows MUST). ONE
// singleton window that RE-TARGETS: clicking a different cast tile while the dossier is already
// open just re-fetches and re-renders in place, mirroring the cast window's own singleton
// pattern — no per-houseguest window instances to manage.
//
// The ONE shared open-dossier handler every portrait chip should call (M3-6 will wire every
// remaining chip — the strip, decision cards, slates — to this same entry point later):
//   window.OrwellDossier.open(houseguestId, openerEl)
(function () {
  "use strict";

  const PANEL_ID = "orwell-dossier";

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  function statusLabel(s) {
    if (s === "jury") return "Jury";
    if (s === "evicted") return "Evicted";
    if (s === "winner") return "Winner";
    return "In the house";
  }

  // Persona facet -> a short label. Mirrors the route's `_PERSONA_FIELDS` allowlist order.
  const PERSONA_LABELS = {
    archetype: "Archetype", strategyStyle: "Strategy", vocation: "Vocation",
    hometown: "Hometown", age: "Age", demeanor: "Demeanor", background: "Background",
  };

  const TYPE_LABEL = {
    conversation: "Conversation", competition: "Competition",
    "house-event": "House event", surfacing: "A secret surfaced",
  };
  function typeLabel(t) {
    if (TYPE_LABEL[t]) return TYPE_LABEL[t];
    if (!t) return "Together";
    return String(t).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  }

  const DEAL_KIND_LABEL = {
    safety: "Safety", vote: "Vote", "final-two": "Final 2", "target-other": "Protection pact",
    "comp-throw": "Comp throw", "veto-save": "Veto save", "protect-third": "Third-party pact", "conditional": "If-on-the-block pact", "information": "Keep-me-posted pact",
  };
  const DEAL_STATUS_LABEL = { open: "Still standing", kept: "Honored", broken: "Broken" };

  let _win = null;
  let _targetId = null;   // the houseguest this instance is currently showing
  let _reqSeq = 0;        // guards a slow fetch from clobbering a LATER re-target

  function ensurePanel() {
    let el = document.getElementById(PANEL_ID);
    if (el) return el;
    const content = document.createElement("div");
    content.innerHTML = `
      <style>
        #orwell-dossier { width: min(360px, 92vw); }
        #orwell-dossier .od-head { display: flex; align-items: center; gap: .6rem; margin-bottom: .5rem; }
        #orwell-dossier .od-portrait {
          width: 56px; height: 56px; border-radius: 10px; overflow: hidden; flex: 0 0 auto;
          border: 1px solid var(--border, #355a66); background: rgba(255,255,255,.05);
        }
        #orwell-dossier .od-name { font-weight: 700; font-size: 1rem; color: var(--fg, #9cdef2); }
        #orwell-dossier .od-status { font-size: .72rem; opacity: .68; text-transform: uppercase; letter-spacing: .04em; margin-top: .1rem; }
        #orwell-dossier .od-section { margin-top: .7rem; }
        #orwell-dossier .od-h {
          margin: 0 0 .3rem; font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: .06em;
          opacity: .6; font-weight: 600;
        }
        #orwell-dossier .od-bio { font-size: .82rem; line-height: 1.45; opacity: .9; margin-bottom: .4rem; }
        #orwell-dossier .od-facts { display: flex; flex-wrap: wrap; gap: .3rem .5rem; }
        #orwell-dossier .od-fact {
          font-size: .72rem; background: rgba(255,255,255,.05); border: 1px solid var(--border, #355a66);
          border-radius: 6px; padding: .18rem .45rem;
        }
        #orwell-dossier .od-fact b { opacity: .65; font-weight: 600; margin-right: .25rem; }
        #orwell-dossier .od-empty { font-size: .78rem; opacity: .6; line-height: 1.5; padding: .2rem 0; }
        #orwell-dossier .od-row {
          display: flex; align-items: flex-start; gap: .4rem; margin: .3rem 0;
          background: rgba(255,255,255,.05); border: 1px solid var(--border, #355a66);
          border-radius: 8px; padding: .3rem .45rem; border-left: 3px solid var(--border, #355a66);
        }
        #orwell-dossier .od-row-open   { border-left-color: color-mix(in srgb, #4caf50 70%, var(--border, #355a66)); }
        #orwell-dossier .od-row-kept   { border-left-color: color-mix(in srgb, #2196f3 70%, var(--border, #355a66)); opacity: .85; }
        #orwell-dossier .od-row-broken { border-left-color: color-mix(in srgb, #e0564a 75%, var(--border, #355a66)); opacity: .7; }
        #orwell-dossier .od-row-body { flex: 1; min-width: 0; }
        #orwell-dossier .od-row-kind { font-size: var(--fs-2xs); opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
        #orwell-dossier .od-row-terms { opacity: .85; margin-top: .1rem; font-size: .8rem; }
        #orwell-dossier .od-row-tag { flex: 0 0 auto; font-size: var(--fs-2xs); text-transform: uppercase; letter-spacing: .05em; opacity: .65; }
        #orwell-dossier .od-offline { font-size: .82rem; opacity: .65; padding: .3rem 0; }
        body.theme-frosted #orwell-dossier .od-portrait,
        body.theme-frosted #orwell-dossier .od-fact,
        body.theme-frosted #orwell-dossier .od-row {
          border-color: rgba(255,255,255,0.14);
        }
      </style>
      <div class="od-offline" id="od-offline" style="display:none">The dossier is offline right now.</div>
      <div id="od-content" style="display:none">
        <div class="od-head">
          <div class="od-portrait" id="od-portrait"></div>
          <div>
            <div class="od-name" id="od-name"></div>
            <div class="od-status" id="od-status"></div>
          </div>
        </div>
        <div class="od-section" id="od-bio-section" style="display:none">
          <div class="od-bio" id="od-bio"></div>
        </div>
        <div class="od-section" id="od-facts-section" style="display:none">
          <div class="od-facts" id="od-facts"></div>
        </div>
        <div class="od-section">
          <h4 class="od-h">What you know of each other</h4>
          <div id="od-history-list"></div>
          <div class="od-empty" id="od-history-empty" style="display:none">You haven't crossed paths yet.</div>
        </div>
        <div class="od-section" id="od-deals-section" style="display:none">
          <h4 class="od-h">Deals with you</h4>
          <div id="od-deals-list"></div>
        </div>
        <div class="od-section" id="od-alliances-section" style="display:none">
          <h4 class="od-h">Alliances together</h4>
          <div id="od-alliances-list"></div>
        </div>
      </div>`;
    _win = window.OrwellWindowKit.create({
      id: PANEL_ID, title: "Dossier",
      icon: "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2'><rect x='4' y='3' width='16' height='18' rx='2'/><line x1='8' y1='8' x2='16' y2='8'/><line x1='8' y1='12' x2='16' y2='12'/><line x1='8' y1='16' x2='12' y2='16'/></svg>",
      slot: "top-right", slotKey: "dossier", role: "complementary",
      minimizable: true, closable: true, draggable: true, resizable: true,
      content,
      onClose: () => { _win = null; _targetId = null; },
    });
    return document.getElementById(PANEL_ID);
  }

  function setTitle(name) {
    const el = document.getElementById(PANEL_ID);
    const t = el && el.querySelector(".ow-title");
    if (t) t.textContent = name ? name : "Dossier";
  }

  function renderFacts(persona) {
    const wrap = document.getElementById("od-facts-section");
    const list = document.getElementById("od-facts");
    list.textContent = "";
    const entries = Object.keys(PERSONA_LABELS)
      .filter((k) => k !== "background" && persona && persona[k] != null && persona[k] !== "")
      .map((k) => [PERSONA_LABELS[k], persona[k]]);
    if (persona && persona.background && !persona.biography) {
      entries.push(["Background", persona.background]);
    }
    if (!entries.length) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    for (const [label, value] of entries) {
      const chip = document.createElement("span");
      chip.className = "od-fact";
      const b = document.createElement("b");
      b.textContent = label + ":";
      chip.appendChild(b);
      chip.appendChild(document.createTextNode(String(value)));
      list.appendChild(chip);
    }
  }

  function renderBio(persona) {
    const wrap = document.getElementById("od-bio-section");
    const bio = document.getElementById("od-bio");
    if (persona && persona.biography) {
      bio.textContent = persona.biography;
      wrap.style.display = "";
    } else {
      wrap.style.display = "none";
    }
  }

  function renderHistory(history) {
    const list = document.getElementById("od-history-list");
    const empty = document.getElementById("od-history-empty");
    list.textContent = "";
    if (!Array.isArray(history) || !history.length) {
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";
    history.forEach((beat, i) => {
      const label = typeLabel(beat && beat.type);
      const source = i === 0 ? "Most recent · " + label : label;
      list.appendChild(window.OrwellFactLine.row({ text: (beat && beat.content) || "", source }));
    });
  }

  function renderDeals(deals) {
    const wrap = document.getElementById("od-deals-section");
    const list = document.getElementById("od-deals-list");
    list.textContent = "";
    if (!Array.isArray(deals) || !deals.length) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    for (const d of deals) {
      const row = document.createElement("div");
      row.className = "od-row od-row-" + (d.status || "open");
      const body = document.createElement("div");
      body.className = "od-row-body";
      const kind = document.createElement("div");
      kind.className = "od-row-kind";
      kind.textContent = DEAL_KIND_LABEL[d.kind] || d.kind || "Deal";
      const terms = document.createElement("div");
      terms.className = "od-row-terms";
      terms.textContent = d.terms || "";
      body.appendChild(kind); body.appendChild(terms);
      const tag = document.createElement("div");
      tag.className = "od-row-tag";
      tag.textContent = DEAL_STATUS_LABEL[d.status] || d.status || "";
      row.appendChild(body); row.appendChild(tag);
      list.appendChild(row);
    }
  }

  function renderAlliances(alliances) {
    const wrap = document.getElementById("od-alliances-section");
    const list = document.getElementById("od-alliances-list");
    list.textContent = "";
    if (!Array.isArray(alliances) || !alliances.length) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    for (const a of alliances) {
      const row = document.createElement("div");
      row.className = "od-row od-row-open";
      const body = document.createElement("div");
      body.className = "od-row-body";
      const kind = document.createElement("div");
      kind.className = "od-row-kind";
      kind.textContent = a.name || "Named alliance";
      const terms = document.createElement("div");
      terms.className = "od-row-terms";
      const members = (a.members || []).map((m) => m && m.name).filter(Boolean).join(", ");
      terms.textContent = members ? "With " + members : "";
      body.appendChild(kind); body.appendChild(terms);
      const tag = document.createElement("div");
      tag.className = "od-row-tag";
      tag.textContent = a.youAreFounder ? "You founded" : "Member";
      row.appendChild(body); row.appendChild(tag);
      list.appendChild(row);
    }
  }

  function render(data) {
    const el = ensurePanel();
    const offline = el.querySelector("#od-offline");
    const content = el.querySelector("#od-content");
    if (!data || !data.found) {
      offline.style.display = "";
      offline.textContent = "The dossier is offline right now.";
      content.style.display = "none";
      setTitle(null);
      return;
    }
    offline.style.display = "none";
    content.style.display = "";
    setTitle(data.name);
    el.querySelector("#od-name").textContent = data.name || "";
    el.querySelector("#od-status").textContent = data.isPlayer
      ? "You" : statusLabel(data.status);
    const portraitHolder = el.querySelector("#od-portrait");
    portraitHolder.textContent = "";
    if (window.OrwellMonogram) {
      portraitHolder.appendChild(window.OrwellMonogram.face({
        id: data.id, name: data.name, status: data.status, portrait: data.portrait,
      }));
    }
    renderBio(data.persona || {});
    renderFacts(data.persona || {});
    renderHistory(data.history);
    renderDeals(data.deals);
    renderAlliances(data.alliances);
  }

  async function refresh() {
    if (!_targetId) return;
    const seq = ++_reqSeq;
    // Non-blocking: the window shows its last-good content (or the initial empty shell) with
    // the kit's own "· refreshing" sliver while the fetch is in flight — never a manual flash.
    if (_win && _win.setLoading) _win.setLoading(true);
    try {
      const data = await getJSON("/api/orwell/dossier/" + encodeURIComponent(_targetId));
      if (seq !== _reqSeq || _targetId == null) return; // superseded by a later open() / closed meanwhile
      render(data);
    } catch (e) {
      if (window.OrwellReport) window.OrwellReport.fail("dossier", "fetch", e); // fail open, never silent
      if (seq !== _reqSeq || _targetId == null) return;
      render(null);
    } finally {
      if (_win && _win.setLoading) _win.setLoading(false);
    }
  }

  /** The ONE shared open-dossier handler. `houseguestId` is the roster/roster-card id
   *  (the same id every portrait chip already carries); `opener` is the triggering element
   *  (for focus-return on close — any focusable node, or omit). Re-targets the SAME window
   *  instance when already open, so clicking a different tile never stacks windows. */
  function open(houseguestId, opener) {
    if (!houseguestId) return;
    ensurePanel();
    // Mount/show the window FIRST — render() reads its DOM, which exists only once the kit
    // has actually opened it (create() alone just constructs the instance; open() builds +
    // appends the element, or restores it if already mounted).
    if (_win) { _win.open(opener); _win.raise(); }
    _targetId = String(houseguestId);
    refresh(); // the kit's own non-blocking loading sliver covers the fetch — no manual flash
  }

  window.OrwellDossier = { open };

  // Kept fresh across game-mutating turns exactly like the other rail/window surfaces. No
  // standing chrome to boot on load — the window opens only on demand via open() above.
  window.addEventListener("orwell:gamechanged", () => { if (_targetId) refresh(); });
})();
