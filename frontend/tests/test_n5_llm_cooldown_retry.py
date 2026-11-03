"""N-5 (2026-11-03 playtest): the dead-host cooldown must not turn a few real connect failures into a
wall of instant 503s, a cooled host must be probed, and the narration stream retries a connect-class
failure (pre-byte only, bounded) before the blank-turn fallback. Also: HTTP clients are per event loop."""
import asyncio
import json
import threading
import time

import httpx
import pytest

from src import llm_core as lc

URL = "https://upstream.example/v1/chat/completions"


@pytest.fixture(autouse=True)
def _reset():
    for d in (lc._dead_hosts, lc._host_fails, getattr(lc, "_host_last_fail", {}), getattr(lc, "_host_probe_at", {})):
        d.clear()
    yield
    for d in (lc._dead_hosts, lc._host_fails, getattr(lc, "_host_last_fail", {}), getattr(lc, "_host_probe_at", {})):
        d.clear()


def test_single_and_few_failures_do_not_cool_host():
    for _ in range(3):
        assert lc._mark_host_dead(URL) is False
    assert lc._is_host_dead(URL) is False


def test_threshold_is_a_named_constant_above_two():
    assert lc.HOST_FAIL_THRESHOLD >= 4
    assert lc.DEAD_HOST_COOLDOWN <= 10


def test_stale_failures_do_not_count_as_consecutive(monkeypatch):
    t = [1000.0]
    monkeypatch.setattr(lc.time, "time", lambda: t[0])
    for _ in range(lc.HOST_FAIL_THRESHOLD - 1):
        lc._mark_host_dead(URL)
    t[0] += lc.HOST_FAIL_WINDOW + 1
    assert lc._mark_host_dead(URL) is False


def test_cooled_host_is_probed_after_interval(monkeypatch):
    t = [1000.0]
    monkeypatch.setattr(lc.time, "time", lambda: t[0])
    for _ in range(lc.HOST_FAIL_THRESHOLD):
        lc._mark_host_dead(URL)
    assert lc._is_host_dead(URL) is True          # cooled: fail fast
    t[0] += lc.HOST_PROBE_INTERVAL + 0.1
    assert lc._is_host_dead(URL) is False          # ONE trial call passes
    assert lc._is_host_dead(URL) is True           # others still fast-fail until the next interval
    lc._clear_host_dead(URL)                       # trial succeeded
    assert lc._is_host_dead(URL) is False


def test_cooldown_for_one_host_does_not_fail_another():
    for _ in range(lc.HOST_FAIL_THRESHOLD):
        lc._mark_host_dead(URL)
    assert lc._is_host_dead("https://other.example/v1") is False


def _stream(monkeypatch, scripts):
    """scripts: list of per-attempt chunk lists returned by successive stream_llm calls."""
    calls = {"n": 0}

    async def fake_stream(url, model, messages, **kw):
        i = calls["n"]
        calls["n"] += 1
        for c in scripts[min(i, len(scripts) - 1)]:
            yield c

    async def nosleep(_):
        return None

    monkeypatch.setattr(lc, "stream_llm", fake_stream)
    monkeypatch.setattr(lc.asyncio, "sleep", nosleep)
    out = []

    async def drive():
        async for c in lc._stream_llm_with_fallback_impl([(URL, "m", {})], [{"role": "user", "content": "hi"}]):
            out.append(c)

    asyncio.run(drive())
    return out, calls["n"]


CONNECT_ERR = ('event: error\ndata: ' + json.dumps({"error": "Cannot reach x", "status": 503, "error_type": "connect"}) + '\n\n')
OK = ['data: ' + json.dumps({"delta": "hello"}) + '\n\n', "data: [DONE]\n\n"]


def test_connect_failure_is_retried_then_succeeds(monkeypatch):
    out, n = _stream(monkeypatch, [[CONNECT_ERR], [CONNECT_ERR], OK])
    assert n == 3
    assert any('"hello"' in c for c in out)
    assert not any(c.startswith("event: error") for c in out)


def test_connect_retries_are_bounded(monkeypatch):
    out, n = _stream(monkeypatch, [[CONNECT_ERR]])
    assert n == 1 + lc.STREAM_CONNECT_RETRIES
    assert any(c.startswith("event: error") for c in out)


def test_failure_after_streamed_bytes_is_not_retried(monkeypatch):
    chunks = ['data: ' + json.dumps({"delta": "partial"}) + '\n\n', CONNECT_ERR]
    out, n = _stream(monkeypatch, [chunks, OK])
    assert n == 1
    assert sum('"partial"' in c for c in out) == 1


def test_non_connect_error_is_not_retried(monkeypatch):
    err = 'event: error\ndata: ' + json.dumps({"error": "Read timeout", "status": 504}) + '\n\n'
    out, n = _stream(monkeypatch, [[err], OK])
    assert n == 1


def test_utility_call_survives_isolated_connect_failures(monkeypatch):
    calls = {"n": 0}

    class _Resp:
        is_success = True
        status_code = 200
        text = ""
        def json(self):
            return {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}

    class _Client:
        async def post(self, *a, **k):
            calls["n"] += 1
            if calls["n"] <= 2:
                raise httpx.ConnectTimeout("boom")
            return _Resp()

    async def nosleep(_):
        return None

    monkeypatch.setattr(lc, "_get_http_client", lambda: _Client())
    monkeypatch.setattr(lc.asyncio, "sleep", nosleep)
    out = asyncio.run(lc._llm_call_async_impl(URL, "m", [{"role": "user", "content": "hi"}], max_retries=3))
    assert out == "ok" and calls["n"] == 3


def test_http_client_is_per_event_loop():
    """Loop A stays ALIVE (blocked on an event) while loop B runs in another thread: distinct clients."""
    seen = {}
    b_done = threading.Event()
    a_got = threading.Event()

    def run_a():
        async def a():
            seen["a"] = (lc._get_http_client(), lc._get_http_client())
            a_got.set()
            while not b_done.is_set():
                await asyncio.sleep(0.01)
        asyncio.run(a())

    ta = threading.Thread(target=run_a, daemon=True)
    ta.start()

    async def grab_b():
        seen["b"] = (lc._get_http_client(), lc._get_http_client())

    try:
        assert a_got.wait(5), "loop A never became ready"
        asyncio.run(grab_b())
    finally:
        b_done.set()
        ta.join(timeout=5)
    assert seen["a"][0] is seen["a"][1] and seen["b"][0] is seen["b"][1]
    assert seen["a"][0] is not seen["b"][0]


def test_run_isolated_closes_the_loops_clients():
    seen = {}

    async def job():
        seen["c"] = lc._get_http_client()
        return 7

    assert lc.run_isolated(job()) == 7
    assert seen["c"].is_closed, "a short-lived loop's client is closed when the run ends"


def test_closed_loop_entry_is_dropped_on_next_build():
    async def grab():
        return lc._get_http_client()

    asyncio.run(grab())  # leaves a (closed-loop) entry behind
    asyncio.run(grab())
    with lc._loop_clients_lock:
        assert all(not l.is_closed() for l in list(lc._loop_clients.keys()))


def test_engine_run_isolated_closes_its_client():
    from src import orwell_engine as oe
    oe._client = None
    oe._client_factory = None
    seen = {}

    async def job():
        seen["c"] = oe._shared_client()

    lc.run_isolated(job())
    oe._client = None
    oe._client_factory = None
    assert seen["c"].is_closed


def test_engine_other_loop_clients_are_consistent_under_concurrent_loops():
    """Concurrent worker loops (all alive at once) each get exactly ONE client of their own: no loop shares one, none gets two."""
    from src import orwell_engine as oe
    oe._client = None
    oe._client_factory = None
    n = 8
    ready = threading.Barrier(n + 1)
    release = threading.Event()
    seen = {}

    def worker(i):
        async def job():
            a = oe._shared_client()
            ready.wait(10)           # every loop is alive and has asked once before any asks again
            b = oe._shared_client()
            seen[i] = (a, b)
            while not release.is_set():
                await asyncio.sleep(0.005)
        asyncio.run(job())

    threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(n)]
    try:
        for t in threads:
            t.start()
        ready.wait(10)
    finally:
        release.set()
        for t in threads:
            t.join(timeout=10)
    assert len(seen) == n
    assert all(a is b for a, b in seen.values()), "one client per loop, stable across calls"
    assert len({id(a) for a, _ in seen.values()}) == n, "no two live loops share a client"
    oe._client = None
    oe._client_factory = None


def _drive(monkeypatch, fake):
    async def nosleep(_):
        return None

    monkeypatch.setattr(lc, "stream_llm", fake)
    monkeypatch.setattr(lc.asyncio, "sleep", nosleep)
    out = []

    async def go():
        async for c in lc._stream_llm_with_fallback_impl([(URL, "m", {})], [{"role": "user", "content": "hi"}]):
            out.append(c)

    asyncio.run(go())
    return out


def test_retries_of_the_in_flight_request_survive_the_cooldown_it_tripped(monkeypatch):
    for _ in range(lc.HOST_FAIL_THRESHOLD - 1):
        lc._mark_host_dead(URL)
    calls = {"n": 0}

    async def fake(url, model, messages, **kw):
        calls["n"] += 1
        if not kw.get("_retry_in_flight") and lc._is_host_dead(url):
            yield 'event: error\ndata: ' + json.dumps({"error": "cooldown active", "status": 503}) + '\n\n'
            return
        if calls["n"] == 1:
            lc._mark_host_dead(url)  # this very attempt trips the cooldown
            yield CONNECT_ERR
            return
        for c in OK:
            yield c

    out = _drive(monkeypatch, fake)
    assert calls["n"] == 2 and any('"hello"' in c for c in out)
    assert not any(c.startswith("event: error") for c in out)


def test_separate_caller_still_fast_fails_on_a_cooled_host():
    for _ in range(lc.HOST_FAIL_THRESHOLD):
        lc._mark_host_dead(URL)

    async def go():
        return [c async for c in lc.stream_llm(URL, "m", [{"role": "user", "content": "hi"}])]

    out = asyncio.run(go())
    assert out and out[0].startswith("event: error") and "cooldown" in out[0]


def test_probe_call_on_an_already_cooled_host_is_a_single_attempt(monkeypatch):
    for _ in range(lc.HOST_FAIL_THRESHOLD):
        lc._mark_host_dead(URL)
    assert lc._is_host_cooled_now(URL)
    calls = {"n": 0}

    async def fake(url, model, messages, **kw):
        calls["n"] += 1
        yield CONNECT_ERR

    out = _drive(monkeypatch, fake)
    assert calls["n"] == 1, "a probe to a down host gets exactly one attempt"
    assert any(c.startswith("event: error") for c in out)


def test_engine_client_is_per_event_loop():
    from src import orwell_engine as oe
    seen = {}

    async def grab(tag):
        seen[tag] = (oe._shared_client(), oe._shared_client())

    oe._client = None
    oe._client_factory = None
    asyncio.run(grab("a"))
    t = threading.Thread(target=lambda: asyncio.run(grab("b")))
    t.start(); t.join()
    oe._client = None
    oe._client_factory = None
    assert seen["a"][0] is seen["a"][1] and seen["b"][0] is seen["b"][1]
    assert seen["a"][0] is not seen["b"][0]


def test_engine_loop_keeps_its_client_when_the_primarys_loop_closes_mid_flight():
    """The CI-seen failure: a foreign (e.g. leaked background) loop holds the module-global primary and closes while other
    live loops already hold their own clients. Those loops must keep THEIR client, not be handed a fresh one."""
    from src import orwell_engine as oe
    oe._client = None
    oe._client_factory = None
    oe._client_loop = None
    foreign_claimed = threading.Event()
    close_foreign = threading.Event()
    foreign_closed = threading.Event()

    def foreign():
        async def job():
            oe._shared_client()          # claims the primary
            foreign_claimed.set()
            while not close_foreign.is_set():
                await asyncio.sleep(0.005)
        asyncio.run(job())
        foreign_closed.set()

    n = 4
    got_first = threading.Barrier(n + 1)
    primary_gone = threading.Event()
    done = threading.Barrier(n + 1)
    seen = {}

    def worker(i):
        async def job():
            a = oe._shared_client()
            got_first.wait(10)
            while not primary_gone.is_set():
                await asyncio.sleep(0.005)
            seen[i] = (a, oe._shared_client())
            done.wait(10)
        asyncio.run(job())

    tf = threading.Thread(target=foreign, daemon=True)
    threads = [threading.Thread(target=worker, args=(i,), daemon=True) for i in range(n)]
    try:
        tf.start()
        assert foreign_claimed.wait(5)
        for t in threads:
            t.start()
        got_first.wait(10)               # every worker holds its own (other-loop) client
        close_foreign.set()
        assert foreign_closed.wait(5)    # the primary's loop is now closed
        primary_gone.set()
        done.wait(10)
    finally:
        # ONE cleanup path: always release + join every thread and reset the engine client state, whatever failed above
        close_foreign.set()
        primary_gone.set()
        for t in [tf, *threads]:
            if t.is_alive():
                t.join(timeout=10)
        oe._client = None
        oe._client_factory = None
        oe._client_loop = None
    assert len(seen) == n and all(a is b for a, b in seen.values()), "each loop keeps the client it already had"


def test_engine_secondary_client_is_rebuilt_when_the_factory_changes(monkeypatch):
    """A loop's cached client built by an OLD httpx.AsyncClient must not be reused after the constructor is replaced."""
    from src import orwell_engine as oe
    oe._client = None
    oe._client_factory = None
    oe._client_loop = None
    made = []

    class F1:
        is_closed = False
        def __init__(self, **kw): made.append(("F1", self))

    class F2:
        is_closed = False
        def __init__(self, **kw): made.append(("F2", self))

    got = {}

    def foreign_primary():
        async def job():
            monkeypatch.setattr(oe.httpx, "AsyncClient", F1)
            oe._shared_client()                       # the foreign loop claims the primary under F1
            got["ready"] = True
            while not got.get("stop"):
                await asyncio.sleep(0.005)
        asyncio.run(job())

    t = threading.Thread(target=foreign_primary, daemon=True)
    try:
        t.start()
        for _ in range(500):
            if got.get("ready"):
                break
            time.sleep(0.01)
        assert got.get("ready")

        async def mine():
            first = oe._shared_client()                # secondary under F1
            monkeypatch.setattr(oe.httpx, "AsyncClient", F2)
            second = oe._shared_client()               # factory changed: rebuilt under F2
            third = oe._shared_client()                # and stable afterwards
            return first, second, third
        first, second, third = asyncio.run(mine())
        assert type(first) is F1 and type(second) is F2 and second is third
    finally:
        got["stop"] = True
        t.join(timeout=10)
        oe._client = None
        oe._client_factory = None
        oe._client_loop = None
        oe._other_loop_clients = None
