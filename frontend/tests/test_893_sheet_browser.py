"""#893 — the OrwellWindow SHEET presentation mode, proven live at a phone viewport.

Companion to test_893_sheet_presentation.py (the source pins). This drives the REAL
kit (`orwellWindow.js` + `orwellSlots.js`) over Playwright at a phone viewport and
proves the behavior the issue asks for:

  • a modal kit window MOUNTS as a bottom sheet on the phone tier (bottom-pinned,
    edge-to-edge, grabber, medium detent) — and stays a floating window on desktop;
  • a non-modal window keeps the existing narrow slot-sheet host UNLESS it opts in
    with `sheet:true` (the Cast recipe);
  • detent DRAG: grabber drag up → the full detent; a deep drag down → dismiss;
  • the window kit's modal semantics ride along unchanged (aria-modal, scrim,
    focus lands inside, Tab is trapped);
  • the safe-area + scroll-containment rules are in the injected kit CSS.

Harness: mirrors test_a8_mobile_window_kit.py — a tiny static server over the real
`frontend/static/js/` tree (no engine/FE boot). Roles only; no names. Vault-free.
"""

import functools
import http.server
import os
import socketserver
import threading

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static")

_PORT = int(os.environ.get("ORWELL_893_PORT", "8798"))

PHONE = {"width": 390, "height": 844}
DESKTOP = {"width": 1280, "height": 800}


def _chromium_path():
    from _chromium import chromium_path  # shared locator: sandbox paths, then Playwright's own install dir (CI)
    return chromium_path()


@pytest.fixture(scope="module")
def _static_server():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=STATIC)

    class _Q(socketserver.TCPServer):
        allow_reuse_address = True

    httpd = _Q(("127.0.0.1", _PORT), handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{_PORT}"
    finally:
        httpd.shutdown()


_HARNESS = """
<!doctype html><html><head><meta charset="utf-8">
</head><body data-game-build="1">
  <div id="sidebar"></div>
  <script type="module">
    import '/js/orwellSlots.js';
    import { OrwellWindow } from '/js/orwellWindow.js';
    window.__OrwellWindow = OrwellWindow;
  </script>
</body></html>
"""

# Open a kit window the way the real consumers do. Content carries two buttons so
# the focus-trap assertion has tab stops, and enough text to need body scrolling.
_OPEN_JS = """
({ id, title, modal, sheet, scrim, closable }) => {
    const opts = { id, title, closable: closable !== false };
    if (modal) opts.modal = true;
    if (sheet !== undefined) opts.sheet = sheet;
    if (scrim) opts.scrim = true;
    const c = document.createElement('div');
    c.innerHTML = '<button id="' + id + '-b1">one</button>'
      + '<p>' + 'role text '.repeat(400) + '</p>'
      + '<button id="' + id + '-b2">two</button>';
    opts.content = c;
    const w = window.OrwellWindowKit.create(opts);
    w.open();
    window.__wins = window.__wins || {};
    window.__wins[id] = w;
}
"""

# Measured AFTER the entrance animation settles (rects include a live transform,
# so a mid-slide measurement would read the sheet below the viewport).
_MEASURE_JS = """
(id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    return {
      classes: el.className,
      detent: el.dataset.owDetent || null,
      left: r.left, right: r.right, top: r.top, bottom: r.bottom,
      width: r.width, height: r.height,
      vw: window.innerWidth, vh: window.innerHeight,
      ariaModal: el.getAttribute('aria-modal'),
      hasGrabber: !!el.querySelector(':scope > .ow-grabber'),
      hasScrim: !!document.querySelector('.ow-scrim[data-ow-scrim="' + id + '"]'),
      focusInside: el.contains(document.activeElement),
    };
}
"""


def _open_and_measure(page, opts):
    page.evaluate(_OPEN_JS, opts)
    page.wait_for_timeout(450)   # let the slide-up entrance finish (~360ms)
    return page.evaluate(_MEASURE_JS, opts["id"])


def _new_page(pw, viewport):
    exe = _chromium_path()
    browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
    page = browser.new_page(viewport=viewport)
    return browser, page


def _load(page, base):
    page.goto(base + "/__h", wait_until="domcontentloaded")
    page.set_content(_HARNESS)
    page.wait_for_function("() => !!window.OrwellWindowKit && !!window.OrwellSlots", timeout=10000)


def _require_browser():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    if _chromium_path() is None:
        pytest.skip("chromium unavailable")


def test_modal_window_mounts_as_bottom_sheet_on_phone(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, PHONE)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, _static_server)
            box = _open_and_measure(page, {"id": "sheet-modal", "title": "Modal dialog",
                                           "modal": True, "sheet": None, "closable": True})
        finally:
            browser.close()
    assert not errs, f"no page errors ({errs})"
    assert "ow-sheet-mode" in box["classes"], "modal window must present as a sheet on the phone tier"
    assert box["detent"] == "medium", "sheets open at the medium detent"
    # bottom-pinned + edge-to-edge (safe-area env() resolves to 0 in headless chromium).
    assert abs(box["bottom"] - box["vh"]) <= 2, f"sheet must pin to the bottom edge (bottom={box['bottom']}, vh={box['vh']})"
    assert box["left"] <= 1 and box["right"] >= box["vw"] - 1, "sheet must span edge-to-edge"
    assert box["height"] < box["vh"] * 0.75, "the medium detent leaves the page visible above"
    assert box["hasGrabber"], "the sheet carries the grabber pill"
    # the window kit's modal semantics ride along unchanged.
    assert box["ariaModal"] == "true"
    assert box["hasScrim"], "the kit's modal scrim still mounts"
    assert box["focusInside"], "focus lands inside the dialog (J1-25 unchanged)"


def test_modal_window_stays_floating_on_desktop(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, DESKTOP)
        try:
            _load(page, _static_server)
            box = _open_and_measure(page, {"id": "sheet-desk", "title": "Modal dialog",
                                           "modal": True, "sheet": None, "closable": True})
        finally:
            browser.close()
    assert "ow-sheet-mode" not in box["classes"], "desktop keeps the floating window"
    assert not box["hasGrabber"]
    assert box["detent"] is None


def test_non_modal_defaults_to_slot_host_and_opts_in_with_sheet_true(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, PHONE)
        try:
            _load(page, _static_server)
            hud = _open_and_measure(page, {"id": "hud-panel", "title": "HUD panel",
                                           "modal": False, "sheet": None, "closable": True})
            cast = _open_and_measure(page, {"id": "cast-like", "title": "Roster",
                                            "modal": False, "sheet": True, "closable": True})
        finally:
            browser.close()
    # the disciplined default: a non-modal HUD panel stays on the slot engine's
    # existing narrow sheet host (top-stacked) — no silent blast radius.
    assert "ow-sheet-mode" not in hud["classes"]
    # the Cast recipe: sheet:true presents a non-modal window as a bottom sheet
    # (no scrim, no aria-modal — the window's semantics are preserved).
    assert "ow-sheet-mode" in cast["classes"]
    assert abs(cast["bottom"] - cast["vh"]) <= 2
    assert cast["ariaModal"] is None
    assert not cast["hasScrim"]


def _grabber_center(page, win_id):
    return page.evaluate(
        """(id) => {
            const g = document.querySelector('#' + id + ' > .ow-grabber');
            const r = g.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + Math.min(20, r.height / 2) };
        }""", win_id)


def _drag(page, frm, dy, steps=12):
    page.mouse.move(frm["x"], frm["y"])
    page.mouse.down()
    for i in range(1, steps + 1):
        page.mouse.move(frm["x"], frm["y"] + dy * i / steps)
    page.mouse.up()


def test_detent_drag_up_expands_to_full_and_drag_down_dismisses(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, PHONE)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, _static_server)
            box = _open_and_measure(page, {"id": "sheet-drag", "title": "Draggy",
                                           "modal": True, "sheet": None, "closable": True})
            h_medium = box["height"]
            # drag the grabber UP well past halfway toward full → snaps to full.
            g = _grabber_center(page, "sheet-drag")
            _drag(page, g, dy=-(box["vh"] - h_medium) * 0.7)
            page.wait_for_timeout(450)   # settle glide (~300ms) + slack
            after_up = page.evaluate(
                """() => {
                    const el = document.getElementById('sheet-drag');
                    const r = el.getBoundingClientRect();
                    return { detent: el.dataset.owDetent, height: r.height,
                             inlineHeight: el.style.height, vh: window.innerHeight };
                }""")
            # deep drag DOWN from full → past the medium dismiss floor → dismissed.
            g2 = _grabber_center(page, "sheet-drag")
            _drag(page, g2, dy=after_up["height"] * 0.92)
            page.wait_for_timeout(600)   # exit slide (~260ms) + teardown slack
            gone = page.evaluate("() => !document.getElementById('sheet-drag')")
            scrim_gone = page.evaluate("() => !document.querySelector('.ow-scrim')")
        finally:
            browser.close()
    assert not errs, f"no page errors ({errs})"
    assert after_up["detent"] == "full", f"drag up must snap to the full detent ({after_up})"
    assert after_up["height"] >= after_up["vh"] * 0.9, "full detent fills (nearly) the viewport"
    assert after_up["inlineHeight"] == "", "the detent CLASS owns the resting height (no inline residue)"
    assert gone, "a deep downward drag must dismiss the sheet"
    assert scrim_gone, "the modal scrim tears down with the sheet (no orphan scrim, #925)"


def test_drag_dismiss_is_inert_for_closable_false(_static_server):
    """The casting-box contract: closable:false ⇒ the sheet can re-detent but a deep
    downward drag snaps back instead of dismissing (the in-body exits stay the only
    way out)."""
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, PHONE)
        try:
            _load(page, _static_server)
            box = _open_and_measure(page, {"id": "sheet-nodismiss", "title": "Casting box",
                                           "modal": True, "sheet": None, "closable": False})
            g = _grabber_center(page, "sheet-nodismiss")
            _drag(page, g, dy=box["height"] * 0.92)
            page.wait_for_timeout(450)
            state = page.evaluate(
                """() => {
                    const el = document.getElementById('sheet-nodismiss');
                    return el ? { detent: el.dataset.owDetent,
                                  height: el.getBoundingClientRect().height } : null;
                }""")
        finally:
            browser.close()
    assert state is not None, "closable:false sheet must survive a deep downward drag"
    assert state["detent"] == "medium" and state["height"] > 150, "it snaps back to medium"


def test_focus_is_trapped_inside_a_modal_sheet(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, PHONE)
        try:
            _load(page, _static_server)
            page.evaluate(_OPEN_JS, {"id": "sheet-trap", "title": "Trap",
                                     "modal": True, "sheet": None, "closable": True})
            inside = []
            for _ in range(6):
                page.keyboard.press("Tab")
                inside.append(page.evaluate(
                    "() => document.getElementById('sheet-trap').contains(document.activeElement)"))
        finally:
            browser.close()
    assert all(inside), f"Tab must stay inside the modal sheet (J1-25 trap unchanged): {inside}"


def test_kit_css_carries_safe_area_and_containment(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, PHONE)
        try:
            _load(page, _static_server)
            page.evaluate(_OPEN_JS, {"id": "sheet-css", "title": "CSS probe",
                                     "modal": True, "sheet": None, "closable": True})
            css = page.evaluate("() => document.getElementById('ow-window-css').textContent")
            contain = page.evaluate(
                """() => getComputedStyle(
                       document.querySelector('#sheet-css > .ow-body')).overscrollBehaviorY""")
        finally:
            browser.close()
    assert "env(safe-area-inset-bottom" in css
    assert "env(safe-area-inset-top" in css
    assert contain == "contain", "the sheet body must contain overscroll"


def test_non_modal_sheet_mounts_scrim_only_with_scrim_opt(_static_server):
    """The `scrim` option (kit-core): a NON-modal sheet:true window opts into the sheet's
    dimming backdrop (the shared .ow-scrim) with scrim:true — the scrim mounts, but the
    window STAYS non-modal: no aria-modal promise, and the page behind is NOT inerted (a
    modal would inert it). A plain non-modal sheet (no scrim) mounts NO scrim. The backdrop
    rides one z BELOW the sheet window (so the sheet is never covered by its own dim) and
    tears down cleanly on close (no orphan scrim, #925). Roles only; Vault-free chrome."""
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, PHONE)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, _static_server)
            # a plain non-modal sheet — no scrim opt → no backdrop.
            plain = _open_and_measure(page, {"id": "ns-plain", "title": "Plain sheet",
                                             "modal": False, "sheet": True, "closable": True})
            page.evaluate("() => window.__wins['ns-plain'].close()")
            page.wait_for_timeout(400)
            # the scrim opt-in on a non-modal sheet.
            scrimmed = _open_and_measure(page, {"id": "ns-scrim", "title": "Scrimmed sheet",
                                                "modal": False, "sheet": True, "scrim": True,
                                                "closable": True})
            layering = page.evaluate(
                """() => {
                    const el = document.getElementById('ns-scrim');
                    const scrim = document.querySelector('.ow-scrim[data-ow-scrim="ns-scrim"]');
                    const wz = parseInt(getComputedStyle(el).zIndex, 10);
                    const sz = scrim ? parseInt(getComputedStyle(scrim).zIndex, 10) : null;
                    const sb = document.getElementById('sidebar');
                    const b = scrim ? scrim.getBoundingClientRect() : null;
                    return {
                        winZ: wz, scrimZ: sz,
                        scrimBelowWindow: (sz !== null && sz < wz),
                        scrimCoversViewport: b ? (b.left <= 0 && b.top <= 0
                            && b.right >= window.innerWidth && b.bottom >= window.innerHeight) : false,
                        // a NON-modal scrim'd sheet must NOT inert the page (that is a modal-only act).
                        pageInert: !!(sb && sb.inert === true),
                    };
                }""")
            # close it and confirm the scrim tears down with the window (no orphan).
            page.evaluate("() => window.__wins['ns-scrim'].close()")
            page.wait_for_timeout(500)
            teardown = page.evaluate(
                "() => ({ winGone: !document.getElementById('ns-scrim'),"
                "        scrimGone: !document.querySelector('.ow-scrim[data-ow-scrim=\\'ns-scrim\\']') })")
        finally:
            browser.close()
    assert not errs, f"no page errors ({errs})"
    # a plain non-modal sheet presents as a sheet but mounts NO scrim (unchanged behavior).
    assert "ow-sheet-mode" in plain["classes"], "sheet:true still presents as a bottom sheet"
    assert not plain["hasScrim"], "a plain non-modal sheet (no scrim opt) must mount no backdrop"
    # scrim:true → the backdrop mounts, but the window stays non-modal.
    assert "ow-sheet-mode" in scrimmed["classes"], "scrim:true still presents as a bottom sheet"
    assert scrimmed["hasScrim"], "scrim:true must mount the dimming backdrop for a non-modal sheet"
    assert scrimmed["ariaModal"] is None, "the scrim'd sheet must stay non-modal (no aria-modal)"
    # layering + non-modality: scrim sits UNDER the sheet, spans the viewport, page not inerted.
    assert layering["scrimBelowWindow"], (
        f"the non-modal scrim must ride below the sheet window (winZ={layering['winZ']}, "
        f"scrimZ={layering['scrimZ']}) so the sheet is never covered by its own dim"
    )
    assert layering["scrimCoversViewport"], "the backdrop must span the full viewport"
    assert not layering["pageInert"], "a NON-modal scrim'd sheet must not inert the page (modal-only)"
    # clean teardown — the scrim never outlives its window (#925 orphan-scrim class).
    assert teardown["winGone"], "the sheet tears down on close"
    assert teardown["scrimGone"], "the scrim tears down with the sheet (no orphan backdrop)"
