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
    _stage()
    monkeypatch.setattr(fl, "_resolve_positions_for_ids", lambda sid, ids: {i: 5 for i in ids})
    assert fl.discard_pending_fold(_P, _SID, 2) == 1  # anchored past keep_count: discarded
    assert _restart() == 0
    assert fl.pending_fold_count(_P, _SID) == 0


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
