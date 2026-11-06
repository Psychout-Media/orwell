"""ORW-148 part B - the model's advanceGame releases at most ONE staged-premiere arrival per player turn.

Live 11-06 playtest: the narrator called advanceGame three times in one reply while the premiere entrance stage was
live; each call released another arrival, so the premiere fast-forwarded past what was voiced. The per-turn signal is
the once-per-framed-turn `note_premiere_turn` hook, which resets the allowance when a new player turn is framed.
"""
import asyncio
import importlib
import json

import pytest

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
ti = importlib.import_module("src.tool_implementations")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _board(stage):
    return {"phase": "premiere", "premiere": {"entrance": {"stage": stage}}}


@pytest.fixture(autouse=True)
def _fake_engine(monkeypatch):
    import src.orwell_offscreen_texture as _oot
    import src.orwell_gen_competitions as _ogc
    monkeypatch.setattr(_oot, "kickoff_enrich", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(_ogc, "kickoff_fiction", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    monkeypatch.setattr(ch, "scheduled_event_is_held", lambda user: False)
    calls = []

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(1)
        return {"beatSeq": 10 + len(calls), "phase": "premiere"}

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    ch._PREMIERE_RELEASED_THIS_TURN.clear()
    ch._PREMIERE_ENTRANCE_STAGE.clear()
    yield calls
    ch._PREMIERE_RELEASED_THIS_TURN.clear()
    ch._PREMIERE_ENTRANCE_STAGE.clear()


def test_second_release_in_one_turn_is_held_and_skips_the_engine(_fake_engine):
    calls = _fake_engine
    u = "orw148-b"
    ch.note_premiere_turn(u, _board("entrances"))
    first = _run(ti.do_advance_game("{}", owner=u))
    assert "held" not in json.loads(first["output"]) and len(calls) == 1
    second = _run(ti.do_advance_game("{}", owner=u))
    assert json.loads(second["output"])["held"] is True
    assert "voice" in json.loads(second["output"])["note"].lower()
    assert len(calls) == 1, "the engine must NOT be called for the held second release"


def test_a_new_player_turn_resets_the_allowance(_fake_engine):
    calls = _fake_engine
    u = "orw148-b-reset"
    ch.note_premiere_turn(u, _board("entrances"))
    _run(ti.do_advance_game("{}", owner=u))
    ch.note_premiere_turn(u, _board("entrances"))  # next framed player turn
    out = _run(ti.do_advance_game("{}", owner=u))
    assert "held" not in json.loads(out["output"]) and len(calls) == 2


def test_outside_the_entrance_stage_advance_is_never_held(_fake_engine):
    calls = _fake_engine
    u = "orw148-b-off"
    ch.note_premiere_turn(u, {"phase": "hoh-competition"})
    _run(ti.do_advance_game("{}", owner=u))
    _run(ti.do_advance_game("{}", owner=u))
    assert len(calls) == 2
