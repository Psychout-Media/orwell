"""ORW-189-lite: the report-only perf harness (scripts/perf_report.py) - the parts that need no browser."""
import importlib.util
import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location("perf_report", os.path.join(FRONTEND, "scripts", "perf_report.py"))
perf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(perf)

_RES = {
    "cpu_throttle": 4.0, "idle_seconds": 60,
    "load": {"requests": 1, "js_files": 1, "css_files": 1, "js_raw_bytes": 2048, "css_raw_bytes": 1024, "js_gzip_bytes": 512,
             "css_gzip_bytes": 256, "js_transferred_bytes": 2048, "css_transferred_bytes": 1024, "seconds_to_settle": 6.0},
    "idle": {"requests": 40, "requests_per_minute": 40.0, "max_burst_per_second": 3},
    "stream": {"settled": True, "reply_chars_scripted": 2033, "reply_chars_rendered": 2000, "deltas": 60, "window_seconds": 4.0,
               "long_tasks": 2, "long_task_total_ms": 150.0, "blocking_time_ms": 60.0, "long_task_max_ms": 90.0, "script_ms": 800.0,
               "layout_ms": 20.0, "style_recalc_ms": 10.0, "task_ms": 1000.0, "frames": 100, "frame_p50_ms": 16.7, "frame_p95_ms": 40.0,
               "frames_over_50ms": 1, "mutation_observer_callbacks": 5, "mutation_observer_records": 50},
}


def test_scripted_reply_is_about_2000_chars_in_sentence_deltas():
    d = perf.scripted_reply(2000)
    assert 2000 <= sum(map(len, d)) < 2100
    assert all(x.rstrip().endswith(".") for x in d)  # one sentence per delta (the game-build scrub buffers to sentences)
    assert any(x.endswith("\n\n") for x in d)  # paragraph breaks exist, so the block-freeze path is exercised


def test_table_and_markdown_render_every_measure():
    t = perf.render_table(_RES)
    for key in ("LOAD  JS", "IDLE  requests", "STREAM long tasks", "STREAM MutationObserver"):
        assert key in t
    md = perf.render_markdown(_RES)
    assert md.count("\n| ") >= 12 and "report-only" in md


def test_perf_job_gates_the_request_budgets_in_ci():
    """ORW-181: the request-count budgets are a real gate - pass 1 enforces, the job is a ci-gate need, and a dead harness fails too."""
    import yaml
    ci = yaml.safe_load(open(os.path.join(os.path.dirname(FRONTEND), ".github", "workflows", "ci.yml"), encoding="utf-8"))
    job = ci["jobs"]["fe-perf-report"]
    assert "fe_render" in job["if"]  # test-only / markdown edits do not spend a runner slot
    assert "continue-on-error" not in job
    steps = job["steps"]
    assert any(st.get("uses") == "./.github/actions/setup-playwright" for st in steps)
    perf = next(st for st in steps if st.get("name", "").startswith("perf report"))
    assert "continue-on-error" not in perf
    run = perf["run"]
    assert "PERF_LOW_POWER=0 python3 scripts/perf_report.py --enforce-budget" in run
    assert "--enforce-budget" not in run.split("PERF_LOW_POWER=1", 1)[1]  # the 10 s low-power pass stays report-only
    assert "exit 1" in run and "did not run" in run
    gate = ci["jobs"]["ci-gate"]
    assert "fe-perf-report" in gate["needs"]
    env = gate["steps"][0]["env"]["RESULTS"]
    assert "fe-perf-report=${{ needs.fe-perf-report.result }}" in env
    assert "fe-perf-report" in gate["steps"][0]["run"].split("applicable()")[1].split("esac")[0]


def test_budget_violations_flag_a_request_flood_and_pass_the_measured_baseline():
    ok = {"idle": {"requests_per_minute": 12.0, "max_burst_per_second": 2}, "load": {"requests": 176}}  # the measured baseline
    assert perf.budget_violations(ok) == []
    assert perf.budget_violations({"idle": {"requests_per_minute": 30.0, "max_burst_per_second": 6}, "load": {"requests": 230}}) == []  # the edge passes
    flood = {"idle": {"requests_per_minute": 47.0, "max_burst_per_second": 9}, "load": {"requests": 300}}  # prod: 660 state GETs in 14 min
    bad = perf.budget_violations(flood)
    assert len(bad) == 3 and any("requests/min" in b for b in bad) and any("burst" in b for b in bad) and any("settle" in b for b in bad)
    assert perf.budget_violations({}) == []  # an absent measure is the harness's job to flag, not a budget breach


def test_private_test_symbols_the_harness_imports_still_exist():
    import sys
    sys.path.insert(0, os.path.join(FRONTEND, "tests"))
    import test_m0_3_midgen_join as m03
    import test_p0h_day1_clock_e2e as p0h
    for name in ("_stack", "STUB", "_post_form", "_post_json"):
        assert hasattr(m03, name), name
    assert hasattr(p0h, "_session")
    assert hasattr(m03.STUB, "script")
