"""#1638 — the plan menu (migrated onto OrwellMenuKit) TOGGLES on re-click, never stacks (regression).

Greptile P1: initPlanMenu._open() called OrwellMenuKit.open() on every plan-toggle click, minting a
NEW menu each time. The kit's outside-click seat treats the anchor (#plan-toggle-btn) as "inside", so
re-clicking the toggle does not dismiss the open menu — a 2nd identical .ow-popover stacked on top.
(The composer overflow menu avoids this via .attach()'s built-in toggle; the plan button can't use
attach() because it only opens the menu when _hasPlan(), else it falls through to the plan-mode
toggle — so _open() must own the toggle itself.)

This drives programmatic re-clicks (the button is game-trim-hidden, so a real click is refused, but
the toggle logic is build-independent — the capture-phase handler fires on .click()) and asserts:
open → re-click CLOSES (never 2 popovers) → re-open → an item still selects+closes. maxSeen must stay
1 (the old bug reached 2).

Auto-marked ``browser`` by conftest (sync_playwright). Game build. Roles only.
"""
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-1638-plan-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-1638-plan-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-1638p-"), "app.db"),
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


_HARNESS = r"""
async () => {
  const planBtn = document.getElementById('plan-toggle-btn');
  if (!planBtn) return { error: 'no #plan-toggle-btn' };
  if (!window.OrwellMenuKit) return { error: 'no OrwellMenuKit' };
  // _hasPlan() reads window._getStoredPlan — stub it truthy so the toggle OPENS the plan menu
  // (otherwise the button falls through to the normal plan-mode toggle and never opens a menu).
  window._getStoredPlan = () => 'a stored plan';
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));
  const count = () => document.querySelectorAll('.ow-popover[role="menu"]').length;
  const seen = [];
  const before = count(); seen.push(before);
  planBtn.click(); await tick(40); const afterOpen = count(); seen.push(afterOpen);
  planBtn.click(); await tick(40); const afterToggle = count(); seen.push(afterToggle);   // must CLOSE
  planBtn.click(); await tick(40); const afterReopen = count(); seen.push(afterReopen);
  // an item still selects + closes.
  const surf = document.querySelector('.ow-popover[role="menu"]');
  const firstItem = surf ? surf.querySelector('.ow-menu-item') : null;
  let afterSelect = null, itemCount = surf ? surf.querySelectorAll('.ow-menu-item').length : 0;
  if (firstItem) { firstItem.click(); await tick(40); afterSelect = count(); seen.push(afterSelect); }
  return { before, afterOpen, afterToggle, afterReopen, afterSelect, itemCount,
           maxSeen: Math.max.apply(null, seen) };
}
"""


def test_plan_menu_reclick_toggles_and_never_stacks(_app):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(_app, wait_until="domcontentloaded")
        page.wait_for_function("() => document.getElementById('plan-toggle-btn') && window.OrwellMenuKit")
        res = page.evaluate(_HARNESS)
        browser.close()

    assert res.get("error") is None, res
    assert res["before"] == 0, f"no plan popover before the first click: {res}"
    assert res["afterOpen"] == 1, f"the first plan-toggle click opens exactly ONE .ow-popover: {res}"
    assert res["itemCount"] >= 2, f"the plan menu carries its Show plan / Plan mode items: {res}"
    # THE regression: a re-click must TOGGLE the menu closed, never stack a 2nd identical popover.
    assert res["afterToggle"] == 0, \
        f"re-clicking the plan toggle must CLOSE the menu, not stack a 2nd popover (old bug → 2): {res}"
    assert res["afterReopen"] == 1, f"a third click re-opens exactly one: {res}"
    assert res["maxSeen"] == 1, \
        f"the plan menu must NEVER have two .ow-popover surfaces at once (never stacks): {res}"
    # and an item still selects + closes.
    assert res["afterSelect"] == 0, f"selecting a plan item closes the menu: {res}"
