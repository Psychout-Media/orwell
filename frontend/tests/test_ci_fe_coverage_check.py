"""ORW-218: the front-end coverage floor checker (ci/check-fe-coverage.py)."""
import importlib.util
import json
import os
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SCRIPT = os.path.join(ROOT, "ci", "check-fe-coverage.py")
spec = importlib.util.spec_from_file_location("check_fe_coverage", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def report(src=(80, 100, 40, 50), routes=(10, 10, 0, 0)):
    def f(t):
        return {"summary": {"covered_lines": t[0], "num_statements": t[1], "covered_branches": t[2], "num_branches": t[3]}}
    return {"files": {"src/a.py": f(src), "routes/b.py": f(routes), "app.py": f((1, 1, 0, 0))}}


FLOORS = {"src": {"line": 80, "branch": 80}, "routes": {"line": 100}}


def test_at_floor_passes():
    fails, hints, _ = mod.check(report(), FLOORS)
    assert fails == [] and hints == []


def test_below_floor_fails():
    fails, _, _ = mod.check(report(src=(79, 100, 40, 50)), FLOORS)
    assert len(fails) == 1 and "src: line" in fails[0]
    fails, _, _ = mod.check(report(src=(80, 100, 39, 50)), FLOORS)
    assert len(fails) == 1 and "src: branch" in fails[0]


def test_two_points_above_prints_ratchet_hint_but_passes():
    fails, hints, _ = mod.check(report(src=(90, 100, 40, 50)), FLOORS)
    assert fails == [] and hints == ["ratchet up: raise src line floor to 89 (measured 90.00%, floor 80.00%)"]


def test_missing_directory_fails():
    fails, _, _ = mod.check(report(), {"gateway": {"line": 10}})
    assert len(fails) == 1 and "gateway: not in the coverage measurement" in fails[0]


def test_root_and_total_groups():
    g = mod.group(report())
    assert g["(root)"]["covered_lines"] == 1 and g["TOTAL"]["num_statements"] == 111


def test_cli_exit_codes(tmp_path):
    r, fl = tmp_path / "r.json", tmp_path / "f.json"
    r.write_text(json.dumps(report()))
    fl.write_text(json.dumps(FLOORS))
    run = lambda: subprocess.run([sys.executable, SCRIPT, str(r), str(fl)], capture_output=True, text=True)
    assert run().returncode == 0
    fl.write_text(json.dumps({"src": {"line": 95}}))
    assert run().returncode == 1


def test_committed_floor_file_is_well_formed():
    with open(os.path.join(ROOT, "frontend", "coverage_floor.json"), encoding="utf-8") as fh:
        floors = json.load(fh)
    assert "TOTAL" in floors
    for k, v in floors.items():
        if not k.startswith("_"):
            assert set(v) <= {"line", "branch"} and all(0 <= x <= 100 for x in v.values())
