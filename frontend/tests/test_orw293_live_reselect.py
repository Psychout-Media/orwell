"""ORW-293: re-selecting the active session while its reply streams is a no-op (it used to detach the stream, whose drop-recovery then auto-continued a SECOND
generation: the same reply persisted twice, seen as "reply shown 2 times" in test_orw139_no_empty_bubble). Runs the real isLiveReselect from sessions.js under node."""
import json
import os
import shutil
import subprocess

import pytest

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "sessions.js")
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node not available")

PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const i = src.indexOf('export function isLiveReselect(');
let depth = 0, started = false, end = -1;
for (let j = src.indexOf('{', i); j < src.length; j++) {
  if (src[j] === '{') { depth++; started = true; } else if (src[j] === '}') { depth--; if (started && depth === 0) { end = j + 1; break; } }
}
const f = new Function(src.slice(i, end).replace('export function', 'function') + '; return isLiveReselect;')();
const streaming = { hasActiveStream: id => id === 's1' };
const idle = { hasActiveStream: () => false };
process.stdout.write(JSON.stringify({
  sameAndStreaming: f('s1', 's1', streaming),
  sameButIdle: f('s1', 's1', idle),
  otherSession: f('s2', 's1', streaming),
  noModule: f('s1', 's1', null),
  noId: f('', '', streaming),
  throwing: f('s1', 's1', { hasActiveStream() { throw new Error('x'); } }),
}));
"""


def test_only_the_active_session_while_streaming_is_ignored():
    res = subprocess.run([NODE, "-e", PROGRAM, "--", JS], capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    o = json.loads(res.stdout)
    assert o["sameAndStreaming"] is True, o          # the no-op
    assert o["sameButIdle"] is False, o               # a normal reselect (refresh) of an idle session still rebuilds
    assert o["otherSession"] is False and o["noModule"] is False and o["noId"] is False and o["throwing"] is False, o


def test_selectSession_returns_before_detaching_on_a_live_reselect():
    src = open(JS, encoding="utf-8").read()
    head = src[src.index("export async function selectSession("):]
    guard = head.index("isLiveReselect(id, currentSessionId, window.chatModule)")
    assert guard < head.index("++_sessionNavToken") and guard < head.index("detachCurrentStream"), "the guard must run before any navigation state changes or the stream detach"
