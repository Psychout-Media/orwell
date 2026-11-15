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


def test_updater_waits_on_the_directory_the_front_end_publishes_to():
    # review of #2686: frontend/src/turn_inflight.py publishes to ORWELL_INFLIGHT_DIR (else its data dir); the updater must watch the same file.
    # review of #2749: match the assignment and the call argument themselves, not a word that also sits in a comment
    # ORW-437 (#2766): the directory is read through `__envval`: ORWELL_INFLIGHT_DIR first, ORWELL_DATA_DIR_FE only when that is empty. The behaviour
    # (order, spaces, quotes, env vs .env) is proven by test_updater_watches_the_directory_the_front_end_publishes_to in test_orw406_force_keeps_turn_wait.py.
    first = re.search(r'^\s*INFLIGHT_DIR="\$\(__envval ORWELL_INFLIGHT_DIR\)"$', UPDATE, re.M)
    second = re.search(r'^\s*\[\[ -n "\$INFLIGHT_DIR" \]\] \|\| INFLIGHT_DIR="\$\(__envval ORWELL_DATA_DIR_FE\)"$', UPDATE, re.M)
    call = re.search(r'^\s*update_wait_for_no_turn "\$\{INFLIGHT_DIR:-[^"]*\}/turns-in-flight" "\$FORCE_NOW"', UPDATE, re.M)
    assert first and second and call and first.start() < second.start() < call.start()


def test_update_plus_reset_waits_for_warm_after_the_reset_owns_the_final_restart():
    # review of #2720: the updater skips its warm wait under --no-restart, so the script that does the final restart must run it.
    reset = (ROOT / "deploy" / "orwell-oobe-reset.sh").read_text()
    assert "orwell-live-game.sh" in reset and "update_wait_for_warm" in reset
    assert reset.index('do_svc start "$svc"') < reset.index("update_wait_for_warm \"http")


def test_wait_loops_are_bounded_and_quiet_and_the_reset_records_the_marker():
    live = (ROOT / "deploy" / "orwell-live-game.sh").read_text()
    reset = (ROOT / "deploy" / "orwell-oobe-reset.sh").read_text()
    # review of #2686: one line per 30 s and no sleep past the bound; #2720: probes capped by the remaining budget, no duplicate log append; #2702: the reset records HEAD.
    assert "last_say" in live and "never sleep past the bound" in live
    assert '--max-time "${2:-3}"' in live and "_warm_left" in live
    assert '>>"$log"' not in live[live.index("update_wait_for_warm()"):live.index("update_wait_for_warm()") + 2500]
    assert "update_restarted_sha_write" in reset


def test_wait_for_no_turn_sleeps_no_longer_than_what_is_left():
    import subprocess
    script = f"""set -u; . '{ROOT}/deploy/orwell-live-game.sh'
T=100; slept=''
_update_defer_now() {{ echo $T; }}
_update_defer_sleep() {{ slept="$slept $1"; T=$((T + $1)); }}
update_turn_in_flight() {{ return 0; }}
ORWELL_UPDATE_TURN_WAIT_SECONDS=3
update_wait_for_no_turn /x >/dev/null; echo "SLEPT:$slept" """
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=20).stdout
    assert "SLEPT: 2 1" in out, out   # 2 s, then only the 1 s that is left of the 3 s bound
