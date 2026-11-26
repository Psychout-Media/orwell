"""ORW-995: the engine deals each slot's hometown; the writer is told it and describes it, never picks one."""
import importlib

g = importlib.import_module("src.orwell_cast_genesis")

_D = {"role": "r", "roleNote": "n", "archetype": "floater", "ageLo": 30, "ageHi": 40}


def test_the_dealt_hometown_rides_the_card_as_a_fixed_input():
    line = g.render_slot_directive("npc:2", {**_D, "dealtHometown": "Waco, TX"})
    assert "HOMETOWN (fixed): Waco, TX" in line
    assert "HOMETOWN (fixed)" not in g.render_slot_directive("npc:2", _D)


def test_a_dealt_hometown_replaces_the_size_and_region_hint():
    hand = {"vocationFamily": "x", "townSize": "a small town", "state": "OH", "region": "Midwest", "heightBuild": "a", "skinToneCue": "b", "hair": "c", "voiceTic": "d", "namePhonology": "e"}
    with_town = g.render_slot_directive("npc:2", {**_D, "ledger": hand, "dealtHometown": "Waco, TX"})
    assert "hometown: a small town" not in with_town
    assert "hometown: a small town" in g.render_slot_directive("npc:2", {**_D, "ledger": hand})


def test_the_prompt_says_the_writer_does_not_choose_the_town():
    assert "HOMETOWN (fixed)" in g._SYSTEM and "ignored" in g._SYSTEM
