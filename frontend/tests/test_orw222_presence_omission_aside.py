"""ORW-222: the presence-OMISSION guard must not fire on an aside-only ((out-of-character)) reply: it is not a scene, and "surface who is actually here" after a pure OOC answer is a false steer.
A real scene that omits the room's cast must still be flagged. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

FACTS = {"room": "backyard", "in_view": {"An Ally", "A Neighbor"}, "room_present": {"An Ally", "A Neighbor"},
         "active_offscene": set(), "evicted": set()}


def test_aside_only_reply_is_exempt_even_when_it_names_nobody_in_the_room():
    assert ch._presence_omission_directive("((There are 4 houseguests left; the HOH is a houseguest in the living room.))", FACTS) is None


def test_several_asides_and_an_ooc_prefix_are_exempt():
    assert ch._presence_omission_directive("((first answer)) ((second answer))", FACTS) is None
    assert ch._presence_omission_directive("((first answer))\n\n((second answer))", FACTS) is None
    assert ch._presence_omission_directive("ooc: who is left?", FACTS) is None


def test_a_real_scene_that_omits_the_room_is_still_flagged():
    d = ch._presence_omission_directive("You stare at the hatch and say nothing for hours.", FACTS)
    assert d is not None and "An Ally" in d


def test_a_scene_with_an_aside_attached_is_still_a_scene_and_is_still_flagged():
    d = ch._presence_omission_directive("You stare at the hatch in silence. ((side note: the comp is at 2pm))", FACTS)
    assert d is not None


def test_empty_narration_is_not_treated_as_an_aside():
    assert ch._is_aside_only_reply("") is False
    assert ch._is_aside_only_reply("   ") is False
    assert ch._is_aside_only_reply("No parentheses here.") is False
    assert ch._is_aside_only_reply("((just an aside))") is True
