"""ORW-440: a whole reply was the bare echoed tag "</tool_use>" (eviction night). `_scrub_game_leak` cuts bare tool-markup tags (tag-only, never prose); an empty-after-scrub round takes the existing blank-turn guard (#1110) rather than an empty bubble. Roles only."""
import pytest

from tests.test_1110_double_blank_guard import _drive_double_blank


@pytest.mark.parametrize("s", [
    "</tool_use>", "\n</tool_use>", "<tool_use>", "<tool_call>", "</tool_call>", "<function_call>",
    "</function_calls>", "</tool_result>", "</tool_results>", '<tool_use_id="abc123">', '<tool_use id="x">', "<|tool_call_end|>", "<|im_end|>",
])
def test_bare_markup_scrubs_to_empty(s):
    from src.agent_loop import _scrub_game_leak
    assert _scrub_game_leak(s).strip() == ""


def test_markup_mid_reply_is_cut_without_eating_neighbours():
    from src.agent_loop import _scrub_game_leak
    kept = _scrub_game_leak("The kitchen goes quiet. </tool_use> The HOH sets her mug down.")
    assert "tool_use" not in kept and "The kitchen goes quiet." in kept and "The HOH sets her mug down." in kept
    assert "quiet. The HOH" in kept, kept  # review of #2779: the neighbours keep a separator


def test_plain_word_prose_untouched():
    from src.agent_loop import _scrub_game_leak
    for s in ("She picks up the tool and makes a call.", 'He says "use the tool_use word" and grins.',
              "The function call of the day is dinner.", "Is 3 < 5 and 7 > 2? Yes."):
        assert _scrub_game_leak(s) == s


def test_empty_after_scrub_reply_takes_the_blank_turn_path(monkeypatch):
    out = _drive_double_blank(monkeypatch, ["\n</tool_use>"])
    assert out.strip() and "tool_use" not in out


def test_a_quoted_literal_tag_is_stripped_by_design():
    """review of #2779: the scrub has no notion of quotes; a literal tool tag is machinery wherever it sits (only the plain words are prose)."""
    from src.agent_loop import _scrub_game_leak
    assert "tool_use" not in _scrub_game_leak('He says "<tool_use>" and grins.')


def test_a_tag_never_joins_words_or_leaves_a_space_before_punctuation():
    """ORW-440 review (cubic): a tag at the start of a streamed chunk must not glue the next word to the previous chunk; a tag before punctuation leaves no stray space."""
    from src.agent_loop import _scrub_game_leak
    assert _scrub_game_leak("The room is quiet</tool_use>.").strip() == "The room is quiet."
    assert _scrub_game_leak("</tool_use>The HOH stands.") == " The HOH stands."
    assert _scrub_game_leak("It is quiet.</tool_use>The HOH stands.") == "It is quiet. The HOH stands."
    assert _scrub_game_leak("It is quiet. </tool_use> The HOH stands.") == "It is quiet. The HOH stands."
