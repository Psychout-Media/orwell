"""#658 — the Appearance tab composes the OrwellSettingsCard primitive, proven in a REAL browser.

test_658_settings_card_kit.py source-pins the primitive + the settings.js adoption and runs the
kit's transform against a fake DOM. This lane closes the loop end to end: boot the real FE, open
Settings, land on Appearance, and assert every section in that panel actually renders as
``.osc-card`` > ``.osc-head`` (``.osc-title``) + ``.osc-body`` — while KEEPING ``.admin-card`` (so
the peek / empty-tab / ``.closest('.admin-card')`` logic still works) and dropping the per-card
inline padding leak.

Auto-marked ``browser`` by conftest (sync_playwright).
"""
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

from _settle import app_ready

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(FRONTEND, "tests"))
from _settings_open import open_settings_deterministically  # noqa: E402


from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-658-render-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-658-render-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError("server never became ready")


@pytest.fixture(scope="module")
def _app():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(
        os.environ,
        ORWELL_GAME_BUILD="1",
        AUTH_ENABLED="false",
        LOCALHOST_BYPASS="true",
        PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-658-"), "app.db"),
    )
    port = _free_port()
    try:
        proc, base = _boot(env, port)
    except RuntimeError as e:
        pytest.skip(str(e))
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


_ASSERT = r"""
() => {
  const panel = document.querySelector('[data-settings-panel="appearance"]');
  if (!panel) return { error: 'no appearance panel' };
  const cards = Array.from(panel.children).filter(
    c => c.classList && (c.classList.contains('osc-card') || c.classList.contains('admin-card')));
  return {
    cardCount: cards.length,
    rows: cards.map(c => ({
      osc: c.classList.contains('osc-card'),
      admin: c.classList.contains('admin-card'),
      head: !!c.querySelector(':scope > .osc-head > .osc-title'),
      body: !!c.querySelector(':scope > .osc-body'),
      inlinePad: c.style.paddingBottom || '',
    })),
  };
}
"""


def _land_on_appearance(page, base, viewport):
    page.set_viewport_size(viewport)
    page.goto(base + "/", wait_until="load", timeout=30000)
    app_ready(page)  # ORW-414: the event (app modules mounted), not a fixed 1.5 s
    open_settings_deterministically(page)
    page.evaluate("() => { const b = document.getElementById('settings-tab-appearance'); if (b) b.click(); }")
    page.wait_for_timeout(400)
    return page.evaluate(_ASSERT)


def _assert_composed(result):
    assert "error" not in result, result.get("error")
    rows = result["rows"]
    assert len(rows) >= 2, f"expected several Appearance sections; got {len(rows)}"
    for r in rows:
        assert r["osc"], "each section is upgraded to .osc-card"
        assert r["admin"], "upgrade KEEPS .admin-card (peek / empty-tab / closest still work)"
        assert r["head"], "each section has an .osc-head > .osc-title"
        assert r["body"], "each section wraps its content in .osc-body"
        assert not r["inlinePad"], "the per-card inline padding leak is dropped"


def test_appearance_sections_compose_the_primitive_desktop(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        result = _land_on_appearance(page, _app, {"width": 1280, "height": 900})
        browser.close()
    _assert_composed(result)


def test_appearance_sections_compose_the_primitive_mobile(_app):
    """≤768px the Settings kit hosts as a bottom sheet (#893); the primitive still composes."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        result = _land_on_appearance(page, _app, {"width": 390, "height": 844})
        browser.close()
    _assert_composed(result)


# ── #658 follow-on: the REMAINING tabs compose the primitive, proven in a REAL browser ────────
# Appearance was the first tab (above). The rest migrate through the single `_swapToPanel` seam —
# every tab activation composes the shown panel's sections. This lane drives each tab in a real FE
# and asserts the same `.osc-card` > `.osc-head` (`.osc-title`) + `.osc-body` contract, KEEPING
# `.admin-card` and dropping the inline padding leak — for a player-facing tab (account), the
# intentional skip (shortcuts), and the admin panels (including the services "Login background"
# card admin.js appends dynamically).

_DESKTOP = {"width": 1280, "height": 900}
_MOBILE = {"width": 390, "height": 844}

_PROBE = r"""
(tabName) => {
  const panel = document.querySelector(`[data-settings-panel="${tabName}"]`);
  if (!panel) return { error: 'no panel: ' + tabName };
  const cards = Array.from(panel.children).filter(
    c => c.classList && (c.classList.contains('osc-card') || c.classList.contains('admin-card')));
  return { count: cards.length, rows: cards.map(c => ({
    osc: c.classList.contains('osc-card'),
    admin: c.classList.contains('admin-card'),
    head: !!c.querySelector(':scope > .osc-head > .osc-title'),
    body: !!c.querySelector(':scope > .osc-body'),
    inlinePad: c.style.paddingBottom || '',
  })) };
}
"""


def _land_on_tab(page, base, viewport, tab, force_admin=False):
    page.set_viewport_size(viewport)
    page.goto(base + "/", wait_until="load", timeout=30000)
    app_ready(page)  # ORW-414: the event (app modules mounted), not a fixed 1.5 s
    open_settings_deterministically(page)
    if force_admin:
        # The admin panels (services/ai/users/system/…) are `.admin-only` + built lazily by the
        # admin module. This no-engine boot has no admin session, so reveal + build them the same
        # way an admin session would, then let `_swapToPanel` compose them on click. Vault-free,
        # purely to exercise the render path.
        page.evaluate(
            """() => { try { window._isAdmin = true;
                document.querySelectorAll('.admin-only').forEach(e => { e.style.display = ''; });
                if (window.adminModule && window.adminModule._initData) window.adminModule._initData();
            } catch (_) {} }""")
        page.wait_for_timeout(500)
    page.evaluate("(t) => { const b = document.getElementById('settings-tab-' + t); if (b) b.click(); }", tab)
    page.wait_for_timeout(400)
    return page.evaluate(_PROBE, tab)


def _run_tab(app, viewport, tab, force_admin=False):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        result = _land_on_tab(page, app, viewport, tab, force_admin)
        browser.close()
    return result


def _assert_tab_composed(result, tab, min_cards=1):
    assert "error" not in result, result.get("error")
    rows = result["rows"]
    assert len(rows) >= min_cards, f"{tab}: expected >= {min_cards} sections; got {len(rows)}"
    for r in rows:
        assert r["osc"], f"{tab}: each section is upgraded to .osc-card"
        assert r["admin"], f"{tab}: upgrade KEEPS .admin-card (peek / empty-tab / closest still work)"
        assert r["head"], f"{tab}: each section has an .osc-head > .osc-title"
        assert r["body"], f"{tab}: each section wraps its content in .osc-body"
        assert not r["inlinePad"], f"{tab}: the per-card inline padding leak is dropped"


def test_account_sections_compose_the_primitive_desktop(_app):
    _assert_tab_composed(_run_tab(_app, _DESKTOP, "account"), "account", min_cards=3)


def test_account_sections_compose_the_primitive_mobile(_app):
    _assert_tab_composed(_run_tab(_app, _MOBILE, "account"), "account", min_cards=3)


def test_shortcuts_tab_stays_on_raw_admin_card(_app):
    """The Shortcuts tab is intentionally NOT migrated: its header bar is a flex row whose <h2> is
    nested in a wrapper (no direct-child heading → upgrading would drop the reset button below the
    title) and its list card is headingless. Both stay on the raw `.admin-card`. This pins the skip
    as deliberate + stable (a future change that upgrades it must be a conscious choice)."""
    result = _run_tab(_app, _DESKTOP, "shortcuts")
    assert "error" not in result, result.get("error")
    rows = result["rows"]
    assert len(rows) >= 1, "the shortcuts panel has sections"
    for r in rows:
        assert r["admin"], "shortcuts sections keep .admin-card"
        assert not r["osc"], "shortcuts sections are intentionally left un-upgraded (no clean .osc-head)"


@pytest.mark.parametrize("tab", ["services", "ai", "search", "users", "tools", "system"])
def test_admin_panels_compose_the_primitive(_app, tab):
    """The admin panels migrate through the same `_swapToPanel` seam once shown — including the
    services 'Login background' card admin.js appends dynamically (it composes on first activation
    because the admin build runs before the panel is shown)."""
    _assert_tab_composed(_run_tab(_app, _DESKTOP, tab, force_admin=True), tab, min_cards=1)
