"""N4 (2026-07-16 live-playthrough forensics) — the non-stream LLM call path now enforces a
genuine WALL-CLOCK ceiling.

Live evidence: a background memory-extraction call (pure JSON extraction, `llm_call_async`, no
streaming) ran 780,485ms (13 minutes) and still completed `ok:true`. `agent_stream_timeout_seconds`
only guards the STREAMING path (`stream_llm`); the non-stream chokepoint's per-attempt httpx
`read` timeout can be defeated by upstream keep-alive trickle (resets on ANY received byte, not
overall call duration) and, even when it fires, gets multiplied by the impl's own retry loop.

`llm_core._bounded_impl_call` now wraps every non-stream attempt (all retries included) in
`asyncio.wait_for(..., timeout=<the effective timeout>)` — a REAL ceiling immune to both defeats.
This file pins:

  * a call that never returns a byte is force-terminated at the ceiling (never hangs past it);
  * the raised exception is a genuine `asyncio.TimeoutError`, which `_exc_fail_class` (the rc6
    #1663 precedent) already classifies as `"timeout"`;
  * with the I/O trace enabled, the failure is logged truthfully — `ok:false` /
    `failClass:"timeout"` — NEVER a silent `ok:true` the way the live incident recorded it;
  * a falsy `timeout` (0/None) stays "no ceiling" (legacy behavior) — it must never become an
    instant `wait_for(timeout=0)` expiry.

Roles only — probe strings, never cast material.
"""
import asyncio
import importlib
import json
import os

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")  # ORW-287: pins the OpenRouter payload shape (non-game build)

lc = importlib.import_module("src.llm_core")
llm_trace = importlib.import_module("src.llm_trace")

_URL = "https://openrouter.ai/api/v1/chat/completions"


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


class _HangingClient:
    """A fake HTTP client whose post() never returns — simulates the live incident: an upstream
    call ran far longer than any per-attempt read timeout should allow (keep-alive trickle
    defeating httpx's idle-reset heuristic)."""

    async def post(self, url, headers=None, json=None, timeout=None):
        await asyncio.sleep(3600)  # "forever" relative to the test's tiny ceiling
        raise AssertionError("should have been cancelled by the wall-clock ceiling long before this")


def _wire_hanging(monkeypatch):
    monkeypatch.setattr(lc, "_get_http_client", lambda: _HangingClient())
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_get_cached_response", lambda k: None)
    monkeypatch.setattr(lc, "_set_cached_response", lambda *a, **k: None)


def test_hanging_nonstream_call_is_force_terminated_at_the_ceiling(monkeypatch):
    _wire_hanging(monkeypatch)
    with pytest.raises(asyncio.TimeoutError):
        _run(lc.llm_call_async(
            _URL, "m", [{"role": "user", "content": "x"}],
            timeout=0.05, max_retries=1,
        ))


def test_timeout_expiry_is_classified_truthfully_as_timeout(monkeypatch):
    _wire_hanging(monkeypatch)
    raised = None
    try:
        _run(lc.llm_call_async(
            _URL, "m", [{"role": "user", "content": "x"}],
            timeout=0.05, max_retries=1,
        ))
        pytest.fail("expected the call to raise on ceiling expiry")
    except Exception as e:
        raised = e
    assert isinstance(raised, asyncio.TimeoutError)
    assert lc._exc_fail_class(raised) == "timeout"


@pytest.fixture
def _trace_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(llm_trace, "enabled", lambda: True)
    return tmp_path


def _last_record(tmp_path):
    return json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])


def test_timeout_logs_ok_false_failclass_timeout_never_ok_true(_trace_dir, monkeypatch):
    _wire_hanging(monkeypatch)
    with pytest.raises(asyncio.TimeoutError):
        _run(lc.llm_call_async(
            _URL, "m", [{"role": "user", "content": "x"}],
            timeout=0.05, max_retries=1, call_class="utility-extraction",
        ))
    rec = _last_record(_trace_dir)
    assert rec["ok"] is False, "a wall-clock ceiling expiry must never be logged ok:true"
    assert rec["failClass"] == "timeout"


def test_falsy_timeout_stays_unbounded_no_instant_expiry(monkeypatch):
    """A literal 0/None timeout is legacy 'no ceiling' — it must never turn into an instant
    wait_for(timeout=0) expiry that breaks every caller that (theoretically) passes it."""

    class _Resp:
        is_success = True
        status_code = 200

        def __init__(self):
            self.text = json.dumps(
                {"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]})

        def json(self):
            return json.loads(self.text)

    class _FastClient:
        async def post(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(lc, "_get_http_client", lambda: _FastClient())
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_get_cached_response", lambda k: None)
    monkeypatch.setattr(lc, "_set_cached_response", lambda *a, **k: None)

    result = _run(lc.llm_call_async(
        _URL, "m", [{"role": "user", "content": "x"}], timeout=0,
    ))
    assert result == "ok"


def test_memory_extraction_timeout_setting_is_registered_and_well_under_streaming():
    """N4: the new configurable default for utility-class non-stream calls (memory extraction is
    the flagship consumer) must exist and stay well under the shared 300s streaming figure."""
    settings = importlib.import_module("src.settings")
    val = settings.DEFAULT_SETTINGS.get("memory_extraction_timeout_seconds")
    assert isinstance(val, int) and 0 < val < settings.DEFAULT_SETTINGS["agent_stream_timeout_seconds"]
