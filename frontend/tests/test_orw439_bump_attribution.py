"""ORW-439: the dropped-fold alarm explains itself.

The engine now says which tool caused each beatSeq bump (`beatLog`). When the sync ledger is about to read a between-turn gap as a
dropped fold, the async turn path (`agent_loop._explain_ledger_gap`) asks the engine and `record_turn` classifies:

  * every bump caused by a tool this FE dispatched in the window but did not count -> a WARNING "counting miss", not a red alarm;
  * an "outside-a-tool-call" bump, a tool this FE did not dispatch, a truncated log, or an engine without the tool -> red as before
    (the causes appended when the engine answered).

Everything here goes through production code: the real dispatch seam (`orwell_engine._call` -> `note_engine_write`), the real
`_explain_ledger_gap` / `peek_unexplained_gap` / `classify_gap` / `record_turn`; only the HTTP transport is stubbed. Roles only."""
import asyncio
import importlib
import logging

import pytest

ledger = importlib.import_module("src.orwell_sync_ledger")
log_rings = importlib.import_module("src.log_rings")
oe = importlib.import_module("src.orwell_engine")
cache = importlib.import_module("src.engine_read_cache")
al = importlib.import_module("src.agent_loop")

BASE_RED = ("an unaccounted beatSeq gap between turns — the board moved without this FE recording the write or "
            "reconciling a cross-window advance")
_MARK = 0


@pytest.fixture
def _led(tmp_path, monkeypatch):
    global _MARK
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "ledger.json")
    dicts = (ledger._PENDING_STALE, ledger._LAST_BEAT_AFTER, ledger._PENDING_FE_WRITES, ledger._PENDING_BELTS,
             ledger._PENDING_FORCED, ledger._PARKED_BELTS, ledger._PARKED_FORCED, ledger._WINDOW_DISPATCHED)
    for d in dicts:
        d.clear()
    ledger._IN_TURN.clear()
    _MARK = log_rings.OVERSEER.since(0, limit=1)[0]
    yield
    for d in dicts:
        d.clear()
    ledger._IN_TURN.clear()


def _reds():
    _, lines = log_rings.OVERSEER.since(_MARK, limit=100000)
    return [e for e in lines if e.get("kind") == "sync:dropped-fold" and e.get("ok") is False]


def _text(e):
    return " ".join(str(v) for v in e.values())


def _engine(monkeypatch, beat_log):
    """Stub the HTTP transport only. `beat_log`: a dict answer, or an exception to raise (an older engine without the tool)."""
    seen = []

    async def transport(name, args=None, user=None, timeout=None):
        seen.append((name, args))
        if name == "beatLog":
            if isinstance(beat_log, Exception):
                raise beat_log
            return beat_log
        return {"ok": True}
    monkeypatch.setattr(oe, "_call_inner", transport)
    return seen


def _dispatch(*names):
    async def go():
        for n in names:
            await oe._call(n, {}, user="player")
    asyncio.run(go())


def _finish_turn(before=12, last_after=10):
    """The turn path exactly as agent_loop runs it: ask the engine (async), then record the turn with the explanation."""
    ledger._LAST_BEAT_AFTER["player"] = last_after
    expl = asyncio.run(al._explain_ledger_gap("player", beat_seq_before=before, stale_before=0))
    al._record_sync_ledger_turn("player", session_id="s", tool_events=[], beat_seq_before=before, stale_before=0,
                                nudges_fired=0, auto_backfills=0, gap_explanation=expl)
    return expl, ledger.get_recent("player", 1)[-1]


def _bumps(*tools, start=11):
    return {"beatSeq": start + len(tools) - 1, "truncated": False,
            "bumps": [{"seq": start + i, "tool": t, "at": 1} for i, t in enumerate(tools)]}


def test_a_gap_caused_by_a_dispatched_but_uncounted_tool_is_a_counting_miss_not_a_red_alarm(_led, monkeypatch, caplog):
    seen = _engine(monkeypatch, _bumps("recordRoomCanon", "recordRoomCanon"))  # a write on no bumping list that in fact bumps twice
    _dispatch("recordRoomCanon")
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0  # the ledger did not count it: that is the miss
    with caplog.at_level(logging.WARNING, logger=ledger.logger.name):
        expl, entry = _finish_turn()
    assert ("beatLog", {"sinceBeatSeq": 10}) in seen
    assert expl["kind"] == "counting-miss"
    assert _reds() == []
    warn = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING and "counting miss" in r.getMessage()]
    assert len(warn) == 1 and "recordRoomCanon x2" in warn[0]
    assert entry["gapExplanation"]["kind"] == "counting-miss"
    assert entry["gapExplanation"]["tools"] == {"recordRoomCanon": 2}


def test_a_gap_with_an_outside_a_tool_call_bump_stays_red_and_names_the_cause(_led, monkeypatch):
    _engine(monkeypatch, _bumps("recordRoomCanon", "outside-a-tool-call"))
    _dispatch("recordRoomCanon")
    expl, entry = _finish_turn()
    assert expl["kind"] == "unexplained"
    reds = _reds()
    assert len(reds) == 1
    assert BASE_RED in _text(reds[0]) and "seq 12 outside-a-tool-call" in _text(reds[0])
    assert entry["gapExplanation"]["kind"] == "unexplained"


def test_a_bump_from_a_tool_this_fe_did_not_dispatch_in_the_window_stays_red(_led, monkeypatch):
    _engine(monkeypatch, _bumps("recordRoomCanon", "advanceGame"))
    _dispatch("recordRoomCanon")  # advanceGame was never dispatched here (another window / device drove it)
    expl, _ = _finish_turn()
    assert expl["kind"] == "unexplained" and "advanceGame" in expl["note"]
    assert len(_reds()) == 1 and "seq 12 advanceGame" in _text(_reds()[0])


def test_an_engine_without_the_tool_leaves_the_alarm_exactly_as_before(_led, monkeypatch):
    _engine(monkeypatch, oe.EngineToolError("tool \"beatLog\" is not available on channel \"player\"", status=400))
    _dispatch("recordRoomCanon")
    expl, entry = _finish_turn()
    assert expl is None
    assert "gapExplanation" not in entry
    reds = _reds()
    assert len(reds) == 1
    assert BASE_RED in _text(reds[0]) and "engine bump causes" not in _text(reds[0])
    assert "(beatSeq gap 2" in _text(reds[0])


def test_a_truncated_log_leaves_the_alarm_red(_led, monkeypatch):
    log = _bumps("recordRoomCanon", "recordRoomCanon")
    log["truncated"] = True
    _engine(monkeypatch, log)
    _dispatch("recordRoomCanon")
    expl, _ = _finish_turn()
    assert expl["kind"] == "unexplained" and "does not reach back" in expl["note"]
    assert len(_reds()) == 1


def test_a_log_that_misses_bumps_in_the_gap_is_not_a_counting_miss(_led, monkeypatch):
    _engine(monkeypatch, _bumps("recordRoomCanon"))  # gap is 2 but the engine accounts for one
    _dispatch("recordRoomCanon")
    expl, _ = _finish_turn()
    assert expl["kind"] == "unexplained"
    assert len(_reds()) == 1


def test_a_gap_the_counting_already_explains_never_asks_the_engine(_led, monkeypatch):
    seen = _engine(monkeypatch, _bumps("noteMessage", "noteMessage"))
    _dispatch("noteMessage", "noteMessage")  # a counted bumping write each: the gap of 2 is explained
    expl, _ = _finish_turn()
    assert expl is None and not any(n == "beatLog" for n, _ in seen)
    assert _reds() == []


def test_a_gap_with_a_desync_reconcile_is_not_asked_about(_led, monkeypatch):
    ledger._LAST_BEAT_AFTER["player"] = 10
    assert ledger.peek_unexplained_gap("player", beat_seq_before=12, desync_detected=True) is None


def test_the_new_tool_is_a_pure_read_in_the_ledger_lists_and_is_never_counted(_led, monkeypatch):
    assert "beatLog" in cache.PURE_READS
    assert "beatLog" not in ledger.BUMPING_WRITES and "beatLog" not in ledger.NON_BUMPING_WRITES
    _engine(monkeypatch, _bumps("recordRoomCanon"))
    out = asyncio.run(oe.beat_log(10, user="player"))
    assert out["bumps"][0]["tool"] == "recordRoomCanon"
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0
    assert ledger._WINDOW_DISPATCHED.get("player", {}).get("beatLog") is None  # reading the log is not a dispatch to explain


def test_the_stored_explanation_holds_names_and_numbers_only(_led):
    cleaned = ledger._clean_gap_explanation({"kind": "unexplained", "note": "secret prose",
                                             "bumps": [{"seq": 3, "tool": "x", "args": {"a": "secret"}}], "tools": {"x": 1}})
    assert cleaned == {"kind": "unexplained", "bumps": [{"seq": 3, "tool": "x"}], "tools": {"x": 1}}
    assert ledger._clean_gap_explanation({"kind": "other"}) is None
