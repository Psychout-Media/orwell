"""#891 F-A7 (messaging resilience) — the PER-BUBBLE DELIVERY-STATE tail.

The reload-durable send outbox (P0-1) + offline detection (P0-2) shipped in
`test_891_reload_durable_outbox.py`; the model-driven idempotency (F1) + the SSE replay-durable
pushes (F3) shipped elsewhere. This closes the remaining F-A7 item: a message's LIFECYCLE state is
now projected onto its own user bubble — queued → sending → delivered | failed — and the load-bearing
half, the terminal `failed` state, is PERSISTED so a reload shows the true state (not a stranded
pending bubble or a vanished turn) with an explicit per-bubble Retry.

  queued / offline  — already visible (`.queued-tag`); now also stamped `dataset.deliveryState`.
  sending           — dispatched, awaiting the server-row confirm (dim; `dataset.deliveryState`).
  delivered         — a server row (adopt pass / dedupe) proved it landed → every marker cleared.
  failed            — the network-requeue cap (`_OUTBOX_MAX_RETRIES`) is spent → `.msg-unsent` + a
                      REAL 'Not delivered' label + a Retry button, held in a DURABLE bucket
                      (`_outboxFailed`, persisted `state:'failed'`), repainted on reload, never
                      auto-draining. Retry / a proven-delivered row are the only exits.

Reuses the existing message-state CSS vocabulary (`.msg-pending` / `.queued-tag` / `.msg-unsent` /
`.continue-btn`) — no new stylesheet rules. Like the sibling #891 gates this is an LLM-stub-blind
seam, so the runtime legs drive the REAL chat.js in headless chromium.

Run: cd frontend && .venv/bin/python -m pytest tests/test_891_delivery_state.py
"""

import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


# ─────────────────────────────────────────────────────────────────────────────
# Source pins — the delivery-state legs can't silently regress (cheap, no browser).
# ─────────────────────────────────────────────────────────────────────────────

def test_delivery_state_helper_exists_and_reuses_existing_css():
    js = _read("static/js/chatOutbox.js")
    assert "function _setDeliveryState(bubbleEl, state)" in js, "the per-bubble projection must exist"
    helper = js[js.index("function _setDeliveryState(bubbleEl, state)"):]
    helper = helper[:helper.index("function _clearDeliveryRetry")]
    # every lifecycle state is handled
    for st in ("'delivered'", "'queued'", "'offline'", "'sending'", "'failed'"):
        assert st in helper, f"the {st} state must be handled in _setDeliveryState"
    # the machine-readable projection (reconstructed on reload for 'failed')
    assert "dataset.deliveryState" in helper, "the state must stamp a machine-readable dataset projection"
    # reuses the EXISTING message-state CSS vocabulary (no new stylesheet rules)
    assert "classList.add('msg-pending')" in helper and "classList.add('msg-unsent')" in helper, \
        "delivery states must reuse the existing .msg-pending / .msg-unsent classes"
    assert "_setQueuedTag(bubbleEl" in helper, "queued/offline must delegate to the existing .queued-tag painter"
    # the failed Retry affordance is a REAL text node + a reused .continue-btn (WCAG 4.1.3; no new CSS)
    retry = js[js.index("function _attachDeliveryRetry(bubbleEl, clientMsgId)"):]
    retry = retry[:retry.index("function _markSendFailed")]
    assert "'msg-delivery-retry'" in retry
    assert "'Not delivered.'" in retry, "the failed label must be a real text node, not CSS-only"
    assert "btn.className = 'continue-btn'" in retry, "the Retry button must reuse the existing style"
    assert "_retryFailedSend(" in retry, "the Retry button must re-enter the ONE normal flush"
    # no new CSS: style.css must NOT have grown a bespoke delivery-state selector
    css = _read("static/style.css")
    assert ".msg-delivery-retry" not in css, \
        "F-A7 must reuse existing CSS — no bespoke .msg-delivery-retry rule was added"
    assert "deliveryState" not in css and "delivery-state" not in css, \
        "the delivery state must not introduce new stylesheet rules"


def test_failed_bucket_declared_persisted_and_restored():
    js = _read("static/js/chatOutbox.js")
    assert "chatState._outboxFailed" in js, "the durable-failed bucket must exist (moved to the chatState singleton — #1414)"
    # persistence: failed items serialize with state:'failed'
    persist = js[js.index("function _persistOutbox()"):]
    persist = persist[:persist.index("function _restoreOutboxFromStorage")]
    assert "_outboxFailed.map(" in persist and "state: 'failed'" in persist, \
        "terminally-failed items must persist (reload-durable) with state:'failed'"
    # restore: a state:'failed' record routes to the failed bucket, NOT the auto-drain
    restore = js[js.index("function _restoreOutboxFromStorage()"):]
    restore = restore[:restore.index("function _outboxConfirmDelivery")]
    assert "if (it.state === 'failed')" in restore, "the restore must branch on the persisted failed state"
    assert "_outboxFailed.push(failedItem)" in restore, "a restored failed item goes to the failed bucket"
    assert "_setDeliveryState(failedItem.bubbleEl, 'failed')" in restore, \
        "a restored failed item must repaint its 'failed' delivery state (+ Retry)"
    # the flush is kicked only for DRAINABLE (queued) restores — a failed item never re-sends on its own
    assert "if (restored) setTimeout(() => { try { _flushSendOutbox()" in restore, \
        "only queued restores kick the drain; a restored 'failed' item must wait for its explicit Retry"
    # the restore dedupe guard also excludes ids already in the failed bucket (no duplicate repaint)
    assert "_outboxFailed.some((x) => x.clientMsgId === it.clientMsgId)" in restore


def test_confirm_and_dedupe_settle_the_bubble_delivered():
    js = _read("static/js/chatOutbox.js")
    confirm = js[js.index("function _outboxConfirmDelivery(clientMsgId)"):]
    confirm = confirm[:confirm.index("function _requeueOutboxItem")]
    assert "[chatState._outboxAwaitingConfirm, chatState._sendOutbox, chatState._outboxFailed]" in confirm, \
        "a proven-delivered server row must be able to rescue even a 'failed' bubble"
    assert "_setDeliveryState(removed.bubbleEl, 'delivered')" in confirm, \
        "a confirmed delivery must settle the bubble to 'delivered'"
    # the dedupe 'already on server' drop also settles delivered
    dd = js[js.index("async function _dedupeOutboxAgainstServer()"):]
    dd = dd[:dd.index("function _setQueuedTag")]
    assert "_setDeliveryState(it.bubbleEl, 'delivered')" in dd


def test_dispatch_marks_sending():
    js = _read("static/js/chatOutbox.js")
    fn = js[js.index("function _flushSendOutbox()"):]
    fn = fn[:fn.index("// ── #891 P0: durability wiring")]
    assert "_setDeliveryState(item.bubbleEl, 'sending')" in fn, \
        "a dispatched (awaiting-confirm) item must project the 'sending' state onto its bubble"


def test_catch_hook_marks_failed_after_the_requeue_cap():
    js = _read("static/js/chat.js")
    requeue_at = js.index("_requeueOutboxItem(_clientMsgId, msg, _userMsgEl, streamSessionId)")
    markfail_at = js.index("_markSendFailedById(_clientMsgId, msg, _userMsgEl, streamSessionId)")
    recover_at = js.index("_tryAutoRecover(holder, accumulated, streamSessionId)")
    assert requeue_at < markfail_at < recover_at, (
        "on a classified network failure the durable-failed marking must run AFTER the requeue "
        "(only when the cap is spent) and BEFORE the generic auto-recover/error surface"
    )
    # the requeue is still the primary path (unchanged) — the failed-mark is the exhausted fallback
    hook = js[requeue_at - 200:markfail_at + 200]
    assert "if (!_requeuedOffline)" in hook, "the failed-mark must be gated on the requeue declining (capped)"


def test_retry_reenters_the_one_normal_flush():
    js = _read("static/js/chatOutbox.js")
    fn = js[js.index("function _retryFailedSend(clientMsgId)"):]
    fn = fn[:fn.index("// ── #830: the AGGREGATED")] if "// ── #830: the AGGREGATED" in fn else fn[:2000]
    assert "_outboxFailed.splice(i, 1)" in fn, "Retry must remove the item from the failed bucket"
    assert "item.needsDedupe = true" in fn, "a retried send may have partially landed — re-verify first"
    assert "item.retries = 0" in fn, "a user-initiated Retry is a fresh attempt (retry budget reset)"
    assert "_sendOutbox.unshift(item)" in fn, "the retried turn is the oldest — it re-sends first (order)"
    assert "_flushSendOutbox()" in fn, "Retry must drive the ONE normal flush"
    # no second send path introduced
    assert js.count("let _outboxDispatch") == 1, "Retry must not add a second dispatcher"


def test_new_helpers_exported_for_the_browser_gate():
    js = _read("static/js/chat.js")
    exports = js[js.index("_outboxAwaitingConfirm,"):js.index("export default chatModule")]
    for name in ("_outboxFailed", "_setDeliveryState", "_markSendFailedById", "_retryFailedSend"):
        assert f"{name}," in exports, \
            f"{name} must be exported on window.chatModule for the runtime gate"


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL chat.js in headless chromium.
# ─────────────────────────────────────────────────────────────────────────────

from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _log_tail(port, lines=40):
    try:
        with open(f"/tmp/fe-891ds-{port}.log", encoding="utf-8", errors="replace") as f:
            return "\n".join(f.read().splitlines()[-lines:])
    except Exception as e:  # pragma: no cover - diagnostics only
        return f"<log unreadable: {e}>"


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-891ds-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(
                f"uvicorn exited early (exit status {proc.returncode}); log tail:\n{_log_tail(port)}"
            )
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError(f"server never became ready; log tail:\n{_log_tail(port)}")


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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-891ds-"), "app.db"),
    )
    port = _free_port()
    proc, base = _boot(env, port)
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def _wait_ready(page):
    page.wait_for_function("() => !!window.chatModule", timeout=15000)


def _new_context(pw, app):
    try:
        browser = pw.chromium.launch()
    except Exception as e:
        pytest.skip(f"chromium unavailable: {e}")
    context = browser.new_context()
    page = context.new_page()
    page.goto(app + "/", wait_until="load", timeout=30000)
    _wait_ready(page)
    return browser, context, page


# Paints a REAL user bubble through the outbox, then drives it to 'failed' via the public helper.
_SEED_FAILED = r"""
  () => {
    const chat = window.chatModule;
    if (!chat || !chat._enqueueSend || !chat._markSendFailedById) return { error: 'helpers missing' };
    const box = document.getElementById('chat-history');
    if (box) box.innerHTML = '';
    chat._sendOutbox.length = 0;
    chat._outboxAwaitingConfirm.length = 0;
    chat._outboxFailed.length = 0;
    try { sessionStorage.removeItem('orwell-send-outbox:'); } catch (_) {}
    // Real paint path (chatRenderer.addMessage) — an authentic .role/.body user bubble.
    chat._enqueueSend('a turn that fails to send');
    const cid = chat._sendOutbox[0] && chat._sendOutbox[0].clientMsgId;
    const bubble = chat._sendOutbox[0] && chat._sendOutbox[0].bubbleEl;
    // sessionId null → pre-session semantics (dedupe trivially clean; drain uses current session).
    const ok = chat._markSendFailedById(cid, 'a turn that fails to send', bubble, null);
    return { cid, ok };
  }
"""


def test_failed_delivery_state_visible_persisted_and_retryable(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, context, page = _new_context(pw, _app)
        seeded = page.evaluate(_SEED_FAILED)
        assert "error" not in seeded, seeded.get("error")
        assert seeded["ok"] is True and seeded["cid"], f"the send must be markable failed: {seeded!r}"
        cid = seeded["cid"]

        state = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            const bubble = document.querySelector('#chat-history .msg.msg-user');
            const rec = chat._outboxPeekStorage();
            return {
              deliveryState: bubble && bubble.dataset.deliveryState,
              unsent: !!(bubble && bubble.classList.contains('msg-unsent')),
              pending: !!(bubble && bubble.classList.contains('msg-pending')),
              hasRetryBtn: !!(bubble && bubble.querySelector('.msg-delivery-retry .continue-btn')),
              retryLabel: (() => { const s = bubble && bubble.querySelector('.msg-delivery-retry span'); return s ? s.textContent : null; })(),
              failedLen: chat._outboxFailed.length,
              queueLen: chat._sendOutbox.length,
              awaitingLen: chat._outboxAwaitingConfirm.length,
              storedStates: rec && rec.items ? rec.items.map(it => it.state) : null,
              storedIds: rec && rec.items ? rec.items.map(it => it.clientMsgId) : null,
            };
          }
        """)
        assert state["deliveryState"] == "failed", f"the bubble must project the 'failed' state: {state!r}"
        assert state["unsent"] and not state["pending"], "failed = .msg-unsent, not .msg-pending"
        assert state["hasRetryBtn"], "a failed send must offer a per-bubble Retry"
        assert state["retryLabel"] == "Not delivered.", "the failed label must be a real text node"
        assert state["failedLen"] == 1 and state["queueLen"] == 0 and state["awaitingLen"] == 0, \
            f"the failed item lives in the durable-failed bucket, out of the drain: {state!r}"
        assert state["storedStates"] == ["failed"] and state["storedIds"] == [cid], \
            f"the failed send must be reload-durable (persisted state:'failed'): {state!r}"

        # Retry re-enters the ONE normal flush: the item leaves the failed bucket, re-queues
        # (needsDedupe), and dispatches EXACTLY once through the spied dispatcher.
        page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            const sent = [];
            window.__dsSpy = sent;
            chat._setOutboxDispatch((text, opts) => {
              sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId });
              return Promise.resolve();
            });
          }
        """)
        # Click the REAL Retry button to prove the wiring (its own `addEventListener('click')`
        # handler). Invoke `.click()` in-page rather than page.click(): the onboarding scrim
        # (#orwell-onboarding) can overlay the chat in the full lane and intercept a synthetic
        # pointer event — the wired handler is what we're testing, not pointer hit-testing. The
        # sibling #891 gates use the same page.evaluate discipline for exactly this reason.
        clicked = page.evaluate(r"""
          () => {
            const btn = document.querySelector('#chat-history .msg.msg-user .msg-delivery-retry .continue-btn');
            if (!btn) return false;
            btn.click();
            return true;
          }
        """)
        assert clicked, "the Retry button must be present and clickable"
        try:
            page.wait_for_function("() => (window.__dsSpy || []).length >= 1", timeout=15000)
        except Exception as e:
            dbg = page.evaluate("() => ({ spy: window.__dsSpy, failed: window.chatModule._outboxFailed.length, q: window.chatModule._sendOutbox.length })")
            browser.close()
            pytest.fail(f"the Retry never dispatched the failed send: {dbg!r} — {e}")
        page.wait_for_timeout(300)
        after = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            const sent = window.__dsSpy || [];
            const bubble = document.querySelector('#chat-history .msg.msg-user');
            return {
              dispatched: sent.map(s => ({ text: s.text, id: s.clientMsgId })),
              failedLen: chat._outboxFailed.length,
              bubbleUnsentCleared: !!(bubble && !bubble.classList.contains('msg-unsent')),
              retryGone: !!(bubble && !bubble.querySelector('.msg-delivery-retry')),
            };
          }
        """)
        browser.close()
    assert after["dispatched"] == [{"text": "a turn that fails to send", "id": cid}], (
        f"Retry must re-send the original turn exactly once, carrying its client id: {after!r}"
    )
    assert after["failedLen"] == 0, "a retried item leaves the failed bucket"
    assert after["bubbleUnsentCleared"] and after["retryGone"], \
        "on Retry the bubble must drop the failed 'not delivered'/Retry chrome"


def test_failed_state_is_reload_durable_and_never_auto_drains(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, context, page = _new_context(pw, _app)
        seeded = page.evaluate(_SEED_FAILED)
        assert "error" not in seeded, seeded.get("error")
        cid = seeded["cid"]

        # Hard reload — sessionStorage is per-tab, so the failed record rides the same tab across it.
        page.reload(wait_until="load", timeout=30000)
        try:
            page.wait_for_function(
                "() => window.chatModule && window.chatModule._outboxFailed.length >= 1",
                timeout=20000,
            )
        except Exception as e:
            rec = page.evaluate("() => window.chatModule ? window.chatModule._outboxPeekStorage() : null")
            browser.close()
            pytest.fail(f"the failed record never restored after the reload: {rec!r} — {e}")

        restored = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            const bubble = document.querySelector('#chat-history .msg.msg-user');
            return {
              failedIds: chat._outboxFailed.map(it => it.clientMsgId),
              queueLen: chat._sendOutbox.length,
              deliveryState: bubble && bubble.dataset.deliveryState,
              unsent: !!(bubble && bubble.classList.contains('msg-unsent')),
              hasRetryBtn: !!(bubble && bubble.querySelector('.msg-delivery-retry .continue-btn')),
            };
          }
        """)
        assert restored["failedIds"] == [cid], f"the failed item must restore into the failed bucket: {restored!r}"
        assert restored["queueLen"] == 0, "a restored failed item must NOT enter the auto-drain queue"
        assert restored["deliveryState"] == "failed" and restored["unsent"], \
            "the reload must repaint the TRUE 'failed' state, not a stranded pending bubble"
        assert restored["hasRetryBtn"], "the reloaded failed bubble must still offer Retry"

        # Prove it never auto-drains: install a spy, release any hold, flush — nothing must dispatch.
        page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            window.__dsSpy2 = [];
            chat._setOutboxDispatch((text, opts) => { window.__dsSpy2.push(text); return Promise.resolve(); });
            window.__orwellOutboxHoldDrain = false;
            chat._flushSendOutbox();
          }
        """)
        page.wait_for_timeout(500)
        final = page.evaluate(r"""
          () => ({
            dispatched: (window.__dsSpy2 || []).length,
            failedLen: window.chatModule._outboxFailed.length,
          })
        """)
        browser.close()
    assert final["dispatched"] == 0, (
        f"a terminally-failed send must NEVER re-send on its own (only explicit Retry) — got {final['dispatched']}"
    )
    assert final["failedLen"] == 1, "the failed item stays durable until Retry or a proven-delivered row"


def test_sending_then_delivered_lifecycle(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, context, page = _new_context(pw, _app)
        result = page.evaluate(r"""
          async () => {
            const chat = window.chatModule;
            if (!chat || !chat._enqueueSend) return { error: 'helpers missing' };
            const box = document.getElementById('chat-history');
            if (box) box.innerHTML = '';
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            chat._outboxFailed.length = 0;
            try { sessionStorage.removeItem('orwell-send-outbox:'); } catch (_) {}

            // ENQUEUE (online) → the bubble projects 'queued'.
            chat._enqueueSend('lifecycle turn');
            const cid = chat._sendOutbox[0] && chat._sendOutbox[0].clientMsgId;
            const bubble = document.querySelector('#chat-history .msg.msg-user');
            const queuedState = bubble && bubble.dataset.deliveryState;

            // DISPATCH via a spy → the awaiting item projects 'sending'.
            window.__lifeSpy = [];
            chat._setOutboxDispatch((text, opts) => { window.__lifeSpy.push(text); return Promise.resolve(); });
            chat._flushSendOutbox();
            await new Promise(r => setTimeout(r, 250));
            const sendingState = bubble && bubble.dataset.deliveryState;
            const awaiting = chat._outboxAwaitingConfirm.map(it => it.clientMsgId);

            // CONFIRM (server row observed) → 'delivered', all transient markers cleared.
            chat._outboxConfirmDelivery(cid);
            const deliveredState = bubble && bubble.dataset.deliveryState;
            return {
              cid,
              queuedState, sendingState, deliveredState, awaiting,
              afterDeliverPending: !!(bubble && bubble.classList.contains('msg-pending')),
              afterDeliverQueuedTag: !!(bubble && bubble.querySelector('.role .queued-tag')),
              awaitingCleared: chat._outboxAwaitingConfirm.length === 0,
            };
          }
        """)
        browser.close()
    assert "error" not in result, result.get("error")
    assert result["queuedState"] == "queued", f"an enqueued send must project 'queued': {result!r}"
    assert result["awaiting"] == [result["cid"]], "the dispatched item must sit in awaiting-confirm"
    assert result["sendingState"] == "sending", f"a dispatched send must project 'sending': {result!r}"
    assert result["deliveredState"] == "delivered", f"a confirmed send must project 'delivered': {result!r}"
    assert not result["afterDeliverPending"] and not result["afterDeliverQueuedTag"], \
        "'delivered' must clear the pending dim + the queued tag"
    assert result["awaitingCleared"], "confirm must release the durable awaiting copy"
