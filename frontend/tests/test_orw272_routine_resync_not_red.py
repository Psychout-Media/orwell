"""ORW-272: the two routine resync reasons ('run-started-empty', 'reconnect-run-gone') must not raise the RED health event; any other reason still does. Source-pinned on chatWsSplice.js (the function runs in a browser). No model."""
import re
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "static" / "js" / "chatWsSplice.js").read_text()


def test_routine_reasons_are_not_red_and_others_are():
    assert "const _routineResync = reason === 'run-started-empty' || reason === 'reconnect-run-gone';" in SRC
    call = re.search(r"OrwellReport\.fail\('ws:resync-heal'.*?\);", SRC, re.S).group(0)
    assert "red: !_routineResync" in call and "red: true" not in call


def test_the_reconnect_run_gone_site_still_reports_red_once():
    ws = (Path(__file__).resolve().parents[1] / "static" / "js" / "orwellWs.js").read_text()
    call = re.search(r"OrwellReport\.fail\('ws:reconnect-run-gone'.*?\);", ws, re.S).group(0)
    assert "red: true" in call
