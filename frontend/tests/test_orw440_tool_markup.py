"""ORW-440: a whole reply was the bare echoed tag "</tool_use>" (eviction night). `_scrub_game_leak` cuts bare tool-markup tags (tag-only, never prose); an empty-after-scrub round takes the existing blank-turn guard (#1110) rather than an empty bubble. Roles only."""
import pytest

from tests.test_1110_double_blank_guard import _drive_double_blank


@pytest.mark.parametrize("s", [
    "</tool_use>", "\n</tool_use>", "<tool_use>", "<tool_call>", "</tool_call>", "<function_call>",
    "</function_calls>", '<tool_use_id="abc123">', '<tool_use id="x">', "<|tool_call_end|>", "<|im_end|>",
])
def test_bare_markup_scrubs_to_empty(s):
    from src.agent_loop import _scrub_game_leak
    assert _scrub_game_leak(s).strip() == ""


def test_markup_mid_reply_is_cut_without_eating_neighbours():
    from src.agent_loop import _scrub_game_leak
    kept = _scrub_game_leak("The kitchen goes quiet. </tool_use> The HOH sets her mug down.")
    assert "tool_use" not in kept and "The kitchen goes quiet." in kept and "The HOH sets her mug down." in kept


def test_prose_and_quoted_uses_untouched():
    from src.agent_loop import _scrub_game_leak
    for s in ("She picks up the tool and makes a call.", 'He says "use the tool_use word" and grins.',
              "The function call of the day is dinner.", "Is 3 < 5 and 7 > 2? Yes."):
        assert _scrub_game_leak(s) == s


def test_empty_after_scrub_reply_takes_the_blank_turn_path(monkeypatch):
    out = _drive_double_blank(monkeypatch, ["\n</tool_use>"])
    assert out.strip() and "tool_use" not in out
