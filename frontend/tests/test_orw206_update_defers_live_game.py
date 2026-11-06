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
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"
LIB = DEPLOY / "orwell-live-game.sh"
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
needs_sqlite = pytest.mark.skipif(shutil.which("sqlite3") is None, reason="sqlite3 CLI required")
# As root the signal reader (correctly) drops to the service user, who cannot read a root-made tmp DB.
not_root = pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="reader drops privileges when run as root")


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
    ("0 -30 15 0 240", "defer:live"),           # negative idle = clock skew -> treated as LIVE
    ("0 -99999 15 0 240", "defer:live"),
    ("0 -30 15 14400 240", "run:max-defer"),    # ...but still bounded by max defer
])
def test_decision(args, expected):
    assert bash(f"update_defer_decision {args}") == expected


@needs_bash
def test_settings_precedence_clamp_and_decimal(tmp_path):
    envf = tmp_path / ".env"
    envf.write_text("ORWELL_UPDATE_IDLE_MINUTES=30\nORWELL_UPDATE_MAX_DEFER_MINUTES=bogus\nORWELL_UPDATE_DEFER_POLL_SECONDS=08\n")
    nocfg = {"ORWELL_UPDATE_ROOT_CONF": str(tmp_path / "none.conf")}
    def get(key, d, lo, hi, env=None):
        return bash(f"update_defer_setting {key} {d} {lo} {hi} '{envf}'", {**nocfg, **(env or {})})
    assert get("ORWELL_UPDATE_IDLE_MINUTES", 15, 1, 120) == "30"                       # data/.env
    assert get("ORWELL_UPDATE_IDLE_MINUTES", 15, 1, 120, {"ORWELL_UPDATE_IDLE_MINUTES": "5"}) == "5"   # env wins
    assert get("ORWELL_UPDATE_MAX_DEFER_MINUTES", 240, 1, 1440) == "240"             # garbage -> default
    assert get("ORWELL_UPDATE_DEFER_POLL_SECONDS", 60, 5, 300) == "8"                 # 08 is decimal, not an octal error
    assert get("ORWELL_UPDATE_IDLE_MINUTES", 15, 1, 120, {"ORWELL_UPDATE_IDLE_MINUTES": "99999"}) == "120"   # clamped
    assert get("ORWELL_UPDATE_DEFER_POLL_SECONDS", 60, 5, 300, {"ORWELL_UPDATE_DEFER_POLL_SECONDS": "1"}) == "5"
    assert get("ORWELL_UPDATE_IDLE_MINUTES", 15, 1, 120, {"ORWELL_UPDATE_IDLE_MINUTES": "0"}) == "15"  # 0 is invalid -> default


@needs_bash
def test_root_owned_conf_is_read_before_data_env_only_when_safe(tmp_path):
    envf = tmp_path / ".env"
    envf.write_text("ORWELL_UPDATE_IDLE_MINUTES=30\n")
    conf = tmp_path / "update-defer.conf"
    conf.write_text("ORWELL_UPDATE_IDLE_MINUTES=45\n")
    conf.chmod(0o666)   # group/world-writable -> never trusted
    env = {"ORWELL_UPDATE_ROOT_CONF": str(conf)}
    assert bash(f"update_defer_setting ORWELL_UPDATE_IDLE_MINUTES 15 1 120 '{envf}'", env) == "30"
    if os.geteuid() == 0:   # ownership check needs a root-owned file
        conf.chmod(0o644)
        assert bash(f"update_defer_setting ORWELL_UPDATE_IDLE_MINUTES 15 1 120 '{envf}'", env) == "45"


@needs_bash
def test_fifo_in_place_of_data_env_does_not_hang_the_updater(tmp_path):
    fifo = tmp_path / ".env"
    os.mkfifo(fifo)
    t0 = time.time()
    out = bash(f"update_defer_setting ORWELL_UPDATE_IDLE_MINUTES 15 1 120 '{fifo}'",
               {"ORWELL_UPDATE_ROOT_CONF": str(tmp_path / "none.conf")})
    assert out == "15" and time.time() - t0 < 5      # a FIFO is not a regular file: skipped, never read


@needs_bash
def test_data_env_cannot_raise_max_defer_above_240_but_env_can(tmp_path):
    envf = tmp_path / ".env"
    envf.write_text("ORWELL_UPDATE_MAX_DEFER_MINUTES=1440\n")
    nocfg = {"ORWELL_UPDATE_ROOT_CONF": str(tmp_path / "none.conf")}
    assert bash(f"update_defer_setting ORWELL_UPDATE_MAX_DEFER_MINUTES 240 1 1440 '{envf}' 240", nocfg) == "240"
    assert bash(f"update_defer_setting ORWELL_UPDATE_MAX_DEFER_MINUTES 240 1 1440 '{envf}' 240",
                {**nocfg, "ORWELL_UPDATE_MAX_DEFER_MINUTES": "1440"}) == "1440"


@needs_bash
def test_root_conf_in_a_writable_directory_is_rejected(tmp_path):
    d = tmp_path / "etc"
    d.mkdir()
    d.chmod(0o777)
    conf = d / "update-defer.conf"
    conf.write_text("ORWELL_UPDATE_IDLE_MINUTES=45\n")
    env = {"ORWELL_UPDATE_ROOT_CONF": str(conf)}
    assert bash("_ud_root_conf_ok && echo yes || echo no", env) == "no"


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
@not_root
def test_idle_seconds_uses_newest_player_message_only(tmp_path):
    db = _db(tmp_path, [("user", 3000), ("user", 120), ("assistant", 5)])
    got = int(bash(f"live_game_idle_seconds '{db}'"))
    assert 118 <= got <= 130          # the assistant row (5s) must not count as a player message


@needs_bash
@needs_sqlite
@not_root
def test_idle_seconds_none_for_no_db_table_or_player_rows_error_for_corrupt(tmp_path):
    assert bash(f"live_game_idle_seconds '{tmp_path}/missing.db'") == "none"
    empty = tmp_path / "e.db"
    sqlite3.connect(empty).close()
    assert bash(f"live_game_idle_seconds '{empty}'") == "none"          # no table
    assert bash(f"live_game_idle_seconds '{_db(tmp_path, [('assistant', 5)])}'") == "none"   # no player rows
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"this is not a sqlite database" * 50)
    assert bash(f"live_game_idle_seconds '{bad}'") == "error"           # transient/unknown failure -> retry, not run


@needs_bash
@needs_sqlite
def test_sqlite_is_never_run_as_root_without_dropping_privileges(tmp_path):
    db = _db(tmp_path, [("user", 10)])
    # Pretend to be root (id -u -> 0) with no usable service user: must answer "none" and never invoke sqlite3.
    out = bash(f"id() {{ if [[ \"$1\" == -u ]]; then echo 0; else return 1; fi; }}; "
               f"sqlite3() {{ echo SQLITE_RAN_AS_ROOT >&2; echo 5; }}; live_game_idle_seconds '{db}'",
               {"ORWELL_SERVICE_USER": "no-such-user-xyz"})
    assert out == "none"


# ── the whole loop, with the clock + sleep faked ─────────────────────────────
LOOP = textwrap.dedent("""
    T=1000000; SLEEPS=0
    export ORWELL_RUN_DIR='{run}'
    _update_defer_now() {{ echo $T; }}
    _update_defer_sleep() {{ T=$((T + $1)); SLEEPS=$((SLEEPS + 1)); {on_sleep}; }}
    live_game_idle_seconds() {{ printf '%s' "${{IDLE:-none}}"; }}
    {call}
    echo "SLEEPS=$SLEEPS T=$((T - 1000000))"
    echo "STATUS_PRESENT=$([[ -e '{run}/update-deferred' ]] && echo yes || echo no)"
""")


def run_loop(tmp_path, *, idle, force=0, on_sleep=":", env=None, call_extra=""):
    ops = tmp_path / "ops"
    ops.mkdir(exist_ok=True)
    call = f"{call_extra}IDLE='{idle}'; update_wait_for_idle_game /nonexistent.db '{ops}' {force} ''"
    return bash(LOOP.format(on_sleep=on_sleep, call=call, run=tmp_path / "run"), env)


@needs_bash
def test_live_game_defers_writes_status_then_runs_when_idle(tmp_path):
    run = tmp_path / "run"
    out = run_loop(tmp_path, idle=30,
                   on_sleep='[[ $SLEEPS -ge 3 ]] && IDLE=2000 || { grep -q "deferred=true" "' + str(run) + '/update-deferred" && echo SAW_STATUS; }')
    assert "Update deferred" in out and "SAW_STATUS" in out        # visible status while deferring
    assert "proceeding with the update" in out
    assert "SLEEPS=3" in out and "STATUS_PRESENT=no" in out        # cleared once it proceeds


@needs_bash
def test_defer_notifies_the_web_status_page_via_hook(tmp_path):
    out = run_loop(tmp_path, idle=30, on_sleep='IDLE=2000',
                   call_extra='update_defer_notify() { echo "NOTIFY:$1"; }; ')
    assert "NOTIFY:Update deferred: a game is live" in out


@needs_bash
def test_status_file_lives_in_root_owned_run_dir_and_has_reason(tmp_path):
    run = tmp_path / "run"
    bash("update_defer_write_status 'live game: last player message 30s ago' 2026-11-06T00:00:00Z 2026-11-06T04:00:00Z 1793000000",
         {"ORWELL_RUN_DIR": str(run)})
    text = (run / "update-deferred").read_text()
    assert "reason=live game" in text and "proceeds_by_epoch=1793000000" in text and "--force" in text
    assert not [p for p in run.iterdir() if p.name.startswith(".update-deferred.")]   # no temp left behind
    # a symlinked run dir is refused outright
    link = tmp_path / "linkdir"
    link.symlink_to(tmp_path / "elsewhere")
    (tmp_path / "elsewhere").mkdir()
    bash("update_defer_write_status r s u 1", {"ORWELL_RUN_DIR": str(link)})
    assert not list((tmp_path / "elsewhere").iterdir())


@needs_bash
def test_idle_game_runs_immediately(tmp_path):
    out = run_loop(tmp_path, idle=5000)
    assert "SLEEPS=0" in out and "deferred" not in out.lower().replace("deferring", "")


@needs_bash
def test_force_runs_immediately_even_when_live(tmp_path):
    out = run_loop(tmp_path, idle=1, force=1)
    assert "SLEEPS=0" in out and "skipped" in out


@needs_bash
def test_web_force_flag_is_consumed_and_proceeds(tmp_path):
    ops = tmp_path / "ops"
    ops.mkdir()
    (ops / "update-force-requested").write_text("x")
    out = run_loop(tmp_path, idle=1)
    assert "web force request received" in out and "SLEEPS=0" in out
    assert not (ops / "update-force-requested").exists()


@needs_bash
def test_web_force_flag_that_is_a_symlink_or_stale_is_ignored(tmp_path):
    ops = tmp_path / "ops"
    ops.mkdir()
    target = tmp_path / "t"
    target.write_text("x")
    (ops / "update-force-requested").symlink_to(target)
    out = run_loop(tmp_path, idle=1, env={"ORWELL_UPDATE_MAX_DEFER_MINUTES": "1", "ORWELL_UPDATE_DEFER_POLL_SECONDS": "60"})
    assert "web force request" not in out and "max defer" in out
    (ops / "update-force-requested").unlink()
    f = ops / "update-force-requested"
    f.write_text("x")
    old = time.time() - 7200
    os.utime(f, (old, old))
    out = run_loop(tmp_path, idle=1, env={"ORWELL_UPDATE_MAX_DEFER_MINUTES": "1", "ORWELL_UPDATE_DEFER_POLL_SECONDS": "60"})
    assert "web force request" not in out


@needs_bash
def test_none_signal_runs_but_error_retries_then_runs(tmp_path):
    assert "SLEEPS=0" in run_loop(tmp_path, idle="none")
    out = run_loop(tmp_path, idle="error")           # 3 retries (5s each), then run
    assert "attempt 3/3" in out and "SLEEPS=3 T=15" in out and "proceeding" in out


@needs_bash
def test_negative_idle_is_live_until_max_defer(tmp_path):
    out = run_loop(tmp_path, idle=-500, env={"ORWELL_UPDATE_MAX_DEFER_MINUTES": "2", "ORWELL_UPDATE_DEFER_POLL_SECONDS": "60"})
    assert "SLEEPS=2 T=120" in out and "max defer" in out


@needs_bash
def test_max_defer_proceeds_even_if_game_never_goes_idle(tmp_path):
    out = run_loop(tmp_path, idle=1, env={"ORWELL_UPDATE_MAX_DEFER_MINUTES": "2", "ORWELL_UPDATE_DEFER_POLL_SECONDS": "60"})
    assert "max defer (2 min) reached" in out and "SLEEPS=2 T=120" in out and "STATUS_PRESENT=no" in out


@needs_bash
def test_status_is_cleared_when_the_wait_is_terminated(tmp_path):
    run = tmp_path / "run"
    ops = tmp_path / "ops"
    ops.mkdir()
    script = (f"export ORWELL_RUN_DIR='{run}'; live_game_idle_seconds() {{ echo 10; }}; "
              f"_update_defer_sleep() {{ kill -TERM $$; sleep 1; }}; "
              f"update_wait_for_idle_game /x.db '{ops}' 0 ''")
    r = subprocess.run(["bash", "-c", f". '{LIB}'; {script}"], capture_output=True, text=True, timeout=30)
    assert r.returncode == 143
    assert not (run / "update-deferred").exists()


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
    assert "update_deferred_check" in DOCTOR and "/run/orwell" in DOCTOR and "[:print:]" in DOCTOR
    assert DOCTOR.index("update_deferred_check\n") < DOCTOR.index("token_security_check\n  engine_http_ok")


def _doctor(tmp_path, body, now_offset=0):
    run = tmp_path / "run"
    run.mkdir(exist_ok=True)
    (run / "update-deferred").write_bytes(body)
    src = DOCTOR[DOCTOR.index("update_deferred_check() {"):DOCTOR.index("diagnose() {")]
    return bash(f"ORWELL_RUN_DIR='{run}'; APP_DIR=/x; warn() {{ echo \"warn $*\"; }}; info() {{ echo \"info $*\"; }}\n{src}\nupdate_deferred_check")


@needs_bash
def test_doctor_check_prints_the_reason_and_strips_control_chars(tmp_path):
    future = int(time.time()) + 3600
    out = _doctor(tmp_path, f"deferred=true\nreason=live game \x1b[31mRED\x07\nproceeds_by_epoch={future}\n".encode())
    assert "DEFERRED" in out and "reason=live game" in out and "--force" in out
    assert "\x1b" not in out and "\x07" not in out


@needs_bash
def test_doctor_ignores_a_stale_status(tmp_path):
    past = int(time.time()) - 3600     # proceeds_by + 10 min margin long gone: the updater died
    assert _doctor(tmp_path, f"deferred=true\nreason=x\nproceeds_by_epoch={past}\n".encode()) == ""


# ── the web-side force endpoint ──────────────────────────────────────────────
def test_force_route_exists_and_uses_the_same_admin_guard():
    src = (ROOT / "frontend" / "routes" / "admin_update_routes.py").read_text()
    seg = src[src.index('"/update/force"'):]
    assert "guard_root_op(request)" in seg and "update-force-requested" in seg
