"""ORW-197 - client render-parity self-heal for the history repaint.

Narrator bubbles painted must match the history's narrator rows; on a mismatch selectSession
reports once and repaints ONCE from the already-fetched rows, never touching live holders or
pending sends. The hydrate id/seq half is pinned by test_orw139_hydrate_seq.py. Roles only.
"""
import os
import re
import shutil
import subprocess

import pytest

SESSIONS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "sessions.js")

_HARNESS = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const m = src.match(/export function historyRenderParity\([\s\S]*?\n\}\n/);
if (!m) throw new Error("no historyRenderParity");
const fn = new Function(m[0].replace("export ", "") + "\nreturn historyRenderParity;")();
const box = (n) => ({ querySelectorAll: () => ({ length: n }) });
const rows = [
  { role: "user", content: "a" }, { role: "assistant", content: "r1" },
  { role: "user", content: "b" }, { role: "assistant", content: [{ type: "text", text: "r2" }] },
  { role: "assistant", content: "" },
];
let r = fn(rows, box(2));
if (!r.ok || r.expected !== 2) throw new Error("ASSERT parity ok " + JSON.stringify(r));
r = fn(rows, box(1));
if (r.ok || r.expected !== 2 || r.rendered !== 1) throw new Error("ASSERT mismatch " + JSON.stringify(r));
if (!fn([], box(0)).ok) throw new Error("ASSERT empty");
console.log("ok");
"""


def test_parity_counts_narrator_rows_vs_bubbles():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    p = subprocess.run([node, "-e", _HARNESS, SESSIONS], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, f"{p.stdout}\n{p.stderr}"


def test_select_session_retries_once_and_keeps_non_history_nodes():
    s = open(SESSIONS, encoding="utf-8").read()
    i = s.index("ORW-197: render-parity self-heal")
    blk = s[i:i + 1400]
    assert blk.count("_paintRows()") == 1  # one bounded retry, no loop
    assert "while" not in blk and "for (let" not in blk
    assert "dataset.fromHistory === '1'" in blk  # only history bubbles are cleared
    assert "_keep" in blk and "appendChild(el)" in blk  # live holders / pending sends re-appended
    assert "_beaconHistoryParity" in blk
    assert "'history-parity'" in s
