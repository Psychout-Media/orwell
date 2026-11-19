"""ORW-698: the per-player archives (season archive, hall of fame, notoriety) survive a new-season
GAME reset and are cleared by the OOBE / factory reset (back to a fresh install).

Runs the real deploy scripts over a sandboxed tmp layout, like test_public_deployment_survives_reset.
Pure deploy plumbing: no houseguests, no game state.
"""
import json
import os
import shutil
import subprocess

import pytest

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_OOBE = os.path.join(_REPO, "deploy", "orwell-oobe-reset.sh")
_GAME = os.path.join(_REPO, "deploy", "orwell-game-reset.sh")
_FACTORY = os.path.join(_REPO, "deploy", "orwell-factory-reset.sh")
_HELPER = os.path.join(_REPO, "frontend", "scripts", "oobe_reset.py")
_ARCHIVES = ("season-archive", "hall-of-fame", "notoriety")


def _layout(tmp_path, same_dir):
    app = tmp_path / "app"
    fe_data = app / "frontend" / "data"
    fe_scripts = app / "frontend" / "scripts"
    config = app / "data"
    saves = config if same_dir else (app / ".orwell-data")
    for d in (fe_data, fe_scripts, config, saves):
        d.mkdir(parents=True, exist_ok=True)
    shutil.copy(_HELPER, fe_scripts / "oobe_reset.py")
    (fe_data / "auth.json").write_text(json.dumps({"users": {"admin": {"is_admin": True}}}))
    (config / ".env").write_text(f"ORWELL_DATA_DIR={saves}\n")
    (saves / "player-1").mkdir(parents=True, exist_ok=True)
    (saves / "player-1" / "save.json").write_text("{}")
    for name in _ARCHIVES:
        (saves / name).mkdir(parents=True, exist_ok=True)
        (saves / name / "6162.json").write_text("[]")
    env = dict(os.environ)
    env.update({"APP_DIR": str(app), "ORWELL_CONFIG_DIR": str(config), "ORWELL_DATA_DIR": str(saves),
                "ORWELL_FE_DIR": str(app / "frontend"), "ORWELL_FE_DATA_DIR": str(fe_data), "ORWELL_PYTHON": "python3"})
    return saves, env


def _run(script, env):
    proc = subprocess.run(["bash", script, "--yes", "--no-restart"], env=env, capture_output=True, text=True)
    assert proc.returncode == 0, f"{script} failed:\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
@pytest.mark.parametrize("same_dir", [False, True], ids=["save-dir-separate", "save-dir==config-dir"])
def test_game_reset_keeps_the_player_archives(tmp_path, same_dir):
    saves, env = _layout(tmp_path, same_dir)
    _run(_GAME, env)
    assert not (saves / "player-1").exists(), "the season's sandbox must be scrubbed"
    for name in _ARCHIVES:
        assert (saves / name / "6162.json").exists(), f"a new season must keep {name}"


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
@pytest.mark.parametrize("script", [_OOBE, _FACTORY], ids=["oobe", "factory"])
@pytest.mark.parametrize("same_dir", [False, True], ids=["save-dir-separate", "save-dir==config-dir"])
def test_oobe_and_factory_reset_clear_the_player_archives(tmp_path, script, same_dir):
    saves, env = _layout(tmp_path, same_dir)
    _run(script, env)
    assert not (saves / "player-1").exists()
    for name in _ARCHIVES:
        assert not (saves / name).exists(), f"a fresh install must not keep {name}"
