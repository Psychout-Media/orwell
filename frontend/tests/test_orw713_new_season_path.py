"""ORW-713 (+ the ORW-714 root cause): every new season starts a FRESH canonical chat, and the old chat stays readable.

* the ops game reset (deploy/orwell-game-reset.sh) keeps the chat sessions but must drop the canonical game-chat
  binding, so the next visit opens a new chat for the new season (the old season's rows no longer sit above it);
* the in-app doors (reset-progress, next-season, new-game) already unbind: pinned here beside the ops door;
* the sidebar 'New Chat' confirm ends the season through the ONE restart door instead of opening an empty chat
  still bound to the live game.
Roles only; no game state.
"""
import json
import os
import re
import shutil
import subprocess

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
_GAME = os.path.join(_REPO, "deploy", "orwell-game-reset.sh")
_HELPER = os.path.join(_REPO, "frontend", "scripts", "oobe_reset.py")


def _read(rel):
    with open(os.path.join(_REPO, rel), encoding="utf-8") as f:
        return f.read()


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_ops_game_reset_unbinds_the_canonical_chat_and_keeps_the_sessions(tmp_path):
    app = tmp_path / "app"
    fe_data = app / "frontend" / "data"
    fe_scripts = app / "frontend" / "scripts"
    config = app / "data"
    saves = app / ".orwell-data"
    for d in (fe_data, fe_scripts, config, saves):
        d.mkdir(parents=True, exist_ok=True)
    shutil.copy(_HELPER, fe_scripts / "oobe_reset.py")
    (config / ".env").write_text(f"ORWELL_DATA_DIR={saves}\n")
    (saves / "player-1").mkdir()
    (saves / "player-1" / "save.json").write_text("{}")
    (fe_data / "orwell_game_session.json").write_text(json.dumps({"player-1": "old-season-chat"}))
    (fe_data / "app.db").write_text("chat sessions live here")  # stands for the preserved session store
    env = dict(os.environ)
    env.update({"APP_DIR": str(app), "ORWELL_CONFIG_DIR": str(config), "ORWELL_DATA_DIR": str(saves),
                "ORWELL_FE_DIR": str(app / "frontend"), "ORWELL_FE_DATA_DIR": str(fe_data), "ORWELL_PYTHON": "python3"})
    proc = subprocess.run(["bash", _GAME, "--yes", "--no-restart"], env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not (saves / "player-1").exists(), "the season is scrubbed"
    assert not (fe_data / "orwell_game_session.json").exists(), "the canonical chat is unbound: the new season gets a fresh chat"
    assert (fe_data / "app.db").exists(), "the chat sessions themselves are kept, so the old chat stays readable"


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_ops_game_reset_dry_run_leaves_the_binding(tmp_path):
    app = tmp_path / "app"
    fe_data = app / "frontend" / "data"
    config = app / "data"
    saves = app / ".orwell-data"
    for d in (fe_data, app / "frontend" / "scripts", config, saves):
        d.mkdir(parents=True, exist_ok=True)
    (config / ".env").write_text(f"ORWELL_DATA_DIR={saves}\n")
    (fe_data / "orwell_game_session.json").write_text("{}")
    env = dict(os.environ)
    env.update({"APP_DIR": str(app), "ORWELL_CONFIG_DIR": str(config), "ORWELL_DATA_DIR": str(saves),
                "ORWELL_FE_DIR": str(app / "frontend"), "ORWELL_FE_DATA_DIR": str(fe_data), "ORWELL_PYTHON": "python3"})
    proc = subprocess.run(["bash", _GAME, "--yes", "--no-restart", "--dry-run"], env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (fe_data / "orwell_game_session.json").exists()


def test_every_in_app_new_season_door_unbinds_the_canonical_chat():
    src = _read("frontend/routes/orwell_routes.py")
    for route in ("orwell_new_game", "orwell_next_season", "orwell_reset_progress"):
        body = src[src.index(f"async def {route}("):]
        body = body[: body.index("@router.", 10)] if "@router." in body[10:] else body
        assert "clear_game_session(user)" in body, f"{route} must unbind the canonical game chat"


def test_new_chat_confirm_ends_the_season_through_the_one_restart_door():
    js = _read("frontend/static/js/orwellSessionGuard.js")
    assert "Leave my season" not in js, "the dialog must not promise a leave it does not do"
    assert "/api/orwell/reset-progress" in js and "confirm: true" in js
    assert "_orwellMarkRestart" in js and "_orwellFreshSession" in js
    # the reset is only reachable after the player's own confirm
    assert js.index("styledConfirm(") < js.index("return endSeasonAndRestart()")
    assert re.search(r"if \(!ok\) return false;", js)
