"""Issue 1 — FE↔engine client resilience: a TRANSIENT outage (gateway 502/503/504, a refused
connection, a read timeout, an empty 200 body) is RETRIED a couple of times with short backoff and
RECOVERS rather than surfacing a hard error on the first miss. While retrying, the client reports a
brief "reconnecting" state the health banner renders soft. A structured engine answer (bad args, or
the benign "no active game") is NEVER retried — it is the engine talking, not an outage.

Name-agnostic; httpx is faked with REAL httpx.Response objects so status/JSON/raise_for_status behave.
asyncio.sleep is stubbed so the backoff adds no wall-clock time to the suite.
"""
import importlib

import httpx
import pytest

orwell_engine = importlib.import_module("src.orwell_engine")

# This module tests the retry / backoff itself: opt out of the conftest default (retry off).
pytestmark = pytest.mark.engine_retry


def _resp(status: int, *, payload=None, text=None) -> httpx.Response:
    req = httpx.Request("POST", orwell_engine.ENGINE_URL.rstrip("/") + "/player/call")
    if payload is not None:
        return httpx.Response(status, json=payload, request=req)
    return httpx.Response(status, text=text or "", request=req)


class _SeqClient:
    """Stands in for httpx.AsyncClient: each post/get yields the NEXT item from a script — either a
    prepared httpx.Response or an Exception instance to raise. Models "fail twice, then succeed"."""

    def __init__(self, script):
        self._script = list(script)
        self.calls = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def _next(self):
        self.calls += 1
        item = self._script.pop(0) if self._script else None
        if isinstance(item, Exception):
            raise item
        return item

    async def post(self, *_a, **_k):
        return await self._next()

    async def get(self, *_a, **_k):
        return await self._next()


def _patch_seq(monkeypatch, script):
    client = _SeqClient(script)
    monkeypatch.setattr(orwell_engine.httpx, "AsyncClient", lambda *a, **k: client)
    return client


def _run(coro):
    # Run on a DEDICATED, freshly-minted event loop — never the process-shared
    # ``get_event_loop()`` one. Under ``pytest-xdist -n``, sibling tests in the same worker can
    # leave a pending fire-and-forget coroutine on the shared default loop (the front-end schedules
    # many best-effort background engine calls). Resumed inside this test's ``run_until_complete``,
    # such a foreign coroutine reaches the process-global ``orwell_engine._shared_client`` — which is
    # THIS test's ``_SeqClient`` stub — and steals a scripted response, so ``client.calls`` came out
    # nondeterministically 3 instead of 2 (the ``assert 3 == 2`` CI flake). A private loop is never
    # iterated by any foreign task, so the stubbed call sequence stays hermetic.
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        # Drain before close: cancel + await any tasks the coro left pending so a fire-and-forget
        # child isn't destroyed mid-flight (no "Task was destroyed but it is pending" warnings /
        # skipped cleanup). run_until_complete only awaits the root coroutine. (CodeRabbit #1621.)
        try:
            _pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
            for _t in _pending:
                _t.cancel()
            if _pending:
                loop.run_until_complete(asyncio.gather(*_pending, return_exceptions=True))
        finally:
            loop.close()


@pytest.fixture(autouse=True)
def _fast_and_clean(monkeypatch):
    # No real backoff sleeps in the suite, and a clean error/reconnecting slate per test.
    async def _no_sleep(_s):
        return None
    monkeypatch.setattr(orwell_engine.asyncio, "sleep", _no_sleep)
    orwell_engine._clear_error()
    orwell_engine._clear_reconnecting()
    # Tear down the process-global shared client both before and after: a lingering ``_SeqClient``
    # stub must never persist as ``orwell_engine._client`` for a later test to grab (and a stale real
    # client from a prior test must be rebuilt against THIS test's monkeypatched ``AsyncClient``).
    orwell_engine._client = None
    orwell_engine._client_factory = None
    yield
    orwell_engine._clear_error()
    orwell_engine._clear_reconnecting()
    orwell_engine._client = None
    orwell_engine._client_factory = None


# --- a transient gateway 502 is retried and recovers ------------------------------------------

def test_transient_502_is_retried_then_succeeds(monkeypatch):
    client = _patch_seq(monkeypatch, [
        _resp(502, text="<html>bad gateway</html>"),          # blip 1
        _resp(200, payload={"result": {"started": True}}),     # recovered
    ])
    assert _run(orwell_engine.get_game_state(user="x")) == {"started": True}
    assert client.calls == 2  # it retried once, then got the good answer
    assert orwell_engine.last_engine_error() is None  # a recovered blip leaves no recorded error


def test_transient_connection_error_is_retried_then_succeeds(monkeypatch):
    client = _patch_seq(monkeypatch, [
        httpx.ConnectError("connection refused"),              # blip 1 (engine bouncing)
        httpx.ConnectError("connection refused"),              # blip 2
        _resp(200, payload={"result": {"ok": True}}),          # third try lands
    ])
    assert _run(orwell_engine._call("gameStatus", {}, user="x")) == {"ok": True}
    assert client.calls == 3
    assert orwell_engine.last_engine_error() is None


def test_an_empty_200_body_is_retried(monkeypatch):
    # A 200 with no `result` / no structured error (engine answered oddly mid-restart) → retry.
    client = _patch_seq(monkeypatch, [
        _resp(200, payload={}),                                # empty/odd body
        _resp(200, payload={"result": {"started": True}}),     # recovered
    ])
    assert _run(orwell_engine.get_game_state(user="x")) == {"started": True}
    assert client.calls == 2


# --- a sustained outage still surfaces after the retries are spent -----------------------------

def test_a_sustained_502_eventually_raises(monkeypatch):
    _patch_seq(monkeypatch, [_resp(502, text="down") for _ in range(5)])
    with pytest.raises(httpx.HTTPStatusError):
        _run(orwell_engine.get_game_state(user="x"))
    le = orwell_engine.last_engine_error()
    assert le and le["kind"] == "unreachable"  # the FINAL outcome is recorded for the banner


def test_a_sustained_connection_error_eventually_raises(monkeypatch):
    _patch_seq(monkeypatch, [httpx.ConnectError("refused") for _ in range(5)])
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine._call("gameStatus", {}, user="x"))


# --- a structured engine answer is NEVER retried ----------------------------------------------

def test_no_active_game_is_not_retried(monkeypatch):
    # The benign "no active game" pre-game refusal is the engine ANSWERING — one call, no retry,
    # mapped to started:false, and NEVER recorded as an error.
    client = _patch_seq(monkeypatch, [_resp(404, payload={"error": "no active game for this user"})])
    assert _run(orwell_engine.get_game_state(user="fresh")) == {"started": False}
    assert client.calls == 1
    assert orwell_engine.last_engine_error() is None


def test_a_structured_tool_error_is_not_retried(monkeypatch):
    client = _patch_seq(monkeypatch, [_resp(400, payload={"error": "bad args"})])
    with pytest.raises(orwell_engine.EngineToolError):
        _run(orwell_engine._call("recordInteraction", {}, user="x"))
    assert client.calls == 1  # the engine answered with a reason — not an outage, not retried


# --- latency guard: a tight framing TIMEOUT fails fast (not retried) ---------------------------

def test_tight_framing_timeout_is_not_retried(monkeypatch):
    # get_game_state uses the short _FRAMING_TIMEOUT — a read timeout there must fail FAST so the
    # chat turn's fallback prompt takes over, not wait out 3 retries.
    req = httpx.Request("POST", orwell_engine.ENGINE_URL.rstrip("/") + "/player/call")
    client = _patch_seq(monkeypatch, [httpx.ReadTimeout("slow", request=req) for _ in range(5)])
    with pytest.raises(httpx.ReadTimeout):
        _run(orwell_engine.get_game_state(user="x"))  # passes _FRAMING_TIMEOUT by default
    assert client.calls == 1  # one attempt only — no retry storm on the chat-blocking path


def test_tight_framing_refused_connection_still_retries(monkeypatch):
    # A FAST-failing blip (connection refused) is cheap, so even the framing path retries it.
    client = _patch_seq(monkeypatch, [
        httpx.ConnectError("refused"),
        _resp(200, payload={"result": {"started": True}}),
    ])
    assert _run(orwell_engine.get_game_state(user="x")) == {"started": True}
    assert client.calls == 2


def test_wider_poller_timeout_is_retried(monkeypatch):
    # A roster-style wide timeout (8s) DOES retry a read timeout — pollers run off the chat path.
    req = httpx.Request("POST", orwell_engine.ENGINE_URL.rstrip("/") + "/player/call")
    client = _patch_seq(monkeypatch, [
        httpx.ReadTimeout("slow", request=req),
        _resp(200, payload={"result": {"started": True}}),
    ])
    assert _run(orwell_engine.get_game_state(user="x", timeout=8.0)) == {"started": True}
    assert client.calls == 2


# --- the brief "reconnecting" state for the banner --------------------------------------------

def test_reconnecting_is_flagged_during_retry_and_cleared_on_success(monkeypatch):
    _patch_seq(monkeypatch, [
        _resp(503, text="bouncing"),                           # blip → marks reconnecting
        _resp(200, payload={"result": {"ok": True}}),          # recovers → clears it
    ])
    assert orwell_engine.reconnecting() is False
    _run(orwell_engine._call("gameStatus", {}, user="x"))
    assert orwell_engine.reconnecting() is False  # a success clears the soft state


def test_health_detail_reports_reconnecting_while_retrying(monkeypatch):
    # /health probe blips once (502) then the suite runs out of script → it surfaces down, but the
    # transient blip set the soft reconnecting flag the banner reads.
    _patch_seq(monkeypatch, [_resp(502, text="down"), httpx.ConnectError("still down")])
    d = _run(orwell_engine.engine_health_detail())
    assert d["ok"] is False
    assert d.get("reconnecting") is True  # the soft state rides on the health detail


def test_health_detail_recovers_and_clears_reconnecting(monkeypatch):
    _patch_seq(monkeypatch, [_resp(502, text="blip"), _resp(200, payload={"ok": True})])
    d = _run(orwell_engine.engine_health_detail())
    assert d["ok"] is True
    assert not d.get("reconnecting")  # a healthy probe clears the soft state
    assert orwell_engine.reconnecting() is False
