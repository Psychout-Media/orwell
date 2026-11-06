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
  const fake = { RENDERER: 7937, getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 37446 } : null), getParameter: (p) => (p === 37446 ? FAKE : 'WebKit WebGL') };
  const real = HTMLCanvasElement.prototype.getContext;
  // spoof getContext itself (a runner with no WebGL at all still gets a context to read): webgl kinds return the fake, 2d is untouched
  HTMLCanvasElement.prototype.getContext = function (k, ...a) { return /webgl/.test(k) ? fake : real.call(this, k, ...a); };
})();"""
AUTO = """try { localStorage.setItem('orwell-low-power', 'auto'); } catch (e) {}"""   # detect even though Playwright sets navigator.webdriver
NO_WEBGL = """(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (k, ...a) { return /webgl/.test(k) ? null : g.call(this, k, ...a); }; })();"""
EXPLICIT_THEME = """try { localStorage.setItem('orwell-theme', JSON.stringify({ name: 'glass', colors: { bg:'#15171c', fg:'#eef1f4', panel:'#1d2026', border:'#3a3f47', red:'#9aa3af' }, glassTier: 'full', _explicit: true })); } catch (e) {}"""
SNAP = """() => ({ low: document.body.classList.contains('low-power'), frosted: document.body.classList.contains('theme-frosted'), full: document.body.classList.contains('glass-full'),
  info: window.__orwellLowPower || null,
  blur: Array.from(document.querySelectorAll('#sidebar, .chat-input-bar, .msg, #__wp')).map(e => getComputedStyle(e).backdropFilter).filter(v => v && v !== 'none') })"""


def _wait_low_power(page, timeout_s=15):
    """Poll with evaluate (the page's CSP forbids the string eval wait_for_function uses)."""
    import time
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if page.evaluate("() => document.body && document.body.classList.contains('low-power')"):
            return
        page.wait_for_timeout(150)
    raise AssertionError("body.low-power never appeared")


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
            _wait_low_power(page)
        else:
            page.wait_for_timeout(3000)  # theme.js has long since applied its tier
        snap = page.evaluate(SNAP)
        browser.close()
    return snap


@pytest.mark.browser
def test_class_is_applied_when_the_renderer_is_software(_app):  # noqa: F811
    s = _snap(_app, [AUTO, SPOOF % json.dumps("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)")], True)
    assert s["low"] and s["info"]["on"] and s["info"]["reason"] == "renderer"
    assert not s["frosted"] and not s["full"], f"low-power must drop the glass tiers: {s}"
    assert s["blur"] == [], f"no backdrop blur may remain in low-power: {s['blur']}"


@pytest.mark.browser
def test_class_is_applied_when_webgl_fails(_app):  # noqa: F811
    s = _snap(_app, [AUTO, NO_WEBGL], True)
    assert s["low"] and s["info"]["reason"] == "no-webgl"


@pytest.mark.browser
def test_class_is_not_applied_on_a_hardware_renderer(_app):  # noqa: F811
    s = _snap(_app, [AUTO, SPOOF % json.dumps("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)")], False)
    assert not s["low"] and s["info"] and s["info"]["on"] is False


@pytest.mark.browser
def test_an_explicit_theme_choice_wins_over_a_software_renderer(_app):  # noqa: F811
    s = _snap(_app, [AUTO, SPOOF % json.dumps("llvmpipe (LLVM 15.0.7, 256 bits)"), EXPLICIT_THEME], False)
    assert not s["low"] and s["info"]["explicit"] is True


@pytest.mark.browser
def test_automation_keeps_the_glass_default_without_the_opt_in(_app):  # noqa: F811
    """CI determinism: a WebDriver/Playwright browser on a software-rendered runner must NOT go low-power on its own (the mirror, screenshot, a11y
    and perf jobs compare like with like), even when the renderer string is SwiftShader."""
    s = _snap(_app, [SPOOF % json.dumps("SwiftShader driver")], False)
    assert not s["low"], s


@pytest.mark.browser
def test_a_theme_choice_made_in_the_ui_sticks_across_tweaks_and_reload(_app):  # noqa: F811
    """A software-renderer player who picks a theme/tier stays out of low-power, including after a later tint/font tweak and a reload."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        ctx = browser.new_context(viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        page.add_init_script(AUTO)
        page.add_init_script(SPOOF % json.dumps("llvmpipe (LLVM 15.0.7, 256 bits)"))
        page.goto(_app, wait_until="load")
        _wait_low_power(page)
        # a deliberate pick through the theme module's own save(), then an unrelated tweak that re-saves (the old code dropped the flag here)
        page.evaluate("""() => { const t = window.themeModule; const s = t.getSaved() || {}; const c = (s.colors) || { bg:'#15171c', fg:'#eef1f4', panel:'#1d2026', border:'#3a3f47', red:'#9aa3af' };
          t.save('glass', c, { glassTier: 'full' }); t.save('glass', c, { glassTier: 'full', tinted: true, font: 'system' }); }""")
        assert page.evaluate("() => JSON.parse(localStorage.getItem('orwell-theme'))._explicit") is True
        assert not page.evaluate("() => document.body.classList.contains('low-power')")
        page.reload(wait_until="load")
        page.wait_for_timeout(3000)
        assert not page.evaluate("() => document.body.classList.contains('low-power')"), "an explicit choice must survive a reload"
        browser.close()
