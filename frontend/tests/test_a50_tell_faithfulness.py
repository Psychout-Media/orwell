"""A50: narrated carriage must not contradict the engine's tell (closed lexicon, one named NPC per line)."""
import pytest
from routes import chat_helpers as ch
from src import orwell_engine as oe

U = "a50-user"


@pytest.fixture(autouse=True)
def _clean():
    oe._TELLS_TURN.clear()
    yield
    oe._TELLS_TURN.clear()


def _set(**kw):
    oe._TELLS_TURN[U] = kw


def test_opposite_pole_replaced_both_ways():
    _set(Alex=["withdrawn"], Sam=["giddy"])
    t, ops = ch.screen_tell_faithfulness(U, "Alex is beaming across the room.\nSam is sobbing by the pool.\nAlex nods.")
    assert len(ops) == 2 and "beaming" not in t and "sobbing" not in t and "Alex nods." in t


def test_agreeing_or_unrelated_untouched():
    _set(Alex=["withdrawn"], Sam=["snapping"])
    txt = "Alex is withdrawn, tearful.\nSam is grinning like a shark.\nAlex and Sam are beaming."
    assert ch.screen_tell_faithfulness(U, txt) == (txt, [])


def test_calm_npc_not_given_strong_tell():
    _set(Alex=[])
    t, ops = ch.screen_tell_faithfulness(U, "Alex is sobbing quietly.")
    assert len(ops) == 1
    assert ch.screen_tell_faithfulness(U, "Alex is laughing.") == ("Alex is laughing.", [])


def test_no_tells_layer_is_noop():
    txt = "Alex is sobbing."
    assert ch.screen_tell_faithfulness(U, txt) == (txt, [])


def test_guard_off_mutant_goes_red(monkeypatch):
    _set(Alex=["withdrawn"])
    monkeypatch.setattr(ch, "_tell_line_violation", lambda *a, **k: None)
    assert ch.screen_tell_faithfulness(U, "Alex is beaming.")[1] == []  # control: with the check disabled nothing is corrected
    monkeypatch.undo()
    assert ch.screen_tell_faithfulness(U, "Alex is beaming.")[1] != []


def test_note_tells_capture():
    oe._note_tells(U, {"houseguest": {"id": "x", "name": "Alex"}, "tells": [{"kind": "giddy"}]})
    oe._note_tells(U, {"houseguest": {"id": "y", "name": "Sam"}})  # layer off: nothing stored
    assert oe.tells_this_turn(U) == {"Alex": ["giddy"]}
    oe.clear_disclosure_turn(U)
    assert oe.tells_this_turn(U) == {}
