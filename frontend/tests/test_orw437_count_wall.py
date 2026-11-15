"""ORW-437 (review of #2656, #2693): small plain-bug fixes in the engine-count wall. Pure functions, no engine."""
import importlib

ch = importlib.import_module("routes.chat_helpers")


def _kinds(text):
    return [(c.kind, c.n, c.rooms) for c in ch._engine_count_claims(text)]


def test_other_n_are_here_is_a_claim():
    assert [k for k in _kinds("The other five are here.") if k[0] == "others"] == [("others", 5, ())]


def test_n_of_you_left_is_a_strict_house_claim():
    c = ch._engine_count_claims("Eleven of you are left.")[0]
    assert c.kind == "house"
    assert not ch._engine_count_ok(c, {"house": 12, "room": 3, "others": 2, "voters": None})


def test_negative_voters_is_unavailable_not_a_count():
    wa = {"room": "kitchen", "nearby": [], "counts": {"room": 3, "others": 2, "house": 12, "voters": -1}}
    assert ch._engine_counts_of(wa)["voters"] is None


def test_one_asleep_is_checked():
    c = ch._engine_count_claims("One houseguest is asleep upstairs.")[0]
    assert c.kind == "asleep" and c.n == 1
    assert not ch._engine_count_ok(c, {"asleep": 0})
    assert ch._engine_count_ok(c, {"asleep": 4})


def test_negated_empty_is_not_a_claim():
    assert _kinds("The kitchen is not empty.") == []
    assert _kinds("The kitchen isn't empty.") == []
    assert _kinds("The kitchen is no longer empty.") == []
    assert _kinds("The kitchen is empty.") == [("empty", 0, ("kitchen",))]


def test_empty_claim_names_only_the_clause_it_ends():
    assert _kinds("Sam is in the kitchen, and the living room is empty.") == [("empty", 0, ("living-room",))]
    assert _kinds("Sam is in the kitchen and the living room is empty.") == [("empty", 0, ("living-room",))]
    # a list of rooms before one empty word is still all claimed
    assert _kinds("The kitchen, the living room and the dining room are all empty.")[0][2] == ("kitchen", "living-room", "dining-room")


def test_lounge_bathroom_are_rooms():
    assert _kinds("The lounge is empty.") == [("empty", 0, ("lounge",))]
    assert _kinds("The bathroom is empty.") == [("empty", 0, ("bathroom",))]


def test_article_form_rule_inside_its_own_leading_quote_is_rules_speech():
    # review of #2658: the opening quote starts the SAME sentence, so the text before it holds no quote
    text = '"The last houseguest standing is the new Head of Household."'
    assert ch._rule_subject(text, text)
    assert not ch._rule_subject("The last houseguest standing is the new Head of Household.", "The last houseguest standing is the new Head of Household.")


def test_unclosed_curly_single_quote_unit_is_unrepairable():
    # review of #2652: a dropped unit that opens a U+2018 span and never closes it must not be "repaired" as balanced
    assert ch._dropped_unit_residue("She says ‘we won the veto.") is None
    assert ch._dropped_unit_residue("She says ‘we won’ and don’t care.") == ("", "")


def test_style_keywords_do_not_match_inside_longer_words():
    # review of #2649: "surf" is a beachy keyword but must not fire inside "surface"
    from src.orwell_style_families import families_mentioned
    assert "beachy" not in families_mentioned("a smooth surface finish and a matte sleeve")
    assert "beachy" in families_mentioned("she surfs every morning, board shorts and all")
    assert "healthcare" in families_mentioned("scrubs and clogs")


import pytest


@pytest.mark.parametrize("text", [
    "No one is asleep yet.", "One by one they turned in.", "Not one of them is asleep, and the lights are still on.",
    "Everyone is up.", "Anyone could be asleep by now.", "Someone is asleep somewhere.", "She dragged one sleeping bag across the floor.",
])
def test_one_inside_no_one_not_one_one_by_one_is_not_an_asleep_claim(text):
    assert [c for c in ch._engine_count_claims(text) if c.kind == "asleep"] == []


def test_a_real_one_of_them_is_asleep_is_checked_against_the_engine_count():
    c = [c for c in ch._engine_count_claims("One of them is asleep upstairs.") if c.kind == "asleep"]
    assert len(c) == 1 and c[0].n == 1
    assert ch._engine_count_ok(c[0], {"asleep": 2})
    assert not ch._engine_count_ok(c[0], {"asleep": 0})
