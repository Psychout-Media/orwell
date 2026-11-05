"""#1638 session-sort — the OrwellMenuKit migration proven in a REAL browser.

Source pins live in tests/test_1638_sorts.py; this lane proves the runtime behavior in headless
chromium against the booted game-build app:

  1. clicking #session-sort-btn body-appends exactly ONE `.ow-popover[role=menu]` kit surface
     (aria-expanded flips true), and the Tidy split-control (#auto-sort-sessions-btn + its
     more/no-ai children) is re-parented into a menu row via the kit's render() escape hatch;
  2. the Rearrange row is a real menuitemcheckbox;
  3. re-clicking the trigger toggles the menu CLOSED (attach owns toggle-on-reclick, aria-expanded
     back to false) — and re-opening mounts exactly one surface again, never a stacked pair.

Auto-marked ``browser`` by conftest (sync_playwright). No fixture names — roles only.
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-1638sorts-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-1638sorts-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(1)
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-1638sorts-"), "app.db"),
    )
    port = _free_port()
    # Playwright-missing (above) is the only sanctioned skip; a uvicorn-never-ready is a real
    # regression and must FAIL, not silently skip.
    proc, base = _boot(env, port)
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def _clear_onboarding(page):
    """Clear the no-engine pre-game overlays (A84: the shared recipe in tests/_no_engine_page.py; the root cause is documented there and in tests/_settings_open.py)."""
    from _no_engine_page import ready
    ready(page)


def test_session_sort_menu_mounts_and_toggles(_app):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(_app, wait_until="domcontentloaded")
        _clear_onboarding(page)
        # un-hide the (empty on a fresh boot) Chats section so the trigger is clickable.
        page.evaluate("""() => {
          const sec = document.getElementById('sessions-section');
          if (sec) sec.classList.remove('hidden', 'collapsed');
        }""")
        # the kit wires the trigger asynchronously (orwellMenu.js loads after app.js).
        page.wait_for_function(
            "() => { const b = document.getElementById('session-sort-btn');"
            " return b && b.getAttribute('aria-haspopup') === 'menu'; }"
        )

        # open → exactly ONE kit surface holding the Tidy split-control (its more/no-ai children).
        page.click("#session-sort-btn")
        page.wait_for_selector(".ow-popover[role='menu']", timeout=3000)
        opened = page.evaluate("""() => {
          const surfaces = document.querySelectorAll('.ow-popover[role="menu"]');
          return {
            count: surfaces.length,
            expanded: document.getElementById('session-sort-btn').getAttribute('aria-expanded'),
            tidy: !!document.querySelector('.ow-popover[role="menu"] #auto-sort-sessions-btn'),
            more: !!document.querySelector('.ow-popover[role="menu"] #auto-sort-sessions-more'),
            noai: !!document.querySelector('.ow-popover[role="menu"] #auto-sort-sessions-noai-btn'),
            rearrange: !!document.querySelector('.ow-popover[role="menu"] [role="menuitemcheckbox"]'),
          };
        }""")
        assert opened["count"] == 1, f"exactly one kit surface must mount (no stacking): {opened}"
        assert opened["expanded"] == "true", f"the trigger reports aria-expanded=true when open: {opened}"
        assert opened["tidy"] and opened["more"] and opened["noai"], \
            f"the Tidy split-control (+ its more/no-ai children) rides into the kit row: {opened}"
        assert opened["rearrange"], f"the Rearrange row is a menuitemcheckbox: {opened}"

        # re-click the trigger → the kit toggles the menu CLOSED (attach owns toggle-on-reclick).
        page.click("#session-sort-btn")
        page.wait_for_selector(".ow-popover[role='menu']", state="detached", timeout=3000)
        closed = page.evaluate("""() => ({
          count: document.querySelectorAll('.ow-popover[role="menu"]').length,
          expanded: document.getElementById('session-sort-btn').getAttribute('aria-expanded'),
        })""")

        # re-open → still exactly one (never a stale + fresh pair stacked).
        page.click("#session-sort-btn")
        page.wait_for_selector(".ow-popover[role='menu']", timeout=3000)
        reopened = page.evaluate(
            "() => document.querySelectorAll('.ow-popover[role=\"menu\"]').length"
        )
        browser.close()

    assert closed["count"] == 0, f"re-clicking the trigger must close the menu: {closed}"
    assert closed["expanded"] == "false", f"aria-expanded returns to false on close: {closed}"
    assert reopened == 1, f"re-opening mounts exactly one surface (no duplicate stack): {reopened}"
