"""ORW-217: `hasRun:false` on a reconnect's chat subscribe is the NORMAL idle state (ws_routes: no live or buffered run), not "the run vanished". `orwellWs.js` must raise the RED
`ws:reconnect-run-gone` report and the run-gone resync ONLY when a live run was mid-tail at the disconnect. Drives the REAL orwellWs.js in Node with a stubbed WebSocket."""
import os
import shutil
import subprocess

import pytest

STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js")

_HARNESS = r"""
const fs = require("node:fs");
const src = fs.readFileSync(process.argv[1], "utf8");
function assert(c, m) { if (!c) { throw new Error("ASSERT: " + m); } }
process.on("unhandledRejection", (e) => { console.error(e); process.exit(1); });
const tick = () => new Promise((r) => setImmediate(r));
// Poll until the reconnect timer has replaced the socket (real 500 ms backoff + jitter-free), instead of a fixed sleep racing it.
async function nextSocket(prev) { for (let i = 0; i < 400 && lastSock === prev; i++) await new Promise((r) => setTimeout(r, 10)); assert(lastSock !== prev, "the reconnect never created a new socket"); }
let lastSock = null, resyncs = [], reports = [];
function boot() {
  resyncs = []; reports = [];
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
    addEventListener(n, fn) { (listeners[n] = listeners[n] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(e) { (listeners[e.type] || []).forEach((fn) => { try { fn(e); } catch (_) {} }); return true; },
    location: { protocol: "https:", host: "example.test" },
    sessionModule: { getCurrentSessionId() { return "sess_pertab"; } },
    OrwellReport: { fail(kind) { reports.push(kind); } },
  };
  global.window.addEventListener("orwell:ws-resync", (e) => resyncs.push(e.detail || {}));
  global.document = { readyState: "complete", body: { dataset: { gameBuild: "1" } }, addEventListener() {} };
  global.window.document = global.document;
  delete global.window.OrwellWs;
  (0, eval)(src);
  return global.window.OrwellWs;
}
function down(f) { lastSock.onmessage({ data: JSON.stringify(f) }); }
function chatSubs() { return lastSock.sent.filter((f) => f.t === "subscribe" && f.ch === "chat"); }
async function handshake(beat, hasRun) {
  lastSock.readyState = 1; lastSock.onopen();
  const hello = lastSock.sent.find((f) => f.t === "hello");
  down({ t: "ack", cid: hello.cid, d: { canonicalId: "sess_pertab", live: true, beatSeq: beat } });
  await tick();
  const sub = chatSubs()[chatSubs().length - 1];
  down({ t: "ack", ch: "chat", cid: sub.cid, d: { fromSeq: 0, headSeq: 0, hasRun: !!hasRun } });
  await tick();
}
const gone = () => reports.includes("ws:reconnect-run-gone");
const goneResync = () => resyncs.some((r) => r.reason === "reconnect-run-gone");

(async function main() {
  // A: an IDLE reconnect (a finished turn, then a drop) must not report run-gone.
  {
    boot(); await tick();
    await handshake(10, true);
    down({ t: "event", ch: "chat", seq: 0, d: { delta: "the reply" } });
    down({ t: "event", ch: "chat", seq: 1, d: { done: true } });   // the run FINISHED before the drop
    await tick(); resyncs = []; reports = [];
    { const prev = lastSock; prev.onclose(); await nextSocket(prev); }
    await handshake(10, false);                                     // server: no run at all (idle)
    assert(!gone(), "an idle reconnect must NOT raise the RED run-gone report; got " + JSON.stringify(reports));
    assert(!goneResync(), "an idle reconnect must NOT emit a run-gone resync");
  }
  // B: a reconnect on a page that never had a run (hasRun:false at the first connect, then a drop).
  {
    boot(); await tick();
    await handshake(10, false);
    { const prev = lastSock; prev.onclose(); await nextSocket(prev); }
    await handshake(10, false);
    assert(!gone() && !goneResync(), "a never-ran page reconnecting idle is not a vanished run");
  }
  // C: a live run mid-tail at the drop that is gone on reconnect IS reported (the genuine interruption).
  {
    boot(); await tick();
    await handshake(30, true);
    down({ t: "event", ch: "chat", seq: 0, d: { delta: "partial" } });
    await tick(); resyncs = []; reports = [];
    { const prev = lastSock; prev.onclose(); await nextSocket(prev); }
    await handshake(30, false);
    assert(gone(), "a mid-stream run that vanished across the reconnect MUST still be reported");
    assert(goneResync(), "...and must still resync so the half-painted bubble reconciles");
  }
  // D: the flag is consumed: a LATER idle reconnect after C's recovery is not reported again.
  {
    boot(); await tick();
    await handshake(30, true);
    down({ t: "event", ch: "chat", seq: 0, d: { delta: "partial" } });
    await tick();
    { const prev = lastSock; prev.onclose(); await nextSocket(prev); }
    await handshake(30, false);                                     // reported once (run gone)
    resyncs = []; reports = [];
    { const prev = lastSock; prev.onclose(); await nextSocket(prev); }                          // a second, idle drop
    await handshake(30, false);
    assert(!gone() && !goneResync(), "a later idle reconnect must not re-report the already-handled run");
  }
  // E: a drop between "subscribe sent" and its ack, on a page that never had a live run, is NOT a vanished run.
  {
    boot(); await tick();
    await handshake(10, false);
    resyncs = []; reports = [];
    { const prev = lastSock; prev.onclose(); await nextSocket(prev); }
    lastSock.readyState = 1; lastSock.onopen();                       // reconnect: hello sent, subscribe about to go
    const hello = lastSock.sent.find((f) => f.t === "hello");
    down({ t: "ack", cid: hello.cid, d: { canonicalId: "sess_pertab", live: true, beatSeq: 10 } });
    await tick();
    { const prev = lastSock; prev.onclose(); await nextSocket(prev); } // dropped again BEFORE the subscribe ack
    await handshake(10, false);
    assert(!gone() && !goneResync(), "a pre-ack drop with no known live run must not raise run-gone");
  }
  console.log("OK");
  process.exit(0);
})();
"""


def test_idle_reconnect_is_not_run_gone_but_a_vanished_live_run_still_is():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    proc = subprocess.run([node, "-e", _HARNESS, os.path.join(STATIC, "orwellWs.js")],
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, f"node failed: {proc.stdout}\n{proc.stderr}"
    assert "OK" in proc.stdout
