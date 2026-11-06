"""ORW-154 / ORW-190 - the browser leg: `body.low-power` lands when the WebGL renderer is a software rasteriser (spoofed via an init script
so the test is deterministic on any runner), and does NOT land on a hardware renderer or when the player chose a theme explicitly.
The detection function and decision matrix are unit-tested in test_orw154_low_power.py (Node, no browser)."""
import json

import pytest

# ---- real browser: the class lands when the renderer is software ----------------------------------------------------------------------
from test_1638_sorts_browser import _app  # noqa: E402,F401  (module-scoped uvicorn FE with NO engine)

pytestmark = pytest.mark.browser

SPOOF = """(() => {
  const FAKE = %s;
  const patch = (proto) => {
    if (!proto) return;
    const gp = proto.getParameter, ge = proto.getExtension;
    proto.getParameter = function (p) { return p === 0x9246 ? FAKE : gp.call(this, p); };
    proto.getExtension = function (n) { return n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 } : ge.call(this, n); };
  };
  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
})();"""
NO_WEBGL = """(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (k, ...a) { return /webgl/.test(k) ? null : g.call(this, k, ...a); }; })();"""
EXPLICIT_THEME = """try { localStorage.setItem('orwell-theme', JSON.stringify({ name: 'glass', glassTier: 'full', _explicit: true })); } catch (e) {}"""
SNAP = """() => ({ low: document.body.classList.contains('low-power'), frosted: document.body.classList.contains('theme-frosted'), full: document.body.classList.contains('glass-full'),
  info: window.__orwellLowPower || null,
  blur: Array.from(document.querySelectorAll('#sidebar, .chat-input-bar, .msg, #__wp')).map(e => getComputedStyle(e).backdropFilter).filter(v => v && v !== 'none') })"""


def _snap(app, init_scripts, wait_for_class):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_context(viewport={"width": 1280, "height": 900}).new_page()
        for s in init_scripts:
            page.add_init_script(s)
        page.goto(app, wait_until="load")
        if wait_for_class:
            page.wait_for_function("document.body.classList.contains('low-power')", timeout=15000)
        else:
            page.wait_for_timeout(3000)  # theme.js has long since applied its tier
        snap = page.evaluate(SNAP)
        browser.close()
    return snap


@pytest.mark.browser
def test_class_is_applied_when_the_renderer_is_software(_app):  # noqa: F811
    s = _snap(_app, [SPOOF % json.dumps("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)")], True)
    assert s["low"] and s["info"]["on"] and s["info"]["reason"] == "renderer"
    assert not s["frosted"] and not s["full"], f"low-power must drop the glass tiers: {s}"
    assert s["blur"] == [], f"no backdrop blur may remain in low-power: {s['blur']}"


@pytest.mark.browser
def test_class_is_applied_when_webgl_fails(_app):  # noqa: F811
    s = _snap(_app, [NO_WEBGL], True)
    assert s["low"] and s["info"]["reason"] == "no-webgl"


@pytest.mark.browser
def test_class_is_not_applied_on_a_hardware_renderer(_app):  # noqa: F811
    s = _snap(_app, [SPOOF % json.dumps("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)")], False)
    assert not s["low"] and s["info"] and s["info"]["on"] is False


@pytest.mark.browser
def test_an_explicit_theme_choice_wins_over_a_software_renderer(_app):  # noqa: F811
    s = _snap(_app, [SPOOF % json.dumps("llvmpipe (LLVM 15.0.7, 256 bits)"), EXPLICIT_THEME], False)
    assert not s["low"] and s["info"]["explicit"] is True
