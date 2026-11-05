"""P0h - the Day-1 clock END TO END through the real FE chat route (the strongest proof before a human plays).

Real engine (dist/main.js, defaults) + real FE (`POST /api/chat_stream`) + a scripted OpenAI-compatible stub as the FAKE NARRATOR: it streams a short plain reply and calls NO tools,
so a turn's only engine side effect is what the FE itself does (the per-message `noteMessage` announcement). The REAL order is exercised: the FIRST chat turn arrives while the day does
not exist yet (the clock is dormant), THEN the day-break advances run (the model's `advanceGame`), then 48 plain messages follow. Reads go through the engine's `getGameState`
`daySchedule` (minutesUntil / due - the very gate the FE and hang-out read).

Proves: (1) the day starts at exactly 8:00 (HOH due in 240 min) - the day-break costs no message; (2) every plain message advances the clock exactly 5 minutes; (3) no turn errors
(no 409 stale-beat, no streamed error); (4) the HOH comes due on the 48th message after the day start and not on the 47th; (5) a retry carrying the same clientMsgId bills nothing;
(6) a hang-out between two messages leaves no free message (the next one still costs 5). Roles only. Needs the built engine bundle (skips cleanly without it); browser lane = serial,
because the stack shares frontend/data state with the other real-stack pins.
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request

import pytest

from test_m0_3_midgen_join import STUB, _post_form, _post_json, _stack  # noqa: F401  (the shared real-stack fixture)

pytestmark = pytest.mark.browser

MESSAGES_TO_NOON = 48   # 240 minutes / 5 minutes per message, counted from the 8:00 day start
STEP = 5


def _engine(stack, name, args=None):
    r = _post_json(stack["engine"], "/player/call", {"name": name, "args": args or {}})
    assert "result" in r, f"{name} -> {r}"
    return r["result"]


def _schedule(stack):
    st = _engine(stack, "getGameState")
    return st.get("daySchedule"), st


def _send(stack, session, text, client_msg_id):
    """One plain player message through the REAL chat route; returns the full streamed body."""
    data = urllib.parse.urlencode({"message": text, "session": session, "client_msg_id": client_msg_id}).encode()
    req = urllib.request.Request(stack["fe"] + "/api/chat_stream", data=data, method="POST",
                                 headers={"content-type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=120) as r:
        assert r.status == 200
        body = r.read().decode("utf-8", "replace")
    low = body.lower()
    assert "event: error" not in low, f"the turn streamed an error: {body[:400]}"
    assert "stale-beat" not in low, f"stale-beat on a turn: {body[:400]}"
    return body


def _session(stack, name):
    sid = _post_form(stack["fe"], "/api/session", {
        "name": name, "model": "stub-narrator", "skip_validation": "true", "endpoint_id": stack["endpoint_id"],
    }).get("id")
    assert sid, "could not create the FE chat session"
    return sid


def _start_day(stack, session):
    """Real order: first chat turn (the day does not exist yet), then the day-break advances."""
    assert _schedule(stack)[0] is None, "the clock must be dormant before the day starts"
    _send(stack, session, "Hello house, settling in.", "p0h-first")
    sched, _ = _schedule(stack)
    first_message_effect = sched  # what the very first message did to the (dormant) clock
    for _ in range(80):
        sched, _ = _schedule(stack)
        if sched is not None:
            break
        adv = _engine(stack, "advanceGame")
        assert not adv.get("pending"), f"unexpected player decision before the day started: {json.dumps(adv['pending'])[:300]}"
    sched, st = _schedule(stack)
    assert sched is not None, f"the day never started: phase={st.get('phase')} tod={st.get('timeOfDay')} keys={sorted(st)[:60]}"
    return sched, first_message_effect


def test_day1_48_plain_messages_through_the_real_chat_route(_stack):  # noqa: F811
    sid = _session(_stack, "p0h-day1")
    sched, first_effect = _start_day(_stack, sid)
    assert first_effect is None, f"the first message (before the day exists) must leave the clock dormant, got {first_effect!r}"
    assert sched["next"] == "hoh-competition" and sched["phase"] == "afternoon"
    assert sched["minutesUntil"] == 240, f"the day must start at exactly 8:00 (240 min to noon), got {sched}"
    assert sched["due"] is False

    for i in range(1, MESSAGES_TO_NOON + 1):
        _send(_stack, sid, f"Plain chat line {i}.", f"p0h-m{i}")
        s, _ = _schedule(_stack)
        assert s["minutesUntil"] == max(0, 240 - STEP * i), f"after message {i}: {s}"
        assert s["due"] is (i == MESSAGES_TO_NOON), f"due flag after message {i}: {s}"

    # (5) a retry of an already-billed clientMsgId bills nothing
    before, _ = _schedule(_stack)
    _send(_stack, sid, "Plain chat line 48.", f"p0h-m{MESSAGES_TO_NOON}")
    after, _ = _schedule(_stack)
    assert after == before, "a retry carrying the same clientMsgId must bill nothing"


def test_hangout_between_two_messages_leaves_no_free_message(_stack):  # noqa: F811
    # a fresh season through the FE's own sanctioned restart door, then the real order again
    r = _post_json(_stack["fe"], "/api/orwell/new-game", {"playerName": "P", "confirm": True}, timeout=120)
    assert r.get("started"), r
    sid = _session(_stack, "p0h-hang")
    _start_day(_stack, sid)
    _send(_stack, sid, "One.", "p0h-h1")
    mid, _ = _schedule(_stack)
    hang = _engine(_stack, "hangOut")
    after_hang, _ = _schedule(_stack)
    assert (hang.get("minutes") or 0) > 0, f"the hang-out must spend time: {hang}"
    _send(_stack, sid, "Two.", "p0h-h2")
    nxt, _ = _schedule(_stack)
    assert after_hang["minutesUntil"] - nxt["minutesUntil"] == STEP, \
        f"the message after a hang-out must still cost {STEP} min: before={mid} afterHang={after_hang} next={nxt}"
