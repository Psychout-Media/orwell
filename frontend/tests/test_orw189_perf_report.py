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


def test_perf_job_is_report_only_in_ci():
    ci = open(os.path.join(os.path.dirname(FRONTEND), ".github", "workflows", "ci.yml"), encoding="utf-8").read()
    job = ci.split("\n  fe-perf-report:\n", 1)[1].split("\n  fe-responsive:", 1)[0]
    assert "continue-on-error: true" in job
    gate = ci.split("\n  ci-gate:\n", 1)[1]
    assert "fe-perf-report" not in gate  # not a ci-gate need: never blocks a merge
