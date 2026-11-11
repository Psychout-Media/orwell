"""ORW-134: ci/prune-orwell-runs.sh is a DRY RUN unless --apply AND the explicit confirmation env are both given; it keeps the newest N, recent, .keep and in-use dirs; it has a kill switch. Runs against a temp tree; deletes nothing real."""
import os
import subprocess
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "ci" / "prune-orwell-runs.sh"


def _tree(tmp_path):
    root = tmp_path / "runs"
    root.mkdir()
    now = time.time()
    for name, age_h in (("newest", 1), ("old-a", 100), ("old-b", 120), ("old-keep", 130), ("recent", 2), ("oldest", 200)):
        d = root / name
        d.mkdir()
        (d / "f").write_text("x")
        os.utime(d, (now - age_h * 3600, now - age_h * 3600))
    (root / "old-keep" / ".keep").write_text("")
    os.utime(root / "old-keep", (now - 130 * 3600, now - 130 * 3600))
    return root


def _run(root, *args, env=None):
    e = dict(os.environ, ORWELL_RUNS_ROOT=str(root), ORWELL_PRUNE_KEEP_NEWEST="2", ORWELL_PRUNE_MIN_AGE_HOURS="48")
    e.update(env or {})
    return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env=e)


def test_default_is_a_dry_run_that_lists_but_deletes_nothing(tmp_path):
    root = _tree(tmp_path)
    r = _run(root)
    assert r.returncode == 0 and "DRY-RUN" in r.stdout
    listed = [l for l in r.stdout.splitlines() if l.startswith("would-rm")]
    # newest two by mtime (newest, recent) are kept; old-keep has .keep; the rest are candidates
    assert sorted(Path(l.split()[-1]).name for l in listed) == ["old-a", "old-b", "oldest"]
    assert all((root / n).exists() for n in ("newest", "old-a", "old-b", "old-keep", "recent", "oldest"))


def test_apply_without_the_confirmation_is_refused(tmp_path):
    root = _tree(tmp_path)
    r = _run(root, "--apply")
    assert r.returncode == 3 and "refusing" in r.stderr
    assert (root / "old-a").exists()


def test_apply_with_the_confirmation_removes_only_the_candidates(tmp_path):
    root = _tree(tmp_path)
    r = _run(root, "--apply", env={"ORWELL_PRUNE_CONFIRM": "yes-ryne-approved"})
    assert r.returncode == 0 and "APPLY" in r.stdout
    assert not any((root / n).exists() for n in ("old-a", "old-b", "oldest"))
    assert all((root / n).exists() for n in ("newest", "recent", "old-keep"))


def test_the_kill_switch_stops_it_even_with_the_confirmation(tmp_path):
    root = _tree(tmp_path)
    (root / ".prune-disabled").write_text("")
    r = _run(root, "--apply", env={"ORWELL_PRUNE_CONFIRM": "yes-ryne-approved"})
    assert r.returncode == 0 and "kill switch" in r.stdout
    assert (root / "old-a").exists()


def test_a_dir_that_is_a_live_processes_cwd_is_never_a_candidate(tmp_path):
    root = _tree(tmp_path)
    p = subprocess.Popen(["sleep", "30"], cwd=root / "old-a")
    try:
        r = _run(root, "--apply", env={"ORWELL_PRUNE_CONFIRM": "yes-ryne-approved"})
        assert (root / "old-a").exists() and r.returncode == 0
    finally:
        p.kill()
