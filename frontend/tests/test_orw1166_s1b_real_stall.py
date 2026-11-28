"""ORW-1166: S1b forces advanceGame only on a real stall, never on a social message, never on a desync alone."""
import asyncio
import inspect
import re

import pytest

from routes import chat_helpers as ch
from src import agent_loop as al

OWNER = "orw1166-user"


def _msgs(text):
    return [{"role": "user", "content": text}]


@pytest.fixture(autouse=True)
def _clean():
    ch._ADVANCE_ESCALATION.clear()
    ch._LAST_FRAMED_REQUIRED_LEVER.pop(OWNER, None)
    yield
    ch._ADVANCE_ESCALATION.clear()
    ch._LAST_FRAMED_REQUIRED_LEVER.pop(OWNER, None)


def _arm(seq=7, reason="stall-nudges-unconverted"):
    ch._LAST_BEAT_SEQ[ch._beat_seq_key(OWNER)] = seq
    ch._arm_advance_escalation(OWNER, reason)


def _allowed(text):
    return asyncio.run(al._s1b_force_allowed(OWNER, OWNER, _msgs(text)))


def test_arm_records_reason_and_beat():
    _arm(7, "double-stale-409")
    assert ch.advance_escalation_info(OWNER) == {"reason": "double-stale-409", "beat_seq": 7}
    assert ch.advance_escalation_armed(OWNER)


def test_desync_reground_alone_no_longer_arms():
    src = inspect.getsource(al)
    m = re.search(r"elif _s1_have_baseline and not _s1_beat_moved and _s1_desync:(.*?)elif _s1_beat_moved:", src, re.S)
    assert m and "_arm_advance_escalation" not in m.group(1)


def test_social_message_after_desync_shape_does_not_force():
    # 05:18-05:20Z shape: armed (stuck beat, lever named) and the player just talks
    _arm()
    ch._LAST_FRAMED_REQUIRED_LEVER[OWNER] = "advanceGame"
    ok, why = _allowed("haha that was a wild night, how is everyone feeling about the house today")
    assert not ok and why == "social-message"


def test_real_stall_with_lever_forces_on_move_on_or_neutral():
    _arm()
    ch._LAST_FRAMED_REQUIRED_LEVER[OWNER] = "advanceGame"
    assert _allowed("let's go")[0]
    assert _allowed("ok")[0]


def test_no_lever_and_no_due_event_does_not_force(monkeypatch):
    _arm()
    async def _gs(*a, **k):
        return {}
    from src import orwell_engine as oe
    monkeypatch.setattr(oe, "get_game_state", _gs)
    ok, why = _allowed("let's go")
    assert not ok and why == "no-lever-or-due-event"


def test_beat_moved_since_arm_does_not_force():
    _arm(7)
    ch._LAST_FRAMED_REQUIRED_LEVER[OWNER] = "advanceGame"
    ch._LAST_BEAT_SEQ[ch._beat_seq_key(OWNER)] = 8
    assert _allowed("let's go") == (False, "beat-moved-since-arm")
