"""F-5 / N-10 (playtest blocker) - a finished turn must never leave a header-only (empty) assistant bubble.

Evidence: /home/ryne/orwell-playtest/run-20261103-1447/shots/t015.png and run-20261103-0520/shots/t021.png - an empty "Production
HH:MM" bubble (header, no text, no actions) sits directly above the real reply, on (nearly) every turn of the game phase. The empty
bubble is a holder that mounted for a pure-tool / pre-resolved round and was never filled; coalescing un-hides it at `agent_step`.

The fix is structural, not a hunt for one mounting path: `pruneEmptyAssistantBubbles(box)` removes any assistant bubble with NO body
content (no text, no media, no live-stream/spinner/thinking/Retry chrome, not streaming, not a persisted row), and runs at the end of
every stream and at the end of every history reconcile. These tests drive the REAL helper in headless chromium and pin the wiring.

Run: cd frontend && .venv/bin/python -m pytest tests/test_f5_empty_assistant_bubble.py
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


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


# -- source pins: the helper exists and is wired at BOTH choke points --------------------------------

def test_helper_is_defined_and_exposed():
    rec = _read("static/js/chatReconcile.js")
    assert "export function isEmptyAssistantBubble(" in rec
    assert "export function pruneEmptyAssistantBubbles(" in rec
    chat = _read("static/js/chat.js")
    assert "_pruneEmptyAssistantBubbles: pruneEmptyAssistantBubbles" in chat, "exposed on chatModule for the browser gate"


def test_pruned_at_stream_end_and_after_reconcile():
    chat = _read("static/js/chat.js")
    fin = chat[chat.index("    } finally {\n      clearResponseTimeout();"):]
    fin = fin[:fin.index("\n    }\n", 200)]
    assert "pruneEmptyAssistantBubbles(" in fin, "the stream-end finally must sweep empty assistant bubbles"
    rec = _read("static/js/chatReconcile.js")
    body = rec[rec.index("export async function softReloadHistory"):]
    assert "pruneEmptyAssistantBubbles(" in body, "softReloadHistory must sweep empty assistant bubbles"


# -- runtime: drive the REAL helper in headless chromium ----------------------------------------------

def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-f5-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-f5-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(1)
    proc.terminate()
    raise RuntimeError("server never became ready")


@pytest.fixture(scope="module")
def _app():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(
        os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true",
        PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-f5-"), "app.db"),
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
  const chat = window.chatModule;
  if (!chat || !chat._pruneEmptyAssistantBubbles) return { error: 'chatModule._pruneEmptyAssistantBubbles missing' };
  const box = document.getElementById('chat-history');
  box.innerHTML = '';
  const mk = (cls, bodyHtml, data) => {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (data) Object.assign(d.dataset, data);
    d.innerHTML = '<div class="role">Production</div><div class="body">' + bodyHtml + '</div>';
    box.appendChild(d);
    return d;
  };
  mk('msg-user', 'I grab a seat', null);
  mk('msg-ai', '', null).id = 'empty-1';                                         // the F-5 bubble: header only
  mk('msg-ai', '   \n  ', null).id = 'empty-ws';                                  // whitespace-only is empty too
  mk('msg-ai', '<p>The water hits the wall.</p>', null).id = 'real';               // a real reply
  mk('msg-ai streaming', '', null).id = 'live-streaming';                          // a live holder still filling
  mk('msg-ai', '<div class="spinner-wave">...</div>', null).id = 'live-spinner';   // a holder showing its spinner
  mk('msg-ai', '<div class="retry-row"><button>Retry</button></div>', null).id = 'retry';  // the clean-empty-turn Retry
  mk('msg-ai', '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">', null).id = 'media';  // an image-only bubble
  mk('msg-ai', '', { dbId: 'srv-1' }).id = 'persisted-empty';                      // a persisted row is the server's call
  mk('msg-ai', '<div class="thinking-section" style="display:none"><div class="thinking-content">hidden debug</div></div>', null).id = 'hidden-accordion';
  const removed = chat._pruneEmptyAssistantBubbles(box);
  const ids = Array.from(box.querySelectorAll('.msg-ai')).map(e => e.id);
  const again = chat._pruneEmptyAssistantBubbles(box);
  return { removed, ids, again };
}
"""


def test_prunes_exactly_the_empty_assistant_bubbles(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        page.wait_for_timeout(3500)
        r = page.evaluate(_HARNESS)
        browser.close()
    assert "error" not in r, r.get("error")
    # gone: the header-only bubble, the whitespace-only one, and the one holding only a HIDDEN debug accordion
    assert "empty-1" not in r["ids"] and "empty-ws" not in r["ids"] and "hidden-accordion" not in r["ids"], r
    # kept: real reply, live/streaming holder, spinner holder, Retry, media, persisted row
    for keep in ("real", "live-streaming", "live-spinner", "retry", "media", "persisted-empty"):
        assert keep in r["ids"], f"{keep} must NOT be pruned: {r}"
    assert r["removed"] == 3, r
    assert r["again"] == 0, "idempotent: a second sweep removes nothing"
