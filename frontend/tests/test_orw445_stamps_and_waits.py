"""ORW-445: the persisted bubble header is stamped from the POST-tool state; a stated wait length reaches the clock. Roles only."""
import asyncio

import pytest

from routes import chat_helpers as ch
from src import orwell_engine


def _gs(tod, day=3, week=1):
    return {"started": True, "week": week, "dayNumber": day, "phase": "nominations", "timeOfDay": tod}


def test_header_restamped_after_a_nap_moves_the_clock(monkeypatch):
    ch._LAST_FRAMED_GAME_MOMENT["u"] = ch._format_game_moment(_gs("morning"))  # stamped at framing, before the nap
    assert ch.current_game_moment("u").endswith("Morning")

    async def read(user=None):
        return _gs("afternoon", day=3)
    monkeypatch.setattr(orwell_engine, "get_game_state", read)
    asyncio.run(ch.refresh_framed_game_stamps("u"))
    assert ch.current_game_moment("u").endswith("Afternoon")
    assert ch.current_game_day("u") == 3 and ch.current_game_week("u") == 1


def test_hiccup_keeps_the_start_of_turn_stamp(monkeypatch):
    ch._LAST_FRAMED_GAME_MOMENT["u2"] = "Week 1 · Nominations · Morning"

    async def boom(user=None):
        raise RuntimeError("engine blip")
    monkeypatch.setattr(orwell_engine, "get_game_state", boom)
    asyncio.run(ch.refresh_framed_game_stamps("u2"))
    assert ch.current_game_moment("u2") == "Week 1 · Nominations · Morning"


def test_a_stalled_engine_read_is_bounded_and_keeps_the_stamp(monkeypatch):
    """Review of #2772: the persist-time refresh never holds the save for the engine's full timeout."""
    ch._LAST_FRAMED_GAME_MOMENT["u4"] = "Week 1 · Nominations · Morning"
    monkeypatch.setattr(ch, "_STAMP_REFRESH_TIMEOUT", 0.05)

    async def stall(user=None):
        await asyncio.sleep(30)
    monkeypatch.setattr(orwell_engine, "get_game_state", stall)

    async def run():
        t = asyncio.get_running_loop().time()
        await ch.refresh_framed_game_stamps("u4")
        return asyncio.get_running_loop().time() - t
    assert asyncio.run(run()) < 2
    assert ch.current_game_moment("u4") == "Week 1 · Nominations · Morning"


def test_pregame_stays_none(monkeypatch):
    ch._LAST_FRAMED_GAME_MOMENT.pop("u3", None)

    async def read(user=None):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", read)
    asyncio.run(ch.refresh_framed_game_stamps("u3"))
    assert ch.current_game_moment("u3") is None


def test_persist_sites_refresh_before_reading_the_stamp():
    src = open(ch.__file__.replace("chat_helpers.py", "chat_routes.py")).read()
    assert src.count("refresh_framed_game_stamps(ctx.user") == 4
    read_sites = 0
    for line_no, line in enumerate(src.splitlines()):
        if "current_game_moment(ctx.user) if ctx.game_active" in line:
            read_sites += 1
            assert "refresh_framed_game_stamps" in "\n".join(src.splitlines()[line_no - 2:line_no])
    assert read_sites == 4, "the read-site match went vacuous (review of #2772): one stamp read per persist site"


@pytest.mark.parametrize("msg,want", [
    ("let's wait around for a couple more hours", (120, False)),
    ("I'll wait for a couple of hours", (120, False)),
    ("hang out for a few hours", (180, False)),
    ("chill for 2 hours", (120, False)),
    ("chill for an hour", (60, False)),
    ("wait for an hour and a half", (90, False)),
    ("hang out for half an hour", (30, False)),
    ("kick back for 45 minutes", (45, False)),
    ("relax for six hours", (180, False)),  # hard cap
    ("wait for the rest of the morning", (None, True)),
    ("wait for the rest of the afternoon", (None, True)),
    ("wait for a while", (None, False)),
    ("hang out until the comp", (None, False)),
    ("hang out for the rest of the day", (None, False)),
])
def test_stated_wait_parses(msg, want):
    assert ch.hang_out_intent(msg)
    assert ch.parse_stated_wait(msg) == want


def test_no_intent_no_target():
    assert ch.parse_stated_wait("I need an hour of sleep") == (None, False)
    assert ch.parse_stated_wait(None) == (None, False)


def test_maybe_hang_out_passes_the_target(monkeypatch):
    seen = {}

    async def fake(expected_beat_seq=None, max_beats=None, user=None, max_minutes=None, until_band_end=False):
        seen.update(max_minutes=max_minutes, until_band_end=until_band_end)
        return {"ok": True, "stopReason": "max-beats", "minutes": 120}
    monkeypatch.setattr(orwell_engine, "hang_out", fake)
    assert asyncio.run(ch.maybe_hang_out("w", {"started": True}, "wait around for a couple more hours"))
    assert seen == {"max_minutes": 120, "until_band_end": False}
    seen.clear()
    assert asyncio.run(ch.maybe_hang_out("w", {"started": True}, "wait around for a while"))
    assert seen == {"max_minutes": None, "until_band_end": False}


def test_rest_of_band_after_until_sets_the_band_target():
    """Review of #2772: the match ends at until/till, so the band phrase after it must still count."""
    assert ch.parse_stated_wait("hang out until the rest of the afternoon") == (None, True)
    assert ch.parse_stated_wait("chill till the rest of the morning") == (None, True)


@pytest.mark.parametrize("msg,want", [
    ("I wait a couple of hours", (120, False)),
    ("I'll stay here for another two hours", (120, False)),
    ("stay put for another three hours", (180, False)),
    ("sit here for a few hours", (180, False)),
    ("I'll linger for an hour", (60, False)),
    ("let's stick around another hour", (60, False)),
    ("wait around here for a couple of hours", (120, False)),
    ("wait here for an hour", (60, False)),
])
def test_orw477_stated_waits_start_a_hangout(msg, want):
    assert ch.hang_out_intent(msg)
    assert ch.parse_stated_wait(msg) == want


@pytest.mark.parametrize("msg", [
    "maybe I'll wait later",
    "maybe I'll wait a couple of hours",
    "should I wait a couple of hours?",
    'she said "I wait a couple of hours" and left',
    "I wait for the HOH to speak",
    "I need an hour of sleep",
])
def test_orw477_not_a_wait(msg):
    assert not ch.hang_out_intent(msg)
    assert ch.parse_stated_wait(msg) == (None, False)


@pytest.mark.parametrize("gs,want", [
    ({"started": True, "week": 1, "phase": "nominations", "timeOfDay": "morning", "earlyMorning": True}, "Week 1 · Nominations · Early morning"),
    ({"started": True, "week": 1, "phase": "nominations", "timeOfDay": "morning", "earlyMorning": False}, "Week 1 · Nominations · Morning"),
    ({"started": True, "week": 1, "phase": "nominations", "timeOfDay": "morning"}, "Week 1 · Nominations · Morning"),
    ({"started": True, "week": 1, "phase": "nominations", "timeOfDay": "late-night", "earlyMorning": True}, "Week 1 · Nominations · Early morning"),
    ({"started": True, "week": 1, "phase": "nominations", "timeOfDay": "evening", "earlyMorning": True}, "Week 1 · Nominations · Evening"),
])
def test_orw479_header_says_early_morning(gs, want):
    assert ch._format_game_moment(gs) == want


def test_orw479_pregame_none():
    assert ch._format_game_moment({"started": False, "earlyMorning": True}) is None
    assert ch._format_game_moment(None) is None
