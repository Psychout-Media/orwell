"""ORW-406 slice 2 - the page rides through a release (a ~5-8 s front-end restart).

(a) the engine-status banner shows only once a front-end failure has lasted > 10 s; (b) a turn sent while the socket is down is held and sent
exactly once, in order, with its own clientMsgId, after the reconnect; (c) the HUD's "feed offline" dot waits the same 10 s.
Driven against the REAL modules in Node with stubs (the test_ws_close_rejects_pending_turn.py idiom). Roles only.
"""
import os
import shutil
import subprocess

import pytest

_STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")

_WS = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8");
function assert(c, m) { if (!c) { throw new Error("ASSERT: " + m); } }
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastSock = null; const socks = [];
global.CustomEvent = function (t, i) { this.type = t; this.detail = i && i.detail; };
global.WebSocket = function (url) {
  this.url = url; this.readyState = 0; this.sent = [];
  this.send = (s) => this.sent.push(JSON.parse(s));
  this.close = () => { this.readyState = 3; };
  lastSock = this; socks.push(this);
};
const listeners = {};
global.window = {
  API_BASE: "", ORWELL_WS_TRANSPORT: true,
  addEventListener(n, fn) { (listeners[n] = listeners[n] || []).push(fn); }, removeEventListener() {},
  dispatchEvent(e) { (listeners[e.type] || []).forEach((fn) => { try { fn(e); } catch (_) {} }); return true; },
  location: { protocol: "https:", host: "example.test" },
  sessionModule: { getCurrentSessionId() { return "sess_pertab"; } },
};
global.document = { readyState: "complete", body: { dataset: { gameBuild: "1" } }, addEventListener() {} };
global.window.document = global.document;
(0, eval)(src);
const WS = global.window.OrwellWs;
function down(f) { lastSock.onmessage({ data: JSON.stringify(f) }); }
async function handshake() {
  lastSock.readyState = 1; lastSock.onopen();
  const hello = lastSock.sent.find((f) => f.t === "hello");
  down({ t: "ack", cid: hello.cid, d: { canonicalId: "sess_pertab", live: true, beatSeq: 1 } });
  await tick();
  const sub = lastSock.sent.find((f) => f.t === "subscribe" && f.ch === "chat");
  down({ t: "ack", ch: "chat", cid: sub.cid, d: { fromSeq: 0, headSeq: 0, hasRun: false } });
  await tick();
}
(async function main() {
  await tick(); await handshake();
  assert(WS.isActive(), "live after handshake");
  assert(!WS.isReconnecting(), "not reconnecting while live");
  // the release: the socket drops
  const first = lastSock; first.readyState = 3; first.onclose();
  assert(WS.isReconnecting(), "a drop of a once-live socket is a reconnect, not a fallback");
  // the player types two messages during the gap
  const settled = [];
  WS.sendTurnWhenLive({ message: "one", clientMsgId: "c-1" }, 20000).then(() => settled.push("c-1"), (e) => settled.push("ERR1:" + e.message));
  WS.sendTurnWhenLive({ message: "two", clientMsgId: "c-2" }, 20000).then(() => settled.push("c-2"), (e) => settled.push("ERR2:" + e.message));
  await tick();
  assert(first.sent.filter((f) => f.t === "turn").length === 0, "nothing is sent on the dead socket");
  assert(settled.length === 0, "queued sends neither resolve nor error during the gap");
  // the reconnect (backoff 500 ms)
  await sleep(700);
  assert(lastSock !== first, "a new socket was opened");
  await handshake();
  await sleep(500);
  const turns = lastSock.sent.filter((f) => f.t === "turn");
  assert(turns.length === 2, "exactly two turn frames after the reconnect, got " + turns.length);
  assert(turns[0].d.clientMsgId === "c-1" && turns[1].d.clientMsgId === "c-2", "in order, same ids: " + JSON.stringify(turns.map((t) => t.d.clientMsgId)));
  turns.forEach((t) => down({ t: "ack", ch: "chat", cid: t.cid, d: { accepted: true } }));
  await tick(); await tick();
  assert(settled.join() === "c-1,c-2", "both resolve once: " + settled.join());
  // never double-sent on the old socket either
  assert(socks.reduce((n, s) => n + s.sent.filter((f) => f.t === "turn").length, 0) === 2, "exactly-once across all sockets");
  console.log("OK"); process.exit(0);
})();
"""

_STATUS = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8");
function assert(c, m) { if (!c) { throw new Error("ASSERT: " + m); } }
process.on("unhandledRejection", (e) => { console.error("UNHANDLED:", e); process.exit(1); });
let now = 1000000; Date.now = () => now; Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true }); // ORW-437: the gap clock is monotonic (performance.now)
const timers = []; global.setTimeout = (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; };
global.clearTimeout = () => {}; global.setInterval = () => 0; global.clearInterval = () => {};
let shows = 0; let hides = 0; let mode = "502";
global.window = {
  OrwellNoticeKit: { create() { return { show() { shows++; }, update() {}, hide() { hides++; } }; } },
  addEventListener() {},
};
global.document = { readyState: "complete", addEventListener() {} };
global.navigator = { onLine: true };
global.fetch = async () => (mode === "502" ? { ok: false, status: 502 } : mode === "throw" ? (() => { throw new Error("refused"); })() : { ok: true, json: async () => ({ engine: true }) });
(0, eval)(src);
const refresh = global.window.orwellRefreshEngineStatus;
const flush = () => new Promise((r) => setImmediate(r));
(async function main() {
  await flush();                      // start() ran one refresh: 502 #1 at t0
  assert(shows === 0, "a first 502 shows nothing");
  now += 4000; await refresh(); assert(shows === 0, "a 4 s gap shows no banner");
  mode = "throw"; now += 3000; await refresh(); assert(shows === 0, "a connection-refused 7 s into the gap shows no banner");
  mode = "ok"; now += 1000; await refresh(); assert(shows === 0, "recovered inside the grace: still nothing shown");
  // a gap that outlasts the grace DOES show
  mode = "502"; now += 1000; await refresh(); assert(shows === 0, "new gap starts quiet");
  now += 11000; await refresh(); assert(shows === 1, "a gap longer than 10 s shows the banner, shows=" + shows);
  console.log("OK"); process.exit(0);
})();
"""


def _node():
    n = shutil.which("node") or ("/opt/node22/bin/node" if os.path.exists("/opt/node22/bin/node") else None)
    if not n:
        pytest.skip("node not available")
    return n


def _run(script, module):
    proc = subprocess.run([_node(), "-e", script, os.path.join(_STATIC, module)], capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, f"node failed: {proc.stdout}\n{proc.stderr}"
    assert "OK" in proc.stdout


def test_turns_sent_during_a_socket_gap_are_queued_and_sent_once_in_order():
    _run(_WS, "orwellWs.js")


def test_engine_status_banner_waits_out_a_release_sized_gap():
    _run(_STATUS, "orwellEngineStatus.js")


def test_status_panel_feed_dot_and_chat_wiring_are_gated():
    """(c) + the chat seam: static guards (the panel needs a full DOM; the wiring is a few lines)."""
    panel = open(os.path.join(_STATIC, "orwellStatusPanel.js")).read()
    assert "Date.now() - _failSince >= 10000" in panel
    chat = open(os.path.join(_STATIC, "chat.js")).read()
    assert "sendTurnWhenLive" in chat and "isReconnecting" in chat and "_setQueuedTag(_userMsgEl, 'sending')" in chat
