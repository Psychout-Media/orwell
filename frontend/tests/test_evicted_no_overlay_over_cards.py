"""E-1 (live rehearsal 2026-11-04) — after the player is evicted, NO window may cover the exit-interview / spectator-choice decision card.

The legacy LW10 "Evicted — your season is over / See how it ends" window rendered on top of those cards (covering "Skip ahead to the finale" and Confirm),
offered a competing fast-forward, and contradicted "you are back for the finale". The gate now shows it for NOBODY; the post-season hand-off is unchanged.
Drives the REAL page with the engine state stubbed to an evicted player holding an open spectator-choice card."""
import os
import subprocess
import sys
import time
import urllib.request

import pytest

from _settle import app_ready

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _src():
    return open(os.path.join(FRONTEND, "static", "js", "orwellNewSeason.js"), encoding="utf-8").read()


def test_the_gate_no_longer_returns_evicted():
    s = _src()
    gate = s[s.index("async function gateState()"):s.index("// ── the panel body")]
    assert 'return "evicted"' not in gate, "the evicted hand-off window must not be raised"
    assert 'return "post-season"' in gate, "the post-season hand-off is unchanged"


from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-evov-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-evov-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError("server never became ready")


@pytest.fixture(scope="module")
def _base():
    """ORW-414: ONE front end for the module (was one uvicorn boot per test); each test routes its own /api/orwell/state in its own page."""
    env = dict(os.environ); env.setdefault("AUTH_ENABLED", "false"); env.setdefault("ORWELL_GAME_BUILD", "1")
    proc, base = _boot(env, _free_port())
    try:
        yield base
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


def _run(base, state_json):
    from playwright.sync_api import sync_playwright
    if True:
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as e:
                pytest.skip(f"chromium unavailable: {e}")
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.route("**/api/orwell/state", lambda r: r.fulfill(status=200, content_type="application/json", body=state_json))
            page.goto(base + "/", wait_until="load", timeout=30000)
            app_ready(page)
            page.evaluate("async () => { if (window._orwellNewSeasonRefresh) await window._orwellNewSeasonRefresh(); }")
            page.wait_for_timeout(800)  # elapsed-time hold: the first test asserts a window does NOT appear, so the window of time is the test
            has_win = page.evaluate("() => !!document.getElementById('orwell-new-season')")
            title = page.evaluate("() => (document.querySelector('#orwell-new-season .ow-win-title, #orwell-new-season [class*=title]') || {}).innerText || ''")
            browser.close()
            return has_win, title


EVICTED_STATE = ('{"started": true, "finished": false, "moment": "eviction", "week": 5, '
                 '"player": {"status": "evicted", "spectator": "watch"}, "pending": {"kind": "spectator-choice"}}')
POST_SEASON_STATE = '{"started": true, "finished": true, "moment": "post-season", "week": 12, "player": {"status": "evicted"}}'


def test_no_window_covers_the_cards_after_a_pre_jury_eviction(_base):
    try:
        import playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    has_win, _ = _run(_base, EVICTED_STATE)
    assert has_win is False, "an evicted player (card open) must see NO new-season/evicted window over the card"


def test_the_post_season_hand_off_still_appears(_base):
    try:
        import playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    has_win, _ = _run(_base, POST_SEASON_STATE)
    assert has_win is True, "the post-season keep/recast hand-off is unchanged"
