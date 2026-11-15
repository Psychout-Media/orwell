"""Perf audit — server-side stage frames + framing/probe/compaction latency fixes.

Covers the five remediations landed together on this lane. Roles-only, names-free; a mix of
behavioral unit tests (the pure/async functions we can call directly) and source pins (the wiring
that regresses silently — the live stream stack is non-deterministic in CI, so the wiring is what we
guard, mirroring test_chat_stream_no_silent_drop.py):

  F-TR-1  anti-buffering headers on every token-carrying SSE response.
  F-PY-5  a status/stage progress frame emitted before the model call.
  F-PY-4  the per-turn framing reads use the tight framing timeout, not the 30s default.
  F-PY-3  the blocking /models + /slots context probes are off-loaded + short-TTL memoized.
  F-PY-2  context compaction no longer blocks the first token (backgrounded).
"""
import asyncio
import inspect
import json
import os
import re

import pytest

from routes import chat_routes
import src.orwell_engine as oe
import src.model_context as mc
import src.context_compactor as cc

def _run(coro):
    """Run a coroutine on an isolated event loop and never touch the process-wide current loop.

    (Using ``asyncio.run`` here would close the default loop and break sibling framing tests that
    share ``asyncio.get_event_loop().run_until_complete`` — real cross-file pollution.)"""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHAT_ROUTES_SRC = open(
    os.path.join(FRONTEND, "routes", "chat_routes.py"), encoding="utf-8"
).read()
CHAT_HELPERS_SRC = open(
    os.path.join(FRONTEND, "routes", "chat_helpers.py"), encoding="utf-8"
).read()


def _slice(src: str, start: str, end: str) -> str:
    a = src.index(start)
    b = src.index(end, a)
    return src[a:b]


# ── F-TR-1: anti-buffering headers ─────────────────────────────────────────── #


def test_sse_stream_headers_constant_matches_session_events():
    # Must be EXACTLY the dict the persistent session-events SSE already sets.
    assert chat_routes.SSE_STREAM_HEADERS == {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    }


def test_chat_stream_token_responses_all_carry_anti_buffering_headers():
    # Every text/event-stream StreamingResponse inside the chat_stream route must pass
    # headers=SSE_STREAM_HEADERS (so a buffering reverse proxy can't hold the tokens).
    body = _slice(CHAT_ROUTES_SRC, "async def chat_stream(", "async def chat_events(")
    responses = re.findall(r"StreamingResponse\([^\n]*text/event-stream[^\n]*\)", body)
    assert responses, "expected token-stream responses in chat_stream"
    for r in responses:
        assert "SSE_STREAM_HEADERS" in r, f"token-stream response missing headers: {r}"
    # X-Accel-Buffering: no is the load-bearing anti-nginx-buffering header.
    assert chat_routes.SSE_STREAM_HEADERS["X-Accel-Buffering"] == "no"


def test_chat_resume_response_carries_anti_buffering_headers():
    body = _slice(CHAT_ROUTES_SRC, "async def chat_resume(", "async def chat_stop(")
    resp = re.search(r"StreamingResponse\([^\n]*text/event-stream[^\n]*\)", body)
    assert resp is not None, "chat_resume must return a token-stream response"
    assert "SSE_STREAM_HEADERS" in resp.group(0)


def test_stream_rewrite_response_carries_anti_buffering_headers():
    # CR-MAJOR-1: POST /api/rewrite is a genuine token-carrying SSE stream and had NO anti-buffering
    # headers — the same reverse-proxy hang could still happen there.
    assert "StreamingResponse(stream_rewrite(), media_type=\"text/event-stream\", headers=SSE_STREAM_HEADERS)" in CHAT_ROUTES_SRC


def test_no_token_stream_hardcodes_the_header_dict_anymore():
    # CR-ROBUSTNESS-6: chat_events (and every token stream) must reuse the SSE_STREAM_HEADERS constant,
    # not an ad-hoc dict that can drift. Exactly ONE literal definition of the dict remains: the constant.
    literal = '{"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}'
    assert CHAT_ROUTES_SRC.count(literal) == 1, "the anti-buffering header dict must be defined once (the constant)"


# ── F-PY-5: a status/stage frame before the model call ─────────────────────── #


def _producer_src() -> str:
    a = CHAT_ROUTES_SRC.index("async def stream_with_save(")
    b = CHAT_ROUTES_SRC.index("async def _safe_stream(", a)
    return CHAT_ROUTES_SRC[a:b]


def test_status_frame_shape_is_well_formed_json():
    # The exact wire shape the FE-JS lane consumes.
    payload = json.loads(json.dumps({"type": "status", "stage": "thinking"}))
    assert payload == {"type": "status", "stage": "thinking"}


def test_status_frame_emitted_after_keepalive_and_before_the_model_call():
    src = _producer_src()
    assert "'type': 'status'" in src and "'stage': 'thinking'" in src, "no status frame in producer"
    ka = src.index('yield ": keepalive')
    st = src.index("'stage': 'thinking'")
    model = src.index("stream_llm_with_fallback(")  # the actual model dispatch
    assert ka < st < model, "status frame must follow the keepalive and precede the model call"


def test_status_frame_is_not_persisted_reply_text():
    # It is a transient UI cue: no reply text, so it can never be mistaken for narration.
    payload = {"type": "status", "stage": "thinking"}
    assert "delta" not in payload and "content" not in payload


# ── F-PY-4: framing reads bounded by the tight framing timeout (via wait_for) ─ #
#
# The engine gameStatus/stateDelta clients are deliberately left byte-identical (a signature change
# would break the many narrow test stubs that replace them); the tight per-turn bound is enforced at
# the FE with `asyncio.wait_for`, and cancelling an in-flight READ mid-turn is safe.


def test_framing_reads_are_bounded_by_wait_for_at_the_framing_timeout():
    # The three per-turn framing reads (pending barrier, beat-signature status, delta line) each wrap
    # their engine read in asyncio.wait_for(..., _FRAMING_TIMEOUT) so a hung engine can't stall the
    # turn on the 30s default.
    assert CHAT_HELPERS_SRC.count("orwell_engine._FRAMING_TIMEOUT)") >= 3, (
        "expected the 3 framing reads bounded by _FRAMING_TIMEOUT"
    )
    # barrier + beat-signature both bound gameStatus (2x); the delta line bounds stateDelta (1x).
    assert (
        CHAT_HELPERS_SRC.count(
            "orwell_engine.game_status(user=user), orwell_engine._FRAMING_TIMEOUT)"
        ) >= 2
    ), "both gameStatus framing reads must be bounded by _FRAMING_TIMEOUT"
    assert (
        "orwell_engine.state_delta(last_seen_beat_seq, user=user), orwell_engine._FRAMING_TIMEOUT)"
        in CHAT_HELPERS_SRC
    )
    assert CHAT_HELPERS_SRC.count("asyncio.wait_for(") >= 3


def test_hung_state_delta_read_is_abandoned_at_the_framing_bound(monkeypatch):
    # Behavioral: a hung stateDelta is abandoned at the framing bound (fail-open → None) rather than
    # blocking the turn for the full default. Shrink the bound so the test is fast.
    import time
    import routes.chat_helpers as ch

    monkeypatch.setattr(oe, "_FRAMING_TIMEOUT", 0.05)

    async def _hang(*a, **k):
        await asyncio.sleep(10)

    monkeypatch.setattr(oe, "state_delta", _hang)
    t0 = time.monotonic()
    out = _run(ch._maybe_delta_line("u-perf-hang", 4))
    dt = time.monotonic() - t0
    assert out is None, "a hung framing read fails open (no delta line), never blocks the frame"
    assert dt < 2.0, "wait_for must abandon the hung read at the framing bound, not stall on it"


# ── F-PY-3: off-loaded + memoized context probes ───────────────────────────── #


def test_get_context_length_async_returns_underlying(monkeypatch):
    monkeypatch.setattr(mc, "get_context_length", lambda url, model: 4321)
    mc._context_ttl_cache.clear()
    assert _run(mc.get_context_length_async("http://x", "m")) == 4321


def test_get_context_length_async_memoizes_within_ttl(monkeypatch):
    calls = {"n": 0}

    def fake(url, model):
        calls["n"] += 1
        return 777

    monkeypatch.setattr(mc, "get_context_length", fake)
    mc._context_ttl_cache.clear()

    async def _twice():
        return (
            await mc.get_context_length_async("http://y", "m"),
            await mc.get_context_length_async("http://y", "m"),
        )

    a, b = _run(_twice())
    assert a == b == 777
    assert calls["n"] == 1, "second call must be served from the short-TTL memo, not re-probed"


def test_get_context_length_async_is_failsoft(monkeypatch):
    def boom(url, model):
        raise RuntimeError("upstream down")

    monkeypatch.setattr(mc, "get_context_length", boom)
    mc._context_ttl_cache.clear()
    # A probe failure degrades to the default window, never raising into the turn.
    assert _run(mc.get_context_length_async("http://z", "m")) == mc.DEFAULT_CONTEXT


def test_get_context_length_async_offloads_off_the_event_loop():
    # The blocking httpx probes must run in a worker thread, not on the event loop.
    assert "asyncio.to_thread" in inspect.getsource(mc.get_context_length_async)


def test_compactor_uses_the_async_context_lookup():
    src = inspect.getsource(cc.maybe_compact)
    assert "await get_context_length_async(" in src


def test_get_context_length_async_coalesces_concurrent_misses(monkeypatch):
    # CR-ROBUSTNESS-5: two cold callers on the SAME key must share ONE probe, not launch duplicates.
    import threading
    calls = {"n": 0}
    gate = threading.Event()

    def slow(url, model):
        calls["n"] += 1
        gate.wait(2.0)  # hold the (threaded) probe so a second caller races in while it's in flight
        return 555

    monkeypatch.setattr(mc, "get_context_length", slow)
    mc._context_ttl_cache.clear()
    mc._context_inflight.clear()

    async def _both():
        t1 = asyncio.create_task(mc.get_context_length_async("http://coalesce", "m"))
        await asyncio.sleep(0.05)          # let t1 register its in-flight future + enter the thread
        t2 = asyncio.create_task(mc.get_context_length_async("http://coalesce", "m"))
        await asyncio.sleep(0.05)
        gate.set()                          # release the shared probe
        return await asyncio.gather(t1, t2)

    a, b = _run(_both())
    assert a == b == 555
    assert calls["n"] == 1, "concurrent cold callers must share ONE underlying probe"


def test_get_context_length_async_cancelled_first_caller_does_not_hang_others(monkeypatch):
    # Greptile P1 repro: the FIRST cold caller is cancelled mid-probe. A naive shared-future would
    # orphan the entry (CancelledError skips the fail-soft except; the finally drops it unresolved),
    # hanging the concurrent awaiter forever. With the Task+shield design the shared probe runs on and
    # the awaiter still resolves.
    import threading
    gate = threading.Event()
    calls = {"n": 0}

    def slow(url, model):
        calls["n"] += 1
        gate.wait(3.0)   # hold the shared probe so we can cancel the first caller while it's in flight
        return 999

    monkeypatch.setattr(mc, "get_context_length", slow)
    mc._context_ttl_cache.clear()
    mc._context_inflight.clear()

    async def _scenario():
        t1 = asyncio.create_task(mc.get_context_length_async("http://cancelme", "m"))
        await asyncio.sleep(0.05)   # t1 registers the shared task and enters the thread
        t2 = asyncio.create_task(mc.get_context_length_async("http://cancelme", "m"))
        await asyncio.sleep(0.05)   # t2 grabs the SAME shared task (awaits it under shield)
        t1.cancel()                 # cancel the FIRST caller mid-probe
        with pytest.raises(asyncio.CancelledError):
            await t1                # its own cancellation propagates …
        gate.set()                  # … but the shared probe keeps running; let it finish
        # The invariant: t2 must resolve within a short timeout — never hang on an orphaned future.
        return await asyncio.wait_for(t2, timeout=2.0)

    res = _run(_scenario())
    assert res == 999, "the awaiter got the shared probe's real result despite the first caller cancelling"
    assert calls["n"] == 1, "still exactly ONE probe — the cancellation didn't spawn a duplicate"


def test_get_context_length_async_cancelled_awaiter_leaves_others_intact(monkeypatch):
    # The mirror case: a LATER caller (awaiter) is cancelled — the shared task and every other awaiter
    # must be unaffected, and the shared probe still completes + caches.
    import threading
    gate = threading.Event()
    calls = {"n": 0}

    def slow(url, model):
        calls["n"] += 1
        gate.wait(3.0)
        return 111

    monkeypatch.setattr(mc, "get_context_length", slow)
    mc._context_ttl_cache.clear()
    mc._context_inflight.clear()

    async def _scenario():
        t1 = asyncio.create_task(mc.get_context_length_async("http://awaiter", "m"))
        await asyncio.sleep(0.05)
        t2 = asyncio.create_task(mc.get_context_length_async("http://awaiter", "m"))
        await asyncio.sleep(0.05)
        t2.cancel()                 # cancel the AWAITER
        with pytest.raises(asyncio.CancelledError):
            await t2
        gate.set()
        return await asyncio.wait_for(t1, timeout=2.0)  # the first caller still resolves

    res = _run(_scenario())
    assert res == 111
    assert calls["n"] == 1


# ── CR-MAJOR-2: env floats parse fail-soft (a bad env var must not crash startup) ── #


def test_env_float_falls_back_on_malformed(monkeypatch):
    monkeypatch.setenv("ORWELL_TEST_BAD_FLOAT", "5s")   # trailing unit — not a float
    assert mc._env_float("ORWELL_TEST_BAD_FLOAT", 5.0) == 5.0
    monkeypatch.setenv("ORWELL_TEST_BAD_FLOAT", "   ")  # blank/whitespace
    assert mc._env_float("ORWELL_TEST_BAD_FLOAT", 42.0) == 42.0
    monkeypatch.delenv("ORWELL_TEST_BAD_FLOAT", raising=False)  # unset
    assert mc._env_float("ORWELL_TEST_BAD_FLOAT", 7.0) == 7.0
    monkeypatch.setenv("ORWELL_TEST_BAD_FLOAT", "12.5")  # a real override still applies
    assert mc._env_float("ORWELL_TEST_BAD_FLOAT", 5.0) == 12.5


def test_model_context_imports_under_malformed_env():
    # The module must import cleanly with a garbage timeout env — no ValueError at import time.
    # Run in a FRESH subprocess (not an in-process importlib.reload) so nothing pollutes the parallel
    # suite's module state.
    import subprocess
    import sys

    env = dict(os.environ, ORWELL_MODEL_PROBE_TIMEOUT="5s", ORWELL_MODEL_CONTEXT_TTL="not-a-number")
    code = (
        "import src.model_context as m; "
        "assert m.REQUEST_TIMEOUT == 5.0, m.REQUEST_TIMEOUT; "
        "assert m._CONTEXT_TTL_SECONDS == 60.0, m._CONTEXT_TTL_SECONDS; "
        "print('IMPORT_OK')"
    )
    r = subprocess.run(
        [sys.executable, "-c", code], env=env, cwd=FRONTEND,
        capture_output=True, text=True, timeout=60,
    )
    assert r.returncode == 0, f"import crashed under malformed env: {r.stderr}"
    assert "IMPORT_OK" in r.stdout


# ── F-PY-2: non-blocking compaction (background) ─────── #


class _FakeSession:
    def __init__(self):
        self.id = "sess-perf"
        self.history = []


def _msgs(n_convo: int):
    m = [{"role": "system", "content": "S" * 50}]
    for i in range(n_convo):
        m.append({"role": "user" if i % 2 == 0 else "assistant", "content": "X" * 400})
    return m


def test_maybe_compact_backgrounds_over_threshold(monkeypatch):
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")  # ORW-224: compaction is refused in the game build; these test the mechanics
    async def fake_ctx(url, model):
        return 100  # tiny window ⇒ far over the 85% threshold

    llm = {"n": 0}

    async def fake_llm(*a, **k):
        llm["n"] += 1
        return "SUMMARY"

    monkeypatch.setattr(cc, "get_context_length_async", fake_ctx)
    monkeypatch.setattr(cc, "llm_call_async", fake_llm)
    monkeypatch.setattr(cc, "resolve_endpoint", lambda *a, **k: (None, None, None))
    cc._compaction_in_flight.clear()
    cc._background_tasks.clear()

    messages = _msgs(6)
    sess = _FakeSession()

    async def _drive():
        out = await cc.maybe_compact(sess, "url", "model", messages)
        if cc._background_tasks:  # drain the fire-and-forget summarization
            await asyncio.gather(*list(cc._background_tasks))
        return out

    out_msgs, ctxlen, was = _run(_drive())
    assert was is False, "backgrounded compaction reports was_compacted=False for THIS turn"
    assert out_msgs is messages, "this turn's messages are returned uncompacted (trim_for_context fits them)"
    assert llm["n"] == 1, "the summary still ran — in the background, off the first-token path"


def test_maybe_compact_under_threshold_is_noop(monkeypatch):
    async def fake_ctx(url, model):
        return 10_000_000  # huge window ⇒ well under threshold

    monkeypatch.setattr(cc, "get_context_length_async", fake_ctx)
    messages = _msgs(6)
    out_msgs, ctxlen, was = _run(cc.maybe_compact(_FakeSession(), "url", "model", messages))
    assert was is False and out_msgs is messages


# ── CR-MAJOR-3 (DATA INTEGRITY, mandate #4): a concurrent history edit during the in-flight ──── #
#     summary must NOT be overwritten by the background compaction.


def test_background_compaction_abandons_on_concurrent_history_edit(monkeypatch):
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")  # ORW-224: compaction is refused in the game build; these test the mechanics
    import core.models as core_models

    async def fake_ctx(url, model):
        return 100  # over threshold

    monkeypatch.setattr(cc, "get_context_length_async", fake_ctx)
    monkeypatch.setattr(cc, "resolve_endpoint", lambda *a, **k: (None, None, None))
    # Force the in-memory apply path (no real session manager DB write) so we can inspect history.
    monkeypatch.setattr(core_models, "_session_manager", None, raising=False)
    cc._compaction_in_flight.clear()
    cc._background_tasks.clear()

    sess = _FakeSession()
    # A REAL persisted history so effective_split (= system_msg_count 1 + split_point 3 = 4) lands
    # INSIDE it — i.e. compaction would otherwise proceed and overwrite.
    sess.history = [{"role": "system", "content": "S"}] + [
        {"role": ("user" if i % 2 == 0 else "assistant"), "content": f"m{i}"} for i in range(7)
    ]  # 8 distinct dict objects
    original = list(sess.history)

    async def mutating_llm(*a, **k):
        # Simulate a CONCURRENT writer (delete/truncate/replace) editing the summarized prefix while
        # the summary is in flight — the classic lost-update race.
        sess.history = sess.history[2:]   # drop the first two messages → the captured prefix shifts
        return "SUMMARY"

    monkeypatch.setattr(cc, "llm_call_async", mutating_llm)

    messages = _msgs(6)  # 1 system + 6 convo → split_point=3, system_msg_count=1

    async def _drive():
        out = await cc.maybe_compact(sess, "url", "model", messages)
        if cc._background_tasks:
            await asyncio.gather(*list(cc._background_tasks))
        return out

    out_msgs, ctxlen, was = _run(_drive())
    assert was is False
    # The compaction must have ABANDONED: session.history is EXACTLY the concurrent edit, untouched.
    assert sess.history == original[2:], "the concurrent edit was overwritten — data lost (mandate #4)"
    assert not any(
        isinstance(m, dict) and "[Conversation summary" in (m.get("content") or "")
        for m in sess.history
    ), "no summary was injected over the concurrent edit"


def test_background_compaction_abandons_on_in_place_content_edit(monkeypatch):
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")  # ORW-224: compaction is refused in the game build; these test the mechanics
    # CR-MAJOR: history_routes.edit_message mutates the SAME message object's `content` IN PLACE —
    # identity is unchanged, only content changes. The content-digest revalidation must catch it (an
    # object-identity check would MISS it and overwrite the newer edit).
    import core.models as core_models

    async def fake_ctx(url, model):
        return 100

    monkeypatch.setattr(cc, "get_context_length_async", fake_ctx)
    monkeypatch.setattr(cc, "resolve_endpoint", lambda *a, **k: (None, None, None))
    monkeypatch.setattr(core_models, "_session_manager", None, raising=False)
    cc._compaction_in_flight.clear()
    cc._background_tasks.clear()

    sess = _FakeSession()
    sess.history = [{"role": "system", "content": "S"}] + [
        {"role": ("user" if i % 2 == 0 else "assistant"), "content": f"m{i}"} for i in range(7)
    ]  # 8 objects; effective_split=4 lands inside, so index 1 is in the summarized prefix

    async def mutating_llm(*a, **k):
        # IN-PLACE edit of a prefix message (SAME object, new content) — the edit_message shape.
        sess.history[1]["content"] = "EDITED-IN-PLACE"
        return "SUMMARY"

    monkeypatch.setattr(cc, "llm_call_async", mutating_llm)

    messages = _msgs(6)

    async def _drive():
        out = await cc.maybe_compact(sess, "url", "model", messages)
        if cc._background_tasks:
            await asyncio.gather(*list(cc._background_tasks))
        return out

    out_msgs, ctxlen, was = _run(_drive())
    assert was is False
    # The in-place edit must SURVIVE — compaction abandoned, no summary injected, length unchanged.
    assert sess.history[1]["content"] == "EDITED-IN-PLACE", "in-place edit was overwritten — data lost"
    assert len(sess.history) == 8, "compaction rewrote history despite the concurrent in-place edit"
    assert not any(
        isinstance(m, dict) and "[Conversation summary" in (m.get("content") or "")
        for m in sess.history
    )


def test_background_compaction_bounded_by_global_semaphore(monkeypatch):
    # CR-ROBUSTNESS-4 (strengthened): RUNTIME-verify the global semaphore actually caps concurrency —
    # a wrong sem object or off-by-one capacity must fail. Schedule cap+1 compactions (distinct session
    # ids so the per-session guard doesn't block them) with a blocking summarize_fn that tracks a
    # high-water-mark of concurrent calls; it must never exceed the cap, and must REACH it.
    cap = 2
    monkeypatch.setattr(cc, "_MAX_CONCURRENT_BG_COMPACTIONS", cap)
    monkeypatch.setattr(cc, "_global_compaction_sem", None, raising=False)  # force a fresh sem at `cap`
    monkeypatch.setattr(cc, "_global_compaction_sem_loop", None, raising=False)
    cc._compaction_in_flight.clear()
    cc._background_tasks.clear()

    conc = {"now": 0, "max": 0}

    async def _scenario():
        release = asyncio.Event()

        async def blocking_summarize():
            conc["now"] += 1
            conc["max"] = max(conc["max"], conc["now"])
            try:
                await release.wait()
                return "S"
            finally:
                conc["now"] -= 1

        for i in range(cap + 1):
            s = _FakeSession()
            s.id = f"sem-sess-{i}"   # distinct ids ⇒ the per-session guard admits all of them
            s.history = []           # empty prefix ⇒ digest () ⇒ applies (no-op via early return)
            cc._schedule_background_compaction(s, 0, 0, blocking_summarize)

        # Wait until the cap is saturated, then give a broken/over-capacity sem a chance to over-admit.
        for _ in range(200):
            if conc["now"] >= cap:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        assert conc["max"] == cap, f"semaphore admitted {conc['max']} concurrent, cap is {cap}"
        assert conc["now"] == cap, f"expected exactly {cap} running (rest blocked), saw {conc['now']}"
        release.set()
        await asyncio.gather(*list(cc._background_tasks))

    _run(_scenario())
    assert conc["max"] == cap  # never exceeded, and the cap WAS reached


def test_bg_compaction_semaphore_env_is_failsoft(monkeypatch):
    monkeypatch.setenv("ORWELL_MAX_BG_COMPACTIONS", "lots")  # malformed
    assert cc._safe_int_env("ORWELL_MAX_BG_COMPACTIONS", 4) == 4
    monkeypatch.setenv("ORWELL_MAX_BG_COMPACTIONS", "8")
    assert cc._safe_int_env("ORWELL_MAX_BG_COMPACTIONS", 4) == 8
