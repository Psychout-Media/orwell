"""ORW-10 (a)+(b), live replay 7 (veto-day stall): (b) the overnight-roll beat of a scheduled phase re-grounds the narrator ("the house slept; the event has NOT started"); (a) the sentence guard emptying consecutive
turns is counted as cut turns, so from the 2nd the cutaway is the plain engine-true line and the neutral directive carries the production-hold fact. Roles only."""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
agent_loop = importlib.import_module("src.agent_loop")
_USER = "u-orw10-ab"


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def _sig(**o):
    b = {"week": 1, "phase": "veto-competition", "pending": None, "hoh": "npc:1", "hohName": "Marcus", "noms": ["npc:2", "npc:3"], "nomNames": ["Sofia", "Mario"],
         "activeNames": ["Sofia", "Mario", "Marcus", "Nina", "Sam"], "vetoHolder": None, "vetoHolderName": None, "vetoUsed": False, "playerIsHoh": False,
         "playerHasVeto": False, "evicted": 0, "evictedNames": [], "finished": False, "room": "kitchen", "present": []}
    b.update(o)
    return b


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    for d in (chat_helpers._LAST_BEAT_SIG, chat_helpers._DESYNC_REGROUND, chat_helpers._CUT_STREAK, chat_helpers._PRODUCTION_HOLD):
        d.pop(_USER, None)
    chat_helpers._PRODUCTION_HOLD.pop(chat_helpers._runway_key(_USER), None)

    async def fake_capture(user=None):
        return _sig()
    monkeypatch.setattr(chat_helpers, "_capture_beat_signature", fake_capture)
    yield
    for d in (chat_helpers._LAST_BEAT_SIG, chat_helpers._DESYNC_REGROUND, chat_helpers._CUT_STREAK):
        d.pop(_USER, None)
    chat_helpers._PRODUCTION_HOLD.pop(chat_helpers._runway_key(_USER), None)


def test_the_overnight_roll_beat_regrounds_the_narrator():
    d = chat_helpers.day_roll_reground("veto-competition", "The house turns in, and morning breaks on the day of the Power of Veto competition.")
    assert d and "has NOT started" in d and "Veto competition" in d


def test_other_beats_do_not_reground():
    for beat in ("Emilio Duval wins the Power of Veto", "Hope Bagwell falls behind and is out; 5 remain", "the veto players are drawn for Total Recall", None, ""):
        assert chat_helpers.day_roll_reground("veto-competition", beat) is None, beat


def test_emptied_turns_go_engine_true_from_the_second_and_carry_the_production_hold():
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()
    assert _run(chat_helpers.guard_emptied_cutaway(_USER)) == ""          # 1st emptied turn: keep the generic cutaway
    chat_helpers._PRODUCTION_HOLD[chat_helpers._runway_key(_USER)] = (("sig",), 3)
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()                           # next turn
    line = _run(chat_helpers.guard_emptied_cutaway(_USER))
    assert "Marcus" in line and "Sofia" in line
    d = chat_helpers._DESYNC_REGROUND[_USER]
    assert "has NOT called the Veto competition" in d and "BOARD, AS THE ENGINE HAS IT" in d


def test_the_agent_loop_uses_the_engine_true_line_when_the_sentence_guard_empties_the_turn(monkeypatch):
    async def always_empty(text, owner):
        return ""
    monkeypatch.setattr(agent_loop, "_pre_emission_outcome_guard", always_empty)
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()
    first = _run(agent_loop._emit_guarded_scene("The veto is starting right now.", _USER, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert first.text == agent_loop._SCENE_CUTAWAY_LINE
    chat_helpers._LAST_BEAT_SIG[_USER] = _sig()
    second = _run(agent_loop._emit_guarded_scene("The veto is starting right now.", _USER, scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert second.text != agent_loop._SCENE_CUTAWAY_LINE and "Marcus" in second.text
