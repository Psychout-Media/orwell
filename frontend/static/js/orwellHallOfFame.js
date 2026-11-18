// Orwell Hall of Fame (0208 B3, ORW-665) - the player's finished seasons, readable OUTSIDE any game.
//
// A standing sidebar entry (shown in every phase, unlike the in-game Memory Wall) opens a kit window listing the seasons the
// engine filed for this user, newest first. Each season is a labelled list: the engine's own fields shown as they are
// (winner and runner-up names, the placement, the player's competition wins, and the best-move / worst-betrayal facts as
// kind + actor + subject). No phrase is composed per case; the headings are existing UI vocabulary.
//
// VAULT-FREE: it renders only what GET /api/orwell/hall-of-fame returns, which the route whitelists server-side (no ids, no
// numbers beyond placement / cast size / the player's own win count). Text goes in through textContent only.
// g15: it never dispatches the game-changed event (the one dispatcher lives in platform.js); the hall changes only when a
// season ends, so it re-reads on open and when a game change is heard while open.
(function () {
  "use strict";

  const BTN_ID = "sidebar-hall-btn";
  const PANEL_ID = "orwell-hall-of-fame";
  const TITLE = "Hall of Fame";

  // The pure model: the view -> [{ title, rows: [[label, value], ...] }], newest season first. No DOM, no I/O.
  function words(s) { return String(s).replace(/-/g, " "); }
  function factText(f) {
    if (!f || typeof f !== "object" || !f.kind) return "";
    return [words(f.kind), f.actor, f.subject].filter((x) => typeof x === "string" && x).join(" · ");
  }
  function model(view) {
    const seasons = (view && Array.isArray(view.seasons)) ? view.seasons.slice() : [];
    seasons.sort((a, b) => (b.season || 0) - (a.season || 0));
    return seasons.map((s) => {
      const rows = [];
      if (s.result) rows.push(["Result", words(s.result)]);
      if (Number.isFinite(s.placement)) rows.push(["Placement", s.castSize ? s.placement + " / " + s.castSize : String(s.placement)]);
      if (s.winnerName) rows.push(["Winner", s.winnerName]);
      if (s.runnerUpName) rows.push(["Runner-up", s.runnerUpName]);
      if (Number.isFinite(s.compWins)) rows.push(["Competition wins", String(s.compWins)]);
      const best = factText(s.bestMove);
      if (best) rows.push(["Best move", best]);
      const worst = factText(s.worstBetrayal);
      if (worst) rows.push(["Worst betrayal", worst]);
      return { title: "Season " + s.season, rows };
    });
  }

  // Build the list into `into` (a node): one <ol> of seasons, each with a heading and a <dl>. Empty -> a plain note.
  function render(view, into, doc) {
    doc = doc || document;
    while (into.firstChild) into.removeChild(into.firstChild);
    const seasons = model(view);
    if (!seasons.length) {
      const p = doc.createElement("p");
      p.className = "ohf-empty";
      p.textContent = "No seasons yet.";
      into.appendChild(p);
      return 0;
    }
    const ol = doc.createElement("ol");
    ol.className = "ohf-list";
    for (const s of seasons) {
      const li = doc.createElement("li");
      li.className = "ohf-season";
      const h = doc.createElement("h3");
      h.className = "ohf-hd";
      h.textContent = s.title;
      const dl = doc.createElement("dl");
      dl.className = "ohf-facts";
      for (const [k, v] of s.rows) {
        const dt = doc.createElement("dt"); dt.textContent = k;
        const dd = doc.createElement("dd"); dd.textContent = v;
        dl.appendChild(dt); dl.appendChild(dd);
      }
      li.appendChild(h); li.appendChild(dl);
      ol.appendChild(li);
    }
    into.appendChild(ol);
    return seasons.length;
  }

  window.OrwellHallOfFame = { model, render };
  if (typeof document === "undefined" || !document.body) return;

  let _win = null;
  let _body = null;

  function ensureCss() {
    if (document.getElementById("orwell-hall-css")) return;
    const st = document.createElement("style");
    st.id = "orwell-hall-css";
    st.textContent =
      "#orwell-hall-of-fame { width: min(380px, 92vw); font-family: var(--ow-ui-font); }" +
      "#orwell-hall-of-fame .ohf-list { list-style: none; margin: 0; padding: 0; }" +
      "#orwell-hall-of-fame .ohf-season { margin: 0 0 .8rem; padding-bottom: .5rem; border-bottom: 1px solid var(--border, #355a66); }" +
      "#orwell-hall-of-fame .ohf-hd { margin: 0 0 .3rem; font-size: .85rem; font-weight: 600; }" +
      "#orwell-hall-of-fame .ohf-facts { display: grid; grid-template-columns: auto 1fr; gap: .15rem .6rem; margin: 0; font-size: .8rem; }" +
      "#orwell-hall-of-fame .ohf-facts dt { opacity: .65; }" +
      "#orwell-hall-of-fame .ohf-facts dd { margin: 0; overflow-wrap: anywhere; }" +
      "#orwell-hall-of-fame .ohf-empty { opacity: .7; font-size: .8rem; margin: .4rem 0; }" +
      "@media (max-width: 768px) { #orwell-hall-of-fame { width: auto !important; max-width: none !important; } }";
    document.head.appendChild(st);
  }

  async function load() {
    try {
      const r = await fetch("/api/orwell/hall-of-fame", { credentials: "same-origin" });
      return r.ok ? await r.json() : { seasons: [] };
    } catch (_) { return { seasons: [] }; }
  }

  async function refresh() {
    if (!_body) return;
    render(await load(), _body);
  }

  function open() {
    if (_win && document.getElementById(PANEL_ID)) { refresh(); return; }
    ensureCss();
    _body = document.createElement("div");
    _win = window.OrwellWindowKit.create({
      id: PANEL_ID, title: TITLE,
      icon: "<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3'/></svg>",
      slot: "top-left", slotKey: "hall-of-fame", role: "complementary",
      minimizable: true, closable: true, draggable: true, dockable: true, defaultDocked: false,
      content: _body,
      onClose: () => { _win = null; _body = null; },
    });
    _win.open(document.getElementById(BTN_ID) || undefined);
    refresh();
  }

  function ensureButton() {
    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;
    const anchor = document.getElementById("sidebar-memory-btn") || document.getElementById("sidebar-cast-btn")
      || document.getElementById("sidebar-diary-room-btn") || document.getElementById("sidebar-search-btn")
      || document.getElementById("sidebar-new-chat-btn");
    if (!anchor || !anchor.parentElement) return null;
    btn = document.createElement("div");
    btn.className = "list-item";
    btn.id = BTN_ID;
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.title = TITLE;
    btn.setAttribute("aria-label", TITLE);
    // The FIRST child is the svg icon (the rail mirror clones it into the collapsed rail).
    btn.innerHTML = "<svg class='sidebar-action-icon' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3'/></svg><span class='grow'></span>";
    btn.querySelector(".grow").textContent = TITLE;
    btn.addEventListener("click", open);
    btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    anchor.parentElement.insertBefore(btn, anchor.nextSibling);
    return btn;
  }

  window.addEventListener("orwell:gamechanged", () => { if (_win) refresh(); });
  const ready = (fn) => document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn();
  ready(() => {
    if (document.body.dataset.gameBuild !== "1") return; // game-build gated
    ensureButton();
  });
})();
