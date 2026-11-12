"""ORW-191 - the GOLDEN FLOWS of today's UI, recorded before the front-end rebuild (React + TypeScript + Vite).

The point is a rebuild acceptance suite: every flow here drives the page through the DOM CONTRACT ONLY (element ids / classes / visible text and the browser's own online-offline switch). It never touches
`window.chatModule`, module internals or source text, so the same file can be pointed at the new front end unchanged; if a flow needs a different hook, the rebuild must provide the contract hook in
docs/FE-GOLDEN-FLOWS.md, not rewrite the flow. Real engine + real FE + the scripted stub narrator + a real Chromium (the shared `_stack` fixture); needs the built engine bundle + chromium (skips cleanly without;
the A41 guard turns that skip red in CI). No model, no money. Roles only.

Flows: (1) send a message (2) stream a reply and settle (3) reload restores the transcript once, in order (4) reload with a queued (offline) message delivers it exactly once (5) a second window mirrors both
the earlier transcript and a new turn without a reload. Confirming a decision card is the sixth golden flow; it is pinned by tests/test_0025_secret_veto_card_e2e.py and tests/test_n12_decision_submit_timeout.py
(real pages, card contract in the doc) rather than duplicated here.
"""
from __future__ import annotations

import pytest

from test_m0_3_midgen_join import STUB, _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _session

pytestmark = pytest.mark.browser

# The DOM contract these flows rely on (mirrored in docs/FE-GOLDEN-FLOWS.md).
COMPOSER = "#message"
USER_BUBBLE = "#chat-history .msg.msg-user"
AI_BUBBLE = "#chat-history .msg.msg-ai"
FOOTER_ACTION = ".msg-footer button"


def _launch(pw):
    try:
        return pw.chromium.launch()
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"chromium unavailable: {e}")


def _texts(page, selector):
    return page.evaluate(
        "(sel) => Array.from(document.querySelectorAll(sel)).filter(e => e.style.display !== 'none')"
        ".map(e => (e.textContent || '').replace(/\\s+/g, ' ').trim())", selector)


def _count_containing(page, selector, needle):
    return sum(1 for t in _texts(page, selector) if needle in t)


def _open(browser, stack, ctx=None):
    page = (ctx or browser.new_context()).new_page()
    page.goto(stack["fe"] + "/", wait_until="load")
    page.wait_for_function(f"() => {{ const m = document.querySelector('{COMPOSER}'); return !!m && !m.disabled; }}", timeout=20000)
    return page


def _send(page, text, expect_consumed_from=None):
    """A deterministic send (the A58/ORW-251g pattern): wait for an enabled composer, type, Enter, and - when the caller says how long the stub script was - confirm the narrator CONSUMED the turn,
    retrying (up to 3 attempts) if the send never reached the server. 'The bubble appeared' is not proof: the optimistic bubble shows even when the request never leaves the page."""
    for _attempt in (1, 2, 3):
        page.wait_for_function(f"() => {{ const m = document.querySelector('{COMPOSER}'); return !!m && !m.disabled; }}", timeout=20000)
        page.click(COMPOSER)
        page.fill(COMPOSER, text)
        page.keyboard.press("Enter")
        if expect_consumed_from is None or _wait_consumed(expect_consumed_from, timeout_s=12):
            return
    raise AssertionError(f"the narrator never consumed the turn after 3 sends: {text!r}")


def _wait_settled(page, reply_text):
    """The golden 'settled' signal: the reply text is in an assistant bubble AND its footer actions exist."""
    try:
        page.wait_for_function(
            """([sel, foot, needle]) => Array.from(document.querySelectorAll(sel)).some(e =>
                (e.textContent || '').includes(needle) && e.querySelectorAll(foot).length > 0)""",
            arg=[AI_BUBBLE, FOOTER_ACTION, reply_text], timeout=40000)
    except Exception:
        diag = page.evaluate("() => Array.from(document.querySelectorAll('#chat-history .msg')).slice(-4).map(e => e.className + ' | footer=' + e.querySelectorAll('.msg-footer button').length + ' | ' + (e.textContent||'').replace(/\\s+/g,' ').slice(0,90))")
        raise AssertionError(f"the reply {reply_text!r} never settled: {diag}")


def _expect_once(page, pairs, what, timeout_s=20):
    """Each (selector, needle) shows EXACTLY once, and stays so for a short hold. A transient doubled bubble while a reload/mirror repaints is tolerated; one that does not converge fails."""
    import time
    end = time.time() + timeout_s
    stable_since = None
    last = None
    while time.time() < end:
        last = [_count_containing(page, sel, needle) for sel, needle in pairs]
        if all(c == 1 for c in last):
            stable_since = stable_since or time.time()
            if time.time() - stable_since >= 0.8:
                return
        else:
            stable_since = None
        page.wait_for_timeout(150)
    raise AssertionError(f"{what}: counts never converged to exactly once: {last} for {pairs}")


def _wait_consumed(n_before, timeout_s=30):
    import time
    end = time.time() + timeout_s
    while time.time() < end:
        if len(STUB.script) < n_before:
            return True
        time.sleep(0.15)
    return False


# ORW-293c: no automatic rerun. Every framed turn lands in the module stack's ONE canonical session, and this test asserts "exactly one" of fixed texts, so a rerun
# after a failed first attempt sees attempt 1's rows and fails for an unrelated reason (the CI "shown 2 times" artifact), hiding the real first failure.
@pytest.mark.flaky(reruns=0)
def test_golden_send_stream_reload_offline_queue_and_mirror(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright

    _session(_stack, "orw191-golden")
    say1, reply1 = "Golden flow one: look around the kitchen.", "The kitchen hums with golden-one."
    say2, reply2 = "Golden flow two: queued while offline.", "A queued line lands as golden-two."
    say3, reply3 = "Golden flow three: from the first window.", "The mirror shows golden-three."
    with sync_playwright() as pw:
        browser = _launch(pw)
        ctx_a = browser.new_context()
        page = _open(browser, _stack, ctx_a)

        # (1) send  +  (2) stream and settle
        STUB.script.append({"deltas": ["The kitchen hums ", "with golden-one."], "delay": 0.2})
        n0 = len(STUB.script)
        _send(page, say1, n0)
        page.wait_for_function(
            "([sel, t]) => Array.from(document.querySelectorAll(sel)).some(e => (e.textContent||'').includes(t))",
            arg=[USER_BUBBLE, say1], timeout=15000)
        assert page.input_value(COMPOSER) == "", "the composer clears once a message is sent"
        _wait_settled(page, reply1)
        _expect_once(page, [(USER_BUBBLE, say1), (AI_BUBBLE, reply1)], "after the live turn")

        # (3) reload restores the transcript once, user before assistant
        page.reload(wait_until="load")
        page.wait_for_function(
            "([sel, t]) => Array.from(document.querySelectorAll(sel)).some(e => (e.textContent||'').includes(t))",
            arg=[AI_BUBBLE, reply1], timeout=30000)
        _expect_once(page, [(USER_BUBBLE, say1), (AI_BUBBLE, reply1)], "after reload")
        order = page.evaluate(
            """([u, a, tu, ta]) => { const box = document.getElementById('chat-history'); const all = Array.from(box.querySelectorAll('.msg'));
              const iu = all.findIndex(e => e.matches('.msg-user') && e.textContent.includes(tu)); const ia = all.findIndex(e => e.matches('.msg-ai') && e.textContent.includes(ta));
              return [iu, ia]; }""", [USER_BUBBLE, AI_BUBBLE, say1, reply1])
        assert 0 <= order[0] < order[1], f"the restored transcript keeps the order (user then reply): {order}"

        # (4) a message queued while OFFLINE survives a reload and is delivered exactly once
        STUB.script.append({"deltas": ["A queued line ", "lands as golden-two."], "delay": 0})
        n1 = len(STUB.script)
        ctx_a.set_offline(True)
        _send(page, say2)
        page.wait_for_function(
            "([sel, t]) => Array.from(document.querySelectorAll(sel)).some(e => (e.textContent||'').includes(t))",
            arg=[USER_BUBBLE, say2], timeout=10000)
        assert len(STUB.script) == n1, "nothing is delivered while the browser is offline"
        ctx_a.set_offline(False)
        page.reload(wait_until="load")
        _wait_settled(page, reply2)
        _expect_once(page, [(USER_BUBBLE, say2), (AI_BUBBLE, reply2)], "queued message after reload + reconnect")
        assert len(STUB.script) == n1 - 1, "the queued message was delivered to the narrator exactly once"

        # (5) a second window mirrors the transcript, then a new turn from window A shows up in B live
        page_b = _open(browser, _stack)
        # window B converges: wait for the WHOLE earlier transcript (history paints in steps), then count
        for sel, needle in ((USER_BUBBLE, say1), (AI_BUBBLE, reply1), (USER_BUBBLE, say2), (AI_BUBBLE, reply2)):
            page_b.wait_for_function(
                "([sel, t]) => Array.from(document.querySelectorAll(sel)).some(e => (e.textContent||'').includes(t))",
                arg=[sel, needle], timeout=30000)
        _expect_once(page_b, [(USER_BUBBLE, say1), (USER_BUBBLE, say2), (AI_BUBBLE, reply1), (AI_BUBBLE, reply2)], "window B mirrors the earlier transcript")
        STUB.script.append({"deltas": ["The mirror shows ", "golden-three."], "delay": 0.1})
        n2 = len(STUB.script)
        _send(page, say3, n2)
        try:
            _wait_settled(page, reply3)
        except Exception:
            diag = page.evaluate("() => Array.from(document.querySelectorAll('#chat-history .msg')).slice(-4).map(e => e.className + ' | ' + (e.textContent||'').replace(/\\s+/g,' ').slice(0,90))")
            raise AssertionError(f"window A never settled turn three: stub_left={len(STUB.script)}/{n2} last={diag}")
        page_b.wait_for_function(
            "([sel, t]) => Array.from(document.querySelectorAll(sel)).some(e => (e.textContent||'').includes(t))",
            arg=[AI_BUBBLE, reply3], timeout=40000)
        _expect_once(page_b, [(USER_BUBBLE, say3), (AI_BUBBLE, reply3)], "window B shows the new turn once")
        browser.close()
