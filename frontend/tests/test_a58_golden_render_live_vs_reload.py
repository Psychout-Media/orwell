"""A58 (#1413 R2, test-first) - the GOLDEN-RENDER harness: the SAME assistant turn rendered through the LIVE SSE path (chat.js, as the sender sees it settle) and through the RELOAD path (chatRenderer.js, after a
page reload) must produce the same bubble. Real engine + real FE + a scripted stub narrator + a real Chromium; the turn is sent through the real UI. The two renders are compared after normalizing what legitimately
differs (ids, seq, timestamps, avatars, spinners): wrapper classes, child structure, the role label, the body text, the footer actions, the reasoning accordion, tool-beat chips.

Every KNOWN drift is a strict xfail with the drift named (it XPASSes -> red the day it is fixed, so the xfail is deleted deliberately). Shared-concern enumeration (the DoR): reply/reasoning split · tool-beat chips
· beat outcome · OOC asides · role relabel · decision card. Covered here: reply/reasoning split, OOC aside, markdown, paragraphs, a tool-beat turn. NOT covered yet (need a pending decision / a ceremony beat in
the loop): the decision card and the beat-outcome line. Needs the built engine bundle + chromium (skips cleanly without; the A41 guard turns that skip red in CI). Roles only."""
from __future__ import annotations

import json
import re
import threading

import pytest

from test_m0_3_midgen_join import STUB, _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _session

pytestmark = pytest.mark.browser

SNAP = """() => { const box = document.getElementById('chat-history'); const ai = Array.from(box.querySelectorAll('.msg.msg-ai')).filter(e => e.style.display !== 'none'); const e = ai[ai.length-1]; if (!e) return null;
  const c = e.cloneNode(true); c.querySelectorAll('svg,.ow-chatface,.role-timestamp,.spinner-container').forEach(x => x.remove());
  const body = c.querySelector('.body'); const think = e.querySelector('.thinking-section, .thinking-content');
  return { n: ai.length, cls: e.className.split(/\\s+/).sort().join(' '), kids: Array.from(e.children).map(k => k.className.split(/\\s+/).sort().join(' ')),
    role: ((e.querySelector('.role')||{}).textContent||'').replace(/\\s+/g,' ').trim().replace(/Week \\d+( . [A-Za-z ]+)+$/, '').replace(/\\d{1,2}:\\d{2}\\s?[AP]M$/i, '').trim(),
    body: (body ? body.textContent : '').replace(/\\s+/g,' ').trim(),
    bodyBlocks: body ? Array.from(body.querySelectorAll('p,li,strong,em,ul,ol,pre,code,blockquote')).map(n => n.tagName.toLowerCase()) : [],
    footer: Array.from(e.querySelectorAll('.msg-footer button')).map(b => b.dataset.action || b.title),
    thinking: !!think, thinkingText: think ? think.textContent.replace(/\\s+/g,' ').trim() : '',
    chips: Array.from(e.querySelectorAll('[class*=tool-beat],[class*=toolbeat],[class*=beat-chip]')).map(n => n.className.split(/\\s+/).sort().join(' ')),
    // ORW-264: the thread chips (agent-thread-node) - class (minus live-only transients) + label text; shared builder orwellBeatNodeView
    threadNodes: Array.from(box.querySelectorAll('.agent-thread-node')).map(n => n.className.split(/\\s+/).filter(c => !/^(running|open|ow-ceremony-reveal)$/.test(c)).sort().join(' ') + ' | ' + n.querySelector('.agent-thread-header').textContent.replace(/\\s+/g,' ').trim()) }; }"""

# (id, stub entries, text that MUST be in the bubble on both paths - proves the scripted turn reached the page, not a guard/scene-cut replacement)
CASES = [
    ("plain-reply", [{"deltas": ["The kitchen hums. ", "Someone laughs. ", "A door opens. ", "Footsteps."], "delay": 0.4}], "Footsteps."),
    ("reasoning-channel-split", [{"reasoning": ["Let me think about the house. "], "deltas": ["The kitchen hums. ", "Someone laughs."], "delay": 0}], "Someone laughs."),
    ("markdown", [{"deltas": ["**Bright idea.** ", "They say:\n\n- apples\n- pears\n\n", "*Quietly.*"], "delay": 0}], "Bright idea."),
    ("paragraphs", [{"deltas": ["First paragraph.\n\n", "Second paragraph.\n\n", "Third."], "delay": 0}], "Second paragraph."),
    ("ooc-producer-aside", [{"deltas": ["((Production: ", "the house ", "is settling ", "in.))"], "delay": 0.4}], "settling in"),
    ("ooc-complete-first-delta", [{"deltas": ["((Production: the house is settling in.)) "], "delay": 1.5}], "settling in"),
    # A72 - the clock's three narrated surfaces: a production cut-in mid-reply, a hang-out stop line (the model calls hangOut, then voices where it stopped), the premiere champagne toast.
    ("clock-production-cutin", [{"deltas": ["You trade a few words by the sink. ", "((Production: it is noon - the Head of Household competition is about to begin.)) ", "Everyone drifts toward the backyard."], "delay": 0.2}], "about to begin"),
    ("clock-hangout-stop", [{"tool_calls": [{"name": "hangOut", "args": {}}]}, {"deltas": ["You lose track of the hours on the couch, until a houseguest sits down beside you and says they need a word."], "delay": 0}], "need a word"),
    ("clock-premiere-toast", [{"deltas": ["Glasses clink as the whole house gathers for the toast.\n\n", "*To the first night,* someone says, and the room cheers."], "delay": 0.2}], "first night"),
    ("tool-beat-turn", [{"tool_calls": [{"name": "whereabouts", "args": {}}]}, {"deltas": ["You glance around the room."], "delay": 0}], "glance around"),
]


# A88: the live turn bubble first shows a WAIT label (the spinner copy: "Responding", or the orwellToolBeats _WAIT_COPY lines), not reply text. A poll that takes that for the "first paint of the reply" compares a
# placeholder shell (always a plain `msg msg-ai streaming`) with the reload - the source of the old "ooc class lands a state late" xfails (A88 drift 3), which was a HARNESS artifact, not a render drift.
_WAIT_LABEL = re.compile(r"^(Responding|The (house is in motion|producers are)|The feeds are rolling|Cameras are still rolling)")


def _send_and_snapshot(stack, entries, text, hold=False):
    from playwright.sync_api import sync_playwright
    sid = _session(stack, "a58-" + text[:6])
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_context().new_page()
        page.goto(stack["fe"] + "/", wait_until="load")
        page.wait_for_timeout(2500)
        before = page.evaluate(SNAP)
        base_n = before["n"] if before else 0
        # ORW-251f: only the plain-reply case holds - it paints text DURING the stream. A producer aside is held behind the spinner until the stream FINISHES and paints whole then, so holding it just burned ~20s of the loop (and
        # left too little time to settle on a loaded runner); `mid` for those is the first frame with reply text, with or without the footer.
        # ORW-251b: `hold` makes the first-paint check DETERMINISTIC. The stub holds the final entry's stream open (before finish) on a gate until the test has observed the streaming paint, so a slow CI
        # runner can no longer let the whole turn settle before the sampler sees an unsettled bubble. The gate is released as soon as `mid` is captured (or after ~20s, so a real failure fails the assertion, not the stub).
        gate = threading.Event() if hold else None
        if gate is not None and entries:
            entries[-1]["gate"] = gate
        for en in entries:
            STUB.script.append(en)
        # ORW-251d: send, then CONFIRM the user bubble landed; on a loaded CI runner the first Enter can be swallowed (onboarding scrim / composer not yet armed) and the turn never starts, which showed up as "the live turn
        # never settled". Retry the send once if no user bubble appears (the stub script is only consumed by a request that reached it, so a resend is safe).
        _users = "() => document.querySelectorAll('#chat-history .msg.msg-user').length"
        users_before = page.evaluate(_users)
        for _attempt in (1, 2):
            page.fill("#message", text)
            page.keyboard.press("Enter")
            try:
                page.wait_for_function("(n) => document.querySelectorAll('#chat-history .msg.msg-user').length > n", arg=users_before, timeout=10000)
                break
            except Exception:  # noqa: BLE001 - the send did not register; try once more
                continue
        live = None
        mid = None
        # ORW-251: sample the first paint IN the page, once per painted frame (rAF), instead of from Python at ~150ms. Under CI load the Python-side evaluate() calls stall past the whole streaming window,
        # the poll never sees an unsettled bubble, and `mid` stays None (the flake). The in-page loop sees every painted frame, so it cannot miss a stream that lasts more than a frame.
        page.evaluate("""([snap, base, waitSrc]) => { window.__mid = null; const fn = eval(snap); const wait = new RegExp(waitSrc);
          const tick = () => { if (window.__mid) return; let s = null; try { s = fn(); } catch (e) {}
            if (s && s.n > base && s.body && !wait.test(s.body)) { window.__mid = s; return; } requestAnimationFrame(tick); };
          requestAnimationFrame(tick); }""", [SNAP, base_n, _WAIT_LABEL.pattern])
        for _ in range(240):
            page.wait_for_timeout(150)
            if gate is not None and not gate.is_set():
                if mid is not None or page.evaluate("window.__mid") or _ >= 130:
                    gate.set()
            live = page.evaluate(SNAP)
            if live and live["n"] <= base_n:
                continue  # the previous turn's bubble is still the last one - wait for THIS turn's
            if live and live["body"] and not _WAIT_LABEL.match(live["body"]) and mid is None:
                mid = live  # first paint of the reply (body has text). ORW-251c: NOT gated on "no footer" - a producer aside paints whole and the footer lands in the same step (measured: footer present while the stream is still held)
            if live and live["footer"]:
                break
        if gate is not None:
            gate.set()
        assert live and live["n"] > base_n, f"the live turn never produced a NEW bubble (n={live and live['n']}, base_n={base_n}); the old bubble's footer must not count as 'settled'"
        assert live and live["footer"], f"the live turn never settled (no footer): last={json.dumps({k: (live or {}).get(k) for k in ('n', 'cls', 'body', 'footer')})[:300]} base_n={base_n} users={page.evaluate(_users)}/{users_before} stub_left={len(STUB.script)}"
        mid = mid or page.evaluate("window.__mid")
        page.reload(wait_until="load")
        page.wait_for_timeout(3500)
        reloaded = page.evaluate(SNAP)
        browser.close()
    return live, reloaded, mid


@pytest.mark.parametrize("case_id,entries,expect", CASES, ids=[c[0] for c in CASES])
def test_live_and_reload_render_the_same_bubble(_stack, case_id, entries, expect):  # noqa: F811
    live, reloaded, mid = _send_and_snapshot(_stack, [dict(e) for e in entries], f"Golden render {case_id}")
    assert reloaded is not None, "the reload rendered no assistant bubble"
    # not vacuous: the scripted turn really reached the page on BOTH paths (a guard's scene-cut line would also be 'equal')
    assert expect in live["body"], f"{case_id}: the scripted text never reached the live bubble: {live['body'][:160]!r}"
    assert expect in reloaded["body"], f"{case_id}: the scripted text is missing after reload: {reloaded['body'][:160]!r}"
    if case_id == "reasoning-channel-split":
        assert "Let me think" not in live["body"] and "Let me think" not in reloaded["body"], "reasoning must never reach the public bubble, live or reloaded"
    if case_id == "ooc-producer-aside":
        assert "msg-ooc" in live["cls"] and "msg-ooc" in reloaded["cls"], "the OOC aside is classed on BOTH paths"
    live = {k: v for k, v in live.items() if k != "n"}
    reloaded = {k: v for k, v in reloaded.items() if k != "n"}
    assert json.dumps(live, sort_keys=True) == json.dumps(reloaded, sort_keys=True), f"LIVE != RELOAD for {case_id}:\nlive   ={json.dumps(live, sort_keys=True)}\nreload ={json.dumps(reloaded, sort_keys=True)}"


# ── first paint: the STREAMING bubble vs the reload ────────────────────────────────────────────────────────────────────
# The settled live bubble is converged through the history reconcile, so it equals the reload by construction. The drift that bit players (#828: OOC asides rendered as normal bubbles until a refresh) only exists
# WHILE streaming. Compare what must already hold at first paint: the wrapper classes and the role label. (The footer and the full text legitimately arrive only at settle.)
STREAMING_CASES = [
    pytest.param(*[c for c in CASES if c[0] == "plain-reply"][0], id="plain-reply"),
    # A88 drift 3 was a HARNESS artifact (see _WAIT_LABEL): the old poll took the spinner's wait-label shell for the reply's first paint. Measured on the real reply paint, the producer aside's class and text land in the SAME
    # synchronous step (chat.js `_renderStream` calls applyOocClass before the first renderer.update, and a still-open `((` aside is HELD behind the spinner and painted whole + classed at once) - for both a complete-in-first-delta
    # aside and a slowly streamed one. Plain passing tests now; if the live path ever paints aside text before the class, these go red.
    pytest.param(*[c for c in CASES if c[0] == "ooc-complete-first-delta"][0], id="ooc-complete-first-delta"),
    pytest.param(*[c for c in CASES if c[0] == "ooc-producer-aside"][0], id="ooc-producer-aside"),
]


@pytest.mark.parametrize("case_id,entries,expect", STREAMING_CASES)
def test_first_paint_of_the_streaming_bubble_matches_the_reload(_stack, case_id, entries, expect):  # noqa: F811
    live, reloaded, mid = _send_and_snapshot(_stack, [dict(e) for e in entries], f"First paint {case_id}", hold=(case_id == "plain-reply"))
    assert mid is not None, "the streaming bubble never painted before settle (the stub should be slow enough)"
    # A88 (from the CI MutationObserver trace): the live bubble is created with a TRANSIENT `streaming` class (spinner/skeleton) that the reload never has - by design, normalised here.
    _norm = lambda c: " ".join(x for x in c.split() if x != "streaming")  # noqa: E731
    assert _norm(mid["cls"]) == _norm(reloaded["cls"]), f"{case_id}: wrapper classes at first paint differ from the reload: {mid['cls']!r} vs {reloaded['cls']!r}"
    # A88 drift 2 was a MEASUREMENT artifact, not a render drift: the avatar-initials chip ("PR") is attached by orwellChatFaces.js's MutationObserver in a queued MICROTASK, so a MutationObserver callback
    # (what the CI trace used) sees the bare "Production" one microtask early, while every painted frame (and this harness's polling) already reads "PRProduction", exactly like the reload. No normalisation needed.
    assert mid["role"] == reloaded["role"], f"{case_id}: role label at first paint differs from the reload: {mid['role']!r} vs {reloaded['role']!r}"
