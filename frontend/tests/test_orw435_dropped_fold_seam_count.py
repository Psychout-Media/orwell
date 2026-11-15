"""ORW-435: `sync:dropped-fold` must fire only on a REAL dropped fold.

Live play fired it ~31 times in ~65 turns. 22 of those gaps were exactly: one accepted per-message noteMessage (already counted by
ORW-150) plus the deferred scene fold settled at the start of the next turn (a recordInteraction that nothing counted). The fix counts
every FE-owned engine write that bumps beatSeq at the single dispatch seam (`orwell_engine._call`), so a new writer is counted by
construction. Roles only; synthetic values."""
import asyncio
import importlib
import re
from pathlib import Path

import pytest

ledger = importlib.import_module("src.orwell_sync_ledger")
log_rings = importlib.import_module("src.log_rings")
oe = importlib.import_module("src.orwell_engine")
cache = importlib.import_module("src.engine_read_cache")

_MARK = 0


@pytest.fixture
def _led(tmp_path, monkeypatch):
    global _MARK
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "ledger.json")
    dicts = (ledger._PENDING_STALE, ledger._LAST_BEAT_AFTER, ledger._PENDING_FE_WRITES, ledger._PENDING_BELTS,
             ledger._PENDING_FORCED, ledger._PARKED_BELTS, ledger._PARKED_FORCED)
    for d in dicts:
        d.clear()
    ledger._IN_TURN.clear()
    _MARK = log_rings.OVERSEER.since(0, limit=1)[0]
    yield
    for d in dicts:
        d.clear()
    ledger._IN_TURN.clear()


def _fires():
    _, lines = log_rings.OVERSEER.since(_MARK, limit=100000)
    return [e for e in lines if e.get("kind") == "sync:dropped-fold" and e.get("ok") is False]


def _seam(monkeypatch, reply):
    """Drive the REAL dispatch seam with a stubbed transport that answers `reply` (dict, or a callable of the tool name)."""
    async def transport(name, args=None, user=None, timeout=None):
        return reply(name) if callable(reply) else reply
    monkeypatch.setattr(oe, "_call_inner", transport)


def _call(name):
    return asyncio.get_event_loop().run_until_complete(oe._call(name, {}, user="player"))


# one test per newly counted writer: each bumps beatSeq on the engine (EngineCommandsAdapter/GameSessionAdapter persist())
@pytest.mark.parametrize("tool", ["recordInteraction", "moveTo", "moveHouseguest", "markHouseguestMet", "recordImageBeat",
                                  "makeDeal", "diaryRoom", "confide", "exposeSecret", "tradeSecret", "surfaceInformationTo",
                                  "turnIn", "advanceGame", "updateCasting"])
def test_each_bumping_writer_is_counted_between_turns(_led, monkeypatch, tool):
    _seam(monkeypatch, {"ok": True, "beatSeq": 7})
    _call(tool)
    assert ledger._PENDING_FE_WRITES.get("player") == 1


@pytest.mark.parametrize("tool", sorted(ledger.NON_BUMPING_WRITES))
def test_backgroundpersist_writes_and_reads_are_not_counted(_led, monkeypatch, tool):
    _seam(monkeypatch, {"ok": True})
    _call(tool)
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0


def test_pure_reads_are_not_counted(_led, monkeypatch):
    _seam(monkeypatch, {"beatSeq": 7})
    for name in sorted(cache.PURE_READS):
        _call(name)
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0


@pytest.mark.parametrize("reply", [{"accepted": False, "beatSeq": 3}, {"status": "noop"}, {"status": "illegal"},
                                   {"playerMove": None}])
def test_a_refused_or_noop_answer_committed_nothing(_led, monkeypatch, reply):
    _seam(monkeypatch, reply)
    _call("moveHouseguest")
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0


@pytest.mark.parametrize("reply", [{"accepted": True, "duplicate": True}, {"beatSeq": 7, "replay": True},
                                   {"beatSeq": 7, "replayed": True}])
def test_a_duplicate_or_replayed_answer_of_an_idempotent_writer_is_not_counted_again(_led, monkeypatch, reply):
    _seam(monkeypatch, {"ok": True, "beatSeq": 7})
    _call("recordInteraction")
    assert ledger._PENDING_FE_WRITES.get("player") == 1
    _seam(monkeypatch, reply)
    _call("recordInteraction")
    assert ledger._PENDING_FE_WRITES.get("player") == 1  # unchanged by the repeat


def test_a_failed_write_is_not_counted(_led, monkeypatch):
    async def boom(name, args=None, user=None, timeout=None):
        raise oe.EngineToolError("refused", status=409)
    monkeypatch.setattr(oe, "_call_inner", boom)
    with pytest.raises(oe.EngineToolError):
        _call("recordInteraction")
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0


def test_a_write_inside_a_ledgered_turn_is_not_a_between_turn_allowance(_led, monkeypatch):
    _seam(monkeypatch, {"beatSeq": 9})
    ledger.begin_turn("player")
    _call("recordInteraction")
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0
    ledger.record_turn("player", session="s", turn_id="t", beat_seq_before=8, beat_seq_after=9)
    _call("recordInteraction")  # after the record (a background write): between-turn again
    assert ledger._PENDING_FE_WRITES.get("player") == 1


def test_a_failed_turn_closes_the_window_in_a_finally(_led, monkeypatch):
    """A turn that raises (or is cancelled) never reaches record_turn: the loop wrapper's `finally` must still close the window."""
    al = importlib.import_module("src.agent_loop")

    async def impl(*a, _ledger_turn_tokens=None, **kw):
        _ledger_turn_tokens.append(ledger.begin_turn("player"))
        yield "data: x\n\n"
        raise RuntimeError("boom")

    monkeypatch.setattr(al, "_stream_agent_loop_impl", impl)

    async def run():
        with pytest.raises(RuntimeError):
            async for _ in al.stream_agent_loop(owner="player"):
                pass
    asyncio.get_event_loop().run_until_complete(run())
    assert "player" not in ledger._IN_TURN
    _seam(monkeypatch, {"beatSeq": 9})
    _call("recordInteraction")  # the next between-turn write is counted again
    assert ledger._PENDING_FE_WRITES.get("player") == 1


def test_overlapping_turns_each_hold_their_own_window(_led, monkeypatch):
    _seam(monkeypatch, {"beatSeq": 9})
    a, b = ledger.begin_turn("player"), ledger.begin_turn("player")
    ledger.end_turn("player", a)
    ledger.end_turn("player", a)  # idempotent
    _call("recordInteraction")
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0  # b is still inside its turn
    ledger.end_turn("player", b)
    _call("recordInteraction")
    assert ledger._PENDING_FE_WRITES.get("player") == 1


def test_an_unknown_tool_is_not_counted_and_is_logged_once(_led, monkeypatch, caplog):
    import logging
    ledger._UNKNOWN_LOGGED.clear()
    _seam(monkeypatch, {"ok": True, "beatSeq": 7})
    with caplog.at_level(logging.INFO, logger=ledger.logger.name):
        _call("someBrandNewTool")
        _call("someBrandNewTool")
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0
    assert len([r for r in caplog.records if "someBrandNewTool" in r.getMessage()]) == 1


@pytest.mark.parametrize("tool", ["setBehavioralFlags", "endOfSessionSummary"])
def test_known_non_bumping_tools_are_not_counted(_led, monkeypatch, tool):
    _seam(monkeypatch, {"ok": True})
    _call(tool)
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0


def test_every_tool_the_frontend_can_call_is_classified():
    """Drift guard: a tool added to the FE's `_call("<name>")` sites must be classified bumping / non-bumping / pure read."""
    root = Path(__file__).resolve().parents[1]
    names = set()
    for sub in ("src", "routes"):
        for f in (root / sub).rglob("*.py"):
            names |= set(re.findall(r"\b_call(?:_inner)?\(\s*[\"']([A-Za-z]+)[\"']", f.read_text(errors="ignore")))
    known = ledger.BUMPING_WRITES | ledger.NON_BUMPING_WRITES | cache.PURE_READS
    unclassified = sorted(names - known)
    assert not unclassified, f"classify in orwell_sync_ledger BUMPING_WRITES / NON_BUMPING_WRITES (or PURE_READS): {unclassified}"
    assert not (ledger.BUMPING_WRITES & (ledger.NON_BUMPING_WRITES | cache.PURE_READS))


def test_bumping_names_exist_in_the_engine_source():
    ts = Path(__file__).resolve().parents[2] / "src" / "adapters" / "engine" / "GameSessionAdapter.ts"
    if not ts.exists():
        pytest.skip("engine source not present")
    text = ts.read_text()
    reg = Path(__file__).resolve().parents[2] / "src" / "surfaces" / "tools" / "registry.ts"
    blob = text + (reg.read_text() if reg.exists() else "")
    missing = [n for n in sorted(ledger.BUMPING_WRITES) if n not in blob]
    assert not missing, missing


def test_casting_turn_park_closes_the_window(_led):
    ledger.begin_turn("player")
    ledger.park_pending_unledgered_turn("player")
    assert "player" not in ledger._IN_TURN


# The live shape: noteMessage + the deferred fold settled at the start of the next turn.
def _live_turn(monkeypatch, before, after, writes_between):
    for w in writes_between:
        _seam(monkeypatch, {"accepted": True, "beatSeq": before})
        _call(w)
    ledger.begin_turn("player")
    ledger.record_turn("player", session="s", turn_id="t", beat_seq_before=before, beat_seq_after=after)


def test_replay_of_the_live_turn_sequence_has_zero_false_soft_fails(_led, monkeypatch):
    ledger.begin_turn("player")
    ledger.record_turn("player", session="s", turn_id="t0", beat_seq_before=41, beat_seq_after=43)
    beat = 43
    for _ in range(12):
        # between turns: the per-message noteMessage (+1) and the settled deferred scene fold (+1); the turn then moves 0..2 beats
        _live_turn(monkeypatch, beat + 2, beat + 4, ["noteMessage", "recordInteraction"])
        beat += 4
    assert _fires() == []


def test_replay_with_background_image_beat_and_move_writes_has_zero_false_soft_fails(_led, monkeypatch):
    ledger.begin_turn("player")
    ledger.record_turn("player", session="s", turn_id="t0", beat_seq_before=10, beat_seq_after=11)
    _live_turn(monkeypatch, 15, 16, ["recordImageBeat", "moveHouseguest", "noteMessage", "recordInteraction"])
    assert _fires() == []


def test_a_real_unexplained_drop_still_fires(_led, monkeypatch):
    ledger.begin_turn("player")
    ledger.record_turn("player", session="s", turn_id="t0", beat_seq_before=20, beat_seq_after=21)
    # one noteMessage + one settled fold explain two beats; the board moved THREE: one is unaccounted
    _live_turn(monkeypatch, 24, 24, ["noteMessage", "recordInteraction"])
    assert len(_fires()) == 1


def test_a_gap_with_no_fe_write_at_all_still_fires(_led):
    ledger.begin_turn("player")
    ledger.record_turn("player", session="s", turn_id="t0", beat_seq_before=5, beat_seq_after=5)
    ledger.begin_turn("player")
    ledger.record_turn("player", session="s", turn_id="t1", beat_seq_before=8, beat_seq_after=8)
    assert len(_fires()) == 1


# Methods that commit (this.persist) only in the pre-game prewarm lifecycle and backgroundPersist in a running season.
MIXED_BY_LIFECYCLE = frozenset({"recordCastIdentity"})


# Drift guard: every engine `record*` write that persists only via backgroundPersist (no beatSeq bump) must be listed.
def test_non_bumping_list_matches_the_engine_source():
    ts = Path(__file__).resolve().parents[2] / "src" / "adapters" / "engine" / "GameSessionAdapter.ts"
    if not ts.exists():
        pytest.skip("engine source not present")
    lines = ts.read_text().split("\n")
    found, texts = {}, {}
    for i, l in enumerate(lines):
        m = re.match(r"  (record[A-Za-z]+)\(", l)
        if not m:
            continue
        depth, body, started = 0, [], False
        for j in range(i, len(lines)):
            body.append(lines[j])
            depth += lines[j].count("{") - lines[j].count("}")
            started = started or "{" in lines[j]
            if started and depth <= 0:
                break
        text = "\n".join(body)
        texts[m[1]] = text
        found[m[1]] = ("backgroundPersist" in text, bool(re.search(r"this\.(persist|onPersist)", text)))
    for name, (bg, committing) in found.items():
        if bg and committing:
            # A method that commits on one path and background-persists on another is mixed. It may only stay in
            # NON_BUMPING_WRITES when its commit is the pre-game prewarm lifecycle (no turn-time beat to count) and the
            # running-season path is the background one; an unknown mixed method fails here (review of #2743).
            assert name in MIXED_BY_LIFECYCLE, f"{name} both commits and backgroundPersists: classify it by lifecycle in MIXED_BY_LIFECYCLE"
            assert re.search(r"if \(ctx\.prewarm\) this\.persist\(\);\s*else this\.backgroundPersist\(\);", texts[name]), \
                f"{name} is no longer 'prewarm commits, running season backgroundPersists'"
            assert name in ledger.NON_BUMPING_WRITES, f"{name}'s running-season path never bumps, so it belongs in NON_BUMPING_WRITES"
            continue
        if bg and not committing:
            assert name in ledger.NON_BUMPING_WRITES, f"{name} only backgroundPersists (no beatSeq bump) - add it to NON_BUMPING_WRITES"
        if committing and not bg:
            assert name not in ledger.NON_BUMPING_WRITES, f"{name} commits (bumps beatSeq) - it must not be in NON_BUMPING_WRITES"
