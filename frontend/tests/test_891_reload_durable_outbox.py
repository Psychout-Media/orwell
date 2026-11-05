"""#891 P0 (messaging resilience) — the RELOAD-DURABLE outbox + honest offline status.

The #985 send outbox shipped in-memory only, with the reload-durable half explicitly deferred to
#891 (the old chat.js header comment; audit row INT-3 in docs/audits/2026-07-03-product-review-
fix-ledger.md: "hard reload while a send is QUEUED loses it"). This change closes the #891 P0 set:

  P0-1  RELOAD-DURABLE OUTBOX — every queued item persists to sessionStorage (PER-TAB by design:
        the outbox is this tab's queue per ADR 0008/0012, and a drained send flows through the
        NORMAL canonical-session send path — localStorage would let two tabs restore one queue and
        double-send; IndexedDB buys nothing for a handful of {id, text} strings). An item stays
        persisted from enqueue THROUGH dispatch (awaiting-confirm) until a server row carrying its
        clientMsgId is OBSERVED (adopt pass / pre-send dedupe). On boot the queue restores, bubbles
        repaint pending, and the drain resumes. At-most-once: restored/requeued items carry
        `needsDedupe` — one /api/history fetch drops any item whose client_msg_id the server
        already persisted, FAIL-CLOSED (unverifiable ⇒ stay queued + backoff, never a blind
        re-send). This is the F1 "no missing messages" bar (docs/audits/2026-06-27-ship-gate.md).

  P0-2  OFFLINE DETECTION + HONEST STATUS — a queued bubble carries a real-text-node `.queued-tag`
        ('queued' / 'queued — offline'; the .unsent-tag WCAG 4.1.3 precedent); the flush gates on
        navigator.onLine; an offline send goes STRAIGHT to the outbox (no doomed POST); a send that
        died at the network layer before any byte (`_isNetworkSendFailure` — deliberately narrower
        than the auto-recover classifier) is RE-QUEUED instead of surfacing a raw error; and the
        'online' event + a capped exponential backoff auto-drain the queue.

No second send path exists: the drain dispatches through the one `_outboxDispatch` →
`handleChatSubmit`, riding the existing clientMsgId adopt/reconcile seams (ADR 0008/0012).

  P1 FIX (PR #1379 review — Greptile's EXECUTED cross-session repro; CodeRabbit flagged the same
  gate): the first cut's drain only required that SOME session was selected, and the dedupe
  PREFERRED the currently-selected session over the item's own — so a restored session-A item
  could be "verified" against and DISPATCHED INTO session B if B became current first after the
  reload. Now an item's recorded `sessionId` is BINDING: the drain dispatches an item only while
  ITS session is the currently-selected one (others are HELD — kept in the queue, _flushingOutbox
  reset, backoff armed, never shifted — draining via the sessions.js selectSession nudge or the
  retry tick), and `_dedupeOutboxAgainstServer` verifies each item against ITS OWN session's
  history, never the current session's. No-sessionId items (queued before any session existed)
  keep current-session-at-dispatch-time semantics, documented at the eligibility check.

Like #985/#836 this is an LLM-stub-blind seam, so the runtime gates drive the REAL chat.js in
headless chromium — including the literal commissioned scenario: queue while offline
(context.set_offline), reload, reconnect, exactly-once delivery with order preserved — and the
Greptile repro: restored session-A item, session B current, nothing bleeds into B.

Run: cd frontend && .venv/bin/python -m pytest tests/test_891_reload_durable_outbox.py
"""

import json
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
# Source pins — the durability legs can't silently regress (cheap, no browser).
# ─────────────────────────────────────────────────────────────────────────────

def test_persistence_layer_exists_and_is_per_tab():
    js = _read("static/js/chatOutbox.js")
    assert "function _persistOutbox()" in js, "the persistence write point must exist"
    assert "'orwell-send-outbox:'" in js, "the storage key must be user-scoped (E71 pattern)"
    assert "sessionStorage.setItem(_outboxKey()" in js, "the queue must persist to sessionStorage"
    # The storage CHOICE is load-bearing (per-tab, no cross-tab double-drain) — pin the rationale.
    assert "localStorage is shared across tabs" in js, \
        "the per-tab sessionStorage-vs-localStorage justification must stay documented in source"
    assert "chatState._outboxAwaitingConfirm" in js, \
        "dispatched-but-unconfirmed items must be tracked (persisted through the in-flight window; moved to the chatState singleton — #1414)"


def test_enqueue_persists_immediately():
    js = _read("static/js/chatOutbox.js")
    fn = js[js.index("function _enqueueSend(text)"):]
    fn = fn[:fn.index("function _paintOutboxBubble")]
    assert "_persistOutbox();" in fn, "an enqueued send must be reload-durable from the instant it queues"
    assert "sessionId:" in fn, "the item must record its session for the restore-side dedupe/drain gates"


def test_restore_exists_and_dedupes_before_resend():
    js = _read("static/js/chatOutbox.js")
    assert "function _restoreOutboxFromStorage()" in js, "the boot restore must exist"
    restore = js[js.index("function _restoreOutboxFromStorage()"):]
    restore = restore[:restore.index("function _outboxConfirmDelivery")]
    assert "needsDedupe: true" in restore, \
        "EVERY restored item must verify against the server log before re-sending (at-most-once)"
    assert "_paintOutboxBubble(item)" in restore, "restored items must repaint their pending bubbles"
    # restore is wired to the boot (pageshow + retry schedule), not left for callers to remember
    assert "window.addEventListener('pageshow', _kickOutboxRestore" in js
    assert "function _dedupeOutboxAgainstServer()" in js.replace("async function", "function"), \
        "the pre-send server-log dedupe must exist"
    dd = js[js.index("async function _dedupeOutboxAgainstServer()"):]
    dd = dd[:dd.index("\n  // ──")]
    assert "metadata.client_msg_id" in dd.replace("m.metadata && m.metadata.client_msg_id", "metadata.client_msg_id"), \
        "dedupe must key on the server-stamped client_msg_id"
    assert "allVerified = false" in dd and "return allVerified" in dd, \
        "dedupe must FAIL CLOSED when verification is unavailable"
    # P1 fix (PR #1379): dedupe verifies each item against ITS OWN session's history — the
    # currently-selected session must play NO part in choosing which log to consult.
    assert "bySid" in dd and "it.sessionId" in dd, \
        "dedupe must group/verify by each item's OWN recorded sessionId"
    assert "getCurrentSessionId" not in dd, \
        "dedupe must NEVER consult the currently-selected session (the cross-session bleed root cause)"


def test_flush_gates_on_offline_and_dedupe_and_keeps_item_persisted_through_dispatch():
    js = _read("static/js/chatOutbox.js")
    fn = js[js.index("function _flushSendOutbox()"):]
    fn = fn[:fn.index("// ── #891 P0: durability wiring")]
    # original #985 guards intact
    assert "if (chatState._flushingOutbox) return;" in fn
    assert "if (chatState.isStreaming) return;" in fn
    assert "chatState._sendOutbox.shift()" in fn
    # the new gates
    offline_at = fn.index("_outboxOnline()")
    shift_at = fn.index("_sendOutbox.shift()")
    assert offline_at < shift_at, "the offline gate must run BEFORE an item is consumed"
    assert "_dedupeOutboxAgainstServer()" in fn, "the at-most-once preflight must gate the dispatch"
    dedupe_at = fn.index("_dedupeOutboxAgainstServer()")
    assert dedupe_at < shift_at, "dedupe must run BEFORE the item is consumed"
    assert "ok === false" in fn, "an unverifiable dedupe must defer the drain (fail closed)"
    # durability through the in-flight window: dispatch does NOT drop the persisted copy
    assert "_outboxAwaitingConfirm.push(item)" in fn and "_persistOutbox()" in fn, \
        "a dispatched item must stay in the persisted record until server-confirmed"


def test_item_session_binding_gates_the_dispatch():
    """P1 fix (PR #1379 — Greptile repro / CodeRabbit gate): an item with a recorded sessionId may
    only dispatch while ITS session is currently selected; a non-matching item is HELD (queue kept,
    _flushingOutbox reset, backoff armed) — never shifted into another session's send path."""
    js = _read("static/js/chat.js")              # the requeue CALL SITE stays in handleChatSubmit
    ob = _read("static/js/chatOutbox.js")        # #1414 R3 PR6: the flush body moved to chatOutbox.js
    fn = ob[ob.index("function _flushSendOutbox()"):]
    fn = fn[:fn.index("// ── #891 P0: durability wiring")]
    # the eligibility scan binds by session (and skips still-unverified items)
    assert "!it.sessionId || it.sessionId === _cur" in fn, \
        "dispatch eligibility must bind an item to ITS recorded session (null ⇒ pre-session semantics)"
    assert "!it.needsDedupe" in fn, "a still-unverified item must never be eligible to dispatch"
    # held path: reset the flush guard, arm the retry, and return BEFORE any item is consumed
    held_at = fn.index("if (_idx === -1) { chatState._flushingOutbox = false; _armOutboxRetry(); return; }")
    shift_at = fn.index("_sendOutbox.shift()")
    assert held_at < shift_at, "the hold must happen before an item is consumed"
    # the selectSession nudge exists, so a held item drains the moment its session is selected
    sess = _read("static/js/sessions.js")
    assert "window.chatModule._flushSendOutbox" in sess, \
        "sessions.js selectSession must nudge the outbox drain on session change"
    # a network-requeued item binds to the session the failed send actually targeted
    assert "_requeueOutboxItem(_clientMsgId, msg, _userMsgEl, streamSessionId)" in js, \
        "the catch-hook requeue must bind to the turn's streamSessionId, not current-at-catch-time"


def test_drain_is_self_continuing():
    """P1 fix (PR #1379 — drain starvation): a flush attempt landing while a dispatch is in flight
    is swallowed by the single-flight guard, and early-return dispatch paths never reach the
    stream-end finally that re-kicks the drain — so after each dispatch settles, the flush must
    re-invoke ITSELF while items remain (one hop per settle; every guard re-checked)."""
    js = _read("static/js/chatOutbox.js")
    fn = js[js.index("function _flushSendOutbox()"):]
    fn = fn[:fn.index("// ── #891 P0: durability wiring")]
    assert "const _continueDrain = () => {" in fn, "the settle continuation must exist"
    cont = fn[fn.index("const _continueDrain = () => {"):]
    cont_body = cont[:cont.index("};") + 2]
    assert "_flushingOutbox = false;" in cont_body, "the continuation must clear the single-flight guard"
    assert "_sendOutbox.length > 0" in cont_body and "_flushSendOutbox()" in cont_body, \
        "the continuation must re-run the flush while items remain (self-continuing drain)"
    # BOTH settle paths route through it: the dispatch promise's finally AND the sync-throw catch.
    assert ".finally(_continueDrain)" in fn, "the dispatch settle must continue the drain"
    assert cont.count("_continueDrain()") >= 1, "the sync-throw path must continue the drain too"


def test_offline_send_goes_straight_to_outbox():
    """A non-headless send while navigator.onLine === false must enqueue (honest 'queued — offline')
    instead of firing a doomed POST — placed AFTER the slash dispatch, BEFORE the BUG-1 early bubble
    / session materialization (so no session machinery runs for a dead link)."""
    js = _read("static/js/chat.js")
    fn = js[js.index("export async function handleChatSubmit"):]
    preflight_at = fn.index("an OFFLINE send goes STRAIGHT to the durable outbox")
    bug1_at = fn.index("BUG 1 (never eat a message)")
    materialize_at = fn.index("Materialize pending session")
    assert preflight_at < bug1_at < materialize_at
    block = fn[preflight_at:bug1_at]
    assert "!_headless && !_outboxOnline()" in block
    assert "_enqueueSend(msg);" in block
    assert "_armOutboxRetry();" in block
    assert "_releaseSendFlag();" in block, "the send flag must release or the next send wedges"


def test_network_failure_classification_and_requeue():
    js = _read("static/js/chat.js")              # the catch-hook CALL SITES stay in handleChatSubmit
    ob = _read("static/js/chatOutbox.js")        # #1414 R3 PR6: the outbox helpers moved to chatOutbox.js
    # the classifier is deliberately NARROW (browser fetch-network messages + navigator.onLine only)
    fn = ob[ob.index("function _isNetworkSendFailure(err)"):]
    fn = fn[:fn.index("async function _dedupeOutboxAgainstServer")]
    assert "failed to fetch" in fn and "networkerror" in fn
    assert "_outboxOnline()" in fn
    # the catch hook re-queues BEFORE the auto-recover branch, only for a zero-byte real player turn
    hook_at = js.index("_requeueOutboxItem(_clientMsgId, msg, _userMsgEl, streamSessionId)")
    recover_at = js.index("_tryAutoRecover(holder, accumulated, streamSessionId)")
    assert hook_at < recover_at, "the requeue classification must precede auto-recover"
    hook_region = js[hook_at - 600:hook_at]
    assert "!accumulated && _userMsgEl && _isNetworkSendFailure(err)" in hook_region + js[hook_at - 120:hook_at + 120], \
        "requeue must be gated on zero bytes + a real user bubble + the network classifier"
    # the requeue helper: idempotent, dedupe-armed, capped
    rq = ob[ob.index("function _requeueOutboxItem(clientMsgId, text, bubbleEl, sessionId)"):]
    rq = rq[:rq.index("function _isNetworkSendFailure")]
    assert "item.needsDedupe = true;" in rq, "a requeued POST may have reached the server — must re-verify"
    assert "_OUTBOX_MAX_RETRIES" in rq, "requeue must be capped (a misclassified error can't loop forever)"
    assert "_sendOutbox.unshift(item)" in rq, "the failed turn is the OLDEST — it re-sends first (order)"


def test_online_event_and_backoff_wiring():
    js = _read("static/js/chatOutbox.js")
    assert "window.addEventListener('online'" in js, "the reconnect drain must ride the 'online' event"
    assert "window.addEventListener('offline'" in js, "going offline must retag queued bubbles honestly"
    assert "function _armOutboxRetry()" in js
    arm = js[js.index("function _armOutboxRetry()"):]
    arm = arm[:arm.index("\n  /**")]
    assert "_OUTBOX_RETRY_MAX_MS" in arm and "* 2" in arm, "retry must back off exponentially with a cap"
    assert "const _OUTBOX_RETRY_BASE_MS = 2000" in js
    assert "const _OUTBOX_RETRY_MAX_MS = 60000" in js


def test_honest_status_tag_exists_and_is_styled():
    js = _read("static/js/chatOutbox.js")
    assert "function _setQueuedTag(bubbleEl, mode)" in js
    assert "'queued — offline'" in js and "'queued'" in js
    assert "tag.className = 'queued-tag'" in js, "the status must be a REAL text node (WCAG 4.1.3)"
    css = _read("static/style.css")
    assert ".msg-user .role .queued-tag" in css, "the queued tag must be styled in style.css"
    assert ".msg-user.msg-queued-offline .role .queued-tag" in css, \
        "the offline variant must be visually distinct"


def test_confirm_seam_and_single_send_path():
    # #1414 R3 PR7: the adopt pass (softReloadHistory) moved to chatReconcile.js.
    recon = _read("static/js/chatReconcile.js")
    # delivery confirm rides the EXISTING adopt pass (softReloadHistory) — no new reconcile path
    adopt_at = recon.index("// 1) ADOPT PASS — no DOM churn.")
    adopt_block = recon[adopt_at:adopt_at + 1400]
    assert "_outboxConfirmDelivery(cid)" in adopt_block, \
        "a server row carrying the clientMsgId must release the durable copy (adopt-pass seam)"
    js = _read("static/js/chat.js")
    # the drain still dispatches through the ONE dispatcher → handleChatSubmit (no second send path).
    # #1414 R3 PR6: the outbox moved to chatOutbox.js; chat.js registers the SOLE production dispatch
    # (still a headless handleChatSubmit) through the _setOutboxDispatch seam at module-eval, and the
    # module holds exactly one dispatcher variable.
    assert "_setOutboxDispatch((text, opts) => handleChatSubmit(null, text, opts))" in js, \
        "chat.js must register the production dispatch (→ handleChatSubmit) via the outbox seam"
    assert js.count("_setOutboxDispatch(") == 1, \
        "exactly one production dispatch registration → handleChatSubmit (no second send path)"
    ob = _read("static/js/chatOutbox.js")
    assert ob.count("let _outboxDispatch") == 1, "the outbox module holds exactly one dispatcher variable"


# ─────────────────────────────────────────────────────────────────────────────
# Runtime — drive the REAL chat.js in headless chromium.
# ─────────────────────────────────────────────────────────────────────────────

def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _log_tail(port, lines=40):
    try:
        with open(f"/tmp/fe-891-{port}.log", encoding="utf-8", errors="replace") as f:
            return "\n".join(f.read().splitlines()[-lines:])
    except Exception as e:  # pragma: no cover - diagnostics only
        return f"<log unreadable: {e}>"


def _boot(env, port):
    """Boot uvicorn. A startup failure is a REAL failure (raise with exit status + log tail) —
    never a skip: a boot regression must red-x this gate, not silently deselect it."""
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-891-{port}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError(
                f"uvicorn exited early (exit status {proc.returncode}); log tail:\n{_log_tail(port)}"
            )
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(1)
    proc.terminate()
    raise RuntimeError(f"server never became ready; log tail:\n{_log_tail(port)}")


@pytest.fixture(scope="module")
def _app():
    # Skip is reserved for a missing browser toolchain (playwright/chromium). A server-boot
    # failure FAILS loudly instead — see _boot.
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-891-"), "app.db"),
    )
    port = _free_port()
    proc, base = _boot(env, port)  # raises (fails the gate) on any startup problem
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


def _wait_ready(page):
    # Condition-based readiness (never a fixed sleep): the module graph is up once chat.js has
    # registered its public surface.
    page.wait_for_function("() => !!window.chatModule", timeout=15000)


def _new_context(pw, app, init_scripts=()):
    try:
        browser = pw.chromium.launch()
    except Exception as e:
        pytest.skip(f"chromium unavailable: {e}")
    context = browser.new_context()
    for script in init_scripts:
        context.add_init_script(script)
    page = context.new_page()
    page.goto(app + "/", wait_until="load", timeout=30000)
    _wait_ready(page)
    return browser, context, page


# The dispatch spy used after the reload: records (text, clientMsgId) and mimics the real
# stream-end finally by scheduling the next flush, so the drain chains FIFO exactly like prod.
_INSTALL_SPY = r"""
() => {
  const chat = window.chatModule;
  const sent = [];
  window.__durableSpy = sent;
  chat._setOutboxDispatch((text, opts) => {
    sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId });
    return Promise.resolve().then(() => { setTimeout(() => chat._flushSendOutbox(), 0); });
  });
  return true;
}
"""


# ── THE commissioned scenario: queue while OFFLINE → honest status → reload → restore →
#    reconnect ('online' event) → exactly-once delivery, order preserved. ─────────────────────────
def test_offline_queue_reload_reconnect_exactly_once_in_order(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, context, page = _new_context(
            pw, _app,
            # After the reload, hold the boot auto-drain until the spy is installed (deterministic —
            # the init script lands before any page script on every navigation).
            init_scripts=("window.__orwellOutboxHoldDrain = true;",),
        )
        # NOTE: the init script also applied to THIS first load — clear it so phase 1 behaves
        # exactly like production (offline enqueue never dispatches anyway).
        page.evaluate("() => { window.__orwellOutboxHoldDrain = false; }")

        # Phase 1 — go OFFLINE and send twice through the REAL submit path.
        context.set_offline(True)
        phase1 = page.evaluate(r"""
          async () => {
            const chat = window.chatModule;
            if (!chat || !chat.handleChatSubmit || !chat._outboxPeekStorage) return { error: 'helpers missing' };
            const box = document.getElementById('chat-history');
            if (box) box.innerHTML = '';
            chat._sendOutbox.length = 0;
            const mi = document.getElementById('message');
            mi.value = 'first offline msg';
            await chat.handleChatSubmit(null);
            const composerClearedAfterFirst = mi.value === '';
            mi.value = 'second offline msg';
            await chat.handleChatSubmit(null);
            const bubbles = Array.from(document.querySelectorAll('#chat-history .msg.msg-user'));
            const rec = chat._outboxPeekStorage();
            return {
              queueLen: chat._sendOutbox.length,
              ids: chat._sendOutbox.map(it => it.clientMsgId),
              storedItems: rec && rec.items ? rec.items.map(it => ({ id: it.clientMsgId, text: it.text, state: it.state })) : null,
              bubbleCount: bubbles.length,
              tags: bubbles.map(b => { const t = b.querySelector('.role .queued-tag'); return t ? t.textContent : null; }),
              offlineClass: bubbles.every(b => b.classList.contains('msg-queued-offline')),
              pending: bubbles.every(b => b.dataset.clientMsgId && !b.dataset.dbId),
              composerClearedAfterFirst,
              composerClearedAfterSecond: mi.value === '',
            };
          }
        """)
        assert "error" not in phase1, phase1.get("error")
        assert phase1["queueLen"] == 2, "both offline sends must be captured in the outbox (never dropped)"
        assert phase1["bubbleCount"] == 2, "each offline send must paint its optimistic bubble"
        assert phase1["pending"], "the bubbles must be pending optimistic sends (clientMsgId, no dbId)"
        assert phase1["tags"] == ["queued — offline", "queued — offline"], (
            f"an offline send must show the HONEST status, not spin: {phase1['tags']!r}"
        )
        assert phase1["offlineClass"], "the offline variant class must be applied"
        assert phase1["composerClearedAfterFirst"] and phase1["composerClearedAfterSecond"], \
            "the composer must clear — the words are safely captured in the durable queue"
        assert phase1["storedItems"] is not None and len(phase1["storedItems"]) == 2, \
            "the queue must be persisted (reload-durable) the instant it queues"
        assert [s["text"] for s in phase1["storedItems"]] == ["first offline msg", "second offline msg"]
        assert all(s["state"] == "queued" for s in phase1["storedItems"])
        pre_reload_ids = phase1["ids"]
        assert len(set(pre_reload_ids)) == 2 and all(i.startswith("c-") for i in pre_reload_ids)

        # Phase 2 — hold the drain in THIS page too, reconnect, and hard-reload (sessionStorage is
        # per-tab, so the record rides the same tab across the reload).
        page.evaluate("() => { window.__orwellOutboxHoldDrain = true; }")
        context.set_offline(False)
        page.reload(wait_until="load", timeout=30000)
        try:
            page.wait_for_function(
                "() => window.chatModule && window.chatModule._sendOutbox.length >= 2",
                timeout=20000,
            )
        except Exception as e:
            state = page.evaluate(
                "() => window.chatModule ? { n: window.chatModule._sendOutbox.length, rec: window.chatModule._outboxPeekStorage() } : null"
            )
            browser.close()
            pytest.fail(f"the queue never restored after the reload (the deferred #891 half): {state!r} — {e}")

        restored = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            const bubbles = Array.from(document.querySelectorAll('#chat-history .msg.msg-user'))
              .filter(b => b.dataset.clientMsgId && !b.dataset.dbId);
            return {
              ids: chat._sendOutbox.map(it => it.clientMsgId),
              texts: chat._sendOutbox.map(it => it.text),
              needsDedupe: chat._sendOutbox.every(it => it.needsDedupe === true),
              repainted: bubbles.length,
            };
          }
        """)
        assert restored["ids"] == pre_reload_ids, (
            "the client message ids (the idempotency keys) must survive the reload byte-identical: "
            f"{restored['ids']!r} vs {pre_reload_ids!r}"
        )
        assert restored["texts"] == ["first offline msg", "second offline msg"], "order must be preserved"
        assert restored["needsDedupe"], "restored items must be marked for the pre-send server-log check"
        assert restored["repainted"] >= 2, "the restored queue must repaint its pending bubbles"

        # Phase 3 — install the spy, release the hold, and drain via the REAL 'online' seam.
        page.evaluate(_INSTALL_SPY)
        page.evaluate("() => { window.__orwellOutboxHoldDrain = false; window.dispatchEvent(new Event('online')); }")
        try:
            page.wait_for_function("() => (window.__durableSpy || []).length >= 2", timeout=15000)
        except Exception as e:
            spy = page.evaluate("() => (window.__durableSpy || []).map(s => s.text)")
            browser.close()
            pytest.fail(f"the reconnect drain never delivered both queued sends: {spy!r} — {e}")
        # Exactly-once: an extra flush + settle window must not re-dispatch anything.
        page.evaluate("() => window.chatModule._flushSendOutbox()")
        _frames(page, 6)  # A83: 6 page frames (the bounded settle window), was a fixed 400ms
        final = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            const sent = window.__durableSpy || [];
            const rec = chat._outboxPeekStorage();
            return {
              order: sent.map(s => s.text),
              ids: sent.map(s => s.clientMsgId),
              sentCount: sent.length,
              queueDrained: chat._sendOutbox.length === 0,
              awaiting: chat._outboxAwaitingConfirm.map(it => it.clientMsgId),
              storedStates: rec && rec.items ? rec.items.map(it => it.state) : null,
            };
          }
        """)
        assert final["sentCount"] == 2, (
            f"exactly-once: both sends deliver, neither doubles — got {final['sentCount']} ({final['order']!r})"
        )
        assert final["order"] == ["first offline msg", "second offline msg"], (
            f"delivery must preserve send order: {final['order']!r}"
        )
        assert final["ids"] == pre_reload_ids, "the dispatched sends must carry the ORIGINAL client ids"
        assert final["queueDrained"]
        # Durability through the in-flight window: still persisted until the server row is observed…
        assert final["awaiting"] == pre_reload_ids
        assert final["storedStates"] == ["inflight", "inflight"], \
            "a dispatched-but-unconfirmed item must STILL be reload-durable"
        # …and released exactly when delivery is confirmed.
        confirmed = page.evaluate(r"""
          (ids) => {
            const chat = window.chatModule;
            ids.forEach(id => chat._outboxConfirmDelivery(id));
            return { awaiting: chat._outboxAwaitingConfirm.length, rec: chat._outboxPeekStorage() };
          }
        """, pre_reload_ids)
        assert confirmed["awaiting"] == 0
        assert confirmed["rec"] is None, "a confirmed delivery must release the persisted copy"
        browser.close()


# ── At-most-once across a reload: an item whose row ALREADY reached the server never re-sends. ───
def test_restored_item_already_on_server_never_double_sends(_app):
    from playwright.sync_api import sync_playwright
    seed = json.dumps({
        "v": 1,
        "items": [{
            "clientMsgId": "c-891-dup", "text": "already delivered turn",
            "sessionId": "sess-891-dup", "ts": 1, "retries": 0, "state": "inflight",
        }],
    })
    init = (
        "window.__orwellOutboxHoldDrain = true;"
        "try { sessionStorage.setItem('orwell-send-outbox:', %s); } catch (_) {}"
        % json.dumps(seed)
    )
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        context = browser.new_context()
        context.add_init_script(init)
        page = context.new_page()
        # The server already persisted this client_msg_id (stubbed history for the recorded session).
        page.route(
            "**/api/history/sess-891-dup",
            lambda route: route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({"history": [{
                    "role": "user", "content": "already delivered turn",
                    "metadata": {"client_msg_id": "c-891-dup"},
                }]}),
            ),
        )
        page.goto(_app + "/", wait_until="load", timeout=30000)
        _wait_ready(page)
        try:
            page.wait_for_function(
                "() => window.chatModule && window.chatModule._sendOutbox.length >= 1",
                timeout=20000,
            )
        except Exception as e:
            browser.close()
            pytest.fail(f"the seeded record never restored — {e}")
        page.evaluate(_INSTALL_SPY)
        page.evaluate("() => { window.__orwellOutboxHoldDrain = false; window.chatModule._flushSendOutbox(); }")
        try:
            page.wait_for_function(
                "() => window.chatModule._sendOutbox.length === 0",
                timeout=15000,
            )
        except Exception as e:
            state = page.evaluate("() => ({ n: window.chatModule._sendOutbox.length, spy: window.__durableSpy })")
            browser.close()
            pytest.fail(f"the dedupe pass never resolved the queued duplicate: {state!r} — {e}")
        _frames(page, 6)  # A83: 6 page frames (the bounded settle window), was a fixed 300ms
        result = page.evaluate(r"""
          () => ({
            dispatched: (window.__durableSpy || []).length,
            rec: window.chatModule._outboxPeekStorage(),
          })
        """)
        browser.close()
    assert result["dispatched"] == 0, (
        "an item whose client_msg_id the server already persisted must NEVER re-send "
        f"(at-most-once across a reload) — got {result['dispatched']} dispatches"
    )
    assert result["rec"] is None, "the proven-delivered item must be released from storage"


# ── Requeue semantics: idempotent per id, capped, confirm releases everything. ───────────────────
def test_requeue_idempotent_capped_and_confirm_releases(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, context, page = _new_context(pw, _app)
        result = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            if (!chat || !chat._requeueOutboxItem) return { error: 'helpers missing' };
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            try { sessionStorage.removeItem('orwell-send-outbox:'); } catch (_) {}

            // idempotent per clientMsgId: a double network-failure classification queues ONE copy
            const r1 = chat._requeueOutboxItem('c-rq-891', 'hello world', null);
            const r2 = chat._requeueOutboxItem('c-rq-891', 'hello world', null);
            const rec1 = chat._outboxPeekStorage();
            const afterTwo = {
              r1, r2,
              queueLen: chat._sendOutbox.length,
              needsDedupe: chat._sendOutbox[0] && chat._sendOutbox[0].needsDedupe === true,
              persisted: !!(rec1 && rec1.items && rec1.items.length === 1),
            };

            // capped: an item that has burned its retries hands the turn back (returns false)
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.push({ clientMsgId: 'c-cap-891', text: 'x', retries: 4, sessionId: null, ts: 1 });
            const capOk = chat._requeueOutboxItem('c-cap-891', 'x', null);
            const capState = { capOk, queueLen: chat._sendOutbox.length, awaiting: chat._outboxAwaitingConfirm.length };

            // confirm releases queue + awaiting + storage
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            chat._requeueOutboxItem('c-cf-891', 'bye', null);
            chat._outboxConfirmDelivery('c-cf-891');
            const confirmed = { queueLen: chat._sendOutbox.length, rec: chat._outboxPeekStorage() };

            return { afterTwo, capState, confirmed };
          }
        """)
        browser.close()
    assert "error" not in result, result.get("error")
    a = result["afterTwo"]
    assert a["r1"] is True and a["r2"] is True and a["queueLen"] == 1, \
        f"requeue must be idempotent per clientMsgId (one copy): {a!r}"
    assert a["needsDedupe"], "a requeued item must re-verify against the server before re-sending"
    assert a["persisted"], "a requeued item must be reload-durable"
    c = result["capState"]
    assert c["capOk"] is False and c["queueLen"] == 0, \
        f"past the retry cap the requeue must decline (the normal error surface speaks): {c!r}"
    f = result["confirmed"]
    assert f["queueLen"] == 0 and f["rec"] is None, \
        "a confirmed delivery must release every durable copy"


# ── P1 regression (PR #1379 — Greptile's executed repro): a restored session-A item with session B
#    current must NOT be verified against B, must NOT dispatch into B, and must deliver exactly once
#    into A the moment A is selected. ─────────────────────────────────────────────────────────────
def test_restored_item_never_bleeds_into_another_session(_app):
    from playwright.sync_api import sync_playwright
    seed = json.dumps({
        "v": 1,
        "items": [
            {"clientMsgId": "c-a-pending", "text": "turn for session A",
             "sessionId": "sess-a-891", "ts": 1, "retries": 0, "state": "queued"},
            {"clientMsgId": "c-a-delivered", "text": "already delivered in A",
             "sessionId": "sess-a-891", "ts": 2, "retries": 0, "state": "inflight"},
        ],
    })
    init = (
        "window.__orwellOutboxHoldDrain = true;"
        "try { sessionStorage.setItem('orwell-send-outbox:', %s); } catch (_) {}"
        % json.dumps(seed)
    )
    a_hits, b_hits = [], []
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        context = browser.new_context()
        context.add_init_script(init)
        page = context.new_page()
        # Session A's log already carries c-a-delivered (its POST landed before the reload);
        # session B's log is empty. Both stubs count their hits so we can prove which log the
        # dedupe consulted (the page's own history loader also hits these on selectSession —
        # the assertions therefore compare DELTAS across the isolated flush window).
        page.route(
            "**/api/history/sess-a-891",
            lambda route: (a_hits.append(1), route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({"history": [{
                    "role": "user", "content": "already delivered in A",
                    "metadata": {"client_msg_id": "c-a-delivered"},
                }]}),
            ))[-1],
        )
        page.route(
            "**/api/history/sess-b-891",
            lambda route: (b_hits.append(1), route.fulfill(
                status=200, content_type="application/json",
                body=json.dumps({"history": []}),
            ))[-1],
        )
        page.goto(_app + "/", wait_until="load", timeout=30000)
        _wait_ready(page)
        page.wait_for_function(
            "() => window.chatModule && window.chatModule._sendOutbox.length >= 2",
            timeout=20000,
        )

        # Make session B current BEFORE the drain (the exact repro ordering).
        page.evaluate("() => { window.sessionModule.selectSession('sess-b-891'); }")
        page.wait_for_function(
            "() => window.sessionModule.getCurrentSessionId() === 'sess-b-891'",
            timeout=15000,
        )
        _frames(page, 6)  # A83: 6 page frames (the bounded settle window), was a fixed 400ms - let selectSession's finally (incl. its drain nudge) settle

        # Isolated flush window: spy installed, hit counters snapshotted, hold released.
        page.evaluate(_INSTALL_SPY)
        a0, b0 = len(a_hits), len(b_hits)
        page.evaluate("() => { window.__orwellOutboxHoldDrain = false; window.chatModule._flushSendOutbox(); }")
        try:
            page.wait_for_function(
                "() => window.chatModule._sendOutbox.length === 1",
                timeout=15000,
            )
        except Exception as e:
            state = page.evaluate("() => ({ n: window.chatModule._sendOutbox.length, spy: window.__durableSpy })")
            browser.close()
            pytest.fail(f"the dedupe pass never settled the seeded queue under session B: {state!r} — {e}")
        _frames(page, 6)  # A83: 6 page frames (the bounded settle window), was a fixed 400ms
        under_b = page.evaluate(r"""
          () => ({
            dispatched: (window.__durableSpy || []).map(s => ({ text: s.text, id: s.clientMsgId })),
            remaining: window.chatModule._sendOutbox.map(it => it.clientMsgId),
            rec: window.chatModule._outboxPeekStorage(),
          })
        """)
        # (1) NOTHING dispatched into B — the A-bound item is held, not re-targeted.
        assert under_b["dispatched"] == [], (
            f"cross-session bleed: a session-A item dispatched while session B was current — {under_b['dispatched']!r}"
        )
        # (2) The dedupe consulted A's log (dropping the already-delivered copy), never B's.
        assert len(a_hits) - a0 >= 1, "the dedupe must verify against the item's OWN session (A)"
        assert len(b_hits) - b0 == 0, (
            "the dedupe/drain must not touch the CURRENT session's (B's) history — that was the bleed"
        )
        assert under_b["remaining"] == ["c-a-pending"], (
            f"the delivered copy is released, the undelivered one HELD for its session: {under_b['remaining']!r}"
        )
        assert under_b["rec"] is not None and [i["clientMsgId"] for i in under_b["rec"]["items"]] == ["c-a-pending"], \
            "the held item must stay reload-durable while it waits for its session"

        # (3) Selecting A drains it — exactly once, into A, via the selectSession nudge.
        page.evaluate("() => { window.sessionModule.selectSession('sess-a-891'); }")
        try:
            page.wait_for_function("() => (window.__durableSpy || []).length >= 1", timeout=15000)
        except Exception as e:
            state = page.evaluate("() => ({ cur: window.sessionModule.getCurrentSessionId(), n: window.chatModule._sendOutbox.length })")
            browser.close()
            pytest.fail(f"the held item never drained after its session was selected: {state!r} — {e}")
        page.evaluate("() => window.chatModule._flushSendOutbox()")
        _frames(page, 6)  # A83: 6 page frames (the bounded settle window), was a fixed 400ms
        final = page.evaluate(r"""
          () => ({
            dispatched: (window.__durableSpy || []).map(s => ({ text: s.text, id: s.clientMsgId })),
            queueLen: window.chatModule._sendOutbox.length,
            awaiting: window.chatModule._outboxAwaitingConfirm.map(it => it.clientMsgId),
          })
        """)
        browser.close()
    assert final["dispatched"] == [{"text": "turn for session A", "id": "c-a-pending"}], (
        f"exactly-once delivery into the item's OWN session: {final['dispatched']!r}"
    )
    assert final["queueLen"] == 0
    assert final["awaiting"] == ["c-a-pending"], "the delivered item awaits its server-row confirm"


# ── P1 regression (PR #1379 — drain starvation): with TWO items queued, one recovery cycle must
#    drain BOTH, with no external nudge between them. The dispatch spy here deliberately does NOT
#    mimic the stream-end finally's re-kick (unlike _INSTALL_SPY): on pre-fix code the guard
#    swallowed any flush attempt made while a dispatch was in flight, and the settle only cleared
#    the guard — so the second item sat stuck until some unrelated event nudged the outbox. The
#    drain must be SELF-CONTINUING. ─────────────────────────────────────────────────────────────
def test_drain_self_continues_both_items_in_one_recovery_cycle(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser, context, page = _new_context(pw, _app)

        # Queue TWO real sends while offline (same session — both carry the same null/current
        # binding), exactly the commissioned shape.
        context.set_offline(True)
        seeded = page.evaluate(r"""
          async () => {
            const chat = window.chatModule;
            if (!chat || !chat.handleChatSubmit) return { error: 'helpers missing' };
            const box = document.getElementById('chat-history');
            if (box) box.innerHTML = '';
            chat._sendOutbox.length = 0;
            chat._outboxAwaitingConfirm.length = 0;
            const mi = document.getElementById('message');
            mi.value = 'starve check one';
            await chat.handleChatSubmit(null);
            mi.value = 'starve check two';
            await chat.handleChatSubmit(null);
            // NON-KICKING spy: records and resolves — schedules NOTHING. Any second delivery must
            // come from the drain continuing itself.
            const sent = [];
            window.__starveSpy = sent;
            chat._setOutboxDispatch((text, opts) => {
              sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId });
              return Promise.resolve();
            });
            return { queueLen: chat._sendOutbox.length, ids: chat._sendOutbox.map(it => it.clientMsgId) };
          }
        """)
        assert "error" not in seeded, seeded.get("error")
        assert seeded["queueLen"] == 2, f"both offline sends must queue: {seeded!r}"

        # ONE recovery cycle: reconnect. The 'online' handler fires a single flush (and clears any
        # armed backoff timer) — the second item may only arrive via the self-continuing drain.
        context.set_offline(False)
        try:
            page.wait_for_function("() => (window.__starveSpy || []).length >= 2", timeout=15000)
        except Exception as e:
            state = page.evaluate(r"""
              () => ({
                dispatched: (window.__starveSpy || []).map(s => s.text),
                queued: window.chatModule._sendOutbox.map(it => it.text),
              })
            """)
            browser.close()
            pytest.fail(
                "drain starvation: the second queued item never delivered in the same recovery "
                f"cycle (dispatched {state['dispatched']!r}, still queued {state['queued']!r}) — {e}"
            )
        # Exactly-once: settle window + a redundant flush must not re-dispatch anything.
        page.evaluate("() => window.chatModule._flushSendOutbox()")
        _frames(page, 6)  # A83: 6 page frames (the bounded settle window), was a fixed 400ms
        result = page.evaluate(r"""
          () => {
            const chat = window.chatModule;
            const sent = window.__starveSpy || [];
            chat._setOutboxDispatch((text, opts) => chat.handleChatSubmit(null, text, opts));
            const ids = sent.map(s => s.clientMsgId);
            return {
              order: sent.map(s => s.text),
              sentCount: sent.length,
              uniqueIds: new Set(ids).size === ids.length,
              ids,
              queueDrained: chat._sendOutbox.length === 0,
            };
          }
        """)
        browser.close()
    assert result["order"] == ["starve check one", "starve check two"], (
        f"both items must deliver IN ORDER through one recovery cycle: {result['order']!r}"
    )
    assert result["sentCount"] == 2, f"exactly-once: got {result['sentCount']} dispatches"
    assert result["uniqueIds"], "each delivery must carry its own clientMsgId (no double-send)"
    assert result["ids"] == seeded["ids"], "the dispatched sends must be the queued items themselves"
    assert result["queueDrained"], "the queue must be empty after the drain"


# ─────────────────────────────────────────────────────────────────────────────
# #1785 (T1-4 A1-A5) — ACK-IS-THE-ROW: outbox confirm from stream event path + migration
# ─────────────────────────────────────────────────────────────────────────────

def test_stream_event_path_calls_outbox_confirm_delivery():
    """#1785 A5: _outboxConfirmDelivery must be called from the stream event path
    (renderObserverUserMessage), not only from the reconcile poll."""
    js = _read("static/js/chat.js")
    # Find renderObserverUserMessage and verify it calls _outboxConfirmDelivery
    fn = js[js.index("export function renderObserverUserMessage(ev, opts)"):]
    fn_body = fn[:fn.index("export function ")] if "\nexport function " in fn else fn[:2000]
    assert "_outboxConfirmDelivery(cid)" in fn_body, \
        "renderObserverUserMessage must call _outboxConfirmDelivery from the dedup branch"
    # Verify the call is INSIDE the dedup-if block, i.e. before that branch's `return existing;`
    # (the old slice did `index("}" + 3)` — a str+int TypeError — and the branch contains nested
    # `{ try { … } catch (_) {} }` braces, so "first `}`" was never the block end anyway).
    start = fn_body.index("if (existing) {")
    dedup_block = fn_body[start:fn_body.index("return existing;", start)]
    assert "_outboxConfirmDelivery(cid)" in dedup_block, \
        "_outboxConfirmDelivery must be called in the dedup-existing branch"


def test_migration_adds_client_msg_id_column_and_unique_index():
    """#1785 A2: migration must add client_msg_id column, backfill from metadata,
    de-dup pre-existing duplicates, and create the unique index."""
    import sqlite3
    import tempfile
    import os
    import json
    from core.database import _migrate_add_chat_message_client_msg_id_column, DATABASE_URL

    db_fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(db_fd)
    try:
        conn = sqlite3.connect(db_path)
        conn.execute("CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT, content TEXT, metadata TEXT)")
        # Insert rows: two with distinct client_msg_ids, two with same client_msg_id (duplicates)
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, content, metadata) VALUES (?, ?, ?, ?)",
            ("1", "sess1", "hello", json.dumps({"client_msg_id": "cid-a"}))
        )
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, content, metadata) VALUES (?, ?, ?, ?)",
            ("2", "sess1", "world", json.dumps({"client_msg_id": "cid-b"}))
        )
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, content, metadata) VALUES (?, ?, ?, ?)",
            ("3", "sess1", "dup", json.dumps({"client_msg_id": "cid-a"}))  # duplicate! same session + client_msg_id
        )
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, content, metadata) VALUES (?, ?, ?, ?)",
            ("4", "sess2", "alone", json.dumps({"client_msg_id": "cid-c"}))
        )
        conn.commit()
        conn.close()

        # Monkey-patch DATABASE_URL to point at our temp file
        import core.database as db_module
        _original_url = db_module.DATABASE_URL
        try:
            db_module.DATABASE_URL = f"sqlite:///{db_path}"
            _migrate_add_chat_message_client_msg_id_column()

            conn2 = sqlite3.connect(db_path)
            cursor = conn2.execute("PRAGMA table_info(chat_messages)")
            cols = [row[1] for row in cursor.fetchall()]
            assert "client_msg_id" in cols, "client_msg_id column must exist after migration"

            # Verify backfill — every row gets its id from metadata EXCEPT the later duplicate: the
            # migration's defensive de-dup keeps the FIRST row per (session, client_msg_id) (MIN rowid)
            # and NULLs the rest so the unique index can be created (rows are never deleted).
            got = dict(conn2.execute("SELECT id, client_msg_id FROM chat_messages"))
            assert got == {"1": "cid-a", "2": "cid-b", "3": None, "4": "cid-c"}, got

            # Verify de-dup: only one row per (session_id, client_msg_id) pair survives
            rows = list(conn2.execute(
                "SELECT session_id, client_msg_id, COUNT(*) as cnt FROM chat_messages GROUP BY session_id, client_msg_id"
            ))
            for r in rows:
                assert r[2] == 1, f"duplicate (session={r[0]}, cid={r[1]}) not removed: count={r[2]}"

            # Verify unique index was created
            indexes = conn2.execute("PRAGMA index_list(chat_messages)").fetchall()
            index_names = [row[1] for row in indexes]
            assert "ix_messages_session_client_msg_id" in index_names, \
                "unique index ix_messages_session_client_msg_id must exist after migration"
            conn2.close()
        finally:
            db_module.DATABASE_URL = _original_url
    finally:
        os.unlink(db_path)
