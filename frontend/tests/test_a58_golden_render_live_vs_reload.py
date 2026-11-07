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
import time

import pytest

from test_m0_3_midgen_join import STUB, _stack  # noqa: F401  (the shared real-stack fixture)
from test_p0h_day1_clock_e2e import _session

pytestmark = pytest.mark.browser

SNAP = """() => { const box = document.getElementById('chat-history'); const ai = Array.from(box.querySelectorAll('.msg.msg-ai')).filter(e => e.style.display !== 'none'); const e = ai[ai.length-1]; if (!e) return null;
  const c = e.cloneNode(true); c.querySelectorAll('svg,.ow-chatface,.role-timestamp,.spinner-container').forEach(x => x.remove());
  const body = c.querySelector('.body'); const think = e.querySelector('.thinking-section, .thinking-content');
  return { n: ai.length, cls: e.className.split(/\\s+/).sort().join(' '), kids: Array.from(e.children).map(k => k.className.split(/\\s+/).sort().join(' ')),
    role: ((e.querySelector('.role')||{}).textContent||'').replace(/\\s+/g,' ').trim().replace(/Week \\d+ . [A-Za-z ]+$/, '').replace(/\\d{1,2}:\\d{2}\\s?[AP]M$/i, '').trim(),
    body: (body ? body.textContent : '').replace(/\\s+/g,' ').trim(),
    bodyBlocks: body ? Array.from(body.querySelectorAll('p,li,strong,em,ul,ol,pre,code,blockquote')).map(n => n.tagName.toLowerCase()) : [],
    footer: Array.from(e.querySelectorAll('.msg-footer button')).map(b => b.dataset.action || b.title),
    thinking: !!think, thinkingText: think ? think.textContent.replace(/\\s+/g,' ').trim() : '',
    chips: Array.from(e.querySelectorAll('[class*=tool-beat],[class*=toolbeat],[class*=beat-chip]')).map(n => n.className.split(/\\s+/).sort().join(' ')) }; }"""

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


# ORW-229 flake fix (the most frequent fe-browser-tests flake on 2026-11-06/07, sometimes on every rerun): the first-paint test caught the streaming
# bubble by polling every 150 ms while the stub streamed and then FINISHED on its own clock, so on a loaded runner the whole stream could end between
# two polls ("the streaming bubble never painted before settle"). With first_paint=True the stub holds the stream open after its last delta (a
# threading.Event gate on the scripted entry, test_m0_3_midgen_join's stub) until this poll has captured the streaming bubble, so settle can never
# overtake the capture, however slowly the poll runs. What is captured is unchanged: the same task-level snapshot as before (see A88 drift 2 below).
_GATE_RELEASE_S = 20.0  # a gated poll that has not captured the streaming bubble by then lets the stream finish (the test then fails on `mid`)
_TURN_BUDGET_S = 45.0   # THIS turn must settle within this long after the send, gated or not


def _drive_turn(page, entries, text, base_n, *, gate=None, poll_ms=150, script=None, clock=None):
    """Queue the scripted stub entries, send `text`, and poll until THIS turn's bubble settles. Returns (live, mid, settled).

    `mid` is the first paint of the STREAMING bubble (reply text, not settled yet). With a gate, the stub holds the stream open after its last delta
    until the poll that captures `mid` releases it, or until _GATE_RELEASE_S has passed, whether or not this turn's bubble has appeared. The gate is
    also released on every exit, a send that fails included, so the stub is never left waiting. Deadlines are on `clock`, not a count of polls."""
    script = STUB.script if script is None else script
    clock = clock or time.monotonic
    live = mid = None
    settled = False
    try:
        script.extend(entries)
        page.fill("#message", text)
        page.keyboard.press("Enter")
        sent = clock()
        while clock() - sent < _TURN_BUDGET_S:
            page.wait_for_timeout(poll_ms)
            live = page.evaluate(SNAP)
            fresh = bool(live) and live["n"] > base_n  # THIS turn's bubble; until it appears, the last bubble is the previous turn's
            if fresh and mid is None and not live["footer"] and live["body"] and not _WAIT_LABEL.match(live["body"]):
                mid = live  # first paint of the STREAMING bubble (body has text, not settled yet)
            if gate is not None and not gate.is_set() and (mid is not None or clock() - sent >= _GATE_RELEASE_S):
                gate.set()  # captured (or the deadline passed: let it settle and fail on `mid`): the stub may finish the stream
            if fresh and live["footer"]:
                settled = True
                break
    finally:
        if gate is not None:
            gate.set()  # never leave the stub waiting
    return live, mid, settled


def _send_and_snapshot(stack, entries, text, *, first_paint=False, poll_ms=150):
    from playwright.sync_api import sync_playwright
    gate = threading.Event() if first_paint else None
    if gate is not None:
        [e for e in entries if e.get("deltas")][-1]["gate"] = gate  # the stub holds the stream open after its last delta until we release it
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
        live, mid, settled = _drive_turn(page, entries, text, base_n, gate=gate, poll_ms=poll_ms)
        assert settled, "the live turn never settled (no footer)"
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
    # ORW-244, quarantined under the ORW-229 flaky-test rule on 2026-11-07 (they run nightly): the front-end server holds an aside back until it is
    # complete (agent_loop.py's open-`((` buffer and live-game scrub), so an aside-only reply first reaches the page when the model stream ENDS, a
    # milliseconds-wide window before settle. Gating the stub cannot widen it (nothing is flushed until the stream ends), and the poll misses it on
    # a loaded runner. Card ORW-244: redesign these two cases (and check a one-frame unstyled flash seen on the finalize path).
    pytest.param(*[c for c in CASES if c[0] == "ooc-complete-first-delta"][0], id="ooc-complete-first-delta",
                 marks=pytest.mark.quarantine(card="ORW-244", added="2026-11-07")),
    pytest.param(*[c for c in CASES if c[0] == "ooc-producer-aside"][0], id="ooc-producer-aside",
                 marks=pytest.mark.quarantine(card="ORW-244", added="2026-11-07")),
]
# The cases whose reply paints WHILE the stub is still streaming: only those can be gated (see _send_and_snapshot).
_GATED = {"plain-reply"}


@pytest.mark.parametrize("case_id,entries,expect", STREAMING_CASES)
def test_first_paint_of_the_streaming_bubble_matches_the_reload(_stack, case_id, entries, expect):  # noqa: F811
    gated = case_id in _GATED
    # poll_ms=1000 on purpose for a gated case: the capture must not depend on how often the harness looks (a loaded runner is a slow poller)
    live, reloaded, mid = _send_and_snapshot(_stack, [dict(e) for e in entries], f"First paint {case_id}", first_paint=gated, poll_ms=1000 if gated else 150)
    assert mid is not None, "the streaming bubble never showed reply text before settle, although the stub held the stream open (a render bug)"
    # A88 (from the CI MutationObserver trace): the live bubble is created with a TRANSIENT `streaming` class (spinner/skeleton) that the reload never has - by design, normalised here.
    _norm = lambda c: " ".join(x for x in c.split() if x != "streaming")  # noqa: E731
    assert _norm(mid["cls"]) == _norm(reloaded["cls"]), f"{case_id}: wrapper classes at first paint differ from the reload: {mid['cls']!r} vs {reloaded['cls']!r}"
    # A88 drift 2 was a MEASUREMENT artifact, not a render drift: the avatar-initials chip ("PR") is attached by orwellChatFaces.js's MutationObserver in a queued MICROTASK, so a MutationObserver callback
    # (what the CI trace used) sees the bare "Production" one microtask early, while every painted frame (and this harness's polling) already reads "PRProduction", exactly like the reload. No normalisation needed.
    assert mid["role"] == reloaded["role"], f"{case_id}: role label at first paint differs from the reload: {mid['role']!r} vs {reloaded['role']!r}"


# ── the harness itself (no browser, no stack): a fake page on a fake clock ─────────────────────────────────────────────────────────────────────────
# Review of #2302 (cubic, greptile): the gate must be released on time even when THIS turn's bubble never appears, and on every exit, including a
# send that fails before the poll starts; a turn that never shows up must fail within the poll budget, and the previous turn's settled bubble must
# never count as this turn's settle.
class _FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class _FakePage:
    """Stands in for the Playwright page: wait_for_timeout advances the fake clock, evaluate returns the next scripted snapshot (the last one
    repeats) and records the clock and whether the gate was already released at that poll."""

    def __init__(self, clock, snaps, gate=None, fail_on=None):
        self.clock, self.snaps, self.gate, self.fail_on = clock, list(snaps), gate, fail_on
        self.seen = []
        self.keyboard = self

    def fill(self, _selector, _text):
        if self.fail_on == "fill":
            raise RuntimeError("page closed")

    def press(self, _key):
        if self.fail_on == "press":
            raise RuntimeError("page closed")

    def wait_for_timeout(self, ms):
        self.clock.now += ms / 1000

    def evaluate(self, _js):
        self.seen.append((self.clock.now, self.gate.is_set() if self.gate is not None else None))
        return self.snaps.pop(0) if len(self.snaps) > 1 else self.snaps[0]


_PREVIOUS_TURN = {"n": 1, "footer": ["copy"], "body": "The previous turn."}


@pytest.mark.parametrize("fail_on", ["fill", "press"])
def test_harness_releases_the_gate_when_the_send_itself_fails(fail_on):
    gate, clock = threading.Event(), _FakeClock()
    page = _FakePage(clock, [_PREVIOUS_TURN], gate, fail_on=fail_on)
    with pytest.raises(RuntimeError):
        _drive_turn(page, [{"deltas": ["x"], "gate": gate}], "hi", 1, gate=gate, poll_ms=1000, script=[], clock=clock)
    assert gate.is_set(), "a failed send left the stub's gate closed (the next consumer of the entry would wait 60 s)"


def test_harness_releases_the_gate_on_time_when_this_turn_never_appears():
    gate, clock = threading.Event(), _FakeClock()
    page = _FakePage(clock, [_PREVIOUS_TURN], gate)
    live, mid, settled = _drive_turn(page, [], "hi", 1, gate=gate, poll_ms=1000, script=[], clock=clock)
    assert not settled, "the previous turn's settled bubble was taken for this turn's settle"
    assert mid is None
    released = [t for t, is_set in page.seen if is_set]
    assert released, "the gate was only released on exit, not by the deadline inside the poll loop"
    assert 20 <= released[0] <= 22, f"released at {released[0]} s, not at the 20 s mark"
    assert clock.now <= 60, f"a turn that never appears polled for {clock.now:.0f} s before failing"


def test_harness_releases_the_gate_in_the_poll_that_captures_the_streaming_bubble():
    gate, clock = threading.Event(), _FakeClock()
    snaps = [
        _PREVIOUS_TURN,                                            # this turn's bubble is not there yet
        {"n": 2, "footer": [], "body": "Responding"},              # the spinner's wait label is not reply text
        {"n": 2, "footer": [], "body": "The kitchen hums."},       # first paint of the reply
        {"n": 2, "footer": [], "body": "The kitchen hums. Someone laughs."},
        {"n": 2, "footer": ["copy"], "body": "The kitchen hums. Someone laughs."},
    ]
    page = _FakePage(clock, snaps, gate)
    live, mid, settled = _drive_turn(page, [], "hi", 1, gate=gate, poll_ms=1000, script=[], clock=clock)
    assert settled and live["footer"] and mid["body"] == "The kitchen hums."
    assert [is_set for _, is_set in page.seen] == [False, False, False, True, True], page.seen
