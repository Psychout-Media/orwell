"""ORW-1150 (prod 11-28 04:24Z shape, codes only): the narration passes the night while the engine clock has not moved; a bed word the room does not have; a sleeper put in a bed in the player's room.
The pre-display check refuses each and the reply is regenerated once with the real clock. Roles only."""
import pytest

from src.predisplay_check import (FACT_BED_WORD, FACT_SLEEPER_ROOM, FACT_TIME_JUMP, conflict_details, correction_for)
from test_orw408_sentence_rewrite import CLEAN_A, TAIL, _drive, _rewrite_on  # noqa: F401

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

JUMP = "The lamp stays off for hours, and the next morning the house is up and the beds are empty. "
NIGHT = {"timeOfDay": "night", "asleep": [], "whereabouts": {"room": "bedroom-c", "present": [], "bedLayout": {"singles": 5, "doubles": 0}}}
MORNING = dict(NIGHT, timeOfDay="morning")


def _facts(text, state, **kw):
    return [c.fact for c in conflict_details(text, state, zero_clocks=False, **kw)]


def test_a_prose_morning_jump_with_the_clock_at_night_is_a_conflict():
    assert FACT_TIME_JUMP in _facts(JUMP, NIGHT)
    assert FACT_TIME_JUMP in _facts("Hours pass in the dark. ", NIGHT)
    assert FACT_TIME_JUMP in _facts("Everyone wakes up to the kitchen noise. ", NIGHT)


def test_the_same_words_pass_when_the_engine_clock_is_at_morning():
    assert FACT_TIME_JUMP not in _facts(JUMP, MORNING)


def test_quoted_talk_and_future_or_past_wording_do_not_count():
    assert FACT_TIME_JUMP not in _facts('Jace says, "See you the next morning." ', NIGHT)
    assert FACT_TIME_JUMP not in _facts("Tomorrow morning the alarm will go. ", NIGHT)
    assert FACT_TIME_JUMP not in _facts("You settle into the dark and listen to the house. ", NIGHT)


def test_a_double_in_a_room_of_singles_is_caught_and_a_real_double_is_not():
    assert FACT_BED_WORD in _facts("You were told the double is yours. ", NIGHT)
    two = {"timeOfDay": "night", "whereabouts": {"room": "bedroom-a", "present": [], "bedLayout": {"singles": 2, "doubles": 2}}}
    assert FACT_BED_WORD not in _facts("You were told the double is yours. ", two)
    assert FACT_BED_WORD not in _facts("You were told the double is yours. ", {"timeOfDay": "night", "whereabouts": {"room": "bedroom-c", "present": []}})  # no layout: nothing is checked
    assert FACT_BED_WORD not in _facts("You double check the door. ", NIGHT)


def test_sleepers_the_engine_does_not_have_here_are_not_narrated_in_beds_here():
    st = dict(NIGHT, asleep=[{"name": "Valerie Role"}, {"name": "Jace Role"}])
    assert FACT_SLEEPER_ROOM in _facts("Valerie Role and Jace Role are in their beds in bedroom C. ", st)
    assert FACT_SLEEPER_ROOM not in _facts("Valerie Role is in her bed in bedroom A. ", st)
    here = dict(st, whereabouts=dict(st["whereabouts"], present=[{"id": "npc:10", "name": "Valerie Role"}]))
    assert FACT_SLEEPER_ROOM not in _facts("Valerie Role is in her bed in bedroom C. ", here)


def test_every_new_fact_has_a_correction():
    for f in (FACT_TIME_JUMP, FACT_BED_WORD, FACT_SLEEPER_ROOM):
        assert correction_for(f)


def test_the_live_stream_withholds_the_jump_and_redoes_it_once_with_the_clock(monkeypatch):
    redo = "You lie in the dark and the house settles around you. "
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [CLEAN_A, JUMP, TAIL]}], redo=redo, state=NIGHT)
    assert "next morning" not in emitted and "for hours" not in emitted
    assert emitted.strip() == (CLEAN_A + redo).strip() and stored[0] == emitted.strip()
    assert len(cont) == 1 and "has not moved" in cont[0][-1]["content"]
