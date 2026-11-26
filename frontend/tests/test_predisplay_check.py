"""ORW-408 first slice: the pre-display hard-fact checker + counter. Roles only; no model calls."""
import asyncio

import pytest

from src import predisplay_check as pc

STATE = {"asleep": [{"name": "Sleeper Role"}], "daySchedule": {"next": "nominations", "tomorrow": True}}


def test_asleep_houseguest_speaking_is_detected():
    assert pc.find_conflicts('Sleeper says, "Morning, everyone." The kettle clicks.', STATE, zero_clocks=False) == [pc.FACT_ASLEEP]


def test_asleep_houseguest_acting_without_quote_is_detected():
    assert pc.FACT_ASLEEP in pc.find_conflicts("Sleeper Role walks into the kitchen.", STATE, zero_clocks=False)


def test_asleep_houseguest_merely_mentioned_as_sleeping_is_clean():
    assert pc.find_conflicts("Sleeper Role is asleep in bed, snoring softly.", STATE, zero_clocks=False) == []


def test_clock_time_detected_only_when_zero_clocks_on():
    assert pc.find_conflicts("It's 8:15 in the morning.", STATE, zero_clocks=True) == [pc.FACT_CLOCK]
    assert pc.find_conflicts("It's 8:15 in the morning.", STATE, zero_clocks=False) == []


def test_schedule_words_contradicting_tomorrow_detected():
    assert pc.find_conflicts("The nomination ceremony is this afternoon.", STATE, zero_clocks=False) == [pc.FACT_SCHEDULE]
    assert pc.find_conflicts("The nominations happen tonight.", STATE, zero_clocks=False) == [pc.FACT_SCHEDULE]


def test_schedule_words_fine_when_event_is_tomorrow_or_today():
    assert pc.find_conflicts("The nomination ceremony is tomorrow.", STATE, zero_clocks=False) == []
    today = {"daySchedule": {"next": "nominations"}}
    assert pc.find_conflicts("The nomination ceremony is this afternoon.", today, zero_clocks=False) == []


def test_clean_text_passes_and_bad_state_fails_open():
    assert pc.find_conflicts("The couch is warm. Someone laughs in the next room.", STATE, zero_clocks=True) == []
    assert pc.find_conflicts("anything", None, zero_clocks=True) == []


def test_correction_names_each_fact():
    assert all(pc.correction_for(f) for f in (pc.FACT_ASLEEP, pc.FACT_CLOCK, pc.FACT_SCHEDULE))


def test_asleep_name_inside_quoted_speech_or_merely_mentioned_is_clean():
    for text in ('"Sleeper Role is asleep," Other whispers.', '"Where\'s Sleeper?" Other asked.', "Other looks over at Sleeper Role and sighs.",
                 '\u201cSleeper Role is asleep,\u201d Other whispers.'):
        assert pc.find_conflicts(text, STATE, zero_clocks=False) == [], text


def test_asleep_speaker_tag_and_attribution_and_subject_still_count():
    assert pc.find_conflicts('@[Sleeper Role] \u2014 "Morning."', STATE, zero_clocks=False) == [pc.FACT_ASLEEP]
    assert pc.find_conflicts('"Morning," Sleeper asks.', STATE, zero_clocks=False) == [pc.FACT_ASLEEP]
    assert pc.find_conflicts("Sleeper quietly sits on the couch.", STATE, zero_clocks=False) == [pc.FACT_ASLEEP]


def test_schedule_check_ignores_quoted_speech():
    assert pc.find_conflicts('"The nominations are tonight," Other guesses.', STATE, zero_clocks=False) == []


def test_counter_is_plain_not_a_health_event_and_text_untouched(monkeypatch):
    import src.log_rings as lr
    seen = []
    monkeypatch.setattr(lr, "record_soft_failure", lambda cls, exc, **kw: seen.append(cls))
    from src import engine_read_cache as erc
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0, fields=None: STATE)
    monkeypatch.setattr("src.zero_clocks.zero_clocks_on", lambda: True)
    pc.PREDISPLAY_COUNTS.clear()
    got = asyncio.new_event_loop().run_until_complete(pc.check_and_count('Sleeper says, "It\'s 8:15." The nominations are tonight.', "u"))
    assert got == [pc.FACT_ASLEEP, pc.FACT_CLOCK, pc.FACT_SCHEDULE]
    assert seen == [], "a count-only hit must not raise a RED-eligible health event"
    assert pc.PREDISPLAY_COUNTS == {f: 1 for f in got}


def test_check_with_refresh_off_never_fetches_and_counts_a_skip(monkeypatch):
    from src import engine_read_cache as erc, orwell_engine
    monkeypatch.setenv("ORWELL_PREDISPLAY_READ_TIMEOUT_S", "0")
    pc.CHECK_STATS["skipped"].clear()
    called = []

    async def slow(*a, **k):
        called.append(1)
        await asyncio.sleep(30)
    monkeypatch.setattr(orwell_engine, "get_game_state_polled", slow)
    monkeypatch.setattr(orwell_engine, "get_game_state", slow)
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0, fields=None: None)
    got = asyncio.new_event_loop().run_until_complete(asyncio.wait_for(pc.check_and_count("Sleeper Role walks in.", "u"), 1))
    assert got == [] and called == []
    assert pc.CHECK_STATS["skipped"] == {"no-cache": 1}


def test_flag_off_counts_nothing_and_reads_nothing(monkeypatch):
    from src import engine_read_cache as erc, orwell_engine
    reads = []
    monkeypatch.setattr(erc, "peek", lambda *a, **k: reads.append("peek") or STATE)
    monkeypatch.setattr(orwell_engine, "get_game_state_polled", lambda *a, **k: reads.append("polled"))
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda *a, **k: reads.append("direct"))  # review of #2751: the direct engine read is a second entry point
    monkeypatch.setenv("ORWELL_PREDISPLAY_CHECK", "0")
    assert asyncio.new_event_loop().run_until_complete(pc.check_and_count("It's 8:15.", "u")) == []
    assert reads == [], "review of #2682: a disabled checker must not touch the cache or the engine"


def test_orw437_the_real_peek_honours_the_staleness_cutoff_and_invalidation(monkeypatch):
    """review of #2700: check_and_count skips on an aged or invalidated cache entry (the real `engine_read_cache.peek`)."""
    from src import engine_read_cache as erc
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "400")
    erc.clear()
    monkeypatch.setenv("ORWELL_PREDISPLAY_READ_TIMEOUT_S", "0")  # this test is about the cache-only path
    loop = asyncio.new_event_loop()

    async def fetch():
        return {"asleep": [{"name": "Sleeper Role"}]}

    loop.run_until_complete(erc.read("getGameState", "u-peek", fetch))
    text = "Sleeper Role walks into the kitchen."
    assert loop.run_until_complete(pc.check_and_count(text, "u-peek")) == [pc.FACT_ASLEEP]
    real = erc.time.monotonic
    monkeypatch.setattr(erc.time, "monotonic", lambda: real() + 31.0)
    assert erc.peek("getGameState", "u-peek") is None and loop.run_until_complete(pc.check_and_count(text, "u-peek")) == []
    monkeypatch.setattr(erc.time, "monotonic", real)
    assert loop.run_until_complete(pc.check_and_count(text, "u-peek")) == [pc.FACT_ASLEEP]
    erc.invalidate("u-peek")
    assert loop.run_until_complete(pc.check_and_count(text, "u-peek")) == []
    erc.clear()


def test_orw437_a_speaker_tag_inside_a_quotation_is_not_an_asleep_conflict():
    """review of #2728 / #2700: the speaker-tag check matches the text outside quotes, so a quoted (or carried-open) tag never counts."""
    from src import predisplay_check as pc
    assert pc.asleep_conflicts('He reads aloud:\n"first line\n@[Sleeper Role] - hello\nlast line"', ["Sleeper Role"]) == []
    assert pc.asleep_conflicts("@[Sleeper Role] - hello", ["Sleeper Role"], in_quote=True) == []
    assert pc.asleep_conflicts("@[Sleeper Role] - hello", ["Sleeper Role"]) == ["Sleeper Role"]


def test_orw437_repeated_matches_of_one_fact_count_once(monkeypatch):
    """review of #2682: several clock / asleep / schedule matches in one text are ONE count per fact."""
    from src import engine_read_cache as erc
    monkeypatch.setattr(erc, "peek", lambda name, user, max_age_s=30.0, fields=None: STATE)
    monkeypatch.setattr("src.zero_clocks.zero_clocks_on", lambda: True)
    pc.PREDISPLAY_COUNTS.clear()
    text = "Sleeper walks in. Sleeper sits down. It is 8:15, then 9:40. The nominations are tonight. The nominations start this evening."
    got = asyncio.new_event_loop().run_until_complete(pc.check_and_count(text, "u"))
    assert got == [pc.FACT_ASLEEP, pc.FACT_CLOCK, pc.FACT_SCHEDULE] and pc.PREDISPLAY_COUNTS == {f: 1 for f in got}


# ── ORW-408 second round ─────────────────────────────────────────────────────────────────────────────────────────────

def test_an_inch_mark_is_not_a_quote_so_later_chunks_are_still_checked():
    # finding 6: `5'10"` is a height, not an opening quote; the round must not read as "inside a quote" afterwards
    round_text = "A tall houseguest, 5'10\", leans on the counter. "
    assert pc.quote_open_after(round_text) is False
    assert pc.FACT_ASLEEP in pc.find_conflicts("Sleeper Role walks in.", STATE, zero_clocks=False, in_quote=pc.quote_open_after(round_text))


def test_a_stray_quote_does_not_exempt_the_rest_of_the_round():
    # an odd count must stop carrying at a paragraph break
    assert pc.quote_open_after('Someone says, "Wait.') is True
    assert pc.quote_open_after('Someone says, "Wait.\n\nThe kettle clicks. ') is False


def test_a_carried_quote_is_bounded_in_length():
    long_open = '"' + ("a long unclosed line, " * 60)
    assert len(long_open) > 600 and pc.quote_open_after(long_open) is False
    assert pc.quote_open_after('"short line, still going') is True


def test_a_normal_multi_chunk_quote_still_carries():
    assert pc.quote_open_after('She says, "Nobody\'s safe. ') is True
    assert pc.quote_open_after('She says, "Nobody\'s safe. The nominations are tonight." ') is False


def test_a_short_sentence_equal_to_a_shown_one_is_not_dropped_as_a_repeat():
    shown = "The kitchen is quiet. Okay. "
    assert pc.drop_repeated_prefix("Okay. The kettle clicks off.", shown) == "Okay. The kettle clicks off."
    assert pc.drop_repeated_prefix("Fine.", "Fine. ") == "Fine."


def test_a_long_repeated_sentence_is_still_dropped():
    shown = "The kitchen is quiet and everyone is waiting. "
    assert pc.drop_repeated_prefix("The kitchen is quiet and everyone is waiting. The kettle clicks off.", shown).strip() == "The kettle clicks off."


def test_a_stated_clock_time_in_dialogue_is_still_a_conflict():
    # the zero-clocks rule (ORW-377) covers houseguests as well as the narrator: quoted speech is NOT exempt
    assert pc.find_conflicts('She says, "Meet at 3:00 PM."', STATE, zero_clocks=True) == [pc.FACT_CLOCK]
