"""ORW-356 - the identity lint must not drop a young houseguest's biography for saying "retired" when the engine's own PINNED vocation is "retired ...".

Found in the free-play live run (2026-11-15): a 24-year-old woman pinned as a "retired firefighter-paramedic"; the authored biography said so and the lint
dropped it to the floor ("elder life-stage") at every game start, raising a RED-eligible signal. Roles only; no names.
"""
from src.orwell_cast_authoring import coherence_conflicts

BIO = ("A 24-year-old retired firefighter-paramedic from the coast. She spent five years on the line before an injury ended her field career, and now she is figuring out what comes next. "
       "She keeps people guessing with her dry humor.")


def test_a_pinned_retired_vocation_may_say_retired():
    npc = {"age": 24, "genderPresentation": "woman", "vocation": "retired firefighter-paramedic"}
    assert coherence_conflicts({"biography": BIO}, npc) == []


def test_an_unpinned_retirement_on_a_young_houseguest_is_still_dropped():
    npc = {"age": 24, "genderPresentation": "woman", "vocation": "bartender"}
    assert coherence_conflicts({"biography": BIO}, npc) == ["biography"]


def test_a_multi_decade_career_is_still_dropped_even_with_a_retired_vocation():
    npc = {"age": 24, "genderPresentation": "woman", "vocation": "retired firefighter-paramedic"}
    bio = BIO + " She has been doing this for thirty years."
    assert coherence_conflicts({"biography": bio}, npc) == ["biography"]


def test_an_older_houseguest_is_unaffected():
    npc = {"age": 61, "genderPresentation": "man", "vocation": "retired teacher"}
    bio = "A retired teacher who still grades everything in red pen. He keeps a tidy garden and an untidy temper."
    assert coherence_conflicts({"biography": bio}, npc) == []
