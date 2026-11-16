"""ORW-477: a wait the player states in their own words reaches the clock, whatever verb or filler carries it; sentences that are not the player's wait do not. Roles only."""
import asyncio

import pytest

from routes import chat_helpers as ch
from src import orwell_engine


@pytest.mark.parametrize("msg,want", [
    # the three phrasings the sweep found
    ("I wait a couple of hours", (120, False)),
    ("I'll stay here for another two hours", (120, False)),
    ("stay put for another three hours", (180, False)),
    # the family: verbs, number words and digits, filler, "another N", halves
    ("I wait two hours", (120, False)),
    ("I wait 2 hours", (120, False)),
    ("I'll wait here for 3 hrs", (180, False)),
    ("I wait a few hours", (180, False)),
    ("I wait another hour", (60, False)),
    ("I wait for another hour and a half", (90, False)),
    ("I wait half an hour", (30, False)),
    ("we wait forty-five minutes", (45, False)),
    ("I wait 20 mins", (20, False)),
    ("I'll sit tight for an hour", (60, False)),
    ("I linger in the kitchen for another couple of hours", (120, False)),
    ("I remain here for two and a half hours", (150, False)),
    ("let's stay around for another 90 minutes", (90, False)),
    ("I stay here a couple more hours", (120, False)),
    ("I stick around for an hour", (60, False)),
    ("I'm going to wait here for six hours", (180, False)),  # the 3 h hard cap
    ("I stay in the living room for the rest of the afternoon", (None, True)),
    ("I wait here for the rest of the evening", (None, True)),
    ("I'll stay put until the rest of the morning", (None, True)),
    ("I stay put until the competition starts", (None, False)),
    ("I'll wait here until production calls us", (None, False)),
])
def test_the_family_of_stated_waits(msg, want):
    assert ch.hang_out_intent(msg), msg
    assert ch.parse_stated_wait(msg) == want, msg


@pytest.mark.parametrize("msg", [
    "I've been waiting two hours",
    "I waited two hours for him",
    "he said wait two hours",
    "She told me to wait a couple of hours",
    "\"wait two hours,\" he said",
    "Should I wait two hours?",
    "should I wait two hours",
    "Can we stay here for another three hours?",
    "I won't wait two hours",
    "I don't want to stay put for another two hours",
    "I had to wait two hours",
    "if they wait a couple of hours it will be too late",
    "I stayed here for three hours",
    "Jess stays here for another two hours",
    "I need two hours of sleep",
    "I wait by the door and tell him I need two hours",
    "wait, what? two hours?",
])
def test_not_the_players_wait_moves_nothing(msg):
    assert not ch.hang_out_intent(msg), msg
    assert ch.parse_stated_wait(msg) == (None, False), msg


@pytest.mark.parametrize("msg,mins", [
    ("I wait a couple of hours", 120),
    ("I'll stay here for another two hours", 120),
    ("stay put for another three hours", 180),
])
def test_the_real_path_hands_the_engine_the_target(monkeypatch, msg, mins):
    """parse -> maybe_hang_out -> the engine call: the stated minutes are the target the engine is given."""
    seen = {}

    async def fake(expected_beat_seq=None, max_beats=None, user=None, max_minutes=None, until_band_end=False):
        seen.update(max_minutes=max_minutes, until_band_end=until_band_end)
        return {"ok": True, "stopReason": "max-beats", "minutes": mins}
    monkeypatch.setattr(orwell_engine, "hang_out", fake)
    assert asyncio.run(ch.maybe_hang_out("w477", {"started": True}, msg))
    assert seen == {"max_minutes": mins, "until_band_end": False}


def test_a_negative_never_calls_the_engine(monkeypatch):
    called = []

    async def fake(**kw):
        called.append(kw)
        return {"ok": True}
    monkeypatch.setattr(orwell_engine, "hang_out", fake)
    for msg in ("I've been waiting two hours", "he said wait two hours", "Should I wait two hours?"):
        assert not asyncio.run(ch.maybe_hang_out("w477", {"started": True}, msg))
    assert called == []
