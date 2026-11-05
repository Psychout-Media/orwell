"""#1638 KM-W10 (batch B) — a backdrop tap with a session-row kit menu open must
dismiss ONLY the menu, never the sidebar.

Runtime race regression guard. The session-row action menu is now an
OrwellMenuKit surface (`.ow-popover`, body-appended). Its outside-click
dismissal (`escMenuStack.bindMenuDismiss`) runs in the click CAPTURE phase, so
on a mobile backdrop tap it detaches the `.ow-popover` BEFORE the sidebar's
bubble-phase backdrop handler runs — a live `document.querySelector('.ow-popover')`
there is already null and loses the race. sidebar-layout.js snapshots the
popover-open state at `pointerdown` (before the click) and, on the first
backdrop tap, dismisses the menu and stops the tap from reaching the sibling
document-level outside-click handler (which keys on `e.target` = the backdrop and
would otherwise close the sidebar). A SECOND tap (nothing open) closes the sidebar.

Harness mirrors test_a8_mobile_window_kit.py: a tiny static server over the REAL
`frontend/static/js/` tree drives the REAL OrwellMenuKit + the REAL
sidebar-layout.js handlers over Playwright at a mobile viewport. Roles only; no
names. Vault-free (chrome only).
"""

import functools
import http.server
import os
import socketserver
import threading

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static")

_PORT = int(os.environ.get("ORWELL_1638_BACKDROP_PORT", "8799"))

MOBILE_VIEWPORT = {"width": 375, "height": 812}


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


# The harness wires the REAL kit + the REAL sidebar-layout init so the real
# pointerdown snapshot + backdrop handler + document outside-click handler all
# run. A full-viewport #sidebar-backdrop (styled here) makes the backdrop a real
# hit target; the sidebar occupies the left rail so a right-side tap lands on the
# backdrop, clear of the sidebar and the (top-left-anchored) menu.
_HARNESS = """
<!doctype html><html><head><meta charset="utf-8">
<style>
  #sidebar { position: fixed; left: 0; top: 0; width: 240px; height: 100%; background: #222; }
  #sidebar.hidden { display: none; }
  #sidebar-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.3); display: none; z-index: 5; }
  #sidebar-backdrop.visible { display: block; }
</style></head>
<body data-game-build="1">
  <div id="icon-rail"></div>
  <button id="hamburger-btn"></button>
  <div id="chat-container"></div>
  <button id="chat-new-btn"></button>
  <button id="incognito-btn"></button>
  <button id="sidebar-brand-btn"></button>
  <button id="sidebar-new-chat-btn"></button>
  <button id="sidebar-toggle-btn"></button>
  <div id="sidebar"><button id="anchor">menu</button></div>
  <script type="module">
    import '/js/orwellMenu.js';
    import { initSidebarLayout } from '/js/sidebar-layout.js';
    const Storage = { get: () => null, set: () => {}, KEYS: { SIDEBAR_SIDE: 'sidebar-side' } };
    const opts = {
      documentModule: {}, _closeCompareIfActive: () => {}, _deactivateIncognito: () => {},
      presetsModule: {}, sessionModule: {}, el: (id) => document.getElementById(id),
      _defaultChat: {}, _syncResearchIndicator: () => {},
    };
    try { initSidebarLayout(Storage, opts); window.__initOk = true; }
    catch (e) { window.__initErr = String(e); }
  </script>
</body></html>
"""

# Open the sidebar + backdrop, then open a REAL session-row-style kit menu
# anchored inside the sidebar (danger row included, mirroring the session menu).
_OPEN_MENU_JS = """
() => {
  const sb = document.getElementById('sidebar');
  sb.classList.remove('hidden');
  const bd = document.getElementById('sidebar-backdrop');
  bd.classList.add('visible');
  window.OrwellMenuKit.open({
    anchor: document.getElementById('anchor'), align: 'start', ariaLabel: 'Session actions',
    items: [
      { label: 'Rename', onSelect: () => {} },
      { label: 'Delete', danger: true, onSelect: () => {} },
    ],
  });
  return {
    menuOpen: !!document.querySelector('.ow-popover[role="menu"]'),
    sidebarHidden: sb.classList.contains('hidden'),
    backdropVisible: bd.classList.contains('visible'),
  };
}
"""

_STATE_JS = """
() => ({
  menuOpen: !!document.querySelector('.ow-popover'),
  sidebarHidden: document.getElementById('sidebar').classList.contains('hidden'),
})
"""


def test_backdrop_tap_dismisses_only_the_menu_then_closes_sidebar(_static_server):
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    if _chromium_path() is None:
        pytest.skip("chromium unavailable")
    base = _static_server
    with sync_playwright() as pw:
        exe = _chromium_path()
        browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
        page = browser.new_page(viewport=MOBILE_VIEWPORT)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            page.goto(base + "/__h", wait_until="domcontentloaded")
            page.set_content(_HARNESS)
            page.wait_for_function("() => window.__initOk || window.__initErr", timeout=10000)
            init = page.evaluate("() => ({ ok: window.__initOk || false, err: window.__initErr || null })")
            assert init["ok"] and not init["err"], f"sidebar-layout init failed: {init['err']}"
            # narrow viewport actually engages the mobile paths.
            assert page.evaluate("() => window.matchMedia('(max-width: 768px)').matches"), \
                "the 375px viewport must register as narrow"

            opened = page.evaluate(_OPEN_MENU_JS)
            assert opened["menuOpen"], "the kit session-row menu did not open"
            assert not opened["sidebarHidden"] and opened["backdropVisible"], \
                "precondition: sidebar open + backdrop visible"

            # FIRST backdrop tap (clear of the sidebar + the top-left menu): dismisses ONLY
            # the menu — the sidebar must STAY open (the race the pointerdown snapshot fixes).
            page.mouse.click(350, 780)
            after1 = page.evaluate(_STATE_JS)
            assert not after1["menuOpen"], "the first backdrop tap must dismiss the kit menu"
            assert not after1["sidebarHidden"], (
                "the first backdrop tap must NOT close the sidebar while a kit menu was open — "
                "the pointerdown snapshot + stopPropagation must keep it open (both the backdrop "
                "handler AND the sibling document outside-click handler)"
            )

            # SECOND backdrop tap (nothing open): now closes the sidebar.
            page.mouse.click(350, 780)
            after2 = page.evaluate(_STATE_JS)
            assert after2["sidebarHidden"], "the second backdrop tap (no menu open) must close the sidebar"
        finally:
            browser.close()
    assert not errs, f"no page errors during the backdrop interaction ({errs})"
