"""ORW-157 - the MutationObserver storm: body-/transcript-wide observers must not run per streamed token.

Audit report A (3.3): ~11 observers on `document.body` (subtree) and ~6 on `#chat-history` fire on every streamed token; several do a
`querySelectorAll` per added node, one forces layout synchronously. The streaming tail is replaced every token, so most added nodes are
already gone by the time a callback looks at them.

Fix: `frameBatch.js` (`frameBatched` = accumulate records, run the callback ONCE per animation frame with a timer backstop;
`liveAddedElements` = only still-attached, non-nested added elements). Applied to the per-token body/transcript observers; the
gadget-rail sync is coalesced to a frame too. Behaviour is the same, one frame later and once per frame.

The numeric proof is the perf job (`scripts/perf_report.py`, per-site MutationObserver callbacks during a streamed reply).
"""
import json
import os
import re
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static")
JS = os.path.join(STATIC, "js")
_NODE = shutil.which("node")


def _read(*parts):
    with open(os.path.join(STATIC, *parts), encoding="utf-8") as f:
        return f.read()


_PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8').replace(/export /g, '');
const frames = [];
globalThis.requestAnimationFrame = (f) => { frames.push(f); return frames.length; };
globalThis.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
const lib = new Function(src + '; return { frameBatched, liveAddedElements };')();
const out = {};

// 1. 50 mutation batches inside one frame -> ONE callback with all 50 records
let calls = 0, seen = 0;
const cb = lib.frameBatched((recs) => { calls++; seen += recs.length; });
for (let i = 0; i < 50; i++) cb([{ i }], 'obs');
out.callsBeforeFrame = calls;
frames.forEach((f) => f && f());
out.callsAfterFrame = calls; out.recordsSeen = seen;
// the next burst schedules a fresh frame
cb([{ i: 99 }], 'obs'); frames.forEach((f) => f && f());
out.callsAfterSecondBurst = calls;

// 2. liveAddedElements: drops detached and nested nodes, keeps the roots
const root = { nodeType: 1, isConnected: true, parentNode: null };
const child = { nodeType: 1, isConnected: true, parentNode: root };
const gone = { nodeType: 1, isConnected: false, parentNode: null };
const text = { nodeType: 3, isConnected: true, parentNode: root };
const other = { nodeType: 1, isConnected: true, parentNode: null };
const live = lib.liveAddedElements([{ addedNodes: [root, child, gone, text] }, { addedNodes: [other] }]);
out.live = live.map((n) => [root, child, gone, text, other].indexOf(n));

// 3. no rAF (hidden tab / old engine): the timer backstop still delivers
delete globalThis.requestAnimationFrame;
let late = 0;
const cb2 = lib.frameBatched(() => { late++; });
cb2([{}], 'o');
setTimeout(() => { out.timerBackstop = late; console.log(JSON.stringify(out)); }, 250);
"""


@pytest.fixture(scope="module")
def probe():
    if not _NODE:
        pytest.skip("node not available")
    p = subprocess.run([_NODE, "-e", _PROGRAM, os.path.join(JS, "frameBatch.js")], capture_output=True, text=True, timeout=60)
    assert p.returncode == 0, p.stderr[-1500:]
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_a_burst_of_mutation_batches_runs_the_callback_once_per_frame(probe):
    assert probe["callsBeforeFrame"] == 0
    assert probe["callsAfterFrame"] == 1 and probe["recordsSeen"] == 50  # nothing dropped, delivered together
    assert probe["callsAfterSecondBurst"] == 2


def test_live_added_elements_skips_detached_and_nested_nodes(probe):
    assert probe["live"] == [0, 4]  # root and other; not the nested child, the detached node, or the text node


def test_timer_backstop_delivers_when_no_frame_fires(probe):
    assert probe["timerBackstop"] == 1


# ---- every per-token body/transcript observer goes through the batcher (source pins) ------------------------------------------------
@pytest.mark.parametrize("path,needle", [
    (("js", "markdown.js"), "new MutationObserver(frameBatched((mutations) => {\n      for (const node of liveAddedElements(mutations)) _apply(node);"),
    (("js", "chat.js"), "new MutationObserver(frameBatched((muts) => {\n      for (const n of liveAddedElements(muts)) {"),
    (("js", "ui.js"), "new MutationObserver(frameBatched((mutations) => {"),
    (("js", "ui.js"), "new MutationObserver(frameBatched((muts) => {"),
    (("js", "sidebar-layout.js"), "new MutationObserver(frameBatched((muts) => {"),
    (("app.js",), "new MutationObserver(frameBatched((mutations) => {\n      for (const n of liveAddedElements(mutations)) {"),
])
def test_per_token_observers_are_frame_batched(path, needle):
    assert needle in _read(*path)


def test_classic_script_observers_coalesce_to_a_frame():
    assert "_wnRun" in _read("js", "orwellScrollBottom.js") and "requestAnimationFrame(_wnRun)" in _read("js", "orwellScrollBottom.js")
    assert "requestAnimationFrame(_sbRun)" in _read("js", "orwellScrollbars.js")
    rail = _read("js", "orwellGadgetRail.js")
    assert "requestAnimationFrame(_railSyncRun)" in rail
    # the rail observer stays scoped to its own body (never document.body)
    assert re.search(r"_obs\.observe\(body, \{ childList: true, subtree: true", rail)


def test_no_new_gamechanged_dispatcher_was_added():
    # g15: exactly one dispatcher (platform.js); the batching helpers must not dispatch it
    assert "orwell:gamechanged" not in _read("js", "frameBatch.js")
