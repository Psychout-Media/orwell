"""ORW-414: the CI browser lane runs `-n 2 --dist loadgroup`. Every browser file must carry an xdist_group named by the file (so its module-scoped stack boots once), except the
files deliberately spread over both workers (conftest._BROWSER_SPREAD_FILES). Collection only: no browser is started."""
import os
import subprocess
import sys
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
SPREAD = "test_a58_golden_render_live_vs_reload.py"
OTHER = "test_orw359_names_open_cast_card_browser.py"
MARKED = "test_a69_day_label_real_loop.py"  # marked `browser` by its own pytestmark, with no sync_playwright in it (review of #2785)

PROBE = textwrap.dedent("""
    import sys, pytest
    class P:
        def pytest_collection_finish(self, session):
            for i in session.items:
                m = i.get_closest_marker("xdist_group")
                print("GROUP", i.fspath.basename, m.kwargs.get("name") if m else "-")
    sys.exit(pytest.main(["--collect-only", "-q", "-m", "browser", "-p", "no:cacheprovider", "%s", "%s", "%s"], plugins=[P()]))
""")


def test_browser_files_are_grouped_by_file_except_the_spread_files():
    code = PROBE % (os.path.join(HERE, SPREAD), os.path.join(HERE, OTHER), os.path.join(HERE, MARKED))
    r = subprocess.run([sys.executable, "-c", code], cwd=os.path.dirname(HERE), capture_output=True, text=True, timeout=120,
                       env={k: v for k, v in os.environ.items() if k != "ORWELL_CI_SHARD"})
    rows = [l.split() for l in r.stdout.splitlines() if l.startswith("GROUP ")]
    assert rows, r.stdout + r.stderr
    spread = [g for _, f, g in rows if f == SPREAD]
    other = [g for _, f, g in rows if f == OTHER]
    assert spread and all(g == "-" for g in spread), "the spread file must carry no group, so its cases spread over the workers"
    assert other and all(g == OTHER for g in other), "every other browser file is grouped by its own name (one stack boot per file)"
    marked = [g for _, f, g in rows if f == MARKED]
    assert marked and all(g == MARKED for g in marked), "a file marked browser by its own pytestmark is grouped too"
