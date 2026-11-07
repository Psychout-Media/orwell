"""ORW-233 — the live-game check works on a box WITHOUT the sqlite3 command-line tool (production has none).

deploy/orwell-live-game.sh (ORW-206) read the newest player message with the `sqlite3` CLI. Production has python3 but
no sqlite3 CLI, so live_game_idle_seconds answered "none" and the updater never waited for a live game. The reader now
uses python3's built-in sqlite3 module (read-only URI, 2 s busy timeout, isolated interpreter, run as the service user
when the updater is root) and keeps the CLI only as a fallback for a box without python3.

These tests run the REAL bash function with a PATH that has NO sqlite3 on it, against a fixture DB.
Name-agnostic: roles only.
"""
import getpass
import os
import shutil
import sqlite3
import subprocess

import pytest

from test_orw206_update_defers_live_game import LIB, _db, needs_bash, not_root  # the shared fixture DB + guards

# What the reader may call. sqlite3 is deliberately NOT here: production does not have it.
_TOOLS = ("bash", "python3", "timeout", "mktemp", "rm", "grep", "id", "cat", "sed", "tr", "head", "tail", "env",
          "dirname", "stat", "date", "find", "sleep")
needs_sqlite_cli = pytest.mark.skipif(shutil.which("sqlite3") is None, reason="sqlite3 CLI required")
needs_python3 = pytest.mark.skipif(shutil.which("python3") is None, reason="python3 required")


def _bin(tmp_path, *, without=("sqlite3",), extra=()):
    """A PATH dir holding only the named tools (symlinks to the real ones)."""
    d = tmp_path / "bin"
    d.mkdir(exist_ok=True)
    for tool in _TOOLS + tuple(extra):
        real = shutil.which(tool)
        if tool not in without and real and not (d / tool).exists():
            (d / tool).symlink_to(real)
    return d


def _fake(bindir, name, body):
    p = bindir / name
    if p.exists() or p.is_symlink():
        p.unlink()
    p.write_text("#!/usr/bin/env bash\n" + body)
    p.chmod(0o755)


def run(script, bindir, env=None):
    full = {k: v for k, v in os.environ.items() if not k.startswith(("ORWELL_", "PYTHON"))}
    full["PATH"] = str(bindir)
    full.update(env or {})
    r = subprocess.run([str(bindir / "bash"), "-c", f"set -euo pipefail; . '{LIB}'; {script}"],
                       capture_output=True, text=True, timeout=60, env=full)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@needs_bash
@needs_python3
@not_root
def test_the_real_idle_seconds_come_back_with_no_sqlite3_cli_on_path(tmp_path):
    path = _bin(tmp_path)
    assert run("command -v sqlite3 || echo absent", path) == "absent"       # exactly the production box
    db = _db(tmp_path, [("user", 3000), ("user", 120), ("assistant", 5)])
    got = int(run(f"live_game_idle_seconds '{db}'", path))
    assert 118 <= got <= 130, "the newest PLAYER message (120 s ago), not the assistant's (5 s ago)"


@needs_bash
@needs_python3
@not_root
def test_without_the_cli_no_db_table_or_player_message_is_none_and_a_corrupt_db_is_an_error(tmp_path):
    path = _bin(tmp_path)
    assert run(f"live_game_idle_seconds '{tmp_path}/missing.db'", path) == "none"
    empty = tmp_path / "e.db"
    sqlite3.connect(empty).close()
    assert run(f"live_game_idle_seconds '{empty}'", path) == "none"            # no table
    assert run(f"live_game_idle_seconds '{_db(tmp_path, [('assistant', 5)])}'", path) == "none"   # no player rows
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"this is not a sqlite database" * 50)
    assert run(f"live_game_idle_seconds '{bad}'", path) == "error"             # unknown failure -> retried, then runs


@needs_bash
@needs_python3
@not_root
def test_a_locked_db_is_a_transient_error_after_the_two_second_busy_timeout(tmp_path):
    path = _bin(tmp_path)
    db = _db(tmp_path, [("user", 60)])
    holder = sqlite3.connect(db, isolation_level=None)
    holder.execute("BEGIN EXCLUSIVE")                                         # a writer mid-commit
    try:
        assert run(f"live_game_idle_seconds '{db}'", path) == "error"
    finally:
        holder.execute("ROLLBACK")
        holder.close()
    assert 55 <= int(run(f"live_game_idle_seconds '{db}'", path)) <= 70       # free again -> the real value


@needs_bash
@needs_python3
@not_root
def test_the_read_never_writes_to_the_game_db(tmp_path):
    path = _bin(tmp_path)
    db = _db(tmp_path, [("user", 30)])
    before = (db.read_bytes(), db.stat().st_mtime_ns, sorted(p.name for p in tmp_path.iterdir()))
    run(f"live_game_idle_seconds '{db}'", path)
    assert (db.read_bytes(), db.stat().st_mtime_ns, sorted(p.name for p in tmp_path.iterdir())) == before


@needs_bash
@needs_python3
@not_root
def test_the_python_reader_ignores_a_planted_module_and_python_env(tmp_path):
    path = _bin(tmp_path)
    db = _db(tmp_path, [("user", 300)])
    evil = tmp_path / "evil"
    evil.mkdir()
    (evil / "sqlite3.py").write_text("raise SystemExit('PLANTED MODULE RAN')\n")
    out = run(f"cd '{evil}'; live_game_idle_seconds '{db}'", path, {"PYTHONPATH": str(evil), "PYTHONSTARTUP": str(evil / "sqlite3.py")})
    assert 295 <= int(out) <= 310


@needs_bash
@needs_python3
@not_root
def test_as_root_the_python_reader_runs_as_the_service_user(tmp_path):
    path = _bin(tmp_path)
    real_id = shutil.which("id")
    _fake(path, "id", f'if [[ "$*" == "-u" ]]; then echo 0; else exec {real_id} "$@"; fi\n')   # pretend to be root
    log = tmp_path / "runuser.log"
    _fake(path, "runuser", f'echo "$*" >> "{log}"\n[[ "$1" == -u && "$3" == -- ]] || exit 99\nshift 3\nexec "$@"\n')
    db = _db(tmp_path, [("user", 200)])
    me = getpass.getuser()                                                     # any existing non-root account
    got = int(run(f"live_game_idle_seconds '{db}'", path, {"ORWELL_SERVICE_USER": me}))
    assert 195 <= got <= 210
    calls = log.read_text().splitlines()
    assert calls and calls[0].startswith(f"-u {me} -- python3 -I "), calls


@needs_bash
@needs_sqlite_cli
@not_root
def test_a_box_without_python3_falls_back_to_the_sqlite3_cli(tmp_path):
    path = _bin(tmp_path, without=("python3",), extra=("sqlite3",))
    db = _db(tmp_path, [("user", 3000), ("user", 120), ("assistant", 5)])
    assert 118 <= int(run(f"live_game_idle_seconds '{db}'", path)) <= 130


@needs_bash
@not_root
def test_with_neither_python3_nor_the_cli_the_signal_is_unknown_so_the_update_runs(tmp_path):
    path = _bin(tmp_path, without=("python3", "sqlite3"))
    db = _db(tmp_path, [("user", 10)])
    assert run(f"live_game_idle_seconds '{db}'", path) == "none"
