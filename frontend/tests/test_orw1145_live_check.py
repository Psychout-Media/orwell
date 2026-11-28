"""ORW-1145: a dev live check can stand still and start at once.

  - the deploy hold: deploy/orwell-deploy-hold.sh's update_deploy_hold_active (real bash; orwell-update.sh calls it from one line that lands after the open ORW-1074 PR merges), and the admin route that writes it (refused on prod);
  - the pre-cast test account: the route makes the account, turns its images off, starts the season with the fixed seed and authors the whole cast inside the call;
  - the script: scripts/live-run/live_check.py's offline self-test, and a failure mid-run still clears the hold.

Roles only: every account and name is an invented probe."""
import importlib
import os
import re
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import httpx
import pytest
from conftest import _run
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "deploy" / "orwell-deploy-hold.sh"
sys.path.insert(0, str(ROOT / "scripts" / "live-run"))
sys.path.insert(0, str(ROOT / "scripts" / "rehearsal-kit"))
lcheck = importlib.import_module("live_check")
routes = importlib.import_module("routes.admin_live_check_routes")
middleware = importlib.import_module("core.middleware")
from core.auth import AuthManager

HDR = {middleware.INTERNAL_TOOL_HEADER: middleware.INTERNAL_TOOL_TOKEN}


# -- (1) the hold, in real bash ---------------------------------------------------------------------------------------

def _hold(path, env=None):
    script = f'source "{LIB}"; update_deploy_hold_active "{path}"; echo "rc=$?"'
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30, env=dict(os.environ, **(env or {})))
    return r.stdout.strip().splitlines()


def _write(path, until, age_s=0):
    Path(path).write_text(f"until={int(until)}\nreason=probe\n")
    t = time.time() - age_s
    os.utime(path, (t, t))


def test_a_future_hold_is_active_and_names_when_it_ends(tmp_path):
    f = tmp_path / ".deploy-hold"
    _write(f, time.time() + 600)
    out = _hold(f)
    assert out[-1] == "rc=0" and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", out[0])


def test_no_file_an_expired_hold_and_junk_are_not_holds(tmp_path):
    f = tmp_path / ".deploy-hold"
    assert _hold(f) == ["rc=1"]
    _write(f, time.time() - 5)
    assert _hold(f) == ["rc=1"]
    f.write_text("until=soon\n")
    assert _hold(f) == ["rc=1"]


def test_a_hold_never_outlives_the_cap_counted_from_the_files_own_mtime(tmp_path):
    f = tmp_path / ".deploy-hold"
    _write(f, time.time() + 36000, age_s=5 * 3600)   # asks for ten more hours, written five hours ago: the 4 h cap has passed
    assert _hold(f) == ["rc=1"]
    _write(f, time.time() + 36000, age_s=60)         # still inside the cap: held
    assert _hold(f)[-1] == "rc=0"
    assert _hold(f, {"ORWELL_DEPLOY_HOLD_MAX_MINUTES": "1"}) == ["rc=1"]


def test_a_symlinked_hold_is_ignored(tmp_path):
    real = tmp_path / "real"
    _write(real, time.time() + 600)
    link = tmp_path / ".deploy-hold"
    link.symlink_to(real)
    assert _hold(link) == ["rc=1"]


# -- (2) the routes --------------------------------------------------------------------------------------------------

@pytest.fixture
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ORWELL_DEPLOYMENT", "dev")
    monkeypatch.setenv("ORWELL_IMAGE_SPEND_FILE", str(tmp_path / "image-spend.json"))
    prefs = importlib.import_module("routes.prefs_routes")
    monkeypatch.setattr(prefs, "PREFS_FILE", str(tmp_path / "user_prefs.json"))
    a = FastAPI()
    a.state.auth_manager = AuthManager(auth_path=str(tmp_path / "auth.json"))
    a.state.auth_manager.create_user("opsadmin", "a-long-enough-admin-password", is_admin=True)
    a.include_router(routes.setup_admin_live_check_routes())
    return a


def _post(app, path, body, headers=HDR):
    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://probe") as c:
            return await c.post(path, json=body, headers=headers)
    return _run(go())


def test_the_hold_route_writes_and_clears_the_file(app, tmp_path):
    r = _post(app, "/api/admin/ops/deploy-hold", {"minutes": 30, "reason": "live check"})
    assert r.status_code == 200 and r.json()["held"] is True
    text = (tmp_path / ".deploy-hold").read_text()
    until = int(re.search(r"until=(\d+)", text).group(1))
    assert 29 * 60 < until - time.time() <= 30 * 60 + 2
    assert _hold(tmp_path / ".deploy-hold")[-1] == "rc=0"   # the bash side reads what the route wrote
    assert _post(app, "/api/admin/ops/deploy-hold", {"clear": True}).json()["held"] is False
    assert not (tmp_path / ".deploy-hold").exists()


def test_the_hold_route_bounds_the_minutes(app):
    for bad in (0, 241, -5, "9", True):
        assert _post(app, "/api/admin/ops/deploy-hold", {"minutes": bad}).status_code == 400


def test_the_routes_refuse_production_and_non_admins(app, monkeypatch, tmp_path):
    assert _post(app, "/api/admin/ops/deploy-hold", {"minutes": 5}, headers={}).status_code == 403
    monkeypatch.delenv("ORWELL_DEPLOYMENT")
    for path, body in (("deploy-hold", {"minutes": 5}), ("prepare-test-account", {"username": "livecheck-a", "password": "x" * 20}), ("delete-test-account", {"username": "livecheck-a"})):
        r = _post(app, "/api/admin/ops/" + path, body)
        assert r.status_code == 403 and "production" in r.json()["reason"]
    assert not (tmp_path / ".deploy-hold").exists()


@pytest.fixture
def engine(monkeypatch):
    eng = importlib.import_module("src.orwell_engine")
    ca = importlib.import_module("src.orwell_cast_authoring")
    orwell_routes = importlib.import_module("routes.orwell_routes")
    pre = importlib.import_module("src.orwell_prewarm")
    seen = {"create": [], "authored": []}
    left = {"ids": [f"npc:{i}" for i in range(15)]}

    async def create(player, seed=None, user=None, **kw):
        seen["create"].append((player, seed, user))
        return {"started": True}

    async def state(user=None, timeout=None):
        return {"started": True}

    async def backfill(missing, user):
        seen["authored"].append(list(missing))
        left["ids"] = []
        return len(missing)

    monkeypatch.setattr(eng, "create_character", create)
    monkeypatch.setattr(eng, "get_game_state", state)
    monkeypatch.setattr(orwell_routes, "_roster_cards", lambda st, u: [{"id": "player", "isPlayer": True}] + [{"id": i, "status": "active"} for i in range(15)])
    monkeypatch.setattr(ca, "unauthored_ids", lambda u, cards: list(left["ids"]))
    monkeypatch.setattr(ca, "backfill_unauthored", backfill)
    monkeypatch.setattr(pre, "reset_user_season", lambda u: None)
    return seen


def test_prepare_makes_the_account_images_off_fixed_seed_and_cast_authored(app, engine):
    prefs = importlib.import_module("routes.prefs_routes")
    r = _post(app, "/api/admin/ops/prepare-test-account", {"username": "livecheck-probe", "password": "a-long-enough-probe-password", "seed": 4242})
    j = r.json()
    assert r.status_code == 200 and j["ok"] and j["ready"] is True and j["imagesOff"] is True and (j["authored"], j["total"]) == (15, 15)
    assert engine["create"] == [("Livecheck Player", 4242, "livecheck-probe")]
    assert len(engine["authored"]) == 1 and len(engine["authored"][0]) == 15   # the whole cast, authored inside the call
    assert prefs._load_for_user("livecheck-probe")["image_gen_enabled"] is False
    assert "a-long-enough-probe-password" not in r.text
    assert app.state.auth_manager.is_admin("livecheck-probe")


def test_prepare_refuses_a_bad_name_a_short_password_and_an_existing_account(app, engine):
    ok_pw = "a-long-enough-probe-password"
    assert _post(app, "/api/admin/ops/prepare-test-account", {"username": "opsadmin", "password": ok_pw}).status_code == 400   # not a livecheck- name
    assert _post(app, "/api/admin/ops/prepare-test-account", {"username": "livecheck-b", "password": "short"}).status_code == 400
    assert _post(app, "/api/admin/ops/prepare-test-account", {"username": "livecheck-b", "password": ok_pw}).status_code == 200
    assert _post(app, "/api/admin/ops/prepare-test-account", {"username": "livecheck-b", "password": ok_pw}).status_code == 409
    assert engine["create"].__len__() == 1


def test_delete_only_touches_livecheck_accounts(app, engine):
    ok_pw = "a-long-enough-probe-password"
    _post(app, "/api/admin/ops/prepare-test-account", {"username": "livecheck-c", "password": ok_pw})
    assert _post(app, "/api/admin/ops/delete-test-account", {"username": "opsadmin"}).status_code == 400
    assert _post(app, "/api/admin/ops/delete-test-account", {"username": "livecheck-c"}).json()["deleted"] is True
    assert "livecheck-c" not in app.state.auth_manager.users


def test_the_routes_are_wired_into_the_app():
    src = (ROOT / "frontend" / "app.py").read_text()
    assert "app.include_router(setup_admin_live_check_routes())" in src


# -- (3) the script ---------------------------------------------------------------------------------------------------

def test_the_script_self_test_passes_and_writes_numbers_only(tmp_path):
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "live-run" / "live_check.py"), "--dry-run", "--turns", "3", "--out", str(tmp_path)],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0 and "DRY-RUN PASS" in r.stdout, r.stdout + r.stderr
    md = (tmp_path / "report.md").read_text()
    assert "| ON |" in md and "| OFF |" in md and "Numbers only" in md


def test_a_failure_mid_run_still_clears_the_hold_and_deletes_the_account(tmp_path):
    import argparse
    args = argparse.Namespace(flag="act_first_enabled", turns=2, seed=1, hold_minutes=30, author_timeout=5.0, max_spend=1.0, keep_account=False)
    steps, first = lcheck.lf.stub_week(None)

    class Boom(lcheck.StubWorld):
        def login_only(self):
            raise RuntimeError("login refused")

    ops = lcheck.StubOps()
    code, rep = lcheck.run_check(ops, lambda u, p: Boom(steps, first), args, None)
    assert code == 2 and "login refused" in rep["meta"]["error"]
    assert [c[0].rsplit("/", 1)[-1] for c in ops.calls] == ["deploy-hold", "prepare-test-account", "delete-test-account", "deploy-hold"]
    assert ops.calls[-1][1] == {"clear": True}
    assert all("password" not in c[1] for c in ops.calls)


def test_an_unauthored_cast_is_not_played_on():
    import argparse
    args = argparse.Namespace(flag="act_first_enabled", turns=2, seed=1, hold_minutes=30, author_timeout=5.0, max_spend=1.0, keep_account=False)
    steps, first = lcheck.lf.stub_week(None)
    ops = lcheck.StubOps(authored=9, total=15)
    code, rep = lcheck.run_check(ops, lambda u, p: lcheck.StubWorld(steps, first), args, None)
    assert code == 2 and "not fully authored" in rep["meta"]["error"] and rep["arms"] == []
    assert ops.calls[-1][1] == {"clear": True}
