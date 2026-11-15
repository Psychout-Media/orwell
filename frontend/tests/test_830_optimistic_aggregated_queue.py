"""#830 — optimistic-always user bubble + AGGREGATED unsent send queue.

Builds ON the #1379 reload-durable outbox (test_891_reload_durable_outbox.py) — the queue, the
per-item at-most-once machinery, the durability and the honest status tags are all #891's; #830
adds the AGGREGATION lane on top:

  1. OPTIMISTIC-ALWAYS — the user's message paints as a bubble synchronously on submit in EVERY
     path (BUG-1 covered the no-model/no-session materialize branches; #985 the send-while-
     streaming enqueue; #891 the offline enqueue). The one remaining stranded state — a DECLINED
     API-key confirm left a ghost `msg-pending` bubble that would never dispatch while the text
     stayed in the composer — now removes the stale bubble (the words remain in the composer:
     never invisible, never doubled).

  2. AGGREGATED ONE-TURN DRAIN — the owner's ruling: "aggregate what you send quickly … when it's
     time to send the payload it sends all messages in one turn." Items queued WHILE A TURN WAS
     STREAMING carry `coalesce: true`; at drain time a same-lane run of them folds into ONE
     combined turn (`_foldOutboxBatch`): one payload (texts joined by a blank line, order kept),
     ONE clientMsgId (the head's — the batch's single idempotency key), ONE bubble (the separate
     pending bubbles collapse into a single combined bubble through the same render path), ONE
     server row — so live, persisted and peer views all converge. A single queued item — and every
     OFFLINE-queued / network-requeued / reload-restored item — dispatches byte-identical to the
     per-item #891 path (each of those is its own at-most-once unit; folding items with divergent
     delivery states could double- or half-send a batch). That split is exactly why this composes
     with, rather than regresses, the #1379 gates.

  3. AGGREGATED AFFORDANCE — when ≥2 items sit queued, one status strip above the composer
     (`#send-queue-strip`, role="status", REAL text nodes — the WCAG 4.1.3 .unsent-tag precedent)
     shows the count + the one-turn/offline truth + a manual "Send now" retry that resets the
     backoff and drains through the ONE normal flush ("retry re-sends the batch"). The strip is a
     pure PROJECTION of the outbox — no queue state of its own, no second send path.

Like #985/#891 this is an LLM-stub-blind seam, so the runtime gates drive the REAL chat.js in
headless chromium.

Run: cd frontend && python3 -m pytest tests/
(the CLAUDE.md rule — run the WHOLE FE suite before pushing FE changes: many gates are
source-pinned convention checks that live outside obvious keywords. For fast iteration on just
this gate: cd frontend && .venv/bin/python -m pytest tests/test_830_optimistic_aggregated_queue.py)
"""

import os
import shutil
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
# Source pins — the aggregation legs can't silently regress (cheap, no browser).
# ─────────────────────────────────────────────────────────────────────────────

def test_coalesce_lane_is_streaming_enqueue_only():
    """The aggregation lane is opt-in at enqueue time and ONLY for the rapid-succession case (a
    send made while a turn streams). Offline-queued items must keep #891's per-item drain."""
    js = _read("static/js/chatOutbox.js")
    fn = js[js.index("function _enqueueSend(text)"):]
    fn = fn[:fn.index("function _paintOutboxBubble")]
    assert "coalesce: chatState.isStreaming === true && _outboxOnline()" in fn, (
        "an item queued while a turn streams (and ONLY then, AND on a live link) may join the "
        "aggregation lane — the offline branch routes through this helper too, and an offline "
        "item that dropped its link mid-stream must stay a per-item idempotency unit, never fold"
    )


def test_fold_helper_folds_to_head_identity_and_one_bubble():
    js = _read("static/js/chatOutbox.js")
    assert "function _foldOutboxBatch(batch)" in js, "the batch fold helper must exist"
    fn = js[js.index("function _foldOutboxBatch(batch)"):]
    fn = fn[:fn.index("\n  /**\n   * Flush the next queued send")]
    assert "clientMsgId: head.clientMsgId" in fn, (
        "the folded turn must carry the HEAD item's clientMsgId — one idempotency key per batch"
    )
    assert "join('\\n\\n')" in fn, "the combined payload joins the texts in send order"
    assert "_paintOutboxBubble(folded)" in fn, (
        "the batch's bubbles must collapse into ONE combined bubble via the SAME render path"
    )
    assert "it.bubbleEl.remove()" in fn, "the superseded per-message bubbles must be removed"
    assert "needsDedupe: false" in fn, "a foldable batch has no at-most-once ambiguity by construction"


def test_flush_folds_only_the_safe_run_after_every_gate():
    """The fold may only cover `coalesce && !needsDedupe` same-lane items, must run AFTER the
    dedupe preflight + session-binding eligibility + the FIFO pick, and BEFORE the dispatch
    bookkeeping — and a single item must stay byte-identical (no fold below 2)."""
    js = _read("static/js/chatOutbox.js")
    fn = js[js.index("function _flushSendOutbox()"):]
    fn = fn[:fn.index("// ── #891 P0: durability wiring")]
    assert "item.coalesce && !item.needsDedupe" in fn, (
        "only a coalesce-lane head with no at-most-once ambiguity may start a batch"
    )
    assert "it.coalesce && !it.needsDedupe" in fn, (
        "only coalesce-lane siblings with no at-most-once ambiguity may join the batch"
    )
    assert "if (_batch.length > 1) item = _foldOutboxBatch(_batch);" in fn, (
        "a single queued item must dispatch byte-identical to the per-item path (no fold marker)"
    )
    dedupe_at = fn.index("_dedupeOutboxAgainstServer()")
    shift_at = fn.index("_sendOutbox.shift()")
    fold_at = fn.index("_foldOutboxBatch(_batch)")
    push_at = fn.index("_outboxAwaitingConfirm.push(item)")
    assert dedupe_at < shift_at < fold_at < push_at, (
        "the fold must sit between the FIFO pick and the awaiting-confirm bookkeeping, after the "
        "at-most-once preflight"
    )
    # The batch collection stops at a same-lane item that can't join (conversation order is never
    # shuffled) but skips over items HELD for another session (an independent lane).
    collect = fn[fn.index("const _batch = [item];"):fn.index("if (_batch.length > 1)")]
    assert "_sameLane" in collect and "break;" in collect, (
        "the collection must stop at the first same-lane non-batchable item (order preserved)"
    )


def test_restored_and_requeued_items_leave_the_aggregation_lane():
    """A RESTORED or network-REQUEUED item is its own at-most-once idempotency unit (its POST may
    already have reached the server), so it re-enters the queue OUTSIDE the aggregation lane:
    per-item drain, per-item dedupe, never folded — comment and code agree (PR #1398 review)."""
    js = _read("static/js/chatOutbox.js")
    restore = js[js.index("function _restoreOutboxFromStorage()"):]
    restore = restore[:restore.index("function _outboxConfirmDelivery")]
    assert "coalesce: false" in restore, "the restore must force the item OUT of the aggregation lane"
    assert "needsDedupe: true" in restore, "…and still arm the #891 per-item dedupe gate"
    rq = js[js.index("function _requeueOutboxItem(clientMsgId, text, bubbleEl, sessionId)"):]
    rq = rq[:rq.index("function _isNetworkSendFailure")]
    assert "item.coalesce = false;" in rq, (
        "a network-requeued item (incl. a failed folded batch) must never fold AGAIN"
    )
    # …and nothing persists the lane either: the restore ignores it, so a stored copy of the flag
    # would be dead weight that invites exactly the comment/code drift this pin prevents.
    persist = js[js.index("function _persistOutbox()"):]
    persist = persist[:persist.index("function _restoreOutboxFromStorage")]
    assert "coalesce: it.coalesce" not in persist, "the lane flag must not be serialized"


def test_shadow_instance_never_restores_the_shared_outbox():
    """Dual-instance hazard (found by the aggregation runtime gate): this page evaluates chat.js
    TWICE (app.js imports './chat.js' bare; index.html script-tags 'chat.js?v=…'), so two module
    instances share ONE sessionStorage outbox record. Only the window.chatModule-registered
    instance may boot-restore it — a shadow-instance restore repaints duplicate pending bubbles
    and can dispatch a real DOUBLE-SEND after its own dedupe pass verifies clean."""
    js = _read("static/js/chatOutbox.js")
    restore = js[js.index("function _restoreOutboxFromStorage()"):]
    restore = restore[:restore.index("function _outboxConfirmDelivery")]
    assert "window.chatModule._restoreOutboxFromStorage !== _restoreOutboxFromStorage" in restore, (
        "a non-canonical (shadow) chat.js instance must never restore the shared outbox record"
    )
    guard_at = restore.index("_restoreOutboxFromStorage !== _restoreOutboxFromStorage")
    paint_at = restore.index("_paintOutboxBubble(item)")
    assert guard_at < paint_at, "the shadow guard must run before any restore paint"


def test_strip_is_a_kit_composed_projection_with_no_second_send_path():
    """The aggregate affordance composes window.OrwellNoticeKit — the ONE stacked above-composer
    zone (ruling #642; test_on_notice_kit.py forbids hand-rolled anchors) — with role='status'
    (WCAG 4.1.3) and REAL text nodes; its retry routes through the ONE normal flush."""
    js = _read("static/js/chatOutbox.js")
    upd = js[js.index("function _updateOutboxStrip()"):]
    upd = upd[:upd.index("\n  /** #891: capped exponential backoff")]
    assert "window.OrwellNoticeKit" in upd and "OrwellNoticeKit.create" in upd, (
        "the aggregate card must COMPOSE the notice kit — never a hand-rolled anchor (#642)"
    )
    assert "kind: 'continue'" in upd, "a quiet ambient notice — the import-banner precedent"
    assert "role: 'status'" in upd, (
        "the card must be announced without focus (WCAG 4.1.3 — the .unsent-tag precedent)"
    )
    assert "_flushSendOutbox()" in upd, "the manual retry must drain through the ONE normal flush"
    assert "_outboxRetryDelayMs = 0" in upd, "the manual retry must reset the backoff"
    assert "handleChatSubmit" not in upd and "fetch(" not in upd and "insertBefore" not in upd, (
        "the card must never grow its own send path or anchor — it is a projection of the outbox"
    )
    assert "n < 2" in upd, "the aggregate card shows only at ≥2 queued items"
    assert "textContent" in upd, "the status must be a REAL text node, never CSS generated content"
    # …and the per-bubble tag sweep keeps the card in lockstep (one refresh seam).
    refresh = js[js.index("function _refreshOutboxStatusTags()"):]
    refresh = refresh[:refresh.index("function _updateOutboxStrip")]
    assert "_updateOutboxStrip()" in refresh


def test_strip_css_exists_and_is_theme_token_only():
    css = _read("static/style.css")
    assert ".send-queue-row" in css, "the aggregate row must be styled in style.css"
    block = css[css.index("/* Issue 830 (aggregated unsent queue"):]
    block = block[:block.index(".send-queue-row .send-queue-retry:disabled") + 120]
    assert "var(--fg)" in block and "color-mix" in block
    # The block sits inside the L36 token-pin slice (test_l36_ooc_aside), which asserts NO '#'
    # at all — hold the same bar here so the two gates can never drift apart.
    assert "#" not in block, "the row styling must be theme-token driven — no hex, no id selectors"


def test_api_key_decline_removes_the_stale_pending_bubble():
    """Optimistic-always closure: the early bubble paints BEFORE the API-key confirm; a DECLINE
    keeps the text in the composer, so the ghost pending bubble must be removed (a flushed outbox
    send's queued bubble is exempt — its lifecycle belongs to the outbox)."""
    js = _read("static/js/chat.js")
    guard = js[js.index("API key guard"):]
    guard = guard[:guard.index("const messageInput = el('message');")]
    assert "if (_userMsgEl && !_queuedBubbleEl)" in guard and ".remove()" in guard, (
        "a declined API-key send must remove its stale pending bubble (text stays in the composer)"
    )
    decline_at = guard.index(".remove()")
    release_at = guard.index("_releaseSendFlag();")
    assert decline_at < release_at, "the cleanup must happen before the send flag releases"


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL chat.js in headless chromium.
# ─────────────────────────────────────────────────────────────────────────────

from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _log_tail(log_path, lines=40):
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            return "\n".join(f.read().splitlines()[-lines:])
    except Exception as e:  # pragma: no cover - diagnostics only
        return f"<log unreadable: {e}>"


def _boot(env, port, log_path):
    # The child gets its own copy of the log fd, so closing ours right after Popen lets the
    # fixture teardown unlink the file cleanly (PR #1398 review: no leaked scratch files).
    with open(log_path, "w") as log_f:
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=FRONTEND, env=env, stdout=log_f, stderr=subprocess.STDOUT,
        )
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError(
                f"uvicorn exited early (exit status {proc.returncode}); log tail:\n{_log_tail(log_path)}"
            )
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError(f"server never became ready; log tail:\n{_log_tail(log_path)}")


@pytest.fixture(scope="module")
def _app():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    # PR #1398 review: the DB dir and the uvicorn log are per-run scratch — track them and clean
    # them up in teardown (a boot FAILURE still surfaces the log TAIL inside the raised error
    # before the cleanup runs, so no diagnostics are lost).
    db_dir = tempfile.mkdtemp(prefix="orwell-830-")
    log_fd, log_path = tempfile.mkstemp(prefix="fe-830-", suffix=".log")
    os.close(log_fd)

    def _cleanup_scratch():
        shutil.rmtree(db_dir, ignore_errors=True)
        try:
            os.remove(log_path)
        except OSError:
            pass

    env = dict(
        os.environ,
        ORWELL_GAME_BUILD="1",
        AUTH_ENABLED="false",
        LOCALHOST_BYPASS="true",
        PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
        DATABASE_URL="sqlite:///" + os.path.join(db_dir, "app.db"),
    )
    port = _free_port()
    try:
        proc, base = _boot(env, port, log_path)  # raises (fails the gate) on any startup problem
    except BaseException:
        _cleanup_scratch()
        raise
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()
    _cleanup_scratch()


def _new_page(pw, app):
    try:
        browser = pw.chromium.launch()
    except Exception as e:
        pytest.skip(f"chromium unavailable: {e}")
    page = browser.new_page()
    page.goto(app + "/", wait_until="load", timeout=30000)
    page.wait_for_function("() => !!window.chatModule", timeout=15000)
    return browser, page


# ── THE commissioned behaviour: three rapid sends while a turn streams → ONE combined turn. ──────
def test_streaming_queued_batch_sends_as_one_turn(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        setup = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            if (!chat || !chat._enqueueSend || !chat._setStreamStateForTest) return { error: 'helpers missing' };
            const box = document.getElementById('chat-history');
            box.innerHTML = '';
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            try { sessionStorage.removeItem('orwell-send-outbox:'); } catch (_) {}
            // The player keeps talking while the model replies (the rapid-succession case).
            chat._setStreamStateForTest({ streaming: true });
            const mi = document.getElementById('message');
            ['alpha one', 'beta two', 'gamma three'].forEach(t => { mi.value = t; chat._enqueueSend(t); });
            chat._setStreamStateForTest({ streaming: false });
            // Install the spy HERE (same evaluate — no window where an async nudge could drain
            // the queue past an uninstalled spy).
            const sent = [];
            window.__batchSpy = sent;
            chat._setOutboxDispatch((text, opts) => {
              sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId, hadBubble: !!(opts && opts.queuedBubbleEl) });
              return Promise.resolve();
            });
            const bubbles = document.querySelectorAll('#chat-history .msg.msg-user');
            return {
              queueLen: chat._sendOutbox.length,
              lanes: chat._sendOutbox.map(it => it.coalesce === true),
              headId: chat._sendOutbox[0] && chat._sendOutbox[0].clientMsgId,
              bubblesBefore: bubbles.length,
            };
          }
        """)
        assert "error" not in setup, setup.get("error")
        assert setup["queueLen"] == 3 and setup["bubblesBefore"] == 3
        assert setup["lanes"] == [True, True, True], (
            "sends made while a turn streams must join the aggregation lane"
        )
        head_id = setup["headId"]

        result = page.evaluate(r"""
          async () => {
            const chat = window.chatModule;
            const sent = window.__batchSpy || [];
            chat._flushSendOutbox();
            await new Promise(r => setTimeout(r, 200));
            chat._flushSendOutbox(); // exactly-once: a redundant flush must not re-dispatch
            await new Promise(r => setTimeout(r, 200));
            const bubbles = Array.from(document.querySelectorAll('#chat-history .msg.msg-user'));
            const rec = chat._outboxPeekStorage();
            const out = {
              sent,
              queueLen: chat._sendOutbox.length,
              awaiting: chat._outboxAwaitingConfirm.map(it => ({ id: it.clientMsgId, text: it.text })),
              storedStates: rec && rec.items ? rec.items.map(it => it.state) : null,
              bubbleCount: bubbles.length,
              bubbleId: bubbles[0] && bubbles[0].dataset.clientMsgId,
              bubbleText: bubbles[0] ? (bubbles[0].querySelector('.body') || bubbles[0]).textContent : null,
            };
            // …and the confirm seam releases the folded batch like any other item.
            chat._outboxConfirmDelivery(out.awaiting.length ? out.awaiting[0].id : null);
            out.recAfterConfirm = chat._outboxPeekStorage();
            out.awaitingAfterConfirm = chat._outboxAwaitingConfirm.length;
            chat._setOutboxDispatch((text, opts) => chat.handleChatSubmit(null, text, opts));
            return out;
          }
        """)
        browser.close()
    assert len(result["sent"]) == 1, (
        f"three rapid-succession sends must drain as ONE turn, got {len(result['sent'])} dispatches: "
        f"{[s['text'] for s in result['sent']]!r}"
    )
    assert result["sent"][0]["text"] == "alpha one\n\nbeta two\n\ngamma three", (
        f"the combined payload must join the texts in send order: {result['sent'][0]['text']!r}"
    )
    assert result["sent"][0]["clientMsgId"] == head_id, (
        "the combined turn must carry the HEAD item's clientMsgId (one idempotency key)"
    )
    assert result["sent"][0]["hadBubble"], "the combined turn must re-use the folded bubble"
    assert result["queueLen"] == 0, "the whole batch must leave the queue"
    # ONE bubble ↔ ONE server row: the three pending bubbles collapsed into a single combined one.
    assert result["bubbleCount"] == 1, (
        f"the batch's bubbles must collapse into ONE combined bubble, got {result['bubbleCount']}"
    )
    assert result["bubbleId"] == head_id
    for part in ("alpha one", "beta two", "gamma three"):
        assert part in (result["bubbleText"] or ""), f"the combined bubble must show {part!r}"
    # Reload-durable as a BATCH: one awaiting item holding the combined payload.
    assert result["awaiting"] == [{"id": head_id, "text": "alpha one\n\nbeta two\n\ngamma three"}]
    assert result["storedStates"] == ["inflight"], (
        "the folded batch must stay reload-durable (as ONE per-item record — the lane flag is "
        "deliberately not serialized; a restored batch re-sends per-item semantics) until its "
        "server row is observed"
    )
    assert result["awaitingAfterConfirm"] == 0 and result["recAfterConfirm"] is None, (
        "a confirmed delivery must release the folded batch's durable copy"
    )


# ── Byte-identical single: ONE queued item never folds, never changes shape. ─────────────────────
def test_single_queued_item_dispatches_byte_identical(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        result = page.evaluate(r"""
          async () => {
            const chat = window.chatModule;
            if (!chat || !chat._enqueueSend) return { error: 'helpers missing' };
            const box = document.getElementById('chat-history');
            box.innerHTML = '';
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            try { sessionStorage.removeItem('orwell-send-outbox:'); } catch (_) {}
            chat._setStreamStateForTest({ streaming: true });
            const mi = document.getElementById('message');
            mi.value = 'solo message';
            chat._enqueueSend('solo message');
            chat._setStreamStateForTest({ streaming: false });
            const queuedId = chat._sendOutbox[0].clientMsgId;
            const queuedBubble = chat._sendOutbox[0].bubbleEl;
            const sent = [];
            chat._setOutboxDispatch((text, opts) => {
              sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId,
                          sameBubble: (opts && opts.queuedBubbleEl) === queuedBubble });
              return Promise.resolve();
            });
            chat._flushSendOutbox();
            await new Promise(r => setTimeout(r, 150));
            chat._setOutboxDispatch((text, opts) => chat.handleChatSubmit(null, text, opts));
            return { sent, queuedId, bubbleCount: document.querySelectorAll('#chat-history .msg.msg-user').length };
          }
        """)
        browser.close()
    assert "error" not in result, result.get("error")
    assert len(result["sent"]) == 1
    assert result["sent"][0]["text"] == "solo message", "a single item's payload must be verbatim"
    assert result["sent"][0]["clientMsgId"] == result["queuedId"]
    assert result["sent"][0]["sameBubble"], (
        "a single item must re-use its ORIGINAL painted bubble — no fold, no repaint"
    )
    assert result["bubbleCount"] == 1


# ── Mixed lanes: a per-item (#891) head drains alone; the coalesce run behind it folds. ──────────
def test_mixed_lanes_preserve_order_and_fold_only_the_run(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        setup = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            if (!chat || !chat._enqueueSend) return { error: 'helpers missing' };
            const box = document.getElementById('chat-history');
            box.innerHTML = '';
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            try { sessionStorage.removeItem('orwell-send-outbox:'); } catch (_) {}
            const mi = document.getElementById('message');
            // A: queued at REST (the offline/per-item shape — no coalesce).
            mi.value = 'per-item head'; chat._enqueueSend('per-item head');
            // B, C: queued while a turn streamed (the aggregation lane).
            chat._setStreamStateForTest({ streaming: true });
            mi.value = 'rapid one'; chat._enqueueSend('rapid one');
            mi.value = 'rapid two'; chat._enqueueSend('rapid two');
            chat._setStreamStateForTest({ streaming: false });
            const sent = [];
            window.__mixedSpy = sent;
            chat._setOutboxDispatch((text, opts) => {
              sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId });
              // mimic the real stream-end finally so the drain chains like production
              return Promise.resolve().then(() => { setTimeout(() => chat._flushSendOutbox(), 0); });
            });
            chat._flushSendOutbox();
            return { lanes: null, ok: true };
          }
        """)
        assert "error" not in setup, setup.get("error")
        page.wait_for_function("() => (window.__mixedSpy || []).length >= 2", timeout=15000)
        page.wait_for_timeout(300)
        result = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            chat._setOutboxDispatch((text, opts) => chat.handleChatSubmit(null, text, opts));
            return { order: (window.__mixedSpy || []).map(s => s.text), queueLen: chat._sendOutbox.length };
          }
        """)
        browser.close()
    assert result["order"] == ["per-item head", "rapid one\n\nrapid two"], (
        "the per-item head must drain ALONE (its own turn, #891 semantics) and the coalesce run "
        f"behind it must fold into ONE turn — got {result['order']!r}"
    )
    assert result["queueLen"] == 0


# ── The aggregated affordance: count strip + offline honesty + hidden once drained. ──────────────
def test_aggregate_strip_projects_the_queue(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        context = browser.new_context()
        page = context.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        page.wait_for_function("() => !!window.chatModule", timeout=15000)

        # Two REAL offline sends through the whole submit path (the strip must ride the normal
        # enqueue seams, not a bespoke hook).
        context.set_offline(True)
        state = page.evaluate(r"""
          async () => {
            const chat = window.chatModule;
            const box = document.getElementById('chat-history');
            box.innerHTML = '';
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            const mi = document.getElementById('message');
            mi.value = 'strip check one';
            await chat.handleChatSubmit(null);
            const afterOne = (() => {
              const s = document.getElementById('send-queue-strip');
              return { exists: !!s, visible: !!(s && !s.hidden) };
            })();
            mi.value = 'strip check two';
            await chat.handleChatSubmit(null);
            const s = document.getElementById('send-queue-strip');
            return {
              afterOne,
              visible: !!(s && !s.hidden),
              role: s && s.getAttribute('role'),
              label: s ? (s.querySelector('.send-queue-label') || {}).textContent : null,
              retryDisabled: !!(s && s.querySelector('.send-queue-retry') && s.querySelector('.send-queue-retry').disabled),
            };
          }
        """)
        # A single queued item keeps only its per-bubble tag — the AGGREGATE strip needs ≥2.
        assert not state["afterOne"]["visible"], "the aggregate strip must not show for a single item"
        assert state["visible"], "two queued sends must surface the aggregate strip"
        assert state["role"] == "status", "the strip must be a WCAG 4.1.3 status region"
        assert state["label"] == "2 messages queued — offline", f"honest offline count: {state['label']!r}"
        assert state["retryDisabled"], "a manual retry with no link would be a lie — disabled offline"

        # Reconnect: the 'online' seam drains (per-item — these are #891-shape items), and the
        # card closes with the queue (the kit animates it out, then removes it from the DOM).
        page.evaluate(_SPY_WITH_SETTLE_KICK)
        context.set_offline(False)
        page.wait_for_function("() => (window.__stripSpy || []).length >= 2", timeout=15000)
        page.wait_for_function("() => !document.getElementById('send-queue-strip')", timeout=10000)
        final = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            chat._setOutboxDispatch((text, opts) => chat.handleChatSubmit(null, text, opts));
            return {
              order: (window.__stripSpy || []).map(x => x.text),
              queueLen: chat._sendOutbox.length,
            };
          }
        """)
        browser.close()
    assert final["order"] == ["strip check one", "strip check two"], (
        f"offline items keep the per-item #891 drain, in order: {final['order']!r}"
    )
    assert final["queueLen"] == 0


_SPY_WITH_SETTLE_KICK = r"""
() => {
  const chat = window.chatModule;
  const sent = [];
  window.__stripSpy = sent;
  chat._setOutboxDispatch((text, opts) => {
    sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId });
    return Promise.resolve().then(() => { setTimeout(() => chat._flushSendOutbox(), 0); });
  });
  return true;
}
"""


# ── "Send now" — the manual retry re-sends the (folded) batch through the ONE normal flush. ──────
def test_send_now_retry_dispatches_the_batch_as_one_turn(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, page = _new_page(pw, _app)
        setup = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            if (!chat || !chat._enqueueSend) return { error: 'helpers missing' };
            const box = document.getElementById('chat-history');
            box.innerHTML = '';
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            try { sessionStorage.removeItem('orwell-send-outbox:'); } catch (_) {}
            chat._setStreamStateForTest({ streaming: true });
            const mi = document.getElementById('message');
            mi.value = 'batch retry one'; chat._enqueueSend('batch retry one');
            mi.value = 'batch retry two'; chat._enqueueSend('batch retry two');
            chat._setStreamStateForTest({ streaming: false });
            const sent = [];
            window.__retrySpy = sent;
            chat._setOutboxDispatch((text, opts) => {
              sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId });
              return Promise.resolve();
            });
            const s = document.getElementById('send-queue-strip');
            return {
              visible: !!(s && !s.hidden),
              label: s ? (s.querySelector('.send-queue-label') || {}).textContent : null,
              retryEnabled: !!(s && s.querySelector('.send-queue-retry') && !s.querySelector('.send-queue-retry').disabled),
            };
          }
        """)
        assert "error" not in setup, setup.get("error")
        assert setup["visible"], "two queued coalesce items must surface the strip"
        assert setup["label"] == "2 messages queued — they will send as one turn", (
            f"the strip must say the batch sends as ONE turn: {setup['label']!r}"
        )
        assert setup["retryEnabled"]
        # Dispatch the click on the element itself (the known onboarding scrim, #925/#1148, can
        # intercept hit-testing in this harness; the HANDLER is the unit under test here).
        page.evaluate("() => document.querySelector('#send-queue-strip .send-queue-retry').click()")
        page.wait_for_function("() => (window.__retrySpy || []).length >= 1", timeout=10000)
        # The card closes once the batch dispatches (the kit animates out then removes the node).
        page.wait_for_function("() => !document.getElementById('send-queue-strip')", timeout=10000)
        result = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            chat._setOutboxDispatch((text, opts) => chat.handleChatSubmit(null, text, opts));
            return {
              sent: (window.__retrySpy || []).map(x => x.text),
              queueLen: chat._sendOutbox.length,
            };
          }
        """)
        browser.close()
    assert result["sent"] == ["batch retry one\n\nbatch retry two"], (
        f"Send now must re-send the whole batch as ONE turn: {result['sent']!r}"
    )
    assert result["queueLen"] == 0
