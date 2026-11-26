"""ORW-1016 - the pure parts of scripts/perf_load.py (time to interactive, the guard). No browser, no model."""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("perf_load", os.path.join(os.path.dirname(HERE), "scripts", "perf_load.py"))
pl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pl)


def test_tti_is_fcp_when_the_page_is_quiet_from_the_start():
    assert pl.compute_tti(800.0, [], [(0.0, 300.0)], 12000.0) == 800.0


def test_tti_is_the_end_of_the_last_long_task_before_a_quiet_window():
    # long tasks end at 1500 and 3000; quiet from 3000 on
    assert pl.compute_tti(800.0, [(1000.0, 500.0), (2500.0, 500.0)], [(0.0, 400.0)], 12000.0) == 3000.0


def test_tti_waits_for_the_network_to_calm_down():
    flood = [(900.0, 4000.0)] * 3  # three requests in flight until 4000
    assert pl.compute_tti(800.0, [], flood, 15000.0) == 800.0
    assert pl.compute_tti(800.0, [(3900.0, 100.0)], flood, 15000.0) == 4000.0


def test_tti_of_a_page_that_never_settles_is_the_end_of_observation():
    busy = [(t, 80.0) for t in range(1000, 11000, 1000)]
    assert pl.compute_tti(800.0, [(float(s), d) for s, d in busy], [], 11000.0) == 11000.0


def test_guard_flags_only_what_exceeds_a_ceiling():
    ok = {"viewports": {"4k": {"cold_load_event_ms": 1000, "worst_interaction_ms": 40}}}
    assert pl.ceiling_violations(ok) == []
    bad = {"viewports": {"4k": {"cold_load_event_ms": pl.CEILINGS["cold_load_event_ms"] + 1}}}
    assert len(pl.ceiling_violations(bad)) == 1
