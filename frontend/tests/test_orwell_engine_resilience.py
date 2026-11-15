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
    orwell_engine._clear_engine_down()
    # Tear down the process-global shared client both before and after: a lingering ``_SeqClient``
    # stub must never persist as ``orwell_engine._client`` for a later test to grab (and a stale real
    # client from a prior test must be rebuilt against THIS test's monkeypatched ``AsyncClient``).
    orwell_engine._client = None
    orwell_engine._client_factory = None
    yield
    orwell_engine._clear_error()
    orwell_engine._clear_reconnecting()
    orwell_engine._clear_engine_down()
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
    _Clock(monkeypatch)  # ORW-404: a refused connection now rides the ~20 s budget, on the virtual clock
    _patch_engine(monkeypatch, _RefusingEngine(lambda: True))
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine._call("gameStatus", {}, user="x"))


# --- ORW-404: the engine's "restarting" 503 (it is shutting down) is an outage, not a failed turn --------

_RESTARTING = {"error": "engine restarting: retry shortly", "code": "engine-restarting", "retryable": True}


class _Clock:
    """A virtual clock: the stubbed asyncio.sleep advances it, so a 20 s wait costs no wall time."""

    def __init__(self, monkeypatch):
        self.now = 0.0
        self.sleeps = []

        async def _sleep(s):
            self.sleeps.append(s)
            self.now += s

        monkeypatch.setattr(orwell_engine.asyncio, "sleep", _sleep)
        monkeypatch.setattr(orwell_engine, "_monotonic", lambda: self.now)


class _RestartingEngine:
    """Answers the restarting 503 (Retry-After: 3) until `until` virtual seconds, then succeeds."""

    def __init__(self, clock, until, retry_after="3"):
        self.clock, self.until, self.retry_after, self.calls = clock, until, retry_after, 0

    async def post(self, *_a, **_k):
        self.calls += 1
        if self.clock.now < self.until:
            r = _resp(503, payload=_RESTARTING)
            if self.retry_after is not None:
                r.headers["retry-after"] = self.retry_after
            return r
        return _resp(200, payload={"result": {"ok": True}})


def _patch_engine(monkeypatch, eng):
    monkeypatch.setattr(orwell_engine.httpx, "AsyncClient", lambda *a, **k: eng)


def test_engine_restarting_503_is_retried_then_succeeds(monkeypatch):
    # The engine refused a NEW call during its shutdown window (nothing was applied): retry like any
    # momentary outage, and leave no recorded error when the next try lands.
    client = _patch_seq(monkeypatch, [
        _resp(503, payload=_RESTARTING),
        _resp(200, payload={"result": {"ok": True}}),
    ])
    assert _run(orwell_engine._call("recordInteraction", {}, user="x")) == {"ok": True}
    assert client.calls == 2
    assert orwell_engine.last_engine_error() is None


def test_a_restart_that_lasts_five_seconds_is_ridden_out_without_an_error(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RestartingEngine(clock, until=5.0)
    _patch_engine(monkeypatch, eng)
    assert _run(orwell_engine._call("recordInteraction", {}, user="x")) == {"ok": True}
    assert eng.calls >= 3 and clock.now >= 5.0  # far past the old ~0.75 s of backoff
    assert max(clock.sleeps) <= 3.0              # Retry-After honoured, capped
    assert orwell_engine.last_engine_error() is None


def test_retry_after_is_honoured_and_capped(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RestartingEngine(clock, until=1.5, retry_after="1.5")
    _patch_engine(monkeypatch, eng)
    _run(orwell_engine._call("recordInteraction", {}, user="x"))
    assert clock.sleeps == [1.5]
    clock2 = _Clock(monkeypatch)
    eng2 = _RestartingEngine(clock2, until=1.0, retry_after="999")
    _patch_engine(monkeypatch, eng2)
    _run(orwell_engine._call("recordInteraction", {}, user="x"))
    assert clock2.sleeps == [3.0]


def test_a_sustained_engine_restarting_503_surfaces_as_unreachable_not_a_tool_error(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RestartingEngine(clock, until=10_000.0)
    _patch_engine(monkeypatch, eng)
    with pytest.raises(httpx.HTTPStatusError):
        _run(orwell_engine._call("recordInteraction", {}, user="x"))
    assert 20.0 <= clock.now <= 23.0   # about 20 s, then give up
    le = orwell_engine.last_engine_error()
    assert le and le["kind"] == "unreachable"  # the same outage banner as a refused connection, never "tool-error"


def test_a_short_timeout_read_is_not_held_for_twenty_seconds(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RestartingEngine(clock, until=10_000.0)
    _patch_engine(monkeypatch, eng)
    with pytest.raises(httpx.HTTPStatusError):
        _run(orwell_engine.get_game_state(user="x"))  # framing read: 3 s timeout budget
    assert clock.now <= orwell_engine._FRAMING_TIMEOUT + 0.001
    clock.now = 0.0
    with pytest.raises(httpx.HTTPStatusError):
        _run(orwell_engine.game_status(user="x"))     # status poll: 8 s budget
    assert clock.now <= orwell_engine._POLL_TIMEOUT + 0.001


class _RefusingEngine:
    """Models the engine across a deploy: `script(now)` says what the call does at the virtual time, one of
    "503" (restarting answer), "refuse" (ConnectError), or an exception instance to raise; anything else succeeds.
    Constructed with a callable of no args for the simple "always refuse" case."""

    def __init__(self, fn, clock=None):
        self.fn, self.clock, self.calls = fn, clock, 0

    async def post(self, *_a, **_k):
        self.calls += 1
        what = self.fn() if self.clock is None else self.fn(self.clock.now)
        if what is True or what == "refuse":
            raise httpx.ConnectError("refused")
        if what == "503":
            r = _resp(503, payload=_RESTARTING)
            r.headers["retry-after"] = "1"
            return r
        if isinstance(what, Exception):
            raise what
        return _resp(200, payload={"result": {"ok": True}})

    async def get(self, *_a, **_k):
        """The /health probe: refused while the engine is down, 200 once it is back."""
        self.calls += 1
        what = self.fn() if self.clock is None else self.fn(self.clock.now)
        if what is True or what == "refuse":
            raise httpx.ConnectError("refused")
        if isinstance(what, Exception):
            raise what
        return _resp(200, payload={"ok": True})


def test_503_then_refused_connections_then_success_is_ridden_out(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda t: "503" if t < 0.5 else ("refuse" if t < 6.5 else "ok"), clock)
    _patch_engine(monkeypatch, eng)
    assert _run(orwell_engine._call("recordInteraction", {}, user="x")) == {"ok": True}  # a MUTATING-style call
    assert orwell_engine.last_engine_error() is None
    assert 6.5 <= clock.now < 8.0


def test_refused_connections_for_six_seconds_then_success(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda t: "refuse" if t < 6.0 else "ok", clock)
    _patch_engine(monkeypatch, eng)
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert clock.sleeps == [1.0] * 6 and eng.calls == 7  # 1 s between tries, no Retry-After
    assert orwell_engine.last_engine_error() is None


def test_reconnecting_is_marked_before_each_refused_wait(monkeypatch):
    clock = _Clock(monkeypatch)
    seen = []
    real_sleep = orwell_engine.asyncio.sleep

    async def _spy(s):
        seen.append(orwell_engine.reconnecting())
        await real_sleep(s)

    monkeypatch.setattr(orwell_engine.asyncio, "sleep", _spy)
    _patch_engine(monkeypatch, _RefusingEngine(lambda t: "refuse" if t < 3.0 else "ok", clock))
    _run(orwell_engine._call("advanceGame", {}, user="x"))
    assert seen and all(seen)


def test_refused_longer_than_the_budget_ends_unreachable_not_a_tool_error(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda: True)
    _patch_engine(monkeypatch, eng)
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine._call("advanceGame", {}, user="x"))
    assert 20.0 <= clock.now <= 21.0
    assert eng.calls == 21
    le = orwell_engine.last_engine_error()
    assert le and le["kind"] == "unreachable"


def test_connect_timeout_gets_the_long_wait_too(monkeypatch):
    clock = _Clock(monkeypatch)
    req = httpx.Request("POST", "http://x/")
    eng = _RefusingEngine(lambda t: httpx.ConnectTimeout("t", request=req) if t < 4.0 else "ok", clock)
    _patch_engine(monkeypatch, eng)
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert clock.now >= 4.0


def test_the_budget_is_shared_between_503_and_refused_waits(monkeypatch):
    clock = _Clock(monkeypatch)
    # 503 for the first 10 s, then refused forever: total wait stays ~20 s, not 20 + 20.
    eng = _RefusingEngine(lambda t: "503" if t < 10.0 else "refuse", clock)
    _patch_engine(monkeypatch, eng)
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine._call("advanceGame", {}, user="x"))
    assert 20.0 <= clock.now <= 21.0


def test_a_short_timeout_read_gives_up_at_its_own_timeout_when_refused(monkeypatch):
    clock = _Clock(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda: True))
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine.get_game_state(user="x"))  # 3 s framing read
    assert clock.now <= orwell_engine._FRAMING_TIMEOUT + 0.001
    clock.now = 0.0
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine.game_status(user="x"))     # 8 s status poll
    assert clock.now <= orwell_engine._POLL_TIMEOUT + 0.001


@pytest.mark.parametrize("make", [
    lambda req: httpx.ReadError("reset", request=req),
    lambda req: httpx.RemoteProtocolError("closed", request=req),
    lambda req: httpx.WriteError("w", request=req),
])
def test_after_send_errors_keep_the_short_retry_exactly(monkeypatch, make):
    # These can happen AFTER the engine got the call: no long wait, today's 3 tries / 0.25 s, 0.5 s.
    clock = _Clock(monkeypatch)
    req = httpx.Request("POST", "http://x/")
    client = _patch_seq(monkeypatch, [make(req) for _ in range(6)])
    with pytest.raises(httpx.TransportError):
        _run(orwell_engine._call("advanceGame", {}, user="x"))
    assert client.calls == 3
    assert clock.sleeps == [0.25, 0.5]
    le = orwell_engine.last_engine_error()
    assert le and le["kind"] == "unreachable"


def test_after_send_read_timeout_on_a_mutating_tool_keeps_the_short_retry(monkeypatch):
    clock = _Clock(monkeypatch)
    req = httpx.Request("POST", "http://x/")
    client = _patch_seq(monkeypatch, [httpx.ReadTimeout("slow", request=req) for _ in range(6)])
    with pytest.raises(httpx.ReadTimeout):
        _run(orwell_engine._call("advanceGame", {}, user="x"))
    assert client.calls == 3 and clock.sleeps == [0.25, 0.5]


def test_other_structured_503s_are_still_the_engine_answering(monkeypatch):
    # e.g. the response-budget 503 or the disabled-admin 503: a structured body that is NOT the restart code.
    client = _patch_seq(monkeypatch, [_resp(503, payload={"error": "engine busy", "code": "engine-busy"})])
    with pytest.raises(orwell_engine.EngineToolError):
        _run(orwell_engine._call("recordInteraction", {}, user="x"))
    assert client.calls == 1


def test_other_503s_keep_the_short_retry_exactly(monkeypatch):
    # A bare gateway 503 (no engine body) and a different structured 503 are NOT the restart code: the
    # original 3 tries / 0.25 s, 0.5 s backoff, never the long wait.
    clock = _Clock(monkeypatch)
    client = _patch_seq(monkeypatch, [_resp(503, text="bad gateway") for _ in range(5)])
    with pytest.raises(httpx.HTTPStatusError):
        _run(orwell_engine._call("recordInteraction", {}, user="x"))
    assert client.calls == 3
    assert clock.sleeps == [0.25, 0.5]


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


# --- ORW-404: a real outage (unreachable for longer than a restart) fails fast and shows "down" -----------

def _outage_call(clock):
    """One refused call on the virtual clock; returns (elapsed seconds, sleeps taken)."""
    t0, n0 = clock.now, len(clock.sleeps)
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine._call("advanceGame", {}, user="x"))
    return clock.now - t0, clock.sleeps[n0:]


def _spy_reconnecting(monkeypatch):
    """Record reconnecting() at every wait the client takes."""
    seen = []
    real_sleep = orwell_engine.asyncio.sleep

    async def _spy(s):
        seen.append(orwell_engine.reconnecting())
        await real_sleep(s)

    monkeypatch.setattr(orwell_engine.asyncio, "sleep", _spy)
    return seen


def test_outage_first_call_waits_the_budget_second_call_fails_fast(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda: True)
    _patch_engine(monkeypatch, eng)
    elapsed, _ = _outage_call(clock)
    assert 20.0 <= elapsed <= 21.0
    assert orwell_engine._engine_down()
    calls_before = eng.calls
    elapsed, sleeps = _outage_call(clock)
    assert sleeps == [0.25, 0.5] and eng.calls - calls_before == 3
    le = orwell_engine.last_engine_error()
    assert le and le["kind"] == "unreachable"


def test_an_established_outage_stays_fast_however_long_it_lasts(monkeypatch):
    # No timer re-opens the long wait: only an answer from the engine does.
    clock = _Clock(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda: True))
    _outage_call(clock)
    for later in (15.0, 60.0, 240.0):
        clock.now += later
        assert _outage_call(clock)[1] == [0.25, 0.5]


def test_a_refusal_from_long_ago_is_stale_evidence_and_the_clock_restarts(monkeypatch):
    # The player left during an outage and nothing called the engine for hours. Nobody knows it stayed down, so the
    # first call of the new session, landing inside a 6 s restart, must still ride it out.
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda: True)
    _patch_engine(monkeypatch, eng)
    _outage_call(clock)
    assert orwell_engine._engine_down()
    clock.now += 3 * 3600.0
    back_at = clock.now + 6.0
    eng.clock, eng.fn = clock, (lambda t: "refuse" if t < back_at else "ok")
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert clock.now >= back_at


def test_a_restarting_503_seen_by_one_call_re_opens_the_long_wait_for_the_next(monkeypatch):
    # The 503 is an ANSWER: it ends the outage even when the call that saw it does not succeed.
    clock = _Clock(monkeypatch)
    monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_SINCE", 0.0)
    monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_LAST", 24.0)   # an established outage with fresh evidence
    clock.now = 25.0
    assert orwell_engine._engine_down()
    _patch_engine(monkeypatch, _RefusingEngine(lambda t: "503" if t < 28.0 else ("refuse" if t < 33.0 else "ok"), clock))
    with pytest.raises((httpx.HTTPStatusError, httpx.ConnectError)):
        _run(orwell_engine.get_game_state(user="x"))            # a 3 s read: sees the 503, gives up at its own timeout
    assert clock.now < 33.0
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}   # the next call, refused at first, rides it out
    assert clock.now >= 33.0


def test_a_short_read_giving_up_mid_restart_does_not_make_the_next_call_fail_fast(monkeypatch):
    # The defect this rule exists to avoid: a 3 s framing read fails during an ordinary 6 s restart. That is not an
    # outage. The turn's next call must still ride the restart out, and the banner must keep saying reconnecting.
    clock = _Clock(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda t: "refuse" if t < 6.0 else "ok", clock))
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine.get_game_state(user="x"))            # the 3 s framing read gives up at its own timeout
    assert clock.now <= orwell_engine._FRAMING_TIMEOUT + 0.001
    assert not orwell_engine._engine_down()                     # 3 s unreachable is a restart, not an outage
    assert orwell_engine.reconnecting() is True                 # a short call giving up does not turn the banner red
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert clock.now >= 6.0 and orwell_engine.last_engine_error() is None


def test_a_status_poll_giving_up_mid_restart_does_not_establish_an_outage(monkeypatch):
    clock = _Clock(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda t: "refuse" if t < 12.0 else "ok", clock))
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine.game_status(user="x"))               # the 8 s status poll gives up at its own timeout
    assert not orwell_engine._engine_down()
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert clock.now >= 12.0


def test_a_success_ends_the_outage_and_the_full_wait_is_available_again(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda t: "refuse" if (t < 21.0 or 22.0 <= t < 28.5) else "ok", clock)
    _patch_engine(monkeypatch, eng)
    _outage_call(clock)                       # unreachable for the whole budget: an outage
    assert orwell_engine._engine_down()
    clock.now = 21.5                          # the engine answers a call
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert not orwell_engine._engine_down() and orwell_engine._ENGINE_UNREACHABLE_SINCE is None
    clock.now = 22.0                          # it bounces for ~6 s: ridden out
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert clock.now >= 28.5


def test_an_engine_restarting_503_ends_the_outage(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda: True)
    _patch_engine(monkeypatch, eng)
    _outage_call(clock)
    assert orwell_engine._engine_down()
    clock.now = 21.0                          # the engine is back and restarting: 503, then down ~6 s, then up
    eng.clock, eng.fn = clock, (lambda t: "503" if t < 21.5 else ("refuse" if t < 27.5 else "ok"))
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert clock.now >= 27.5 and not orwell_engine._engine_down()


def test_any_engine_answer_ends_the_unreachable_state(monkeypatch):
    # A structured tool error is the engine ANSWERING: it is listening.
    clock = _Clock(monkeypatch)
    monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_SINCE", 0.0)
    clock.now = 25.0
    assert orwell_engine._engine_down()
    _patch_seq(monkeypatch, [_resp(400, payload={"error": "bad args"})])
    with pytest.raises(orwell_engine.EngineToolError):
        _run(orwell_engine._call("recordInteraction", {}, user="x"))
    assert orwell_engine._ENGINE_UNREACHABLE_SINCE is None and not orwell_engine._engine_down()


def test_an_after_send_error_does_not_start_the_unreachable_clock(monkeypatch):
    # Only a connection that was never established counts toward an outage.
    _patch_seq(monkeypatch, [httpx.ReadError("reset"), httpx.ReadError("reset"), httpx.ReadError("reset")])
    with pytest.raises(httpx.ReadError):
        _run(orwell_engine._call("advanceGame", {}, user="x"))
    assert orwell_engine._ENGINE_UNREACHABLE_SINCE is None


def test_a_call_already_waiting_finishes_its_own_budget_when_the_outage_becomes_established(monkeypatch):
    clock = _Clock(monkeypatch)
    monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_SINCE", 0.0)   # another caller saw the first refusal at t=0
    clock.now = 15.0                                                       # this call starts before the 20 s mark ...
    _patch_engine(monkeypatch, _RefusingEngine(lambda t: "refuse" if t < 30.0 else "ok", clock))
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}   # ... and keeps its own 20 s
    assert clock.now >= 30.0


def test_reconnecting_is_false_after_a_full_budget_call_gives_up(monkeypatch):
    clock = _Clock(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda: True))
    _outage_call(clock)
    assert orwell_engine.reconnecting() is False


def test_a_refused_call_in_an_established_outage_does_not_mark_reconnecting(monkeypatch):
    clock = _Clock(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda: True))
    _outage_call(clock)
    seen = _spy_reconnecting(monkeypatch)
    _outage_call(clock)
    assert seen == [False, False] and orwell_engine.reconnecting() is False


def test_the_health_probe_in_an_established_outage_reports_down_not_reconnecting(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda: True)
    _patch_engine(monkeypatch, eng)
    _outage_call(clock)
    calls_before = eng.calls
    d = _run(orwell_engine.engine_health_detail())
    assert eng.calls - calls_before == 3                      # the probe really ran (refused three times)
    assert d["ok"] is False and "ConnectError" in d["error"] and not d.get("reconnecting")


def test_the_health_probe_alone_establishes_an_outage(monkeypatch):
    # An idle player: nothing but the banner's probe is calling. It must still end up showing down, not reconnecting.
    clock = _Clock(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda: True))
    d = _run(orwell_engine.engine_health_detail())            # t=0: the first refusal; could be a restart
    assert d["ok"] is False and d.get("reconnecting") is True
    clock.now = 10.0
    orwell_engine._clear_reconnecting()                        # (stands in for the marker's own 8 s expiry, which is on the real clock)
    assert _run(orwell_engine.engine_health_detail()).get("reconnecting") is True   # still within a restart's length
    clock.now = 21.0
    orwell_engine._clear_reconnecting()
    d = _run(orwell_engine.engine_health_detail())            # unreachable for over 20 s: an outage
    assert d["ok"] is False and not d.get("reconnecting")


def test_a_successful_health_probe_ends_an_established_outage(monkeypatch):
    clock = _Clock(monkeypatch)
    eng = _RefusingEngine(lambda t: "refuse" if t < 30.0 else "ok", clock)
    _patch_engine(monkeypatch, eng)
    _outage_call(clock)
    assert orwell_engine._engine_down()
    clock.now = 31.0
    assert _run(orwell_engine.engine_health_detail())["ok"] is True
    assert not orwell_engine._engine_down()
    eng.fn = lambda t: "refuse" if t < 37.0 else "ok"         # it bounces again at once: the full wait is back
    assert _run(orwell_engine._call("advanceGame", {}, user="x")) == {"ok": True}
    assert clock.now >= 37.0


def test_reconnecting_is_true_while_a_restart_wait_runs_and_false_after_success(monkeypatch):
    clock = _Clock(monkeypatch)
    seen = _spy_reconnecting(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda t: "refuse" if t < 6.0 else "ok", clock))
    _run(orwell_engine._call("advanceGame", {}, user="x"))
    assert seen and all(seen) and orwell_engine.reconnecting() is False


def test_a_structured_httpx_timeout_does_not_raise_type_error(monkeypatch):
    clock = _Clock(monkeypatch)
    _patch_engine(monkeypatch, _RefusingEngine(lambda t: "refuse" if t < 2.0 else "ok", clock))
    assert _run(orwell_engine._call("advanceGame", {}, user="x", timeout=httpx.Timeout(30.0))) == {"ok": True}
    assert orwell_engine._restart_budget_s(httpx.Timeout(30.0)) == orwell_engine._RESTART_WAIT_BUDGET_S
    assert orwell_engine._restart_budget_s(None) == orwell_engine._RESTART_WAIT_BUDGET_S
    assert orwell_engine._restart_budget_s(3) == 3


# --- ORW-439: the quiet diagnostic read (beatLog) -----------------------------------------------

@pytest.mark.parametrize("script", [
    [_resp(400, payload={"error": 'tool "beatLog" is not available on channel "player"'})] * 4,
    [httpx.ConnectError("refused")] * 4,
    [httpx.ReadTimeout("slow", request=httpx.Request("POST", "http://x/player/call"))] * 4,
    [_resp(503, payload={"error": "restarting", "code": "engine-restarting"})] * 4,  # the real restarting payload (review of #2757): a bare {"error": ...} is an ordinary EngineToolError
    [_resp(502, text="bad gateway")] * 4,
], ids=["tool-error", "refused", "timeout", "restarting-503", "gateway-502"])
def test_a_failing_beat_log_is_one_attempt_and_leaves_no_banner_error_or_reconnecting_state(monkeypatch, script):
    client = _patch_seq(monkeypatch, script)
    with pytest.raises(Exception):
        _run(orwell_engine.beat_log(10, user="x", timeout=2.0))
    assert client.calls == 1
    assert orwell_engine.last_engine_error() is None
    assert orwell_engine.reconnecting() is False
    assert orwell_engine._ENGINE_UNREACHABLE_SINCE is None  # ORW-404: a diagnostic read never starts (or ends) the outage clock


def test_a_successful_beat_log_does_not_clear_an_error_another_tool_recorded(monkeypatch):
    orwell_engine._record_error("moveTo", "unreachable", "ConnectError: boom")
    client = _patch_seq(monkeypatch, [_resp(200, payload={"result": {"beatSeq": 1, "bumps": [], "truncated": False}})])
    _run(orwell_engine.beat_log(0, user="x", timeout=2.0))
    assert client.calls == 1
    err = orwell_engine.last_engine_error()
    assert err is not None and err["tool"] == "moveTo"


def test_the_default_path_still_retries_and_records(monkeypatch):
    # an error after the request was sent keeps the short retry (a refused connection now gets the ORW-404 restart wait instead)
    client = _patch_seq(monkeypatch, [httpx.ReadError("reset")] * 4)
    with pytest.raises(httpx.ReadError):
        _run(orwell_engine._call("gameStatus", {}, user="x"))
    assert client.calls == 1 + orwell_engine._RETRY_ATTEMPTS
    assert orwell_engine.last_engine_error() is not None


def test_a_generic_gateway_5xx_does_not_end_an_established_outage(monkeypatch):
    """review of #2744: a bare 502/503/504 proves only that a proxy answered. During an established outage it must not clear the outage clock (a later refused connection would then restart the 20 s wait)."""
    clock = _Clock(monkeypatch)
    monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_SINCE", 0.0)
    monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_LAST", 24.0)
    clock.now = 25.0
    assert orwell_engine._engine_down()
    for status in (502, 503, 504):
        _patch_seq(monkeypatch, [_resp(status, text="bad gateway")] * 8)
        with pytest.raises(httpx.HTTPStatusError):
            _run(orwell_engine._call("advanceGame", {}, user="x"))
        assert orwell_engine._engine_down(), status
    # the recognized restarting 503 and a non-gateway status ARE answers from a listening engine
    for resp in (_resp(503, payload={"error": "restarting", "code": "engine-restarting"}), _resp(500, text="boom")):
        monkeypatch.setattr(orwell_engine, "_ENGINE_UNREACHABLE_SINCE", 0.0)
        _patch_seq(monkeypatch, [resp] * 8)
        with pytest.raises(Exception):
            _run(orwell_engine._call("advanceGame", {}, user="x"))
        assert orwell_engine._ENGINE_UNREACHABLE_SINCE is None
