"""ORW-398 — a run that goes ahead must supersede a deferred update run (one restart, not two); the updater logs
who/how it was started; the ops-update header is truthful; journald restarts only when its drop-in changed.
"""
import os
import re
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"
LIB = DEPLOY / "orwell-live-game.sh"
UPDATE = (DEPLOY / "orwell-update.sh").read_text()
needs_bash = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")
needs_flock = pytest.mark.skipif(shutil.which("bash") is None or shutil.which("flock") is None, reason="bash and flock required")  # review of #2746: the lock tests run flock itself


def bash(script, env=None, check=True):
    full = dict(os.environ)
    full.update(env or {})
    r = subprocess.run(["bash", "-c", f"set -uo pipefail; . '{LIB}'; {script}"],
                       capture_output=True, text=True, timeout=60, env=full)
    if check:
        assert r.returncode == 0, r.stderr
    return r


LOOP = textwrap.dedent("""
    T=1000000
    export ORWELL_RUN_DIR='{run}'
    _update_defer_now() {{ echo $T; }}
    _update_defer_sleep() {{ T=$((T + $1)); {on_sleep}; }}
    live_game_idle_seconds() {{ printf '%s' "${{IDLE:-none}}"; }}
    IDLE='{idle}'; rc=0
    update_wait_for_idle_game /nonexistent.db '{ops}' {force} '' || rc=$?
    echo "RC=$rc RESTARTS_WOULD_RUN=$([[ $rc -eq 0 ]] && echo yes || echo no)"
""")


def loop(tmp_path, *, idle, force=0, on_sleep=":"):
    ops = tmp_path / "ops"
    ops.mkdir(exist_ok=True)
    env = {"ORWELL_UPDATE_ROOT_CONF": str(tmp_path / "none.conf")}
    return bash(LOOP.format(run=tmp_path / "run", on_sleep=on_sleep, idle=idle, ops=ops, force=force), env).stdout


@needs_bash
def test_deferred_run_exits_without_running_when_another_run_went_ahead(tmp_path):
    # While run A waits on a live game, run B (forced/manual) proceeds -> A must stop, not restart a second time.
    out = loop(tmp_path, idle=30, on_sleep="update_run_supersede")
    assert "superseded" in out
    assert "RC=10 RESTARTS_WOULD_RUN=no" in out


@needs_bash
def test_a_run_that_proceeds_supersedes_any_deferred_run(tmp_path):
    run = tmp_path / "run"
    before = bash(f"ORWELL_RUN_DIR='{run}'; update_run_seq_read").stdout
    out = loop(tmp_path, idle=30, force=1)          # forced: proceeds at once
    assert "RC=0" in out
    after = bash(f"ORWELL_RUN_DIR='{run}'; update_run_seq_read").stdout
    assert after != before                           # a deferred run polling this token would now exit
    out = loop(tmp_path, idle=5000)                  # idle: proceeds too
    assert "RC=0" in out
    assert bash(f"ORWELL_RUN_DIR='{run}'; update_run_seq_read").stdout != after


@needs_bash
def test_deferred_run_still_runs_when_nothing_else_went_ahead(tmp_path):
    out = loop(tmp_path, idle=30, on_sleep='[[ $T -ge 1000180 ]] && IDLE=2000 || true')
    assert "RC=0 RESTARTS_WOULD_RUN=yes" in out


# ── updater wiring ──────────────────────────────────────────────────────────
def test_updater_exits_zero_when_superseded_and_when_already_at_ref():
    # ORW-406: a superseded run no longer exits blindly; the under-lock check decides (see test_orw406_review_followups)
    blk = re.search(r'if \[\[ \$__ud_rc -eq 10 \]\]; then(?P<body>(?:(?!\n  fi).)*)\n  fi', UPDATE, re.S)
    assert blk, "the superseded-run block is gone"
    code = "\n".join(l for l in blk.group("body").splitlines() if not l.strip().startswith("#"))
    assert "__ud_rc=0" in code and "exit" not in code, "a superseded run must reset __ud_rc=0 and fall through to the under-lock check, never exit blindly (review of #2702)"
    m = re.search(r'^if \[\[ "\$\{__UD_WAITED:-0\}" == 1.*?\n(.*?)\nfi\n', UPDATE, re.S | re.M)
    assert m and "fetch_target" in m.group(1) and "exit 0" in m.group(1)
    # the already-at-ref check sits before the update is armed / anything is touched
    assert UPDATE.index("__UD_WAITED:-0") < UPDATE.index("snapshot_running_dist\nUPDATE_ARMED=1")


@needs_bash
def test_invocation_is_logged_with_who_and_how(tmp_path):
    fn = re.search(r'^ops_log_invocation\(\) \{.*?^\}\n', UPDATE, re.S | re.M).group(0)
    app = tmp_path / "app"
    (app / "data").mkdir(parents=True)
    r = subprocess.run(["bash", "-c", f"{fn}\nAPP_DIR='{app}' FORCE=1 ROLLBACK=0 SET_TOKEN=0 NO_RESTART=0 REF='abc1234'; ops_log_invocation --force"],
                       capture_output=True, text=True, env={**os.environ, "SSH_CONNECTION": "10.0.0.5 51000 10.0.0.9 22"})
    assert r.returncode == 0, r.stderr
    line = (app / "data" / "ops-update.log").read_text()
    assert "user=" in line and "ssh=10.0.0.5 51000 10.0.0.9 22" in line and "argv=[--force]" in line and "force=1" in line
    uid, pid = subprocess.run(["id", "-u"], capture_output=True, text=True).stdout.strip(), None
    assert f"uid={uid} " in line and "ref=abc1234 " in line and re.search(r" pid=\d+ ==", line), line  # review of #2689: uid, ref and pid are logged too


def test_ops_update_header_is_not_hardcoded_web_triggered():
    svc = (DEPLOY / "systemd" / "orwell-ops-update.service").read_text()
    assert "(web-triggered)" not in svc
    assert "orwell-ops-update.service" in svc.split("ExecStart=")[1]


@needs_bash
def test_journald_restarted_only_when_dropin_changed():
    m = re.search(r'  JOURNALD_DROPIN=.*?\n  fi\n', UPDATE, re.S)
    assert m, "journald drop-in block not found"
    assert sum(1 for l in UPDATE.splitlines() if l.strip().startswith("systemctl restart systemd-journald")) == 1
    assert "!= \"$JOURNALD_DROPIN\"" in m.group(0)
    # behaviour: run the block against a temp dir with a fake systemctl
    def run(tmp, existing):
        d = tmp / "j"
        d.mkdir(exist_ok=True)
        f = d / "orwell.conf"
        if existing is not None:
            f.write_text(existing)
        log = tmp / "calls"
        block = m.group(0).replace("/etc/systemd/journald.conf.d/orwell.conf", str(f))
        script = f"systemctl() {{ echo \"$*\" >> '{log}'; }}\nORWELL_JOURNAL_CAP=300M\n{block}"
        subprocess.run(["bash", "-c", script], check=True)
        return log.read_text() if log.exists() else ""
    import tempfile
    with tempfile.TemporaryDirectory() as t:
        t = Path(t)
        assert "restart systemd-journald" in run(t, None)               # first write -> restart
        (t / "calls").unlink()
        assert run(t, (t / "j" / "orwell.conf").read_text()) == ""      # unchanged -> no restart
        assert "restart systemd-journald" in run(t, "stale\n")          # changed -> restart


# ── review of #2702: a superseded deferred run waits for the lock instead of exiting 75 ──

def _lock_fn_script(tmp_path, superseded, wait_s, waited=0):
    body = re.search(r"^acquire_update_lock\(\) \{.*?^\}\n", UPDATE, re.S | re.M).group(0)
    return textwrap.dedent(f"""
        set -u
        APP_DIR='{tmp_path}'
        UPDATE_LOCK='{tmp_path}/u.lock'
        __UD_WAITED={waited}
        __UD_SUPERSEDED={superseded}
        export ORWELL_UPDATE_LOCK_WAIT={wait_s}
        unset ORWELL_UPDATE_LOCK_FD
        {body}
        acquire_update_lock
        echo ACQUIRED
    """)


def _hold_lock(tmp_path, secs):
    p = subprocess.Popen(["bash", "-c", f"exec 9>>'{tmp_path}/u.lock'; flock -n 9 && echo held && exec sleep {secs}"],
                         stdout=subprocess.PIPE, text=True)
    assert p.stdout.readline().strip() == "held"
    return p


@needs_flock
def test_a_normal_run_refuses_a_held_lock_with_75(tmp_path):
    holder = _hold_lock(tmp_path, 5)
    try:
        r = subprocess.run(["bash", "-c", _lock_fn_script(tmp_path, 0, 20)], capture_output=True, text=True, timeout=30)
        assert r.returncode == 75 and "ACQUIRED" not in r.stdout
    finally:
        holder.kill()


@needs_flock
def test_a_superseded_deferred_run_waits_for_the_lock_then_runs(tmp_path):
    holder = _hold_lock(tmp_path, 2)
    try:
        r = subprocess.run(["bash", "-c", _lock_fn_script(tmp_path, 1, 20)], capture_output=True, text=True, timeout=30)
        assert r.returncode == 0 and "ACQUIRED" in r.stdout, (r.stdout, r.stderr)
    finally:
        holder.kill()


@needs_flock
def test_a_superseded_deferred_run_gives_up_after_the_bounded_wait(tmp_path):
    holder = _hold_lock(tmp_path, 10)
    try:
        r = subprocess.run(["bash", "-c", _lock_fn_script(tmp_path, 1, 1)], capture_output=True, text=True, timeout=30)
        assert r.returncode == 75
    finally:
        holder.kill()


@needs_bash
def test_only_a_run_that_really_deferred_is_marked_as_waited(tmp_path):
    # review of #2689: --force / an idle game / no signal must keep the full update, so they must not set the flag the under-lock "already done" check reads.
    flag = LOOP.replace('echo "RC=$rc', 'echo "DEFERRED=$UPDATE_WAIT_DEFERRED RC=$rc')
    def run(idle, force, on_sleep=":"):
        ops = tmp_path / "ops"; ops.mkdir(exist_ok=True)
        env = {"ORWELL_UPDATE_ROOT_CONF": str(tmp_path / "none.conf")}
        return bash(flag.format(run=tmp_path / "run", on_sleep=on_sleep, idle=idle, ops=ops, force=force), env).stdout
    assert "DEFERRED=0 RC=0" in run(idle=5000, force=0)
    assert "DEFERRED=0 RC=0" in run(idle=30, force=1)
    assert "DEFERRED=1 RC=0" in run(idle=30, force=0, on_sleep='[[ $T -ge 1000180 ]] && IDLE=2000 || true')


@needs_flock
def test_a_normal_or_merely_waited_run_refuses_a_held_lock_at_once(tmp_path):
    # reviewer of #2746: __UD_WAITED is set on every run that passed the idle guard; only a SUPERSEDED run may wait for the lock.
    holder = _hold_lock(tmp_path, 15)
    try:
        import time
        for waited in (0, 1):
            t0 = time.time()
            r = subprocess.run(["bash", "-c", _lock_fn_script(tmp_path, 0, 30, waited=waited)], capture_output=True, text=True, timeout=30)
            assert r.returncode == 75 and "ACQUIRED" not in r.stdout, (waited, r.stdout, r.stderr)
            assert time.time() - t0 < 5, "a plain concurrent run must refuse immediately, not wait"
    finally:
        holder.kill()


def test_only_the_superseded_path_sets_the_lock_wait_flag():
    assert len(re.findall(r"__UD_SUPERSEDED=1(?=\n)", UPDATE)) == 1 and "__ud_rc=0; __ud_superseded=1; __UD_SUPERSEDED=1" in UPDATE


@needs_bash
def test_superseded_waiter_removes_the_status_it_wrote_after_the_clear(tmp_path):
    # The run that went ahead cleared the status, then THIS waiter wrote its own, then the token changed: nothing may be left saying "deferred".
    out = loop(tmp_path, idle=30, on_sleep="update_run_supersede")
    assert "RC=10" in out
    assert not (tmp_path / "run" / "update-deferred").exists()


@needs_bash
def test_superseded_waiter_keeps_a_newer_waiters_status(tmp_path):
    status = tmp_path / "run" / "update-deferred"
    out = loop(tmp_path, idle=30, on_sleep=f"printf 'deferred=true\\nrun_seq=newer-waiter\\n' > '{status}'; update_run_supersede")
    assert "RC=10" in out
    assert "run_seq=newer-waiter" in status.read_text()
