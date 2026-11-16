"""the suite's run folder is removed on exit and on SIGTERM, can be kept for debugging, and stale ones a killed run left behind are swept under guards
(same owner, `orwell-run-` prefix, older than 20 minutes, a real directory, not in use, not this run's own). Roles only."""
import os
import subprocess
import sys
import time

import _run_tmp as rt

HERE = os.path.dirname(os.path.abspath(__file__))
OLD = time.time() - 3600


def _mk(base, name, age_s=None, payload=True):
    p = base / name
    p.mkdir()
    if payload:
        (p / "save.json").write_text("x" * 100)
    if age_s is not None:
        os.utime(p, (time.time() - age_s, time.time() - age_s))
    return p


def test_a_stale_folder_of_this_user_is_swept_and_everything_else_is_left(tmp_path):
    stale = _mk(tmp_path, "orwell-run-aaaa", age_s=3600)
    fresh = _mk(tmp_path, "orwell-run-bbbb", age_s=60)
    other_prefix = _mk(tmp_path, "something-else", age_s=3600)
    mine = _mk(tmp_path, "orwell-run-cccc", age_s=3600)
    busy = _mk(tmp_path, "orwell-run-dddd", age_s=3600)
    got = rt.sweep_stale(str(tmp_path), keep=str(mine), in_use=lambda p: p.endswith("orwell-run-dddd"))
    assert got == [str(stale)] and not stale.exists()
    assert fresh.exists() and other_prefix.exists() and mine.exists() and busy.exists()


def test_a_folder_of_another_owner_is_never_swept(tmp_path):
    p = _mk(tmp_path, "orwell-run-eeee", age_s=3600)
    assert rt.sweep_stale(str(tmp_path), uid=os.getuid() + 1) == [] and p.exists()


def test_a_symlink_is_never_followed_or_removed(tmp_path):
    victim = tmp_path / "victim"
    victim.mkdir()
    (victim / "keep.txt").write_text("precious")
    base = tmp_path / "base"
    base.mkdir()
    link = base / "orwell-run-ffff"
    link.symlink_to(victim)
    os.utime(victim, (OLD, OLD))
    assert rt.sweep_stale(str(base)) == []
    assert link.is_symlink() and (victim / "keep.txt").read_text() == "precious"
    # a stale folder that CONTAINS a symlink: the link goes, its target stays
    stale = _mk(base, "orwell-run-gggg", age_s=3600)
    (stale / "inner").symlink_to(victim)
    os.utime(stale, (OLD, OLD))
    assert rt.sweep_stale(str(base)) == [str(stale)]
    assert (victim / "keep.txt").read_text() == "precious"


def test_a_folder_a_live_process_uses_is_not_swept(tmp_path):
    p = _mk(tmp_path, "orwell-run-hhhh", age_s=3600)
    env = {**os.environ, "TMPDIR": str(p)}
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"], env=env, cwd="/")
    try:
        time.sleep(0.3)
        assert rt.sweep_stale(str(tmp_path)) == [] and p.exists(), "its TMPDIR is a live process's"
    finally:
        child.kill()
        child.wait()
    assert rt.sweep_stale(str(tmp_path)) == [str(p)], "once the process is gone it is stale"


def test_the_run_folder_is_removed_unless_kept_for_debugging(tmp_path):
    a = _mk(tmp_path, "orwell-run-iiii")
    assert rt.remove_run_folder(str(a), env={}) is True and not a.exists()
    b = _mk(tmp_path, "orwell-run-jjjj")
    assert rt.remove_run_folder(str(b), env={rt.KEEP_ENV: "1"}) is False and b.exists()


def _run_and_term(tmp_path, install):
    folder = tmp_path / "orwell-run-kkkk"
    code = f"""
import os, signal, sys
sys.path.insert(0, {HERE!r})
import _run_tmp as rt
os.makedirs({str(folder)!r}); open({str(folder / 'big')!r}, 'w').write('x')
{'rt.install_sigterm_cleanup(' + repr(str(folder)) + ')' if install else ''}
os.kill(os.getpid(), signal.SIGTERM)
import time; time.sleep(5)
"""
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=30)
    return r.returncode, folder


def test_a_sigterm_removes_the_folder_and_still_ends_the_process(tmp_path):
    rc, folder = _run_and_term(tmp_path, install=True)
    assert rc == -15 and not folder.exists(), (rc, folder.exists())   # died of SIGTERM, as before, with the folder gone


def test_without_the_handler_a_sigterm_strands_the_folder(tmp_path):
    rc, folder = _run_and_term(tmp_path, install=False)
    assert rc == -15 and folder.exists(), "the control: this is the leak the handler closes"


def test_the_conftest_wires_all_of_it_in_the_controller_only():
    src = open(os.path.join(HERE, "conftest.py"), encoding="utf-8").read()
    assert "_run_tmp.remove_run_folder" in src and "_run_tmp.install_sigterm_cleanup(_RUN_TMP)" in src
    i = src.index('if not os.environ.get("PYTEST_XDIST_WORKER")')
    assert "sweep_stale" in src[i:i + 300], "workers never sweep"


def test_a_live_runs_heartbeat_keeps_its_folder_fresh(tmp_path):
    p = _mk(tmp_path, "orwell-run-llll", age_s=3600)
    rt.start_heartbeat(str(p), every_s=0.1)
    time.sleep(0.6)
    assert time.time() - os.stat(p).st_mtime < 30, "the folder's mtime was refreshed by the heartbeat"
    assert rt.sweep_stale(str(tmp_path), in_use=lambda _p: False) == []
