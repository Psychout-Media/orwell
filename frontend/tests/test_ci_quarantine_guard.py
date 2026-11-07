"""ORW-229 flaky-test rule (docs/CI.md): the quarantine guard.

Every `@pytest.mark.quarantine(card=..., added=...)` in the suite must name a Plane card and an added-on date, and no quarantine may be more than
7 days old. The first test reads the real suite; the rest pin the checker and prove (in a nested pytest) that a quarantined test is deselected,
not skipped, unless ORWELL_RUN_QUARANTINED=1."""
from __future__ import annotations

import datetime as dt
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from _ci_shard import nested_env
from _quarantine import MAX_AGE_DAYS, find_quarantines, problems, scan, split_quarantined

TESTS = Path(__file__).resolve().parent
TODAY = dt.date(2026, 11, 10)


def test_every_quarantine_names_a_plane_card_and_a_date_and_is_at_most_seven_days_old():
    today = dt.datetime.now(dt.timezone.utc).date()
    bad = [p for q in scan([TESTS], TESTS.parent) for p in problems(q, today)]
    assert not bad, "the quarantine rule (docs/CI.md) is broken:\n" + "\n".join(bad)


def _one(src: str):
    found = find_quarantines(textwrap.dedent(src), "tests/test_x.py")
    assert len(found) == 1, found
    return found[0]


@pytest.mark.parametrize("added", ["2026-11-10", "2026-11-03", "2026-11-11"])
def test_a_literal_quarantine_with_a_card_and_a_recent_date_passes(added):
    q = _one(f'''
        @pytest.mark.quarantine(card="ORW-123", added="{added}")
        def test_y(): pass
    ''')
    assert (q.card, q.added, q.target) == ("ORW-123", added, "test_y")
    assert problems(q, TODAY) == []


def test_finds_class_decorators_module_marks_and_param_marks():
    src = textwrap.dedent('''
        import pytest
        pytestmark = pytest.mark.quarantine(card="ORW-1", added="2026-11-09")
        @pytest.mark.quarantine(card="ORW-2", added="2026-11-09")
        class TestThing:
            def test_a(self): pass
        @pytest.mark.parametrize("v", [pytest.param(1, marks=pytest.mark.quarantine(card="ORW-3", added="2026-11-09")), 2])
        def test_b(v): pass
    ''')
    assert [(q.card, q.target) for q in find_quarantines(src, "t.py")] == [
        ("ORW-1", "<module or param>"), ("ORW-2", "TestThing"), ("ORW-3", "<module or param>")]


def test_an_expired_quarantine_fails_and_names_its_card():
    q = _one('@pytest.mark.quarantine(card="ORW-123", added="2026-11-02")\ndef test_y(): pass\n')
    assert MAX_AGE_DAYS == 7
    assert "quarantined 8 days ago (2026-11-02, ORW-123); the rule allows 7" in " ".join(problems(q, TODAY))


@pytest.mark.parametrize("card", ["", "#123", "orw-123", "ORW123", "ORW-"])
def test_a_missing_or_malformed_plane_card_fails(card):
    q = _one(f'@pytest.mark.quarantine(card="{card}", added="2026-11-09")\ndef test_y(): pass\n')
    assert "not a Plane card id" in " ".join(problems(q, TODAY))


@pytest.mark.parametrize("added", ["", "11/09/2026", "2026-13-01", "2026-02-30"])
def test_a_missing_or_malformed_date_fails(added):
    q = _one(f'@pytest.mark.quarantine(card="ORW-1", added="{added}")\ndef test_y(): pass\n')
    assert "is not a date" in " ".join(problems(q, TODAY))


def test_a_future_date_fails():
    q = _one('@pytest.mark.quarantine(card="ORW-1", added="2026-11-20")\ndef test_y(): pass\n')
    assert "in the future" in " ".join(problems(q, TODAY))


@pytest.mark.parametrize("src", [
    "@pytest.mark.quarantine\ndef test_y(): pass\n",
    '@pytest.mark.quarantine(card="ORW-1")\ndef test_y(): pass\n',
    '@pytest.mark.quarantine(card=CARD, added="2026-11-09")\ndef test_y(): pass\n',
])
def test_a_quarantine_without_literal_card_and_date_fails(src):
    assert "write it as @pytest.mark.quarantine(card=" in " ".join(problems(_one(src), TODAY))


def test_an_aliased_mark_is_still_read_with_its_card_and_date():
    # #2279 review (cubic P1): pytest deselects `@m.quarantine(...)` after `from pytest import mark as m`, so the guard must check it too.
    q = _one('''
        from pytest import mark as m
        @m.quarantine(card="ORW-7", added="2026-11-02")
        def test_y(): pass
    ''')
    assert (q.card, q.added, q.target) == ("ORW-7", "2026-11-02", "test_y")
    assert "quarantined 8 days ago" in " ".join(problems(q, TODAY))


def test_a_marker_kept_in_a_variable_fails_closed():
    # the guard cannot follow a variable to the call, so it reports the bare marker and asks for the literal form
    found = find_quarantines(textwrap.dedent('''
        import pytest
        q = pytest.mark.quarantine
        @q(card="ORW-7", added="2026-11-09")
        def test_y(): pass
    '''), "tests/test_x.py")
    assert found and all("write it as @pytest.mark.quarantine(card=" in " ".join(problems(f, TODAY)) for f in found)


class _Item:
    def __init__(self, name: str, parked: bool):
        self.name, self._parked = name, parked

    def get_closest_marker(self, name):
        return object() if (name == "quarantine" and self._parked) else None


def test_split_parks_quarantined_items_unless_the_nightly_run_asks_for_them():
    items = [_Item("a", False), _Item("b", True), _Item("c", False)]
    kept, parked = split_quarantined(items, run_quarantined=False)
    assert [i.name for i in kept] == ["a", "c"] and [i.name for i in parked] == ["b"]
    kept, parked = split_quarantined(items, run_quarantined=True)
    assert [i.name for i in kept] == ["a", "b", "c"] and parked == []


def _nested(tmp_path: Path, run_quarantined: bool) -> subprocess.CompletedProcess:
    test = tmp_path / "test_parked.py"
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    test.write_text(textwrap.dedent(f'''
        import pytest
        @pytest.mark.quarantine(card="ORW-1", added="{today}")
        def test_parked():
            print("PARKED-RAN")
        def test_steady():
            pass
    '''), encoding="utf-8")
    env = nested_env(os.environ)
    env.pop("ORWELL_RUN_QUARANTINED", None)
    env.pop("GITHUB_STEP_SUMMARY", None)
    if run_quarantined:
        env["ORWELL_RUN_QUARANTINED"] = "1"
    env["PYTHONPATH"] = os.pathsep.join([str(TESTS), env.get("PYTHONPATH", "")])
    return subprocess.run([sys.executable, "-m", "pytest", "-p", "_quarantine", "-p", "no:cacheprovider", "-q", "-s", "-rs", str(test)],
                          cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)


def test_a_quarantined_test_is_deselected_not_skipped_in_a_normal_run(tmp_path):
    r = _nested(tmp_path, run_quarantined=False)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "1 passed, 1 deselected" in r.stdout and "skipped" not in r.stdout
    assert "PARKED-RAN" not in r.stdout
    assert "1 quarantined test(s) deselected here; they run in the nightly workflow" in r.stdout
    assert "ORW-1: test_parked.py::test_parked" in r.stdout


def test_a_quarantined_test_runs_in_the_nightly_run(tmp_path):
    r = _nested(tmp_path, run_quarantined=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "2 passed" in r.stdout and "PARKED-RAN" in r.stdout
    assert "1 quarantined test(s) RAN in this run (nightly)" in r.stdout
