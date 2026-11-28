"""ORW-1142: the chat composer renders as ONE box at 4K, 1080p and phone widths.

Kevin's TV (3840x2160, Firefox) showed two stacked boxes: the textarea's own keyboard-focus ring
(drawn 6px outside it, and Firefox matches :focus-visible on every click) read as a second composer
inside the bar. Also pinned: the placeholder never shows beside composing/typed text, the box wraps
and grows to a bounded maximum, and nothing overlaps. ui.js autoResize also copied the textarea style
through computed cssText, which is empty in Firefox (the clone measured as a default textarea).

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


from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-1142-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-1142-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-1142-"), "app.db"),
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


VIEWPORTS = {"4k": (3840, 2160), "1080p": (1920, 1080), "phone": (390, 844)}

PROBE = """() => {
  const t = document.getElementById('message');
  const bar = document.querySelector('.chat-input-bar');
  const r = e => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  const tc = getComputedStyle(t), bc = getComputedStyle(bar);
  return { n: document.querySelectorAll('textarea#message').length, ta: r(t), bar: r(bar),
    taOutline: tc.outlineStyle + ' ' + tc.outlineWidth, barOutline: bc.outlineStyle + ' ' + bc.outlineWidth,
    sh: t.style.height, vl: t.value.length, cw: t._resizeClone && t._resizeClone.offsetWidth, csh: t._resizeClone && (t._resizeClone.style.height='0', t._resizeClone.scrollHeight), fv: t.matches(':focus-visible'), phOpacity: getComputedStyle(t, '::placeholder').opacity, vw: innerWidth, vh: innerHeight };
}"""


@pytest.mark.parametrize("name", list(VIEWPORTS))
def test_composer_is_one_box_that_wraps_and_grows(_app, name):
    from playwright.sync_api import sync_playwright
    w, h = VIEWPORTS[name]
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={"width": w, "height": h})
        page.goto(_app)
        page.wait_for_selector("#message", state="attached")
        page.wait_for_function("() => !!document.getElementById('message')._resizeClone", timeout=30000)
        page.wait_for_timeout(1500)
        page.evaluate("() => { const d = document.querySelector('#orwell-onboarding [data-ob-dismiss]'); if (d) d.click(); }")
        page.wait_for_timeout(300)
        page.click("#message", force=True)
        page.focus("#message")
        one = page.evaluate(PROBE)
        page.fill("#message", "hello world " * 40)
        page.keyboard.press("End")  # a key press makes :focus-visible match deterministically
        try:
            page.wait_for_function("() => document.getElementById('message').getBoundingClientRect().height > 48", timeout=25000)
        except Exception:
            pass  # the assertion below reports the measured height
        many = page.evaluate(PROBE)
        b.close()
    assert many["n"] == 1
    # one composer: the focus ring is on the bar, never a second ring box on the textarea
    assert many["taOutline"].startswith("none") or many["taOutline"].endswith(" 0px"), many["taOutline"]
    if many["fv"]:
        assert many["barOutline"].startswith("solid"), many["barOutline"]
    # wraps and grows (several lines), bounded by the maximum
    assert many["ta"]["h"] > one["ta"]["h"] * 2, (one, many)
    assert many["ta"]["h"] <= 200
    # nothing overflows the bar or the viewport
    assert many["ta"]["y"] >= many["bar"]["y"] and many["ta"]["y"] + many["ta"]["h"] <= many["bar"]["y"] + many["bar"]["h"]
    assert many["bar"]["x"] >= 0 and many["bar"]["x"] + many["bar"]["w"] <= many["vw"] + 1
    assert many["bar"]["y"] + many["bar"]["h"] <= many["vh"] + 1


def test_placeholder_hides_while_composing(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page(viewport={"width": 1920, "height": 1080})
        page.goto(_app)
        page.wait_for_selector("#message", state="attached")
        page.wait_for_timeout(1500)
        before = page.evaluate(PROBE)["phOpacity"]
        page.evaluate("() => document.getElementById('message').dispatchEvent(new CompositionEvent('compositionstart'))")
        during = page.evaluate(PROBE)["phOpacity"]
        page.evaluate("() => document.getElementById('message').dispatchEvent(new CompositionEvent('compositionend'))")
        after = page.evaluate(PROBE)["phOpacity"]
        b.close()
    assert float(before) > 0 and float(during) == 0 and float(after) > 0


def test_autoresize_clone_does_not_rely_on_computed_csstext():
    with open(os.path.join(FRONTEND, "static", "js", "ui.js"), encoding="utf-8") as f:
        ui = f.read()
    assert "getComputedStyle(textarea).cssText" not in ui, "computed cssText is empty in Firefox (ORW-1142)"
