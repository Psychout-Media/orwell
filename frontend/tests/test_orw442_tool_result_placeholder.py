"""ORW-442: the model once echoed the harness placeholder "<tool result has been redacted>" as visible narration (slot-1 sweep, Day 3, a recordInteraction round: content was exactly that 31-char string).
`_scrub_game_leak` (the live stream and the saved message) cuts just that placeholder (it has no sentence punctuation, so it would otherwise swallow the next sentence); the scene stays, and one space is kept
only where two words would otherwise join (the same rule as ORW-440's tool-markup tags). Tests are exact strings, through the real stream loop (the ORW-408 `_drive` harness): shown AND stored. Roles only."""
import pytest

from tests.test_orw408_sentence_rewrite import _drive

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

PH = "<tool result has been redacted>"
T3 = "Rain taps the glass. A cup is set down. The kettle ticks. "


@pytest.fixture(autouse=True)
def _rewrite_off(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")


@pytest.mark.parametrize("deltas,expected", [
    # the reported input: one chunk, spaces both sides
    ([f"The kitchen goes quiet. {PH} Role A sets her mug down. " + T3], "The kitchen goes quiet. Role A sets her mug down. " + T3.strip()),
    # placeholder at a chunk start (previous chunk ended after the space) and at a chunk end
    (["The kitchen goes quiet. ", f"{PH} Role A sets her mug down. " + T3], "The kitchen goes quiet. Role A sets her mug down. " + T3.strip()),
    ([f"The kitchen goes quiet. {PH}", " Role A sets her mug down. " + T3], "The kitchen goes quiet. Role A sets her mug down. " + T3.strip()),
    # between two sentences, with and without spaces
    ([f"The kitchen goes quiet.{PH}Role A sets her mug down. " + T3], "The kitchen goes quiet. Role A sets her mug down. " + T3.strip()),
    ([f"The kitchen goes quiet.  {PH}  Role A sets her mug down. " + T3], "The kitchen goes quiet. Role A sets her mug down. " + T3.strip()),
    # before punctuation: no space is added in front of it
    ([f"Role A waits {PH}. Then Role B leaves. " + T3], "Role A waits. Then Role B leaves. " + T3.strip()),
    # inside a quoted line
    ([f'Role A says, "hello {PH} there." ' + T3], 'Role A says, "hello there." ' + T3.strip()),
])
def test_the_placeholder_is_cut_and_shown_equals_stored_as_whole_strings(monkeypatch, deltas, expected):
    emitted, _cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": deltas}], redo="X", flag="0")
    first_round_shown = emitted.split("done.")[0].strip()
    assert "redacted" not in first_round_shown and "<" not in first_round_shown
    assert first_round_shown == expected, first_round_shown
    assert stored[0] == expected, stored


def test_the_placeholder_alone_is_dropped():
    from src.agent_loop import _scrub_game_leak
    assert _scrub_game_leak(PH).strip() == ""


def test_ordinary_prose_about_results_is_untouched():
    from src.agent_loop import _scrub_game_leak
    for s in ("The results of the vote are in the envelope.", "Nobody likes the result.", "She reads the tool shed sign."):
        assert _scrub_game_leak(s) == s


def test_reviews_of_2803_trailing_buffer_consecutive_placeholders_and_opening_punctuation():
    from src.agent_loop import _cut_markup_keeping_one_space as cut, _TOOL_RESULT_PLACEHOLDER_RE as rx
    assert cut(rx, f"foo{PH}{PH}bar") == "foo bar"                       # two in a row leave ONE space
    assert cut(rx, f"foo {PH} {PH} bar") == "foo bar"
    assert cut(rx, f'He said ("{PH}word")') == 'He said ("word")'         # nothing is inserted after an opening quote or bracket
    assert cut(rx, f"A ({PH}word) and {PH}done") == "A (word) and done"
    assert cut(rx, f"Role A waits{PH}, then leaves") == "Role A waits, then leaves"


def test_a_placeholder_in_an_unterminated_trailing_buffer_is_cut_shown_and_stored(monkeypatch):
    emitted, _cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [f"Role A waits {PH} Role B leaves"]}], redo="X", flag="0")
    first = emitted.split("done.")[0].strip()
    assert first == "Role A waits Role B leaves", first
    assert stored[0] == "Role A waits Role B leaves", stored
