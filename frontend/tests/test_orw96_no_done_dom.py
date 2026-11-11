"""ORW-96 (A57b): RENDERED-DOM proof of the no-[DONE] failure UX. test_fault_probe_no_done.py pins the chat.js source; this drives the real page in Chromium and asserts what the player SEES when a reply
stream ends without the `[DONE]` sentinel: a quiet `.msg-system` notice (never a Game-Master `.msg-ai`/`.role` bubble), a visible Retry control, and no phantom GM bubble.

The SSE/fetch reader path is where the `_streamSawDone` latch lives (the WS leg has no such throw), so this reuses the F3 stack (ORWELL_WS_TRANSPORT=0, real FE + engine) and replaces the `/api/chat_stream` response
in the browser with SSE text that simply ENDS: (1) after some partial narration, (2) with nothing at all. Roles only; the LLM is never called."""
from __future__ import annotations

import json

import pytest

from test_f3_drop_after_saved_no_recovery import _post_form, _send_first_message, _stack  # noqa: F401

pytestmark = pytest.mark.browser

PROBE = """() => { const box = document.getElementById('chat-history');
  const vis = e => !(e.style && e.style.display === 'none');
  const ai = Array.from(box.querySelectorAll('.msg.msg-ai')).filter(vis);
  const sys = Array.from(box.querySelectorAll('.msg.msg-system')).filter(vis);
  return { ai: ai.map(e => ({ role: ((e.querySelector('.role')||{}).textContent||'').trim(), text: e.textContent.replace(/\\s+/g,' ').trim() })),
           sys: sys.map(e => ({ hasRole: !!e.querySelector('.role'), text: e.textContent.replace(/\\s+/g,' ').trim() })),
           retry: Array.from(box.querySelectorAll('.stream-drop-retry button')).map(b => b.textContent.trim()) }; }"""

PARTIAL = "The house goes quiet, and then"


def _drive(stack, tag, body):
    from playwright.sync_api import sync_playwright
    fbase = stack["fe"]
    sess = _post_form(fbase, "/api/session", {"name": tag, "model": "stub-narrator", "skip_validation": "true", "endpoint_id": stack["endpoint_id"]}).get("id")
    assert sess, "could not create the FE chat session"
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(fbase + "/", wait_until="load", timeout=30000)
        page.wait_for_function("() => !!(window.sessionModule && window.sessionModule.loadSessions && window.sessionModule.selectSession && window.sessionModule.getCurrentSessionId)", timeout=15000)
        page.evaluate("async () => { try { await window.sessionModule.loadSessions(); } catch (_) {} }")
        page.wait_for_function("(sid) => { const sm = window.sessionModule; if (sm.getCurrentSessionId() === sid) return true; try { sm.selectSession(sid); } catch (_) {} return false; }", arg=sess, timeout=25000)
        page.wait_for_timeout(2500)
        page.route("**/api/chat_stream", lambda r: r.fulfill(status=200, content_type="text/event-stream", body=body))
        before = page.evaluate(PROBE)
        _send_first_message(page, "I step into the house.")
        snap = None
        for _ in range(80):
            page.wait_for_timeout(150)
            snap = page.evaluate(PROBE)
            if snap["retry"]:
                page.wait_for_timeout(1500)  # let any settle/reconcile run before judging the final DOM
                snap = page.evaluate(PROBE)
                break
        ws_active = page.evaluate("() => !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive())")
        browser.close()
    assert ws_active is False, "expected the SSE/fetch reader path (ORWELL_WS_TRANSPORT=0)"
    return before, snap


def _assert_failure_ux(before, snap):
    """The no-output drop: nothing was narrated, so the whole turn is a system notice."""
    assert snap["retry"] == ["Retry"], f"a Retry control must be rendered: {json.dumps(snap)}"
    assert snap["sys"], f"the failure must be a .msg-system notice: {json.dumps(snap)}"
    assert all(not s["hasRole"] for s in snap["sys"]), f"the system notice must carry no GM .role: {json.dumps(snap)}"
    assert len(snap["ai"]) == len(before["ai"]), f"no phantom GM bubble may remain for the dropped turn: {json.dumps(snap['ai'])}"


def test_stream_ending_without_done_after_partial_text_keeps_one_bubble_with_a_retry_and_no_raw_error(_stack):  # noqa: F811
    """A drop AFTER real narration: the auto-continue nudges run out (the wire keeps dropping), leaving the text that really streamed plus an honest Retry - never a raw `Error:` typed into the narrator, never a
    second phantom bubble, and (the pre-fix state) never an empty chat where the settle reconcile erased everything."""
    body = 'data: {"delta": "%s "}\n\n' % PARTIAL
    before, snap = _drive(_stack, "orw96-partial", body)
    assert snap["retry"] == ["Retry"], f"a Retry control must be rendered: {json.dumps(snap)}"
    assert len(snap["ai"]) == len(before["ai"]) + 1, f"exactly one bubble holds the dropped turn: {json.dumps(snap['ai'])}"
    text = snap["ai"][-1]["text"]
    assert PARTIAL in text and "Error:" not in text, f"the real partial stands, with no raw error typed into the narrator: {text!r}"


def test_stream_ending_without_done_and_with_no_output_renders_system_notice_and_retry_not_a_gm_bubble(_stack):  # noqa: F811
    _assert_failure_ux(*_drive(_stack, "orw96-empty", ""))
