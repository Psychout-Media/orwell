"""ORW-272: the two routine resync reasons ('run-started-empty', 'reconnect-run-gone') must not raise the RED health event; any other reason still does. Source-pinned on chatWsSplice.js (the function runs in a browser). No model."""
import re
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "static" / "js" / "chatWsSplice.js").read_text()


def test_routine_reasons_are_not_red_and_others_are():
    assert "const _routineResync = _benignEmpty || reason === 'reconnect-run-gone';" in SRC
    call = re.search(r"OrwellReport\.fail\('ws:resync-heal'.*?\);", SRC, re.S).group(0)
    assert "red: !_routineResync" in call and "red: true" not in call


def test_the_reconnect_run_gone_site_still_reports_red_once():
    ws = (Path(__file__).resolve().parents[1] / "static" / "js" / "orwellWs.js").read_text()
    call = re.search(r"OrwellReport\.fail\('ws:reconnect-run-gone'.*?\);", ws, re.S).group(0)
    assert "red: true" in call


# ── ORW-1023: behavioral, the REAL _onWsResync body run in Node ────────────────────────────────────────────

import json
import shutil
import subprocess

import pytest

_NODE = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const start = src.indexOf("export function _onWsResync");
const end = src.indexOf("\n}\n", start) + 3;
const body = src.slice(start, end).replace("export function", "function");
function run(reason, round) {
  const fails = [], counts = [];
  global.window = { OrwellReport: { fail: (...a) => fails.push(a), count: (...a) => counts.push(a) } };
  const f = new Function("window", "sessionModule", "chatState", "_softReloadHistory", "_wsResetRound", "_wsRound", "console",
    body + "; return _onWsResync;")(global.window, { getCurrentSessionId: () => "s" }, { _resumingStreams: new Set(), _streamSessionId: null },
    async () => {}, () => {}, round, { warn() {}, error() {} });
  f({ detail: { reason, canonicalId: "s" } });
  return { fails, counts };
}
const holder = { remove() {} };
const out = {
  specEmpty: run("run-started-empty", { holder, reply: "", reasoning: "" }),
  noRound: run("run-started-empty", null),
  withText: run("run-started-empty", { holder, reply: "streamed", reasoning: "" }),
  ownTurn: run("run-started-empty-own-turn", { holder, reply: "", reasoning: "" }),
  restart: run("engine-restart", { holder, reply: "", reasoning: "" }),
};
console.log(JSON.stringify(out));
"""


def test_benign_empty_resync_is_counted_and_real_cases_still_report():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    path = Path(__file__).resolve().parents[1] / "static" / "js" / "chatWsSplice.js"
    proc = subprocess.run([node, "-e", _NODE, str(path)], capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    # the speculative-holder teardown (page reload, no turn in flight) is counted, never a fail line
    for k in ("specEmpty", "noRound"):
        assert out[k]["fails"] == [] and len(out[k]["counts"]) == 1, k
    # a holder that carried text, an own-turn empty ack, and an unexplained resync all still report (the last two RED)
    assert len(out["withText"]["fails"]) == 1 and out["withText"]["fails"][0][3]["red"] is True
    assert len(out["ownTurn"]["fails"]) == 1 and out["ownTurn"]["fails"][0][3]["red"] is True
    assert len(out["restart"]["fails"]) == 1 and out["restart"]["fails"][0][3]["red"] is True
    assert out["ownTurn"]["counts"] == []
