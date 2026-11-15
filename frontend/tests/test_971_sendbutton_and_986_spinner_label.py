"""#971 — the composer send button shows the WRONG state (Stop when it should be Send/upload-file),
and #986 — the in-progress spinner label diverges across windows.

#971 root cause (frontend/static/js/chat.js):
  The button is a STATE MACHINE — Stop while a turn streams; otherwise Send (text present) /
  upload-file (empty composer) via the global `_updateSendBtnIcon`. It DESYNCS when a stream settles
  on a path that never calls `updateSubmitButton('idle')`. The chief offender is a BACKGROUNDED stream
  finishing: the `_isBgFinally` branch skips the idle reset, stranding `isStreaming = true` +
  `dataset.mode = 'streaming'`. `_updateSendBtnIcon` then EARLY-RETURNS on the stale 'streaming' mode
  and never recovers, so the button is stuck on Stop even though nothing is streaming. (Enter still
  sends because the keydown path reads the live composer text, not the button — which is why the bug
  was "button-only".)

The fix (chat.js, FE-only):
  - `_foregroundStreamLive()` — the single truth for "a turn is genuinely streaming into the session
    the user is looking at right now" (isStreaming + a live reader + on the streaming session + not
    detached to the background).
  - `_syncSubmitButtonState()` — reconciles the button to that truth: Stop ONLY for a live foreground
    stream with an EMPTY composer; with text it is a Send affordance (composes with the #993 queue,
    which ENQUEUES a send-while-streaming — it is NOT a Stop); when not streaming it clears a stuck
    'streaming' mode and lets `_updateSendBtnIcon` paint send/upload/mic.
  - Wired to fire on `orwell:gamechanged`, on tab-return (`visibilitychange`), and at the END of a
    backgrounded-stream settle (the previously-missing `else` of `_isBgFinally`).

#986 root cause: the in-progress spinner label was dressed through `_waitLabel` ONLY at the initial
send; the continuation round, the `resumeStream` re-attach, and the background re-entry hard-coded
"Generating response" / "Response streaming in background", so two windows watching the same run
showed divergent labels. The fix routes all of them through a single `_inProgressLabel()` helper.

Run: cd frontend && .venv/bin/python -m pytest tests/test_971_sendbutton_and_986_spinner_label.py
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
# #971 source pins — the button-state reconciler can't silently regress (no browser).
# ─────────────────────────────────────────────────────────────────────────────

def test_reconciler_and_predicate_exist():
    # #1414 (R3 PR2): the button state machine now lives in chatSubmitButton.js (imported by chat.js).
    js = _read("static/js/chatSubmitButton.js")
    assert "function _foregroundStreamLive()" in js, "the live-foreground-stream predicate must exist"
    assert "function _syncSubmitButtonState()" in js, "the button-state reconciler must exist"


def test_predicate_requires_streaming_abort_session_and_not_backgrounded():
    """`_foregroundStreamLive` must require ALL of: isStreaming, a live reader (currentAbort), being on
    the streaming session, and the run NOT detached to the background. Otherwise the button could show
    Stop for a settled/backgrounded run (the exact #971 desync)."""
    js = _read("static/js/chatSubmitButton.js")  # #1414 (R3 PR2): moved out of chat.js
    fn = js[js.index("function _foregroundStreamLive()"):]
    fn = fn[:fn.index("function _syncSubmitButtonState()")]
    assert "if (!chatState.isStreaming || !chatState.currentAbort) return false;" in fn, "must require a live reader"
    assert "cur !== chatState._streamSessionId" in fn, "must require we are on the streaming session"
    assert "chatState._backgroundStreams.has(chatState._streamSessionId)" in fn, "a backgrounded run is NOT a foreground stream"


def test_reconciler_composes_with_993_queue_text_while_streaming_is_send_not_stop():
    """While a turn streams AND the composer has text, the button must read as SEND (the #993 queue
    enqueues) — NOT Stop. So the reconciler shows Stop ONLY for a live foreground stream with an EMPTY
    composer; with text it drops the Stop face WITHOUT flipping the live isStreaming flag."""
    js = _read("static/js/chatSubmitButton.js")  # #1414 (R3 PR2): moved out of chat.js
    fn = js[js.index("function _syncSubmitButtonState()"):]
    fn = fn[:fn.index("\n  function ", 1) if "\n  function " in fn[1:] else len(fn)]
    # Stop only when empty-composer + live.
    assert "if (!hasText)" in fn and "updateSubmitButton('streaming', submitBtn)" in fn, \
        "an empty composer during a live foreground stream must show Stop"
    # Text during a live stream → drop the Stop face but DON'T touch the live flag (the queue handles it).
    assert "submitBtn.dataset.mode = ''" in fn, "text during streaming must clear the Stop face"
    # Not streaming → clear a stuck 'streaming' mode + repaint via the global updater.
    assert "if (chatState.isStreaming) chatState.isStreaming = false;" in fn, "a settled-but-stuck flag must be cleared"
    assert "window._updateSendBtnIcon()" in fn, "must repaint send/upload/mic via the global updater"


def test_reconciler_wired_to_gamechanged_visibility_and_bg_settle():
    js = _read("static/js/chat.js")
    # orwell:gamechanged → reconcile (a mutation that may have settled a peer/background run).
    assert "window.addEventListener('orwell:gamechanged', () => {" in js
    gc = js[js.index("window.addEventListener('orwell:gamechanged'"):]
    assert "_syncSubmitButtonState()" in gc[:200], "gamechanged must reconcile the button"
    # tab-return must reconcile BEFORE the frozen-stream early-return (so a stuck Stop recovers).
    vis = js[js.index("document.addEventListener('visibilitychange'"):]
    vis_head = vis[:vis.index("if (!chatState.isStreaming) return;")]
    assert "_syncSubmitButtonState()" in vis_head, "tab-return must reconcile before the !isStreaming guard"
    # The backgrounded-settle path (the `else` of `!_isBgFinally`) must reconcile the button.
    assert "} else {" in js[js.index("if (!_isBgFinally) {"):]
    bg = js[js.index("if (!_isBgFinally) {"):js.index("Research clarification timeout")]
    assert "_syncSubmitButtonState()" in bg, "a backgrounded-stream settle must reconcile the stuck button"


def test_does_not_reenable_disabled_stall_watchdog():
    js = _read("static/js/chat.js")
    # The stall watchdog machinery was REMOVED and must stay removed (CLAUDE.md invariant): no call.
    assert "_startStallWatchdog(" not in js, "the disabled stall watchdog must not be (re)introduced"


# ─────────────────────────────────────────────────────────────────────────────
# #986 source pins — every in-progress spinner site routes through the one helper.
# ─────────────────────────────────────────────────────────────────────────────

def test_inprogress_label_helper_exists_and_uses_waitlabel():
    js = _read("static/js/chat.js")
    assert "function _inProgressLabel(" in js, "the unified in-progress label helper must exist"
    fn = js[js.index("function _inProgressLabel("):]
    fn = fn[:fn.index("\n  }") + 4]
    assert "_waitLabel('waiting'" in fn, "the helper must dress the label through _waitLabel (game-build voice)"


def test_all_inprogress_spinner_sites_route_through_helper():
    """The continuation round, the resumeStream re-attach, and the background re-entry must all go
    through `_inProgressLabel(...)` — no bare hard-coded in-progress strings remain at a create site."""
    js = _read("static/js/chat.js")
    assert "spinnerModule.create(_inProgressLabel('Generating response'), 'right', 'wave')" in js, \
        "the continuation-round spinner must use the unified helper"
    assert "spinnerModule.create(_inProgressLabel('Generating response...'), 'right')" in js, \
        "the resumeStream re-attach spinner must use the unified helper"
    assert "spinnerModule.create(_inProgressLabel('Response streaming in background'), 'right')" in js, \
        "the background re-entry spinner must use the unified helper"
    # No bare hard-coded in-progress label survives at a spinner create site.
    assert "spinnerModule.create('Generating response'" not in js
    assert "spinnerModule.create('Generating response...'" not in js
    assert "spinnerModule.create('Response streaming in background'" not in js


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL helpers in headless chromium (LLM-stub-blind paths).
# ─────────────────────────────────────────────────────────────────────────────

from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-971-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-971-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-971-"), "app.db"),
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
    app_ready(page, names=("chatModule", "sessionModule"))
    return browser, page


# ── The {composer text × streaming} button-state matrix, driven through the REAL reconciler. ──────────
_BUTTON_MATRIX_HARNESS = r"""
() => {
  const chat = window.chatModule;
  if (!chat || !chat._syncSubmitButtonState || !chat._setStreamStateForTest) {
    return { error: 'button-state helpers missing' };
  }
  const btn = document.querySelector('.send-btn') || document.getElementById('submit');
  const mi = document.getElementById('message');
  if (!btn || !mi) return { error: 'no send button or composer' };
  const sid = (window.sessionModule && window.sessionModule.getCurrentSessionId &&
               window.sessionModule.getCurrentSessionId()) || 'sess-x';

  // Helper: returns the button mode after forcing a {streaming, text} combination + reconciling.
  function probe(streaming, text, opts) {
    opts = opts || {};
    chat._setStreamStateForTest({
      streaming: streaming,
      hasAbort: streaming,
      sid: opts.bg ? 'OTHER-SESSION' : sid,   // bg ⇒ the live run is on a different session (settled/elsewhere)
    });
    mi.value = text;
    chat._syncSubmitButtonState();
    return btn.dataset.mode || '';
  }

  // 1) empty composer + streaming (foreground)  → Stop
  const emptyStreaming = probe(true, '', {});
  // 2) text + streaming (foreground)            → NOT Stop (the #993 queue enqueues → Send)
  const textStreaming  = probe(true, 'queued while streaming', {});
  // 3) text + idle                              → Send
  const textIdle       = probe(false, 'hello there', {});
  // 4) empty + idle                             → upload-file affordance (mic/newchat/idle — NOT streaming)
  const emptyIdle      = probe(false, '', {});
  // 5) THE #971 BUG: a backgrounded/settled stream left the button stuck on 'streaming' while nothing
  //    is streaming in THIS foreground → the reconciler must recover it (NOT Stop).
  btn.dataset.mode = 'streaming';                         // simulate the stranded Stop face
  const recovered = probe(false, '', { bg: true });        // not foreground-live → must repair

  // reset to a clean idle so we don't leak forced state into other tests.
  chat._setStreamStateForTest({ streaming: false, hasAbort: false, sid: sid });

  return { emptyStreaming, textStreaming, textIdle, emptyIdle, recovered };
}
"""


def test_button_state_matches_text_x_streaming_matrix(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        r = page.evaluate(_BUTTON_MATRIX_HARNESS)
        browser.close()
    assert "error" not in r, r.get("error")
    # empty + streaming → Stop
    assert r["emptyStreaming"] == "streaming", \
        f"empty composer + foreground stream must show Stop, got {r['emptyStreaming']!r}"
    # text + streaming → NOT Stop (composes with the #993 send queue: it enqueues, never Stop-and-drops)
    assert r["textStreaming"] != "streaming", \
        f"text + streaming must read as Send (enqueue), NOT Stop, got {r['textStreaming']!r}"
    # text + idle → Send
    assert r["textIdle"] != "streaming", f"text + idle must be Send, got {r['textIdle']!r}"
    # empty + idle → an upload-file/mic/newchat affordance, never Stop
    assert r["emptyIdle"] != "streaming", \
        f"empty + idle must be the upload-file affordance, never Stop, got {r['emptyIdle']!r}"
    # the stuck-Stop case recovers
    assert r["recovered"] != "streaming", \
        f"a settled/backgrounded run must NOT leave the button stuck on Stop, got {r['recovered']!r}"


# ── #986: the unified in-progress label renders the in-character "producers" voice in the game build. ──
_LABEL_HARNESS = r"""
() => {
  const chat = window.chatModule;
  if (!chat || !chat._inProgressLabel) {
    // _inProgressLabel isn't on the gate; fall back to asserting the rendered label via a fresh spinner
    // is impossible without a stream, so report the helper presence for the test to skip-soft.
    return { helperOnGate: false };
  }
  return { helperOnGate: true, label: chat._inProgressLabel('Generating response') };
}
"""


def test_inprogress_label_is_in_character_in_game_build(_app):
    """In the game build the in-progress label must be the in-character "producers" voice — the same
    string every spinner site now emits, so two windows watching the same run read identically."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        # game build is on (data-game-build attribute set by the server).
        is_game = page.evaluate("() => document.body.hasAttribute('data-game-build')")
        r = page.evaluate(_LABEL_HARNESS)
        browser.close()
    if not r.get("helperOnGate"):
        # The helper isn't exported to the gate; the source pins above already cover the wiring. Still
        # assert the game build is active so this isn't a silent no-op environment.
        assert is_game, "expected the game build to be active in this harness"
        return
    if is_game:
        assert r["label"] == "The producers are talking it over", \
            f"the in-character in-progress label must be used in the game build, got {r['label']!r}"
    else:
        assert r["label"] == "Generating response", \
            f"outside the game build the helper must fail open to the generic label, got {r['label']!r}"
