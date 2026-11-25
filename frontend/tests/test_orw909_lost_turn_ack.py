"""ORW-909 - casting stall: a first casting turn whose `turn` ack never reaches the page left the composer on Stop for good, and every later message queued.

Live run 2026-11-25 (dev, Fable's week-1 playtest): the casting turns after the first reply got no answer. The server's journal shows the player's 3rd and 9th messages were never received
until the page was reloaded (their client message ids are 18 and 5 minutes older than their arrival), and the page screenshot shows the Stop face plus a "the producers are talking it over"
spinner holder still up after the reply had been written. The send path awaits the `turn` up-frame's ack (`OrwellWs.sendTurnWhenLive`, a request with NO timeout): the turn's `finally`
(which resets `isStreaming`, the Stop face and drains the send outbox) only runs once that await ends. When the ack never arrives - a frame lost or held on the way - the run itself still
streams and finishes, but the page never settles: `_flushSendOutbox` returns at `if (chatState.isStreaming)` for ever.

This pins the contract at the page: a lost ack must not strand the page. Real engine (casting, no game started) + FE + scripted stub narrator + Chromium; the lost ack is simulated by
swallowing the first `turn` ack on the page's socket. Roles only.
"""
from __future__ import annotations

import time

import pytest

from test_m0_3_midgen_join import STUB, _boot_stack
from test_p0h_day1_clock_e2e import _session
from test_orw191_golden_flows import AI_BUBBLE, _count_containing, _launch, _open, _wait_settled

pytestmark = pytest.mark.browser

# Swallow the first N `turn` acks (`{t:"ack", ch:"chat", d:{accepted:true}}`) the page's socket receives. Installed before any page script runs.
_DROP_ACK_INIT = """
(() => {
  const Native = window.WebSocket;
  const desc = Object.getOwnPropertyDescriptor(Native.prototype, 'onmessage');
  window.__dropTurnAcks = 0;
  window.__droppedTurnAcks = 0;
  function Wrapped(url, protocols) {
    const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    let user = null;
    Object.defineProperty(ws, 'onmessage', {
      configurable: true,
      get() { return user; },
      set(fn) {
        user = fn;
        desc.set.call(ws, function (ev) {
          if (window.__dropTurnAcks > 0 && typeof ev.data === 'string') {
            let f = null;
            try { f = JSON.parse(ev.data); } catch (_) {}
            if (f && f.t === 'ack' && f.ch === 'chat' && f.d && f.d.accepted === true) {
              window.__dropTurnAcks -= 1; window.__droppedTurnAcks += 1;
              return;
            }
          }
          return fn ? fn.call(ws, ev) : undefined;
        });
      },
    });
    return ws;
  }
  Wrapped.prototype = Native.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { Wrapped[k] = Native[k]; });
  window.WebSocket = Wrapped;
})();
"""


@pytest.fixture()
def _casting_stack():
    yield from _boot_stack(create_game=False)


def _type_once(page, text):
    """One typed send (no harness retry: a retry would hide a composer stuck busy behind the very bug this pins)."""
    # (the stub feed lists as offline, so onboarding's "no feed" gate can hold the composer for a few probe ticks after load)
    page.wait_for_function("() => { const m = document.querySelector('#message'); return !!m && !m.disabled; }", timeout=90000)
    page.click("#message")
    page.fill("#message", text)
    page.keyboard.press("Enter")


def _state(page):
    return page.evaluate("""() => { const btn = document.querySelector('.send-btn'); const cm = window.chatModule, sm = window.sessionModule;
      const cur = sm && sm.getCurrentSessionId && sm.getCurrentSessionId();
      return { mode: btn && btn.getAttribute('data-mode'), live: !!(cm && cm.hasActiveStream && cm.hasActiveStream(cur)),
               holders: document.querySelectorAll('#chat-history .msg-ai.streaming').length,
               dropped: window.__droppedTurnAcks || 0 }; }""")


def test_a_lost_turn_ack_never_strands_the_composer(_casting_stack):
    from _ws_turn_driver import ws_turn

    stack = _casting_stack
    fbase = stack["fe"]
    sid = _session(stack, "o909-casting")
    opener = "Welcome to casting, start with your name."
    STUB.script.append({"deltas": [opener], "delay": 0})
    ws_turn(fbase, sid, "(Production cue - begin the casting interview now.)", timeout=120)
    deadline = time.time() + 15
    import json
    import urllib.request
    while time.time() < deadline:
        with urllib.request.urlopen(fbase + "/api/orwell/game-session", timeout=15) as r:
            if json.loads(r.read() or b"{}").get("sessionId") == sid:
                break
        time.sleep(0.3)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = _launch(pw)
        ctx = b.new_context()
        ctx.add_init_script(_DROP_ACK_INIT)
        page = _open(b, stack, ctx)
        page.wait_for_function("(id) => window.sessionModule && window.sessionModule.getCurrentSessionId() === id", arg=sid, timeout=20000)
        _wait_settled(page, opener)
        # The stub endpoint lists as offline with no models, which holds onboarding's "no feed" gate on the composer. On the live box the narrator model is listed. Stand in for that the
        # way test_orw352 does: treat the model list as not loaded yet and arm a direct chat on the default feed, then let the session list converge back onto the casting chat.
        page.evaluate("""async () => { const dc = await (await fetch('/api/default-chat')).json();
          if (window.modelsModule) window.modelsModule.getCachedItems = () => [];
          window.sessionModule.createDirectChat(dc.endpoint_url, dc.model, dc.endpoint_id);
          await window.sessionModule.loadSessions(); }""")
        page.wait_for_function("(id) => window.sessionModule.getCurrentSessionId() === id", arg=sid, timeout=20000)
        _wait_settled(page, opener)

        reply = "Good name. Now tell me where you are from, o909-a."
        STUB.script.append({"deltas": [reply], "delay": 0.1})
        page.evaluate("() => { window.__dropTurnAcks = 1; }")
        _type_once(page, "My name is the player. I read rooms before I speak.")
        _wait_settled(page, reply)
        assert _state(page)["dropped"] == 1, "the test could not lose the turn ack (setup problem, not the bug)"

        # The run finished on the server. The page must settle within seconds: no Stop face, no live stream, no spinner holder.
        end = time.time() + 20
        st = _state(page)
        while time.time() < end and (st["live"] or st["holders"] or st["mode"] in ("stop", "cancel", "streaming")):
            page.wait_for_timeout(250)
            st = _state(page)
        assert not st["live"] and st["holders"] == 0 and st["mode"] not in ("stop", "cancel", "streaming"), f"a lost turn ack stranded the page on Stop: {st}"
        assert _count_containing(page, AI_BUBBLE, reply) == 1

        # And the NEXT message goes out at once (not held in the outbox behind a stream that never ends).
        reply2 = "Ohio, noted. What is your tell, o909-b?"
        STUB.script.append({"deltas": [reply2], "delay": 0})
        _type_once(page, "From Ohio. I keep everyone's secrets.")
        _wait_settled(page, reply2)
        b.close()
