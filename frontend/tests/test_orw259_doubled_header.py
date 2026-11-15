"""ORW-259 - a run-boundary edge must not mount a SECOND holder beside the sender's pinned one.

The observer run-boundary handler is guarded by `chatState._streamSessionId`, but a prior run's late
`done` clears it after the sender pinned its next holder; the fall-through then reset the pin and
mounted a second holder, leaving an empty header-only bubble ("PRProduction hh:mm" twice).
BEHAVIORAL: the real `_onWsRunBoundary` source is extracted and run in Node with stubs. Roles only.
"""
import os
import re
import shutil
import subprocess

import pytest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")

_HARNESS = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const m = src.match(/export function _onWsRunBoundary\(\) \{[\s\S]*?\n\}\n/);
if (!m) throw new Error("no _onWsRunBoundary");
const body = m[0].replace("export ", "");
const mk = (round) => {
  const calls = { ensure: 0, reset: 0 };
  const chatState = { _streamSessionId: null, _resumingStreams: new Set() };
  const factory = new Function("chatState", "round", "calls", "window",
    "let _wsRound = round; let _wsRichRun = false;\n" +
    "function _wsResetRound() { calls.reset++; _wsRound = null; }\n" +
    "function _wsEnsureRound() { calls.ensure++; _wsRound = { holder: { isConnected: true } }; return _wsRound; }\n" +
    "function _mountThinkingSpinner() { return {}; }\n" + body + "\nreturn _onWsRunBoundary;");
  return { fn: factory(chatState, round, calls, {}), calls };
};
// sender pinned an unfilled holder, _streamSessionId already cleared by the prior run's done
let t = mk({ holder: { isConnected: true }, clientMsgId: "c1", reply: "", reasoning: "" });
t.fn();
if (t.calls.ensure !== 0 || t.calls.reset !== 0) throw new Error("ASSERT: second holder mounted beside the pinned sender holder " + JSON.stringify(t.calls));
// an OBSERVER prior round (no clientMsgId) still resets + remounts
t = mk({ holder: { isConnected: true, remove() {} }, reply: "x", reasoning: "" });
t.fn();
if (t.calls.reset !== 1 || t.calls.ensure !== 1) throw new Error("ASSERT: observer round must still be replaced " + JSON.stringify(t.calls));
console.log("ok");
"""


def test_run_boundary_keeps_unfilled_sender_pinned_holder():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    proc = subprocess.run([node, "-e", _HARNESS, os.path.join(STATIC, "chatWsSplice.js")],
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, f"{proc.stdout}\n{proc.stderr}"
