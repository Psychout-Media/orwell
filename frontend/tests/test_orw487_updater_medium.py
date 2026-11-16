"""ORW-487/490/496/497/498: updater medium fixes. Sandboxed: the scripts' own functions are run against temp dirs with stubbed
sleeps/commands; the update script is never run against an install, and nothing touches systemd, pct or chown."""
import os
import re
import shutil
import sqlite3
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "deploy" / "orwell-live-game.sh"
UPDATE = (ROOT / "deploy" / "orwell-update.sh").read_text()
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")


def _bash(script, env=None, cwd=None):
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=60, cwd=cwd, env={**os.environ, **(env or {})})


def _fn(name):
    return re.search(rf"^{name}\(\) \{{.*?^\}}\n", UPDATE, re.S | re.M).group(0)


def _game_db(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("create table x(a)")
    con.commit()
    con.close()


# ── ORW-487: the guard reads the DATABASE_URL file ─────────────────────────────────────────────────────────────────────
@needs_bash
def test_the_guard_db_follows_a_sqlite_database_url_in_the_env_file_and_defaults_otherwise(tmp_path):
    app = tmp_path / "app"
    (app / "data").mkdir(parents=True)
    env = app / "data" / ".env"
    run = lambda: _bash(f'. "{LIB}"; update_fe_db_path "{app}" "{env}" /default/app.db', {"DATABASE_URL": ""}).stdout
    assert run() == "/default/app.db"                                   # no .env file
    env.write_text("OTHER=1\n")
    assert run() == "/default/app.db"                                   # no DATABASE_URL
    env.write_text('DATABASE_URL="sqlite:////srv/other/play.db"\n')
    assert run() == "/srv/other/play.db"                                # absolute
    env.write_text("DATABASE_URL=sqlite:///./data/alt.db\n")
    assert run() == f"{app}/frontend/data/alt.db"                       # relative to the front end's working directory
    env.write_text("DATABASE_URL=postgresql://u@h/db\n")
    assert run() == "/default/app.db"                                   # not SQLite: the default


def test_the_updater_passes_the_resolved_path_to_the_guard_and_the_cleanup():
    assert "update_wait_for_idle_game \"$(update_fe_db_path " in UPDATE
    assert UPDATE.count("update_fe_db_path \"$APP_DIR\"") == 2


# ── ORW-496: a relative database path is made absolute before the readers cd / ────────────────────────────────────────
@needs_bash
def test_the_live_game_reader_finds_a_database_given_by_a_relative_path(tmp_path):
    _game_db(tmp_path / "frontend" / "data" / "app.db")
    r = _bash(f'. "{LIB}"; _live_game_read_python frontend/data/app.db; echo; _live_game_read_cli frontend/data/app.db', cwd=tmp_path)
    got = r.stdout.split("\n")
    assert got[0] == "none", r.stdout     # a file that is found but has no messages table reads as "none" ...
    # ... whereas an unfound file (the bug: opened from /) reads as "error"
    assert "error" not in r.stdout


@needs_bash
def test_the_cruft_cleanup_gets_an_absolute_path(tmp_path):
    body = _fn("_svc_cleanup_mcp_rows_py")
    script = textwrap.dedent(f"""
        . "{LIB}"
        _CRUFT_MCP_PY='import sys; print(sys.argv[1])'; _CRUFT_MCP_WHERE=x
        {body}
        _svc_cleanup_mcp_rows_py frontend/data/app.db
    """)
    assert _bash(script, cwd=tmp_path).stdout.strip() == f"{tmp_path}/frontend/data/app.db"


# ── ORW-490: hold length, one clamp, settle validated ─────────────────────────────────────────────────────────────────
@needs_bash
def test_the_hold_covers_turn_wait_plus_warm_wait_plus_restart_and_the_clamp_is_shared(tmp_path):
    out = lambda env: _bash(f'. "{LIB}"; update_hold_seconds', env).stdout.strip()
    assert out({"ORWELL_UPDATE_TURN_WAIT_SECONDS": "300", "ORWELL_UPDATE_WARM_WAIT_SECONDS": "300"}) == "750"
    assert out({"ORWELL_UPDATE_TURN_WAIT_SECONDS": "9999", "ORWELL_UPDATE_WARM_WAIT_SECONDS": "x"}) == str(300 + 60 + 150)
    assert out({"ORWELL_UPDATE_TURN_WAIT_SECONDS": "08", "ORWELL_UPDATE_WARM_WAIT_SECONDS": "0"}) == str(8 + 1 + 150)
    lib = LIB.read_text()
    assert "(( max > 300 )) && max=300" not in lib, "the 1..300 clamp lives only in update_bound"
    assert "__tw" not in UPDATE
    ws = (ROOT / "frontend/static/js/orwellWs.js").read_text()
    assert int(re.search(r"HOLD_MAX_WAIT_MS = (\d+)", ws).group(1)) >= 750 * 1000


@needs_bash
@pytest.mark.parametrize("bad,expect", [("999", 2), ("x", 2), ("-5", 2), ("7", 7)])
def test_the_hold_settle_value_is_validated(tmp_path, bad, expect):
    script = textwrap.dedent(f"""
        . "{LIB}"
        export ORWELL_RUN_DIR='{tmp_path / "run"}'
        _update_defer_now() {{ echo 1000; }}
        _update_defer_sleep() {{ echo "SLEPT $1"; }}
        update_turn_hold_begin 100 >/dev/null
        update_turn_hold_begin 100 | grep SLEPT
    """)
    r = _bash(script, {"ORWELL_UPDATE_HOLD_SETTLE_SECONDS": bad})
    assert f"SLEPT {expect}" in r.stdout, r.stdout + r.stderr


# ── ORW-497 / ORW-498: the /play build trust and the rollback match ────────────────────────────────────────────────
def _play_fns():
    return "\n".join([_fn("_owned_by_us"), _fn("play_build_fp"), _fn("play_build_src_fp"), "_same() { [[ -n \"$1\" && \"$1\" != none && \"$1\" == \"$2\" ]]; }"])


def _build(d, fp, src=None):
    d.mkdir(parents=True)
    (d / "index.html").write_text("x")
    (d / ".stamp").write_text(fp + "\n" + (src + "\n" if src else ""))
    d.chmod(0o755)
    for f in d.iterdir():
        f.chmod(0o644)


FP = "a" * 64
SRC = "b" * 64


@needs_bash
def test_a_writable_dist_with_a_matching_stamp_is_not_believed(tmp_path):
    _build(tmp_path / "ok", FP, SRC)
    _build(tmp_path / "bad_dir", FP, SRC)
    (tmp_path / "bad_dir").chmod(0o775)
    _build(tmp_path / "bad_stamp", FP, SRC)
    (tmp_path / "bad_stamp" / ".stamp").chmod(0o666)
    out = lambda d: _bash(f'PLAY_STAMP=.stamp; {_play_fns()}\nplay_build_fp "{tmp_path / d}"').stdout
    assert out("ok") == FP
    assert out("bad_dir") == "" and out("bad_stamp") == ""


@needs_bash
def test_the_rollback_matches_a_kept_build_on_the_source_fingerprint_only(tmp_path):
    _build(tmp_path / "prev", "c" * 64, SRC)       # stamped by the OLD updater: full fingerprint differs from the new updater's
    r = _bash(f'PLAY_STAMP=.stamp; {_play_fns()}\nplay_build_src_fp "{tmp_path / "prev"}"')
    assert r.stdout == SRC
    # the real rollback function matches on the source part; the updater text is not part of play_source_fp
    assert 'fp="$(play_source_fp)"' in _fn("play_follow_rollback")
    assert "updater=" not in _fn("play_source_fp")
    assert "play_source_fp" in _fn("build_play_app")
