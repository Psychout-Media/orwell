"""ORW-139 - an empty Production bubble must never appear above the narrator's reply (casting interview, prod).

The server produced no empty round, so the page made the bubble. The DOM contract only: send a turn whose first round ends in a tool call (the common casting shape), optionally with a mid-stream
history/session refresh, and sample EVERY DOM mutation: at no instant may a visible empty `.msg-ai` bubble exist while the turn runs or after it settles, and the turn ends with exactly one reply bubble.
Real engine + FE + scripted stub narrator + Chromium; no model, no money.
"""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import STUB, _stack  # noqa: F401
from test_p0h_day1_clock_e2e import _session
from test_orw191_golden_flows import AI_BUBBLE, _launch, _open, _send, _wait_settled, _count_containing

pytestmark = pytest.mark.browser

# Installed before the send: records the first moment any visible, textless, non-streaming-spinner .msg-ai exists (empty = no text and no child other than role/body shell).
_SAMPLER = """() => {
  window.__empties = [];
  const probe = (why) => {
    document.querySelectorAll('#chat-history .msg.msg-ai').forEach(e => {
      if (e.style.display === 'none') return;
      const body = e.querySelector('.body');
      const txt = ((body ? body.textContent : e.textContent) || '').replace(/\\s+/g, '');
      const hasThread = !!e.querySelector('.agent-thread-node, .thinking, details, .agent-thinking-dots, .typing, .spinner');
      if (!txt && !hasThread) window.__empties.push({why, cls: e.className, html: e.outerHTML.slice(0, 300), t: Math.round(performance.now())});
    });
  };
  new MutationObserver(() => probe('mut')).observe(document.getElementById('chat-history'), {childList: true, subtree: true, characterData: true, attributes: true});
  setInterval(() => probe('tick'), 25);
}"""


def _run(_stack, tag, script, reply, refresh):
    from playwright.sync_api import sync_playwright
    _session(_stack, tag)
    with sync_playwright() as pw:
        browser = _launch(pw)
        page = _open(browser, _stack)
        page.evaluate(_SAMPLER)
        STUB.script.extend(script)
        n0 = len(STUB.script) + 0
        if refresh:
            page.evaluate("""() => { window.__poke = setInterval(() => { fetch('/api/sessions').catch(()=>{}); }, 30); }""")
        _send(page, f"Interview line for {tag}.", n0)
        if refresh:
            # mid-stream session-list refresh + history reselect, the way the sidebar does
            for _ in range(6):
                page.evaluate("() => { try { const a = document.querySelector('.list-item.active-session'); if (a) a.click(); } catch (e) {} }")
                page.wait_for_timeout(120)
        _wait_settled(page, reply)
        page.wait_for_timeout(1200)
        empties = page.evaluate("() => window.__empties")
        n_reply = _count_containing(page, AI_BUBBLE, reply)
        total_ai = page.evaluate("() => Array.from(document.querySelectorAll('#chat-history .msg.msg-ai')).filter(e => e.style.display !== 'none').length")
        browser.close()
    assert not empties, f"an empty .msg-ai bubble existed during the turn: {empties[:3]}"
    assert n_reply == 1, f"reply shown {n_reply} times"
    return total_ai


@pytest.mark.parametrize("refresh", [False, True])
def test_tool_first_round_no_empty_bubble(_stack, refresh):  # noqa: F811
    reply = f"You glance around the room, refresh{int(refresh)}."
    script = [{"tool_calls": [{"name": "whereabouts", "args": {}}]}, {"deltas": ["You glance ", f"around the room, refresh{int(refresh)}."], "delay": 0.25}]
    _run(_stack, f"orw139-tool-{int(refresh)}", script, reply, refresh)
