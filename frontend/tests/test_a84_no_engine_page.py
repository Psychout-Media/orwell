"""A84 - the shared no-engine page recipe (tests/_no_engine_page.py) keeps the "dark house" holding card from re-mounting: after `ready(page)`, `orwell:models-changed` events (which made route() re-mount
the card and re-cover the page: the #925/#1148/#930 scrim flake) leave no scrim. Boots the REAL front-end with no engine. The negative control shows what the stub prevents (it is timing-dependent
locally and deterministic in CI, so it skips rather than fails when the card does not come back). Roles only."""
import pytest

from _no_engine_page import ready
from test_1638_sorts_browser import _app  # noqa: F401  (module-scoped uvicorn FE with NO engine)

pytestmark = pytest.mark.browser


def _open(pw, app):
    try:
        browser = pw.chromium.launch()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"chromium unavailable: {e}")
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.goto(app, wait_until="domcontentloaded")
    return browser, page


def _overlays(page):
    return page.evaluate("() => ({ ob: !!document.getElementById('orwell-onboarding'), scrims: document.querySelectorAll('[data-ow-scrim]').length, loader: !!document.getElementById('app-loader') })")


def _fire_models_changed(page, n=5):
    for _ in range(n):
        page.evaluate("() => window.dispatchEvent(new CustomEvent('orwell:models-changed'))")
        page.wait_for_timeout(120)


def test_after_ready_models_changed_never_brings_the_scrim_back(_app):  # noqa: F811
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _open(pw, _app)
        assert ready(page), f"ready() must leave the page clean: {_overlays(page)}"
        _fire_models_changed(page)
        state = _overlays(page)
        browser.close()
    assert state == {"ob": False, "scrims": 0, "loader": False}, f"a scrim or the holding card came back after ready(): {state}"


def test_the_gear_is_hit_testable_after_ready(_app):  # noqa: F811
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _open(pw, _app)
        assert ready(page)
        _fire_models_changed(page, 3)
        hit = page.evaluate("""() => { const g = document.getElementById('user-bar-settings'); if (!g) return 'no-gear';
          const r = g.getBoundingClientRect(); const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return el === g || g.contains(el) ? 'gear' : (el && (el.id || el.className)) || 'null'; }""")
        browser.close()
    assert hit in ("gear", "no-gear"), f"something covers the settings gear after ready(): {hit}"


def test_negative_control_the_seam_is_the_mount_path_and_the_stub_is_what_stops_it(_app):  # noqa: F811
    """Deterministic (no timing): without the stub, calling the mount seam brings the holding card back; with the stub (ready()) the same call mounts nothing. This is what the stub prevents on every
    async orwell:models-changed re-route."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _open(pw, _app)
        assert ready(page, stub=False)
        has_seam = page.evaluate("() => typeof window._orwellOnboardingMount === 'function'")
        page.evaluate("() => { try { window._orwellOnboardingMount(); } catch (e) {} }")
        page.wait_for_timeout(300)
        without_stub = _overlays(page)
        assert ready(page)                                   # now with the stub: dismiss + neutralise
        page.evaluate("() => { try { window._orwellOnboardingMount(); } catch (e) {} }")
        page.wait_for_timeout(300)
        with_stub = _overlays(page)
        browser.close()
    assert has_seam, "the mount seam window._orwellOnboardingMount must exist on the no-engine page"
    assert without_stub["ob"] or without_stub["scrims"], f"without the stub the seam must bring the card/scrim back: {without_stub}"
    assert with_stub == {"ob": False, "scrims": 0, "loader": False}, f"with ready()'s stub nothing may mount: {with_stub}"
