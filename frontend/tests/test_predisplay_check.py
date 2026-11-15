"""ORW-408 first slice: the pre-display hard-fact checker + counter. Roles only; no model calls."""
import asyncio

import pytest

from src import predisplay_check as pc

STATE = {"asleep": [{"name": "Sleeper Role"}], "daySchedule": {"next": "nominations", "tomorrow": True}}


def test_asleep_houseguest_speaking_is_detected():
    assert pc.find_conflicts('Sleeper says, "Morning, everyone." The kettle clicks.', STATE, zero_clocks=False) == [pc.FACT_ASLEEP]


def test_asleep_houseguest_acting_without_quote_is_detected():
    assert pc.FACT_ASLEEP in pc.find_conflicts("Sleeper Role walks into the kitchen.", STATE, zero_clocks=False)


def test_asleep_houseguest_merely_mentioned_as_sleeping_is_clean():
    assert pc.find_conflicts("Sleeper Role is asleep in bed, snoring softly.", STATE, zero_clocks=False) == []


def test_clock_time_detected_only_when_zero_clocks_on():
    assert pc.find_conflicts("It's 8:15 in the morning.", STATE, zero_clocks=True) == [pc.FACT_CLOCK]
    assert pc.find_conflicts("It's 8:15 in the morning.", STATE, zero_clocks=False) == []


def test_schedule_words_contradicting_tomorrow_detected():
    assert pc.find_conflicts("The nomination ceremony is this afternoon.", STATE, zero_clocks=False) == [pc.FACT_SCHEDULE]
    assert pc.find_conflicts("The nominations happen tonight.", STATE, zero_clocks=False) == [pc.FACT_SCHEDULE]


def test_schedule_words_fine_when_event_is_tomorrow_or_today():
    assert pc.find_conflicts("The nomination ceremony is tomorrow.", STATE, zero_clocks=False) == []
    today = {"daySchedule": {"next": "nominations"}}
    assert pc.find_conflicts("The nomination ceremony is this afternoon.", today, zero_clocks=False) == []


def test_clean_text_passes_and_bad_state_fails_open():
    assert pc.find_conflicts("The couch is warm. Someone laughs in the next room.", STATE, zero_clocks=True) == []
    assert pc.find_conflicts("anything", None, zero_clocks=True) == []


def test_correction_names_each_fact():
    assert all(pc.correction_for(f) for f in (pc.FACT_ASLEEP, pc.FACT_CLOCK, pc.FACT_SCHEDULE))


def test_counter_recorded_once_per_fact_and_text_untouched(monkeypatch):
    import src.log_rings as lr
    seen = []
    monkeypatch.setattr(lr, "record_soft_failure", lambda cls, exc, **kw: seen.append(cls))
    from src import orwell_engine

    async def fake_state(user=None, timeout=None):
        return STATE
    monkeypatch.setattr(orwell_engine, "get_game_state_polled", fake_state)
    monkeypatch.setattr("src.zero_clocks.zero_clocks_on", lambda: True)
    got = asyncio.new_event_loop().run_until_complete(pc.check_and_count('Sleeper says, "It\'s 8:15." The nominations are tonight.', "u"))
    assert got == [pc.FACT_ASLEEP, pc.FACT_CLOCK, pc.FACT_SCHEDULE]
    assert seen == ["predisplay-conflict:" + f for f in got]


def test_flag_off_counts_nothing(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_CHECK", "0")
    assert asyncio.new_event_loop().run_until_complete(pc.check_and_count("It's 8:15.", "u")) == []
