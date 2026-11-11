"""ORW-79 (A95): the narrator sets the scene with a period-of-day LIGHT phrase ("the afternoon sun") that disagrees with the engine clock - `_clock_misstated` only reads an explicit "it's H:MM". The new
`_time_of_day_words_misstated` is its scene-setting sibling in the same closed-set, next-turn re-ground family (never an edit of creative prose). Narrow: light/sun/glow phrases only, present tense only,
tolerant of flashbacks / future / hypotheticals / asides, and of a clock within the boundary tolerance of the named period. Pure: no model. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")


def live(label):
    return {"clockLabel": label}


def test_afternoon_light_at_a_morning_clock_is_flagged_with_the_real_clock():
    got = ch._time_of_day_words_misstated("Afternoon light slants across the kitchen island as Alice pours coffee.", live("9:05am, Day 3"))
    assert got and "9:05am, Day 3" in got and "morning" in got and "Afternoon light" in got


def test_each_period_is_checked_against_the_engine_period():
    assert ch._time_of_day_words_misstated("The morning sun fills the room.", live("2:30pm, Day 2"))
    assert ch._time_of_day_words_misstated("The evening glow warms the backyard.", live("10:00am, Day 2"))
    assert ch._time_of_day_words_misstated("The afternoon sun is harsh on the patio.", live("6:30pm, Day 2"))
    assert ch._time_of_day_words_misstated("The setting sun paints the wall.", live("9:00am, Day 2"))
    assert ch._time_of_day_words_misstated("Morning light fills the room.", live("11:30pm, Day 2"))


def test_the_matching_period_and_the_boundary_tolerance_are_never_flagged():
    assert ch._time_of_day_words_misstated("Morning light fills the room.", live("9:05am, Day 3")) is None
    assert ch._time_of_day_words_misstated("Afternoon light slants across the island.", live("2:30pm, Day 3")) is None
    assert ch._time_of_day_words_misstated("Afternoon light slants across the island.", live("11:30am, Day 3")) is None  # 30 min before the afternoon starts
    assert ch._time_of_day_words_misstated("The evening glow warms the yard.", live("3:30pm, Day 3")) is None


def test_flashbacks_future_hypotheticals_asides_and_non_light_time_words_are_tolerated():
    clock = live("9:05am, Day 3")
    for ok in (
        "She remembers the afternoon light in her old kitchen.",
        "Yesterday the afternoon sun was brutal on the yard.",
        "By tomorrow the afternoon sun will be on the patio.",
        "If this were the afternoon sun, we would be outside.",
        "((Production: the afternoon light is a continuity note.))",
        "They will meet this afternoon to talk it over.",
        "Bruno says the veto draw is this afternoon.",
        "The kitchen is quiet.",
    ):
        assert ch._time_of_day_words_misstated(ok, clock) is None, ok


def test_no_clock_or_an_unparseable_label_stands_down():
    assert ch._time_of_day_words_misstated("Afternoon light slants in.", {}) is None
    assert ch._time_of_day_words_misstated("Afternoon light slants in.", live("tea time")) is None
    assert ch._time_of_day_words_misstated("", live("9:05am, Day 3")) is None


def test_the_streamed_path_cuts_a_wrong_time_of_day_phrase_and_names_the_real_clock(monkeypatch):
    from test_n16_decisive_cues import _sig, _board, _run, _USER
    sig = _sig(phase="veto-competition", not_due=True)
    sig["clockLabel"] = "9:05am, Day 3"
    ch._LAST_BEAT_SIG[_USER] = dict(sig)
    _board(monkeypatch, sig)
    d = _run(ch.screen_streamed_scene_break(_USER, "Afternoon light slants across the kitchen island as Alice pours coffee."))
    assert d is not None and "9:05am, Day 3" in d, d
    assert _run(ch.screen_streamed_scene_break(_USER, "Morning light slants across the kitchen island as Alice pours coffee.")) is None


def test_it_is_part_of_the_desync_detector_that_feeds_the_reground():
    import inspect
    src = inspect.getsource(ch)
    assert "_clock_misstated(text, after) or _time_of_day_words_misstated(text, after)" in src
