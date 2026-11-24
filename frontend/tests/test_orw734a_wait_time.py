"""ORW-734a: a wait the player states in their own words reaches the engine's clock. Playtest: "I stay at the table ... for three hours" and "I rest in bed for four hours, until 8am"
moved the clock one 5-minute message step while the narration said hours passed (the FE never recognised them as a wait), and "wait until 10pm" carried no target at all. The ENGINE
owns the clock; the FE only reads the player's own words and hands the engine a target. Roles only."""
import asyncio

import pytest

from routes import chat_helpers as ch
from src import orwell_engine


@pytest.mark.parametrize("msg,want", [
    ("I stay at the table listening and laughing for three hours, then I go to bed and sleep until the morning wake-up.", 180),
    ("I stay in the yard and warm up alone for three hours, until the veto competition is called.", 180),
    ("I rest in bed for four hours, until 8am.", 180),  # the 3 h cap on a stated wait
    ("I read on the couch for two hours", 120),
    ("I'll lounge by the pool for an hour and a half", 90),
    ("I sit by myself in the garden for 45 minutes", 45),
])
def test_an_activity_span_the_player_states_is_a_wait(msg, want):
    assert ch.hang_out_intent(msg)
    assert ch.parse_stated_wait(msg) == (want, False)


@pytest.mark.parametrize("msg", [
    "I go to bed and sleep for eight hours",
    "I nap for two hours",
    "I turn in for the night, I sleep for hours",
    "I talk to the HOH for an hour",
    "I chat with the whole house for three hours",
    "I ask Maya about the vote for an hour",
    "He stays at the table for three hours",
    "Should I stay at the table for three hours?",
    "I did not stay at the table for three hours",
    "I tell Maya to wait for two hours",
])
def test_sleep_talk_questions_and_other_people_are_not_a_wait(msg):
    assert not ch.hang_out_intent(msg)


@pytest.mark.parametrize("msg,want", [
    ("wait until 10pm", 22.0),
    ("I wait until 10 pm", 22.0),
    ("I wait until 10:30pm", 22.5),
    ("I wait two and a half hours, until 10pm.", 22.0),
    ("I rest in bed for four hours, until 8am.", 8.0),
    ("hang out till 9:15 p.m.", 21.25),
    ("I stay put until noon", 12.0),
    ("I hang around until midnight", 0.0),
    ("I wait until 12am", 0.0),
    ("I wait until 12pm", 12.0),
])
def test_a_clock_time_target_is_read_from_the_players_own_wait(msg, want):
    assert ch.parse_wait_until_clock(msg) == want


@pytest.mark.parametrize("msg", [
    "I wait for the veto",
    "I stay put until production calls us",
    "I wait until the nominations",
    "I wait until 25pm",
    "I tell Maya the meeting is until 10pm",
    "Should I wait until 10pm?",
    "I go to bed until 8am",
])
def test_no_clock_target_without_a_wait_and_a_real_time(msg):
    assert ch.parse_wait_until_clock(msg) is None


def test_the_real_path_hands_the_engine_the_clock_target(monkeypatch):
    seen = {}

    async def fake(expected_beat_seq=None, max_beats=None, user=None, max_minutes=None, until_band_end=False, until_clock=None):
        seen.update(max_minutes=max_minutes, until_band_end=until_band_end, until_clock=until_clock)
        return {"ok": True, "stopReason": "max-beats", "minutes": 150}
    monkeypatch.setattr(orwell_engine, "hang_out", fake)
    assert asyncio.run(ch.maybe_hang_out("w734a", {"started": True}, "I wait two and a half hours, until 10pm."))
    assert seen == {"max_minutes": 150, "until_band_end": False, "until_clock": 22.0}
    seen.clear()
    assert asyncio.run(ch.maybe_hang_out("w734a", {"started": True}, "wait until 10pm"))
    assert seen == {"max_minutes": None, "until_band_end": False, "until_clock": 22.0}


def test_the_engine_wrapper_sends_untilClock(monkeypatch):
    sent = {}

    async def fake_call(name, args, user=None):
        sent.update(name=name, args=args)
        return {"ok": True}
    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    asyncio.run(orwell_engine.hang_out(user="u", until_clock=22.5))
    assert sent["name"] == "hangOut" and sent["args"] == {"untilClock": 22.5}


def test_the_narrator_is_told_the_elapsed_time_in_hours_and_minutes():
    steer = ch._hang_out_steer({"ok": True, "stopReason": "max-beats", "minutes": 150})
    assert "150 in-game minutes" in steer and "2 hours 30 minutes" in steer
    assert "1 hour" in ch._hang_out_steer({"ok": True, "stopReason": "max-beats", "minutes": 60})
    assert "45 in-game minutes" in ch._hang_out_steer({"ok": True, "stopReason": "max-beats", "minutes": 45})
