"""ORW-909 - a `turn` up-frame whose ack never reaches the page must not leave the sender's turn pending for ever (live dev casting stall, 2026-11-25).

The REAL orwellWs.js in Node with a stubbed WebSocket. Roles only; no names.
"""

import os
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static", "js")


_HARNESS = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8");
function assert(c, m) { if (!c) { throw new Error("ASSERT: " + m); } }
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const tick = () => new Promise((r) => setImmediate(r));

let lastSock = null;

function boot() {
  global.CustomEvent = function (t, i) { this.type = t; this.detail = i && i.detail; };
  global.WebSocket = function (url) {
    this.url = url; this.readyState = 0; this.sent = [];
    this.send = (s) => this.sent.push(JSON.parse(s));
    this.close = () => { this.readyState = 3; };
    lastSock = this;
  };
  const listeners = {};
  global.window = {
    API_BASE: "", ORWELL_WS_TRANSPORT: true,
    addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(e) { (listeners[e.type] || []).forEach((fn) => { try { fn(e); } catch (_) {} }); return true; },
    location: { protocol: "https:", host: "example.test" },
    sessionModule: { getCurrentSessionId() { return "sess_pertab"; } },
  };
  global.document = { readyState: "complete", body: { dataset: { gameBuild: "1" } }, addEventListener() {} };
  global.window.document = global.document;
  delete global.window.OrwellWs;
  (0, eval)(src);
  return global.window.OrwellWs;
}

function chatSubs() { return lastSock.sent.filter((f) => f.t === "subscribe" && f.ch === "chat"); }
function down(frame) { lastSock.onmessage({ data: JSON.stringify(frame) }); }

async function handshake(hasRunFirst, runId) {
  lastSock.readyState = 1; lastSock.onopen();
  const hello = lastSock.sent.find((f) => f.t === "hello");
  down({ t: "ack", cid: hello.cid, d: { canonicalId: "sess_pertab", live: true, beatSeq: 1 } });
  await tick();
  // The initial chat subscribe's ack: hasRun controls whether we're tailing a live run; runId
  // (when the server knows it) names that run for the #1087 reconcile-by-id guard.
  const sub = chatSubs()[0];
  const d = { fromSeq: 0, headSeq: hasRunFirst ? 0 : -1, hasRun: hasRunFirst };
  if (runId != null) d.runId = runId;
  down({ t: "ack", ch: "chat", cid: sub.cid, d: d });
  await tick();
}


(async function main() {
  // ── 1: the ack is lost, but the server ran the turn: a new run began after the send, then it finished ⇒ the sender's turn settles as accepted ──
  {
    const WS = boot(); await tick(); await handshake(false);
    const p = WS.sendTurn({ message: "hello", clientMsgId: "m1" });
    let state = "pending"; p.then(() => { state = "accepted"; }, (e) => { state = "rejected:" + e.code; });
    await tick();
    assert(state === "pending", "no ack yet: the turn is pending");
    down({ t: "state", ch: "state", d: { beatSeq: 2, reason: "run-started", runId: "r-own" } });
    await tick();
    down({ t: "event", ch: "chat", seq: 0, d: { delta: "reply" } });
    down({ t: "event", ch: "chat", seq: 1, d: { done: true } });
    await tick(); await tick();
    assert(state === "accepted", "a run that began after the send and finished settles the un-acked turn as accepted; got " + state);
  }
  // ── 2: a STALE replayed `done` (no new run began after the send) never ends a fresh send ──
  {
    const WS = boot(); await tick(); await handshake(true);
    const p = WS.sendTurn({ message: "hello", clientMsgId: "m2" });
    let state = "pending"; p.then(() => { state = "accepted"; }, (e) => { state = "rejected:" + e.code; });
    await tick();
    down({ t: "event", ch: "chat", seq: 0, d: { delta: "old run" } });
    down({ t: "event", ch: "chat", seq: 1, d: { done: true } });
    await tick(); await tick();
    assert(state === "pending", "a done of a run that began before the send must not settle it; got " + state);
  }
  // ── 3: the real ack still wins and nothing is double-settled ──
  {
    const WS = boot(); await tick(); await handshake(false);
    const p = WS.sendTurn({ message: "hello", clientMsgId: "m3" });
    let n = 0; p.then(() => { n++; });
    await tick();
    const turn = lastSock.sent.filter((f) => f.t === "turn")[0];
    down({ t: "ack", ch: "chat", cid: turn.cid, d: { accepted: true } });
    await tick();
    down({ t: "state", ch: "state", d: { beatSeq: 2, reason: "run-started", runId: "r-3" } });
    down({ t: "event", ch: "chat", seq: 1, d: { done: true } });
    await tick(); await tick();
    assert(n === 1, "the acked turn settles exactly once; got " + n);
  }
  // ── 4: no ack and no run at all ⇒ the request is given up after the bound with ws-ack-timeout (the caller reconciles from history and never re-sends) ──
  {
    const WS = boot(); await tick(); await handshake(false);
    WS._setTurnAckTimingForTest(0, 40);
    const p = WS.sendTurn({ message: "hello", clientMsgId: "m4" });
    let state = "pending"; p.then(() => { state = "accepted"; }, (e) => { state = "rejected:" + e.code; });
    await new Promise((r) => setTimeout(r, 120));
    assert(state === "rejected:ws-ack-timeout", "an ack that never comes is given up with ws-ack-timeout; got " + state);
  }
  console.log("OK"); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
"""


def _run_node(harness, modpath):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    proc = subprocess.run([node, "-e", harness, modpath], capture_output=True, text=True, timeout=30)
    assert proc.returncode == 0, f"node failed: {proc.stdout}\n{proc.stderr}"
    return proc.stdout


def test_a_turn_whose_ack_is_lost_settles_when_its_run_ends_and_is_bounded():
    out = _run_node(_HARNESS, os.path.join(STATIC, "orwellWs.js"))
    assert "OK" in out
