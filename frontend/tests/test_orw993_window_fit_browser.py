"""ORW-993 - every kit window fits the visible viewport at TV, laptop and phone sizes (browser gate).

Seen on a large TV (prod 33.13): the houseguest dossier window was taller than the space it opened in
(over the sidebar account bar), had a sideways scrollbar, its portrait ran under the vertical scrollbar,
and the empty send showed the browser's native "fill out this field" bubble.

Root causes (all in the kit, not per window):
  * orwellSlots.clampPos / orwellWindow._reclamp only guaranteed a 200 px sliver of a tall window on
    screen and ignored persistent chrome (.sidebar-user-bar), and nothing capped the window height
    itself (.ow-body capped at 70dvh but the titlebar/padding sat on top of that).
  * .ow-body was `overflow:auto` (both axes) with no wrapping rule, and the dossier head carried a
    min-width that ignored the body's own vertical scrollbar, so the content box was always wider than
    the box that held it.
  * the composer textarea was `required`, so the empty send reported native validity.

Old code fails: at 1280x720 (a 4K TV at 150%) the dossier body is 560px tall plus titlebar, ~600px, from
a top-right slot start of ~56px: the old clampPos let its bottom reach ~660px (inside 720, so only the
account bar overlap shows) while at 390x844 / 1920x1080 the head min-width (335px) exceeds the content
box (320px after the scrollbar), so scrollWidth > clientWidth - the width assert fails on the old
.ow-body{overflow:auto}; and `required` on #message makes checkValidity() false - the validation assert
fails on the old index.html. Auto-marked ``browser`` by conftest (sync_playwright). Game build.
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

SIZES = [(1920, 1080), (2560, 1440), (3840, 2160), (390, 844)]

_WIDE_SVG = ("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='2400' height='1500'>"
             "<rect width='2400' height='1500' fill='%23567'/></svg>")
_BIO = "A long biography line that keeps going and going so the body must wrap and scroll. " * 12
_DOSSIER = {
    "found": True, "id": "hg1", "name": "Test Guest", "status": "active", "isPlayer": False,
    "portrait": _WIDE_SVG,
    "persona": {"biography": _BIO},
    "history": [{"type": "conversation", "content": "A wrapped line of remembered text. " * 6} for _ in range(10)],
    "deals": [], "alliances": [],
}


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-orw993-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-orw993-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-993-"), "app.db"),
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


_MEASURE = r"""
(id) => {
  const w = document.getElementById(id);
  if (!w) return { error: 'no #' + id };
  const r = w.getBoundingClientRect();
  const body = w.querySelector('.ow-body') || w;
  const imgs = Array.from(w.querySelectorAll('img')).map((i) => {
    const ir = i.getBoundingClientRect();
    // the nearest ancestor that clips or sizes the image: its own container
    const cr = (i.parentElement || w).getBoundingClientRect();
    const br = body.getBoundingClientRect();
    return { w: ir.width, right: ir.right, left: ir.left, cRight: cr.right + 0.5, cLeft: cr.left - 0.5,
             bodyRight: br.right + 0.5 };
  });
  const bar = document.querySelector('.sidebar-user-bar');
  let overBar = false;
  if (bar) {
    const b = bar.getBoundingClientRect();
    overBar = b.width > 0 && b.height > 0 && r.left < b.right && r.right > b.left && r.bottom > b.top + 1 && r.top < b.bottom;
  }
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight,
           scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, imgs, overBar };
}
"""


def _check(res, label):
    assert res.get("error") is None, (label, res)
    tol = 1
    assert res["left"] >= -tol and res["top"] >= -tol, f"{label}: window starts off-screen {res}"
    assert res["right"] <= res["vw"] + tol and res["bottom"] <= res["vh"] + tol, \
        f"{label}: window rect is outside the viewport {res}"
    assert not res["overBar"], f"{label}: window covers the sidebar account bar {res}"
    assert res["scrollWidth"] <= res["clientWidth"] + tol, f"{label}: body scrolls sideways {res}"
    for im in res["imgs"]:
        assert im["right"] <= im["cRight"] + tol and im["left"] >= im["cLeft"] - tol, \
            f"{label}: an image is wider than its container {res}"
        assert im["right"] <= im["bodyRight"] + tol, f"{label}: an image runs past the content box {res}"


@pytest.mark.parametrize("vw,vh", SIZES)
def test_dossier_and_knowledge_windows_fit_viewport(_app, vw, vh):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": vw, "height": vh})
        page.route("**/api/orwell/dossier/*", lambda route: route.fulfill(
            status=200, content_type="application/json", body=__import__("json").dumps(_DOSSIER)))
        page.goto(_app, wait_until="domcontentloaded")
        page.wait_for_function("() => window.OrwellDossier && window.OrwellWindowKit && window.OrwellSlots")
        page.evaluate("() => window.OrwellDossier.open('hg1')")
        page.wait_for_selector("#orwell-dossier #od-name:not(:empty)", timeout=15000)
        page.wait_for_timeout(500)  # image decode + the slot re-stack
        _check(page.evaluate(_MEASURE, "orwell-dossier"), f"dossier {vw}x{vh}")
        # a viewport shrink re-clamps (the kit's resize path)
        if vw > 600:
            page.set_viewport_size({"width": max(500, vw // 2), "height": max(500, vh // 2)})
            # the re-clamp is rAF-debounced and a 4K software-rendered frame is slow: poll, never a fixed sleep
            page.wait_for_function(
                "() => { const r = document.getElementById('orwell-dossier').getBoundingClientRect();"
                " return r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1; }", timeout=10000)
            _check(page.evaluate(_MEASURE, "orwell-dossier"), f"dossier shrunk from {vw}x{vh}")
            page.set_viewport_size({"width": vw, "height": vh})
            page.wait_for_timeout(300)
        # the knowledge window (the wall) through its own button
        opened = page.evaluate("""() => { const b = document.getElementById('sidebar-memory-btn');
          if (!b) return false; b.click(); return true; }""")
        if opened:
            page.wait_for_selector("#orwell-memory", timeout=15000)
            page.wait_for_timeout(400)
            _check(page.evaluate(_MEASURE, "orwell-memory"), f"knowledge {vw}x{vh}")
        browser.close()


def test_empty_send_shows_no_native_validation(_app):
    """The empty send must never surface the browser's native validation bubble."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1920, "height": 1080})
        page.goto(_app, wait_until="domcontentloaded")
        page.wait_for_selector("#message", state="attached")
        res = page.evaluate("""() => {
          const ta = document.getElementById('message');
          const form = document.getElementById('chat-form');
          const btn = document.querySelector('.send-btn');
          let invalid = 0;
          document.addEventListener('invalid', () => { invalid++; }, true);
          ta.value = '';
          if (btn) btn.click();
          return { novalidate: !!(form && form.noValidate), required: ta.required, invalid,
                   reported: ta.validity ? ta.validity.valueMissing : false };
        }""")
        browser.close()
    assert res["novalidate"], f"#chat-form must carry novalidate: {res}"
    assert not res["required"] and not res["reported"], f"the composer must not report native validity: {res}"
    assert res["invalid"] == 0, f"an empty send fired a native invalid event (the bubble): {res}"
