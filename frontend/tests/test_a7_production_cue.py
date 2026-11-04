"""A7 (PO 2026-11-04): production's voice. Within 30 in-game minutes of a scheduled event the narrator gets a NOTICE cue ("about to be called", the house drifts toward the gathering);
when the event comes due WHILE the player is mid-conversation the narrator gets a CALL cue (everyone gathers; the conversation partner turns toward the call). Neither fires the event
early nor invents an outcome. Roles only."""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")


def _run(c):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(c)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.fixture(autouse=True)
def _clean():
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None); ch._PRODUCTION_HOLD.clear()
    yield
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None)


def _state(due, minutes, phase="veto-competition"):
    return {"phase": phase, "moment": phase, "week": 1, "started": True, "pending": None,
            "daySchedule": {"next": phase, "phase": "afternoon", "due": due, "minutesUntil": minutes}}


def _wire(monkeypatch, phase="veto-competition"):
    board = _state(True, 0, phase)

    async def status(user=None):
        return {"phase": board["phase"], "pending": None}

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        board.update(phase="veto-ceremony", moment="veto-ceremony")
        return {"event": {"beat": phase, "content": "x"}, "announcements": []}

    async def state(user=None, **kw):
        return dict(board)

    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "advance_game", advance)
    monkeypatch.setattr(oe, "get_game_state", state)


def test_warning_cue_inside_the_last_half_hour(monkeypatch):
    _wire(monkeypatch)
    out = _run(ch._pre_resolve_npc_ceremony("u", _state(False, 25), retry=False, player_msg="So what do you think of Sam?"))
    assert out.get("moment") == "social"  # still not fired
    steer = ch._SCHEDULE_STEER.get(ch._runway_key("u"), "")
    assert "GIVES NOTICE" in steer and "25 in-game minutes" in steer and "do NOT start the event" in steer


def test_no_warning_before_the_last_half_hour(monkeypatch):
    _wire(monkeypatch)
    _run(ch._pre_resolve_npc_ceremony("u", _state(False, 90), retry=False, player_msg="So what do you think of Sam?"))
    steer = ch._SCHEDULE_STEER.get(ch._runway_key("u"), "")
    assert "GIVES NOTICE" not in steer and "HASN'T CALLED IT YET" in steer


def test_call_cue_when_due_mid_conversation(monkeypatch):
    _wire(monkeypatch)
    _run(ch._pre_resolve_npc_ceremony("u", _state(True, 0), retry=False, player_msg="Honestly I think we should keep Sam, what about you?"))
    steer = ch._SCHEDULE_STEER.get(ch._runway_key("u"), "")
    assert "PRODUCTION CALLS EVERYONE" in steer and "turns toward the call" in steer and "do NOT invent its outcome" in steer


def test_no_call_cue_when_the_player_asked_to_go(monkeypatch):
    _wire(monkeypatch)
    _run(ch._pre_resolve_npc_ceremony("u", _state(True, 0), retry=False, player_msg="Let's go! I'm ready."))
    assert "PRODUCTION CALLS EVERYONE" not in ch._SCHEDULE_STEER.get(ch._runway_key("u"), "")


def test_no_cue_without_a_schedule(monkeypatch):
    _wire(monkeypatch)
    st = _state(False, 10); st.pop("daySchedule")
    _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="hi"))
    assert "GIVES NOTICE" not in ch._SCHEDULE_STEER.get(ch._runway_key("u"), "")
