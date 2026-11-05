"""A8 (ship-blocker) — kit windows must not clip to a sliver on mobile.

The bug: `frontend/static/js/orwellWindow.js`'s shared `.ow-window` CSS sets
`max-width: 64vw` with NO mobile override. `frontend/static/js/orwellSlots.js`'s
`restackNarrowSheets()` (the audit-F3 "narrow tier is a SHEET HOST" mechanism)
already writes `left:0; right:0` on every top-slotted kit window under the
768px breakpoint so it should stretch edge-to-edge — but the un-overridden
`max-width:64vw` silently defeats that stretch, so EVERY kit window (settings,
theme, cast, headshot, retrospective, finale, new season — the whole
`OrwellWindow`/`.ow-*` family, docs/audits/2026-06-11-dwe-window-audit.md)
renders as a clipped ~64vw sliver on a phone. The theme picker is the sharpest
symptom: at 64vw it shows zero visible swatches.

This is a single root cause (the shared kit CSS) with broad blast radius — the
fix belongs in the kit (`orwellWindow.js`'s `ensureCss()`), never a per-window
patch (the F-3 anti-fragmentation ratchet, `test_f3_window_ratchet.py`).

Harness: mirrors `test_925_orphan_scrim_sweep.py` — a tiny static server over
the REAL `frontend/static/js/` tree (no engine/FE boot needed) driving the REAL
`OrwellWindowKit` + `OrwellSlots` over Playwright at a real mobile viewport.
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

_PORT = int(os.environ.get("ORWELL_A8_PORT", "8797"))

MOBILE_VIEWPORT = {"width": 375, "height": 812}
# The window must be USABLY wide — not clipped to the old 64vw (~240px) sliver.
# The narrow sheet host (orwellSlots.js restackNarrowSheets) stacks it edge-to-edge
# (left:0/right:0), so a healthy window should be within a few px of the full
# viewport width; 90% leaves slack for any future small side inset.
MIN_USABLE_FRACTION = 0.90


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


# The harness wires the REAL kit + the REAL slot engine (orwellSlots.js) so the
# narrow-tier stacking (restackNarrowSheets) actually runs — a bare OrwellWindow
# with no OrwellSlots loaded would skip slot registration entirely and never
# reproduce the left:0/right:0 stretch this bug defeats.
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


def _new_page(pw, viewport):
    exe = _chromium_path()
    browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
    page = browser.new_page(viewport=viewport)
    return browser, page


def _load(page, base):
    page.goto(base + "/__h", wait_until="domcontentloaded")  # establish origin for the module import
    page.set_content(_HARNESS)
    page.wait_for_function("() => !!window.OrwellWindowKit && !!window.OrwellSlots", timeout=10000)


def _open_representative_window(page, id_, title, slot=None, modal=False):
    """Open a kit window the same way settings.js / theme.js do (modal:true,
    default slot). Returns its bounding box + the viewport width."""
    return page.evaluate(
        """({ id, title, slot, modal }) => {
            const opts = { id, title, closable: true };
            if (slot) opts.slot = slot;
            if (modal) opts.modal = true;
            const w = window.OrwellWindowKit.create(opts);
            w.open();
            const el = document.getElementById(id);
            const r = el.getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width,
                     viewportWidth: window.innerWidth };
        }""",
        {"id": id_, "title": title, "slot": slot, "modal": modal},
    )


@pytest.mark.parametrize(
    "win_id,title,slot,modal",
    [
        # theme.js: OrwellWindowKit.create({ id: 'theme-modal', modal: true, ... }) — the sharpest
        # reported symptom (zero visible swatches at the old 64vw clip).
        ("theme-modal", "Theme", None, True),
        # settings.js: OrwellWindowKit.create({ id: 'settings-modal', modal: true, ... })
        ("settings-modal", "Settings", None, True),
        # orwellCast.js / orwellFinale.js / orwellRetrospective.js: non-modal top-slotted panels.
        ("orwell-cast", "The Cast", "top-left", False),
    ],
)
def test_kit_window_is_not_clipped_on_mobile(_static_server, win_id, title, slot, modal):
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    if _chromium_path() is None:
        pytest.skip("chromium unavailable")
    base = _static_server
    with sync_playwright() as pw:
        browser, page = _new_page(pw, MOBILE_VIEWPORT)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, base)
            box = _open_representative_window(page, win_id, title, slot=slot, modal=modal)
        finally:
            browser.close()
    assert not errs, f"no page errors opening the kit window ({errs})"
    vw = box["viewportWidth"]
    floor = vw * MIN_USABLE_FRACTION
    assert box["width"] >= floor, (
        f"A8: {win_id!r} is clipped on mobile — width {box['width']:.0f}px of a {vw}px viewport "
        f"(need >= {floor:.0f}px). The kit's shared `.ow-window` CSS (orwellWindow.js ensureCss()) "
        "must relax `max-width:64vw` under the mobile breakpoint so the narrow sheet host's "
        "left:0/right:0 stretch (orwellSlots.js restackNarrowSheets) isn't defeated."
    )
    # Not merely wide — actually ON-SCREEN (never a right-pinned or left-pinned sliver whose
    # opposite edge runs off the viewport, which a naive `max-width:none` with no repositioning
    # could still produce under CSS's abs-pos over-constraint resolution).
    assert box["left"] >= -2, f"A8: {win_id!r} left edge {box['left']:.0f} runs off-screen"
    assert box["right"] <= vw + 2, f"A8: {win_id!r} right edge {box['right']:.0f} runs off the {vw}px viewport"


# ── RESP-11 / HIG F-TOUCH-1 — the coarse-pointer titlebar close hit area (RUNTIME) ─────────
# The kit CSS keeps the VISIBLE titlebar control a proportionate ~32px on coarse pointers
# (no giant buttons dominating a ~44px titlebar — the #893 intent) but extends the HIT area
# to the 44pt floor via an invisible >=44px ::after expander (HIG Layout "at least 44x44 pt";
# an accidental near-miss tap on the highest-consequence CLOSE control otherwise loses the
# panel). test_hig_window_touch_a11y.py SOURCE-pins that CSS; this proves it is genuinely a
# >=44px FUNCTIONAL hit target at runtime — the source-pin lane has no DOM runtime — by
# hit-testing points inside the 44px box but outside the 32px visible box.
#
# The context emulates a COARSE primary pointer (touch/mobile) so `@media (pointer: coarse)`
# actually matches; the 44px ::after rule is width-independent, so the layout viewport width
# is irrelevant here (unlike the sliver test above, which is about narrow-tier stretch).


def _new_coarse_page(pw):
    exe = _chromium_path()
    browser = pw.chromium.launch(executable_path=exe) if exe else pw.chromium.launch()
    ctx = browser.new_context(viewport=MOBILE_VIEWPORT, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    return browser, page


# The JS opens a modal kit window (a centered dialog with a close control in its titlebar)
# and hit-tests the close control on the coarse pointer. `isBtn(x,y)` resolves the topmost
# element at a viewport point back to the close control (directly, a descendant, or via its
# generated ::after — elementFromPoint returns the pseudo's originating element).
_HIT_PROBE_JS = """
() => {
  const w = window.OrwellWindowKit.create({ id: 'ow-hit-win', title: 'Hit test', modal: true, closable: true });
  w.open();
  const btn = document.querySelector('#ow-hit-win .ow-close');
  if (!btn) return { err: 'no close control' };
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const after = getComputedStyle(btn, '::after');
  const isBtn = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return !!(el && (el === btn || btn.contains(el) || (el.closest && el.closest('.ow-close') === btn)));
  };
  return {
    coarse: matchMedia('(pointer: coarse)').matches,
    visualW: r.width, visualH: r.height,
    afterW: after.width, afterH: after.height,
    // points 20px off-center: inside the 44px hit box (half=22) but OUTSIDE the 32px visible
    // box (half=16) — a >=44px hit target resolves all of these back to the close control.
    hitDown: isBtn(cx, cy + 20), hitRight: isBtn(cx + 20, cy), hitUp: isBtn(cx, cy - 20),
    // 30px off-center is OUTSIDE even the 44px hit box — the expansion must be BOUNDED.
    missFar: isBtn(cx, cy + 30),
  };
}
"""


def test_titlebar_close_control_has_44px_hit_area_on_coarse_pointer(_static_server):
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    if _chromium_path() is None:
        pytest.skip("chromium unavailable")
    with sync_playwright() as pw:
        browser, page = _new_coarse_page(pw)
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        try:
            _load(page, _static_server)
            probe = page.evaluate(_HIT_PROBE_JS)
        finally:
            browser.close()
    assert not errs, f"no page errors opening the kit window ({errs})"
    assert not probe.get("err"), probe
    # sanity: the coarse-pointer media query must actually be active, or the whole check is moot.
    assert probe["coarse"], "coarse-pointer emulation failed — @media (pointer: coarse) did not match"
    # the VISIBLE control stays a proportionate ~32px (F-TOUCH-1 grows the hit area, not the glyph).
    assert 30 <= probe["visualW"] <= 36 and 30 <= probe["visualH"] <= 36, (
        f"F-TOUCH-1: the visible close control must stay ~32px, got {probe['visualW']}x{probe['visualH']}"
    )
    # the invisible ::after hit expander meets the 44pt floor…
    assert probe["afterW"] == "44px" and probe["afterH"] == "44px", (
        f"F-TOUCH-1: the ::after hit region must be 44x44, got {probe['afterW']}x{probe['afterH']}"
    )
    # …and it is a genuinely FUNCTIONAL hit target: a near-miss tap 20px off-center (well past
    # the 32px visible edge) still resolves to CLOSE, in every unobstructed direction.
    assert probe["hitDown"] and probe["hitRight"] and probe["hitUp"], (
        "F-TOUCH-1: a tap within the 44px hit region but outside the 32px visible box must still "
        f"hit the close control (down/right/up = {probe['hitDown']}/{probe['hitRight']}/{probe['hitUp']})"
    )
    # the expansion is BOUNDED to ~44px — a point 30px off-center must NOT hit the control.
    assert not probe["missFar"], "F-TOUCH-1: the hit area must be bounded to ~44px, not unbounded"
