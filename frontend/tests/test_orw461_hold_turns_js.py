"""ORW-461 (client half): an update holds new turns for the few seconds of its restart. The server refuses the turn BEFORE anything starts with a retryable `update-holding`;
the page waits ("one moment") and re-sends the SAME clientMsgId, once the hold is over, exactly once. Driven against the real orwellWs.js in Node with stubs (the
test_orw406_silent_reconnect.py idiom). Roles only."""
import importlib.util
import os
import re

import pytest

_spec = importlib.util.spec_from_file_location("silent", os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_orw406_silent_reconnect.py"))
_silent = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_silent)

_PRE = _silent._WS.split("(async function main()")[0]

_HOLD = _PRE + r"""
function turnsOn(s) { return s.sent.filter((f) => f.t === "turn"); }
(async function main() {
  await tick(); await handshake();
  // 1. a turn arrives while the update holds new turns: refused at admission, held, then sent through exactly once
  let held = 0, released = 0; const settled = [];
  WS.sendTurnWhenLive({ message: "hello", clientMsgId: "c-1" }, undefined, { onHold() { held++; }, onRelease() { released++; } }).then(() => settled.push("ok"), (e) => settled.push("ERR:" + e.code));
  await until(() => turnsOn(lastSock).length === 1, "the first turn frame");
  const t1 = turnsOn(lastSock)[0];
  down({ t: "error", ch: "chat", cid: t1.cid, d: { code: "update-holding", retryAfterMs: 500, untilMs: Date.now() + 60000 } });
  await until(() => held === 1, "onHold");
  assert(settled.length === 0, "a held turn neither resolves nor fails: " + settled.join());
  // 2. the restart itself drops the socket; the page rides it out and re-sends on the new one
  const first = lastSock; first.readyState = 3; first.onclose();
  await until(() => lastSock !== first, "the reconnect socket");
  await handshake();
  await until(() => turnsOn(lastSock).length === 1, "the held turn re-sent on the new socket");
  const t2 = turnsOn(lastSock)[0];
  assert(t2.d.clientMsgId === "c-1" && t2.d.message === "hello", "the SAME turn is re-sent, unchanged: " + JSON.stringify(t2.d));
  down({ t: "ack", ch: "chat", cid: t2.cid, d: { accepted: true } });
  await until(() => settled.length === 1, "the held turn settles");
  assert(settled[0] === "ok", "it completes: " + settled.join());
  assert(held === 1 && released === 1, "one moment shown once and released once: " + held + "/" + released);
  // exactly one ACCEPTED send: the first was refused (nothing started), the second acked
  assert(socks.reduce((n, s) => n + turnsOn(s).length, 0) === 2, "two frames in all: the refused one and the accepted one");
  // 3. other refusals are NOT swallowed by the hold wait
  const other = []; WS.sendTurnWhenLive({ message: "x", clientMsgId: "c-2" }, 2000, {}).then(() => other.push("ok"), (e) => other.push(e.code));
  await until(() => turnsOn(lastSock).length === 2, "the second turn frame");
  down({ t: "error", ch: "chat", cid: turnsOn(lastSock)[1].cid, d: { code: "forbidden" } });
  await until(() => other.length === 1, "the refusal surfaces");
  assert(other[0] === "forbidden", "a different refusal is not retried: " + other.join());
  assert(turnsOn(lastSock).length === 2, "and not re-sent");
  console.log("OK"); process.exit(0);
})();
"""

# A fake clock: every timer fires on the next macrotask and advances `now` by its delay, so a bound of minutes runs in milliseconds.
_FAKE = r"""
let now = 1000000; Date.now = () => now;
global.setTimeout = (fn, ms) => { if (ms === 60000) return 0; /* ORW-909: the turn-ack watchdog is a real-time bound, not part of the hold-wait model under test */ setImmediate(() => { now += (ms || 0); fn(); }); return 0; };
global.clearTimeout = () => {};
"""
_HOLD_BOUNDED = _PRE.replace("let lastSock = null;", _FAKE + "let lastSock = null;", 1) + r"""
function turnsOn(s) { return s.sent.filter((f) => f.t === "turn"); }
(async function main() {
  await until(() => lastSock !== null, "the first socket"); await handshake();
  // the server's hold ends 1 s from now: the wait is bounded by it (plus 30 s of slack), it never spins for ever
  const t0 = now; let n = 0; const settled = [];
  WS.sendTurnWhenLive({ message: "hello", clientMsgId: "c-1" }, undefined, {}).then(() => settled.push("ok"), (e) => settled.push(e.code));
  for (let guard = 0; guard < 400; guard++) {
    await until(() => turnsOn(lastSock).length === n + 1 || settled.length === 1, "the next frame or the end");
    if (settled.length === 1) break;
    n++; down({ t: "error", ch: "chat", cid: turnsOn(lastSock)[n - 1].cid, d: { code: "update-holding", retryAfterMs: 500, untilMs: t0 + 1000 } });
  }
  assert(settled[0] === "update-holding", "after the hold's end the refusal surfaces to the caller: " + settled.join());
  assert(n >= 2, "it retried while the hold was in force: " + n);
  assert(now - t0 <= 40000, "bounded by the server's end of the hold plus slack, not the client's own cap: " + (now - t0) + " ms");
  console.log("OK"); process.exit(0);
})();
"""


# Review of #2805: the updater holds for its turn wait (up to 300 s) plus 150 s for the restart and warm-up. A hold that long is waited out, not given up at the client's cap.
_HOLD_LONG = _PRE.replace("let lastSock = null;", _FAKE + "let lastSock = null;", 1) + r"""
function turnsOn(s) { return s.sent.filter((f) => f.t === "turn"); }
(async function main() {
  await until(() => lastSock !== null, "the first socket"); await handshake();
  const t0 = now; let n = 0; const settled = [];
  WS.sendTurnWhenLive({ message: "hello", clientMsgId: "c-1" }, undefined, {}).then(() => settled.push("ok"), (e) => settled.push(e.code));
  for (let guard = 0; guard < 400; guard++) {
    await until(() => turnsOn(lastSock).length === n + 1 || settled.length === 1, "the next frame or the end");
    if (settled.length === 1) break;
    n++;
    const cid = turnsOn(lastSock)[n - 1].cid;
    if (now - t0 < 450000) down({ t: "error", ch: "chat", cid: cid, d: { code: "update-holding", retryAfterMs: 5000, untilMs: t0 + 450000 } });
    else down({ t: "ack", ch: "chat", cid: cid, d: { accepted: true } });
  }
  assert(settled[0] === "ok", "a hold of the updater's longest length is waited out and the turn goes through: " + settled.join() + " after " + (now - t0) + " ms");
  console.log("OK"); process.exit(0);
})();
"""


def test_a_turn_held_by_an_update_is_sent_once_after_the_restart_with_the_same_id():
    _silent._run(_HOLD, "orwellWs.js")


def test_the_hold_wait_is_bounded_by_the_servers_own_end_of_the_hold():
    _silent._run(_HOLD_BOUNDED, "orwellWs.js")


def test_a_hold_as_long_as_the_updaters_longest_is_waited_out():
    _silent._run(_HOLD_LONG, "orwellWs.js")


def test_the_chat_page_shows_one_moment_and_stands_down_the_idle_abort_on_every_send_of_the_turn():
    # Review of #2805: the page's hold callbacks are run, not grepped for: "held" shows "one moment…", stands the idle-abort down (past its bound it would stop the shared
    # game session's run), and release clears the tag. The first send and the stale-beat retry both pass them.
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "static", "js")
    chat = open(os.path.join(here, "chat.js"), encoding="utf-8").read()
    outbox = open(os.path.join(here, "chatOutbox.js"), encoding="utf-8").read()
    m = re.search(r"const _holdOpts = (\{.*?\n        \});", chat, re.S)
    assert m, "chat.js builds the update-hold callbacks once, as `const _holdOpts = {...};`"
    assert chat.count("}, undefined, _holdOpts)") == 2, "both the first send and the stale-beat retry pass the hold callbacks"
    script = (
        "const tags = []; let disarmed = 0; const _userMsgEl = {};\n"
        "const _setQueuedTag = (el, mode) => tags.push(mode); const clearResponseTimeout = () => { disarmed++; };\n"
        f"const o = {m.group(1)};\n"
        "o.onHold();\n"
        "if (disarmed !== 1 || tags[0] !== 'held') { console.log('held: disarmed=' + disarmed + ' tags=' + JSON.stringify(tags)); process.exit(1); }\n"
        "o.onRelease();\n"
        "if (tags[1] !== null) { console.log('release: tags=' + JSON.stringify(tags)); process.exit(1); }\n"
        "console.log('OK');\n"
    )
    _silent._run(script, "chat.js")
    assert "'one moment…'" in outbox
