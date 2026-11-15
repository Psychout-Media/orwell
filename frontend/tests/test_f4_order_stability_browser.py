"""#891 F4 order-stability — browser repros (see test_f4_order_stability.py for the source pins).

Two owner-reported live regressions, driven against the REAL chat.js in headless chromium:

1. THE REFRESH-MID-HANG ORDERING SCENARIO (the wedge repro). Send A's POST hangs for minutes (the
   server wedge) → the player sends B (queued behind the single-flight guard) → the player REFRESHES
   mid-hang. Pre-fix: A had no durable record (direct sends were never outbox-held) — the reload lost
   A, restored+dispatched B first, and A's zombie POST could still persist later server-side → a
   permanent send-order inversion. Post-fix: A restores AHEAD of B (the awaiting-confirm record
   serializes first), a fresh send C queues BEHIND both (the per-session FIFO gate), and the drain
   delivers A → B → C in original send order, exactly once each.

2. OOC RETRO-STYLING (metadata half). A message classified out-of-character AFTER the fact — server
   metadata `ooc: true`, no `((...))`/`ooc:` markers — must render `.msg-ooc` BOTH live-settled (the
   reconcile adopt pass retro-applies it to the already-rendered bubble, same node, no rebuild) and
   after a reload (addMessage reads it off the row metadata), byte-consistent across the two paths.

Roles only; no names (CLAUDE.md).

Run: cd frontend && .venv/bin/python -m pytest tests/test_f4_order_stability_browser.py -m browser
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _log_tail(port, lines=40):
    try:
        with open(f"/tmp/fe-f4ord-{port}.log", encoding="utf-8", errors="replace") as f:
            return "\n".join(f.read().splitlines()[-lines:])
    except Exception as e:  # pragma: no cover - diagnostics only
        return f"<log unreadable: {e}>"


def _boot(env, port):
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-f4ord-{port}.log", "w"), stderr=subprocess.STDOUT,
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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-f4ord-"), "app.db"),
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


# The dispatch spy: records (text, clientMsgId) and mimics the real stream-end finally by
# scheduling the next flush, so the drain chains FIFO exactly like prod.
_INSTALL_SPY = r"""
() => {
  const chat = window.chatModule;
  const sent = [];
  window.__orderSpy = sent;
  chat._setOutboxDispatch((text, opts) => {
    sent.push({ text, clientMsgId: opts && opts.queuedClientMsgId });
    return Promise.resolve().then(() => { setTimeout(() => chat._flushSendOutbox(), 0); });
  });
  return true;
}
"""


# ─────────────────────────────────────────────────────────────────────────────
# 1. The commissioned refresh-mid-hang ordering repro.
# ─────────────────────────────────────────────────────────────────────────────

def test_refresh_mid_hang_preserves_send_order_a_b_c(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        context = browser.new_context()
        # After the reload, hold the boot auto-drain until the spy is installed.
        context.add_init_script("window.__orwellOutboxHoldDrain = true;")
        # THE WEDGE: /api/chat_stream hangs forever (the route is never fulfilled) — exactly the
        # owner's hung house-entry hold, at the transport layer.
        context.route("**/api/chat_stream", lambda route: None)
        page = context.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        _wait_ready(page)
        page.evaluate("() => { window.__orwellOutboxHoldDrain = false; }")

        # A real session to send into (bare placeholder — the POST is stalled client-side anyway).
        sid = page.evaluate(r"""
          async () => {
            const fd = new FormData();
            fd.append('name', 'order-stability repro');
            fd.append('skip_validation', 'true');
            const res = await fetch('/api/session', { method: 'POST', body: fd });
            const j = await res.json();
            await window.sessionModule.loadSessions();
            await window.sessionModule.selectSession(j.id);
            return j.id;
          }
        """)
        assert sid, "the repro needs a real session"
        page.wait_for_function(
            "sid => window.sessionModule.getCurrentSessionId() === sid", arg=sid, timeout=15000,
        )

        # Phase 1 — send A through the REAL submit path. Its POST hangs (the route); do NOT await.
        page.evaluate(r"""
          () => {
            const mi = document.getElementById('message');
            mi.value = 'first send A (hangs)';
            window.chatModule.handleChatSubmit(null);   // deliberately not awaited — it is WEDGED
          }
        """)
        # The durable in-flight record must exist while the POST hangs (the fix's HOLE A half).
        try:
            page.wait_for_function(
                """() => {
                  const rec = window.chatModule._outboxPeekStorage();
                  return !!(rec && rec.items && rec.items.some(it => it.state === 'inflight'));
                }""",
                timeout=15000,
            )
        except Exception as e:
            state = page.evaluate("() => window.chatModule._outboxPeekStorage()")
            browser.close()
            pytest.fail(f"a direct send must be outbox-held (state:'inflight') while its POST hangs: {state!r} — {e}")

        # Phase 2 — send B while A hangs: the send-while-streaming branch queues it (#985 P2-A).
        page.evaluate(r"""
          () => {
            const mi = document.getElementById('message');
            mi.value = 'second send B (queued)';
            window.chatModule.handleChatSubmit(null);
          }
        """)
        page.wait_for_function(
            "() => window.chatModule._sendOutbox.length >= 1", timeout=15000,
        )
        stored = page.evaluate(
            "() => (window.chatModule._outboxPeekStorage().items || []).map(it => ({ text: it.text, state: it.state }))"
        )
        assert [s["state"] for s in stored] == ["inflight", "queued"], (
            f"the persisted record must hold A (inflight) BEFORE B (queued): {stored!r}"
        )

        # Phase 3 — REFRESH mid-hang (the wedge scenario). The init script holds the auto-drain.
        page.reload(wait_until="load", timeout=30000)
        _wait_ready(page)
        try:
            page.wait_for_function(
                "() => window.chatModule._sendOutbox.length >= 2", timeout=20000,
            )
        except Exception as e:
            state = page.evaluate(
                "() => ({ n: window.chatModule._sendOutbox.length, rec: window.chatModule._outboxPeekStorage() })"
            )
            browser.close()
            pytest.fail(f"BOTH the hung direct send and the queued send must restore: {state!r} — {e}")
        restored = page.evaluate(r"""
          () => ({
            texts: window.chatModule._sendOutbox.map(it => it.text),
            needsDedupe: window.chatModule._sendOutbox.every(it => it.needsDedupe === true),
          })
        """)
        assert restored["texts"] == ["first send A (hangs)", "second send B (queued)"], (
            f"the restore must preserve DISPATCH order — A (older, was in flight) ahead of B: {restored['texts']!r}"
        )
        assert restored["needsDedupe"], "restored items must re-verify against the server log (at-most-once)"

        # Phase 4 — a FRESH send C must NOT jump ahead (the FIFO gate). Real submit path; the hold
        # flag only gates the drain, so a regression would dispatch C directly into the stalled POST.
        page.wait_for_function(
            "sid => window.sessionModule.getCurrentSessionId() === sid", arg=sid, timeout=15000,
        )
        page.evaluate(r"""
          () => {
            const mi = document.getElementById('message');
            mi.value = 'third send C (fresh)';
            window.chatModule.handleChatSubmit(null);
          }
        """)
        try:
            page.wait_for_function(
                "() => window.chatModule._sendOutbox.length === 3", timeout=15000,
            )
        except Exception as e:
            state = page.evaluate(
                "() => ({ q: window.chatModule._sendOutbox.map(it => it.text), streaming: window.chatModule._isStreaming() })"
            )
            browser.close()
            pytest.fail(f"a fresh send must JOIN the queue behind the restored unconfirmed turns: {state!r} — {e}")
        queue = page.evaluate("() => window.chatModule._sendOutbox.map(it => it.text)")
        assert queue == ["first send A (hangs)", "second send B (queued)", "third send C (fresh)"], (
            f"per-session FIFO: the fresh send sits BEHIND the restored older turns: {queue!r}"
        )

        # Phase 5 — release the drain: delivery must be A → B → C, exactly once each.
        page.evaluate(_INSTALL_SPY)
        page.evaluate("() => { window.__orwellOutboxHoldDrain = false; window.chatModule._flushSendOutbox(); }")
        try:
            page.wait_for_function("() => (window.__orderSpy || []).length >= 3", timeout=20000)
        except Exception as e:
            state = page.evaluate(
                "() => ({ spy: (window.__orderSpy || []).map(s => s.text), q: window.chatModule._sendOutbox.map(it => it.text) })"
            )
            browser.close()
            pytest.fail(f"the drain never delivered all three sends: {state!r} — {e}")
        page.evaluate("() => window.chatModule._flushSendOutbox()")
        page.wait_for_timeout(400)
        final = page.evaluate(r"""
          () => ({
            order: (window.__orderSpy || []).map(s => s.text),
            queueDrained: window.chatModule._sendOutbox.length === 0,
          })
        """)
        browser.close()
    assert final["order"] == [
        "first send A (hangs)", "second send B (queued)", "third send C (fresh)",
    ], f"delivery must preserve the original send order A → B → C: {final['order']!r}"
    assert final["queueDrained"]


# ─────────────────────────────────────────────────────────────────────────────
# 2. OOC retro-styling from server metadata — live-settled vs reload parity.
# ─────────────────────────────────────────────────────────────────────────────

def test_ooc_metadata_styles_live_settled_and_reload_byte_consistent(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        context = browser.new_context()
        page = context.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        _wait_ready(page)

        sid = page.evaluate(r"""
          async () => {
            const fd = new FormData();
            fd.append('name', 'ooc retro-style repro');
            fd.append('skip_validation', 'true');
            const res = await fetch('/api/session', { method: 'POST', body: fd });
            const j = await res.json();
            await window.sessionModule.loadSessions();
            await window.sessionModule.selectSession(j.id);
            return j.id;
          }
        """)
        assert sid
        page.wait_for_function(
            "sid => window.sessionModule.getCurrentSessionId() === sid", arg=sid, timeout=15000,
        )

        result = page.evaluate(r"""
          async (sid) => {
            const chat = window.chatModule;
            const box = document.getElementById('chat-history');
            box.innerHTML = '';

            // LIVE-SETTLED half: a marker-less user bubble is already on screen (the optimistic
            // render); the server then classifies the persisted row OOC (metadata ooc:true). The
            // reconcile ADOPT pass must retro-apply the class to the SAME node — no rebuild.
            const live = chat.addMessage('user', 'plain words, no markers', null,
                                         { client_msg_id: 'c-ooc-live' });
            live.__sameNodeProbe = true;
            const oocBefore = live.classList.contains('msg-ooc');

            const history = [{
              role: 'user', content: 'plain words, no markers', id: 'm-ooc-1', seq: 1,
              metadata: { _db_id: 'm-ooc-1', _seq: 1, client_msg_id: 'c-ooc-live', ooc: true },
            }];
            const origFetch = window.fetch;
            window.fetch = (url, opts) => {
              if (String(url).includes('/api/history/' + sid)) {
                return Promise.resolve(new Response(
                  JSON.stringify({ history }), { status: 200, headers: { 'Content-Type': 'application/json' } }
                ));
              }
              return origFetch(url, opts);
            };
            try {
              await chat.softReloadHistory(sid);
            } finally {
              window.fetch = origFetch;
            }
            const settled = box.querySelector('.msg[data-client-msg-id="c-ooc-live"]');
            const liveHalf = {
              oocBefore,
              oocAfter: !!(settled && settled.classList.contains('msg-ooc')),
              sameNode: !!(settled && settled.__sameNodeProbe),   // adopt, not a rebuild
              producerLeak: !!(settled && settled.classList.contains('msg-ooc-producer')), // user = never producer
            };

            // RELOAD half: the same row rendered fresh from history metadata (addMessage path).
            box.innerHTML = '';
            const reloaded = chat.addMessage('user', 'plain words, no markers', null,
                                             { _db_id: 'm-ooc-1', _seq: 1, client_msg_id: 'c-ooc-live',
                                               ooc: true, _fromHistory: true });
            const reloadHalf = {
              ooc: reloaded.classList.contains('msg-ooc'),
              producerLeak: reloaded.classList.contains('msg-ooc-producer'),
            };

            // The assistant variant carries the producer class on BOTH paths.
            const aiReloaded = chat.addMessage('assistant', 'a marker-less producer aside', null,
                                               { _db_id: 'm-ooc-2', _seq: 2, ooc: true, _fromHistory: true });
            const aiHalf = {
              ooc: aiReloaded.classList.contains('msg-ooc'),
              producer: aiReloaded.classList.contains('msg-ooc-producer'),
            };

            // Marker-less + NO metadata mark: never styled (no client-side heuristic).
            const plain = chat.addMessage('user', 'ordinary in-character line', null,
                                          { _db_id: 'm-ooc-3', _seq: 3, _fromHistory: true });
            const plainHalf = { ooc: plain.classList.contains('msg-ooc') };

            return { liveHalf, reloadHalf, aiHalf, plainHalf, gameBuild: document.body.hasAttribute('data-game-build') };
          }
        """, sid)
        browser.close()

    assert result["gameBuild"], "the OOC styling contract is game-build-scoped — the harness must run the game build"
    lh = result["liveHalf"]
    assert lh["oocBefore"] is False, "a marker-less bubble must NOT be pre-styled (no heuristic)"
    assert lh["oocAfter"] is True, (
        "LIVE-SETTLED: the adopt pass must retro-apply .msg-ooc from the row's metadata "
        f"(the live-vs-reload divergence): {lh!r}"
    )
    assert lh["sameNode"], "the retro-apply must land on the SAME rendered node (adopt, never a rebuild)"
    assert lh["producerLeak"] is False, "a USER OOC aside never carries the producer variant"
    rh = result["reloadHalf"]
    assert rh["ooc"] is True, f"RELOAD: addMessage must style a metadata-marked OOC row: {rh!r}"
    assert rh["producerLeak"] is False
    assert result["liveHalf"]["oocAfter"] == result["reloadHalf"]["ooc"], \
        "live-settled and reload must be byte-consistent (same class verdict)"
    ai = result["aiHalf"]
    assert ai["ooc"] and ai["producer"], f"an assistant metadata-OOC row is a producer aside on both paths: {ai!r}"
    assert result["plainHalf"]["ooc"] is False, \
        "no metadata mark + no markers ⇒ never styled (classification stays server/model-side)"
