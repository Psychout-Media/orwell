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


def test_orw875_a_missed_first_read_is_retried_so_the_stamp_is_not_a_phase_behind(monkeypatch):
    ch._LAST_FRAMED_GAME_MOMENT["u4"] = "Week 1 · Veto competition · Afternoon"  # the start-of-turn stamp
    calls = []

    async def slow_then_ok(user=None):
        calls.append(1)
        if len(calls) == 1:
            await asyncio.sleep(10)  # the first read misses its window
        return {"started": True, "week": 1, "dayNumber": 4, "phase": "veto-ceremony", "timeOfDay": "morning"}
    monkeypatch.setattr(orwell_engine, "get_game_state", slow_then_ok)
    monkeypatch.setattr(ch, "_STAMP_REFRESH_TIMEOUT", 0.05)
    asyncio.run(ch.refresh_framed_game_stamps("u4"))
    assert len(calls) == 2
    assert ch.current_game_moment("u4").endswith("Veto ceremony · Morning"), ch.current_game_moment("u4")


def test_pregame_stays_none(monkeypatch):
    ch._LAST_FRAMED_GAME_MOMENT.pop("u3", None)

    async def read(user=None):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", read)
    asyncio.run(ch.refresh_framed_game_stamps("u3"))
    assert ch.current_game_moment("u3") is None


def test_persist_sites_refresh_before_reading_the_stamp():
    src = open(ch.__file__.replace("chat_helpers.py", "chat_routes.py")).read()
    assert src.count("await refresh_framed_game_stamps(ctx.user)") == 4
    lines = src.splitlines()
    sites = [n for n, line in enumerate(lines) if "current_game_moment(ctx.user) if ctx.game_active" in line]
    assert len(sites) == 4, "the read sites changed: update this pin deliberately (review of #2772: it passed vacuously with no match)"
    for line_no in sites:
        assert "refresh_framed_game_stamps" in "\n".join(lines[line_no - 2:line_no])


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


def test_until_the_rest_of_the_band_is_a_band_target_even_after_until():
    assert ch.parse_stated_wait("hang out until the rest of the afternoon") == (None, True)
    assert ch.parse_stated_wait("chill till the rest of the morning") == (None, True)
    assert ch.parse_stated_wait("hang out for the rest of the afternoon") == (None, True)


def test_stamp_refresh_is_bounded_and_keeps_the_start_of_turn_stamp(monkeypatch):
    from src import orwell_engine
    ch._LAST_FRAMED_GAME_MOMENT["u-slow"] = "start-of-turn"

    async def hang(user=None):
        await asyncio.sleep(30)
    monkeypatch.setattr(orwell_engine, "get_game_state", hang)
    monkeypatch.setattr(ch, "_STAMP_REFRESH_TIMEOUT", 0.05)
    monkeypatch.setattr(ch, "_STAMP_REFRESH_RETRY_TIMEOUT", 0.05)  # ORW-875: the retry is bounded too
    import time
    t0 = time.monotonic()
    asyncio.run(ch.refresh_framed_game_stamps("u-slow"))
    assert time.monotonic() - t0 < 2
    assert ch._LAST_FRAMED_GAME_MOMENT["u-slow"] == "start-of-turn"


def test_rest_of_band_scan_stays_in_the_intents_own_sentence():
    """Cubic on main: a LATER sentence's "rest of the day/morning" must not change this wait's target."""
    assert ch.parse_stated_wait("I wait here for an hour. Tomorrow I will sleep for the rest of the morning") == (60, False)
    assert ch.parse_stated_wait("hang out until the rest of the afternoon. then bed for the rest of the night") == (None, True)
