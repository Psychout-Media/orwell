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


def test_skip_marker_always_passes():
    out = drop_unstated_gender({"genderPresentation": "skipped"}, "hi")
    assert out["genderPresentation"] == "skipped"


def test_answer_a_turn_earlier_counts_via_recent_window():
    from src.tool_implementations import PLAYER_TURN_TEXT, PLAYER_RECENT_TEXT, _gender_evidence_text
    PLAYER_TURN_TEXT.set("sure, go ahead")
    PLAYER_RECENT_TEXT.set("sure, go ahead\nI'm a woman, she/her")
    try:
        out = drop_unstated_gender({"genderPresentation": "woman"}, _gender_evidence_text())
        assert out["genderPresentation"] == "woman"
    finally:
        PLAYER_TURN_TEXT.set(""); PLAYER_RECENT_TEXT.set("")


def test_recent_user_text_collects_last_few_user_messages():
    from src.agent_loop import _recent_user_text
    msgs = [{"role": "user", "content": f"m{i}"} for i in range(6)] + [{"role": "assistant", "content": "x"}]
    t = _recent_user_text(msgs)
    assert "m5" in t and "m2" in t and "m1" not in t
