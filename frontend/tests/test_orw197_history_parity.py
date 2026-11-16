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
const box = (n) => ({ querySelectorAll: () => Array.from({ length: n }, (_, i) => ({ dataset: { dbId: "r" + i } })) });
const rows = [
  { role: "user", content: "a" }, { role: "assistant", content: "r1" },
  { role: "user", content: "b" }, { role: "assistant", content: [{ type: "text", text: "r2" }] },
  { role: "assistant", content: "" },
];
let r = fn(rows, box(2));
if (!r.ok || r.expected !== 2) throw new Error("ASSERT parity ok " + JSON.stringify(r));
r = fn(rows, box(1));
if (r.ok || r.expected !== 2 || r.rendered !== 1) throw new Error("ASSERT mismatch " + JSON.stringify(r));
// ORW-481: three bubbles of ONE row do not satisfy two expected rows
const dup = { querySelectorAll: () => [1, 2, 3].map(() => ({ dataset: { dbId: "r0" } })) };
r = fn(rows, dup);
if (r.ok || r.rendered !== 1) throw new Error("ASSERT distinct rows " + JSON.stringify(r));
if (!fn([], box(0)).ok) throw new Error("ASSERT empty");
console.log("ok");
"""


def test_parity_counts_narrator_rows_vs_bubbles():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    p = subprocess.run([node, "-e", _HARNESS, SESSIONS], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, f"{p.stdout}\n{p.stderr}"


def test_select_session_retries_once_and_keeps_only_pending_sends_and_live_holders():
    s = open(SESSIONS, encoding="utf-8").read()
    i = s.index("ORW-197: render-parity self-heal")
    blk = s[i:i + 2000]
    assert blk.count("_paintRows()") == 1  # one bounded retry, no loop
    assert "while" not in blk and "for (let" not in blk
    assert "_keep" in blk and "appendChild(el)" in blk
    # ORW-481: only pending sends + live holders are kept; untagged tool threads / cards are repainted
    assert "Array.from(chatHistory.children).filter(el => _pendingToPreserve.includes(el) || _liveHoldersToKeep.includes(el))" in blk
    assert "_beaconHistoryParity" in blk
    assert "'history-parity'" in s
