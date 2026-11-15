"""Issue #873 / messaging-resilience audit F5 — DUPLICATE "received" (assistant) message dedup.

Root cause (verified by trace, chat.js):
  softReloadHistory (ADR 0008 render-and-reconcile) decided "converged → no rebuild" using ONLY the
  db-id-bearing bubbles: `renderedIds = .msg[data-db-id]` vs the server seq order. An assistant bubble
  that never received its `data-db-id` — a multi-round CONTINUATION bubble (only the first round's
  `currentHolder` is stamped on `message_saved`, chat.js ~2230) or a RESUME finalize-in-place bubble
  (chat.js ~4094 rendered via addMessage with no `_db_id`) — is an ORPHAN the id-order check cannot
  see. When a db-id'd bubble is also present (so `renderedIds.length === serverIds.length`), the check
  reported "converged" while a DUPLICATE orphan sat on screen → the dup survived every reload.

The fix (chat.js):
  (a) the resume finalize-in-place now STAMPS the captured DB id onto the canonical bubble (zero-churn
      adopt on the next reload — the streamed bubble keeps its single entrance, no rebuild);
  (b) the divergence check now ALSO requires `_visibleMsgCount(box) === visible.length` — an orphan
      (an extra visible bubble with no server counterpart) is no longer invisible, so it forces the
      authoritative seq-ordered rebuild (no-animate, scroll-preserving) that collapses the duplicate.

This is a streaming/resume reconcile path EVERY automated gate stubs the LLM for (the #822 lesson), so
the runtime check drives the REAL `softReloadHistory` over a deterministic stubbed `/api/history`
replay — it FAILS on pre-fix main (the orphan survives) and PASSES after, asserting exactly ONE
assistant bubble per persisted assistant message, correct seq order, and the reasoning/reply channel
split (reasoning never in the public body). Scenarios 1–5 from the brief are each covered below.
"""

import json
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

def test_visible_msg_count_helper_exists_and_excludes_hidden_rows():
    # #1414 R3 PR7: the orphan-aware count helper + softReloadHistory moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    assert "export function _visibleMsgCount(box)" in js, \
        "the orphan-aware count helper must exist"
    # It must EXCLUDE display:none rows (hidden tool-only continuation / skippable production cue),
    # which have no server counterpart and would otherwise spuriously force a rebuild.
    block = js[js.index("export function _visibleMsgCount(box)"):]
    block = block[:block.index("export async function softReloadHistory")]
    assert "style.display === 'none'" in block, \
        "hidden (display:none) rows must not be counted (no server message backs them)"


def test_divergence_check_is_orphan_aware():
    # #1414 R3 PR7: the divergence check lives inside softReloadHistory, moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    # The convergence decision must fold in the visible-count guard — an id-order match is NOT enough.
    # (mirror-toolturn fix: the oracle is _expectedVisibleBubbleCount(visible), NOT a raw
    # `visible.length` — a multi-round tool-rich message legitimately renders as several bubbles
    # (chatRenderer.addMessage's multi-bubble reconstruction), and the raw 1:1 count made every
    # tool-rich turn read as a permanent orphan → a destructive rebuild on every reconcile forever.
    # For plain messages the expected count degenerates to visible.length — same guard, same teeth.)
    assert "_visibleMsgCount(box) === _expectedVisibleBubbleCount(visible)" in js, \
        "the divergence check must compare visible bubble count to the server's EXPECTED bubble count"
    assert "export function _expectedVisibleBubbleCount(visible)" in js, \
        "the expected-count oracle (multi-round-aware) must exist"
    assert "const orphanFree =" in js and "const converged = orphanFree &&" in js, \
        "convergence must require orphanFree AND the id-order match"


def test_resume_finalize_stamps_db_id():
    js = _read("static/js/chat.js")
    # The resume reader captures the DB id off message_saved and carries it onto the finalized bubble.
    assert "savedDbId = json.id" in js, "resume must capture the persisted DB id"
    assert "if (savedDbId) meta_._db_id = savedDbId;" in js, \
        "the finalize-in-place bubble must be stamped with its DB id (zero-churn adopt on reload)"


def test_zero_churn_happy_path_preserved():
    # #1414 R3 PR7: softReloadHistory's converged early-return + flicker-free rebuild moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    # The converged early-return (no rebuild) must remain — the fix must not make every reload rebuild.
    assert "if (converged && !_forced) { chatState._pendingReconcile.delete(sessionId); return; }" in js
    # The rebuild must stay flicker-free (no-animate + scroll preservation).
    assert "box.classList.add('no-animate');" in js and "box.classList.remove('no-animate');" in js


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL softReloadHistory reconcile in headless chromium.
# ─────────────────────────────────────────────────────────────────────────────

from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-873-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-873-{port}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError("server never became ready")


# The in-page harness. Loaded into the booted app page; it stubs `fetch('/api/history/...')` with a
# deterministic server log, plants the DOM that the live stream/resume would leave, runs the REAL
# softReloadHistory, and reports the resulting assistant-bubble state. No live LLM, fully deterministic.
_HARNESS = r"""
async () => {
  const chat = window.chatModule;
  const sess = window.sessionModule;
  if (!chat || !chat.softReloadHistory) return { error: 'chatModule.softReloadHistory missing' };

  const SID = 'dedup-test-session';
  sess.setCurrentSessionId(SID);

  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };

  // The deterministic authoritative server log (ordered by seq), per scenario.
  const SERVER = {
    history: window.__serverHistory,
    model: 'test-model',
  };

  const _origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.indexOf('/api/history/' + SID) !== -1) {
      return new Response(JSON.stringify(SERVER), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return _origFetch(url, opts);
  };

  try {
    // Run the REAL reconcile twice (a reload, then an idempotency re-check).
    await chat.softReloadHistory(SID);
    await chat.softReloadHistory(SID);
  } finally {
    window.fetch = _origFetch;
  }

  // Count assistant bubbles per server-message db id; flag orphans (visible AI bubbles with no db id).
  const aiEls = Array.from(box.querySelectorAll('.msg.msg-ai, .msg.msg-assistant'))
    .filter(el => !(el.style && el.style.display === 'none'));
  const seenIds = aiEls.map(el => el.dataset.dbId || null);
  const orphanAi = aiEls.filter(el => !el.dataset.dbId).length;
  // The reasoning text must never appear in the PUBLIC reply body. Reasoning is rendered into a
  // collapsed `.thinking-section` accordion (the channel split) — that is NOT the public bubble, so
  // the leak check must read the body with the thinking accordion removed (a clone, non-destructive).
  const bodies = aiEls.map(el => {
    const body = el.querySelector('.body') || el;
    const clone = body.cloneNode(true);
    clone.querySelectorAll('.thinking-section').forEach(n => n.remove());
    return clone.textContent || '';
  });
  const reasoningLeak = bodies.some(t => t.indexOf('SECRET_REASONING_TOKEN') !== -1);
  // Seq order of the rendered bubbles (db-id'd) for the order assertion.
  const renderedDbIds = Array.from(box.querySelectorAll('.msg[data-db-id]')).map(el => el.dataset.dbId);
  return {
    visibleMsgCount: chat._visibleMsgCount ? chat._visibleMsgCount(box) : null,
    aiBubbleCount: aiEls.length,
    orphanAi,
    seenIds,
    reasoningLeak,
    renderedDbIds,
    bodies,
  };
}
"""


def _plant_dom(page, plant_js):
    """Plant the pre-reconcile DOM (what the live stream/resume left behind) into #chat-history.
    `box` is bound to #chat-history for the planted snippet (which references it)."""
    page.evaluate(
        "(js) => { const box = document.getElementById('chat-history'); box.innerHTML = ''; "
        "(new Function('box', js))(box); }",
        plant_js,
    )


# Each scenario: (label, server_history, plant_js builder) — plant_js builds the orphan DOM the live
# path would leave. The reconcile must converge to ONE assistant bubble per server assistant message.
def _assistant(seq, db_id, text):
    return {"role": "assistant", "id": db_id, "seq": seq,
            "content": text, "metadata": {"_db_id": db_id, "_seq": seq}}


def _user(seq, db_id, text):
    return {"role": "user", "id": db_id, "seq": seq,
            "content": text, "metadata": {"_db_id": db_id, "_seq": seq}}


# Scenario builders return (history, plant_js). plant_js runs with `box` = #chat-history in scope.
def _scn_finalize_in_place_no_dbid():
    # Scenario 1: a finalize-in-place assistant bubble with NO db-id, beside a db-id'd user bubble.
    # Server persisted 1 user + 1 assistant. Pre-fix: renderedIds=[u1] == serverIds=[u1] -> "converged"
    # while the orphan assistant bubble (no db-id) survives = the duplicate.
    hist = [_user(1, "u1", "hi"), _assistant(2, "a1", "Welcome to the house.")]
    plant = """
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-db-id="u1"><div class="body">hi</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-ai"><div class="body">Welcome to the house.</div></div>');
    """
    return hist, plant


def _scn_multiround_continuation_orphan():
    # Scenario (multi-round): round-1 bubble db-id'd (currentHolder stamp), round-2 continuation bubble
    # is an ORPHAN. Server persisted ONE assistant message (the concatenation). Pre-fix the id-order
    # check sees renderedIds=[u1,a1] == serverIds=[u1,a1] -> "converged" while the orphan survives.
    hist = [_user(1, "u1", "look around"),
            _assistant(2, "a1", "Round one narration. Round two narration.")]
    plant = """
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-db-id="u1"><div class="body">look around</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-ai" data-db-id="a1"><div class="body">Round one narration.</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-ai msg-continuation"><div class="body">Round two narration.</div></div>');
    """
    return hist, plant


def _scn_resume_after_disconnect():
    # Scenario 2: resume-after-disconnect — the resumed finalize bubble is an orphan beside the user
    # bubble. (Post-fix the resume path stamps the db-id; this models the WORST case where it didn't.)
    hist = [_user(1, "u1", "continue"), _assistant(2, "a1", "Reconnected narration line.")]
    plant = """
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-db-id="u1"><div class="body">continue</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-ai"><div class="body">Reconnected narration line.</div></div>');
    """
    return hist, plant


def _scn_peer_concurrent_write():
    # Scenario 3: a peer/device wrote concurrently — local has the user bubble + its own (orphan) AI
    # bubble, but the server log now has TWO turns in seq order. Must converge to the full ordered log
    # with no dup, correct seq order.
    hist = [_user(1, "u1", "hey"), _assistant(2, "a1", "First reply."),
            _user(3, "u2", "and you?"), _assistant(4, "a2", "Second reply.")]
    plant = """
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-db-id="u1"><div class="body">hey</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-ai"><div class="body">First reply.</div></div>');
    """
    return hist, plant


def _scn_channel_split():
    # The reasoning/reply split: the persisted assistant content carries a <think>-wrapped reasoning
    # block; after reconcile the rendered body must show the reply only, never the reasoning token.
    hist = [_user(1, "u1", "scheme"),
            _assistant(2, "a1", "<think>SECRET_REASONING_TOKEN plan</think>The public narration only.")]
    plant = """
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-db-id="u1"><div class="body">scheme</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-ai"><div class="body">The public narration only.</div></div>');
    """
    return hist, plant


def _scn_happy_zero_churn():
    # Scenario 5: the happy path — user + assistant both already db-id'd, matching the server. Must be
    # ZERO churn (no rebuild) and obviously no dup. We tag the assistant bubble with a sentinel attr;
    # a rebuild would drop it (addMessage doesn't replay it), proving the early-return fired.
    hist = [_user(1, "u1", "hi"), _assistant(2, "a1", "Hello there.")]
    plant = """
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-user" data-db-id="u1"><div class="body">hi</div></div>');
      box.insertAdjacentHTML('beforeend',
        '<div class="msg msg-ai" data-db-id="a1" data-churn-sentinel="kept"><div class="body">Hello there.</div></div>');
    """
    return hist, plant


_SCENARIOS = {
    "finalize_in_place_no_dbid": (_scn_finalize_in_place_no_dbid, 1),
    "multiround_continuation_orphan": (_scn_multiround_continuation_orphan, 1),
    "resume_after_disconnect": (_scn_resume_after_disconnect, 1),
    "peer_concurrent_write": (_scn_peer_concurrent_write, 2),
    "channel_split": (_scn_channel_split, 1),
    "happy_zero_churn": (_scn_happy_zero_churn, 1),
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-873-"), "app.db"),
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
def test_no_duplicate_received_after_reconcile(_app, scenario):
    from playwright.sync_api import sync_playwright

    builder, expected_assistant = _SCENARIOS[scenario]
    hist, plant = builder()

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        app_ready(page, names=("chatModule", "sessionModule"))
        page.evaluate("(h) => { window.__serverHistory = h; }", hist)
        _plant_dom(page, plant)
        result = page.evaluate(_HARNESS)
        browser.close()

    assert "error" not in result, result.get("error")

    # 1) Exactly one assistant bubble per persisted assistant message — no orphan, no duplicate.
    assert result["aiBubbleCount"] == expected_assistant, (
        f"[{scenario}] expected {expected_assistant} assistant bubble(s), got "
        f"{result['aiBubbleCount']} (orphans={result['orphanAi']}) — DUPLICATE received message. "
        f"bodies={result['bodies']!r}"
    )
    assert result["orphanAi"] == 0, (
        f"[{scenario}] {result['orphanAi']} db-id-less ORPHAN assistant bubble(s) survived the reconcile"
    )

    # 2) Correct seq order — the rendered db ids match the server's seq order.
    server_ids = [m["id"] for m in hist]
    assert result["renderedDbIds"] == server_ids, (
        f"[{scenario}] rendered order {result['renderedDbIds']} != server seq order {server_ids}"
    )

    # 3) Channel split holds — reasoning never reaches the public body.
    assert not result["reasoningLeak"], (
        f"[{scenario}] reasoning token leaked into a public bubble body: {result['bodies']!r}"
    )


def test_happy_path_is_zero_churn(_app):
    """The already-converged case must NOT rebuild — proven by a sentinel attribute on the assistant
    bubble that the seq-ordered rebuild (addMessage) would drop. Its survival proves the early-return."""
    from playwright.sync_api import sync_playwright

    builder, _ = _SCENARIOS["happy_zero_churn"]
    hist, plant = builder()
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        app_ready(page, names=("chatModule", "sessionModule"))
        page.evaluate("(h) => { window.__serverHistory = h; }", hist)
        _plant_dom(page, plant)
        page.evaluate(_HARNESS)
        sentinel = page.evaluate(
            "() => !!document.querySelector('#chat-history .msg-ai[data-churn-sentinel=\"kept\"]')"
        )
        browser.close()
    assert sentinel, "the converged happy path rebuilt the DOM (lost the sentinel) — NOT zero-churn"
