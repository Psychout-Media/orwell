"""ORW-408: the narrator wrote "the night wears on" at 6pm and "this afternoon" at night, though it is handed the part of the day every turn. The pre-display check now holds that hard fact. Roles only."""
import pytest

from src import predisplay_check as pc


def _facts(text, tod, early=False):
    return pc.find_conflicts(text, {"timeOfDay": tod, "earlyMorning": early}, zero_clocks=True)


@pytest.mark.parametrize("text,tod", [
    ("The night wears on and the kitchen empties.", "evening"),
    ("It's late at night in the house now.", "afternoon"),
    ("Past midnight, the couch is quiet.", "morning"),
    ("The afternoon sun warms the deck.", "night"),
    ("This morning the house is slow to wake.", "late-night"),
])
def test_the_wrong_part_of_the_day_is_caught(text, tod):
    assert pc.FACT_PART_OF_DAY in _facts(text, tod), text


@pytest.mark.parametrize("text,tod,early", [
    ("The night wears on.", "late-night", False),
    ("The small hours stretch out.", "morning", True),
    ('A houseguest says, "The night wears on, huh?"', "evening", False),
    ("Earlier this morning the veto talk was loud.", "night", False),
    ("Tonight will be long.", "afternoon", False),
    ("The afternoon sun warms the deck.", "afternoon", False),
])
def test_nothing_else_is_flagged(text, tod, early):
    assert pc.FACT_PART_OF_DAY not in _facts(text, tod, early), text


def test_the_rewrite_is_told_the_real_part_of_day():
    hit = pc.conflict_details("The night wears on.", {"timeOfDay": "late-night"}, zero_clocks=True)
    assert hit == []
    (c,) = pc.conflict_details("The night wears on.", {"timeOfDay": "evening"}, zero_clocks=True)
    assert "evening" in pc._correction_line(c)
