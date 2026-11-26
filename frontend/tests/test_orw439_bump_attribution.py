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


def _reset_chat_globals():
    """The process-global stale counter, desync map and last-beat map belong to whichever test ran before: start clean."""
    from routes import chat_helpers as ch
    ch.reset_stale_beat_rejections()
    ch._DESYNC_REGROUND.pop("player", None)
    ch._LAST_BEAT_SEQ.pop(ch._beat_seq_key("player"), None)


@pytest.fixture
def _led(tmp_path, monkeypatch):
    global _MARK
    _reset_chat_globals()
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
    _reset_chat_globals()


def _reds():
    _, lines = log_rings.OVERSEER.since(_MARK, limit=100000)
    return [e for e in lines if e.get("kind") == "sync:dropped-fold" and e.get("ok") is False]


def _text(e):
    return " ".join(str(v) for v in e.values())


def _engine(monkeypatch, beat_log):
    """Stub the HTTP transport only. `beat_log`: a dict answer, or an exception to raise (an older engine without the tool)."""
    seen = []

    async def transport(name, args=None, user=None, timeout=None, **_kw):
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
    assert len(warn) == 1 and "recordRoomCanon: 2 bumps from 1 call" in warn[0]
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
    assert expl["kind"] == "unexplained" and "counted tool" in expl["note"]
    assert len(_reds()) == 1 and "seq 12 advanceGame" in _text(_reds()[0])


def test_a_bump_from_an_uncounted_tool_this_fe_did_not_dispatch_stays_red_and_says_so(_led):
    out = _classify(["recordRoomCanon", "recordDaySummary"], {"recordRoomCanon": 1})
    assert out["kind"] == "unexplained" and "recordDaySummary x1 (not dispatched" in out["note"]


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
    assert cleaned == {"kind": "unexplained", "bumps": [{"seq": 3, "tool": "x"}], "tools": {"x": 1}, "calls": {}}
    assert ledger._clean_gap_explanation({"kind": "other"}) is None


# ---- review round: the downgrade rule (H1) ----------------------------------------------------------------------------------

def _classify(tools, dispatched, counted=0, counted_writes=0, since=10):
    n = len(tools)
    info = {"since": since, "before": since + n, "dispatched": dispatched, "counted": counted, "counted_writes": counted_writes}
    return ledger.classify_gap(info, _bumps(*tools, start=since + 1))


def test_one_dispatch_and_three_bumps_of_an_uncounted_tool_stays_red(_led):
    out = _classify(["recordRoomCanon"] * 3, {"recordRoomCanon": 1})
    assert out["kind"] == "unexplained" and "more than 2 per call" in out["note"]


def test_one_dispatch_and_two_bumps_of_an_uncounted_tool_is_a_counting_miss(_led):
    out = _classify(["recordRoomCanon"] * 2, {"recordRoomCanon": 1})
    assert out["kind"] == "counting-miss" and out["tools"] == {"recordRoomCanon": 2} and out["calls"] == {"recordRoomCanon": 1}


def test_a_counted_tool_bumping_beyond_what_the_ledger_counted_stays_red(_led):
    # another window sends recordInteraction x3; this FE sent it once and the ledger counted one
    out = _classify(["recordInteraction"] * 3, {"recordInteraction": 1}, counted=1, counted_writes=1)
    assert out["kind"] == "unexplained"
    # the same name, one bump, one counted: nothing left unexplained by the rule's own counts, but the arithmetic is the ledger's
    ok = _classify(["recordInteraction", "recordRoomCanon"], {"recordInteraction": 1, "recordRoomCanon": 1}, counted=1, counted_writes=1)
    assert ok["kind"] == "counting-miss"


def test_a_counted_tool_in_the_log_with_nothing_counted_stays_red(_led):
    out = _classify(["recordInteraction", "recordRoomCanon"], {"recordInteraction": 1, "recordRoomCanon": 1}, counted=0, counted_writes=0)
    assert out["kind"] == "unexplained"


def test_the_arithmetic_must_close_over_the_whole_gap(_led):
    # 3 bumps: one counted-tool bump the ledger counted, two uncounted ones explained -> closes; with a stale-only allowance it does not
    assert _classify(["noteMessage", "recordRoomCanon", "recordRoomCanon"], {"noteMessage": 1, "recordRoomCanon": 1}, counted=1, counted_writes=1)["kind"] == "counting-miss"
    assert _classify(["noteMessage", "recordRoomCanon", "recordRoomCanon"], {"noteMessage": 1, "recordRoomCanon": 1}, counted=0, counted_writes=1)["kind"] == "unexplained"


def test_a_counted_write_does_not_lend_its_count_to_a_different_counted_tool(_led):
    # this FE sent one noteMessage (counted) that landed without bumping; another window sent moveTo. The total matches (1 counted,
    # 1 counted-tool bump) but the bump is not this FE's: per tool, moveTo bumped once and this FE never called it.
    out = _classify(["moveTo", "recordRoomCanon"], {"noteMessage": 1, "recordRoomCanon": 1}, counted=1, counted_writes=1)
    assert out["kind"] == "unexplained" and "moveTo x1, this FE called it 0 time(s)" in out["note"]
    # the same shape with the counted tool this FE really called is a counting miss
    ok = _classify(["noteMessage", "recordRoomCanon"], {"noteMessage": 1, "recordRoomCanon": 1}, counted=1, counted_writes=1)
    assert ok["kind"] == "counting-miss"


def test_the_same_named_write_from_elsewhere_is_red_end_to_end(_led, monkeypatch):
    _engine(monkeypatch, _bumps("recordInteraction", "recordInteraction", "recordInteraction"))
    _dispatch("recordInteraction")  # this FE sent one (counted), the engine log shows three
    expl, _ = _finish_turn(before=13, last_after=10)
    assert expl["kind"] == "unexplained"
    assert len(_reds()) == 1


def test_the_gap_peek_reports_the_ledgers_own_allowance(_led):
    ledger._LAST_BEAT_AFTER["player"] = 10
    ledger._PENDING_FE_WRITES["player"] = 1
    info = ledger.peek_unexplained_gap("player", beat_seq_before=13, stale_rejections=0)
    assert info["counted"] == 1 and info["counted_writes"] == 1 and info["gap"] == 3


# ---- M2: the dispatch window has the same span as the gap -------------------------------------------------------------------

def test_a_dispatch_recorded_before_clear_is_not_available_to_a_later_gap(_led):
    ledger.note_engine_write("player", "recordRoomCanon", {})
    ledger.clear("player")
    ledger._LAST_BEAT_AFTER["player"] = 10
    info = ledger.peek_unexplained_gap("player", beat_seq_before=12)
    assert info["dispatched"] == {}
    assert _classify(["recordRoomCanon"] * 2, info["dispatched"])["kind"] == "unexplained"


def test_a_dispatch_from_a_parked_never_ledgered_turn_does_not_downgrade_a_later_gap(_led):
    ledger.note_engine_write("player", "recordRoomCanon", {})
    ledger.park_pending_unledgered_turn("player")
    assert "player" not in ledger._WINDOW_DISPATCHED
    ledger._LAST_BEAT_AFTER["player"] = 10
    info = ledger.peek_unexplained_gap("player", beat_seq_before=12)
    assert _classify(["recordRoomCanon"] * 2, info["dispatched"])["kind"] == "unexplained"


def test_a_failed_durable_write_puts_the_dispatch_record_back_with_the_fe_write_count(_led, monkeypatch):
    ledger.note_engine_write("player", "noteMessage", {})
    monkeypatch.setattr(ledger, "atomic_write_json", lambda *a, **k: (_ for _ in ()).throw(OSError("disk")))
    ledger.record_turn("player", beat_seq_before=11, beat_seq_after=11)
    assert ledger._WINDOW_DISPATCHED.get("player") == {"noteMessage": 1}
    assert ledger._PENDING_FE_WRITES.get("player") == 1


# ---- M1: the quiet diagnostic read, through the REAL _post_tool --------------------------------------------------------------

httpx = importlib.import_module("httpx")


class _SeqClient:
    """The HTTP client only: yields the next scripted Response / raises the next scripted Exception."""

    def __init__(self, script):
        self._script, self.calls = list(script), 0

    async def post(self, *_a, **_k):
        self.calls += 1
        item = self._script.pop(0) if self._script else None
        if isinstance(item, Exception):
            raise item
        return item


def _resp(status, payload):
    return httpx.Response(status, json=payload, request=httpx.Request("POST", oe.ENGINE_URL.rstrip("/") + "/player/call"))


@pytest.fixture
def _real_post_tool(monkeypatch):
    async def _no_sleep(_s):
        return None
    monkeypatch.setattr(oe.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 3)  # retries ON: a quiet call must still make one attempt
    oe._clear_error()
    oe._clear_reconnecting()
    oe._client = None
    oe._client_factory = None
    yield lambda script: _install(monkeypatch, script)
    oe._clear_error()
    oe._clear_reconnecting()
    oe._client = None
    oe._client_factory = None


def _install(monkeypatch, script):
    client = _SeqClient(script)
    monkeypatch.setattr(oe.httpx, "AsyncClient", lambda *a, **k: client)
    return client


def test_explain_ledger_gap_end_to_end_with_the_http_client_stubbed(_led, _real_post_tool):
    """The real await call site: `_explain_ledger_gap` -> `beat_log` -> `_call` -> `_post_tool` (quiet) -> stubbed client."""
    client = _real_post_tool([_resp(200, {"result": _bumps("recordRoomCanon", "recordRoomCanon")})])
    ledger._LAST_BEAT_AFTER["player"] = 10
    ledger.note_engine_write("player", "recordRoomCanon", {})
    expl = asyncio.run(al._explain_ledger_gap("player", beat_seq_before=12, stale_before=0))
    assert expl["kind"] == "counting-miss" and client.calls == 1
    assert oe.last_engine_error() is None


@pytest.mark.parametrize("script", [
    [_resp(400, {"error": 'tool "beatLog" is not available on channel "player"'})] * 4,
    [httpx.ConnectError("refused")] * 4,
    [httpx.ReadTimeout("slow")] * 4,
    [_resp(503, {"error": "restarting"})] * 4,
], ids=["tool-error", "refused", "timeout", "restarting-503"])
def test_a_failing_quiet_gap_read_leaves_the_banner_alone_and_leaves_the_alarm_red(_led, _real_post_tool, script):
    client = _real_post_tool(script)
    _MARKED = oe.reconnecting()
    ledger._LAST_BEAT_AFTER["player"] = 10
    expl = asyncio.run(al._explain_ledger_gap("player", beat_seq_before=12, stale_before=0))
    assert expl is None
    assert client.calls == 1  # one attempt, no retry, no restart wait
    assert oe.last_engine_error() is None and oe.reconnecting() is _MARKED is False


def test_a_stale_allowance_cannot_launder_extra_bumps_of_a_counted_tool(_led):
    # allowance 2 = 1 stale rejection + 1 counted write; two counted-tool bumps are in the log: the ledger counted only one write
    out = _classify(["recordInteraction", "recordInteraction"], {"recordInteraction": 1}, counted=2, counted_writes=1)
    assert out["kind"] == "unexplained" and "counted tool(s) bumped 2" in out["note"]


def test_the_cause_text_adds_an_ellipsis_only_when_bumps_were_really_cut(_led):
    """review of #2757: an exactly-16-bump gap got "; ..." though nothing was truncated."""
    n = ledger._MAX_GAP_BUMPS
    exact = _classify(["recordRoomCanon"] * n, {"recordRoomCanon": n})
    assert "more" not in exact and not ledger._describe_causes(ledger._clean_gap_explanation(exact)).endswith("...")
    over = _classify(["recordRoomCanon"] * (n + 1), {"recordRoomCanon": n + 1})
    assert over["more"] is True and len(over["bumps"]) == n
    assert ledger._describe_causes(ledger._clean_gap_explanation(over)).endswith("; ...")


# ---- ORW-1009 / ORW-1017: a counted write that commits twice (its commit, then the in-game-clock society tick) is not a dropped fold ----

def test_prod_shape_note_message_then_one_fold_that_committed_twice_is_not_red(_led):
    # prod 11-26: seq noteMessage, recordInteraction, recordInteraction; the FE sent one of each and counted both
    out = _classify(["noteMessage", "recordInteraction", "recordInteraction"], {"noteMessage": 1, "recordInteraction": 1}, counted=2, counted_writes=2)
    assert out["kind"] == "same-call-tick"


def test_prod_shape_intent_first_move_that_committed_twice_is_not_red(_led):
    out = _classify(["noteMessage", "resolvePlayerMove", "resolvePlayerMove", "recordInteraction"],
                    {"noteMessage": 1, "resolvePlayerMove": 1, "recordInteraction": 1}, counted=3, counted_writes=3)
    assert out["kind"] == "same-call-tick"


def test_every_counted_writer_in_the_dev_counts_may_double_commit(_led):
    for tool in ("advanceGame", "hangOut", "submitDecision", "recordImageBeat"):
        out = _classify([tool, tool], {tool: 1}, counted=1, counted_writes=1)
        assert out["kind"] == "same-call-tick", tool


def test_a_third_commit_per_dispatch_or_a_foreign_writer_stays_red(_led):
    assert _classify(["recordInteraction"] * 3, {"recordInteraction": 1}, counted=1, counted_writes=1)["kind"] == "unexplained"
    assert _classify(["noteMessage", "resolvePlayerMove", "resolvePlayerMove"], {"noteMessage": 1}, counted=1, counted_writes=1)["kind"] == "unexplained"


def test_a_same_call_tick_is_recorded_on_the_entry_with_no_red_event(_led, monkeypatch):
    _engine(monkeypatch, _bumps("noteMessage", "recordInteraction", "recordInteraction", start=11))
    _dispatch("noteMessage"); _dispatch("recordInteraction")
    expl, entry = _finish_turn(before=13, last_after=10)
    assert expl["kind"] == "same-call-tick"
    assert _reds() == []
    assert entry["gapExplanation"]["kind"] == "same-call-tick"
