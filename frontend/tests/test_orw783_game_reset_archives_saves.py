"""ORW-783: the game reset ARCHIVES each user's engine saves instead of deleting them.

Runs the REAL deploy/orwell-game-reset.sh over a sandboxed tmp layout (no /opt paths, no orwell-* units). A per-user save dir (hex-named) and the
engine's own `<user>.retired-*` rotation move into <save dir>/save-archive/<user>/<stamp>; nothing crosses users; the cap prunes oldest first and
keeps the newest; a dry run moves nothing; a second run does not clobber the first's archive. Roles only (no names, no game content)."""
import os
import shutil
import subprocess
import time

import pytest

_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_GAME_SCRIPT = os.path.join(_REPO, "deploy", "orwell-game-reset.sh")
_USER_A = "6161"   # a hex user dir name, as the engine names them
_USER_B = "6262"


def _layout(tmp_path):
    app = tmp_path / "app"
    saves = app / ".orwell-data"
    fe = app / "frontend" / "data"
    cfg = app / "data"
    for d in (saves, fe, cfg):
        d.mkdir(parents=True, exist_ok=True)
    (cfg / ".env").write_text(f"ORWELL_DATA_DIR={saves}\n")
    return app, saves, fe, cfg


def _env(app, saves, fe, cfg, **extra):
    env = dict(os.environ)
    env.update({"APP_DIR": str(app), "ORWELL_CONFIG_DIR": str(cfg), "ORWELL_DATA_DIR": str(saves), "ORWELL_FE_DATA_DIR": str(fe)})
    env.update(extra)
    return env


def _run(env, *flags):
    return subprocess.run(["bash", _GAME_SCRIPT, "--no-restart", *flags], env=env, capture_output=True, text=True)


def _seed_user(saves, user, payload="x" * 10):
    d = saves / user
    d.mkdir(parents=True, exist_ok=True)
    (d / "v000001.json").write_text(payload)
    return d


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_reset_moves_each_users_saves_into_their_own_archive(tmp_path):
    app, saves, fe, cfg = _layout(tmp_path)
    _seed_user(saves, _USER_A, "season-of-a")
    _seed_user(saves, _USER_B, "season-of-b")
    old = saves / (_USER_A + ".retired-1700000000000")
    old.mkdir()
    (old / "v000001.json").write_text("older-of-a")
    proc = _run(_env(app, saves, fe, cfg), "--yes")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert not (saves / _USER_A).exists() and not (saves / _USER_B).exists()          # cleared from play
    a = sorted(p.name for p in (saves / "save-archive" / _USER_A).iterdir())
    b = sorted(p.name for p in (saves / "save-archive" / _USER_B).iterdir())
    assert len(a) == 2 and any(n.startswith("retired-") for n in a)                   # the live dir and the engine's own rotation
    assert len(b) == 1
    texts_a = {(saves / "save-archive" / _USER_A / n / "v000001.json").read_text() for n in a}
    assert texts_a == {"season-of-a", "older-of-a"}
    assert (saves / "save-archive" / _USER_B / b[0] / "v000001.json").read_text() == "season-of-b"  # never across users
    assert (cfg / ".env").exists()


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_dry_run_moves_nothing_and_a_second_reset_does_not_clobber(tmp_path):
    app, saves, fe, cfg = _layout(tmp_path)
    _seed_user(saves, _USER_A, "first")
    env = _env(app, saves, fe, cfg)
    dry = _run(env, "--dry-run")
    assert dry.returncode == 0 and "would archive" in dry.stdout
    assert (saves / _USER_A / "v000001.json").read_text() == "first" and not (saves / "save-archive").exists()
    assert _run(env, "--yes").returncode == 0
    _seed_user(saves, _USER_A, "second")
    assert _run(env, "--yes").returncode == 0
    kept = sorted(p for p in (saves / "save-archive" / _USER_A).iterdir())
    assert sorted((p / "v000001.json").read_text() for p in kept) == ["first", "second"]   # both seasons kept; no name reused


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
def test_cap_prunes_the_oldest_first_and_keeps_the_newest(tmp_path):
    app, saves, fe, cfg = _layout(tmp_path)
    env = _env(app, saves, fe, cfg, ORWELL_SAVE_ARCHIVE_MAX_MB="1")
    for i, label in enumerate(("oldest", "middle", "newest")):
        d = _seed_user(saves, _USER_A, label)
        (d / "pad.bin").write_bytes(b"\0" * (700 * 1024))                         # 700 KB each: two exceed the 1 MB cap
        assert _run(env, "--yes").returncode == 0
        time.sleep(1.1)                                                            # distinct stamps and mtimes
    left = sorted((p / "v000001.json").read_text() for p in (saves / "save-archive" / _USER_A).iterdir())
    assert left == ["newest"]
