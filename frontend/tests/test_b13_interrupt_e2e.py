"""B13 - an event that comes DUE mid-conversation interrupts the NEXT reply, end to end (real engine + real FE chat route + a scripted fake narrator that calls no tools).

Ryne's rule: production owns the schedule; when the clock reaches the event's hour while the player is still chatting, production calls everyone - the next reply must carry that cut-in (the
engine-decided `PRODUCTION CALLS EVERYONE` steer reaches the narrator), NOT a reply that ignores it, and not a moment earlier. The fake narrator calls no tools, so the FE's own timed-ceremony
belt must move the engine. And a "hang out until something happens" stops ON the due event, never past it. Roles only. Needs the built engine bundle; browser lane (serial).
"""
from __future__ import annotations

import json

import pytest

from test_m0_3_midgen_join import STUB, _post_form, _post_json, _stack  # noqa: F401
from test_p0h_day1_clock_e2e import MESSAGES_TO_NOON, STEP, _engine, _schedule, _send, _session, _start_day

pytestmark = pytest.mark.browser

CUT_IN = "IT IS TIME: the HOH competition is starting NOW"  # the engine-decided cut-in line the narrator is handed when the event is due (it names the event)


def _handed(since: int) -> str:
    """Everything the narrator was handed (all game-turn requests) since request index `since`, as one lowercase-free string."""
    with STUB.lock:
        reqs = list(STUB.requests[since:])
    return "\n".join(json.dumps(r.get("messages") or []) for r in reqs if r.get("stream") and r.get("tools"))


def _count() -> int:
    with STUB.lock:
        return len(STUB.requests)


def _fresh(stack, name):
    r = _post_json(stack["fe"], "/api/orwell/new-game", {"playerName": "P", "confirm": True}, timeout=120)
    assert r.get("started"), r
    sid = _session(stack, name)
    _start_day(stack, sid)
    return sid


def test_due_event_cut_in_reaches_exactly_the_reply_it_comes_due_on(_stack):  # noqa: F811
    sid = _fresh(_stack, "b13-cutin")
    for i in range(1, MESSAGES_TO_NOON):  # messages 1..47: the HOH is NOT yet due
        mark = _count()
        _send(_stack, sid, f"Plain chat line {i}.", f"b13-m{i}")
        s, _ = _schedule(_stack)
        assert s["due"] is False, f"due too early after message {i}: {s}"
        assert CUT_IN not in _handed(mark), f"the due-event cut-in reached the narrator early, on message {i}"
    before, _ = _schedule(_stack)
    assert before["minutesUntil"] == STEP

    mark = _count()
    _send(_stack, sid, "Plain chat line 48.", "b13-m48")  # message 48: the clock reaches the HOH hour DURING this conversation
    handed = _handed(mark)
    assert CUT_IN in handed, "the reply the event came due on was handed NO production cut-in (it would ignore the interruption)"
    assert "production calls the whole house" in handed, "the cut-in must say production calls the house together"

    # the narrator called no tools: the FE's own timed-ceremony belt is what moved the engine
    after, st = _schedule(_stack)
    moved = (after is None) or after.get("next") != "hoh-competition" or bool(st.get("pending")) or st.get("phase") != "hoh-competition"
    assert moved, f"the due HOH never fired (the fake narrator made no tool calls, so only the FE belt could): schedule={after} phase={st.get('phase')} pending={bool(st.get('pending'))}"


def test_hangout_until_something_happens_stops_on_the_due_event(_stack):  # noqa: F811
    sid = _fresh(_stack, "b13-hang")
    for i in range(1, MESSAGES_TO_NOON - 2):  # 45 messages: leave 15 minutes on the clock
        _send(_stack, sid, f"Plain chat line {i}.", f"b13h-m{i}")
    s, _ = _schedule(_stack)
    assert 0 < s["minutesUntil"] <= 3 * STEP + 1 and s["due"] is False, s
    hang = _engine(_stack, "hangOut")
    assert hang.get("stopReason") == "event-due", f"the hang-out must stop ON the due event: {hang}"
    assert (hang.get("minutes") or 0) <= s["minutesUntil"], f"the hang-out ran past the event: {hang} vs {s}"
    after, _ = _schedule(_stack)
    assert after["due"] is True, f"the event must be due when the hang-out stops: {after}"
