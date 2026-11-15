"""#1638 consumer #2 — the composer overflow "+" empty-chevron cascade is REVERSIBLE (regression).

Greptile T-Rex + CodeRabbit (×2 Major) caught a hide-only bug: refreshOverflowChevron() only ever
SET display='none' when buildOverflowItems() was empty and never restored '' when it later went
non-empty. So once the game-build "+" was inline-hidden at boot, a later non-empty build — the
settings pass enabling TTS, or a full-build responsive collapse folding in a toolbar mirror — could
never un-hide it, and the overflow menu became permanently unreachable. (The Appearance UI-vis toggle
for the "+" targets .overflow-wrapper, a DIFFERENT element than the inline-hidden #overflow-plus-btn,
so it could not restore it either.)

This drives that empty→non-empty→empty transition LIVE in the game build and asserts the "+" is
RESTORED (inline display flips back) + actually opens through the kit, then re-hides. The one builder
branch reachable under the game build is the TTS gate, so we force it with a data:-URL <script>
carrying "tts-ai.js" in its src (buildOverflowItems only checks for the tag's presence) + the
_overflowTtsEnabled flag — no network, no real voice module executes.

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
        stdout=open(f"/tmp/fe-1638-chevron-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-1638-chevron-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-1638-"), "app.db"),
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
() => {
  const vis = el => el && !el.hidden && getComputedStyle(el).display !== 'none';
  const plus = document.getElementById('overflow-plus-btn');
  if (!plus) return { error: 'no #overflow-plus-btn' };
  if (typeof window._refreshOverflowChevron !== 'function') return { error: 'no _refreshOverflowChevron' };
  // baseline: the game-build builder is empty (attach/tts/mirrors dropped/guarded) → the "+" is
  // inline-hidden by the G13 empty-chevron cascade.
  window._refreshOverflowChevron();
  const startedDisplay = plus.style.display;
  const startedVisible = vis(plus);
  // drive the builder non-empty via the ONE branch reachable in the game build: the TTS gate.
  // (data: src — buildOverflowItems only checks for a script[src*="tts-ai.js"] presence; no network.)
  const s = document.createElement('script');
  s.src = 'data:text/javascript,/*tts-ai.js*/';
  s.dataset.owSmokeTts = '1';
  document.head.appendChild(s);
  window._overflowTtsEnabled = true;
  window._refreshOverflowChevron();
  const restoredDisplay = plus.style.display;
  const restoredVisible = vis(plus);
  // the restored "+" must OPEN through the kit, carrying the built item.
  let opened = false, itemCount = 0;
  if (window.OrwellMenuKit && vis(plus)) {
    plus.click();
    const surf = document.querySelector('.ow-popover[role="menu"]');
    opened = !!surf;
    itemCount = surf ? surf.querySelectorAll('.ow-menu-item').length : 0;
    try { window.OrwellMenuKit.closeAll(); } catch (_) {}
  }
  // cleanup: restore the empty game-build state.
  window._overflowTtsEnabled = false;
  s.remove();
  window._refreshOverflowChevron();
  const reHiddenDisplay = plus.style.display;
  const reHidden = !vis(plus);
  return { startedDisplay, startedVisible, restoredDisplay, restoredVisible,
           opened, itemCount, reHiddenDisplay, reHidden };
}
"""


def test_overflow_chevron_empty_then_restored_then_reopens(_app):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(_app, wait_until="domcontentloaded")
        # window.OrwellMenuKit can exist BEFORE attach() finishes wiring the trigger — require the
        # trigger's aria-haspopup='menu' (which attach() sets last) before probing/clicking.
        page.wait_for_function(
            "() => document.getElementById('overflow-plus-btn') "
            "&& typeof window._refreshOverflowChevron === 'function' "
            "&& window.OrwellMenuKit "
            "&& document.getElementById('overflow-plus-btn').getAttribute('aria-haspopup') === 'menu'"
        )
        res = page.evaluate(_HARNESS)
        browser.close()

    assert res.get("error") is None, res
    # empty builder → the "+" is inline-hidden (the G13 empty-chevron cascade in the game build).
    assert res["startedDisplay"] == "none", f"game-build '+' must start inline-hidden (empty builder): {res}"
    assert res["startedVisible"] is False, res
    # BUG #1 regression: a non-empty builder RESTORES the inline display (reversible, not hide-only).
    assert res["restoredDisplay"] != "none", \
        f"a non-empty builder must RESTORE the '+' inline display (refreshOverflowChevron reversible): {res}"
    assert res["restoredVisible"] is True, f"the restored '+' must be visible: {res}"
    # and the restored "+" actually opens the kit menu carrying the built item.
    assert res["opened"] is True and res["itemCount"] >= 1, \
        f"the restored '+' must open the kit menu with the built item: {res}"
    # cleanup: clearing the builder re-hides it (the empty-chevron cascade stays intact/reversible).
    assert res["reHiddenDisplay"] == "none" and res["reHidden"] is True, \
        f"clearing the builder must re-hide the '+': {res}"
