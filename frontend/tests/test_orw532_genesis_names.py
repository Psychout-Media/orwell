"""ORW-532: genesis hands the writer the dealt surname and birth year as fixed anchors and tells the engine to keep it."""
import importlib

g = importlib.import_module("src.orwell_cast_genesis")


def test_card_carries_the_name_anchors_and_the_prompt_says_the_surname_is_fixed():
    d = {"role": "r", "roleNote": "n", "archetype": "floater", "ageLo": 30, "ageHi": 40, "dealtSurname": "Okafor", "birthYear": 1992}
    line = g.render_slot_directive("npc:2", d)
    assert "NAME ANCHORS (fixed): the surname is Okafor" in line and "born around 1992" in line
    plain = g.render_slot_directive("npc:2", {k: v for k, v in d.items() if k not in ("dealtSurname", "birthYear")})
    assert "NAME ANCHORS" not in plain
    assert "NAME ANCHORS the surname is FIXED" in g._SYSTEM
