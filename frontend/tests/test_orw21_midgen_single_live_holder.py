"""ORW-21 - a mid-generation joiner must have exactly ONE live holder for the in-flight run.

A late joiner is attached by the SSE `resumeStream` (selectSession -> _checkServerStream) AND by the WS
replay (`chatWsSplice._wsEnsureRound`). When the SSE reader already holds the session's `_resumingStreams`
lock and owns a live bubble, the WS splice must yield (mount nothing), and its `done` must not release a
lock it never took - else the settle reconcile rebuilds under a still-painting reader and a second,
finalized bubble lands beside the history row (the S17 duplicate).
BEHAVIORAL: the real functions are extracted from the source and run in Node with stubs. Roles only.
"""
import os
import shutil
import subprocess

import pytest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")

_HARNESS = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8");
const grab = (re) => { const m = src.match(re); if (!m) throw new Error("missing " + re); return m[0].replace("export ", ""); };
const ensureSrc = grab(/export function _wsEnsureRound\(\) \{[\s\S]*?\n\}\n/);
const frameSrc = grab(/export function _onWsChatFrame\(frame\) \{[\s\S]*?\n\}\n/);

function mk(resuming, round) {
  let mounted = 0, softReloads = 0;
  const chatState = { _streamSessionId: null, _resumingStreams: new Set(resuming) };
  const holder = () => ({ isConnected: true, className: "", dataset: {}, innerHTML: "",
    querySelector: () => ({}), remove() {} });
  const doc = { getElementById: () => ({ appendChild() { mounted++; } }), createElement: holder };
  const sessionModule = { getCurrentSessionId: () => "S", getCurrentModel: () => "m" };
  const uiModule = { esc: (x) => x, scrollHistory() {} };
  const f = new Function("chatState", "sessionModule", "uiModule", "document", "round", "cb", "window",
    "let _wsRound = round; let _wsRichRun = false;\n" +
    "function _shortModel(x) { return x; }\nfunction _senderLabel(x) { return x; }\n" +
    "const _renderLiveStream = () => { cb.rendered++; };\nconst _wsLiveRender = () => '';\n" +
    "function _wsResetRound() { _wsRound = null; _wsRichRun = false; }\n" +
    "function _softReloadHistory() { cb.reload++; }\nfunction _renderUserMessage() {}\nfunction _dispatchAnnouncements() {}\n" +
    ensureSrc + "\n" + frameSrc + "\nreturn { ensure: _wsEnsureRound, frame: _onWsChatFrame, round: () => _wsRound };");
  const cb = { rendered: 0, reload: 0 };
  const api = f(chatState, sessionModule, uiModule, doc, round, cb, {});
  return { api, chatState, cb, mounted: () => mounted };
}

// 1) the SSE reader owns the live render: the WS splice mounts nothing and renders nothing
let t = mk(["S"], null);
if (t.api.ensure() !== null || t.mounted() !== 0) throw new Error("ASSERT: WS mounted a second live holder beside the SSE reader");
t.api.frame({ d: { delta: "x" } });
if (t.cb.rendered !== 0) throw new Error("ASSERT: WS painted a delta the SSE reader already paints");
// ...and its done must NOT release the SSE reader's lock, but still asks for the (deferred) settle reconcile
t.api.frame({ d: { done: true } });
if (!t.chatState._resumingStreams.has("S")) throw new Error("ASSERT: WS done released a lock it never took");
if (t.cb.reload !== 1) throw new Error("ASSERT: settle reconcile not requested");

// 2) no SSE reader: the WS splice mounts its own holder, takes the lock, and releases it at done
t = mk([], null);
if (!t.api.ensure() || t.mounted() !== 1) throw new Error("ASSERT: WS observer must mount its own holder");
if (!t.chatState._resumingStreams.has("S")) throw new Error("ASSERT: WS observer must take the live-render lock");
t.api.frame({ d: { done: true } });
if (t.chatState._resumingStreams.has("S")) throw new Error("ASSERT: WS done must release its own lock");

// 3) a connected WS round keeps being reused (no second holder) even though it holds the lock
t = mk([], null);
const a = t.api.ensure(), b = t.api.ensure();
if (a !== b || t.mounted() !== 1) throw new Error("ASSERT: ensure must reuse the live round");
console.log("ok");
"""


def test_ws_splice_yields_to_sse_resume_holder_and_keeps_its_lock():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    proc = subprocess.run([node, "-e", _HARNESS, os.path.join(STATIC, "chatWsSplice.js")],
                          capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, f"{proc.stdout}\n{proc.stderr}"
