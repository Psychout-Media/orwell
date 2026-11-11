"""Issue #834 — received (assistant) messages inconsistently show a timestamp.

Root cause (verified by trace, chatRenderer.js + chat.js):
  Role + timestamp was gated on the turn's FIRST ROUND (strictly `r === 0`):
    chatRenderer.js  wrap.className = 'msg msg-ai' + (r > 0 ? ' msg-continuation' : '')
                     if (r === 0) roleEl.appendChild(roleTimestamp(...))
    chat.js          the agent_step continuation bubble was ALWAYS `msg-continuation` with no
                     per-round timestamp.
  When round 0 is a HIDDEN tool-call (e.g. getGameState — no visible body), the first VISIBLE
  bubble is a later round, so it rendered as a continuation with NO timestamp.

The fix (BOTH paths, kept consistent):
  Attach role + timestamp to the FIRST VISIBLE bubble of a turn, not strictly round 0.
    - chatRenderer.js (reload): a `renderedFirstVisible` flag; the first rendered bubble owns the
      header (role + timestamp) and is NOT a continuation.
    - chat.js (live): a `turnHeaderShown` flag; when the round-0 header bubble is hidden (pure
      tool-only round), the next continuation bubble is PROMOTED to the header (role + timestamp).

The reload path is an LLM-stub-blind render path (the #822 / #873 lesson), so the runtime gate
drives the REAL chatRenderer.addMessage over a multi-round metadata payload whose round 0 is a
hidden tool-call — it FAILS on pre-fix main (no timestamp, continuation) and PASSES after.

Run: cd frontend && .venv/bin/python -m pytest tests/test_834_first_visible_bubble_timestamp.py
"""

import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


# ─────────────────────────────────────────────────────────────────────────────
# Source pins — the fix legs can't silently regress (cheap, no browser).
# ─────────────────────────────────────────────────────────────────────────────

def test_reload_path_uses_first_visible_not_round_zero():
    js = _read("static/js/chatRenderer.js")
    # The header/timestamp gate must no longer be the strict `r === 0`.
    assert "renderedFirstVisible" in js, (
        "#834: chatRenderer must track the FIRST VISIBLE bubble (renderedFirstVisible), "
        "not gate role+timestamp on r === 0."
    )
    # The continuation class + the timestamp append both key off the first-visible flag.
    assert "const isFirstVisible = !renderedFirstVisible;" in js
    assert "(isFirstVisible ? '' : ' msg-continuation')" in js, (
        "#834: the first visible bubble must NOT be a continuation; later bubbles are."
    )
    assert "if (isFirstVisible) roleEl.appendChild(roleTimestamp(" in js, (
        "#834: the timestamp must attach to the first VISIBLE bubble."
    )
    # The old strict-round-zero gate is gone.
    assert "if (r === 0) roleEl.appendChild(roleTimestamp(" not in js, (
        "#834: the old `r === 0` timestamp gate must be replaced."
    )


def test_live_path_keeps_the_turn_header_on_the_one_coalesced_bubble():
    # #829 turn-coalescing SUPERSEDES the old #834 live-path mechanism: rather than minting a
    # fresh per-round CONTINUATION bubble and PROMOTING it to header when round 0 was a hidden
    # tool-call, the live path now renders ALL rounds into the ONE turn bubble. That bubble is
    # created up front WITH its role + `.role-timestamp` header, so the #834 invariant (the first
    # visible bubble carries a timestamp even when round 0 is a hidden tool-call) holds by
    # construction — the header can never be lost because the bubble is never replaced.
    js = _read("static/js/chat.js")
    # The one turn bubble carries the role + timestamp header at creation.
    # ORW-259: the creation-time stamp comes from `_stampSpanHtml(roleTs)`, which always emits a `.role-timestamp` span (the in-world moment when
    # a game bubble is on screen, the neutral wall clock otherwise).
    assert '${_stampSpanHtml(roleTs)}</div><div class="body"></div>`;\n      holder._requestedModel' in js, (
        "#834/#829: the ONE turn bubble must carry a .role-timestamp header at creation."
    )
    assert "return '<span class=\"role-timestamp\">' + wallClock + '</span>';" in js and 'class="role-timestamp role-timestamp-moment"' in js, (
        "ORW-259: the stamp helper must always emit a .role-timestamp span."
    )
    # Rounds coalesce into that bubble (no per-round bubble, no promotion machinery).
    assert "_turnCoalesced" in js and "_commitRoundSegment" in js, (
        "#829: the live path coalesces rounds into the one turn bubble."
    )
    # A pure-tool round may hide the bubble (tool_start empty-branch); the next round UN-HIDES
    # the same bubble — so its header + timestamp become visible, never a promoted new bubble.
    assert "if (roundHolder && roundHolder.style.display === 'none') roundHolder.style.display = '';" in js, (
        "#829: a hidden pure-tool round is re-shown as the SAME (header-bearing) bubble."
    )
    # The obsolete per-round promotion machinery is gone (it minted the timestamp-losing
    # continuation bubble #834 originally worked around).
    assert "turnHeaderShown" not in js and "newWrap" not in js, (
        "#829: the pre-coalescing per-round bubble + turnHeaderShown promotion must be gone."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL chatRenderer.addMessage reload path in headless chromium.
# ─────────────────────────────────────────────────────────────────────────────

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
        stdout=open(f"/tmp/fe-834-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-834-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(1)
    proc.terminate()
    raise RuntimeError("server never became ready")


# An assistant turn whose ROUND 0 is a hidden tool-call (empty round text, a tool event on round 1)
# and whose first VISIBLE narration lands on round 2. addMessage renders the multi-round timeline.
_HARNESS = r"""
async () => {
  const chat = window.chatModule;
  if (!chat || !chat.addMessage) return { error: 'chatModule.addMessage missing' };
  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };
  box.innerHTML = '';

  // round_texts: [r0 EMPTY (hidden tool-call), r1 the first VISIBLE narration]
  const metadata = {
    timestamp: '2026-06-27T15:30:00.000Z',
    round_texts: ['', 'The houseguests gather in the living room.'],
    tool_events: [{ round: 1, tool: 'getGameState', command: 'getGameState', output: '{}' }],
  };
  chat.addMessage('assistant', '', 'test-model', metadata);

  // The first VISIBLE assistant bubble (skip display:none rows).
  const aiEls = Array.from(box.querySelectorAll('.msg.msg-ai'))
    .filter(el => !(el.style && el.style.display === 'none'))
    .filter(el => (el.querySelector('.body')?.textContent || '').trim().length > 0);
  if (!aiEls.length) return { error: 'no visible assistant bubble rendered' };
  const first = aiEls[0];
  return {
    firstHasTimestamp: !!first.querySelector('.role .role-timestamp'),
    firstIsContinuation: first.classList.contains('msg-continuation'),
    visibleBubbles: aiEls.length,
  };
}
"""


def test_first_visible_bubble_gets_timestamp_when_round0_is_hidden_toolcall():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")

    env = dict(os.environ)
    env.setdefault("AUTH_ENABLED", "false")
    env.setdefault("ORWELL_GAME_BUILD", "1")
    port = _free_port()
    proc = None
    try:
        proc, base = _boot(env, port)
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as e:
                pytest.skip(f"chromium unavailable: {e}")
            page = browser.new_page()
            page.goto(base + "/", wait_until="load", timeout=30000)
            page.wait_for_timeout(3500)  # module graph + async init
            result = page.evaluate(_HARNESS)
            browser.close()
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()

    assert not result.get("error"), result.get("error")
    # #829 coalescing: this turn (round 0 a hidden tool-call, round 1 the first narration) renders
    # as EXACTLY one visible bubble — the whole point of coalescing.
    assert result["visibleBubbles"] == 1, (
        f"expected exactly ONE visible bubble (coalesced turn), got {result['visibleBubbles']}"
    )
    assert result["firstHasTimestamp"], (
        "#834: the first VISIBLE bubble must carry a .role-timestamp even when round 0 "
        "was a hidden tool-call."
    )
    assert not result["firstIsContinuation"], (
        "#834: the first VISIBLE bubble must NOT be a msg-continuation."
    )
