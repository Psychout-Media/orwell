"""#1638 — the color picker inside a modal: a close-X click closes ONLY the picker.

REGRESSION (Greptile P1). The color picker lives inside the Theme / Settings modals
(their close buttons are `.close-btn` with aria-label "Close …"). Before the kit
migration the bespoke `_onOutside` handler swallowed a close-X click while the picker
was open, so the FIRST click closed only the picker and the modal stayed; a second
click closed the modal. The OrwellPopover kit's capture-phase outside-click dismissal
does NOT stopPropagation, so without a guard the SAME click closes BOTH.

colorPicker.js restores the behavior with a narrow document-capture swallow
(`_swallowModalCloseClick`, stopPropagation but NOT stopImmediatePropagation, added on
open / removed on close). This drives the REAL kit + REAL colorPicker over Playwright
with a real modal whose `.close-btn` has a real bubble-phase close handler, and proves:

  • click the modal close-X while the picker is open → the picker closes, the modal STAYS;
  • a second close-X click → the modal closes (the swallow is gone with the picker);
  • a normal outside click (not a close-btn) still closes the picker;
  • Escape still closes the picker first (through the escMenuStack seat).

Harness mirrors test_893_sheet_browser.py — a tiny static server over the real
frontend/static/js tree (no engine/FE boot). Roles only; Vault-free chrome.
"""

import functools
import http.server
import os
import socketserver
import threading

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static")

VIEWPORT = {"width": 1280, "height": 720}


def _chromium_path():
    from _chromium import chromium_path  # shared locator: sandbox paths, then Playwright's own install dir (CI)
    return chromium_path()


@pytest.fixture(scope="module")
def _static_server():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=STATIC)

    class _Q(socketserver.TCPServer):
        allow_reuse_address = True

    # Bind an EPHEMERAL port (0) to avoid collisions with a parallel/other run.
    httpd = _Q(("127.0.0.1", 0), handler)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        httpd.shutdown()
        httpd.server_close()   # release the listening socket (shutdown() alone leaves it open)


# A modal that mirrors the real Theme/Settings chrome: a `.close-btn` (aria-label
# "Close settings") with a REAL bubble-phase close handler, a colour input the picker
# attaches to, and an unrelated field to test a plain outside click. The close-X sits
# top-left; the colour input sits bottom so the popover flips ABOVE it and can never
# overlap the close-X (so a real click lands on the button, not the popover).
_HARNESS = """
<!doctype html><html><head><meta charset="utf-8"></head>
<body data-game-build="1">
  <div id="test-modal" class="modal-content" role="dialog" style="position:fixed;inset:0;">
    <button class="close-btn" id="modal-close" aria-label="Close settings"
            style="position:fixed;top:8px;left:8px;width:40px;height:40px;">x</button>
    <input type="text" id="outside-field"
           style="position:fixed;top:8px;left:220px;width:120px;">
    <input type="color" id="test-color" value="#336699"
           style="position:fixed;bottom:40px;left:560px;">
  </div>
  <!-- An UNRELATED modal (does NOT enclose the colour input): its close-btn must
       NOT be swallowed by the picker's scoped guard. -->
  <div id="other-modal" class="modal-content" role="dialog" style="position:fixed;top:8px;left:420px;">
    <button class="close-btn" id="other-close" aria-label="Close other"
            style="width:40px;height:40px;">x</button>
  </div>
  <script type="module">
    import '/js/orwellMenu.js';
    import { attachColorPicker } from '/js/colorPicker.js';
    import { dismissTopMenu } from '/js/escMenuStack.js';
    // Mimic the ui.js Escape arbiter: Escape drains the top menu FIRST.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dismissTopMenu()) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    // REAL modal close handlers (bubble phase, like the app's close buttons).
    window.__modalClosed = false;
    document.getElementById('modal-close').addEventListener('click', () => {
      window.__modalClosed = true;
      document.getElementById('test-modal').classList.add('hidden');
    });
    window.__otherClosed = false;
    document.getElementById('other-close').addEventListener('click', () => {
      window.__otherClosed = true;
      document.getElementById('other-modal').classList.add('hidden');
    });
    attachColorPicker(document.getElementById('test-color'));
    window.__ready = true;
  </script>
</body></html>
"""

_STATE_JS = """
() => ({
  pickerOpen: !!document.querySelector('.ow-popover'),
  hasHsv: !!document.querySelector('.ow-popover .cp-sl'),
  modalClosed: window.__modalClosed === true,
  modalHidden: document.getElementById('test-modal').classList.contains('hidden'),
  otherClosed: window.__otherClosed === true,
})
"""


def _require_browser():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")


def _new_page(pw):
    exe = _chromium_path()
    browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
    page = browser.new_page(viewport=VIEWPORT)
    return browser, page


def _load(page, base):
    page.goto(base + "/__h", wait_until="domcontentloaded")
    page.set_content(_HARNESS)
    page.wait_for_function("() => window.__ready === true && !!window.OrwellPopoverKit", timeout=10000)


def _open_picker(page):
    page.click("#test-color")
    page.wait_for_timeout(60)


def test_close_x_closes_only_the_picker_then_the_modal(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, _static_server)
            _open_picker(page)
            opened = page.evaluate(_STATE_JS)
            # FIRST close-X click: the picker closes, the modal stays open.
            page.click("#modal-close")
            page.wait_for_timeout(60)
            after_first = page.evaluate(_STATE_JS)
            # SECOND close-X click: now the modal closes (swallow gone with the picker).
            page.click("#modal-close")
            page.wait_for_timeout(60)
            after_second = page.evaluate(_STATE_JS)
        finally:
            browser.close()
    assert not errs, f"no page errors ({errs})"
    assert opened["pickerOpen"] and opened["hasHsv"], "the picker must open on the colour input"
    # the crux: one close-X click closes the picker but NOT the modal.
    assert not after_first["pickerOpen"], "the close-X click must close the picker"
    assert not after_first["modalClosed"], "the close-X click must NOT close the modal (only the picker)"
    assert not after_first["modalHidden"], "the modal must stay visible after the first close-X click"
    # the second click reaches the modal and closes it.
    assert after_second["modalClosed"], "a second close-X click must close the modal"
    assert after_second["modalHidden"]


def test_plain_outside_click_still_closes_the_picker(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, _static_server)
            _open_picker(page)
            assert page.evaluate(_STATE_JS)["pickerOpen"]
            # a click on an unrelated field (not a close-btn) closes the picker via the kit.
            page.click("#outside-field")
            page.wait_for_timeout(60)
            after = page.evaluate(_STATE_JS)
        finally:
            browser.close()
    assert not errs, f"no page errors ({errs})"
    assert not after["pickerOpen"], "a normal outside click must still close the picker"
    assert not after["modalClosed"], "an outside click on a non-close field must not close the modal"


def test_unrelated_modal_close_btn_is_not_swallowed(_static_server):
    """The swallow is scoped to the picker's ENCLOSING modal only. Clicking a
    DIFFERENT modal's close-X while the picker is open must NOT be swallowed — that
    modal closes normally (and, being an outside click, the picker dismisses too)."""
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, _static_server)
            _open_picker(page)
            assert page.evaluate(_STATE_JS)["pickerOpen"]
            page.click("#other-close")
            page.wait_for_timeout(60)
            after = page.evaluate(_STATE_JS)
        finally:
            browser.close()
    assert not errs, f"no page errors ({errs})"
    assert after["otherClosed"], "an UNRELATED modal's close-X must NOT be swallowed — it closes normally"
    assert not after["modalClosed"], "the picker's own modal is untouched"
    assert not after["pickerOpen"], "the outside click still dismisses the picker via the kit"


def test_escape_closes_the_picker(_static_server):
    _require_browser()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, _static_server)
            _open_picker(page)
            assert page.evaluate(_STATE_JS)["pickerOpen"]
            page.keyboard.press("Escape")
            page.wait_for_timeout(60)
            after = page.evaluate(_STATE_JS)
        finally:
            browser.close()
    assert not errs, f"no page errors ({errs})"
    assert not after["pickerOpen"], "Escape must close the picker (via the escMenuStack seat)"
    assert not after["modalClosed"], "Escape closes the picker first, not the modal"
