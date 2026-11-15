"""ORW-399 - the staged scene folds and the production / premiere / competition pacing state survive a
front-end restart (persisted through belt_state_persist, reloaded at boot). No model; roles only."""
import asyncio
import importlib

import pytest

bsp = importlib.import_module("src.belt_state_persist")
fl = importlib.import_module("src.fold_ledger")
chat_helpers = importlib.import_module("routes.chat_helpers")
agent_loop = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

_P = "u-orw399-player"
_SID = "sess-orw399"


def _pacing():
    names = ("_PRODUCTION_HOLD", "_PREMIERE_MSGS", "_PREMIERE_CLOCK_HOLD", "_PREMIERE_TOAST_SPEAKERS",
             "_PREMIERE_ENTRANCE_STAGE", "_COMP_PAUSED")
    return {n: getattr(chat_helpers, n) for n in names}, chat_helpers._PREMIERE_CLOCK_STARTED


def _wipe():
    fl.clear_all()
    dicts, started = _pacing()
    for s in dicts.values():
        s.clear()
    started.clear()


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(bsp, "BELT_STATE_PATH", tmp_path / "belt.json")
    _wipe()
    yield
    _wipe()


def _stage(key="idem-1", anchor="row-1"):
    fl.stage_pending_fold(_P, _SID, content="a talk", with_ids=["npc-a"], kind="talk", consequence=None,
                          felt_minutes=5, idempotency_key=key)
    fl.attach_row_anchor(_P, _SID, anchor)


def _restart():
    """Save, drop every in-memory store (a process restart), then restore from disk."""
    bsp.save_now()
    _wipe()
    return bsp.restore()


def test_a_staged_fold_survives_a_restart_and_settles_exactly_once(monkeypatch):
    _stage()
    assert _restart() >= 1
    assert fl.pending_fold_count(_P, _SID) == 1

    calls = []

    async def _fake_backfill(owner, fn, content, **kw):
        calls.append(kw["idempotency_key"])
        return {"ok": True}

    monkeypatch.setattr(agent_loop, "_backfill_with_cas", _fake_backfill)
    monkeypatch.setattr(fl, "entry_exists_at_settle", lambda sid, anchor: True)
    assert asyncio.run(agent_loop._settle_pending_fold(_P, _SID)) is True
    assert calls == ["idem-1"], "the preserved idempotency key rides to the engine"
    assert asyncio.run(agent_loop._settle_pending_fold(_P, _SID)) is False
    assert calls == ["idem-1"], "settled once; the next turn does not apply it again"
    assert fl.pending_fold_count(_P, _SID) == 0
    # the settled state is what gets saved at turn end: a second restart brings nothing back
    assert _restart() == 0
    assert fl.pending_fold_count(_P, _SID) == 0


def test_the_anchor_and_fifo_order_survive(monkeypatch):
    _stage("idem-1", "row-1")
    _stage("idem-2", "row-2")
    _restart()
    first = fl.pop_oldest_pending_fold(_P, _SID)
    second = fl.pop_oldest_pending_fold(_P, _SID)
    assert (first["idempotency_key"], first["row_anchor"]) == ("idem-1", "row-1")
    assert (second["idempotency_key"], second["row_anchor"]) == ("idem-2", "row-2")


def test_an_anonymous_owner_key_round_trips():
    fl.stage_pending_fold(None, _SID, content="c", with_ids=[], kind="talk", consequence=None,
                          felt_minutes=None, idempotency_key="idem-anon")
    _restart()
    assert fl.pending_fold_count(None, _SID) == 1


def test_truncate_discard_then_restart_does_not_resurrect_the_fold(monkeypatch):
    """Driven through the REAL truncate route (review of #2671): the route's own save after the discard is what keeps the fold from coming back, so the restart
    below restores from the disk WITHOUT an implicit save first. Remove the route's `save_now` and this fails."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import history_routes

    class _Mgr:
        def truncate_messages(self, sid, keep):
            return True

    monkeypatch.setattr(history_routes, "_verify_session_owner", lambda *a, **k: None)
    monkeypatch.setattr("src.auth_helpers.effective_user", lambda request: _P)
    monkeypatch.setattr(fl, "_resolve_positions_for_ids", lambda sid, ids: {i: 5 for i in ids})
    _stage()
    bsp.save_now()  # the staged fold is on disk, as it is at the end of the turn that staged it
    assert bsp.BELT_STATE_PATH.exists()
    app = FastAPI()
    app.include_router(history_routes.setup_history_routes(_Mgr()))
    r = TestClient(app).post(f"/api/session/{_SID}/truncate", json={"keep_count": 2})
    assert r.status_code == 200 and fl.pending_fold_count(_P, _SID) == 0
    _wipe()  # a process restart: memory gone ...
    assert bsp.restore() == 0  # ... and the disk copy the route saved holds no fold
    assert fl.pending_fold_count(_P, _SID) == 0


def test_truncate_snapshots_the_ledger_on_the_event_loop_not_in_the_write_thread(monkeypatch):
    """Review of #2751 (P1): the fold ledger has no lock and its mutators run on the event loop, so the route
    must copy the ledger THERE and hand only the fsync'd write to the worker thread."""
    import threading
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import history_routes

    class _Mgr:
        def truncate_messages(self, sid, keep):
            return True

    monkeypatch.setattr(history_routes, "_verify_session_owner", lambda *a, **k: None)
    monkeypatch.setattr("src.auth_helpers.effective_user", lambda request: _P)
    monkeypatch.setattr(fl, "_resolve_positions_for_ids", lambda sid, ids: {i: 5 for i in ids})
    _stage()
    seen = {}
    real_snapshot, real_write = bsp.snapshot, bsp.atomic_write_json
    monkeypatch.setattr(bsp, "snapshot", lambda: seen.setdefault("snap", threading.get_ident()) and real_snapshot())
    monkeypatch.setattr(bsp, "atomic_write_json", lambda *a, **k: (seen.setdefault("write", threading.get_ident()), real_write(*a, **k))[1])
    app = FastAPI()
    app.include_router(history_routes.setup_history_routes(_Mgr()))
    r = TestClient(app).post(f"/api/session/{_SID}/truncate", json={"keep_count": 2})
    assert r.status_code == 200
    assert seen["snap"] != seen["write"], "the snapshot ran in the write thread, racing the ledger's mutators"


def test_an_older_prepared_snapshot_never_overwrites_a_newer_write():
    _stage()
    older = bsp.prepare_save()
    fl.clear_all()
    bsp.save_now()  # a newer save (the timer's) lands first: no folds on disk
    bsp.save_now(older)  # the offloaded write of the older snapshot arrives late and is dropped
    _wipe()
    assert bsp.restore() == 0 and fl.pending_fold_count(_P, _SID) == 0


def test_the_pacing_stores_survive_a_restart():
    dicts, started = _pacing()
    dicts["_PRODUCTION_HOLD"][_P] = ("3:hoh", 17)
    dicts["_PREMIERE_MSGS"][_P] = 12
    dicts["_PREMIERE_CLOCK_HOLD"][_P] = True
    dicts["_PREMIERE_TOAST_SPEAKERS"][_P] = ["host", "guest"]
    dicts["_PREMIERE_ENTRANCE_STAGE"][_P] = "toast"
    dicts["_COMP_PAUSED"][_P] = "1:hoh"
    started.add(_P)
    _restart()
    dicts, started = _pacing()
    assert dicts["_PRODUCTION_HOLD"] == {_P: ("3:hoh", 17)}
    assert dicts["_PREMIERE_MSGS"] == {_P: 12}
    assert dicts["_PREMIERE_CLOCK_HOLD"] == {_P: True}
    assert dicts["_PREMIERE_TOAST_SPEAKERS"] == {_P: ["host", "guest"]}
    assert dicts["_PREMIERE_ENTRANCE_STAGE"] == {_P: "toast"}
    assert dicts["_COMP_PAUSED"] == {_P: "1:hoh"}
    assert started == {_P}


def test_the_hold_counter_keeps_counting_after_a_restart():
    chat_helpers._PRODUCTION_HOLD[_P] = ("3:hoh", 40)
    _restart()
    sig, n = chat_helpers._PRODUCTION_HOLD[_P]
    assert (sig, n) == ("3:hoh", 40), "resumes at 40, not zero"


def test_a_season_reset_clears_the_persisted_pacing_for_that_user_only():
    dicts, _ = _pacing()
    dicts["_PRODUCTION_HOLD"][_P] = ("s", 3)
    dicts["_PRODUCTION_HOLD"]["u-other"] = ("s", 4)
    bsp.save_now()
    oe._notify_season_reset(_P)
    _wipe()
    bsp.restore()
    dicts, _ = _pacing()
    assert _P not in dicts["_PRODUCTION_HOLD"]
    assert dicts["_PRODUCTION_HOLD"].get("u-other") == ("s", 4)


def test_restore_never_overwrites_live_state():
    _stage()
    dicts, _ = _pacing()
    dicts["_PREMIERE_MSGS"][_P] = 5
    bsp.save_now()
    dicts["_PREMIERE_MSGS"][_P] = 99
    fl.clear_all()
    fl.stage_pending_fold(_P, _SID, content="live", with_ids=[], kind="talk", consequence=None,
                          felt_minutes=None, idempotency_key="idem-live")
    bsp.restore()
    assert dicts["_PREMIERE_MSGS"] == {_P: 99}
    assert [e["idempotency_key"] for e in fl._PENDING[(_P, _SID)]] == ["idem-live"]


@pytest.mark.parametrize("pacing,folds", [
    ({"_PRODUCTION_HOLD": {"u": "bad"}, "_PREMIERE_MSGS": {"u": True}, "_PREMIERE_CLOCK_STARTED": "x"}, "nope"),
    ("x", [{"owner": 5, "session_id": "s", "entries": []}, {"entries": "x"}, {"owner": "u", "session_id": "s", "entries": [{"content": "c"}]}]),
])
def test_malformed_saved_state_is_ignored(pacing, folds):
    import json
    bsp.BELT_STATE_PATH.write_text(json.dumps({"v": 1, "pacing": pacing, "folds": folds}), encoding="utf-8")
    assert bsp.restore() == 0
    assert not fl._PENDING
    assert not any(_pacing()[0].values())


def test_orw437_a_saved_fold_missing_a_key_settle_reads_is_skipped():
    """review of #2671: an entry without consequence / felt_minutes / row_anchor would KeyError at settle or truncate, so restore must drop it."""
    base = {"content": "c", "with_ids": [], "kind": "k", "idempotency_key": "i"}
    assert bsp._valid_fold_entry({**base, "consequence": None, "felt_minutes": None, "row_anchor": None})
    for missing in ("consequence", "felt_minutes", "row_anchor"):
        e = {**base, "consequence": None, "felt_minutes": None, "row_anchor": None}
        del e[missing]
        assert not bsp._valid_fold_entry(e), missing


@pytest.mark.parametrize("field,bad", [("row_anchor", {"id": 1}), ("row_anchor", 7), ("consequence", "text"), ("felt_minutes", "5"), ("felt_minutes", True), ("assurance", [1]), ("heard_about_me", "x")])
def test_a_restored_fold_with_a_wrong_shaped_nullable_field_is_skipped(field, bad):
    """review of #2751: presence of the keys was checked, not their values; a JSON object for `row_anchor` reached a DB equality at settle."""
    _stage()
    snap = bsp.snapshot()
    snap["folds"][0]["entries"][0][field] = bad
    fl.clear_all()
    assert bsp._restore_folds(snap["folds"]) == 0 and fl.pending_fold_count(_P, _SID) == 0
    fl.stage_pending_fold(_P, _SID, content="c", with_ids=[], kind="talk", consequence=None, felt_minutes=None, idempotency_key="idem-null")
    saved = bsp.snapshot()["folds"]
    fl.clear_all()
    assert bsp._restore_folds(saved) == 1, "an entry whose nullable fields are all null still restores"
