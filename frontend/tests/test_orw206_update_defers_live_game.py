"""ORW-206 — orwell-update.sh must not restart the app in the middle of a live game.

The decision lives in deploy/orwell-live-game.sh (sourced by the updater): live => defer, idle => run,
force => run, unknown signal => run, max-defer reached => run. These tests drive the REAL bash functions
(pure decision, the sqlite signal, and the whole wait loop with the clock/sleep seams faked).
"""
import os
import shutil
import sqlite3
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"
LIB = DEPLOY / "orwell-live-game.sh"
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
needs_sqlite = pytest.mark.skipif(shutil.which("sqlite3") is None, reason="sqlite3 CLI required")


def bash(script, env=None):
    full = dict(os.environ)
    for k in ("ORWELL_UPDATE_IDLE_MINUTES", "ORWELL_UPDATE_MAX_DEFER_MINUTES",
              "ORWELL_UPDATE_DEFER_POLL_SECONDS", "ORWELL_UPDATE_FORCE"):
        full.pop(k, None)
    full.update(env or {})
    r = subprocess.run(["bash", "-c", f"set -euo pipefail; . '{LIB}'; {script}"],
                       capture_output=True, text=True, timeout=60, env=full)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


# ── every touched script parses ─────────────────────────────────────────────
@needs_bash
@pytest.mark.parametrize("name", ["orwell-live-game.sh", "orwell-update.sh", "orwell-doctor.sh"])
def test_bash_n(name):
    r = subprocess.run(["bash", "-n", str(DEPLOY / name)], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


# ── the pure decision ───────────────────────────────────────────────────────
@needs_bash
@pytest.mark.parametrize("args,expected", [
    ("0 60 15 0 240", "defer:live"),            # player spoke 1 min ago -> defer
    ("0 899 15 0 240", "defer:live"),           # just under the 15-minute idle line
    ("0 900 15 0 240", "run:idle"),             # exactly idle -> run
    ("0 5000 15 0 240", "run:idle"),
    ("1 5 15 0 240", "run:force"),              # force beats a live game
    ("0 5 15 14400 240", "run:max-defer"),      # waited the max -> proceed anyway
    ("0 5 15 14399 240", "defer:live"),
    ("0 '' 15 0 240", "run:unknown"),           # no signal -> fail open
    ("0 'abc' 15 0 240", "run:unknown"),
])
def test_decision(args, expected):
    assert bash(f"update_defer_decision {args}") == expected


@needs_bash
def test_settings_env_then_file_then_default_and_garbage_rejected(tmp_path):
    envf = tmp_path / ".env"
    envf.write_text("ORWELL_UPDATE_IDLE_MINUTES=30\nORWELL_UPDATE_MAX_DEFER_MINUTES=bogus\n")
    assert bash(f"update_defer_setting ORWELL_UPDATE_IDLE_MINUTES 15 '{envf}'") == "30"
    assert bash(f"update_defer_setting ORWELL_UPDATE_IDLE_MINUTES 15 '{envf}'", {"ORWELL_UPDATE_IDLE_MINUTES": "5"}) == "5"
    assert bash(f"update_defer_setting ORWELL_UPDATE_MAX_DEFER_MINUTES 240 '{envf}'") == "240"
    assert bash("update_defer_setting ORWELL_UPDATE_IDLE_MINUTES 15 /nonexistent") == "15"
    assert bash("update_defer_setting ORWELL_UPDATE_IDLE_MINUTES 15", {"ORWELL_UPDATE_IDLE_MINUTES": "0"}) == "15"


# ── the real signal: newest player message in the FE DB ──────────────────────
def _db(tmp_path, rows):
    db = tmp_path / "app.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, timestamp DATETIME)")
    for i, (role, age_s) in enumerate(rows):
        con.execute("INSERT INTO chat_messages VALUES (?,?,?, datetime('now', ?))",
                    (str(i), "s", role, f"-{age_s} seconds"))
    con.commit()
    con.close()
    return db


@needs_bash
@needs_sqlite
def test_idle_seconds_uses_newest_player_message_only(tmp_path):
    db = _db(tmp_path, [("user", 3000), ("user", 120), ("assistant", 5)])
    got = int(bash(f"live_game_idle_seconds '{db}'"))
    assert 118 <= got <= 130          # the assistant row (5s) must not count as a player message


@needs_bash
@needs_sqlite
def test_idle_seconds_unknown_when_no_db_table_or_player_rows(tmp_path):
    assert bash(f"live_game_idle_seconds '{tmp_path}/missing.db'") == ""
    empty = tmp_path / "e.db"
    sqlite3.connect(empty).close()
    assert bash(f"live_game_idle_seconds '{empty}'") == ""
    assert bash(f"live_game_idle_seconds '{_db(tmp_path, [('assistant', 5)])}'") == ""


# ── the whole loop, with the clock + sleep faked ─────────────────────────────
LOOP = textwrap.dedent("""
    T=1000000; SLEEPS=0
    _update_defer_now() {{ echo $T; }}
    _update_defer_sleep() {{ T=$((T + $1)); SLEEPS=$((SLEEPS + 1)); {on_sleep}; }}
    live_game_idle_seconds() {{ printf '%s' "${{IDLE:-}}"; }}
    {call}
    echo "SLEEPS=$SLEEPS T=$((T - 1000000))"
    echo "STATUS_PRESENT=$([[ -e '{ops}/update-deferred' ]] && echo yes || echo no)"
""")


def run_loop(tmp_path, *, idle, force=0, on_sleep=":", env=None):
    ops = tmp_path / "ops"
    call = f"IDLE='{idle}'; update_wait_for_idle_game /nonexistent.db '{ops}' {force} ''"
    return bash(LOOP.format(on_sleep=on_sleep, call=call, ops=ops), env)


@needs_bash
def test_live_game_defers_writes_status_then_runs_when_idle(tmp_path):
    ops = tmp_path / "ops"
    # Live at first; the "player" goes quiet after the 3rd poll (idle jumps past the 15-minute line).
    script = LOOP.format(
        on_sleep='[[ $SLEEPS -ge 3 ]] && IDLE=2000 || { grep -q "deferred=true" "' + str(ops) + '/update-deferred" && echo SAW_STATUS; }',
        call=f"IDLE=30; update_wait_for_idle_game /nonexistent.db '{ops}' 0 ''", ops=ops)
    out = bash(script)
    assert "update DEFERRED" in out and "SAW_STATUS" in out        # visible status while deferring
    assert "proceeding with the update" in out
    assert "SLEEPS=3" in out and "STATUS_PRESENT=no" in out        # cleared once it proceeds


@needs_bash
def test_status_file_content_has_reason_and_override(tmp_path):
    ops = tmp_path / "ops"
    bash(f"update_defer_write_status '{ops}' 'live game: last player message 30s ago' 2026-11-06T00:00:00Z 2026-11-06T04:00:00Z")
    text = (ops / "update-deferred").read_text()
    assert "reason=live game" in text and "proceeds_by=2026-11-06T04:00:00Z" in text and "--force" in text


@needs_bash
def test_idle_game_runs_immediately(tmp_path):
    out = run_loop(tmp_path, idle=5000)
    assert "SLEEPS=0" in out and "DEFERRED" not in out


@needs_bash
def test_force_runs_immediately_even_when_live(tmp_path):
    out = run_loop(tmp_path, idle=1, force=1)
    assert "SLEEPS=0" in out and "skipped" in out
    assert "SLEEPS=0" in run_loop(tmp_path, idle=1, force=1)


@needs_bash
def test_unknown_signal_runs(tmp_path):
    assert "SLEEPS=0" in run_loop(tmp_path, idle="")


@needs_bash
def test_max_defer_proceeds_even_if_game_never_goes_idle(tmp_path):
    # Always live; max defer 2 min, poll 60s -> exactly 2 sleeps, then it proceeds.
    out = run_loop(tmp_path, idle=1, env={"ORWELL_UPDATE_MAX_DEFER_MINUTES": "2", "ORWELL_UPDATE_DEFER_POLL_SECONDS": "60"})
    assert "max defer (2 min) reached" in out and "SLEEPS=2 T=120" in out and "STATUS_PRESENT=no" in out


# ── wiring (the pieces that cannot run on CI) ────────────────────────────────
UPDATE = (DEPLOY / "orwell-update.sh").read_text()
DOCTOR = (DEPLOY / "orwell-doctor.sh").read_text()


def test_updater_wiring():
    assert "--force)      FORCE=1" in UPDATE and 'ORWELL_UPDATE_FORCE' in UPDATE
    call = UPDATE.index("update_wait_for_idle_game \"")
    assert call < UPDATE.index("acquire_update_lock\n"), "the wait must run BEFORE the lock so --force/--rollback are never blocked"
    assert call < UPDATE.index("trap on_update_exit EXIT"), "nothing is built/changed while deferring"
    guard = UPDATE[UPDATE.rindex("if [[", 0, call):call]
    for flag in ("ROLLBACK -eq 0", "SET_TOKEN -eq 0", "NO_RESTART -eq 0"):
        assert flag in guard
    assert '--force' in UPDATE[UPDATE.index("FWD_FLAG="):UPDATE.index("FWD_ENV=")], "the host bridge must forward --force"


def test_doctor_status_shows_deferred_update():
    assert "update_deferred_check" in DOCTOR and "data/ops/update-deferred" in DOCTOR
    assert DOCTOR.index("update_deferred_check\n") < DOCTOR.index("token_security_check\n  engine_http_ok")


@needs_bash
def test_doctor_check_prints_the_reason(tmp_path):
    (tmp_path / "data" / "ops").mkdir(parents=True)
    (tmp_path / "data" / "ops" / "update-deferred").write_text("deferred=true\nreason=live game\n")
    src = DOCTOR[DOCTOR.index("update_deferred_check() {"):DOCTOR.index("diagnose() {")]
    out = bash(f"APP_DIR='{tmp_path}'; warn() {{ echo \"warn $*\"; }}; info() {{ echo \"info $*\"; }}; {src}\n update_deferred_check")
    assert "DEFERRED" in out and "reason=live game" in out and "--force" in out
