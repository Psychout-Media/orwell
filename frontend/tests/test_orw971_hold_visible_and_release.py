"""ORW-971 (2) and (3) - a held season is visible to the doctor and the health snapshot, and an admin can release it.

Prod, 2026-11-26: a season sat held at house entry for hours; `deploy/orwell-doctor.sh --status` printed "VERDICT: healthy" and the
hold was a WARNING line nobody was paged for. Pinned here:
  - the hold's age is counted from its first stamp (a re-stamp never resets it) and a hold past the watch window is `overdue`;
  - the health snapshot carries every hold and every owed or failed start step, and a stuck hold is a RED `season-hold-stuck` alarm;
  - an expired watch raises a soft failure (the OVERSEER ring) once;
  - `GET /api/admin/season-holds` answers a direct loopback connection with no login, and anyone else only as an admin;
  - the doctor's `season_hold_check` (run for real, with a stubbed `curl`): an overdue hold is a FAIL (non-healthy verdict, counted apart so --fix
    does not bounce for it), a young hold is info, a failed step is a warn, an owed step is info;
  - `POST /api/admin/ops/release-season-hold` refuses (409) with no hold, and with one clears the marker, records `admin-release`, stops the
    watch and starts the owed post-start steps; the status page has the button with a confirm prompt.

Roles only - every owner and name is an invented probe.
"""
import asyncio
import importlib
import json
import shutil
import subprocess
import time
from pathlib import Path

import httpx
import pytest
from conftest import _run
from fastapi import FastAPI

ca = importlib.import_module("src.orwell_cast_authoring")
sc = importlib.import_module("src.orwell_season_checklist")
zg = importlib.import_module("src.orwell_zeitgeist")
pa = importlib.import_module("src.orwell_producer_authoring")
words = importlib.import_module("src.orwell_npc_minds_words")
ahr = importlib.import_module("routes.admin_health_routes")
log_rings = importlib.import_module("src.log_rings")

OWNER = "held-owner"
ROOT = Path(__file__).resolve().parents[2]
DOCTOR = (ROOT / "deploy" / "orwell-doctor.sh").read_text()


@pytest.fixture(autouse=True)
def _clean():
    ca._HOUSE_ENTRY_GATE_BLOCKS.clear()
    ca._HOUSE_READY_WATCHES.clear()
    yield
    for t in list(ca._HOUSE_READY_WATCHES.values()):
        try:
            t.cancel()
        except RuntimeError:  # its loop is already closed
            pass
    ca._HOUSE_ENTRY_GATE_BLOCKS.clear()
    ca._HOUSE_READY_WATCHES.clear()


def _age(owner, seconds):
    """Make the marker look `seconds` old."""
    ca._HOUSE_ENTRY_GATE_BLOCKS[ca._safe_user(owner)]["since"] = time.time() - seconds


# -- the hold's age -----------------------------------------------------------------------------------------------------

def test_a_restamp_keeps_the_age_and_the_window_decides_overdue():
    ca.begin_house_entry_hold(OWNER, {"authored": 3, "total": 15, "missing": 12})
    _age(OWNER, 120)
    ca.record_house_entry_gate_block(OWNER, {"authored": 7, "total": 15, "missing": 8})  # the readiness result lands: same hold
    (row,) = ca.house_entry_holds()
    assert row["owner"] == OWNER and 119 <= row["ageS"] <= 125 and (row["authored"], row["total"]) == (7, 15)
    assert row["windowS"] == int(ca._HOUSE_READY_WATCH_TIMEOUT_S) == 1800 and row["overdue"] is False
    _age(OWNER, 1900)
    assert ca.house_entry_holds()[0]["overdue"] is True
    ca.clear_house_entry_gate_block(OWNER)
    assert ca.house_entry_holds() == []
    ca.begin_house_entry_hold(OWNER)  # a new hold starts a new clock
    assert ca.house_entry_holds()[0]["ageS"] < 5


# -- the health snapshot and the RED alarm --------------------------------------------------------------------------------

def test_snapshot_carries_holds_and_open_steps_and_a_stuck_hold_is_red(monkeypatch):
    monkeypatch.setattr(ahr.orwell_engine, "engine_health_detail", lambda: _val({"ok": False}))
    monkeypatch.setattr(ahr, "_engine_raw_health", lambda: _val((None, None)))
    sc.begin_season(OWNER, hold=True)
    ca.begin_house_entry_hold(OWNER, {"authored": 7, "total": 15, "missing": 8})
    sc._update(OWNER, lambda r: sc._set(r, sc.PRODUCER_PERSONA, "failed", reason="gave-up", attempts=3))
    snap = _run(ahr._health_snapshot(OWNER))
    holds = snap["seasonHolds"]["holds"]
    assert [(h["owner"], h["authored"], h["total"], h["overdue"]) for h in holds] == [(OWNER, 7, 15, False)]
    steps = {(s["step"], s["status"]) for s in snap["seasonHolds"]["steps"]}
    assert ("producer_persona", "failed") in steps and ("world_snapshot", "owed") in steps
    assert not [a for a in snap["alarms"] if a["code"] == "season-hold-stuck"]
    _age(OWNER, 2400)
    snap = _run(ahr._health_snapshot(OWNER))
    (alarm,) = [a for a in snap["alarms"] if a["code"] == "season-hold-stuck"]
    assert alarm["severity"] == "red" and alarm["count"] == 1 and "7/15" in alarm["detail"]


async def _val(v):
    return v


def test_an_expired_watch_raises_a_soft_failure(monkeypatch):
    async def never_ready(owner, **k):
        return {"ready": False, "authored": 7, "total": 15, "missing": 8}
    monkeypatch.setattr(ca, "await_house_ready", never_ready)
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **k: seen.append((cls, k.get("user"))))
    ca.begin_house_entry_hold(OWNER)

    async def go():
        assert ca.kickoff_house_ready_watch(OWNER, timeout=0.01, poll_interval=0.01, recheck_interval=0.01) is True
        await asyncio.sleep(0.15)
        ca.clear_house_entry_gate_block(OWNER)  # ends the slow re-check loop
        await asyncio.sleep(0.05)
    _run(go())
    assert seen == [("season-start:hold-expired", OWNER)]


# -- the doctor's endpoint ---------------------------------------------------------------------------------------------------

def _client(app, host):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(host, 5000)), base_url="http://probe")


def test_season_holds_endpoint_loopback_only_then_admin(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")  # a real login is required for anyone who is not direct loopback
    ca.begin_house_entry_hold(OWNER, {"authored": 7, "total": 15})
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())

    async def go():
        async with _client(app, "127.0.0.1") as c:
            ok = await c.get("/api/admin/season-holds")
        async with _client(app, "127.0.0.1") as c:
            proxied = await c.get("/api/admin/season-holds", headers={"X-Forwarded-For": "203.0.113.9"})
        async with _client(app, "203.0.113.9") as c:
            remote = await c.get("/api/admin/season-holds")
        return ok, proxied, remote
    ok, proxied, remote = _run(go())
    assert ok.status_code == 200 and ok.json()["holds"][0]["owner"] == OWNER
    assert proxied.status_code in (401, 403) and remote.status_code in (401, 403)


def test_the_route_is_exempt_from_login_in_app():
    assert '"/api/admin/season-holds"' in (ROOT / "frontend" / "app.py").read_text()


# -- the doctor ------------------------------------------------------------------------------------------------------------

needs_bash = pytest.mark.skipif(shutil.which("bash") is None or shutil.which("python3") is None, reason="bash and python3 are needed")


def _doctor(payload, mode="check"):
    src = DOCTOR[DOCTOR.index("SEASON_HOLD_FAILS=0"):DOCTOR.index("diagnose() {")]
    script = ("FE_BASE=http://127.0.0.1:1\n"
              "pass() { echo \"ok $*\"; }; warn() { echo \"warn $*\"; }; fail() { echo \"FAIL $*\"; fails=$((fails + 1)); }; info() { echo \"info $*\"; }\n"
              "fails=0\n"
              + ("curl() { return 22; }\n" if payload is None else "curl() { cat <<'JSON'\n" + json.dumps(payload) + "\nJSON\n}\n")
              + src + "\nseason_hold_check\necho \"fails=$fails hold_fails=$SEASON_HOLD_FAILS\"\n")
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30).stdout


def _hold(age, overdue, authored=7):
    return {"owner": "probe-a", "ageS": age, "authored": authored, "total": 15, "missing": 15 - authored, "windowS": 1800, "overdue": overdue}


@needs_bash
def test_doctor_fails_on_a_hold_past_its_window():
    out = _doctor({"holds": [_hold(2400, True)], "steps": []})
    assert "FAIL season HELD at house entry past its window: owner=probe-a held 2400s (window 1800s), cast 7/15 authored" in out
    assert "release-season-hold" in out and "fails=1 hold_fails=1" in out


@needs_bash
def test_doctor_reports_a_young_hold_as_info_not_a_failure():
    out = _doctor({"holds": [_hold(60, False)], "steps": []})
    assert "info season held at house entry: owner=probe-a held 60s" in out and "FAIL" not in out and "fails=0 hold_fails=0" in out


@needs_bash
def test_doctor_warns_on_a_failed_step_and_notes_an_owed_one():
    steps = [{"owner": "probe-a", "step": "producer_persona", "status": "failed", "attempts": 3},
             {"owner": "probe-a", "step": "world_snapshot", "status": "owed", "attempts": 1}]
    out = _doctor({"holds": [], "steps": steps})
    assert "warn season-start step FAILED: owner=probe-a step=producer_persona attempts=3" in out
    assert "info season-start step owed: owner=probe-a step=world_snapshot (owed)" in out and "fails=0" in out


@needs_bash
def test_doctor_is_quiet_when_nothing_is_held_and_skips_an_older_build():
    assert "ok season holds: none held" in _doctor({"holds": [], "steps": []})
    out = _doctor(None)
    assert "skipping" in out and "FAIL" not in out


def test_doctor_wiring_the_verdict_counts_it_and_fix_does_not_bounce_for_it():
    assert "  season_hold_check\n  systemd_security_floor" in DOCTOR
    assert "$((fails - SEASON_HOLD_FAILS))" in DOCTOR and "fails=$SEASON_HOLD_FAILS" in DOCTOR


# -- the release action ----------------------------------------------------------------------------------------------------

def _admin_app(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(ahr, "effective_user", lambda request: OWNER)
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    return app


def _post(app, body=None):
    async def go():
        async with _client(app, "203.0.113.9") as c:
            return await c.post("/api/admin/ops/release-season-hold", json=body if body is not None else {})
    return _run(go())


def test_release_refuses_when_no_hold_is_active(monkeypatch):
    sc.begin_season(OWNER, hold=False)
    r = _post(_admin_app(monkeypatch))
    assert r.status_code == 409 and r.json()["released"] is False and r.json()["reason"] == "no-hold-active"


def test_release_clears_the_hold_records_the_reason_and_kicks_the_owed_steps(monkeypatch):
    kicks = []
    monkeypatch.setattr(zg, "kickoff_capture", lambda owner: kicks.append("world_snapshot"))
    monkeypatch.setattr(pa, "kickoff_producer_authoring", lambda owner: kicks.append("producer_persona"))
    monkeypatch.setattr(words, "kickoff_npc_minds_words", lambda owner: kicks.append("habits_culture"))
    sc.begin_season(OWNER, hold=True)
    sc._update(OWNER, lambda r: sc._set(r, sc.WORLD_SNAPSHOT, "done"))  # already done: must not run again
    ca.begin_house_entry_hold(OWNER, {"authored": 7, "total": 15})

    async def forever():
        await asyncio.sleep(30)
    app = _admin_app(monkeypatch)

    async def go():
        ca._HOUSE_READY_WATCHES[ca._safe_user(OWNER)] = asyncio.get_running_loop().create_task(forever())
        async with _client(app, "203.0.113.9") as c:
            r = await c.post("/api/admin/ops/release-season-hold", json={})
        await asyncio.sleep(0.05)
        return r, ca._HOUSE_READY_WATCHES.get(ca._safe_user(OWNER))
    r, watch = _run(go())
    assert r.status_code == 200 and r.json() == {"released": True, "owner": OWNER, "kicked": ["producer_persona", "habits_culture"]}
    assert ca.house_entry_gate_status(OWNER) is None and watch is None, "the marker is gone and the watch is stopped"
    hold = sc.get_record(OWNER)["steps"]["house_hold"]
    assert hold["status"] == "done" and hold["detail"] == "released" and hold["reason"] == "admin-release"
    assert sorted(kicks) == ["habits_culture", "producer_persona"]
    assert _post(app).status_code == 409, "a second release finds no hold"


def test_release_can_name_another_owner(monkeypatch):
    monkeypatch.setattr(zg, "kickoff_capture", lambda owner: None)
    monkeypatch.setattr(pa, "kickoff_producer_authoring", lambda owner: None)
    monkeypatch.setattr(words, "kickoff_npc_minds_words", lambda owner: None)
    ca.begin_house_entry_hold("other-owner")
    r = _post(_admin_app(monkeypatch), {"owner": "other-owner"})
    assert r.status_code == 200 and r.json()["owner"] == "other-owner" and ca.house_entry_gate_status("other-owner") is None


def test_release_requires_admin(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    ca.begin_house_entry_hold(OWNER)
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    assert _post(app).status_code in (401, 403) and ca.house_entry_gate_status(OWNER) is not None


def test_status_page_has_the_release_button_with_a_confirm():
    page = FastAPI()
    page.include_router(ahr.setup_admin_status_page())
    from fastapi.testclient import TestClient
    import os
    os.environ["AUTH_ENABLED"] = "false"
    try:
        html = TestClient(page, raise_server_exceptions=False).get("/admin/status").text
    finally:
        os.environ.pop("AUTH_ENABLED", None)
    assert "release-hold" in html and "d.seasonHolds" in html and "/api/admin/ops/release-season-hold" in html
    seg = html[html.index('addEventListener("click", async function (ev)'):]
    assert seg.index("confirm(") < seg.index("/api/admin/ops/release-season-hold")
