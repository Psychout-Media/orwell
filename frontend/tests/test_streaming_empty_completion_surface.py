"""RCA: the agent/narration streaming rounds return EMPTY and the turn dies.

Corrected debug bundle (live, post-#814): endpoint resolution WORKS and OpenRouter is reachable;
the failure is that every AGENT narration round comes back with 0 chars / 0 tool calls and the
token ledger records in=0 out=0 — and the non-stream memory-extraction call to the SAME endpoint
also comes back with an empty body (`json.loads("")` → "Expecting value: line 1 column 1").

This file pins down two things the bundle implicates:

  1. The coordinator's prime suspect (literal ``max_tokens: 0`` sent on the streaming path) is
     DISPROVEN: `stream_llm` gates `max_tokens` exactly like the non-stream builder
     (`if max_tokens and max_tokens > 0`), so a 0 cap is OMITTED, never sent. The first test
     asserts that gate so a regression that starts sending ``max_tokens: 0`` would go red.

  2. The REAL user-visible defect is that an empty streamed completion on a model that returns
     200-with-no-content must be SURFACED as an error (so the player sees a reason), never
     terminate the wire as a silent success that renders a blank/vanished turn. The second/third
     tests assert `_stream_llm_with_fallback_impl` turns an empty stream into a typed
     ``empty_completion`` error rather than a bare ``[DONE]``.

Run: cd frontend && .venv/bin/python -m pytest tests/test_streaming_empty_completion_surface.py
Tests stub the provider (no network); they assert the built payload + the dispatch decision.
"""
import json
import asyncio

import pytest

import src.llm_core as llm_core

pytestmark = pytest.mark.usefixtures("non_game_text_routing")  # ORW-287: pins the OpenRouter payload shape (non-game build)


# --------------------------------------------------------------------------- #
# 1. max_tokens=0 must be OMITTED from the OpenAI/OpenRouter streaming payload
#    (mirrors the non-stream gate at llm_core.py:1186). NOT the bug — a guard.
# --------------------------------------------------------------------------- #
def _capture_streaming_payload(monkeypatch, *, model, max_tokens):
    """Drive stream_llm far enough to build the payload, capturing it at the
    httpx client boundary, then abort before any real network call."""
    captured = {}

    class _Captured(Exception):
        pass

    class _FakeClient:
        def stream(self, method, url, json=None, headers=None, timeout=None):
            captured["payload"] = json
            captured["url"] = url
            raise _Captured()

    monkeypatch.setattr(llm_core, "_get_http_client", lambda: _FakeClient())
    # Neutralize the dead-host cooldown so we always reach the client.
    monkeypatch.setattr(llm_core, "_is_host_dead", lambda *_a, **_k: False)

    async def _run():
        gen = llm_core.stream_llm(
            "https://openrouter.ai/api/v1/chat/completions",
            model,
            [{"role": "user", "content": "hi"}],
            max_tokens=max_tokens,
            headers={"Authorization": "Bearer k"},
            policy={"reasoning": {"effort": "medium"}, "max_tokens": 4096},
        )
        try:
            async for _ in gen:
                pass
        except _Captured:
            pass

    asyncio.get_event_loop().run_until_complete(_run())
    return captured.get("payload", {})


def test_streaming_payload_omits_max_tokens_when_zero(monkeypatch):
    payload = _capture_streaming_payload(
        monkeypatch, model="deepseek/deepseek-v4-pro", max_tokens=0)
    assert "max_tokens" not in payload, (
        "Regression: the streaming path sent max_tokens:0 (would ask the provider for zero "
        "output). It must be omitted when 0, mirroring the non-stream gate at llm_core.py:1186."
    )
    assert "max_completion_tokens" not in payload


def test_streaming_payload_keeps_a_positive_cap(monkeypatch):
    payload = _capture_streaming_payload(
        monkeypatch, model="deepseek/deepseek-v4-pro", max_tokens=4096)
    assert payload.get("max_tokens") == 4096


# --------------------------------------------------------------------------- #
# 2. An EMPTY streamed completion must be SURFACED (not silently terminate as a
#    blank turn). This is the actual user symptom: a model returning 200-with-no-
#    content makes the bubble vanish.
# --------------------------------------------------------------------------- #
def _collect(agen):
    out = []

    async def _run():
        async for chunk in agen:
            out.append(chunk)

    asyncio.get_event_loop().run_until_complete(_run())
    return out


def test_empty_stream_single_candidate_surfaces_error(monkeypatch):
    """One candidate, stream ends with only [DONE] and zero content → the wrapper must emit a
    typed empty_completion error so the FE renders a reason, never a silent blank turn."""

    async def _fake_stream(url, model, messages, **kwargs):
        yield "data: [DONE]\n\n"  # 200 OK, no content (the live symptom)

    monkeypatch.setattr(llm_core, "stream_llm", _fake_stream)

    chunks = _collect(llm_core._stream_llm_with_fallback_impl(
        [("https://openrouter.ai/api/v1/chat/completions", "deepseek/deepseek-v4-pro", {})],
        [{"role": "user", "content": "hi"}],
    ))
    joined = "".join(chunks)
    assert "event: error" in joined, (
        "An empty completion terminated the stream silently — the blank/vanished-turn bug. "
        "It must surface as event: error."
    )
    assert "empty_completion" in joined


def test_zero_token_usage_only_surfaces_error_not_blank(monkeypatch):
    """The EXACT live symptom: a 200 that streams ONLY a usage chunk with output_tokens==0 (no content,
    no tool calls) + [DONE]. That metadata-only chunk must NOT count as a real reply — it must surface
    a typed empty_completion error, never render a blank/vanished turn."""

    async def _fake_stream(url, model, messages, **kwargs):
        yield 'data: {"type": "usage", "data": {"input_tokens": 12, "output_tokens": 0}}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(llm_core, "stream_llm", _fake_stream)

    chunks = _collect(llm_core._stream_llm_with_fallback_impl(
        [("https://openrouter.ai/api/v1/chat/completions", "deepseek/deepseek-v4-pro", {})],
        [{"role": "user", "content": "hi"}],
    ))
    joined = "".join(chunks)
    assert "event: error" in joined, (
        "A usage-only (out=0) stream terminated as a silent success — the live blank-turn bug. "
        "It must surface as event: error."
    )
    assert "empty_completion" in joined


def test_zero_token_usage_fails_over_to_next_candidate(monkeypatch):
    """Usage-only (out=0) primary + a working fallback → the fallback answers (never a blank turn)."""

    async def _fake_stream(url, model, messages, **kwargs):
        if model == "empty-model":
            yield 'data: {"type": "usage", "data": {"input_tokens": 5, "output_tokens": 0}}\n\n'
            yield "data: [DONE]\n\n"
        else:
            yield 'data: {"delta": "real answer"}\n\n'
            yield "data: [DONE]\n\n"

    monkeypatch.setattr(llm_core, "stream_llm", _fake_stream)

    chunks = _collect(llm_core._stream_llm_with_fallback_impl(
        [
            ("https://openrouter.ai/api/v1/chat/completions", "empty-model", {}),
            ("https://openrouter.ai/api/v1/chat/completions", "good-model", {}),
        ],
        [{"role": "user", "content": "hi"}],
    ))
    joined = "".join(chunks)
    assert "real answer" in joined
    assert '"type": "fallback"' in joined


def test_empty_stream_fails_over_to_next_candidate(monkeypatch):
    """Empty primary + a working fallback → the fallback answers (never a blank turn)."""

    async def _fake_stream(url, model, messages, **kwargs):
        if model == "empty-model":
            yield "data: [DONE]\n\n"            # primary returns nothing
        else:
            yield 'data: {"delta": "real answer"}\n\n'
            yield "data: [DONE]\n\n"

    monkeypatch.setattr(llm_core, "stream_llm", _fake_stream)

    chunks = _collect(llm_core._stream_llm_with_fallback_impl(
        [
            ("https://openrouter.ai/api/v1/chat/completions", "empty-model", {}),
            ("https://openrouter.ai/api/v1/chat/completions", "good-model", {}),
        ],
        [{"role": "user", "content": "hi"}],
    ))
    joined = "".join(chunks)
    assert "real answer" in joined
    assert '"type": "fallback"' in joined  # the FE is told the primary failed


# --------------------------------------------------------------------------- #
# 3. The agent loop's end-of-turn empty guard DOES fire — a turn that produced
#    zero visible content + zero tool calls surfaces `_empty_response_fallback`'s
#    notice (agent_loop.py:5455). So the agent loop is NOT the silent culprit:
#    an empty completion reaching it produces a visible "empty response" notice.
#    This pins that contract so a regression that drops the guard goes red — and
#    documents that the live in=0/out=0 symptom must therefore originate UPSTREAM
#    of the loop (the provider returning empty/erroring for the bound model id),
#    not in a silent loop terminal.
# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# 4. Loud, always-on upstream-completion diagnostic. A 200-with-empty-body on the
#    OpenAI-compatible streaming path must emit a WARNING that says so — the missing
#    counterpart to the non-stream "succeeded" line — so the next reproduction can tell a
#    200-empty-at-the-edge from a genuine empty completion from an auth reject.
# --------------------------------------------------------------------------- #
def _drive_stream_llm(monkeypatch, *, lines, status=200):
    """Drive stream_llm against a fake httpx client that replays `lines` (SSE strings) at `status`."""

    class _FakeResp:
        status_code = status

        async def aiter_lines(self):
            for ln in lines:
                yield ln

        async def aread(self):
            return b""

    class _Ctx:
        async def __aenter__(self):
            return _FakeResp()

        async def __aexit__(self, *a):
            return False

    class _FakeClient:
        def stream(self, method, url, json=None, headers=None, timeout=None):
            return _Ctx()

    monkeypatch.setattr(llm_core, "_get_http_client", lambda: _FakeClient())
    monkeypatch.setattr(llm_core, "_is_host_dead", lambda *_a, **_k: False)
    monkeypatch.setattr(llm_core, "_clear_host_dead", lambda *_a, **_k: None)
    monkeypatch.setattr(llm_core, "note_model_activity", lambda *_a, **_k: None)

    out = []

    async def _run():
        async for chunk in llm_core.stream_llm(
            "https://openrouter.ai/api/v1/chat/completions",
            "deepseek/deepseek-v4-pro",
            [{"role": "user", "content": "hi"}],
        ):
            out.append(chunk)

    asyncio.get_event_loop().run_until_complete(_run())
    return out


def test_stream_logs_empty_200_completion(monkeypatch, caplog):
    # 200 OK, only [DONE] — no content, no usage. The always-on diagnostic must WARN that the body
    # was empty AND that no usage chunk arrived, so the operator can distinguish the failure mode.
    with caplog.at_level("INFO"):
        _drive_stream_llm(monkeypatch, lines=["data: [DONE]"])
    msgs = " ".join(r.getMessage() for r in caplog.records)
    assert "stream to" in msgs and "content_chars=0" in msgs       # the always-fires INFO line
    assert "EMPTY completion" in msgs                               # the loud empty-200 WARNING
    assert "NO usage chunk" in msgs                                 # missing token accounting WARNING


def test_stream_logs_a_real_completion_without_empty_warning(monkeypatch, caplog):
    # A real completion (content + usage) must log the INFO line WITHOUT the empty-200 WARNING.
    lines = [
        'data: {"choices": [{"delta": {"content": "hello world"}}]}',
        'data: {"usage": {"prompt_tokens": 3, "completion_tokens": 2}}',
        "data: [DONE]",
    ]
    with caplog.at_level("INFO"):
        _drive_stream_llm(monkeypatch, lines=lines)
    msgs = " ".join(r.getMessage() for r in caplog.records)
    assert "stream to" in msgs and "content_chars=11" in msgs
    assert "EMPTY completion" not in msgs
    assert "NO usage chunk" not in msgs


def test_empty_agent_turn_surfaces_a_notice_not_a_blank(monkeypatch):
    import src.agent_loop as al

    async def fake_stream(candidates, messages, **kwargs):
        # 200 OK, empty body — what the bound model returns (in=0 out=0, the
        # ledger's record). No content, no reasoning, no tool calls.
        yield 'data: {"type": "usage", "data": {"input_tokens": 0, "output_tokens": 0}}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)
    al._CASTING_STALL_LEVEL.pop("P", None)
    al._CASTING_SUBSTANCE_LEVEL.pop("P", None)

    events = []

    async def drive():
        gen = al.stream_agent_loop(
            "https://openrouter.ai/api/v1/chat/completions", "deepseek/deepseek-v4-pro",
            [{"role": "system", "content": "You are the casting producer."},
             {"role": "user", "content": "My name is P."}],
            owner="P", game_mode="casting", max_rounds=1,
        )
        async for chunk in gen:
            if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                try:
                    events.append(json.loads(chunk[6:]))
                except Exception:
                    pass

    asyncio.get_event_loop().run_until_complete(drive())

    visible = [e for e in events
               if "delta" in e and not e.get("thinking") and (e.get("delta") or "").strip()]
    # The loop's end-of-turn guard emits a visible notice rather than vanishing.
    assert visible, "the agent loop must surface a notice for an empty turn, never a blank"
    # F2 (#1017): an in-game/casting empty turn now surfaces an IN-CHARACTER producer recovery line
    # (NOT the operator "empty response / switch models" dead-end a player can't act on from chat),
    # paired with a one-tap `truncated` retry affordance. The operator string is reserved for
    # non-game workspace turns.
    import src.agent_loop as _al
    assert any(_al._EMPTY_PRODUCER_LINE == (e.get("delta") or "") for e in visible), \
        "a casting/in-game empty turn must surface the in-character producer recovery line"
    assert not any("empty response" in (e.get("delta") or "").lower() for e in visible), \
        "the operator dead-end string must not reach an in-game player"
    assert any(e.get("type") == "truncated" for e in events), \
        "a one-tap retry affordance must accompany the recovery line"
