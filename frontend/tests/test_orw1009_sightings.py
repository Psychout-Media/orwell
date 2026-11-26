"""ORW-1009: a houseguest's report of where someone else is or was seen must come from a recorded sighting. Prod: one houseguest told the player a second had seen a third in one room; the second then gave another room.
Pure: no model. Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")

ROSTER = ["Alice Hart", "Bruno Lane", "Cleo Park", "Dana Moss"]
STATE = {"house": [{"name": n, "status": "active"} for n in ROSTER]}


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def test_a_third_party_sighting_with_no_record_is_flagged():
    hits = ch._unrecorded_sighting_claims("Alice Hart leans in. \"Bruno Lane saw Cleo in the bathroom, I think.\"", ROSTER)
    assert hits == [("Bruno Lane", "Cleo Park")]


def test_the_speaker_the_game_handed_a_told_sighting_may_say_what_they_saw():
    assert ch._unrecorded_sighting_claims("Alice Hart says she saw Cleo Park in the bathroom a moment ago.", ROSTER, allowed={"Alice Hart"}) == []


def test_a_named_third_party_is_flagged_even_when_another_speaker_was_given_a_sighting():
    # Alice was handed the sighting; naming Bruno as the one who saw is the invention
    assert ch._unrecorded_sighting_claims("Alice Hart says Bruno saw Cleo Park in the kitchen.", ROSTER, allowed={"Alice Hart"}) == [("Bruno Lane", "Cleo Park")]


def test_no_room_no_second_houseguest_and_asides_are_not_flagged():
    assert ch._unrecorded_sighting_claims("Bruno Lane saw Cleo Park and nodded.", ROSTER) == []
    assert ch._unrecorded_sighting_claims("Bruno Lane saw the bathroom door close.", ROSTER) == []
    assert ch._unrecorded_sighting_claims("((Production: Bruno Lane saw Cleo Park in the kitchen.))", ROSTER) == []


def test_the_told_speakers_come_from_the_engine_search_view():
    wa = {"search": {"houseguests": [{"name": "Cleo Park", "status": "told", "toldBy": {"id": "npc:1", "name": "Alice Hart"}, "fact": "x"},
                                    {"name": "Dana Moss", "status": "unknown", "fact": "y"}]}}
    assert ch._told_speaker_names(wa) == {"Alice Hart"}
    assert ch._told_speaker_names({}) == set() and ch._told_speaker_names(None) == set()


def _check(monkeypatch, text, key, told=()):
    async def fake_state(user=None, **k):
        return STATE
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    ch._DESYNC_REGROUND.pop(ch._desync_key(key), None)
    ch._TOLD_SPEAKERS[ch._desync_key(key)] = set(told)
    _run(ch.record_post_turn_sighting_check(key, text))
    return ch._DESYNC_REGROUND.get(ch._desync_key(key))


def test_an_unrecorded_sighting_queues_an_in_character_reground(monkeypatch):
    got = _check(monkeypatch, "Alice Hart says Bruno saw Cleo Park in the bathroom.", "u1009a")
    assert got and "RE-GROUND ON SIGHTINGS" in got and "Bruno Lane seeing Cleo Park" in got and "IN CHARACTER" in got


def test_a_recorded_sighting_queues_nothing(monkeypatch):
    assert not _check(monkeypatch, "Bruno Lane says he saw Cleo Park in the bathroom.", "u1009b", told={"Bruno Lane"})


def test_the_moment_prompt_carries_the_rule_and_the_unlisted_houseguest_rule():
    wa = {"room": "kitchen", "present": [{"id": "npc:1", "name": "Alice Hart"}], "nearby": []}
    d = ch._whereabouts_barrier_directive(wa, [], None)
    assert "neither on the list above nor in an adjacent room" in d
    assert "never name a third houseguest as the one who saw them" in d
    assert "e.g." not in d and "such as" not in d.lower()
