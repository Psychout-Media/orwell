// ORW-359 — the full-size photo viewer. Kevin 2026-11-14: "I should be able to open just the photo
// bigger without having to right click, open image in new tab."
//
// One singleton modal dialog composed from the OrwellWindow kit (F-3 ratchet: new windows MUST):
// opening another houseguest retargets it. The kit owns close (its button), Escape (ui.js's single
// arbiter), the modal scrim/inert/focus-trap, and focus-return to the opener — this module adds NO
// Escape or backdrop handler of its own.
//
// Vault-free: the only inputs are the public roster card (name / status / portrait URL) from the
// shared OrwellMonogram cache — the same fields every cast surface renders.
//   window.OrwellPortraitViewer.open(houseguestId, openerEl[, {name, portrait, status}])
(function () {
  "use strict";

  const WIN_ID = "orwell-portrait-viewer";
  let _win = null;

  function cardFor(id) {
    const M = window.OrwellMonogram;
    return M && typeof M.cardFor === "function" ? M.cardFor(id) : null;
  }

  function ensureWindow() {
    if (_win) return _win;
    const content = document.createElement("div");
    content.innerHTML =
      "<style>" +
      "#" + WIN_ID + " { width: auto; max-width: 96vw; }" +
      "#" + WIN_ID + " .opv-body { display: flex; justify-content: center; }" +
      // The kit caps .ow-body at min(70dvh, 560px) and scrolls past it; the viewer lifts that cap and
      // sizes a SQUARE image to fit the viewport, so the whole photo is visible (object-fit: contain).
      // ORW-437: the window is created with sheet:false (below), so this override never meets the phone sheet's scroll containment.
      "#" + WIN_ID + " .ow-body { max-height: none; overflow: visible; }" +
      "#" + WIN_ID + " .opv-img { display: block; aspect-ratio: 1 / 1; height: auto;" +
      "  width: min(92vw, 1024px, calc(100dvh - 190px)); max-width: 100%; max-height: none;" +
      "  object-fit: contain; border-radius: 10px; }" +
      "#" + WIN_ID + " .opv-img.opv-evicted { filter: grayscale(1); }" +
      "</style>" +
      '<div class="opv-body"><img class="opv-img" id="opv-img" alt=""></div>';
    _win = window.OrwellWindowKit.create({
      id: WIN_ID, title: "Photo", role: "dialog", modal: true, slot: "top-center",
      persistLayout: false, sheet: false, minimizable: false, dockable: false, resizable: false,
      draggable: false, closable: true, focus: true, content,
      onClose: () => { _win = null; },
    });
    return _win;
  }

  /** Open (or retarget) the viewer on `houseguestId`'s portrait. No portrait -> nothing to enlarge. */
  function open(houseguestId, opener, known) {
    // `known` (optional): the caller's own public card {name, portrait, status} — a surface that
    // just rendered the photo passes it so the viewer shows exactly that URL even while the shared
    // roster cache is cold. Otherwise the shared cache answers.
    const card = (known && known.portrait) ? known : cardFor(houseguestId);
    if (!card || !card.portrait) return false;
    const w = ensureWindow();
    w.open(opener);
    if (opener) w.opener = opener; // ORW-437: a retarget of the open viewer must return focus to the LATEST opener
    const el = document.getElementById(WIN_ID);
    if (!el) return false;
    const name = card.name || "Houseguest";
    const t = el.querySelector(".ow-title");
    if (t) t.textContent = name;
    const img = el.querySelector("#opv-img");
    img.alt = name;
    img.classList.toggle("opv-evicted", card.status === "evicted");
    // ORW-437: a stale or broken portrait URL must not leave a modal holding a broken image: close the viewer.
    img.onerror = () => { img.onerror = null; try { w.close(); } catch (_) { /* already closed */ } };
    img.src = card.portrait;
    if (w.raise) w.raise();
    return true;
  }

  window.OrwellPortraitViewer = { open };
})();
