"""ORW-455: narrator guard leftovers. Real stream loop (the ORW-408 `_drive` harness), shown AND stored as whole strings, three ordinary true sentences kept. Roles only."""
import pytest

from tests.test_orw408_sentence_rewrite import _drive

pytestmark = [pytest.mark.usefixtures("non_game_text_routing")]

T3 = "Rain taps the glass. A cup is set down. The kettle ticks. "
T3S = T3.strip()
EARLY = {"timeOfDay": "late-night", "earlyMorning": True, "clockLabel": "5:30am, Day 3", "asleep": ["Sam Role"], "awake": ["Ana Role"], "started": True, "pending": None}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    import src.settings as st
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")
    real = st.get_setting
    monkeypatch.setattr(st, "get_setting", lambda k, d=None: True if k == "zero_clocks" else real(k, d))


def _round(monkeypatch, deltas, **kw):
    emitted, _cont, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": deltas}], redo="X", flag="0", **kw)
    return emitted.split("done.")[0].strip(), stored[0]


@pytest.mark.parametrize("quoted", ["'It was 3 a.m.' You nod.", "‘It was 3 a.m.’ You nod.", '"It was 3 a.m." You nod.', "“It was 3 a.m.” You nod."])
def test_a_dropped_quoted_sentence_takes_its_closing_quote_with_it(monkeypatch, quoted):
    shown, stored = _round(monkeypatch, [f"The kettle ticks. {quoted} " + T3])
    expected = "The kettle ticks. You nod. " + T3S
    assert shown == expected and stored == expected, (shown, stored)


def test_a_closer_that_does_not_belong_to_the_dropped_sentence_is_kept(monkeypatch):
    shown, stored = _round(monkeypatch, ["It was 3 a.m. 'Rain taps.' You nod. A cup is set down. The kettle ticks. "])
    expected = "'Rain taps.' You nod. A cup is set down. The kettle ticks."
    assert shown == expected and stored == expected, (shown, stored)


@pytest.mark.parametrize("line,kept", [
    ("‘Good morning,’ Ana whispers, already dressed. ", True),
    ("‘Good morning,’ Sam whispers, already dressed. ", False),
    ("‘Good morning,’ someone whispers. ", False),
])
def test_curly_single_quotes_are_screened_like_straight_ones(monkeypatch, line, kept):
    shown, stored = _round(monkeypatch, [T3, line, "Steam rises. "], status=EARLY)
    expected = T3S + (" " + line.strip() if kept else "") + " Steam rises."
    assert shown == expected and stored == expected, (shown, stored)


def test_the_reported_house_split_sentence_is_not_read_as_a_clock():
    """The zero-clock reader no longer takes "split five to four" for a time. (Not driven through the loop: a "split N to M" sentence is a vote tally, which the closed-set screen checks against the live board by design.)"""
    from routes import chat_helpers as ch
    assert not ch.sentence_states_zero_clock_time("The house split five to four.")
    assert ch.sentence_states_zero_clock_time("The house split at five to four.")


@pytest.mark.parametrize("deltas,expected", [
    (["The kettle ticks. The clock says 9.", "15am. Then he left. " + T3], "The kettle ticks. Then he left. " + T3S),
    (["The kettle ticks. The clock says 4.", "30pm. Then he left. " + T3], "The kettle ticks. Then he left. " + T3S),
    (["The kettle ticks. Room 9.", " Then he left. " + T3], "The kettle ticks. Room 9. Then he left. " + T3S),          # a real "9." sentence end: held one chunk, then shown
    ([T3 + "He was 9."], T3S + " He was 9."),                                                                            # ...and resolved by the round's flush
])
def test_a_chunk_ending_after_a_bare_number_dot_is_held_until_the_next_chunk(monkeypatch, deltas, expected):
    shown, stored = _round(monkeypatch, deltas)
    assert shown == expected and stored == expected, (shown, stored)


def test_a_rewritten_sentence_is_not_counted_as_dropped():
    from src.agent_loop import _chunk_ended_in_drop as ended
    raw = "Role A nods. Role B whispers a secret."
    assert ended(raw, "Role A nods.") is True                       # really dropped
    assert ended(raw, "Role A nods. Role B keeps quiet.") is False  # a later guard rewrote it
    assert ended(raw, "Role A nods. Role B whispers a secret.") is False


T = '<tool_call><invoke name="bash"><parameter name="command">echo hi</parameter></invoke></tool_call>'


@pytest.mark.parametrize("closer", ["</tool_calls>", "</function_calls>"])
@pytest.mark.parametrize("make", [
    lambda c: [f"The kitchen goes quiet. {c} Role A sets her mug down. " + T3],
    lambda c: [f"The kitchen goes quiet.{c}Role A sets her mug down. " + T3],
    lambda c: ["The kitchen goes quiet. ", f"{c} Role A sets her mug down. " + T3],
    lambda c: [f"The kitchen goes quiet. {c[:5]}", f"{c[5:]} Role A sets her mug down. " + T3],
])
def test_a_stray_plural_closer_is_cut_from_shown_and_stored(monkeypatch, closer, make):
    shown, stored = _round(monkeypatch, make(closer))
    expected = "The kitchen goes quiet. Role A sets her mug down. " + T3S
    assert shown == expected and stored == expected, (shown, stored)


def test_a_call_wrapped_in_the_plural_tags_still_parses_and_runs_once(monkeypatch):
    for wrapped in (f"<tool_calls>{T}</tool_calls>", f"<function_calls>{T}</function_calls>", f"{T}</function_calls>"):
        extra = {}
        emitted, _c, stored, _ = _drive(monkeypatch, rounds_scripts=[{"deltas": [T3, wrapped]}, {"deltas": ["The morning moves on."]}], redo="X", flag="0", extra=extra)
        assert extra["runs"] == ["bash"], (wrapped, extra["runs"])
        assert emitted.split("The morning moves on.")[0].strip() == stored[0] == T3S


def test_only_the_plural_closers_are_cut_never_an_opener_or_a_singular_closer():
    from src.agent_loop import _mirror_placeholder_cut as cut
    raw = "Role A nods. <tool_calls> <function_calls> </tool_call> <invoke name=\"x\"> <tool_call> Role B waits."
    assert cut(raw, raw) == (raw, raw)
    rr, before = cut("Role A nods. </tool_calls> Role B waits.", "Role A nods. </tool_calls> Role B waits.")
    assert rr == before == "Role A nods. Role B waits."
