"""#925 — the OrwellWindow modal scrim must never be left orphaned.

The bug (CI-blocking): the kit's modal backdrop scrim (`<div class="ow-scrim"
data-ow-scrim="<id>">`, mounted in `_mountModalChrome`, removed in `_unmountModalChrome`)
could outlive its window — torn down by a path that bypassed the kit teardown, or a
SAME-ID modal collision desyncing the manager registry. A lingering full-viewport scrim
intercepts ALL pointer events, so the Settings gear and other modals become unclickable.
That is exactly why the converging dismiss+click loops in test_h2b_all_model_pools /
test_h2h3_settings would hit their 30s deadline (the loop can never converge while a
scrim outlives its window).

These are SOURCE pins (cheap, keyword-robust, always run) plus a BROWSER gate (loads the
REAL kit over a tiny static server and proves both the orphan sweep and the same-id
collision guard restore a clickable page). The browser gate skips when chromium isn't
installed — the source pins still hold the contract there.

Roles only; no names. Vault-free (chrome only).
"""

import functools
import http.server
import os
import socketserver
import threading

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static")


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


# ── source pins: the sweep exists and is wired where it guarantees coverage ───


def test_kit_defines_the_orphan_scrim_sweep():
    js = _read("static/js/orwellWindow.js")
    assert "function _sweepOrphanScrims(" in js, "the kit must define the orphaned-scrim sweep"
    body = js[js.index("function _sweepOrphanScrims("):]
    body = body[: body.index("\nfunction ")]
    # It builds the LIVE-scrim set from the modal stack (window connected) and removes the rest —
    # i.e. it only ever drops a scrim whose owning modal is genuinely gone, never a live modal's.
    assert "_modalStack" in body and "isConnected" in body
    assert "data-ow-scrim" in body or ".ow-scrim" in body
    assert ".remove()" in body


def test_sweep_is_called_from_recompute_and_dismiss():
    js = _read("static/js/orwellWindow.js")
    # Inside _recomputeModalStack (every push/pop/raise) …
    recompute = js[js.index("function _recomputeModalStack("):]
    recompute = recompute[: recompute.index("\nconst REDUCED")] if "\nconst REDUCED" in recompute else recompute[:2000]
    assert "_sweepOrphanScrims()" in recompute, "recompute must sweep orphaned scrims"
    # … AND at the top of the Escape/dismissTop path.
    dismiss = js[js.index("export function dismissTop("):]
    dismiss = dismiss[: dismiss.index("\nexport function stackIds")]
    assert "_sweepOrphanScrims()" in dismiss, "dismissTop must sweep orphaned scrims first"


def test_open_guards_against_a_same_id_instance_collision():
    """Two DIFFERENT live instances sharing an id desync the id-keyed registries (modalManager
    and the kit's _byId), so closing one strands the other's window + scrim. open() must destroy
    a prior different-instance owner of the id first."""
    js = _read("static/js/orwellWindow.js")
    open_fn = js[js.index("  open(opener) {"):]
    open_fn = open_fn[: open_fn.index("\n  raise()")]
    assert "_byId.get(this.o.id)" in open_fn
    assert "_prior !== this" in open_fn
    assert "_prior.destroy()" in open_fn


def test_onboarding_reroute_fallback_does_not_strand_a_scrim():
    """The orwell:models-changed re-route's holding-card teardown must not leave a scrim behind:
    the bare `open.remove()` fallback (window node only) now also sweeps the matching scrim."""
    js = _read("static/js/orwellOnboarding.js")
    block = js[js.index("function _reRouteAfterModelConfig("):]
    block = block[: block.index("window.addEventListener")]
    # the preferred path is the kit-routing dismiss; the fallback also drops the scrim.
    assert "_obDismiss" in block
    assert 'data-ow-scrim="orwell-onboarding"' in block


# ── browser gate: the real kit sweeps an orphan and restores a clickable page ──

_PORT = int(os.environ.get("ORWELL_925_PORT", "8796"))


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
<style>#user-bar-settings{position:fixed;top:8px;right:8px;width:40px;height:40px;}</style>
</head><body data-game-build="1">
  <button id="user-bar-settings">gear</button>
  <div id="sidebar"></div>
  <script type="module">
    import { OrwellWindow } from '/js/orwellWindow.js';
    window.__esc = () => window.OrwellWindowKit && window.OrwellWindowKit.dismissTop();
  </script>
</body></html>
"""


def _new_page(pw):
    exe = _chromium_path()
    browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
    page = browser.new_page()
    return browser, page


def _scrims(page):
    return page.evaluate("() => document.querySelectorAll('[data-ow-scrim]').length")


def _el_at_gear(page):
    return page.evaluate(
        """() => {
          const g = document.getElementById('user-bar-settings');
          const r = g.getBoundingClientRect();
          const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return t ? (t.id || t.className || t.tagName) : null;
        }"""
    )


def _load(page, base):
    page.goto(base + "/__h", wait_until="domcontentloaded")  # establish origin for the module import
    page.set_content(_HARNESS)
    page.wait_for_function("() => !!window.OrwellWindowKit", timeout=10000)


def test_orphaned_scrim_is_swept_and_gear_becomes_clickable(_static_server):
    """A modal whose WINDOW is removed out-of-band (the orphan trigger) leaves a scrim that eats
    every click; the next Escape/dismiss must sweep it and hand the page back."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    if _chromium_path() is None:
        pytest.skip("chromium unavailable")
    base = _static_server
    with sync_playwright() as pw:
        browser, page = _new_page(pw)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, base)
            # Mount a modal, then remove its WINDOW node WITHOUT the kit teardown — the exact
            # shape of the orphan (a teardown path that dropped the node but not the scrim).
            page.evaluate(
                """() => {
                  const w = window.OrwellWindowKit.create({
                    id: 'orwell-onboarding', title: 't', modal: true, minimizable: false, closable: false });
                  w.open();
                  document.getElementById('orwell-onboarding').remove();
                }"""
            )
            assert _scrims(page) == 1, "precondition: the scrim is orphaned (window gone, scrim left)"
            assert _el_at_gear(page) == "ow-scrim", "precondition: the orphan intercepts the gear click"
            # The fix: the next dismiss/recompute sweeps the orphan.
            page.evaluate("() => window.__esc()")
            assert _scrims(page) == 0, "#925: the orphaned scrim is swept on the next dismiss"
            assert _el_at_gear(page) != "ow-scrim", "#925: the gear is clickable again (no scrim sink)"
        finally:
            browser.close()
    assert not errs, f"no page errors during the sweep ({errs})"


def test_same_id_modal_collision_does_not_deadlock(_static_server):
    """Two DIFFERENT instances opened under one id must not strand a window+scrim: open() destroys
    the prior owner so a single Escape fully clears the surface (no permanent lockup)."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    if _chromium_path() is None:
        pytest.skip("chromium unavailable")
    base = _static_server
    with sync_playwright() as pw:
        browser, page = _new_page(pw)
        try:
            _load(page, base)
            out = page.evaluate(
                """() => {
                  const A = window.OrwellWindowKit.create({
                    id: 'orwell-onboarding', title: 'A', modal: true, minimizable: false, closable: false });
                  A.open();
                  const B = window.OrwellWindowKit.create({
                    id: 'orwell-onboarding', title: 'B', modal: true, minimizable: false, closable: false });
                  B.open();   // same id, different instance — must not double-mount
                  return { scrims: document.querySelectorAll('[data-ow-scrim]').length,
                           wins: document.querySelectorAll('[data-ow-window]').length };
                }"""
            )
            assert out == {"scrims": 1, "wins": 1}, (
                f"the prior same-id instance must be destroyed on the new open ({out})"
            )
            page.evaluate("() => window.__esc()")
            page.wait_for_timeout(400)  # let the close animation settle
            assert _scrims(page) == 0, "a single Escape fully clears the surface (no deadlock)"
            assert _el_at_gear(page) != "ow-scrim", "the gear is clickable (no lingering scrim)"
        finally:
            browser.close()


def test_single_live_modal_scrim_is_NOT_swept(_static_server):
    """The sweep must be precise: a genuinely LIVE modal's scrim is preserved across a recompute
    (no behavior change for the normal single-modal case)."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    if _chromium_path() is None:
        pytest.skip("chromium unavailable")
    base = _static_server
    with sync_playwright() as pw:
        browser, page = _new_page(pw)
        try:
            _load(page, base)
            # A normal modal (closable so a raise()/recompute is exercised), then force a recompute
            # via raise() — its scrim must survive (it's live).
            live = page.evaluate(
                """() => {
                  const w = window.OrwellWindowKit.create({
                    id: 'orwell-onboarding', title: 'live', modal: true, minimizable: false, closable: true });
                  w.open();
                  w.raise();   // runs _recomputeModalStack → _sweepOrphanScrims
                  return { scrims: document.querySelectorAll('[data-ow-scrim]').length,
                           connected: !!document.querySelector('[data-ow-scrim]') };
                }"""
            )
            assert live == {"scrims": 1, "connected": True}, (
                f"a live modal's scrim must NOT be swept ({live})"
            )
        finally:
            browser.close()
