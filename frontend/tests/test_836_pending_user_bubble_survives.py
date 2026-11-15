"""Issue #836 / "never eat a message" — a STILL-PENDING optimistic user bubble must SURVIVE a reconcile.

Root cause (verified by trace, frontend/static/js/chat.js softReloadHistory, the #920 dedup guard):
  PR #920 made the divergence check count EVERY visible `.msg` (`_visibleMsgCount`) and rebuild from
  SERVER-ONLY history when `_visibleMsgCount(box) !== visible.length`. That is correct for an ASSISTANT
  orphan (the bug #920 fixes). But an optimistic USER send — the bubble the player just typed, carrying
  `dataset.clientMsgId` and (until adopted) NO `dataset.dbId` — is ALSO a "visible msg with no server
  counterpart" whenever its persisted row is ABSENT from THIS `/api/history` snapshot (canonical-vs-
  per-tab session adoption, an SSE reconcile racing the just-committed row, or a non-persisted/incognito
  turn). The guard then forced a full rebuild from server-only `visible` → the user's bubble was ERASED
  and never re-rendered. The owner's hard requirement: "what I put in the text box goes in the bubble —
  verbatim, EVERY TIME."

The fix (frontend/static/js/chat.js + sessions.js):
  (a) `_visibleMsgCount` EXCLUDES `_isPendingOptimisticBubble` (clientMsgId, no dbId) so a pending send
      never forces a destructive rebuild on its own; and
  (b) softReloadHistory (and the canonical-adoption selectSession swap, sessions.js ~1674) PRESERVE any
      pending bubble whose client_msg_id is absent from the snapshot across the rebuild — re-appended
      with its clientMsgId, so the next reload's adopt pass claims it with zero churn when its row lands.
  This must NOT relax the convergence logic for ASSISTANT orphans — test_873_dedup_received.py stays the
  guard for #920.

Like #873 this is an LLM-stub-blind reconcile path, so the runtime check drives the REAL
`softReloadHistory` in headless chromium over a deterministic stubbed `/api/history`. It FAILS on
pre-fix main (the pending user bubble is erased) and PASSES after.
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
# Source pins — the two fix legs can't silently regress (cheap, no browser).
# ─────────────────────────────────────────────────────────────────────────────

def test_pending_optimistic_helper_exists():
    # #1414 R3 PR7: the reconcile cluster (incl. _isPendingOptimisticBubble) moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    assert "export function _isPendingOptimisticBubble(el)" in js, \
        "the pending-optimistic-bubble predicate must exist"
    block = js[js.index("export function _isPendingOptimisticBubble(el)"):]
    block = block[:block.index("\n  }") + 3]
    assert "dataset.clientMsgId" in block and "!el.dataset.dbId" in block, \
        "a pending bubble = clientMsgId present AND dbId absent"


def test_visible_count_excludes_pending_optimistic():
    # #1414 R3 PR7: _visibleMsgCount + _isPendingOptimisticBubble moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    block = js[js.index("export function _visibleMsgCount(box)"):]
    block = block[:block.index("export function _isPendingOptimisticBubble")]
    assert "_isPendingOptimisticBubble(el)" in block, \
        "_visibleMsgCount must exclude a still-pending optimistic user send from the orphan count"


def test_softreload_preserves_pending_across_rebuild():
    # #1414 R3 PR7: softReloadHistory moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    # The rebuild must rescue pending sends whose client_msg_id is absent from the server snapshot.
    assert "_pendingToPreserve" in js, "softReloadHistory must capture pending bubbles to preserve"
    assert "for (const el of _pendingToPreserve) box.appendChild(el);" in js, \
        "rescued pending bubbles must be re-appended after the authoritative rebuild"


def test_selectsession_preserves_pending_on_canonical_swap():
    js = _read("static/js/sessions.js")
    # The canonical-adoption swap (different id → wouldWipe does not fire) must preserve pending sends too.
    assert "_pendingToPreserve" in js, "selectSession must capture pending bubbles to preserve"
    assert "chatHistory.appendChild(el)" in js, \
        "rescued pending bubbles must be re-appended after the session swap render"


def test_assistant_orphan_dedup_not_relaxed():
    # The #920 convergence guard must remain intact (no reintroduction of the duplicate-assistant bug).
    # (mirror-toolturn fix: the guard's oracle is now _expectedVisibleBubbleCount(visible) — a
    # multi-round-aware count that degenerates to visible.length for plain messages, so the #920
    # teeth are unchanged while a legitimately multi-bubble tool-rich turn stops reading as a
    # permanent orphan.)
    # #1414 R3 PR7: the orphanFree convergence guard lives inside softReloadHistory, moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    assert "const orphanFree = _visibleMsgCount(box) === _expectedVisibleBubbleCount(visible);" in js, \
        "the orphanFree convergence guard (#920, multi-round-aware) must remain"
    assert "const converged = orphanFree &&" in js


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL softReloadHistory reconcile in headless chromium.
# ─────────────────────────────────────────────────────────────────────────────

from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-836-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-836-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError("server never became ready")


# In-page harness: stub /api/history with a server log that does NOT contain the pending user turn,
# plant an optimistic user bubble (clientMsgId, no dbId), run the REAL softReloadHistory twice, and
# report whether the typed text survived.
_HARNESS = r"""
async () => {
  const chat = window.chatModule;
  const sess = window.sessionModule;
  if (!chat || !chat.softReloadHistory) return { error: 'chatModule.softReloadHistory missing' };

  const SID = 'pending-survive-session';
  sess.setCurrentSessionId(SID);

  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };

  const SERVER = { history: window.__serverHistory, model: 'test-model' };

  const _origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.indexOf('/api/history/' + SID) !== -1) {
      return new Response(JSON.stringify(SERVER), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return _origFetch(url, opts);
  };

  try {
    await chat.softReloadHistory(SID);
    await chat.softReloadHistory(SID);
  } finally {
    window.fetch = _origFetch;
  }

  const userEls = Array.from(box.querySelectorAll('.msg.msg-user'))
    .filter(el => !(el.style && el.style.display === 'none'));
  const bodies = userEls.map(el => {
    const body = el.querySelector('.body') || el;
    return (body.textContent || '');
  });
  const pendingSurvived = userEls.some(el =>
    el.dataset.clientMsgId === window.__pendingClientId && !el.dataset.dbId);
  return {
    userBubbleCount: userEls.length,
    bodies,
    pendingSurvived,
    sawTypedText: bodies.some(t => t.indexOf('VERBATIM_TYPED_TEXT') !== -1),
  };
}
"""


def _plant_dom(page, plant_js):
    page.evaluate(
        "(js) => { const box = document.getElementById('chat-history'); box.innerHTML = ''; "
        "(new Function('box', js))(box); }",
        plant_js,
    )


def _assistant(seq, db_id, text):
    return {"role": "assistant", "id": db_id, "seq": seq,
            "content": text, "metadata": {"_db_id": db_id, "_seq": seq}}


def _user(seq, db_id, text):
    return {"role": "user", "id": db_id, "seq": seq,
            "content": text, "metadata": {"_db_id": db_id, "_seq": seq}}


# Scenario builders return (history, plant_js). The PENDING user bubble carries clientMsgId, no dbId,
# and its row is ABSENT from `history` — exactly the race that erased it pre-fix.
def _scn_pending_user_absent_from_snapshot():
    # A prior committed turn (db-id'd) is in the snapshot; the player then typed a new turn whose row
    # has NOT yet reached this snapshot. The pending bubble must survive the reconcile rebuild.
    hist = [_user(1, "u1", "earlier turn"), _assistant(2, "a1", "earlier reply")]
    plant = """
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-db-id="u1"><div class="body">earlier turn</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-ai" data-db-id="a1"><div class="body">earlier reply</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-client-msg-id="c-PENDING-1"><div class="body">VERBATIM_TYPED_TEXT</div></div>');
    """
    return hist, plant, "c-PENDING-1"


def _scn_pending_user_only_empty_snapshot():
    # Worst case: nothing persisted yet (incognito / first turn pre-commit). Server returns []. The lone
    # optimistic bubble is the only content; the rebuild must not erase it.
    hist = []
    plant = """
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-client-msg-id="c-PENDING-1"><div class="body">VERBATIM_TYPED_TEXT</div></div>');
    """
    return hist, plant, "c-PENDING-1"


_SCENARIOS = {
    "pending_user_absent_from_snapshot": _scn_pending_user_absent_from_snapshot,
    "pending_user_only_empty_snapshot": _scn_pending_user_only_empty_snapshot,
}


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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-836-"), "app.db"),
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


@pytest.mark.parametrize("scenario", list(_SCENARIOS.keys()))
def test_pending_user_bubble_survives_reconcile(_app, scenario):
    from playwright.sync_api import sync_playwright

    hist, plant, pending_id = _SCENARIOS[scenario]()

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        app_ready(page, names=("chatModule", "sessionModule"))
        page.evaluate("(h) => { window.__serverHistory = h; }", hist)
        page.evaluate("(c) => { window.__pendingClientId = c; }", pending_id)
        _plant_dom(page, plant)
        result = page.evaluate(_HARNESS)
        browser.close()

    assert "error" not in result, result.get("error")

    # The owner's hard requirement: the typed text survives the reconcile, verbatim, every time.
    assert result["sawTypedText"], (
        f"[{scenario}] the player's typed text was ERASED by the reconcile rebuild — "
        f"bodies={result['bodies']!r}"
    )
    assert result["pendingSurvived"], (
        f"[{scenario}] the pending optimistic bubble (clientMsgId, no dbId) did not survive — "
        f"bodies={result['bodies']!r}"
    )
