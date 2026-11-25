"""ORW-352 - casting: after the first reply the page stayed busy and every later message queued forever (live run 2026-11-13, Overseer A).

Root cause: a STRAY pending New Chat. Onboarding opens the interview by clicking New Chat, whose real handler is async (it awaits the leave-game probe) and arms the pending
chat (sessionModule.createDirectChat) late. When that probe is slower than onboarding's 1.5 s wait, the producers' opener has ALREADY materialized the casting session, the server
has bound it as the canonical game chat, and the late arm then leaves `_pendingChat` set. loadSessions() converges the window back onto the canonical session (the canonical
wins over a pending chat) but never cleared the pending chat. So the player's first send MATERIALIZED it (a second "Casting interview" row, POST /api/session), the send's holder
was keyed to that new row, the following loadSessions() switched the window back to the canonical session mid-send, and the run (routed server-side to the canonical session)
painted a second holder. The first holder never settled, the page kept an active stream, and every later message sat in the outbox as QUEUED.

The DOM contract only. Real engine (casting, no game started) + FE + scripted stub narrator + Chromium; no model, no money. Roles only.
"""
from __future__ import annotations

import json
import time
import urllib.request

import pytest

from test_m0_3_midgen_join import STUB, _boot_stack
from test_p0h_day1_clock_e2e import _session
from test_orw191_golden_flows import AI_BUBBLE, _count_containing, _launch, _open, _send, _wait_settled

pytestmark = pytest.mark.browser


@pytest.fixture()  # ORW-864: a stack PER ATTEMPT. It was module-scoped, so a pytest rerun reused the stack whose canonical binding (first-writer-wins) the failed first attempt had already set: the rerun could never bind its own new session and failed "never bound the canonical game chat" by construction, hiding the first attempt's real failure.
def _casting_stack():
    yield from _boot_stack(create_game=False)


def _get(base, path):
    with urllib.request.urlopen(base + path, timeout=15) as r:
        return json.loads(r.read() or b"{}")


def _session_ids(base):
    body = _get(base, "/api/sessions")
    rows = body if isinstance(body, list) else (body.get("sessions") or body.get("items") or [])
    return sorted(r.get("id") for r in rows if isinstance(r, dict))


def _page_state(page):
    return page.evaluate("""() => { const cm = window.chatModule, sm = window.sessionModule; const cur = sm && sm.getCurrentSessionId && sm.getCurrentSessionId();
      const btn = document.querySelector('.send-btn');
      return { current: cur, pending: !!(sm && sm.hasPendingChat && sm.hasPendingChat()), live: !!(cm && cm.hasActiveStream && cm.hasActiveStream(cur)),
               mode: btn && btn.getAttribute('data-mode'), holders: document.querySelectorAll('#chat-history .msg-ai.streaming').length,
               queued: document.querySelectorAll('#chat-history .msg-user.queued, #chat-history [data-queued="1"]').length }; }""")


def test_a_late_new_chat_arm_never_forks_the_casting_chat_or_strands_the_turn(_casting_stack):
    from _ws_turn_driver import ws_turn

    stack = _casting_stack
    fbase = stack["fe"]
    sid = _session(stack, "o352-casting")
    # The producers' opener on the casting session: binds it as the canonical game chat (first framed casting turn).
    opener = "Welcome to casting, start with your name."
    STUB.script.append({"deltas": [opener], "delay": 0})
    ws_turn(fbase, sid, "(Production cue - begin the casting interview now.)", timeout=120)
    deadline = time.time() + 15
    while time.time() < deadline and _get(fbase, "/api/orwell/game-session").get("sessionId") != sid:
        time.sleep(0.3)
    assert _get(fbase, "/api/orwell/game-session").get("sessionId") == sid, "the casting turn never bound the canonical game chat"

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = _launch(pw)
        page = _open(b, stack)
        page.wait_for_function("(id) => window.sessionModule && window.sessionModule.getCurrentSessionId() === id", arg=sid, timeout=20000)
        _wait_settled(page, opener)

        # The late onboarding arm: New Chat's async handler arms a pending chat AFTER the opener exists, then the session list reloads and converges back onto the canonical chat.
        # (The stub endpoint lists as offline with no models, so the model picker would drop any pending chat on the spot; on the live box the narrator model is listed.
        # Treat the list as not loaded yet - the picker then keeps the pending chat, as it did live.)
        armed = page.evaluate("""async () => { const dc = await (await fetch('/api/default-chat')).json();
          if (window.modelsModule) window.modelsModule.getCachedItems = () => [];
          window.sessionModule.createDirectChat(dc.endpoint_url, dc.model, dc.endpoint_id);
          const armed = window.sessionModule.hasPendingChat();
          await window.sessionModule.loadSessions(); return armed; }""")
        assert armed, "the test could not arm a pending New Chat (setup problem, not the bug)"
        page.wait_for_function("(id) => window.sessionModule.getCurrentSessionId() === id", arg=sid, timeout=20000)
        _wait_settled(page, opener)
        before_ids = _session_ids(fbase)
        st0 = _page_state(page)

        # The live shape: round 1 is ONLY a tool call (0 chars), round 2 is the reply.
        reply = "Good name. Now tell me where you are from, o352-a."
        STUB.script.extend([{"tool_calls": [{"name": "getGameState", "args": {}}]}, {"deltas": [reply], "delay": 0.1}])
        _send(page, "My name is the player. I read rooms before I speak.", len(STUB.script))
        _wait_settled(page, reply)
        end = time.time() + 15
        st = _page_state(page)
        while time.time() < end and (st["live"] or st["holders"] or st["mode"] in ("stop", "cancel")):
            page.wait_for_timeout(200)
            st = _page_state(page)
        assert st["current"] == sid, f"the window left the casting chat mid-send: {st}"
        assert not st["live"] and st["holders"] == 0 and st["mode"] not in ("stop", "cancel"), f"the turn never settled on the page (stuck holder / busy composer): {st}"
        assert _session_ids(fbase) == before_ids, "the first send created a second chat session (the stray pending New Chat was materialized)"
        assert _count_containing(page, AI_BUBBLE, reply) == 1
        assert not st0["pending"], f"the root cause: a pending New Chat survived converging onto the canonical casting chat: {st0}"

        # And the NEXT message goes out (not queued behind a dead stream).
        reply2 = "Ohio, noted. What is your tell, o352-b?"
        STUB.script.append({"deltas": [reply2], "delay": 0})
        _send(page, "From Ohio. I keep everyone's secrets.", len(STUB.script))
        _wait_settled(page, reply2)
        b.close()
