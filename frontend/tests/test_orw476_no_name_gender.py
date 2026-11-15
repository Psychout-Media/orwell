"""ORW-476: the player's gender is never inferred from their name - a model-supplied genderPresentation
is forwarded only when the player's own words state it."""
import pytest
from src.tool_implementations import drop_unstated_gender, player_stated_gender


@pytest.mark.parametrize("text", ["Hi, I'm Sarah", "I'm Alex, ready to play", "My name is Jordan", ""])
def test_name_only_turn_drops_inferred_gender(text):
    for g in ("woman", "man", "nonbinary"):
        assert "genderPresentation" not in drop_unstated_gender({"genderPresentation": g, "playerName": "X"}, text)


@pytest.mark.parametrize("g,text", [
    ("woman", "I'm a woman, she/her"), ("man", "he/him please"), ("man", "I am a guy from Ohio"),
    ("nonbinary", "I'm nonbinary"), ("nonbinary", "they/them"), ("woman", "As a woman I think so"),
])
def test_stated_gender_passes_through(g, text):
    out = drop_unstated_gender({"genderPresentation": g, "playerName": "X"}, text)
    assert out["genderPresentation"] == g


def test_mismatched_statement_is_dropped():
    assert not player_stated_gender("woman", "he/him")


def test_other_fields_untouched():
    out = drop_unstated_gender({"genderPresentation": "woman", "backstory": "b"}, "hi")
    assert out == {"backstory": "b"}
