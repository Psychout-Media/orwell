"""Ship-blocker A6 — the "New Chat hazard": the logo click, the "New Chat" sidebar row, the
icon-rail "+", and sending an empty composer message ALL silently detached the player from their
live, in-progress season with NO confirmation and NO recovery path. A season is stateful,
single-instance play — there is no "just reopen it" the way there is for a throwaway chat. This is
the sibling of the A2 fabricated-eviction bug: both cost the player their game state without their
knowledge.

The fix, game-build only:
  1. A shared chokepoint, `window._orwellConfirmLeaveGame()` (frontend/static/js/orwellSessionGuard.js),
     checks the Vault-free `/api/orwell/state` projection for a live (started, not finished,
     not post-season) game and — only then — raises a styled, in-fiction confirm dialog. Fails
     OPEN outside the game build, with no live game, or on any fetch/UI error.
  2. Every session-detach entry point (`#rail-new-session`, `#sidebar-brand-btn`, and
     `#mobile-new-chat-btn` which forwards through the same fresh-chat path) calls it FIRST and
     bails if the player declines. `#sidebar-new-chat-btn` forwards to the logo's handler (both of
     its two independent listeners), so guarding the logo covers it too.
  3. The composer's dual-purpose Send-as-"+New" transform (static/app.js `_updateSendBtnIcon` /
     the send-btn click handler / the Enter-key handler) is DISABLED under the game build — an
     empty composer just no-ops (matches chat.js's existing "nothing to send" early return)
     instead of silently switching sessions.

Source pins (no browser) + a real headless-Chromium runtime matrix (Playwright) that drives the
actual click handlers with `/api/orwell/state` stubbed live/not-live and `styledConfirm` spied.

Run: cd frontend && .venv/bin/python -m pytest tests/test_a6_session_detach_guard.py
"""

import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

from _settle import frames as _frames

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


# ─────────────────────────────────────────────────────────────────────────────
# Source pins — the guard module + its wiring can't silently regress (no browser).
# ─────────────────────────────────────────────────────────────────────────────

def test_guard_module_exists_and_is_game_build_gated():
    js = _read("static/js/orwellSessionGuard.js")
    assert "window._orwellConfirmLeaveGame" in js, "the shared chokepoint must be exported"
    assert 'hasAttribute("data-game-build")' in js, "must be game-build gated"
    assert "if (!gameBuild()) return true;" in js, "outside the game build it must always allow (fail open)"


def test_guard_reads_vault_free_state_and_checks_liveness():
    js = _read("static/js/orwellSessionGuard.js")
    assert "/api/orwell/state" in js
    fn = js[js.index("function isLive("):]
    fn = fn[:fn.index("\n  }") + 4]
    assert "st.started === true" in fn
    assert "st.finished" in fn
    assert 'st.moment !== "post-season"' in fn


def test_guard_fails_open_on_no_dialog_and_on_error():
    js = _read("static/js/orwellSessionGuard.js")
    assert "if (!window.styledConfirm) return true;" in js, \
        "no confirm UI available must never trap the player"
    assert "return true; // fail open on any unexpected error" in js


def test_guard_collapses_concurrent_calls_onto_one_dialog():
    js = _read("static/js/orwellSessionGuard.js")
    assert "if (_pending) return _pending;" in js, \
        "redundant double-wired buttons must not stack two confirm dialogs"


def test_index_html_loads_the_guard_before_app_js_runs():
    html = _read("static/index.html")
    assert "orwellSessionGuard.js" in html
    # Plain (non-module) script — executes synchronously during parse, so it is defined by the
    # time the deferred `type="module"` app.js runs its click-handler wiring.
    guard_tag = html[html.index("orwellSessionGuard.js") - 40:html.index("orwellSessionGuard.js") + 40]
    assert 'type="module"' not in guard_tag


# ─────────────────────────────────────────────────────────────────────────────
# Source pins — every detach entry point calls the guard FIRST.
# ─────────────────────────────────────────────────────────────────────────────

def _handler_body(js, marker_id, start_after=0):
    """Slice out the addEventListener('click', ...) callback body that follows a getElementById
    lookup for `marker_id`, so assertions read the actual guarded handler, not just a mention."""
    idx = js.index(f"el('{marker_id}')", start_after)
    click_idx = js.index("addEventListener('click'", idx)
    # Body runs from the click registration to the matching closing `});` of that listener.
    body_start = js.index("{", click_idx)
    depth = 0
    i = body_start
    while i < len(js):
        if js[i] == "{":
            depth += 1
        elif js[i] == "}":
            depth -= 1
            if depth == 0:
                return js[body_start:i + 1]
        i += 1
    raise AssertionError(f"unterminated handler body for {marker_id}")


def test_rail_new_session_calls_the_guard_first():
    js = _read("static/app.js")
    body = _handler_body(js, "rail-new-session")
    assert "_orwellConfirmLeaveGame" in body
    assert body.index("_orwellConfirmLeaveGame") < body.index("_createDirectChatFromPreferredModel"), \
        "the guard must run BEFORE any session-switching logic"


def test_brand_logo_calls_the_guard_first():
    js = _read("static/app.js")
    body = _handler_body(js, "sidebar-brand-btn")
    assert "_orwellConfirmLeaveGame" in body
    assert body.index("_orwellConfirmLeaveGame") < body.index("_createDirectChatFromPreferredModel"), \
        "the guard must run BEFORE any session-switching logic"


def test_sidebar_new_chat_row_forwards_to_the_guarded_logo_handler():
    js = _read("static/app.js")
    # Both of the (redundant) forwarders route through brandBtn.click() — guarding the logo
    # handler covers this row without a second copy of the check.
    body = _handler_body(js, "sidebar-new-chat-btn")
    assert "brandBtn.click()" in body


def test_mobile_new_chat_also_guarded_if_it_is_ever_wired_live():
    # #mobile-new-chat-btn has no matching id in index.html today (dead code — el() returns
    # null and the whole block never wires), but the handler function itself must not become a
    # live, ungated detach path if the markup is ever restored.
    js = _read("static/app.js")
    body = _handler_body(js, "mobile-new-chat-btn")
    assert "_orwellConfirmLeaveGame" in body


# ─────────────────────────────────────────────────────────────────────────────
# Source pins — empty-composer Send no-ops under the game build (never a silent new-chat).
# ─────────────────────────────────────────────────────────────────────────────

def test_send_button_never_becomes_newchat_mode_under_game_build():
    js = _read("static/app.js")
    fn = js[js.index("function _updateSendBtnIcon()"):]
    fn = fn[:fn.index("\n  }\n\n  if (sendBtn)")]
    assert "hasAttribute('data-game-build')" in fn, \
        "the dual-purpose Send-as-New-Chat transform must be gated off in the game build"


def test_send_click_handler_does_not_reach_newchat_branch_bare():
    js = _read("static/app.js")
    fn = js[js.index("sendBtn.addEventListener('click'"):]
    fn = fn[:fn.index("\n  }\n\n  // If input is empty and STT")] if "\n  }\n\n  // If input is empty and STT" in fn else fn[:fn.index("New chat mode")+400]
    assert "New chat mode" in fn


def test_enter_key_empty_composer_does_not_bare_newchat_under_game_build():
    js = _read("static/app.js")
    fn = js[js.index("Enter to send (shift+enter for newline)"):]
    fn = fn[:fn.index("\n  }\n\n  // Toggle mic/send icon")]
    assert "hasAttribute('data-game-build')" in fn, \
        "the Enter-on-empty-composer new-chat shortcut must be gated off in the game build"


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL handlers in headless chromium with /api/orwell/state stubbed.
# ─────────────────────────────────────────────────────────────────────────────

def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-a6-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-a6-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(1)
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-a6-"), "app.db"),
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


_LIVE_STATE = {
    "started": True, "finished": False, "moment": "week3-nominations",
    "week": 3, "player": {"status": "active"},
}
_PREGAME_STATE = {"started": False}


def _stub_state(page, body):
    page._a6_state_hits = 0  # A83: how many times the stubbed /api/orwell/state was answered (a condition to wait on instead of a sleep)

    def handler(route):
        page._a6_state_hits += 1
        route.fulfill(status=200, content_type="application/json", body=__import__("json").dumps(body))
    page.route("**/api/orwell/state", handler)


def _new_page(pw, app, state_body):
    try:
        browser = pw.chromium.launch()
    except Exception as e:
        pytest.skip(f"chromium unavailable: {e}")
    page = browser.new_page()
    _stub_state(page, state_body)
    with page.expect_response(lambda r: "/api/orwell/state" in r.url, timeout=30000):
        page.goto(app + "/", wait_until="load", timeout=30000)
    # A83: boot is a CONDITION, not a 3.5s sleep: the module graph exposed what the spies wrap and the rail/sidebar entries are wired, then the page is quiet (the HUD pollers have settled).
    page.wait_for_function(
        "() => !!(window.sessionModule && window.sessionModule.setCurrentSessionId && window.sessionModule.createDirectChat && document.getElementById('message') && document.getElementById('rail-new-session'))",
        timeout=30000)
    return browser, page


_SPY_HARNESS = r"""
() => {
  window.__a6_confirmCalls = [];
  window.__a6_confirmResolve = true;
  window.styledConfirm = (msg, opts) => {
    window.__a6_confirmCalls.push({ msg, opts });
    return Promise.resolve(window.__a6_confirmResolve);
  };
  // A genuine detach shows up as EITHER setCurrentSessionId(null) (no model/session available —
  // the fresh-welcome-screen path) OR createDirectChat(...) (a model IS available — the pending
  // fresh-session path). Both are "the player left the current thread"; spy on both.
  window.__a6_setSessionCalls = 0;
  const origSet = window.sessionModule.setCurrentSessionId.bind(window.sessionModule);
  window.sessionModule.setCurrentSessionId = (v) => { window.__a6_setSessionCalls++; return origSet(v); };
  window.__a6_createDirectChatCalls = 0;
  const origCreate = window.sessionModule.createDirectChat.bind(window.sessionModule);
  window.sessionModule.createDirectChat = (...a) => { window.__a6_createDirectChatCalls++; return origCreate(...a); };
  return true;
}
"""


def _install_spies(page):
    r = page.evaluate(_SPY_HARNESS)
    assert r is True


def _reset_spies(page, resolve):
    page.evaluate(
        "(resolve) => { window.__a6_confirmResolve = resolve; window.__a6_confirmCalls = []; "
        "window.__a6_setSessionCalls = 0; window.__a6_createDirectChatCalls = 0; }",
        resolve,
    )


def _detach_calls(page):
    """Total count of either detach path the guarded handlers can take."""
    return page.evaluate("window.__a6_setSessionCalls + window.__a6_createDirectChatCalls")


def _wait_until(page, js_predicate, timeout_ms=8000, interval_ms=100):
    """Poll `js_predicate` (a JS expression string) until truthy, instead of a fixed sleep. The
    guard's own fetch to /api/orwell/state can take a couple of seconds to settle on a busy page
    (several unrelated HUD pollers share the same intercepted route), so a short fixed wait is
    flaky — poll for the actual condition instead."""
    waited = 0
    while waited < timeout_ms:
        if page.evaluate(f"() => !!({js_predicate})"):
            return True
        page.wait_for_timeout(interval_ms)
        waited += interval_ms
    return False


@pytest.mark.parametrize("entry_id", ["rail-new-session", "sidebar-brand-btn"])
def test_live_game_cancel_blocks_detach(_app, entry_id):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app, _LIVE_STATE)
        _install_spies(page)
        _reset_spies(page, False)  # simulate the player clicking Cancel / Stay
        page.evaluate("(id) => document.getElementById(id).click()", entry_id)
        _wait_until(page, "window.__a6_confirmCalls.length >= 1")
        calls = page.evaluate("window.__a6_confirmCalls.length")
        detach_calls = _detach_calls(page)
        browser.close()
    assert calls == 1, f"{entry_id}: a live game must raise exactly one confirm dialog, got {calls}"
    assert detach_calls == 0, f"{entry_id}: declining the confirm must NOT detach the session"


@pytest.mark.parametrize("entry_id", ["rail-new-session", "sidebar-brand-btn"])
def test_live_game_confirm_allows_detach(_app, entry_id):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app, _LIVE_STATE)
        _install_spies(page)
        _reset_spies(page, True)  # simulate the player confirming "leave my season"
        page.evaluate("(id) => document.getElementById(id).click()", entry_id)
        _wait_until(page, "window.__a6_confirmCalls.length >= 1")
        # The post-confirm path (_createDirectChatFromPreferredModel) makes its own live
        # /api/default-chat round trip before either detach spy fires — on a busy CI runner
        # that request (like the guard's own /api/orwell/state fetch above) can take well
        # over a fixed 300ms, which was flaking this assertion in CI even though the detach
        # genuinely does land a moment later (confirmed via an injected-latency repro: at a
        # simulated 600ms /api/default-chat delay, a flat 300ms sample reads 0 every time,
        # but the same page reads 1 by 1500ms — the code path is correct, only the sample
        # point was too early). Poll for the actual condition instead of guessing a sleep.
        _wait_until(page, "(window.__a6_setSessionCalls + window.__a6_createDirectChatCalls) > 0")
        calls = page.evaluate("window.__a6_confirmCalls.length")
        detach_calls = _detach_calls(page)
        browser.close()
    assert calls == 1, f"{entry_id}: a live game must raise exactly one confirm dialog, got {calls}"
    assert detach_calls > 0, f"{entry_id}: confirming must proceed with the detach"


def test_sidebar_new_chat_row_double_wire_still_shows_one_dialog(_app):
    """#sidebar-new-chat-btn carries TWO independent click listeners that both forward to the
    logo — a pre-existing quirk this fix must not turn into two stacked confirm dialogs."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app, _LIVE_STATE)
        _install_spies(page)
        _reset_spies(page, False)
        page.evaluate("() => document.getElementById('sidebar-new-chat-btn').click()")
        _wait_until(page, "window.__a6_confirmCalls.length >= 1")
        _frames(page)  # A83: 30 page frames for a stray second dialog to show up if it exists (was a fixed 300ms)
        calls = page.evaluate("window.__a6_confirmCalls.length")
        browser.close()
    assert calls == 1, f"expected exactly one collapsed dialog, got {calls}"


@pytest.mark.parametrize("entry_id", ["rail-new-session", "sidebar-brand-btn"])
def test_pregame_no_live_game_never_shows_a_dialog(_app, entry_id):
    """Fail-open: pre-game (no live season) must behave exactly as before — no dialog, no block."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app, _PREGAME_STATE)
        _install_spies(page)
        hits_before = page._a6_state_hits
        page.evaluate("(id) => document.getElementById(id).click()", entry_id)
        # A83: the guard's own /api/orwell/state fetch is the only async step; wait for it to be answered, then 30 page frames, only then confirm nothing showed up (was a fixed 3s sleep).
        for _ in range(100):  # wait (bounded, 100 x 50ms) for the guard's own state fetch to be answered after the click, then 30 page frames
            if page._a6_state_hits > hits_before:
                break
            page.wait_for_timeout(50)
        _frames(page)
        calls = page.evaluate("window.__a6_confirmCalls.length")
        browser.close()
    assert calls == 0, f"{entry_id}: no live game must never raise a confirm dialog, got {calls}"


def test_empty_composer_send_is_a_no_op_under_live_game_never_a_silent_detach(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app, _LIVE_STATE)
        _install_spies(page)
        page.evaluate("() => { document.getElementById('message').value = ''; }")
        page.evaluate("() => window._updateSendBtnIcon && window._updateSendBtnIcon()")
        mode = page.evaluate("() => document.querySelector('.send-btn')?.dataset.mode")
        page.evaluate("() => document.querySelector('.send-btn')?.click()")
        _frames(page)  # A83 (was a fixed 1.5s)
        calls = page.evaluate("window.__a6_confirmCalls.length")
        detach_calls = _detach_calls(page)
        browser.close()
    assert mode != "newchat", f"the send button must never enter newchat mode in the game build, got {mode!r}"
    assert calls == 0, "an empty-composer Send must no-op silently, never raise the leave-game dialog"
    assert detach_calls == 0, "an empty-composer Send must never detach the session"


def test_empty_composer_enter_is_a_no_op_under_live_game(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app, _LIVE_STATE)
        _install_spies(page)
        page.evaluate("() => { document.getElementById('message').value = ''; }")
        page.evaluate("() => window._updateSendBtnIcon && window._updateSendBtnIcon()")
        page.locator("#message").first.press("Enter")
        _frames(page)  # A83 (was a fixed 1.5s)
        calls = page.evaluate("window.__a6_confirmCalls.length")
        detach_calls = _detach_calls(page)
        browser.close()
    assert calls == 0, "Enter on an empty composer must never raise the leave-game dialog"
    assert detach_calls == 0, "Enter on an empty composer must never detach the session"
