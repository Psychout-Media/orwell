"""ORW-308 (phone play): the live WebSocket must survive phone sleep, an app switch and a wifi/cell handoff. The game build is WebSocket-only, so a permanent fallback is a dead game.
Drives the REAL orwellWs.js in Node with a stubbed WebSocket and a fake clock (no real waiting). Roles only."""
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

// fake clock: setTimeout/clearTimeout/Date.now are virtual, advanced by hand
let now = 1000000, nextId = 1, timers = new Map();
global.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
global.clearTimeout = (id) => { timers.delete(id); };
const RealDate = Date;
global.Date = class extends RealDate { static now() { return now; } };
async function advance(ms) {
  const end = now + ms;
  for (;;) {
    let nextT = null;
    for (const [id, t] of timers) if (t.at <= end && (nextT === null || t.at < timers.get(nextT).at)) nextT = id;
    if (nextT === null) break;
    const t = timers.get(nextT); timers.delete(nextT); now = Math.max(now, t.at); t.fn(); await tick();
  }
  now = end;
}

let lastSock = null, socks = [], events = [], listeners = {}, docListeners = {};
function boot() {
  socks = []; events = []; listeners = {}; docListeners = {}; timers = new Map();
  global.CustomEvent = function (t, i) { this.type = t; this.detail = i && i.detail; };
  global.WebSocket = function (url) {
    this.url = url; this.readyState = 0; this.sent = [];
    this.send = (s) => { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(JSON.parse(s)); };
    this.close = () => { this.closedByUs = true; this.readyState = 3; };
    lastSock = this; socks.push(this);
  };
  global.window = {
    API_BASE: "", ORWELL_WS_TRANSPORT: true,
    addEventListener(n, fn) { (listeners[n] = listeners[n] || []).push(fn); },
    removeEventListener() {},
    dispatchEvent(e) { events.push(e.type + ":" + JSON.stringify(e.detail || {})); (listeners[e.type] || []).forEach((fn) => { try { fn(e); } catch (_) {} }); return true; },
    location: { protocol: "https:", host: "example.test" },
    sessionModule: { getCurrentSessionId() { return "sess_pertab"; } },
    OrwellReport: { fail() {} },
  };
  global.document = { readyState: "complete", visibilityState: "visible", body: { dataset: { gameBuild: "1" } }, addEventListener(n, fn) { (docListeners[n] = docListeners[n] || []).push(fn); } };
  global.window.document = global.document;
  delete global.window.OrwellWs;
  (0, eval)(src);
  return global.window.OrwellWs;
}
const fire = (n) => (listeners[n] || []).forEach((fn) => fn({}));
const fireDoc = (n) => (docListeners[n] || []).forEach((fn) => fn({}));
function down(f) { lastSock.onmessage({ data: JSON.stringify(f) }); }
async function handshake(beat) {
  lastSock.readyState = 1; lastSock.onopen();
  const hello = lastSock.sent.find((f) => f.t === "hello");
  down({ t: "ack", cid: hello.cid, d: { canonicalId: "sess_pertab", live: true, beatSeq: beat } });
  await tick();
  const subs = lastSock.sent.filter((f) => f.t === "subscribe" && f.ch === "chat");
  down({ t: "ack", ch: "chat", cid: subs[subs.length - 1].cid, d: { fromSeq: 0, headSeq: 0, hasRun: false } });
  await tick();
}
const blocked = () => events.some((e) => e.startsWith("orwell:ws-blocked"));

(async function main() {
  // A: after being live, a reconnect whose hello is never answered (a dead link) retries; it does NOT fall back to the dead permanent mode.
  {
    const ws = boot(); await tick();
    await handshake(10);
    assert(ws.mode() === "ws", "live");
    lastSock.onclose();                                   // the drop
    for (let i = 0; i < 4; i++) { await advance(20000); }  // reconnect fires, hello unanswered (3 s), closes, retries ...
    assert(ws.mode() !== "fallback", "a live page must not fall back because the network was away: mode=" + ws.mode());
    assert(!blocked(), "no 'blocked' banner for an away network");
    assert(socks.length >= 3, "it keeps trying: sockets=" + socks.length);
  }
  // B: no give-up cap once live - well past the old 6 failures.
  {
    const ws = boot(); await tick();
    await handshake(10);
    lastSock.onclose();
    for (let i = 0; i < 20; i++) { await advance(20000); if (lastSock.readyState === 0) { lastSock.readyState = 3; lastSock.onclose(); } }
    assert(ws.mode() !== "fallback", "20 failed reconnects later it is still retrying: mode=" + ws.mode());
    // ... and when the link returns it recovers
    await advance(20000);
    await handshake(10);
    assert(ws.mode() === "ws", "recovered after a long outage: mode=" + ws.mode());
  }
  // C: a page that NEVER went live still falls back for good (a proxy that blocks WebSockets) - unchanged.
  {
    const ws = boot(); await tick();
    lastSock.readyState = 3; lastSock.onclose();
    assert(ws.mode() === "fallback", "never-live close => fallback, got " + ws.mode());
  }
  // D: a wake signal cuts the backoff: the reconnect happens now, not after the wait.
  {
    const ws = boot(); await tick();
    await handshake(10);
    for (let i = 0; i < 5; i++) { lastSock.onclose(); await advance(1); lastSock.readyState = 3; await advance(20000); }   // grow the backoff
    const before = socks.length;
    lastSock.readyState = 3; lastSock.onclose();           // a fresh drop with a long wait pending
    assert(socks.length === before, "no new socket yet (backoff pending)");
    fire("online");
    assert(socks.length === before + 1, "the 'online' event reconnects immediately");
  }
  // E: a ZOMBIE socket (readyState 1, nothing flowing) is detected on return: ping, no frame in 4 s => closed and reconnected.
  {
    const ws = boot(); await tick();
    await handshake(10);
    const zombie = lastSock;
    document.visibilityState = "visible"; fireDoc("visibilitychange");
    assert(zombie.sent.some((f) => f.t === "ping"), "the wake-up sent a liveness ping");
    await advance(4500);                                   // nothing came back
    assert(zombie.closedByUs, "the zombie socket was closed");
    await advance(1000);
    assert(socks.length === 2, "and a fresh socket is connecting");
    assert(ws.mode() === "negotiating" || ws.mode() === "ws", "mode " + ws.mode());
  }
  // F: a HEALTHY socket answers the ping and is left alone.
  {
    const ws = boot(); await tick();
    await handshake(10);
    const live = lastSock;
    fire("pageshow");
    assert(live.sent.some((f) => f.t === "ping"), "pinged");
    down({ t: "pong" });                                   // the server answered
    await advance(5000);
    assert(!live.closedByUs && socks.length === 1, "a healthy socket is not recycled");
  }
  // G: a hidden->visible with no live page yet does nothing (no socket exists to probe, nothing to cut).
  {
    const ws = boot(); await tick();
    const n = socks.length;
    fire("online");
    assert(socks.length === n, "a wake before the page ever went live is a no-op");
  }
  // H: a stale socket's late close cannot tear down its replacement.
  {
    const ws = boot(); await tick();
    await handshake(10);
    const first = lastSock;
    document.visibilityState = "visible"; fireDoc("visibilitychange");
    await advance(4500);                                   // zombie replaced
    await advance(1000);
    const second = lastSock; assert(second !== first, "replaced");
    first.onclose && first.onclose();                      // the old one finally reports closed
    assert(lastSock === second && second.readyState !== 3, "the successor is untouched");
  }
  // I: a RECONNECT hands the `state` listeners one edge ping (platform.js turns it into the single dispatch); the first connect does not.
  {
    const ws = boot(); await tick();
    const got = [];
    ws.onFrame("state", (f) => got.push(f.d && f.d.reason + ":" + f.d.beatSeq));
    await handshake(10);
    assert(!got.some((g) => g.startsWith("reconnect")), "a first connect is not a reconnect refresh: " + JSON.stringify(got));
    lastSock.onclose(); await advance(1000);
    await handshake(12);
    assert(got.includes("reconnect:12"), "the reconnect refreshes the board through the state listeners: " + JSON.stringify(got));
  }
  console.log("OK");
  process.exit(0);
})();
"""


def test_the_live_socket_survives_phone_sleep_app_switch_and_network_handoff():
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    proc = subprocess.run([node, "-e", _HARNESS, os.path.join(STATIC, "orwellWs.js")], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, f"node failed: {proc.stdout}\n{proc.stderr}"
    assert "OK" in proc.stdout


# ── real Chromium at phone size against the live stack ───────────────────────────────────────────────────────────
from test_m0_3_midgen_join import STUB, _stack  # noqa: E402,F401
from test_p0h_day1_clock_e2e import _session  # noqa: E402
from test_orw191_golden_flows import AI_BUBBLE, COMPOSER, USER_BUBBLE, _expect_once, _launch, _open, _send, _wait_settled  # noqa: E402

# Every WebSocket the page opens is recorded; while __wsBlock is set a new one is aimed at a refused port (the network is away: onclose fires without ever opening).
_WS_INIT = """
(() => {
  const R = window.WebSocket; window.__ws = []; window.__wsBlock = false;
  const W = function (u, p) { const s = window.__wsBlock ? new R('ws://127.0.0.1:9/') : new R(u, p); window.__ws.push(s); return s; };
  W.prototype = R.prototype; for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) W[k] = R[k];
  window.WebSocket = W;
})();
"""


def _live(page):
    return page.evaluate("() => !!(window.OrwellWs && window.OrwellWs.isActive && window.OrwellWs.isActive() && window.OrwellWs.isChatSubscribed())")


def _wait_live(page, timeout=25000):
    page.wait_for_function("() => !!(window.OrwellWs && window.OrwellWs.isActive() && window.OrwellWs.isChatSubscribed())", timeout=timeout)


def _quiesce_stub(quiet_s=2.0, timeout_s=30):
    """No other narrator call may pop the entry this test queues: wait until the stub has seen no new request for a moment, and drop any leftover scripted entry an earlier test did not consume."""
    import time
    end, last, since = time.time() + timeout_s, -1, time.time()
    while time.time() < end:
        with STUB.lock:
            n = len(STUB.requests)
        if n != last:
            last, since = n, time.time()
        elif time.time() - since >= quiet_s:
            break
        time.sleep(0.2)
    with STUB.lock:
        STUB.script.clear()


def _kill_sockets(page):
    page.evaluate("() => window.__ws.forEach(s => { try { s.close(); } catch (e) {} })")


# ORW-293c: no automatic rerun (unique text per phase, but the module stack's one canonical session still accumulates rows).
@pytest.mark.browser
@pytest.mark.flaky(reruns=0)
def test_phone_viewport_the_socket_comes_back_after_idle_drop_mid_turn_drop_and_a_network_outage(_stack):  # noqa: F811
    import uuid
    from playwright.sync_api import sync_playwright

    _session(_stack, "orw308-phone")
    tag = uuid.uuid4().hex[:8]
    with sync_playwright() as pw:
        browser = _launch(pw)
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=3)
        ctx.add_init_script(_WS_INIT)
        page = _open(browser, _stack, ctx)
        _wait_live(page)
        canon = page.evaluate("() => window.OrwellWs.canonicalId()")
        assert canon, "the socket is bound to a canonical session"

        # (1) idle drop (screen sleep): the socket is killed; it reconnects by itself and binds the SAME session.
        _kill_sockets(page)
        _wait_live(page)
        assert page.evaluate("() => window.OrwellWs.canonicalId()") == canon

        # (2) mid-turn drop: kill the socket while the reply is streaming; the reply must still settle, exactly once.
        _quiesce_stub()
        say, reply = f"Phone mid-turn {tag}: look around.", f"The house settles around phone-mid-{tag}."
        STUB.script.append({"deltas": ["The house ", "settles around ", f"phone-mid-{tag}."], "delay": 0.9})
        n0 = len(STUB.script)
        _send(page, say, n0)
        page.wait_for_function("(s) => Array.from(document.querySelectorAll(s)).some(e => (e.textContent||'').includes('The house'))", arg=AI_BUBBLE, timeout=20000)
        _kill_sockets(page)
        _wait_settled(page, reply)
        _expect_once(page, [(USER_BUBBLE, say), (AI_BUBBLE, reply)], "after a mid-turn drop")

        # (3) a network outage longer than the old give-up: new sockets cannot connect for a while, then the link returns.
        page.evaluate("() => { window.__wsBlock = true; window.__ws.forEach(s => { try { s.close(); } catch (e) {} }); }")
        page.wait_for_timeout(9000)
        assert page.evaluate("() => window.OrwellWs.mode()") != "fallback", "an away network must not drop the page to the permanent fallback"
        assert page.query_selector("#orwell-ws-blocked") is None, "no 'cannot connect' banner for a network that is only away"
        page.evaluate("() => { window.__wsBlock = false; }")
        page.evaluate("() => window.dispatchEvent(new Event('online'))")      # the phone's 'back online' signal: reconnect now, not after the backoff
        _wait_live(page, timeout=15000)
        assert page.evaluate("() => window.OrwellWs.canonicalId()") == canon

        # the game still plays after the outage
        _quiesce_stub()
        say2, reply2 = f"Phone after outage {tag}: carry on.", f"The night goes on, phone-after-{tag}."
        STUB.script.append({"deltas": ["The night goes on, ", f"phone-after-{tag}."], "delay": 0.2})
        n1 = len(STUB.script)
        _send(page, say2, n1)
        _wait_settled(page, reply2)
        _expect_once(page, [(USER_BUBBLE, say2), (AI_BUBBLE, reply2)], "after the outage")
        browser.close()


def _step(step, of, text, kind="veto-ceremony"):
    return {"kind": "ceremony-step", "id": f"{kind}-{step}", "binding": False, "text": text,
            "ceremony": {"kind": kind, "step": step, "of": of, "stepId": f"{kind}-{step}"}}


@pytest.mark.browser
@pytest.mark.flaky(reruns=0)
def test_phone_viewport_a_ceremony_step_that_advanced_while_the_socket_was_down_shows_after_reconnect(_stack):  # noqa: F811
    """The pollers are off while a socket is live and the edge pings die with the socket, so a ceremony card changed during an outage must be re-read on reconnect."""
    import json
    from playwright.sync_api import sync_playwright

    _session(_stack, "orw308-ceremony")
    with sync_playwright() as pw:
        browser = _launch(pw)
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        ctx.add_init_script(_WS_INIT)
        page = ctx.new_page()
        away = {"pending": None}

        def status(route):
            real = route.fetch()
            body = real.json()
            if away["pending"]:
                body["pending"] = away["pending"]     # the engine moved to a ceremony step while we were away
            route.fulfill(response=real, body=json.dumps(body), content_type="application/json")

        page.route("**/api/orwell/status", status)
        page.goto(_stack["fe"] + "/", wait_until="load")
        _wait_live(page)
        assert page.query_selector(".odec-watch") is None
        away["pending"] = _step(2, 3, "The host reads the veto result aloud.")
        _kill_sockets(page)                              # the drop; the step advanced during the outage
        page.wait_for_selector(".odec-watch", timeout=20000)   # reconnect -> one refresh through the dispatcher -> the card mounts
        card = page.evaluate("() => { const c = document.querySelector('.odec-watch'); return { step: c.dataset.step, role: c.getAttribute('role'), n: document.querySelectorAll('.odec-watch').length }; }")
        assert card == {"step": "2", "role": "group", "n": 1}, card
        browser.close()
