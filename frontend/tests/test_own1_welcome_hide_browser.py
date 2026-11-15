"""OWN-1 (2026-07-14 theme visual audit §9) — the welcome hero vs a streaming transcript,
exercised in a REAL browser.

Source pins live in tests/test_own1_welcome_hide.py; this lane proves the behavior in
headless chromium against the booted game-build app:

  1. an empty chat shows the hero (`.chat-container.welcome-active` + visible
     #welcome-screen);
  2. a bubble mounted DIRECTLY into #chat-history — exactly the casting-stream shape
     (`msg msg-ai streaming`, appended without addMessage, the way chat.js's streaming
     holder and the hidden-cue casting kickoff mount) — hides the hero;
  3. a showWelcomeScreen() racing the live render is suppressed while the transcript has
     content (no hero ghosting through the translucent bubbles);
  4. a genuinely empty chat gets its welcome back.

Auto-marked ``browser`` by conftest (sync_playwright). No fixture names — roles only.
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
        stdout=open(f"/tmp/fe-own1-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-own1-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-own1-"), "app.db"),
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
  const out = {};
  const cc = document.getElementById('chat-container');
  const ws = document.getElementById('welcome-screen');
  const box = document.getElementById('chat-history');
  if (!cc || !ws || !box) return { error: 'missing chat nodes' };
  const heroUp = () => cc.classList.contains('welcome-active') && !ws.classList.contains('hidden');
  const heroDown = () => !cc.classList.contains('welcome-active') && ws.classList.contains('hidden');
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  // Baseline: a genuinely EMPTY chat shows the hero (drive the canonical show on a cleared
  // transcript so the assert is independent of whatever the boot ladder last toggled).
  box.innerHTML = '';
  window.chatModule.showWelcomeScreen();
  await tick(40);
  out.emptyChatShowsHero = heroUp();

  // The casting stream's exact mount shape: a live holder appended DIRECTLY to
  // #chat-history (never through addMessage — the hidden-cue user bubble is suppressed).
  const holder = document.createElement('div');
  holder.className = 'msg msg-ai streaming';
  holder.innerHTML = '<div class="role">role</div><div class="body">streaming body</div>';
  box.appendChild(holder);
  await tick(80); // let the childList observer fire
  out.heroHiddenOnDirectStreamMount = heroDown();

  // A show call racing the live render must stay suppressed while content exists —
  // the ghosting the owner screenshot caught.
  window.chatModule.showWelcomeScreen();
  await tick(40);
  out.showSuppressedOverContent = heroDown();

  // Clearing back to a genuinely empty chat restores the welcome.
  box.innerHTML = '';
  window.chatModule.showWelcomeScreen();
  await tick(40);
  out.emptyChatRestoresHero = heroUp();
  return out;
}
"""


def test_welcome_hero_hides_for_streamed_content_and_returns_on_empty(_app):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(_app, wait_until="domcontentloaded")
        page.wait_for_function(
            "() => window.chatModule && typeof window.chatModule.showWelcomeScreen === 'function'"
        )
        res = page.evaluate(_HARNESS)
        browser.close()

    assert res.get("error") is None, res
    assert res["emptyChatShowsHero"], f"empty chat must show the hero: {res}"
    assert res["heroHiddenOnDirectStreamMount"], \
        f"a directly-mounted streaming bubble (the casting-stream path) must hide the hero: {res}"
    assert res["showSuppressedOverContent"], \
        f"showWelcomeScreen must never paint the hero over a non-empty transcript: {res}"
    assert res["emptyChatRestoresHero"], f"a genuinely empty chat must get its welcome back: {res}"
