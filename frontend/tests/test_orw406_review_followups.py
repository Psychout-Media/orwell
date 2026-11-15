"""ORW-406 review follow-ups: restart scope from what is RUNNING, static restarts the front end, a failed
superseding run does not drop the update."""
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "deploy" / "orwell-live-game.sh"
UPDATE = (ROOT / "deploy" / "orwell-update.sh").read_text()
needs_bash = pytest.mark.skipif(shutil.which("bash") is None or shutil.which("git") is None, reason="bash+git")


def sh(script, cwd=None, env=None):
    full = dict(os.environ)
    full.update(env or {})
    r = subprocess.run(["bash", "-c", f"set -euo pipefail; . '{LIB}'; {script}"], capture_output=True,
                       text=True, timeout=60, env=full, cwd=cwd)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def git(repo, *a):
    return subprocess.run(["git", "-C", str(repo), "-c", "user.email=t@t", "-c", "user.name=t", *a],
                          capture_output=True, text=True, check=True).stdout.strip()


def commit(repo, path, text="x", msg="c"):
    f = repo / path
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", msg)
    return git(repo, "rev-parse", "HEAD")


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    r.mkdir()
    git(r, "init", "-q", "-b", "main")
    return r


def scope(repo, tmp_path, marker):
    run = tmp_path / "run"
    run.mkdir(exist_ok=True)
    mf = run / "restarted-sha"
    if marker is None:
        mf.unlink(missing_ok=True)
    else:
        mf.write_text(marker + "\n")
    return sh(f"update_scope_since_restart '{repo}'", env={"ORWELL_RUN_DIR": str(run)})


@needs_bash
def test_scope_comes_from_the_restart_marker_not_the_last_checkout(repo, tmp_path):
    c1 = commit(repo, "README.md")
    c2 = commit(repo, "src/engine.ts")            # run 1 commits new engine code, then dies before restarting
    commit(repo, "frontend/routes/x.py")          # run 2's own diff (c2..HEAD) is front-end only
    assert scope(repo, tmp_path, c1) == "both"    # services still run c1: the engine must restart
    assert scope(repo, tmp_path, c2) == "frontend"


@needs_bash
def test_scope_is_both_when_marker_missing_garbage_unknown_or_not_an_ancestor(repo, tmp_path):
    base = commit(repo, "README.md")
    side = None
    git(repo, "checkout", "-q", "-b", "side")
    side = commit(repo, "frontend/a.py")
    git(repo, "checkout", "-q", "main")
    commit(repo, "frontend/b.py")
    assert scope(repo, tmp_path, None) == "both"
    assert scope(repo, tmp_path, "not-a-sha") == "both"
    assert scope(repo, tmp_path, "0" * 40) == "both"
    assert scope(repo, tmp_path, side) == "both"          # not an ancestor of HEAD
    assert scope(repo, tmp_path, base) == "frontend"


@needs_bash
def test_diff_uses_no_renames(repo, tmp_path):
    base = commit(repo, "src/a.ts", "content that is long enough to be detected as a rename\n" * 5)
    (repo / "frontend").mkdir()
    git(repo, "mv", "src/a.ts", "frontend/a.ts")
    git(repo, "commit", "-qm", "mv")
    assert scope(repo, tmp_path, base) == "both"           # the deleted src/ path counts


@needs_bash
def test_static_only_change_restarts_the_front_end(repo, tmp_path):
    base = commit(repo, "README.md")
    commit(repo, "frontend/static/js/theme.js")
    assert scope(repo, tmp_path, base) == "frontend"


@needs_bash
def test_marker_roundtrip(tmp_path):
    run = tmp_path / "run"
    out = sh(f"update_restarted_sha_write {'a' * 40}; update_restarted_sha_read; echo; update_restarted_sha_clear; "
             f"update_restarted_sha_read", env={"ORWELL_RUN_DIR": str(run)})
    assert out == "a" * 40


def test_updater_wiring():
    # marker written after a successful restart (and after rollback), scope computed from it, no 'none' branch
    i = UPDATE.index("RESTART_SCOPE=both")
    blk = UPDATE[i:UPDATE.index("update complete (")]
    assert "update_scope_since_restart" in blk and "--name-only" not in blk
    assert blk.index("systemctl restart") < blk.index("update_restarted_sha_write")
    assert "== none" not in blk
    rb = UPDATE[UPDATE.index("play_follow_rollback || true"):UPDATE.index("rollback complete (now")]
    assert "update_restarted_sha_write" in rb


def test_deferred_run_is_superseded_only_if_the_restart_marker_equals_head():
    # rc 10 (the token changed) must not exit by itself: the failed superseding run may have reverted.
    m = re.search(r'if \[\[ \$__ud_rc -eq 10 \]\]; then(.*?)\n  fi', UPDATE, re.S)
    assert m and "exit 0" not in m.group(1)
    chk = re.search(r'^if \[\[ "\$\{__UD_WAITED:-0\}" == 1.*?\nfi\n', UPDATE, re.S | re.M).group(0)
    assert "update_restarted_sha_read" in chk and "exit 0" in chk
