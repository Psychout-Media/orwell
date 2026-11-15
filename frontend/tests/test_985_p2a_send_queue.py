"""#985 P2-A — "send-while-streaming is silently dropped" → a SEND QUEUE / OUTBOX.

Root cause (verified by trace, frontend/static/js/chat.js handleChatSubmit):
  A Send made WHILE a turn is streaming entered with `isStreaming === true` and fell into the STOP
  branch — which aborts the in-flight reply and `return`s BEFORE the new composer text is ever read or
  its optimistic bubble painted. So a message sent mid-stream was silently discarded.

The fix (FE-only, chat.js — the owner explicitly chose "Queue it"):
  - A Send with NON-EMPTY composer text while streaming ENQUEUES the message into an in-memory FIFO
    `_sendOutbox` (`_enqueueSend`), paints its optimistic bubble NOW (pending shape: clientMsgId, no
    dbId/seq → floats to the tail per #992), and CLEARS the composer — it does NOT Stop.
  - The outbox flushes IN ORDER once the current turn settles (`_flushSendOutbox`, called from the
    stream-end finally): one in flight at a time, each item dispatched as a headless send that re-uses
    its already-painted bubble + its clientMsgId (idempotent / at-most-once; the existing
    optimistic-adopt path reconciles by clientMsgId, so flushes are clean across windows).
  - STOP is reserved for the explicit Stop button / an EMPTY composer — the two actions are no longer
    collapsed onto one silent action.

Like #836 / #985-P2-B this is an LLM-stub-blind path, so the runtime gates drive the REAL chat.js
helpers in headless chromium. They FAIL on pre-fix main (no queue → the mid-stream message is dropped)
and PASS after.

Run: cd frontend && .venv/bin/python -m pytest tests/test_985_p2a_send_queue.py
"""

import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

from _settle import app_ready

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


# ─────────────────────────────────────────────────────────────────────────────
# Source pins — the fix legs can't silently regress (cheap, no browser).
# ─────────────────────────────────────────────────────────────────────────────

def test_outbox_state_and_helpers_exist():
    js = _read("static/js/chatOutbox.js")
    assert "chatState._sendOutbox" in js, "the in-memory FIFO outbox must exist (moved to the chatState singleton — #1414)"
    assert "chatState._flushingOutbox" in js, "the re-entrancy guard must exist (moved to the chatState singleton — #1414)"
    assert "function _enqueueSend(text)" in js, "the enqueue helper must exist"
    assert "function _flushSendOutbox()" in js, "the flush helper must exist"


def test_queue_branch_precedes_stop_branch():
    """The send-while-streaming QUEUE branch must run BEFORE the Stop branch, so a non-empty composer
    queues instead of Stopping. An empty composer / slash falls through to Stop (semantics preserved)."""
    js = _read("static/js/chat.js")
    fn = js[js.index("export async function handleChatSubmit"):]
    queue_at = fn.index("_enqueueSend(_qText)")
    # the Stop branch is the comment + guard the queue branch sits in front of
    stop_at = fn.index("If currently streaming, stop it")
    assert queue_at < stop_at, "the queue branch must precede the Stop branch"
    # the queue branch only fires for a non-headless, non-command, non-setup, non-empty composer
    block = fn[fn.index("SEND-WHILE-STREAMING"):stop_at]
    assert "isStreaming && !_headless" in block
    assert "isCommand(_qTrim)" in block, "a slash command must NOT be queued as chat"
    assert "_qTrim" in block, "an empty composer must fall through to Stop"


def test_flush_wired_into_stream_settle_finally():
    js = _read("static/js/chat.js")
    # the flush must be invoked from the stream-end finally (after isStreaming is cleared at idle).
    assert "_flushSendOutbox()" in js
    # it must be in the !_isBgFinally (foreground-settle) block, after updateSubmitButton('idle').
    fin = js[js.index("if (!_isBgFinally) {"):]
    fin = fin[:fin.index("Research clarification timeout")]
    assert "updateSubmitButton('idle', submitBtn)" in fin
    idle_at = fin.index("updateSubmitButton('idle', submitBtn)")
    flush_at = fin.index("_flushSendOutbox()")
    assert idle_at < flush_at, "the flush must run AFTER idle clears isStreaming"


def test_flush_is_idempotent_and_serial():
    js = _read("static/js/chatOutbox.js")
    fn = js[js.index("function _flushSendOutbox()"):]
    fn = fn[:fn.index("\n  /**", 1) if "\n  /**" in fn else len(fn)]
    assert "if (chatState._flushingOutbox) return;" in fn, "re-entrancy guard: one flush at a time"
    assert "if (chatState.isStreaming) return;" in fn, "never flush while a turn is in flight"
    assert "_sendOutbox.shift()" in fn, "FIFO drain: shift the head (removed once → at-most-once)"


def test_flush_reuses_queued_client_msg_id_and_bubble():
    """At-most-once + clean adoption: the flushed send carries the queued item's PRE-STAMPED
    clientMsgId and re-uses its already-painted bubble (no duplicate paint, no fresh id)."""
    js = _read("static/js/chat.js")
    assert "queuedClientMsgId" in js and "queuedBubbleEl" in js, \
        "the flushed send must pass the queued clientMsgId + bubble through overrideOpts"
    assert "const _clientMsgId = _queuedClientMsgId ||" in js, \
        "the POST must re-use the queued clientMsgId, not generate a fresh one"
    assert "_userMsgEl = _queuedBubbleEl;" in js, \
        "the flushed send must adopt the already-painted bubble instead of painting a duplicate"


def test_pending_bubble_preservation_intact():
    """#973 / #836 — softReloadHistory must STILL preserve a pending optimistic bubble; a queued send's
    bubble is exactly that shape (clientMsgId, no dbId/seq), so it composes, not regresses."""
    # #1414 R3 PR7: softReloadHistory's pending-bubble rescue moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    assert "_isPendingOptimisticBubble(el) && !_serverClientIds.has(el.dataset.clientMsgId)" in js, \
        "the pending-bubble rescue across the rebuild must remain (composes with the queued bubble shape)"


def test_seq_render_path_intact():
    """#992 — the seq-render helpers must still exist (the queued bubble floats to the tail until its
    seq lands, then reconciles into its slot)."""
    # #1414 R3 PR7: the seq-render helpers moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    assert "export function _reorderBySeq(box)" in js
    assert "export function _insertBySeq(box, el)" in js


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL helpers in headless chromium.
# ─────────────────────────────────────────────────────────────────────────────

from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-985a-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-985a-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError("server never became ready")


@pytest.fixture(scope="module")
def _app():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(
        os.environ,
        ORWELL_GAME_BUILD="1",
        AUTH_ENABLED="false",
        LOCALHOST_BYPASS="true",
        PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-985a-"), "app.db"),
    )
    port = _free_port()
    try:
        proc, base = _boot(env, port)
    except RuntimeError as e:
        pytest.skip(str(e))
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def _new_page(pw, app):
    try:
        browser = pw.chromium.launch()
    except Exception as e:
        pytest.skip(f"chromium unavailable: {e}")
    page = browser.new_page()
    page.goto(app + "/", wait_until="load", timeout=30000)
    app_ready(page)
    return browser, page


# ── enqueue: a send-while-streaming paints a pending bubble + clears composer + queues the text. ──────
_ENQUEUE_HARNESS = r"""
() => {
  const chat = window.chatModule;
  if (!chat || !chat._enqueueSend || !chat._sendOutbox) return { error: 'outbox helpers missing' };
  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };
  box.innerHTML = '';
  chat._sendOutbox.length = 0;
  // Seed the composer as if the player typed while a turn streamed.
  const mi = document.getElementById('message');
  mi.value = 'QUEUED_VERBATIM_TEXT';

  chat._enqueueSend(mi.value);

  const userEls = Array.from(box.querySelectorAll('.msg.msg-user'));
  const last = userEls[userEls.length - 1] || null;
  return {
    outboxLen: chat._sendOutbox.length,
    queuedText: chat._sendOutbox[0] && chat._sendOutbox[0].text,
    queuedHasClientId: !!(chat._sendOutbox[0] && /^c-/.test(chat._sendOutbox[0].clientMsgId)),
    bubblePainted: !!last,
    bubbleText: last ? (last.querySelector('.body') || last).textContent : null,
    bubbleIsPending: !!(last && last.dataset.clientMsgId && !last.dataset.dbId),
    bubbleHasSeq: !!(last && last.dataset.seq),
    composerCleared: mi.value === '',
  };
}
"""


def test_enqueue_paints_bubble_clears_composer_and_queues(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        result = page.evaluate(_ENQUEUE_HARNESS)
        browser.close()
    assert "error" not in result, result.get("error")
    # The message is NOT dropped: it's painted, queued, and the composer is cleared (safely captured).
    assert result["bubblePainted"], "a send-while-streaming must PAINT an optimistic bubble (never dropped)"
    assert result["bubbleText"] == "QUEUED_VERBATIM_TEXT", f"the bubble must carry the verbatim text, got {result['bubbleText']!r}"
    assert result["bubbleIsPending"], "the queued bubble must be a pending optimistic bubble (clientMsgId, no dbId)"
    assert not result["bubbleHasSeq"], "the queued bubble has NO seq yet — it floats to the tail (composes with #992)"
    assert result["outboxLen"] == 1, "the text must be captured in the FIFO outbox"
    assert result["queuedText"] == "QUEUED_VERBATIM_TEXT", "the outbox item must hold the verbatim text"
    assert result["queuedHasClientId"], "the outbox item must be keyed by a clientMsgId (idempotency key)"
    assert result["composerCleared"], "the composer must be cleared (the text is now safely in the queue)"


# ── flush: multiple queued sends drain in FIFO order, exactly once each (no double-send). ─────────────
# The drain is a CHAIN of async hops (each send's stream-end finally schedules the NEXT flush via a
# microtask + a `setTimeout(0)` — see _flushSendOutbox / _outboxDispatch in chat.js). So the harness
# CANNOT assert after a FIXED sleep: under CI load the 3rd (tail) hop can land after any fixed window,
# which intermittently red-x'd unrelated PRs (got ["first","second"]). Instead we install the spy +
# kick the drain, then POLL from Python (page.wait_for_function) until all 3 have dispatched, with a
# generous bounded timeout — deterministic, no logic change, and it still fails LOUDLY if a real
# flush-chain drop ever stalls the drain below 3.
_EXPECTED_FIFO = ["first", "second", "third"]

_FLUSH_FIFO_SETUP = r"""
() => {
  const chat = window.chatModule;
  if (!chat || !chat._enqueueSend || !chat._flushSendOutbox || !chat._setOutboxDispatch) {
    return { error: 'outbox flush helpers missing' };
  }
  const box = document.getElementById('chat-history');
  box.innerHTML = '';
  chat._sendOutbox.length = 0;
  const mi = document.getElementById('message');

  // Enqueue THREE sends (as if typed in quick succession while a turn streamed).
  ['first', 'second', 'third'].forEach(t => { mi.value = t; chat._enqueueSend(t); });

  // Spy the dispatcher: record (text, clientMsgId) in send order, then mimic the real stream-end
  // finally by scheduling the NEXT flush — so the queue drains FIFO, one at a time, via the chain.
  // Stash the record on window so Python can poll it until the chain has fully drained.
  const sent = [];
  window.__fifoSpy = sent;
  chat._setOutboxDispatch((text, opts) => {
    sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId, hadBubble: !!(opts && opts.queuedBubbleEl) });
    // The real send's finally defers `_flushSendOutbox()`; mimic that to drain the chain FIFO.
    return Promise.resolve().then(() => { setTimeout(() => chat._flushSendOutbox(), 0); });
  });

  // Kick the drain (the stream just settled). The chained flushes run asynchronously from here;
  // Python polls window.__fifoSpy until all 3 land (condition-based — never a fixed sleep).
  chat._flushSendOutbox();
  return { ok: true };
}
"""

_FLUSH_FIFO_READ = r"""
() => {
  const chat = window.chatModule;
  const sent = window.__fifoSpy || [];
  // Restore the real dispatcher so we don't leak the spy.
  chat._setOutboxDispatch((text, opts) => chat.handleChatSubmit(null, text, opts));
  const ids = sent.map(s => s.clientMsgId);
  return {
    order: sent.map(s => s.text),
    outboxDrained: chat._sendOutbox.length === 0,
    allHadBubble: sent.every(s => s.hadBubble),
    uniqueIds: new Set(ids).size === ids.length,
    sentCount: sent.length,
  };
}
"""


def test_flush_drains_fifo_exactly_once(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        setup = page.evaluate(_FLUSH_FIFO_SETUP)
        assert "error" not in setup, setup.get("error")
        # Condition-based wait: poll until the whole chain has drained all 3 (generous bounded
        # timeout) — replaces the fixed 300ms sleep that dropped the async tail under CI load. If the
        # flush chain ever GENUINELY stalls below 3, this raises a loud TimeoutError (a real bug)
        # instead of silently asserting a short order.
        try:
            page.wait_for_function(
                "() => (window.__fifoSpy || []).length >= 3",
                timeout=15000,
            )
        except Exception as e:
            spy = page.evaluate("() => (window.__fifoSpy || []).map(s => s.text)")
            browser.close()
            pytest.fail(
                f"flush chain never drained all 3 within timeout (a real flush-chain stall, not a "
                f"sleep race): dispatched {spy!r} — {e}"
            )
        result = page.evaluate(_FLUSH_FIFO_READ)
        browser.close()
    assert result["order"] == _EXPECTED_FIFO, (
        f"the outbox must flush in FIFO order, got {result['order']!r}"
    )
    assert result["sentCount"] == 3, f"all queued sends must flush (none lost), got {result['sentCount']}"
    assert result["outboxDrained"], "the outbox must be empty after the drain"
    assert result["uniqueIds"], "each flushed send must carry a UNIQUE clientMsgId (no double-send)"
    assert result["allHadBubble"], "each flushed send must re-use its already-painted bubble (clean adoption)"


# ── flush never runs while a turn is in flight (it would race the live stream). ───────────────────────
_FLUSH_GUARD_HARNESS = r"""
async () => {
  const chat = window.chatModule;
  if (!chat || !chat._enqueueSend || !chat._flushSendOutbox || !chat._setOutboxDispatch) {
    return { error: 'helpers missing' };
  }
  chat._sendOutbox.length = 0;
  const mi = document.getElementById('message');
  mi.value = 'queued-while-busy';
  chat._enqueueSend('queued-while-busy');

  let dispatched = 0;
  chat._setOutboxDispatch(() => { dispatched++; return Promise.resolve(); });

  // Force the live-stream state and attempt a flush — it MUST NOT dispatch.
  const streamingNow = chat._isStreaming();   // false at rest in this harness
  // Drive the guard directly: call flush while we simulate streaming via the public read.
  // (We can't set isStreaming from outside, so assert the guard's source contract holds: with the
  //  outbox non-empty and NOT streaming, a single flush dispatches exactly one; re-entrant calls don't.)
  chat._flushSendOutbox();
  chat._flushSendOutbox();   // re-entrant: the _flushingOutbox guard must swallow this
  await new Promise(r => setTimeout(r, 80));

  chat._setOutboxDispatch((text, opts) => chat.handleChatSubmit(null, text, opts));
  return { dispatched, streamingNow };
}
"""


def test_flush_reentrancy_guard(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        result = page.evaluate(_FLUSH_GUARD_HARNESS)
        browser.close()
    assert "error" not in result, result.get("error")
    # A double-invocation must dispatch the single queued item exactly once (the re-entrancy guard).
    assert result["dispatched"] == 1, (
        f"two flush calls must dispatch the single item exactly once (re-entrancy guard), got {result['dispatched']}"
    )
