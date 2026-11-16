"""ORW-472: a stray result/use tag between sentences ("quiet. </tool_use> Role A sets her mug down.") is cut from the SHOWN text by the ORW-440 scrub; the stored text must lose only the tag, not the sentence part around it.
Real stream loop (the ORW-408 `_drive` harness), shown AND stored as whole strings. Only the SAFE subset is mirrored into the raw text (tool_use, tool_use_id, tool_result(s), function_result(s)); a call must still parse and run once. Roles only."""
import pytest

from tests.test_orw408_sentence_rewrite import _drive

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

T3 = "Rain taps the glass. A cup is set down. The kettle ticks. "
FULL = "The kitchen goes quiet. Role A sets her mug down. " + T3.strip()


@pytest.fixture(autouse=True)
def _rewrite_off(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")


def _round(monkeypatch, deltas, **kw):
    emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": deltas}], redo="X", flag="0", **kw)
    return emitted.split("done.")[0].strip(), stored[0], cont


@pytest.mark.parametrize("tag", ["</tool_use>", "<tool_use>", "<tool_use_id>", "</tool_result>", "<tool_results>", "</function_results>", "<function_result>"])
@pytest.mark.parametrize("make", [
    lambda t: [f"The kitchen goes quiet. {t} Role A sets her mug down. " + T3],          # spaces both sides
    lambda t: [f"The kitchen goes quiet.{t}Role A sets her mug down. " + T3],            # no spaces
    lambda t: ["The kitchen goes quiet. ", f"{t} Role A sets her mug down. " + T3],      # at a chunk start
    lambda t: [f"The kitchen goes quiet. {t}", " Role A sets her mug down. " + T3],      # at a chunk end
    lambda t: [f"The kitchen goes quiet. {t[:len(t) // 2]}", f"{t[len(t) // 2:]} Role A sets her mug down. " + T3],  # the tag split across chunks
])
def test_a_stray_tag_between_sentences_shown_equals_stored(monkeypatch, tag, make):
    shown, stored, _cont = _round(monkeypatch, make(tag))
    assert shown == FULL, shown
    assert stored == FULL, stored


@pytest.mark.parametrize("tag", ["</tool_use>", "</function_results>"])
def test_before_punctuation_no_space_is_added_and_nothing_is_emptied(monkeypatch, tag):
    shown, stored, _ = _round(monkeypatch, [f"Role A waits {tag}. Then Role B leaves. " + T3])
    expected = "Role A waits. Then Role B leaves. " + T3.strip()
    assert shown == expected and stored == expected, (shown, stored)


def test_a_wrapped_tool_call_still_parses_and_runs_exactly_once(monkeypatch):
    call = '<tool_call><invoke name="bash"><parameter name="command">echo hi</parameter></invoke></tool_call>'
    for wrapped in (f"<tool_use>{call}</tool_use>", f"{call}</tool_use>", f"<tool_result>{call}</tool_result>", f"<function_results>{call}</function_results>"):
        extra = {}
        emitted, cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [T3, wrapped]}, {"deltas": ["The morning moves on."]}], redo="X", flag="0", extra=extra)
        assert extra["runs"] == ["bash"], (wrapped, extra["runs"])
        first = emitted.split("The morning moves on.")[0].strip()
        assert first == stored[0] == T3.strip(), (wrapped, first, stored)
        assert cont == []


def test_only_the_safe_subset_is_cut_from_the_raw_text():
    from src.agent_loop import _mirror_placeholder_cut as cut
    raw = "Role A nods. <tool_call>x</tool_call> Role B waits. <function_calls> <tool_calls> <invoke> <invoke name=\"bash\"> </invoke> "
    assert cut(raw, raw) == (raw, raw), "tool_call, function_calls, tool_calls and antml tags are never touched"
    rr, before = cut("Role A nods. </tool_use> Role B waits.", "Role A nods. </tool_use> Role B waits.")
    assert rr == before == "Role A nods. Role B waits."


def test_review_of_2807_executable_text_is_never_edited_by_the_mirror_cut():
    from src.agent_loop import _mirror_placeholder_cut as cut
    for raw in ("Role A nods. ```bash\nprintf '<tool_use>'\n``` Role B waits.",
                "Role A nods. <invoke name=\"bash\"><parameter name=\"command\">printf '</tool_use>'</parameter></invoke> Role B waits.",
                "Role A nods. ```sh\necho <tool_result>x"):
        assert cut(raw, raw) == (raw, raw), raw
    rr, before = cut("Role A nods. </tool_use> Role B waits. ```\nprintf '</tool_use>'\n```", "Role A nods. </tool_use> Role B waits. ```\nprintf '</tool_use>'\n```")
    assert rr == before == "Role A nods. Role B waits. ```\nprintf '</tool_use>'\n```"  # prose outside the block is still cut, the command is not
