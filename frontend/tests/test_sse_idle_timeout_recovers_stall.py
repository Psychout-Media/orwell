"""SSE/poll fallback — a mid-stream stall must ABORT + recover, never freeze the turn forever.

The SECOND reproducible live-play freeze (the follow-up to the WS-orphaned-pending freeze fixed in
PR #1718). On the SSE/poll fallback transport in `frontend/static/js/chat.js` the whole-turn abort was
a ONE-SHOT: `clearResponseTimeout()` fired on the FIRST stream activity and permanently disarmed the
timer. So a mid-stream SSE stall (the server stops emitting deltas partway through a turn) left
`await reader.read()` blocked FOREVER with `chatState.isStreaming` stuck true — the same reload-forcing
freeze as the WS one, only partially mitigated by the `visibilitychange` tab-recovery (which needs a
manual tab switch to fire).

The fix converts that abort from a one-shot-cleared timer into an ACTIVITY-RESET IDLE timer
(`_makeStreamIdleGuard`): `.activity()` (re)arms the countdown on stream START and on EVERY subsequent
delta/tool event, so it fires only after a genuine IDLE gap. A long-but-ACTIVE agent turn keeps
resetting it and is never tripped (the false-positive the one-shot-clear originally avoided); only real
silence aborts, driving the SAME recovery the turn already has (abort → catch → reconcile → finally
resets `isStreaming` + re-enables the composer).

Driven against the REAL `_makeStreamIdleGuard` extracted from chat.js and run in Node with a controllable
fake clock. Roles only; no names.
"""
import os
import re
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static", "js")


def _read(*parts):
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


def _extract_fn(src: str, name: str):
    """Slice out a top-level `function <name>(...) { ... }` by brace-matching (comment/string aware).
    Returns None if absent (the pre-fix FAILING state — the guard does not exist yet)."""
    start = src.find(f"function {name}(")
    if start < 0:
        return None
    brace = src.find("{", start)
    if brace < 0:
        return None
    depth = 0
    i = brace
    in_str = None
    in_line_comment = False
    in_block_comment = False
    while i < len(src):
        ch = src[i]
        nxt = src[i + 1] if i + 1 < len(src) else ""
        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
        elif in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
                i += 1
        elif in_str:
            if ch == "\\":
                i += 1
            elif ch == in_str:
                in_str = None
        elif ch == "/" and nxt == "/":
            in_line_comment = True
            i += 1
        elif ch == "/" and nxt == "*":
            in_block_comment = True
            i += 1
        elif ch in ("'", '"', "`"):
            in_str = ch
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return src[start : i + 1]
        i += 1
    return None


_HARNESS = r"""
function assert(c, m) { if (!c) { throw new Error("ASSERT: " + m); } }

// ── controllable fake clock ────────────────────────────────────────────────
let now = 0;
let timers = [];
let nextId = 1;
global.setTimeout = (fn, ms) => { const id = nextId++; timers.push({ id, at: now + (ms || 0), fn }); return id; };
global.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
function advance(ms) {
  const target = now + ms;
  while (true) {
    const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at);
    if (!due.length) break;
    const t = due[0];
    timers = timers.filter((x) => x.id !== t.id);
    now = t.at;
    t.fn();
  }
  now = target;
}

// ── the REAL guard, extracted from chat.js ─────────────────────────────────
__GUARD_SRC__
globalThis._makeStreamIdleGuard = _makeStreamIdleGuard;

const IDLE = 120000; // the chat-mode idle bound (DEFAULT_TIMEOUT_MS); agent/research is more generous still

// ── case 1: a mid-stream STALL (no activity after the first delta) must ABORT within the idle bound ──
(function () {
  let fired = 0;
  const g = _makeStreamIdleGuard(IDLE, () => { fired++; });
  g.activity();                 // stream START (also bounds the pre-first-token wait, as before)
  g.activity();                 // FIRST delta arrives — pre-fix this permanently DISARMED the timer
  advance(IDLE - 1);
  assert(fired === 0, "must not abort before the idle bound elapses");
  advance(2);                   // cross the idle bound with the stream gone silent
  assert(fired === 1,
    "FREEZE: a mid-stream stall did NOT abort — the one-shot-cleared timer left reader.read() blocked " +
    "forever (isStreaming stuck true, must-reload freeze). The idle timer must fire after the idle gap.");
})();

// ── case 2: a LONG-but-ACTIVE stream (deltas well past the old one-shot point) must NEVER abort ──────
(function () {
  let fired = 0;
  const g = _makeStreamIdleGuard(IDLE, () => { fired++; });
  g.activity();                 // stream START
  // 20 rounds of activity at 60s gaps = 20 minutes of a legitimately slow agent turn, each gap < idle.
  for (let i = 0; i < 20; i++) {
    advance(IDLE / 2);
    assert(fired === 0, "a long-but-active stream must NEVER trip the idle abort (active cycle " + i + ")");
    g.activity();               // each delta RESETS the countdown (the false-positive the one-shot avoided)
  }
  advance(IDLE + 1);            // now the stream genuinely goes silent
  assert(fired === 1, "once activity stops, a real idle gap must still abort + recover");
})();

// ── case 3: disarm() is the permanent turn-end clear (finally / WS handoff / refusal) ────────────────
(function () {
  let fired = 0;
  const g = _makeStreamIdleGuard(IDLE, () => { fired++; });
  g.activity();
  g.disarm();
  advance(IDLE * 3);
  assert(fired === 0, "disarm() must permanently stop the idle abort once the turn has settled");
  g.activity();                 // activity after disarm is a no-op (turn is over)
  advance(IDLE * 3);
  assert(fired === 0, "activity() after disarm() must not re-arm the idle abort");
})();

console.log("OK");
process.exit(0);
"""


def test_stream_idle_guard_aborts_stall_but_not_active_turn():
    """The REAL `_makeStreamIdleGuard` from chat.js: a mid-stream stall aborts within the idle bound
    (recovering the turn), a long-but-active stream never does (activity resets the countdown), and
    disarm() is the permanent turn-end clear. Pre-fix the guard does not exist (the abort was a
    one-shot-cleared timer) and the extraction fails — the FAILING-first proof."""
    node = shutil.which("node") or (
        "/opt/node22/bin/node" if os.path.exists("/opt/node22/bin/node") else None
    )
    if not node:
        pytest.skip("node not available for the behavioral idle-guard check")

    guard_src = _extract_fn(_read("static", "js", "chat.js"), "_makeStreamIdleGuard")
    assert guard_src is not None, (
        "FREEZE: chat.js has no `_makeStreamIdleGuard` — the whole-turn abort is still a one-shot-cleared "
        "timer, so a mid-stream SSE stall leaves reader.read() blocked forever (must-reload freeze). "
        "Convert the abort into an activity-reset idle timer."
    )

    harness = _HARNESS.replace("__GUARD_SRC__", guard_src)
    proc = subprocess.run(
        [node, "-e", harness],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, f"node failed: {proc.stdout}\n{proc.stderr}"
    assert "OK" in proc.stdout


def test_reader_loop_resets_idle_timer_on_activity_not_one_shot_clear():
    """Source-contract: the SSE reader-loop activity site must RESET the idle countdown on each delta/
    tool event (`resetIdleTimeout()`), not permanently disarm it. The idle guard must be wired into the
    turn, and the permanent-disarm sites (WS handoff, refusal, the stream-end finally) go through
    `clearResponseTimeout` (now backed by the guard's `.disarm()`)."""
    src = _read("static", "js", "chat.js")

    assert "_makeStreamIdleGuard(" in src, "the idle guard must be constructed for the turn"
    assert "resetIdleTimeout" in src, "an activity-reset entry point must exist"

    # The delta / tool-event activity site (the old one-shot clear) must now RESET, not disarm. Grab
    # the block from the activity condition to its `clearProcessingProbe()` sibling and assert the
    # activity call is the idle RESET, not the permanent `clearResponseTimeout()` one-shot.
    m = re.search(
        r"json\.type === 'research_progress'(?: \|\| json\.type === 'keepalive')?\)\s*\{(.*?)clearProcessingProbe\(\);",  # ORW-408: the keepalive event also counts as stream activity
        src, re.DOTALL,
    )
    assert m, "could not locate the reader-loop activity site (json.delta || ... || research_progress)"
    block = m.group(1)
    assert "resetIdleTimeout();" in block, (
        "the reader-loop activity site must call resetIdleTimeout() to re-arm the idle countdown"
    )
    assert "clearResponseTimeout()" not in block, (
        "the reader-loop activity site must NOT permanently disarm the timer (the one-shot-clear bug "
        "that leaves a mid-stream stall unbounded); it must RESET the idle countdown instead"
    )
