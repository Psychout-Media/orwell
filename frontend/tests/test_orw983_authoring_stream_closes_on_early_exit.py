"""ORW-983: an authoring call that stops reading its stream early (an error in the body between two chunks) must cancel the wrapper's pump at once, not when the garbage collector closes the generator
(possibly in another test's loop: "Event loop is closed" / "Queue ... is bound to a different event loop" surfaced in an unrelated test). The one production caller wraps the stream in
`contextlib.aclosing`. All LLM calls are mocked."""
import asyncio

import pytest

import src.endpoint_resolver as er
from src import llm_core as lc
from src import orwell_cast_authoring as A


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _pumps():
    return [t for t in asyncio.all_tasks() if getattr(t.get_coro(), "__qualname__", "").endswith("_bounded_stream.<locals>.pump") and not t.done()]


def test_an_error_between_two_chunks_cancels_the_pump_right_away(monkeypatch):
    produced = [0]

    async def _fake(candidates, messages, temperature=None, policy=None, max_tokens=0, response_format=None, **kw):
        for i in range(10000):  # a stream far longer than the wrapper's 4-chunk queue: its pump blocks on a full queue
            produced[0] += 1
            yield f'data: {{"type":"delta","text":"{i}"}}'

    monkeypatch.setattr(lc, "stream_llm_with_fallback", _fake)
    monkeypatch.setattr(er, "resolve_endpoint", lambda prefix, owner=None: ("https://openrouter.ai/api/v1/chat/completions", "stub-model", {}))
    monkeypatch.setattr(er, "resolve_utility_fallback_candidates", lambda owner=None: [])
    monkeypatch.setattr(er, "_resolve_fallback_candidates", lambda key, owner=None: [])
    seen = [0]

    def _boom(chunk):
        seen[0] += 1
        if seen[0] == 3:
            raise ValueError("the body failed between two chunks")
        return ""

    monkeypatch.setattr(A, "_delta_text", _boom)
    async def go():
        fn = await A._resolve_llm_fn("u983")
        assert fn is not None
        with pytest.raises(Exception) as ei:
            await fn([{"role": "user", "content": "x"}])
        assert "failed between two chunks" in str(ei.value) or isinstance(ei.value, ValueError)
        await asyncio.sleep(0)  # one turn of the loop: the cancel has landed, not "when the garbage collector gets to it"
        await asyncio.sleep(0)
        return _pumps()

    leftover = _run(go())
    assert produced[0] > 3, "positive control: the stream was really being read"
    assert leftover == [], f"the pump of an abandoned stream is still pending: {leftover}"
