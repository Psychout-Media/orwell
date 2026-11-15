"""F1 (concurrent-session consistency — the causal-inversion fix), behavioral browser gate.

The observer/mirror window's run buffer now LEADS with the prompting `user_message` event, so the
shared renderer (`chatModule.renderObserverUserMessage`) places the player's message AHEAD of the
reply holder — cause-before-effect at EVERY frame, not just at settle. Both live consumers (the SSE
`resumeStream` reader and the WS `_onWsChatFrame` splice) call this exact renderer with the reply
holder as `beforeEl`, so this in-page gate over the REAL renderer proves the transport-agnostic core.

Deterministic + browser-real (the #822 lesson — never a hand-rolled JS re-impl): boot the real FE,
plant the reply holder the observer's resume/ws path mounts, then drive the REAL renderer with a
synthetic leading user event and assert:
  * the user bubble lands BEFORE the reply holder (DOM order = cause before effect);
  * it is dedup-idempotent by clientMsgId — a second delivery (at-least-once replay) never duplicates;
  * the sender's ALREADY-present optimistic bubble is ADOPTED (stamped {id, seq}), not re-rendered.

Roles only — a generic player line, no cast names.
"""
from __future__ import annotations

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
        stdout=open(f"/tmp/fe-f1order-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-f1order-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-f1order-"), "app.db"),
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


# In-page harness: exercise the REAL renderer as the OBSERVER path does — a reply holder is already
# mounted (what resumeStream / the ws splice put up), then the leading user event arrives.
_OBSERVER_HARNESS = r"""
() => {
  const chat = window.chatModule;
  const sess = window.sessionModule;
  if (!chat || !chat.renderObserverUserMessage) return { error: 'renderObserverUserMessage missing' };
  if (sess && sess.setCurrentSessionId) sess.setCurrentSessionId('f1-order-session');

  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };
  box.innerHTML = '';

  // The OBSERVER mounts the AI reply holder FIRST (resumeStream/_wsEnsureRound), then the leading
  // user_message event arrives. Plant that holder.
  const holder = document.createElement('div');
  holder.className = 'msg msg-ai';
  holder.innerHTML = '<div class="role">Production</div><div class="body"><div class="stream-content"></div></div>';
  box.appendChild(holder);

  const ev = { type: 'user_message', id: 'u1', seq: 3,
               content: 'I take a lap through the house.', clientMsgId: 'cid-1', role: 'user' };

  // First delivery — renders the user bubble BEFORE the reply holder.
  chat.renderObserverUserMessage(ev, { beforeEl: holder });
  // Second delivery (at-least-once replay) — must be a dedup no-op.
  chat.renderObserverUserMessage(ev, { beforeEl: holder });

  const kids = Array.from(box.children);
  const userEls = box.querySelectorAll('.msg.msg-user');
  const userEl = userEls[0] || null;
  const userIdx = userEl ? kids.indexOf(userEl) : -1;
  const holderIdx = kids.indexOf(holder);
  return {
    userBubbleCount: userEls.length,
    userBeforeReply: userIdx >= 0 && holderIdx >= 0 && userIdx < holderIdx,
    userDbId: userEl && userEl.dataset ? (userEl.dataset.dbId || null) : null,
    userClientId: userEl && userEl.dataset ? (userEl.dataset.clientMsgId || null) : null,
    userSeq: userEl && userEl.dataset ? (userEl.dataset.seq || null) : null,
    userText: userEl ? (userEl.textContent || '').trim() : '',
  };
}
"""

# Sender path: the optimistic user bubble already exists; the leading event must ADOPT it, never dupe.
_SENDER_HARNESS = r"""
() => {
  const chat = window.chatModule;
  const sess = window.sessionModule;
  if (!chat || !chat.renderObserverUserMessage) return { error: 'renderObserverUserMessage missing' };
  if (sess && sess.setCurrentSessionId) sess.setCurrentSessionId('f1-order-session');

  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };
  box.innerHTML = '';

  // The SENDER already painted its optimistic user bubble (clientMsgId, no db id yet), then the reply
  // holder. The leading user_message event carries the authoritative {id, seq}.
  const optimistic = document.createElement('div');
  optimistic.className = 'msg msg-user';
  optimistic.dataset.clientMsgId = 'cid-9';
  optimistic.innerHTML = '<div class="body">I talk a little game with them.</div>';
  box.appendChild(optimistic);
  const holder = document.createElement('div');
  holder.className = 'msg msg-ai';
  holder.innerHTML = '<div class="body"><div class="stream-content"></div></div>';
  box.appendChild(holder);

  const ev = { type: 'user_message', id: 'u9', seq: 5,
               content: 'I talk a little game with them.', clientMsgId: 'cid-9', role: 'user' };
  chat.renderObserverUserMessage(ev, { beforeEl: holder });

  const userEls = box.querySelectorAll('.msg.msg-user');
  return {
    userBubbleCount: userEls.length,
    adoptedDbId: optimistic.dataset.dbId || null,
    adoptedSeq: optimistic.dataset.seq || null,
    sameNode: userEls.length === 1 && userEls[0] === optimistic,
  };
}
"""


def _run(page_url, harness):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(page_url + "/", wait_until="load", timeout=30000)
        app_ready(page, names=("chatModule", "sessionModule"))
        result = page.evaluate(harness)
        browser.close()
    return result


def test_observer_renders_user_bubble_before_the_reply_and_dedups(_app):
    res = _run(_app, _OBSERVER_HARNESS)
    assert "error" not in res, res.get("error")
    # Exactly ONE user bubble despite the double (at-least-once) delivery.
    assert res["userBubbleCount"] == 1, f"expected 1 user bubble, got {res['userBubbleCount']} (dedup failed)"
    # THE GATE: cause before effect — the user bubble precedes the reply holder in the DOM.
    assert res["userBeforeReply"], "the observer's user bubble must render BEFORE the reply holder"
    # Stamped with the authoritative keys so the settle reconcile adopts it with zero churn.
    assert res["userDbId"] == "u1"
    assert res["userClientId"] == "cid-1"
    assert res["userSeq"] == "3"
    assert "lap through the house" in res["userText"]


def test_sender_adopts_its_optimistic_bubble_no_duplicate(_app):
    res = _run(_app, _SENDER_HARNESS)
    assert "error" not in res, res.get("error")
    # The optimistic bubble is ADOPTED, never re-rendered — still exactly one, and the SAME node.
    assert res["userBubbleCount"] == 1, f"sender must not duplicate its bubble, got {res['userBubbleCount']}"
    assert res["sameNode"], "the leading event must adopt the SAME optimistic node, not create a new one"
    assert res["adoptedDbId"] == "u9", "the authoritative db id must be stamped onto the optimistic bubble"
    assert res["adoptedSeq"] == "5", "the authoritative seq must be stamped onto the optimistic bubble"
