"""The NON-STREAM `call` path surfaces an empty "stop" completion as a FAILURE (2026-07-13).

Prod debug-bundle finding: two llmIo `call` records carried
``response: {text: "", toolCalls: [], finishReason: "stop", error: null}`` with ``ok: true`` —
silent empty utility completions that "succeeded" with nothing, so the extraction belts that
issued them folded nothing and nobody noticed. The STREAM path has surfaced this shape as a
typed ``empty_completion`` error since fix D / #1453 (test_empty_completion_surfaced.py /
test_streaming_empty_completion_surface.py); this file pins the same contract onto
``llm_call_async``:

  * an empty non-length completion is retried (a failed attempt, like a 5xx), and
  * when retries are exhausted it raises a typed 502 carrying ``empty_completion`` —
    it NEVER returns "" as a silent success;
  * finish_reason=length keeps its legacy "" return (the cap-cutoff case belongs to the
    existing length-retry / parse-failure floors), and a tool_calls message with an empty
    text body stays legitimate.

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

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _wire(monkeypatch, responses):
    """Stub the HTTP client: each call pops the next canned OpenAI-shape response."""
    calls = {"n": 0}

    class _Resp:
        is_success = True
        status_code = 200

        def __init__(self, data):
            self._data = data
            self.text = json.dumps(data)

        def json(self):
            return self._data

    class _Client:
        async def post(self, url, headers=None, json=None, timeout=None):
            i = min(calls["n"], len(responses) - 1)
            calls["n"] += 1
            return _Resp(responses[i])

    monkeypatch.setattr(lc, "_get_http_client", lambda: _Client())
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_get_cached_response", lambda k: None)
    monkeypatch.setattr(lc, "_set_cached_response", lambda *a, **k: None)
    monkeypatch.setattr(lc.LLMConfig, "RETRY_DELAY", 0)
    return calls


def _msg(content, finish="stop", **extra):
    m = {"content": content}
    m.update(extra)
    return {"choices": [{"message": m, "finish_reason": finish}]}


def _call(**kwargs):
    return lc.llm_call_async(
        "https://openrouter.ai/api/v1/chat/completions", "m",
        [{"role": "user", "content": "x"}], max_retries=2, **kwargs)


def test_empty_stop_completion_raises_typed_after_retries(monkeypatch):
    monkeypatch.setattr(llm_trace, "enabled", lambda: False)
    calls = _wire(monkeypatch, [_msg("")])
    with pytest.raises(Exception) as ei:
        _run(_call())
    assert "empty_completion" in str(ei.value.detail if hasattr(ei.value, "detail") else ei.value), \
        "an empty stop completion must surface as a TYPED failure, never a silent ''"
    assert calls["n"] == 2, "the empty completion must count as a FAILED attempt and retry"


def test_empty_stop_completion_recovers_on_retry(monkeypatch):
    monkeypatch.setattr(llm_trace, "enabled", lambda: False)
    calls = _wire(monkeypatch, [_msg(""), _msg("real answer")])
    assert _run(_call()) == "real answer"
    assert calls["n"] == 2


def test_empty_completion_records_a_failed_trace_not_a_silent_ok(monkeypatch, tmp_path):
    """The llmIo record for the exhausted case is ok=false with the finishReason preserved —
    the exact bundle shape (ok=true, text='', finishReason='stop') can no longer occur."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setattr(llm_trace, "enabled", lambda: True)
    _wire(monkeypatch, [_msg("")])
    with pytest.raises(Exception):
        _run(_call(call_class="utility-extraction"))
    rec = json.loads(open(llm_trace.trace_path()).read().splitlines()[-1])
    assert rec["ok"] is False
    assert rec["callClass"] == "utility-extraction"
    assert rec["finishReason"] == "stop"
    assert "empty_completion" in json.dumps(rec["response"].get("error") or {})


def test_empty_length_completion_keeps_the_legacy_empty_return(monkeypatch):
    """finish_reason=length is deliberately excluded: the cap-cutoff case returns '' as
    today so the existing length-retry seams / parse-failure floors behave unchanged."""
    monkeypatch.setattr(llm_trace, "enabled", lambda: False)
    calls = _wire(monkeypatch, [_msg("", finish="length")])
    assert _run(_call()) == ""
    assert calls["n"] == 1, "a length cutoff is not retried by this guard"


def test_empty_text_with_tool_calls_is_not_an_empty_completion(monkeypatch):
    """A message that carries tool_calls legitimately has an empty text body."""
    monkeypatch.setattr(llm_trace, "enabled", lambda: False)
    calls = _wire(monkeypatch, [_msg("", finish="tool_calls",
                                     tool_calls=[{"id": "t1", "function": {"name": "f"}}])])
    assert _run(_call()) == ""
    assert calls["n"] == 1


def test_reasoning_only_body_is_still_recovered_not_failed(monkeypatch):
    """_openai_message_text reads the reasoning fields when content is empty — a
    reasoning-only completion is a recoverable answer, never an empty-completion failure."""
    monkeypatch.setattr(llm_trace, "enabled", lambda: False)
    calls = _wire(monkeypatch, [_msg("", reasoning_content="the recovered answer")])
    assert _run(_call()) == "the recovered answer"
    assert calls["n"] == 1
