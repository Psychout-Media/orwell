"""A pre-jury evictee holds the 0133 finale-interview card WHILE the post-season retrospective is also shown.

The engine raises the finale-interview decision AFTER the crown and leaves it as the live pending, and the
finished-season retro (#orwell-retro) self-shows at the same time - the real game DOES co-render them. On a phone
the retro is a top sheet and the card an anchored action-sheet above the composer; they intersected (the viewport
matrix's `orwell-retro intersects orwell-decision-card`). A driver that answered the card hid it from CI. The fix:
a live decision card outranks the FLOATING retro on the narrow tier, so the retro yields until the card is
answered/dismissed, then returns.

This is the cheap, engine-free browser lane (the engine-staged proof is the `+card-with-retro` pass in
scripts/responsive_matrix.py): real app, `/api/orwell/{state,recap}` stubbed to a finished season, a finale-interview
pending dispatched exactly the way chat.js arms it. Auto-marked ``browser`` by conftest (sync_playwright). Roles only.
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

_RECAP = {"finished": True, "winner": {"name": "W"}, "weeksPlayed": 14, "placement": "evicted",
          "highlights": ["Week %d: the house voted" % i for i in range(1, 25)]}
_PENDING = {
    "kind": "finale-interview", "by": {"id": "player", "name": "P"}, "pick": 1,
    "prompt": "The season is crowned - the host sits you down for your finale-night interview.",
    "options": [{"id": s, "name": s} for s in ("gracious", "defiant", "bitter")],
    "stances": ["gracious", "defiant", "bitter"],
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-fcro-"), "app.db"),
    )
    port = _free_port()
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-fcro-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            pytest.skip(f"uvicorn exited early; see /tmp/fe-fcro-{port}.log")
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


def _stage(page, base):
    page.route("**/api/orwell/state*", lambda r: r.fulfill(
        status=200, content_type="application/json", body=json.dumps({"started": True})))
    page.route("**/api/orwell/recap*", lambda r: r.fulfill(
        status=200, content_type="application/json", body=json.dumps({"recap": _RECAP})))
    page.goto(base, wait_until="domcontentloaded")
    page.add_style_tag(content="*,*::before,*::after{transition:none!important;animation:none!important}")
    page.wait_for_function("typeof window._orwellRetroEnsure === 'function'", timeout=15000)
    page.evaluate("sessionStorage.removeItem('orwell-retro-dismissed')")
    page.evaluate("window._orwellRetroEnsure()")
    page.wait_for_function(
        "() => { const e = document.getElementById('orwell-retro'); return !!e && e.getBoundingClientRect().height > 100; }",
        timeout=15000)


def _arm_card(page):
    page.evaluate("(p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }))", _PENDING)
    page.wait_for_selector("#orwell-decision-card", state="visible", timeout=10000)


def _rect(page, sel):
    return page.evaluate(
        """(s) => { const e = document.querySelector(s); if (!e) return null;
                    const cs = getComputedStyle(e); const b = e.getBoundingClientRect();
                    return cs.display === 'none' || cs.visibility === 'hidden' || !b.width || !b.height ? null
                         : { l: b.left, t: b.top, r: b.right, b: b.bottom }; }""", sel)


def _intersects(a, b):
    return a and b and a["l"] < b["r"] and b["l"] < a["r"] and a["t"] < b["b"] and b["t"] < a["b"]


@pytest.mark.parametrize("w,h", [(320, 568), (390, 844), (768, 1024), (1366, 768), (1440, 900)])
def test_live_finale_card_and_retro_never_overlap(_app, w, h):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_context(viewport={"width": w, "height": h}, has_touch=w <= 820).new_page()
        _stage(page, _app)
        assert _rect(page, "#orwell-retro"), "precondition: the finished-season retro is showing"
        _arm_card(page)
        card, retro = _rect(page, "#orwell-decision-card"), _rect(page, "#orwell-retro")
        assert card, "the live decision card must render"
        assert not _intersects(card, retro), f"retro {retro} overlaps the live decision card {card} at {w}x{h}"
        if w <= 768:
            # the narrow tier: the floating retro YIELDS to the live card ...
            assert retro is None, "on a phone the floating retro must yield while a decision card is live"
            # ... and returns by itself once the card is gone (answered / dismissed).
            page.evaluate("document.getElementById('orwell-decision-card').remove()")
            assert _rect(page, "#orwell-retro"), "the retro must return once the card is gone"
        browser.close()
