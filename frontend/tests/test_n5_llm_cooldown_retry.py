"""N-5 (2026-11-03 playtest): the dead-host cooldown must not turn a few real connect failures into a
wall of instant 503s, a cooled host must be probed, and the narration stream retries a connect-class
failure (pre-byte only, bounded) before the blank-turn fallback. Also: HTTP clients are per event loop."""
import asyncio
import json
import threading

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
    seen = {}

    async def grab(tag):
        seen[tag] = (lc._get_http_client(), lc._get_http_client())

    asyncio.run(grab("a"))
    t = threading.Thread(target=lambda: asyncio.run(grab("b")))
    t.start(); t.join()
    assert seen["a"][0] is seen["a"][1] and seen["b"][0] is seen["b"][1]
    assert seen["a"][0] is not seen["b"][0]


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
