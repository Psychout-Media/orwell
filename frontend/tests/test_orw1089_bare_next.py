"""ORW-1089: a message that is nothing but "next" / "continue", while the engine says nothing is due, runs the bare-next fast-forward. Roles only."""
import asyncio

import pytest

from routes import chat_helpers as ch

_HELD = {"started": True, "daySchedule": {"due": False, "next": "nominations"}}


@pytest.mark.parametrize("msg", ["next", "Next.", "continue", "ok, next", "skip ahead", "keep going..."])
def test_a_bare_next_while_nothing_is_due(msg):
    assert ch.bare_next_while_nothing_due(_HELD, msg)


@pytest.mark.parametrize("msg", ["Continue from where you left off.", "next week I go after them", "I continue the conversation", "what's next", ""])
def test_anything_more_is_ordinary_talk(msg):
    assert not ch.bare_next_while_nothing_due(_HELD, msg)


def test_not_when_the_event_is_due_or_there_is_no_schedule():
    assert not ch.bare_next_while_nothing_due({"daySchedule": {"due": True}}, "next")
    assert not ch.bare_next_while_nothing_due({"started": True}, "next")


def test_it_calls_the_engine_lever_with_bare_next_and_arms_the_steer(monkeypatch):
    from src import orwell_engine
    seen = {}

    async def fake(expected_beat_seq=None, user=None, **kw):
        seen.update(kw)
        return {"ok": True, "stopReason": "observed", "detail": {"kind": "someone-entered", "who": ["Ana"]}, "minutes": 25}

    monkeypatch.setattr(orwell_engine, "hang_out", fake)
    assert asyncio.run(ch.maybe_hang_out("u-orw1089", dict(_HELD), "next")) is True
    assert seen == {"bare_next": True}
    assert "Ana coming into the room" in ch._HANGOUT_STEER.pop(ch._runway_key("u-orw1089"))
