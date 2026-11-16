"""ORW-506: offline tests for the card-aware / toast-synchronised driver (a21_sync_drive.py) and its spend-capped wrapper (a21-sync-run.sh). Nothing is started: the wrapper's
refusals all happen BEFORE a rig, a guard or a driver is touched. Run: python3 -m pytest scripts/rehearsal-kit/test_a21_sync.py"""
import os, subprocess, sys, tempfile
import pytest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import a21_sync_drive as drv  # noqa: E402  (playwright is imported only inside main())


def _home():
    d = tempfile.mkdtemp(prefix="rigtest-"); os.mkdir(os.path.join(d, "orwell")); return d


def _run(args, env):
    return subprocess.run(["bash", os.path.join(HERE, "a21-sync-run.sh"), *args], capture_output=True, text=True, timeout=30, env={**os.environ, "ORWELL_RIG_HOME": _home(), **env})


@pytest.mark.parametrize("cap", ["bogus", "inf", "0", "-1", "nan"])
def test_wrapper_refuses_a_bad_cap_before_anything(cap):
    r = _run(["x.txt"], {"RIG_SPEND_CAP": cap})
    assert r.returncode == 2 and "COULD-NOT-RUN" in r.stdout and "nothing was started" in r.stdout, (r.stdout, r.stderr)


def test_wrapper_refuses_a_missing_or_unparseable_script(tmp_path):
    r = _run([str(tmp_path / "none.txt")], {"RIG_SPEND_CAP": "1"})
    assert r.returncode == 2 and "no such script" in r.stdout
    bad = tmp_path / "bad.txt"; bad.write_text("hello\n@wait 5\n")
    r = _run([str(bad)], {"RIG_SPEND_CAP": "1"})
    assert r.returncode == 2 and "does not parse" in r.stdout


def test_wrapper_guards_by_pid_identity_and_never_pkills():
    s = open(os.path.join(HERE, "a21-sync-run.sh")).read()
    assert "pkill" not in s and "killall" not in s and "/proc/$pid/cmdline" in s


def test_the_spend_guard_knows_this_driver_by_name():
    assert "a21_sync_drive" in open(os.path.join(HERE, "spend_guard.py")).read()


def test_message_bound_is_clamped():
    assert drv.clamp_messages(60) == 60 and drv.clamp_messages(0) == 1 and drv.clamp_messages(10**9) == drv.MAX_MESSAGES_CEILING and drv.clamp_messages("x") == 60


def test_slot_value_prefers_the_runs_slot_env_and_refuses_a_disagreeing_variable(tmp_path, monkeypatch):
    (tmp_path / "slot.env").write_text("RIG_BASE=http://127.0.0.1:17001\n")
    monkeypatch.delenv("RIG_BASE", raising=False)
    assert drv.slot_value(str(tmp_path), "RIG_BASE", "d") == "http://127.0.0.1:17001"
    monkeypatch.setenv("RIG_BASE", "http://127.0.0.1:17000")
    with pytest.raises(SystemExit):
        drv.slot_value(str(tmp_path), "RIG_BASE", "d")
    monkeypatch.delenv("RIG_BASE"); assert drv.slot_value(str(tmp_path / "x"), "RIG_BASE", "d") == "d"


def test_rig_call_fails_soft_when_the_engine_is_down():
    assert drv.Rig("http://127.0.0.1:9", "t").entrance() is None
