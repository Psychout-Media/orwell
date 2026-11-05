"""A41: the pure skip-guard evaluator (the conftest hook wires it; the end-to-end behavior is exercised by the lane run). Roles only."""
import importlib

g = importlib.import_module("_skip_guard")


def test_a_clean_run_passes():
    assert g.evaluate([], lane="browser", ceiling=0, browser_ids=["t::a"]) == []


def test_a_browser_test_that_skips_in_the_browser_lane_is_a_violation():
    v = g.evaluate([("t::a", "chromium unavailable")], lane="browser", ceiling=5, browser_ids=["t::a"])
    assert len(v) == 1 and "MUST-RUN" in v[0] and "t::a" in v[0]


def test_a_browser_skip_in_the_unit_lane_is_not_a_must_run_violation():
    assert g.evaluate([("t::a", "x")], lane="unit", ceiling=5, browser_ids=["t::a"]) == []


def test_exceeding_the_ceiling_is_a_violation_and_meeting_it_is_not():
    two = [("t::a", "r"), ("t::b", "r")]
    assert g.evaluate(two, lane="unit", ceiling=2, browser_ids=[]) == []
    v = g.evaluate(two, lane="unit", ceiling=1, browser_ids=[])
    assert len(v) == 1 and "exceeds the recorded ceiling" in v[0]


def test_no_recorded_ceiling_means_only_the_must_run_rule_applies():
    assert g.evaluate([("t::a", "r")] * 50, lane="unit", ceiling=None, browser_ids=[]) == []
