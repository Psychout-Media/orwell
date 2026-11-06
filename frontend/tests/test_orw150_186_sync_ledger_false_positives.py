"""ORW-150 / ORW-186: the sync ledger's `sync:dropped-fold` soft-fail must fire only on a REAL dropped fold.
 - ORW-150: the FE's own writes between turns (a per-message noteMessage, the E22 fallback fold) move beatSeq outside a ledgered window and used to read as a dropped fold.
 - ORW-186: belt / forced-choice counts from never-ledgered casting turns used to land on the first GAME turn's row.
Roles only (a player, an FE-owned write)."""
import asyncio
import importlib

import pytest

ledger = importlib.import_module("src.orwell_sync_ledger")
log_rings = importlib.import_module("src.log_rings")
ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _clear_rings():
    try:
        log_rings.OVERSEER.clear()
    except Exception:
        pass


@pytest.fixture
def _tmp_ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "orwell_sync_ledger.json")
    for d in (ledger._PENDING_STALE, ledger._LAST_BEAT_AFTER, ledger._PENDING_FE_WRITES,
              ledger._PENDING_BELTS, ledger._PENDING_FORCED, ledger._PARKED_BELTS, ledger._PARKED_FORCED):
        d.clear()
    _clear_rings()
    yield
    for d in (ledger._PENDING_STALE, ledger._LAST_BEAT_AFTER, ledger._PENDING_FE_WRITES,
              ledger._PENDING_BELTS, ledger._PENDING_FORCED, ledger._PARKED_BELTS, ledger._PARKED_FORCED):
        d.clear()


def _dropped_fold_events():
    _, lines = log_rings.OVERSEER.since(0, limit=100000)
    return [e for e in lines if e.get("kind") == "sync:dropped-fold" and e.get("ok") is False]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── ORW-150 ──────────────────────────────────────────────────────────────────────────────────
def test_fe_owned_writes_explain_the_between_turn_gap(_tmp_ledger):
    """Live shape: gap 2 = one E22 fallback fold + one noteMessage, both FE-owned, both between turns."""
    ledger.record_turn("player", session="s", turn_id="t1", beat_seq_before=33, beat_seq_after=35)
    ledger.note_fe_write("player")  # the E22 fallback fold
    ledger.note_fe_write("player")  # the next message's noteMessage
    ledger.record_turn("player", session="s", turn_id="t2", beat_seq_before=37, beat_seq_after=38)
    assert _dropped_fold_events() == []


def test_a_gap_beyond_the_fe_owned_writes_still_fires(_tmp_ledger):
    """One FE-owned write explains one beat; a second unexplained beat is a real unaccounted move."""
    ledger.record_turn("player", session="s", turn_id="t1", beat_seq_before=10, beat_seq_after=10)
    ledger.note_fe_write("player")
    ledger.record_turn("player", session="s", turn_id="t2", beat_seq_before=12, beat_seq_after=13)
    events = _dropped_fold_events()
    assert events, "a beat the FE neither recorded nor reconciled must still be a dropped-fold alarm"


def test_fe_writes_are_per_user(_tmp_ledger):
    ledger.record_turn("player", session="s", turn_id="t1", beat_seq_before=10, beat_seq_after=10)
    ledger.note_fe_write("other-player")
    ledger.record_turn("player", session="s", turn_id="t2", beat_seq_before=11, beat_seq_after=11)
    assert _dropped_fold_events(), "another user's FE write must not excuse this user's gap"


def test_a_failed_durable_write_restores_the_fe_writes(_tmp_ledger, monkeypatch):
    ledger.note_fe_write("player", 2)
    monkeypatch.setattr(ledger, "atomic_write_json", lambda *a, **k: (_ for _ in ()).throw(OSError("disk")))
    ledger.record_turn("player", session="s", turn_id="t1", beat_seq_before=1, beat_seq_after=1)
    assert ledger._PENDING_FE_WRITES.get("player") == 2


def test_note_message_reports_an_fe_write_only_when_accepted(_tmp_ledger, monkeypatch):
    async def accepted(mid, user=None):
        return {"accepted": True, "beatSeq": 5}

    async def duplicate(mid, user=None):
        return {"accepted": False, "beatSeq": 5}

    monkeypatch.setattr(orwell_engine, "note_message", duplicate)
    _run(ch.note_player_message("m1", "player"))
    assert ledger._PENDING_FE_WRITES.get("player", 0) == 0
    monkeypatch.setattr(orwell_engine, "note_message", accepted)
    _run(ch.note_player_message("m2", "player"))
    assert ledger._PENDING_FE_WRITES.get("player") == 1


# ── ORW-186 ──────────────────────────────────────────────────────────────────────────────────
def test_casting_belts_do_not_land_on_the_first_game_turn_row(_tmp_ledger):
    ledger.note_belt_fire("player", "casting-record-belt")
    ledger.note_belt_fire("player", "desync-reground-voiced")
    ledger.note_forced_choice("player", "createCharacter", honored=True)
    ledger.note_stale_rejection("player")
    ledger.park_pending_unledgered_turn("player")  # the casting turn ended
    ledger.record_turn("player", session="s", turn_id="g1", beat_seq_before=1, beat_seq_after=2)
    row = ledger.get_recent("player")[-1]
    assert row["beltsFired"] == {}, "casting-phase belts must not be blamed on the first game turn"
    assert not row.get("forcedChoice")
    assert row["staleRejections"] == 0


def test_a_game_turn_belt_still_lands_on_its_own_row(_tmp_ledger):
    ledger.note_belt_fire("player", "casting-record-belt")
    ledger.park_pending_unledgered_turn("player")
    ledger.note_belt_fire("player", "auto-record-scene")  # a real game-turn belt
    ledger.record_turn("player", session="s", turn_id="g1", beat_seq_before=1, beat_seq_after=2)
    assert ledger.get_recent("player")[-1]["beltsFired"] == {"auto-record-scene": 1}


def test_parked_casting_belts_stay_in_the_playtest_totals(_tmp_ledger):
    ledger.note_belt_fire("player", "casting-record-belt")
    ledger.note_forced_choice("player", "createCharacter", honored=False)
    ledger.park_pending_unledgered_turn("player")
    assert ledger.get_belt_totals("player") == {"casting-record-belt": 1}
    assert ledger.get_forced_choice_totals("player")["createCharacter"]["ignored"] == 1


def test_the_casting_turn_end_hook_parks_in_the_agent_loop():
    import inspect
    src = inspect.getsource(importlib.import_module("src.agent_loop"))
    assert "park_pending_unledgered_turn(owner)" in src
