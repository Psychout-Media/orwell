// ORW-359 — tap a name or a face in the chat transcript to open that houseguest's cast card
// (the dossier, window.OrwellDossier.open). Kevin 2026-11-14: "I should be able to click on the
// person's name in the message ... and it just pulls up a bigger version of their photo/cast card."
//
// Two halves, both render-only and Vault-free (public roster card fields only):
//  1. ONE delegated click + keydown (Enter/Space) listener on #chat-history — no per-element
//     handlers. It opens the dossier for any element carrying data-hg="<roster id>": the speaker
//     chip + .ow-speaker-name (markdown.js), a resolved <strong>, a plain-text name link, and the
//     sender face (orwellChatFaces.js).
//  2. A post-render pass (MutationObserver on #chat-history — the same seam pattern as
//     orwellChatFaces.js) that (a) marks every <strong> whose text resolves to a roster name and
//     (b) wraps each roster full name, and each first name that is UNIQUE in the cast, found in
//     the prose of a SETTLED row in <span class="ow-name-link" data-hg="id" role="button"
//     tabindex="0">. Case-sensitive, whole words; a trailing 's stays outside the span. It skips
//     code, pre, links, buttons, form controls, the role label and a still-streaming reply. It
//     never edits the text itself (only wraps it), and unwraps+re-wraps a row whose roster
//     changed, so a re-render never duplicates spans.
// Names that do not resolve stay plain text. NON-GAME build: hard-gated on body[data-game-build].
(function () {
  "use strict";

  function gameBuild() {
    return !!(document.body && document.body.hasAttribute("data-game-build"));
  }

  function ensureCss() {
    if (document.getElementById("ow-chatnames-css")) return;
    const s = document.createElement("style");
    s.id = "ow-chatnames-css";
    // No layout shift: the link is an inline span/strong with no padding or border. Underline on
    // hover/focus only; a visible keyboard focus ring (the kit's focus blue).
    s.textContent =
      "body[data-game-build] #chat-history [data-hg] { cursor: pointer; }" +
      "body[data-game-build] #chat-history .ow-name-link { text-decoration: none; }" +
      "body[data-game-build] #chat-history .ow-name-link:hover," +
      "body[data-game-build] #chat-history .ow-name-link:focus-visible {" +
      "  text-decoration: underline; text-underline-offset: 2px; }" +
      "body[data-game-build] #chat-history [data-hg]:focus-visible {" +
      "  outline: 2px solid var(--ow-ios-blue, #0a84ff); outline-offset: 2px; border-radius: 4px; }";
    document.head.appendChild(s);
  }

  // ── the delegated opener ────────────────────────────────────────────────────────────────
  function targetOf(ev) {
    const box = document.getElementById("chat-history");
    const t = ev.target && ev.target.closest ? ev.target.closest("[data-hg]") : null;
    return t && box && box.contains(t) ? t : null;
  }
  function openFor(el) {
    const id = el.getAttribute("data-hg");
    if (!id || !window.OrwellDossier || typeof window.OrwellDossier.open !== "function") return false;
    window.OrwellDossier.open(id, el);
    return true;
  }
  function onClick(ev) {
    if (!gameBuild()) return;
    const el = targetOf(ev);
    if (!el) return;
    // A drag-select that ends on a name is a selection, not a tap.
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed && String(sel).length > 0) return;
    } catch (_) { /* fall through */ }
    openFor(el);
  }
  function onKeydown(ev) {
    if (!gameBuild()) return;
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const el = targetOf(ev);
    if (!el || el.getAttribute("role") !== "button" || ev.target !== el) return;
    ev.preventDefault();
    openFor(el);
  }

  // ── the name pattern (rebuilt only when the roster changes) ─────────────────────────────
  let _key = "";
  let _rx = null;
  let _idByText = null;

  function cards() {
    const M = window.OrwellMonogram;
    return M && typeof M.allCards === "function" ? M.allCards() : [];
  }
  function escRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function rebuild() {
    const list = cards().filter((c) => c && c.id != null && c.name && String(c.name).trim());
    const key = list.map((c) => c.id + "=" + c.name).sort().join("|");
    if (key === _key) return false;
    _key = key;
    const map = new Map();
    const fullNames = new Set(list.map((c) => String(c.name).trim()));
    const firstCount = new Map();
    for (const c of list) {
      const full = String(c.name).trim();
      map.set(full, String(c.id));
      const parts = full.split(/\s+/);
      if (parts.length > 1) firstCount.set(parts[0], (firstCount.get(parts[0]) || 0) + 1);
    }
    for (const c of list) {
      const parts = String(c.name).trim().split(/\s+/);
      const f = parts[0];
      if (parts.length > 1 && f.length > 1 && firstCount.get(f) === 1 && !fullNames.has(f)) {
        map.set(f, String(c.id));
      }
    }
    _idByText = map;
    const names = Array.from(map.keys()).sort((a, b) => b.length - a.length).map(escRx);
    _rx = names.length
      ? new RegExp("(?<![\\p{L}\\p{N}_])(" + names.join("|") + ")(?![\\p{L}\\p{N}_])", "gu")
      : null;
    return true;
  }

  // ── wrapping one settled row ────────────────────────────────────────────────────────────
  const SKIP = "code, pre, a, button, input, textarea, select, script, style, svg, .role, " +
    ".ow-speaker-chip, .ow-name-link, strong[data-hg], [contenteditable], [data-hg]";

  function unwrapAuto(row) {
    row.querySelectorAll("span.ow-name-link[data-ow-auto]").forEach((sp) => {
      sp.replaceWith(document.createTextNode(sp.textContent));
    });
    row.normalize();
  }

  function markStrongs(row) {
    row.querySelectorAll("strong").forEach((st) => {
      if (st.closest(".role, code, pre, a, button")) return;
      if (st.hasAttribute("data-hg")) {
        // markdown.js already carried the id (speaker name) — just make it operable.
        if (!st.hasAttribute("tabindex")) {
          st.classList.add("ow-name-link", "tap-exempt"); st.setAttribute("role", "button"); st.tabIndex = 0;
        }
        return;
      }
      const raw = (st.textContent || "").trim().replace(/[:.,;!?]+$/, "");
      if (!raw || raw.length > 60) return;
      let id = null;
      try {
        id = typeof window.orwellResolveHouseguestId === "function"
          ? window.orwellResolveHouseguestId(raw) : null;
      } catch (_) { id = null; }
      if (!id) return;
      st.setAttribute("data-hg", String(id));
      // ORW-359: a name inside a sentence is an inline target (WCAG 2.5.5/2.5.8 inline exception): `tap-exempt`
      // keeps the 44px touch floor (responsive matrix) for real controls and off running text.
      st.classList.add("ow-name-link", "tap-exempt");
      st.setAttribute("role", "button");
      st.tabIndex = 0;
    });
  }

  function wrapText(row) {
    if (!_rx) return;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue || n.nodeValue.length < 2) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (const node of nodes) {
      const text = node.nodeValue;
      _rx.lastIndex = 0;
      let m, last = 0, frag = null;
      while ((m = _rx.exec(text))) {
        const id = _idByText.get(m[1]);
        if (!id) continue;
        if (!frag) frag = document.createDocumentFragment();
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const sp = document.createElement("span");
        sp.className = "ow-name-link tap-exempt";
        sp.setAttribute("data-hg", id);
        sp.setAttribute("data-ow-auto", "1");
        sp.setAttribute("role", "button");
        sp.tabIndex = 0;
        sp.textContent = m[1];
        frag.appendChild(sp);
        last = m.index + m[1].length;
      }
      if (frag) {
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.replaceWith(frag);
      }
    }
  }

  let _observer = null;

  function process(row) {
    if (!row || row.nodeType !== 1 || !row.classList.contains("msg")) return;
    // SOUL lesson 2: never fight the live stream — only a settled row is touched.
    if (row.classList.contains("streaming")) return;
    // ORW-437: with no roster yet there is nothing to link; leave the row UNMARKED so the resweep that follows the roster
    // arriving (`orwell:rostercache`) processes it, instead of marking it clean against an empty key.
    if (!_rx) return;
    if (row.dataset.owNames === _key) return;
    ensureCss();
    unwrapAuto(row);
    markStrongs(row);
    wrapText(row);
    row.dataset.owNames = _key;
  }

  // ── scheduling (one microtask pass per mutation burst; our own writes are discarded) ────
  const _pending = new Set();
  let _queued = false;
  function schedule(row) {
    if (!row) return;
    _pending.add(row);
    if (_queued) return;
    _queued = true;
    queueMicrotask(() => {
      _queued = false;
      if (!gameBuild()) { _pending.clear(); return; }
      rebuild();
      const batch = Array.from(_pending);
      _pending.clear();
      for (const r of batch) {
        try { process(r); } catch (_) { /* fail open, row by row */ }
      }
      if (_observer) _observer.takeRecords(); // our own wraps are not re-renders
    });
  }

  function rowOf(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    const row = el && el.closest ? el.closest("#chat-history > .msg") : null;
    return row;
  }

  function onMutations(records) {
    if (!gameBuild()) return;
    for (const rec of records) {
      if (rec.type === "attributes") {
        const row = rec.target;
        if (row.classList && row.classList.contains("msg")) schedule(row); // streaming -> settled
        continue;
      }
      if (rec.type === "childList" && rec.addedNodes) {
        // ORW-437: a message row appended DIRECTLY to #chat-history has no ancestor row to find; schedule it itself.
        rec.addedNodes.forEach((n) => {
          if (n && n.nodeType === 1 && n.classList && n.classList.contains("msg") && n.parentElement && n.parentElement.id === "chat-history") schedule(n);
        });
      }
      const row = rowOf(rec.target);
      if (!row) continue;
      // The role label (relabel, timestamp, sender face) holds no prose we wrap.
      const tEl = rec.target.nodeType === 1 ? rec.target : rec.target.parentElement;
      if (tEl && tEl.closest && tEl.closest(".role")) continue;
      // The row's content changed under us (a re-render, a relabel, a stream chunk): the old
      // marker no longer describes it.
      delete row.dataset.owNames;
      schedule(row);
    }
  }

  function sweep() {
    if (!gameBuild()) return;
    const box = document.getElementById("chat-history");
    if (!box) return;
    box.querySelectorAll(":scope > .msg").forEach(schedule);
  }

  function boot() {
    const box = document.getElementById("chat-history");
    if (!box) return;
    box.addEventListener("click", onClick);
    box.addEventListener("keydown", onKeydown);
    try {
      _observer = new MutationObserver(onMutations);
      _observer.observe(box, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ["class"],
      });
    } catch (_) { /* sweep-only */ }
    sweep();
    setTimeout(sweep, 1600);
    setTimeout(sweep, 4500);
  }

  function resweepSoon() { sweep(); setTimeout(sweep, 1200); }
  window.addEventListener("orwell:gamechanged", resweepSoon);
  window.addEventListener("orwell:rostercache", sweep); // ORW-437: the roster cache just (re)filled: link the rows that waited for it

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  window.OrwellChatNames = { refresh: sweep };
})();
