"""ORW-98 (#1934) - the finished-season retrospective panel shows the three things the engine supplies at the 0048 unseal:
each evictee's exit interview (0130), the weekly Diary-Room pull-quote reel (#1396) and the player's own confessionals (0115).

Real app + real orwellRetrospective.js in headless Chromium (free, local); the three /api/orwell routes are stubbed with
the engine's documented shapes. No model. Roles only. Auto-marked ``browser`` by conftest (sync_playwright).
Vault Wall: the panel renders only what the unsealed payload carries, as text, by NAME - nothing is read from anywhere else.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_RECAP = {"finished": True, "winner": {"name": "W"}, "weeksPlayed": 14, "placement": "jury", "highlights": ["Week 1: a vote"]}
_RETRO = {
    "winner": {"id": "npc:1", "name": "W"}, "hiddenStory": [], "twists": [],
    "playerConfessionals": ["I trust nobody in the kitchen alliance."],
    "pullQuoteReel": [{"week": 2, "quotes": [
        {"source": "npc-confessional", "speaker": "Role Alpha", "quote": "the player is my real target"},
        {"source": "player-diary", "speaker": "P", "quote": "I will pretend to be loyal"}]}],
    "exitInterviews": [{"week": 3, "evictee": {"id": "npc:4", "name": "Role Delta"}, "stance": "bitter", "message": "you all know what you did"}],
}


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def _app():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(
        os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true",
        PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-retro98-"), "app.db"),
    )
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-retro98-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            pytest.skip(f"uvicorn exited early; see /tmp/fe-retro98-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            break
        except Exception:
            time.sleep(1)
    else:
        proc.terminate()
        pytest.skip("server never became ready")
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def _open_vault(page, base, retro):
    ok = lambda body: (lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(body)))
    page.route("**/api/orwell/state*", ok({"started": True}))
    page.route("**/api/orwell/recap*", ok({"recap": _RECAP}))
    page.route("**/api/orwell/retrospective*", ok({"retrospective": retro}))
    page.goto(base, wait_until="domcontentloaded")
    page.wait_for_function("typeof window._orwellRetroEnsure === 'function'", timeout=15000)
    page.evaluate("sessionStorage.removeItem('orwell-retro-dismissed')")
    page.evaluate("window._orwellRetroEnsure()")
    page.wait_for_selector("#orwell-retro button[aria-label='Open the Untold Story']", timeout=15000)
    page.click("#orwell-retro button[aria-label='Open the Untold Story']")
    page.wait_for_selector("#orwell-retro h3[aria-label='The Untold Story']", timeout=10000)
    return page.inner_text("#orwell-retro")


def test_panel_shows_exit_interviews_reel_and_own_confessionals(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        text = _open_vault(page, _app, _RETRO)
        assert "Role Delta" in text and "bitter" in text and "you all know what you did" in text      # exit interview
        assert "the player is my real target" in text and "Role Alpha" in text                        # reel: NPC channel
        assert "I will pretend to be loyal" in text and "your Diary Room" in text                     # reel: player channel
        assert "I trust nobody in the kitchen alliance." in text                                      # own confessionals
        assert "npc:" not in text, "no raw ids reach the player"
        browser.close()


def test_absent_extras_render_no_empty_sections(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        text = _open_vault(page, _app, {"winner": None, "hiddenStory": [], "twists": []})
        assert "exit interviews" not in text and "Diary Room reel" not in text and "Your own confessionals" not in text
        browser.close()
