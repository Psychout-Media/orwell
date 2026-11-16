"""#985 P2 — two FE delivery/render bugs on the chat path. The BACKEND is the source of truth and is
correct ("stuff comes in out of order but the backend is tracking it fine"); the FE must render to
match the backend's authoritative `seq` order, and must surface a clean empty turn.

BUG 1 (PRIMARY) — messages render OUT OF ORDER though the server `seq` is correct.
  Root cause (verified by trace, chat.js / chatRenderer.js): `seq` is NEVER a positioning key in the
  FE. Every live insert (optimistic user send, stream holder, peer resumeStream holder) is an
  unconditional `box.appendChild(...)` — arrival order, not seq order. `addMessage` stamps `dataset.seq`
  but never positions by it. The only reorderer, `softReloadHistory`'s destructive rebuild, fires ONLY
  when DIVERGED and ONLY when idle (deferred while a stream is in flight), so a peer write racing the
  local turn (or two interleaved `message_saved`s) sits visibly out of seq order until the stream ends.

  The fix (chat.js, single choke point):
    - `_msgSeq(el)` reads `data-seq`; `_insertBySeq(box, el)` inserts at seq position (no seq ⇒ bottom);
    - `_reorderBySeq(box)` is a NON-DESTRUCTIVE in-place reorder to ascending seq (pending/no-seq bubbles
      float to the tail) that the reconcile ADOPT PASS runs on EVERY reconcile attempt — including the
      "converged" early-return AND while a stream is in flight (the `hasActiveStream` early-return is
      AFTER the adopt pass). So an out-of-seq bubble is corrected the instant its seq is known, without a
      DOM wipe. Idempotent: zero churn when already ordered.

BUG 2 (#985 P2-B) — a clean empty turn → no bubble, no Retry.
  Root cause: when the final round makes a tool call but emits no narration, `accumulated === ''`; the
  server skips the save (`if full_response:`) so NO `message_saved` is emitted; the FE hides the empty
  bubble and never offers Retry (the catch-based `_tryAutoRecover` fires only on a THROWN error — a clean
  `[DONE]` throws nothing). The user's message sits unanswered with no recourse.

  The fix (chat.js): the `_isEmptyTurnNoSave` predicate (clean `[DONE]` + no save + no other visible
  artifact + blank `accumulated` + not cancelled) renders the SAME user-controlled Retry the network-drop
  path builds (`_renderStreamDropRetry`, distinct copy) instead of silently hiding.

Both are LLM-stub-blind render paths (the #822 / #873 lesson), so the runtime gates drive the REAL
chat.js helpers in headless chromium against a deterministic stubbed `/api/history`. They FAIL on
pre-fix main and PASS after.

Run: cd frontend && .venv/bin/python -m pytest tests/test_985_render_order_and_empty_turn.py
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

def test_seq_helpers_exist():
    # #1414 R3 PR7: the seq helpers moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    assert "export function _msgSeq(el)" in js, "the seq reader must exist"
    assert "export function _insertBySeq(box, el)" in js, "the insert-by-seq choke point must exist"
    assert "export function _reorderBySeq(box)" in js, "the non-destructive seq reorder must exist"


def test_reorder_wired_into_reconcile_adopt_pass():
    """The reorder MUST run inside softReloadHistory's adopt pass — i.e. BEFORE the divergence check
    and BEFORE the `hasActiveStream` early-return — so order converges even mid-stream, non-destructively."""
    # #1414 R3 PR7: softReloadHistory + the reorder moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    fn = js[js.index("export async function softReloadHistory"):]
    fn = fn[:fn.index("export function flushPendingReconcile")] if "export function flushPendingReconcile" in fn else fn
    assert "_reorderBySeq(box)" in fn, "softReloadHistory must call _reorderBySeq"
    # ordering: the reorder call must precede the divergence-check early-return.
    reorder_at = fn.index("_reorderBySeq(box)")
    diverge_at = fn.index("DIVERGENCE CHECK")
    defer_at = fn.index("hasActiveStream(sessionId)")
    assert reorder_at < diverge_at < defer_at, \
        "the reorder must run in the adopt pass (before the divergence check + stream-defer early-return)"


def test_empty_turn_predicate_exists_and_wired():
    # #1414 R3 PR7: the _isEmptyTurnNoSave predicate DEFINITION moved to chatReconcile.js; its finalize
    # CALL SITE + the per-stream flags stay in chat.js's stream loop.
    recon = _read("static/js/chatReconcile.js")
    assert "export function _isEmptyTurnNoSave(" in recon, "the clean-empty-turn predicate must exist"
    js = _read("static/js/chat.js")
    # the finalize must consult the predicate and render the Retry control for it.
    assert "_isEmptyTurnNoSave({" in js, "the finalize must consult the empty-turn predicate"
    assert "_sawMessageSaved = true" in js, "message_saved must set the save flag"
    assert "let _sawMessageSaved = false" in js, "the save flag must be declared per-stream"
    assert "let _producedVisibleOutput = false" in js, "the visible-output flag must be declared"


def test_render_stream_drop_retry_serves_empty_turn():
    """The empty-turn path reuses the network-drop Retry control with a custom label — NOT a new
    bespoke control — so the user gets the same user-controlled recourse."""
    js = _read("static/js/chat.js")
    assert "function _renderStreamDropRetry(holder, sessionId, opts)" in js, \
        "the Retry control must accept an opts.label so the empty-turn case can reuse it"
    block = js[js.index("function _renderStreamDropRetry(holder, sessionId, opts)"):]
    block = block[:block.index("\n  }\n") + 4]
    assert "opts.label" in block, "the Retry control must honor a custom label"


def test_pending_bubble_preservation_intact():
    """#973 / #836 — softReloadHistory must still PRESERVE a pending optimistic bubble across a rebuild;
    the seq fix must not have disturbed it."""
    # #1414 R3 PR7: softReloadHistory's pending-bubble rescue moved to chatReconcile.js.
    js = _read("static/js/chatReconcile.js")
    assert "_isPendingOptimisticBubble(el) && !_serverClientIds.has(el.dataset.clientMsgId)" in js, \
        "the pending-bubble rescue across the rebuild must remain"


def test_stall_watchdog_stays_disabled():
    js = _read("static/js/chat.js")
    assert "_startStallWatchdog" not in js or "Removed FEJS-6" in js, \
        "the disabled stall watchdog must not be re-introduced"


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL helpers in headless chromium.
# ─────────────────────────────────────────────────────────────────────────────

from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-985-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(f"uvicorn exited early; see /tmp/fe-985-{port}.log")
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-985-"), "app.db"),
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


# ── BUG 1: _reorderBySeq directly — the structural guarantee, no server fetch needed. ──────────────
_REORDER_HARNESS = r"""
() => {
  const chat = window.chatModule;
  if (!chat || !chat._reorderBySeq) return { error: 'chatModule._reorderBySeq missing' };
  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };
  box.innerHTML = '';
  // Plant bubbles in WRONG arrival order: seq 3, 1, 2 — plus a pending (no-seq) optimistic send that
  // must float to the tail (newest local turn) and NOT be reordered among the seq'd bubbles.
  const mk = (cls, seq, txt, extra) => {
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    if (seq != null) d.dataset.seq = String(seq);
    if (extra) Object.assign(d.dataset, extra);
    d.innerHTML = '<div class="body">' + txt + '</div>';
    box.appendChild(d);
    return d;
  };
  mk('msg-ai', 3, 'third');
  mk('msg-user', 1, 'first');
  mk('msg-ai', 2, 'second');
  const pending = mk('msg-user', null, 'pending-newest', { clientMsgId: 'c-xyz' });
  const moved = chat._reorderBySeq(box);
  // Idempotent re-run must move nothing.
  const moved2 = chat._reorderBySeq(box);
  const order = Array.from(box.querySelectorAll('.msg')).map(el => ({
    seq: el.dataset.seq != null ? Number(el.dataset.seq) : null,
    txt: (el.querySelector('.body') || el).textContent,
  }));
  return { moved, moved2, order, pendingIsLast: box.querySelector('.msg:last-of-type') === pending };
}
"""


def test_bug1_reorder_by_seq_orders_and_is_idempotent(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        result = page.evaluate(_REORDER_HARNESS)
        browser.close()
    assert "error" not in result, result.get("error")
    # Out-of-order arrival (3,1,2) → ascending seq (1,2,3), pending floats to the tail.
    seqs = [o["seq"] for o in result["order"]]
    assert seqs == [1, 2, 3, None], f"bubbles not in seq order with pending last: {result['order']!r}"
    assert result["pendingIsLast"], "the pending optimistic send must float to the tail"
    assert result["moved"] > 0, "a real reorder must have moved nodes (the planted DOM was out of order)"
    assert result["moved2"] == 0, "the reorder must be idempotent (zero churn on the already-ordered re-run)"


# ── BUG 1: the REAL softReloadHistory reconcile converges planted out-of-seq inserts to seq order. ──
_RECONCILE_HARNESS = r"""
async () => {
  const chat = window.chatModule;
  const sess = window.sessionModule;
  if (!chat || !chat.softReloadHistory) return { error: 'softReloadHistory missing' };
  const SID = 'order-test-session';
  sess.setCurrentSessionId(SID);
  const box = document.getElementById('chat-history');
  if (!box) return { error: 'no #chat-history' };
  box.innerHTML = '';

  // The authoritative seq-ordered server log (the API orders by seq).
  const SERVER = { model: 'test-model', history: window.__serverHistory };
  const _origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.indexOf('/api/history/' + SID) !== -1) {
      return new Response(JSON.stringify(SERVER), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return _origFetch(url, opts);
  };

  // Plant the DOM the live path would leave: bubbles with db-ids but in WRONG arrival order — a peer
  // turn (u2/a2) arrived and was appended to the bottom while u1/a1 were already on screen. Plant order:
  // u1, a1, a2, u2 (the peer pair appended out of seq order at the bottom). Each carries a SENTINEL
  // attribute that a DESTRUCTIVE innerHTML rebuild (which re-renders from server history) would DROP —
  // so its survival proves the reorder was NON-DESTRUCTIVE (the structural win: order without a wipe).
  box.insertAdjacentHTML('beforeend', '<div class="msg msg-user" data-db-id="u1" data-sentinel="s"><div class="body">hey</div></div>');
  box.insertAdjacentHTML('beforeend', '<div class="msg msg-ai" data-db-id="a1" data-sentinel="s"><div class="body">First reply.</div></div>');
  box.insertAdjacentHTML('beforeend', '<div class="msg msg-ai" data-db-id="a2" data-sentinel="s"><div class="body">Second reply.</div></div>');
  box.insertAdjacentHTML('beforeend', '<div class="msg msg-user" data-db-id="u2" data-sentinel="s"><div class="body">and you?</div></div>');

  try {
    await chat.softReloadHistory(SID);
  } finally {
    window.fetch = _origFetch;
  }
  const renderedDbIds = Array.from(box.querySelectorAll('.msg[data-db-id]')).map(el => el.dataset.dbId);
  const renderedSeqs = Array.from(box.querySelectorAll('.msg[data-seq]')).map(el => Number(el.dataset.seq));
  const sentinelsKept = box.querySelectorAll('.msg[data-sentinel="s"]').length;
  return { renderedDbIds, renderedSeqs, sentinelsKept };
}
"""


def test_bug1_reconcile_renders_in_seq_order(_app):
    from playwright.sync_api import sync_playwright
    # server log in true seq order
    hist = [
        {"role": "user", "id": "u1", "seq": 1, "content": "hey", "metadata": {"_db_id": "u1", "_seq": 1}},
        {"role": "assistant", "id": "a1", "seq": 2, "content": "First reply.", "metadata": {"_db_id": "a1", "_seq": 2}},
        {"role": "user", "id": "u2", "seq": 3, "content": "and you?", "metadata": {"_db_id": "u2", "_seq": 3}},
        {"role": "assistant", "id": "a2", "seq": 4, "content": "Second reply.", "metadata": {"_db_id": "a2", "_seq": 4}},
    ]
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        page.evaluate("(h) => { window.__serverHistory = h; }", hist)
        result = page.evaluate(_RECONCILE_HARNESS)
        browser.close()
    assert "error" not in result, result.get("error")
    assert result["renderedDbIds"] == ["u1", "a1", "u2", "a2"], (
        f"planted out-of-seq DOM did not converge to server seq order: {result['renderedDbIds']!r}"
    )
    assert result["renderedSeqs"] == [1, 2, 3, 4], (
        f"rendered seqs not ascending: {result['renderedSeqs']!r}"
    )
    # The reorder corrected the order NON-DESTRUCTIVELY — the sentinels (which a destructive innerHTML
    # rebuild would drop) all survived. This proves the adopt-pass reorder, not a wipe, did the work.
    assert result["sentinelsKept"] == 4, (
        f"the seq reorder was destructive (lost {4 - result['sentinelsKept']} sentinel(s)) — expected a "
        f"non-destructive in-place reorder"
    )


# ── BUG 2: a clean empty [DONE] (no content + no save) renders the user-controlled Retry. ───────────
_EMPTY_TURN_HARNESS = r"""
() => {
  const chat = window.chatModule;
  if (!chat || !chat._isEmptyTurnNoSave || !chat._renderStreamDropRetry) {
    return { error: 'empty-turn helpers missing' };
  }
  const box = document.getElementById('chat-history');
  box.innerHTML = '';
  // Mirror the finalize: a holder that was HIDDEN because it produced no visible text.
  const holder = document.createElement('div');
  holder.className = 'msg msg-ai';
  holder.style.display = 'none';
  holder.innerHTML = '<div class="role">Orwell</div><div class="body"></div>';
  box.appendChild(holder);

  // The decision the finalize makes for a clean empty turn.
  const cleanEmpty = chat._isEmptyTurnNoSave({
    sawDone: true, sawSave: false, producedVisible: false, accumulated: '', cancelled: false,
  });
  // Negatives the predicate must reject:
  const withSave      = chat._isEmptyTurnNoSave({ sawDone: true, sawSave: true,  producedVisible: false, accumulated: '',     cancelled: false });
  const withContent   = chat._isEmptyTurnNoSave({ sawDone: true, sawSave: false, producedVisible: false, accumulated: 'hi',   cancelled: false });
  const reasoningOnly = chat._isEmptyTurnNoSave({ sawDone: true, sawSave: false, producedVisible: false, accumulated: '<think>x</think>', cancelled: false });
  const withImage     = chat._isEmptyTurnNoSave({ sawDone: true, sawSave: false, producedVisible: true,  accumulated: '',     cancelled: false });
  const cancelled     = chat._isEmptyTurnNoSave({ sawDone: true, sawSave: false, producedVisible: false, accumulated: '',     cancelled: true  });
  const noDone        = chat._isEmptyTurnNoSave({ sawDone: false,sawSave: false, producedVisible: false, accumulated: '',     cancelled: false });

  // Now render the actual Retry control the finalize calls for the empty turn.
  if (cleanEmpty) {
    chat._renderStreamDropRetry(holder, 'empty-test-session', {
      label: "The narrator didn't respond. Your message was received — retry to continue.",
    });
  }
  const retryNote = holder.querySelector('.stream-drop-retry');
  const retryBtn = retryNote && retryNote.querySelector('button.continue-btn');
  return {
    cleanEmpty, withSave, withContent, reasoningOnly, withImage, cancelled, noDone,
    holderVisibleAfter: holder.style.display !== 'none',
    hasRetryNote: !!retryNote,
    hasRetryBtn: !!retryBtn,
    retryBtnText: retryBtn ? retryBtn.textContent : null,
    noteText: retryNote ? retryNote.textContent : null,
  };
}
"""


def test_bug2_clean_empty_turn_renders_retry(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        result = page.evaluate(_EMPTY_TURN_HARNESS)
        browser.close()
    assert "error" not in result, result.get("error")
    # The predicate fires ONLY for the clean-empty-no-save case.
    assert result["cleanEmpty"] is True, "a clean [DONE] with no content + no save must be the empty-turn case"
    assert result["withSave"] is False, "a turn that persisted a message is NOT the empty-turn case"
    assert result["withContent"] is False, "a turn with content is NOT the empty-turn case"
    assert result["reasoningOnly"] is False, "a reasoning-only turn (non-blank accumulated) is NOT empty-turn"
    assert result["withImage"] is False, "a turn that produced an image is NOT the empty-turn case"
    assert result["cancelled"] is False, "a user-cancelled turn is NOT the empty-turn case"
    assert result["noDone"] is False, "a turn that never saw [DONE] (a drop) is NOT the empty-turn case"
    # The Retry control is rendered, visible, and user-controlled (a clickable button) — not hidden.
    assert result["holderVisibleAfter"], "the previously-hidden empty bubble must be made visible for the Retry"
    assert result["hasRetryNote"], "a clean empty turn must render the stream-drop-retry control"
    assert result["hasRetryBtn"], "the empty-turn recourse must include a clickable Retry button"
    assert result["retryBtnText"] == "Retry", f"the button must read 'Retry', got {result['retryBtnText']!r}"
    assert "retry" in (result["noteText"] or "").lower(), "the empty-turn note must invite a retry"


def test_orw502_retry_holder_is_dropped_once_the_server_answered():
    """ORW-502 (retro thread 4535725357): a dropped stream's Retry holder is carried across a rebuild only while the server log still ends on the player's message; once it ends on an assistant answer the
    holder is stale. Source-pinned (the repo convention for this seam); the rule itself is the exported pure helper."""
    js = _read("static/js/chatReconcile.js")
    assert "export function _retryHolderSuperseded(el, visible)" in js
    assert "!_retryHolderSuperseded(el, visible)" in js and "last.role === 'assistant'" in js
