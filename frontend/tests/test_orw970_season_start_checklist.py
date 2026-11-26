"""ORW-970 - the durable season-start checklist: owed start-up steps survive a restart.

Prod, 2026-11-26: a restart cleared the in-memory house-entry hold and lost the three owed post-start steps (world snapshot,
producer persona, habits + house culture); they were run by hand. Pinned here: the record's shape and tolerance, the hold
mirror, bounded retries ending in `failed` plus an alert, a simulated restart (fresh process state, same file) while the hold
is active and after it, a double run of each step, a new season replacing the record, and the read-only admin view.

Roles only: every name is an invented probe, never cast material.
"""
import asyncio
import importlib
import json

import pytest
from conftest import _run
from fastapi import FastAPI
from fastapi.testclient import TestClient

sc = importlib.import_module("src.orwell_season_checklist")
ca = importlib.import_module("src.orwell_cast_authoring")
oe = importlib.import_module("src.orwell_engine")
zg = importlib.import_module("src.orwell_zeitgeist")
pa = importlib.import_module("src.orwell_producer_authoring")
w = importlib.import_module("src.orwell_npc_minds_words")
ahr = importlib.import_module("routes.admin_health_routes")
log_rings = importlib.import_module("src.log_rings")

OWNER = "probe-owner"


@pytest.fixture(autouse=True)
def _fast_and_clean(monkeypatch):
    monkeypatch.setenv("ORWELL_SEASON_START_RETRY_BASE_S", "0.01")
    monkeypatch.setenv("ORWELL_SEASON_START_MAX_ATTEMPTS", "3")
    monkeypatch.setenv("ORWELL_SEASON_RESUME_ENGINE_WAIT_S", "0.01")
    for s in (zg._IN_FLIGHT, pa._IN_FLIGHT, w._IN_FLIGHT):
        s.clear()
    ca._HOUSE_ENTRY_GATE_BLOCKS.clear()
    ca._HOUSE_READY_WATCHES.clear()
    yield
    for t in list(ca._HOUSE_READY_WATCHES.values()) + list(sc._RETRY_TASKS.values()):
        try:
            t.cancel()
        except RuntimeError:  # its loop is already closed
            pass


def _status(owner=OWNER):
    return {n: s["status"] for n, s in sc.get_record(owner)["steps"].items()}


def _restart():
    """A process restart: every in-process store is gone, only the persisted file remains."""
    ca._HOUSE_ENTRY_GATE_BLOCKS.clear()
    for t in list(ca._HOUSE_READY_WATCHES.values()) + list(sc._RETRY_TASKS.values()):
        t.cancel()
    ca._HOUSE_READY_WATCHES.clear()
    sc._RETRY_TASKS.clear()
    sc._ACTIVE.clear()
    for s in (zg._IN_FLIGHT, pa._IN_FLIGHT, w._IN_FLIGHT):
        s.clear()


async def _until(pred, tries=400):
    for _ in range(tries):
        if pred():
            return True
        await asyncio.sleep(0.01)
    return False


def _stub_steps(monkeypatch, calls, *, results=None):
    results = results or {}

    async def cap(owner):
        calls["world_snapshot"] += 1
        return results.get("world_snapshot", {"accepted": True})

    async def prod(owner):
        calls["producer_persona"] += 1
        return results.get("producer_persona", {"accepted": True})

    async def words(owner):
        calls["habits_culture"] += 1
        return results.get("habits_culture", {"traits": {"accepted": 3, "rejected": 0, "skipped": []}, "culture": {"accepted": True}})
    monkeypatch.setattr(zg, "run_capture", cap)
    monkeypatch.setattr(pa, "run_authoring", prod)
    monkeypatch.setattr(w, "run_words", words)

    async def no_view(user=None):
        return {}
    monkeypatch.setattr(oe, "world_snapshot_view", no_view)


def _calls():
    return {"world_snapshot": 0, "producer_persona": 0, "habits_culture": 0}


def _live_engine(monkeypatch, state=None):
    async def gs(*a, **k):
        return state if state is not None else {"started": True}
    monkeypatch.setattr(oe, "get_game_state", gs)


# -- the record -----------------------------------------------------------------------------------------------------

def test_begin_season_writes_a_record_with_every_step_owed():
    sid = sc.begin_season(OWNER, hold=True)
    rec = sc.get_record(OWNER)
    assert rec["sid"] == sid and set(rec["steps"]) == set(sc.STEPS)
    assert _status() == {"house_hold": "owed", "world_snapshot": "owed", "producer_persona": "owed", "habits_culture": "owed"}
    assert rec["steps"]["house_hold"]["detail"] == "held"
    sc.begin_season("no-gate", hold=False)
    assert _status("no-gate")["house_hold"] == "done"


def test_missing_and_corrupt_files_read_as_empty_and_never_raise():
    assert sc.get_record(OWNER) is None and sc.admin_view(OWNER) == {"present": False}
    sc.CHECKLIST_PATH.write_text("{not json", encoding="utf-8")
    assert sc.get_record(OWNER) is None
    sc.CHECKLIST_PATH.write_text(json.dumps({"v": 1, "owners": {OWNER: "junk", "b": {"sid": "x", "steps": {"world_snapshot": {"status": "weird", "attempts": -4}}}}}))
    assert sc.get_record(OWNER) is None
    assert _status("b")["world_snapshot"] == "owed" and sc.get_record("b")["steps"]["world_snapshot"]["attempts"] == 0
    assert sc.begin_season(OWNER, hold=False)  # a corrupt neighbour does not block a new record


def test_hold_marker_mirrors_into_the_record_and_no_record_is_a_noop():
    ca.begin_house_entry_hold("bare-owner")  # no record: nothing written, nothing raised
    assert not sc.CHECKLIST_PATH.exists()
    sc.begin_season(OWNER, hold=True)
    ca.begin_house_entry_hold(OWNER)
    assert sc.get_record(OWNER)["steps"]["house_hold"]["detail"] == "held" and _status()["house_hold"] == "owed"
    ca.clear_house_entry_gate_block(OWNER)
    assert _status()["house_hold"] == "done" and sc.get_record(OWNER)["steps"]["house_hold"]["detail"] == "released"
    ca.record_house_entry_gate_block(OWNER, {"authored": 1})  # a stray re-mark never reopens a released hold
    assert _status()["house_hold"] == "done"


# -- tracked runs: outcome, retries, bound ---------------------------------------------------------------------------

def test_tracked_marks_done_and_does_not_run_a_done_step_twice():
    sc.begin_season(OWNER, hold=False)
    n = {"n": 0}

    async def fn(owner):
        n["n"] += 1
        return {"accepted": True}

    async def _go():
        await sc.tracked(OWNER, sc.WORLD_SNAPSHOT, fn, OWNER)
        again = await sc.tracked(OWNER, sc.WORLD_SNAPSHOT, fn, OWNER)
        assert again == {"skipped": "done"}
    _run(_go())
    assert n["n"] == 1 and _status()["world_snapshot"] == "done"
    assert sc.get_record(OWNER)["steps"]["world_snapshot"]["attempts"] == 1


def test_no_record_runs_the_function_plain():
    async def fn(owner):
        return {"accepted": True}
    assert _run(sc.tracked(OWNER, sc.WORLD_SNAPSHOT, fn, OWNER)) == {"accepted": True}
    assert not sc.CHECKLIST_PATH.exists()


def test_failures_retry_with_growing_delay_then_end_failed_with_an_alert(monkeypatch):
    alerts = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **k: alerts.append((cls, k.get("user"))))
    monkeypatch.setattr(sc, "retry_delay", lambda a: 0.01 * (4 ** (a - 1)))
    delays = []
    real = sc._schedule_retry
    monkeypatch.setattr(sc, "_schedule_retry", lambda o, s, sid, d: (delays.append(d), real(o, s, sid, d)))
    sc.begin_season(OWNER, hold=False)
    calls = _calls()
    _stub_steps(monkeypatch, calls, results={"world_snapshot": {"accepted": False, "reason": "llm-failed"}})

    async def _go():
        zg.kickoff_capture(OWNER)
        assert await _until(lambda: _status()["world_snapshot"] == "failed")
    _run(_go())
    st = sc.get_record(OWNER)["steps"]["world_snapshot"]
    assert calls["world_snapshot"] == 3 and st["attempts"] == 3 and st["reason"] == "llm-failed"
    assert delays == [0.01, 0.04]  # growing, and no third retry
    assert alerts == [("season-start:world-snapshot-failed", OWNER)]


def test_a_raised_step_is_recorded_and_the_error_still_reaches_the_runner(monkeypatch):
    sc.begin_season(OWNER, hold=False)
    monkeypatch.setattr(sc, "retry_delay", lambda a: 999.0)

    async def boom(owner):
        raise RuntimeError("probe")

    async def _go():
        with pytest.raises(RuntimeError):
            await sc.tracked(OWNER, sc.PRODUCER_PERSONA, boom, OWNER)
    _run(_go())
    st = sc.get_record(OWNER)["steps"]["producer_persona"]
    assert st["status"] == "owed" and st["reason"] == "raised:runtimeerror" and st["next_at"]


def test_no_model_is_done_not_owed_and_attempts_survive_a_restart(monkeypatch):
    alerts = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **k: alerts.append(cls))
    sc.begin_season(OWNER, hold=False)
    calls = _calls()
    _stub_steps(monkeypatch, calls, results={"producer_persona": {"accepted": False, "reason": "no-model"}})
    _run(sc.tracked(OWNER, sc.PRODUCER_PERSONA, pa.run_authoring, OWNER))
    assert _status()["producer_persona"] == "done"
    # a step left `running` with its attempts spent: a restart loop cannot buy another run
    def _spend(owners):
        owners["owners"][OWNER]["steps"]["habits_culture"].update(status="running", attempts=3)
    data = json.loads(sc.CHECKLIST_PATH.read_text())
    _spend(data)
    sc.CHECKLIST_PATH.write_text(json.dumps(data))
    _restart()
    assert _run(sc.tracked(OWNER, sc.HABITS_CULTURE, w.run_words, OWNER)) == {"skipped": "failed"}
    assert calls["habits_culture"] == 0 and _status()["habits_culture"] == "failed"
    assert alerts == ["season-start:habits-culture-failed"]


# -- idempotency: a double run of each step ---------------------------------------------------------------------------

def test_double_run_of_each_step_runs_the_work_once(monkeypatch):
    sc.begin_season(OWNER, hold=False)
    calls = _calls()
    _stub_steps(monkeypatch, calls)

    async def _go():
        for _ in range(2):  # the kickoff guards and the record both hold the second call back
            zg.kickoff_capture(OWNER)
            pa.kickoff_producer_authoring(OWNER)
            w.kickoff_npc_minds_words(OWNER)
            await _until(lambda: not (zg._IN_FLIGHT or pa._IN_FLIGHT or w._IN_FLIGHT))
        assert await _until(lambda: all(v == "done" for k, v in _status().items() if k != "house_hold"))
    _run(_go())
    assert calls == {"world_snapshot": 1, "producer_persona": 1, "habits_culture": 1}


def test_world_snapshot_already_captured_is_skipped_not_overwritten(monkeypatch):
    sc.begin_season(OWNER, hold=False)
    calls = _calls()
    _stub_steps(monkeypatch, calls)

    async def captured(user=None):
        return {"source": "web_search", "slices": {}}
    monkeypatch.setattr(oe, "world_snapshot_view", captured)
    out = _run(sc.tracked(OWNER, sc.WORLD_SNAPSHOT, zg.run_capture, OWNER))
    assert out == {"skipped": "already-captured"} and calls["world_snapshot"] == 0
    assert _status()["world_snapshot"] == "done"


def test_habits_second_run_on_frozen_culture_counts_as_done(monkeypatch):
    sc.begin_season(OWNER, hold=False)
    calls = _calls()
    _stub_steps(monkeypatch, calls, results={"habits_culture": {"traits": {"accepted": 0, "rejected": 4, "skipped": []},
                                                                 "culture": {"accepted": False, "reason": "frozen"}}})
    _run(sc.tracked(OWNER, sc.HABITS_CULTURE, w.run_words, OWNER))
    assert _status()["habits_culture"] == "done"


def test_habits_with_skipped_houseguests_stays_owed(monkeypatch):
    monkeypatch.setattr(sc, "retry_delay", lambda a: 999.0)
    sc.begin_season(OWNER, hold=False)
    _stub_steps(monkeypatch, _calls(), results={"habits_culture": {"traits": {"accepted": 2, "skipped": ["npc:1"]}, "culture": {"accepted": True}}})
    _run(sc.tracked(OWNER, sc.HABITS_CULTURE, w.run_words, OWNER))
    st = sc.get_record(OWNER)["steps"]["habits_culture"]
    assert st["status"] == "owed" and st["reason"] == "traits-skipped"


# -- restart recovery --------------------------------------------------------------------------------------------------

def test_restart_while_the_hold_is_active_reevaluates_the_cast_then_runs_the_owed_steps(monkeypatch):
    calls = _calls()
    _stub_steps(monkeypatch, calls)
    _live_engine(monkeypatch)

    async def gate_on(owner):
        return True
    monkeypatch.setattr(ca, "house_entry_gate_active", gate_on)
    state = {"ready": False, "polls": 0}

    async def ready(owner, **k):
        state["polls"] += 1
        return {"ready": state["ready"], "authored": 15 if state["ready"] else 6, "total": 15, "missing": 0}
    monkeypatch.setattr(ca, "await_house_ready", ready)
    monkeypatch.setattr(ca, "_HOUSE_READY_RECHECK_S", 0.01)
    monkeypatch.setattr(ca, "_HOUSE_READY_WATCH_TIMEOUT_S", 0.0)
    pushed = []
    gs = importlib.import_module("src.orwell_game_session")
    monkeypatch.setattr(gs, "publish_game_updated", lambda user=None: pushed.append(user))

    async def _go():
        sc.begin_season(OWNER, hold=True)
        ca.begin_house_entry_hold(OWNER)  # the season is held, then the process dies
        _restart()
        assert ca.house_entry_gate_status(OWNER) is None  # the in-memory marker is gone
        assert await sc.resume_owner(OWNER) == "holding"
        assert ca.house_entry_gate_status(OWNER) is not None, "re-evaluated, found not ready: the hold is back at once"
        assert calls == _calls() and _status()["house_hold"] == "owed"
        state["ready"] = True
        assert await _until(lambda: ca.house_entry_gate_status(OWNER) is None)
        assert await _until(lambda: all(v == "done" for v in _status().values()))
    _run(_go())
    assert calls == {"world_snapshot": 1, "producer_persona": 1, "habits_culture": 1} and pushed


def test_restart_when_the_cast_is_already_ready_releases_at_once_and_runs_the_steps(monkeypatch):
    calls = _calls()
    _stub_steps(monkeypatch, calls)
    _live_engine(monkeypatch)

    async def gate_on(owner):
        return True

    async def ready(owner, **k):
        return {"ready": True, "authored": 15, "total": 15, "missing": 0}
    monkeypatch.setattr(ca, "house_entry_gate_active", gate_on)
    monkeypatch.setattr(ca, "await_house_ready", ready)

    async def _go():
        sc.begin_season(OWNER, hold=True)
        ca.begin_house_entry_hold(OWNER)
        _restart()
        out = await sc.resume_owner(OWNER)
        assert out.startswith("resumed:") and ca.house_entry_gate_status(OWNER) is None
        assert await _until(lambda: all(v == "done" for v in _status().values()))
    _run(_go())
    assert calls == {"world_snapshot": 1, "producer_persona": 1, "habits_culture": 1}


def test_restart_after_release_reruns_only_what_is_owed_or_left_running(monkeypatch):
    calls = _calls()
    _stub_steps(monkeypatch, calls)
    _live_engine(monkeypatch)
    sc.begin_season(OWNER, hold=False)
    _run(sc.tracked(OWNER, sc.WORLD_SNAPSHOT, zg.run_capture, OWNER))  # done before the restart
    data = json.loads(sc.CHECKLIST_PATH.read_text())
    data["owners"][OWNER]["steps"]["habits_culture"].update(status="running", attempts=1)  # the process died mid-run
    sc.CHECKLIST_PATH.write_text(json.dumps(data))
    calls.update(_calls())
    _restart()

    async def _go():
        assert (await sc.resume_all()) == {OWNER: "resumed:producer_persona,habits_culture"}
        assert await _until(lambda: all(v == "done" for v in _status().values()))
    _run(_go())
    assert calls == {"world_snapshot": 0, "producer_persona": 1, "habits_culture": 1}
    assert sc.get_record(OWNER)["steps"]["habits_culture"]["attempts"] == 2


def test_a_season_that_is_over_or_replaced_triggers_no_work(monkeypatch):
    calls = _calls()
    _stub_steps(monkeypatch, calls)
    sc.begin_season(OWNER, hold=False)
    _live_engine(monkeypatch, {"started": True, "finished": True})
    assert _run(sc.resume_owner(OWNER)) == "closed"
    assert sc.get_record(OWNER)["closed"] == "no-live-season"
    # a record from season 1 while the account is already on season 2: closed, never run
    sc.begin_season("replaced", hold=False)
    _live_engine(monkeypatch)
    seasons = importlib.import_module("src.orwell_seasons")
    monkeypatch.setattr(seasons, "get_season", lambda user: 2)
    assert _run(sc.resume_owner("replaced")) == "superseded"
    assert calls == _calls()


def test_a_new_season_for_the_same_owner_starts_a_fresh_record():
    first = sc.begin_season(OWNER, hold=False)
    _run(sc.tracked(OWNER, sc.PRODUCER_PERSONA, _ok_fn, OWNER))
    assert _status()["producer_persona"] == "done"
    second = sc.begin_season(OWNER, hold=True)
    assert second != first and _status() == {"house_hold": "owed", "world_snapshot": "owed", "producer_persona": "owed", "habits_culture": "owed"}
    # a run that started under the old season cannot write into the new record
    assert sc._update(OWNER, lambda r: sc._set(r, sc.WORLD_SNAPSHOT, "done"), first) is False
    assert _status()["world_snapshot"] == "owed"


async def _ok_fn(owner):
    return {"accepted": True}


def test_engine_down_at_startup_leaves_the_record_owed_and_does_not_raise(monkeypatch):
    sc.begin_season(OWNER, hold=False)
    monkeypatch.setenv("ORWELL_SEASON_RESUME_ENGINE_TRIES", "2")

    async def down(*a, **k):
        raise RuntimeError("engine down")
    monkeypatch.setattr(oe, "get_game_state", down)
    assert _run(sc.resume_all()) == {OWNER: "engine-unreachable"}
    assert _status()["world_snapshot"] == "owed" and sc.get_record(OWNER)["closed"] is None


def test_a_season_in_progress_with_no_record_is_left_alone(monkeypatch):
    calls = _calls()
    _stub_steps(monkeypatch, calls)
    _live_engine(monkeypatch)
    assert _run(sc.resume_all()) == {} and _run(sc.resume_owner(OWNER)) == "none"
    assert sc.kick_owed_steps(OWNER) == [] and calls == _calls()
    assert not sc.CHECKLIST_PATH.exists()


# -- do_create_character writes the record ------------------------------------------------------------------------------

def test_a_genuine_start_through_do_create_character_begins_a_record(monkeypatch):
    ti = importlib.import_module("src.tool_implementations")
    cid = importlib.import_module("src.orwell_cast_identity")

    async def fake_create(*a, **k):
        return {"started": True, "house": [{"id": "player", "name": "The Player"}], "portraitPrompts": []}
    monkeypatch.setattr(oe, "create_character", fake_create)
    monkeypatch.setattr(oe, "get_game_state", lambda *a, **k: _val({"started": False}))
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)
    for mod, fn in ((zg, "kickoff_capture"), (pa, "kickoff_producer_authoring"), (w, "kickoff_npc_minds_words")):
        monkeypatch.setattr(mod, fn, lambda owner: None)
    monkeypatch.setenv("ORWELL_ALLOW_FLOOR_START", "1")  # gate off: no hold owed
    _run(ti.do_create_character('{"playerName":"P"}', owner="creator-probe"))
    assert _status("creator-probe") == {"house_hold": "done", "world_snapshot": "owed", "producer_persona": "owed", "habits_culture": "owed"}


async def _val(v):
    return v


# -- admin ------------------------------------------------------------------------------------------------------------------

def test_admin_endpoint_and_health_payload_show_statuses_only(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(ahr, "effective_user", lambda request: OWNER)
    sc.begin_season(OWNER, hold=True)
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    body = TestClient(app, raise_server_exceptions=False).get("/api/admin/season-checklist").json()
    assert body["present"] and [s["step"] for s in body["steps"]] == list(sc.STEPS)
    assert {s["status"] for s in body["steps"]} == {"owed"}
    assert set(body["steps"][0]) == {"step", "status", "at", "attempts", "reason", "detail", "nextAt"}
    page = FastAPI()
    page.include_router(ahr.setup_admin_status_page())
    html = TestClient(page, raise_server_exceptions=False).get("/admin/status").text
    assert 'id="seasonwrap"' in html and "d.seasonChecklist" in html
    monkeypatch.setattr(ahr, "effective_user", lambda request: "nobody")
    assert TestClient(app).get("/api/admin/season-checklist").json() == {"present": False}


def test_admin_endpoint_requires_admin(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    assert TestClient(app, raise_server_exceptions=False).get("/api/admin/season-checklist").status_code in (401, 403)
