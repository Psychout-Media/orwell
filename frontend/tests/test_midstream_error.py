"""A mid-stream provider error (OpenRouter/OpenAI-compat) must be SURFACED, not silently dropped.

Once the first token is sent the HTTP status is already 200, so a later provider failure arrives
IN-BAND as a chunk carrying a top-level ``error`` object and/or a choice finishing with reason
"error" (OpenRouter §Errors — see docs/reference/openrouter/errors-and-debugging.md). The streaming
loop used to ignore it and close with a bare ``[DONE]``, so the partial reply ended with no signal
and the FE later hid it (the owner's "generates then disappears" report). The fix emits an
``event: error`` carrying the typed ``error_type``, AFTER preserving the already-streamed text.

Driven hermetically against the real ``stream_llm`` generator with a fake HTTP client. Roles only.
"""
import pytest
import asyncio
import json

pytestmark = pytest.mark.usefixtures("non_game_text_routing")  # ORW-287: pins the OpenRouter payload shape (non-game build)


class _FakeResp:
    def __init__(self, lines, status=200):
        self.status_code = status
        self._lines = lines

    async def aiter_lines(self):
        for ln in self._lines:
            yield ln

    async def aread(self):
        return b""


class _FakeStreamCtx:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *exc):
        return False


class _FakeClient:
    def __init__(self, resp):
        self._resp = resp

    def stream(self, method, url, **kw):
        return _FakeStreamCtx(self._resp)


OR_URL = "https://openrouter.ai/api/v1/chat/completions"


def _drive_stream(monkeypatch, lines):
    from src import llm_core as lc
    monkeypatch.setattr(lc, "_get_http_client", lambda: _FakeClient(_FakeResp(lines)))
    monkeypatch.setattr(lc, "_is_host_dead", lambda u: False)
    monkeypatch.setattr(lc, "note_model_activity", lambda *a, **k: None)
    monkeypatch.setattr(lc, "_clear_host_dead", lambda *a, **k: None)

    chunks = []

    async def drive():
        async for chunk in lc.stream_llm(OR_URL, "deepseek/deepseek-v4-pro",
                                         [{"role": "user", "content": "hi"}]):
            chunks.append(chunk)

    asyncio.get_event_loop().run_until_complete(drive())
    return chunks


def _deltas(chunks):
    out = []
    for c in chunks:
        if c.startswith("data: ") and not c.startswith("data: [DONE]"):
            try:
                j = json.loads(c[6:])
            except Exception:
                continue
            if isinstance(j, dict) and "delta" in j and not j.get("thinking"):
                out.append(j["delta"])
    return "".join(out)


def _error_events(chunks):
    out = []
    for c in chunks:
        if c.startswith("event: error") and "\ndata:" in c:
            body = c.split("\ndata:", 1)[1].strip()
            try:
                out.append(json.loads(body))
            except Exception:
                pass
    return out


def test_midstream_error_after_content_is_surfaced_and_content_preserved(monkeypatch):
    lines = [
        'data: {"choices":[{"delta":{"content":"The houseguests gather in the kitchen"}}]}',
        'data: {"id":"x","error":{"code":429,"message":"Rate limit exceeded",'
        '"metadata":{"error_type":"rate_limit_exceeded"}},'
        '"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}',
        'data: [DONE]',
    ]
    chunks = _drive_stream(monkeypatch, lines)
    # the streamed prose is PRESERVED (not discarded by the error)
    assert "The houseguests gather in the kitchen" in _deltas(chunks)
    # the mid-stream error is SURFACED with the typed code + status + the mid_stream marker
    errs = _error_events(chunks)
    assert errs, "a mid-stream error chunk must produce an `event: error`"
    e = errs[-1]
    assert e.get("error_type") == "rate_limit_exceeded"
    assert e.get("status") == 429
    assert e.get("mid_stream") is True
    # and the stream terminates cleanly
    assert chunks[-1] == "data: [DONE]\n\n"


def test_finish_reason_error_without_error_object_still_surfaces(monkeypatch):
    # Some providers send only finish_reason:"error" with no top-level error object.
    lines = [
        'data: {"choices":[{"delta":{"content":"partial"}}]}',
        'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}',
        'data: [DONE]',
    ]
    chunks = _drive_stream(monkeypatch, lines)
    assert "partial" in _deltas(chunks)
    errs = _error_events(chunks)
    assert errs and errs[-1].get("mid_stream") is True
    assert errs[-1].get("error_type") == "provider_unavailable"  # default when untyped


def test_normal_stop_does_not_emit_error(monkeypatch):
    lines = [
        'data: {"choices":[{"delta":{"content":"all good"}}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        'data: [DONE]',
    ]
    chunks = _drive_stream(monkeypatch, lines)
    assert _error_events(chunks) == [], "a normal stop must not surface an error"
    assert "all good" in _deltas(chunks)
