"""ORW-1155 - a closed day's recap is voiced once, even when its turnIn ran outside a narrator turn.

The ORW-382 directive rides only the FE-run bedtime turnIn, so a night ended any other way left its recap unvoiced for good. The FE tracks the last closed day whose recap was voiced (per user and
session, persisted with the belt state) and, at the start of a turn, voices a newer non-empty engine recap first. Stubbed engine and LLM; roles only.
"""
import json

import pytest

from test_orw310_bedtime_belt import DEEPSEEK, _drive, _res

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

OWNER = "orw1155"
NOTE_MARK = "never voiced as a day-in-review"
_MORNING = {"timeOfDay": "morning", "clockLabel": "8:00am, Day 2", "phase": "playing"}


def _recap(day=1, **kw):
    base = {"day": day, "highlights": ["a quiet hour on the porch"], "yourDay": [], "surfaced": []}
    base.update(kw)
    return base


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    from src import agent_loop as al
    al._RECAP_VOICED_DAY.clear()
    yield
    al._RECAP_VOICED_DAY.clear()


def _engine_recap(monkeypatch, holder):
    from src import orwell_engine as oe

    async def fake(user=None):
        return holder["rec"]

    monkeypatch.setattr(oe, "daily_recap", fake)


def _noted(rounds):
    return [m for m in rounds[0]["msgs"] if m.get("role") == "system" and NOTE_MARK in str(m.get("content"))]


def test_turn_in_run_outside_a_narrator_turn_is_voiced_on_the_next_turn_exactly_once(monkeypatch):
    holder = {"rec": _recap(day=1)}
    _engine_recap(monkeypatch, holder)
    rounds, belts, _, _ = _drive(monkeypatch, text="I look around the living room.", owner=OWNER, status=_MORNING)
    notes = _noted(rounds)
    assert len(notes) == 1 and "a quiet hour on the porch" in notes[0]["content"]
    assert belts.get("recap-replay") == 1
    # the next turn, same recap: already voiced, nothing more
    rounds, belts, _, _ = _drive(monkeypatch, text="I look around the living room.", owner=OWNER, status=_MORNING)
    assert _noted(rounds) == [] and "recap-replay" not in belts
    # a newer closed day is voiced again, once
    holder["rec"] = _recap(day=2, highlights=["a late knock"])
    rounds, _, _, _ = _drive(monkeypatch, text="I look around the living room.", owner=OWNER, status=_MORNING)
    assert len(_noted(rounds)) == 1


def test_a_normal_turn_in_turn_does_not_double_voice(monkeypatch):
    holder = {"rec": _recap(day=1)}
    _engine_recap(monkeypatch, holder)
    night = {"timeOfDay": "night", "clockLabel": "11:00pm, Day 1", "phase": "playing"}
    tin = _res("morning", dailyRecap=_recap(day=1))
    rounds, belts, _, executed = _drive(monkeypatch, text="I'm going to bed.", model=DEEPSEEK, status=night, owner=OWNER, turn_in_result=tin)
    assert executed == ["turnIn"] and belts.get("bedtime-turn-in-direct") == 1
    assert _noted(rounds) == [] and "recap-replay" not in belts    # the ORW-382 directive voices it on this turn
    rounds, belts, _, _ = _drive(monkeypatch, text="Good morning.", owner=OWNER, status=_MORNING)
    assert _noted(rounds) == [] and "recap-replay" not in belts    # and the next turn does not replay it


def test_an_empty_recap_is_skipped(monkeypatch):
    for rec in (_recap(day=1, highlights=[]), None, {}):
        _engine_recap(monkeypatch, {"rec": rec})
        rounds, belts, _, _ = _drive(monkeypatch, text="I look around.", owner=OWNER, status=_MORNING)
        assert _noted(rounds) == [] and "recap-replay" not in belts


def test_a_restart_does_not_replay_a_voiced_recap(monkeypatch, tmp_path):
    from src import agent_loop as al
    from src import belt_state_persist as bsp
    monkeypatch.setattr(bsp, "BELT_STATE_PATH", tmp_path / "belt.json")
    _engine_recap(monkeypatch, {"rec": _recap(day=1)})
    rounds, _, _, _ = _drive(monkeypatch, text="I look around.", owner=OWNER, status=_MORNING)
    assert len(_noted(rounds)) == 1
    bsp.save_now()
    assert al._RECAP_VOICED_DAY
    al._RECAP_VOICED_DAY.clear()                                   # the process restarts: memory is empty
    assert bsp.restore() >= 1
    rounds, belts, _, _ = _drive(monkeypatch, text="I look around.", owner=OWNER, status=_MORNING)
    assert _noted(rounds) == [] and "recap-replay" not in belts
