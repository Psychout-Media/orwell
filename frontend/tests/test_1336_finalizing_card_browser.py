"""#1336 residual (3) — the gate-wait UX card, exercised in a REAL browser.

During the #1313 house-entry hold the createCharacter tool return is held for the whole
authoring wait; chat.js now paints the "Production is finalizing your casting…" card at
``tool_start`` (source-pinned in test_1336_gate_residuals.py). This lane proves the card itself
in headless chromium: it mounts INLINE in the transcript (never a modal), carries the holding
copy and a polite live-region, is idempotent across the tool_start paint + the tool_output
re-paint (never two cards), and clears cleanly on end().

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
        stdout=open(f"/tmp/fe-1336-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-1336-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-1336-"), "app.db"),
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
  const fin = window._orwellFinalizing;
  if (!fin || !fin.begin || !fin.end) return { error: '_orwellFinalizing missing' };
  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };

  // The gate-wait paint (tool_start) …
  fin.begin();
  const el1 = document.getElementById('orwell-finalizing');
  const afterBegin = {
    present: !!el1,
    inTranscript: !!(el1 && box.contains(el1)),
    role: el1 ? el1.getAttribute('role') : null,
    ariaLive: el1 ? el1.getAttribute('aria-live') : null,
    text: el1 ? (el1.textContent || '') : '',
  };

  // … plus the tool_output re-paint must be idempotent (never two cards stacked).
  fin.begin();
  const count = document.querySelectorAll('#orwell-finalizing').length;

  // The first narration token clears it.
  fin.end();
  const afterEnd = !!document.getElementById('orwell-finalizing');

  // end() is safe when nothing is showing (the finally safety net can double-fire).
  fin.end();

  return { afterBegin, countAfterDoubleBegin: count, presentAfterEnd: afterEnd };
}
"""


def test_finalizing_card_renders_holds_and_clears(_app):
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        app_ready(page)
        result = page.evaluate(_HARNESS)
        browser.close()

    assert "error" not in result, result.get("error")

    ab = result["afterBegin"]
    assert ab["present"], "begin() must mount the finalizing card"
    assert ab["inTranscript"], "the card mounts INLINE in #chat-history — never a modal"
    assert ab["role"] == "status" and ab["ariaLive"] == "polite", \
        "the holding copy must be a polite live-region"
    assert "Production is finalizing your casting" in ab["text"], \
        "the holding copy must show during the gate wait"

    assert result["countAfterDoubleBegin"] == 1, \
        "the tool_start paint + tool_output re-paint must never stack two cards"
    assert result["presentAfterEnd"] is False, "end() must clear the card"
