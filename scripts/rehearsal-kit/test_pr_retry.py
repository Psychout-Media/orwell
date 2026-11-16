"""pr.sh must not retry a turn whose failed attempt already moved the engine (ORW-506)."""
import os, shutil, stat, subprocess, pathlib

KIT = pathlib.Path(__file__).parent


def _run(tmp_path, status_after):
    d = tmp_path / "run"; d.mkdir()
    shutil.copy(KIT / "pr.sh", d / "pr.sh"); shutil.copy(KIT / "slot.sh", d / "slot.sh")
    (tmp_path / "ptr").write_text(str(d))
    (d / "slot.env").write_text(f"RIG_RUN_PTR={tmp_path/'ptr'}\nRIG_BASE=http://x\nRIG_SLOT=1\n")
    (d / "p.sh").write_text('#!/bin/bash\necho "$1" >> %s/calls\necho "technical interlude"\n' % tmp_path)
    bin_ = tmp_path / "bin"; bin_.mkdir()
    (bin_ / "curl").write_text('#!/bin/bash\nn=$(cat %s/n 2>/dev/null || echo 0); echo $((n+1)) > %s/n\nif [ $n -eq 0 ]; then echo S0; else echo %s; fi\n' % (tmp_path, tmp_path, status_after))
    for f in (d / "p.sh", bin_ / "curl"): f.chmod(f.stat().st_mode | stat.S_IEXEC)
    env = dict(os.environ, PATH=f"{bin_}:{os.environ['PATH']}", PR_RETRY_SLEEP="0")
    r = subprocess.run(["bash", str(d / "pr.sh"), "5", "hi"], capture_output=True, text=True, env=env)
    calls = (tmp_path / "calls").read_text().split()
    return r, calls


def test_no_retry_when_the_failed_attempt_moved_the_engine(tmp_path):
    r, calls = _run(tmp_path, "MOVED")
    assert r.returncode == 3 and calls == ["51"]


def test_retries_when_engine_state_is_unchanged(tmp_path):
    r, calls = _run(tmp_path, "S0")
    assert len(calls) == 4 and r.returncode == 1
