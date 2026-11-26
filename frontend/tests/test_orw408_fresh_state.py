"""ORW-408: the pre-display check never skips silently. After an engine write the cache is empty; the check takes ONE bounded read, counts what it checked / skipped (with the
reason) / found, and the rewrite sees the same fresh state. Stubbed engine, no network, roles only."""
import asyncio
import importlib
import json
import time

import pytest

from src import engine_read_cache as erc
from src import predisplay_check as pc

t408 = importlib.import_module("test_orw408_sentence_rewrite")
STATE = {"asleep": [{"name": "Sleeper Role"}], "daySchedule": {"next": "nominations", "tomorrow": True}, "started": True, "beatSeq": 7}
TEXT = "Sleeper Role walks into the kitchen."


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    erc.clear()
    pc.CHECK_STATS["checked"] = 0
    pc.CHECK_STATS["turns"] = pc.CHECK_STATS["turns"] = 0
    pc.CHECK_STATS["turnsWithConflict"] = 0
    for k in ("skipped", "cacheMiss"):
        pc.CHECK_STATS[k].clear()
    pc.CHECK_STATS["stateFrom"].update(cache=0, read=0)
    pc.PREDISPLAY_COUNTS.clear()
    pc._TURN.clear()
    pc._READ_BACKOFF.clear()
    monkeypatch.delenv("ORWELL_PREDISPLAY_READ_TIMEOUT_S", raising=False)
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "400")  # the suite turns the cache off by default; the check's stored read needs it
    monkeypatch.setattr("src.zero_clocks.zero_clocks_on", lambda: False)
    yield
    erc.clear()


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _engine(monkeypatch, fn):
    from src import orwell_engine as oe
    monkeypatch.setattr(oe, "get_game_state", fn)


def test_a_reply_after_an_engine_write_is_checked_and_counted_not_skipped(monkeypatch):
    reads = []

    async def get(user=None, timeout=None):
        reads.append(timeout)
        return dict(STATE)
    _engine(monkeypatch, get)
    # the turn read state earlier, then wrote to the engine: the write drops the cached state
    _run(erc.read("getGameState", "u1", lambda: get()))
    erc.invalidate("u1")
    assert erc.peek("getGameState", "u1") is None
    assert _run(pc.check_and_count(TEXT, "u1")) == [pc.FACT_ASLEEP]
    snap = pc.stats_snapshot()
    assert snap["checked"] == 1 and snap["skippedTotal"] == 0
    assert snap["conflicts"] == {pc.FACT_ASLEEP: 1}
    assert snap["stateFrom"] == {"cache": 0, "read": 1} and snap["cacheMiss"] == {"no-cache": 1}
    assert reads[-1] is not None and reads[-1] <= 1.0, "the read is bounded"
    # the next chunk of the same turn reuses the stored read: no second engine call
    n = len(reads)
    _run(pc.check_and_count(TEXT, "u1"))
    assert len(reads) == n and pc.stats_snapshot()["stateFrom"]["cache"] == 1


def test_skips_are_counted_with_their_reason_when_the_refresh_is_off(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_READ_TIMEOUT_S", "0")
    assert _run(pc.check_and_count(TEXT, "u2")) == []
    assert pc.CHECK_STATS["skipped"] == {"no-cache": 1}
    real = erc.time.monotonic

    async def fetch():
        return dict(STATE)
    _run(erc.read("getGameState", "u2", fetch))
    monkeypatch.setattr(erc.time, "monotonic", lambda: real() + 31.0)
    assert _run(pc.check_and_count(TEXT, "u2")) == []
    assert pc.CHECK_STATS["skipped"] == {"no-cache": 1, "stale": 1}


def test_a_slow_engine_is_a_counted_timeout_skip_within_the_bound_and_backs_off(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_READ_TIMEOUT_S", "0.2")
    calls = []

    async def slow(user=None, timeout=None):
        calls.append(1)
        await asyncio.sleep(30)
    _engine(monkeypatch, slow)
    t0 = time.monotonic()
    assert _run(pc.check_and_count(TEXT, "u3")) == []
    assert time.monotonic() - t0 < 2.0
    assert pc.CHECK_STATS["skipped"] == {"timeout": 1}
    t1 = time.monotonic()
    assert _run(pc.check_and_count(TEXT, "u3")) == []  # inside the back-off: no second wait, still counted
    assert time.monotonic() - t1 < 0.1 and len(calls) == 1
    assert pc.CHECK_STATS["skipped"] == {"timeout": 2}


def test_a_failed_read_and_a_no_game_answer_are_counted_as_other(monkeypatch):
    async def boom(user=None, timeout=None):
        raise RuntimeError("engine down")
    _engine(monkeypatch, boom)
    assert _run(pc.check_and_count(TEXT, "u4")) == []

    async def nogame(user=None, timeout=None):
        return {"started": False}
    _engine(monkeypatch, nogame)
    pc._READ_BACKOFF.clear()
    assert _run(pc.check_and_count(TEXT, "u5")) == []
    assert pc.CHECK_STATS["skipped"] == {"other": 2}


def test_one_info_line_per_turn_with_the_tally(monkeypatch, caplog):
    async def get(user=None, timeout=None):
        return dict(STATE)
    _engine(monkeypatch, get)
    _run(pc.check_and_count(TEXT, "u6"))
    _run(pc.check_and_count("The kitchen is quiet.", "u6"))
    with caplog.at_level("INFO", logger=pc.logger.name):
        pc.end_turn("u6")
        pc.end_turn("u6")  # nothing left: no second line
    lines = [r.getMessage() for r in caplog.records if "[predisplay-turn]" in r.getMessage()]
    assert lines == ["[predisplay-turn] checked=2 skipped=0 conflicts=%s:1" % pc.FACT_ASLEEP]
    assert pc.CHECK_STATS["turns"] == 1 and pc.CHECK_STATS["turnsWithConflict"] == 1


def test_the_admin_health_snapshot_carries_the_counters():
    from routes import admin_health_routes as ahr
    pc.CHECK_STATS["checked"] = 3
    sec = ahr._predisplay_section()
    assert sec["checked"] == 3 and "skipped" in sec and "conflicts" in sec and "stateFrom" in sec


@pytest.mark.usefixtures("non_game_text_routing")
def test_through_the_real_loop_an_empty_cache_still_gets_a_check_and_the_contradiction_is_counted(monkeypatch):
    """Old code: no cached state at display time => the check returned [] silently. Rewrite off: counted, still shown (today's behaviour)."""
    emitted, _c, _s, _n = t408._drive(monkeypatch, rounds_scripts=[{"deltas": [t408.CLEAN_A, t408.BAD, t408.TAIL]}], flag="0", engine_state=STATE, owner="orw408-fresh")
    assert pc.PREDISPLAY_COUNTS.get(pc.FACT_ASLEEP) == 1, pc.PREDISPLAY_COUNTS
    assert pc.CHECK_STATS["skipped"] == {} and pc.CHECK_STATS["stateFrom"]["read"] >= 1


@pytest.mark.usefixtures("non_game_text_routing")
def test_with_the_rewrite_on_a_contradicting_reply_never_reaches_the_player_even_after_a_write(monkeypatch):
    """The shipped default (no env): the cache starts EMPTY (as after a narrator turn's writes), the check takes its one read, the contradicting sentence is withheld and redone."""
    monkeypatch.delenv("ORWELL_PREDISPLAY_REWRITE", raising=False)
    assert pc.predisplay_rewrite_enabled() is True
    emitted, cont, _s, _n = t408._drive(monkeypatch, rounds_scripts=[{"deltas": [t408.CLEAN_A, t408.BAD, t408.TAIL]}], redo=t408.REDO.strip(), flag=None, engine_state=STATE, owner="orw408-on")
    assert "Sleeper Role says" not in emitted and "Morning, everyone" not in emitted
    assert len(cont) == 1 and emitted.strip() == (t408.CLEAN_A + t408.REDO).strip()
