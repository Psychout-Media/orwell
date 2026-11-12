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
        # ORW-293b diagnostics: if the reply is persisted twice, say WHO sent what. Every socket frame the client sends (turn up-frames and their clientMsgIds),
        # the page console, and (below) the server's own history rows are folded into the failure message.
        diag = {"sent": [], "console": []}

        def _on_ws(ws):
            ws.on("framesent", lambda payload: diag["sent"].append(str(payload)[:220]))
        page.on("websocket", _on_ws)
        page.on("console", lambda m: diag["console"].append(m.text[:200]))
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
        dump = page.evaluate("([sel, t]) => Array.from(document.querySelectorAll(sel)).filter(e => (e.textContent||'').includes(t)).map(e => ({cls: e.className, id: e.id, data: Object.assign({}, e.dataset), parent: e.parentElement && e.parentElement.id, html: e.outerHTML.slice(0, 260)}))", [AI_BUBBLE, reply])
        total_ai = page.evaluate("() => Array.from(document.querySelectorAll('#chat-history .msg.msg-ai')).filter(e => e.style.display !== 'none').length")
        try:
            import json as _json, urllib.request as _ur
            sid = page.evaluate("() => window.sessionModule && window.sessionModule.getCurrentSessionId && window.sessionModule.getCurrentSessionId()")
            with _ur.urlopen(f"{_stack['fe']}/api/history/{sid}", timeout=15) as r:
                body = _json.loads(r.read() or b"{}")
            rows = body if isinstance(body, list) else (body.get("messages") or body.get("history") or [])
            diag["rows"] = [{"role": m.get("role"), "seq": (m.get("metadata") or {}).get("seq"), "cid": (m.get("metadata") or {}).get("client_msg_id"),
                             "text": str(m.get("content", ""))[:60]} for m in rows if isinstance(m, dict)]
        except Exception as e:  # diagnostics must never mask the real assertion
            diag["rows"] = f"unavailable: {type(e).__name__}"
        diag["turn_frames"] = [s for s in diag["sent"] if '"t": "turn"' in s or '"t":"turn"' in s]
        browser.close()
    assert not empties, f"an empty .msg-ai bubble existed during the turn: {empties[:3]}"
    assert n_reply == 1, f"reply shown {n_reply} times: {dump}\nDIAG turn up-frames sent={len(diag['turn_frames'])}: {diag['turn_frames']}\nDIAG history rows: {diag.get('rows')}\nDIAG console (last 25): {diag['console'][-25:]}"
    return total_ai


@pytest.mark.parametrize("refresh", [False, True])
def test_tool_first_round_no_empty_bubble(_stack, refresh):  # noqa: F811
    reply = f"You glance around the room, refresh{int(refresh)}."
    script = [{"tool_calls": [{"name": "whereabouts", "args": {}}]}, {"deltas": ["You glance ", f"around the room, refresh{int(refresh)}."], "delay": 0.25}]
    _run(_stack, f"orw139-tool-{int(refresh)}", script, reply, refresh)
