"""ORW-437 (review of #2668): a stream that ends in an `event: error` frame RAISES out of the shared completion fn.
Each consumer of `_resolve_llm_fn` is driven through the REAL resolved fn with a stub stream (a partial text, then an error
frame): nothing is stored and the consumer takes its own failure path."""
import asyncio
import json

import pytest

import src.endpoint_resolver as er
from src import llm_core as lc
from src import orwell_cast_authoring as A

_URL = "https://openrouter.ai/api/v1/chat/completions"
ERR = 'event: error\ndata: {"status": 503, "text": "provider overloaded"}\n\n'


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


@pytest.fixture
def failing_fn(monkeypatch):
    monkeypatch.setattr(er, "resolve_endpoint", lambda prefix, owner=None: (_URL, "stub-chat-model", {}))
    monkeypatch.setattr(er, "resolve_utility_fallback_candidates", lambda owner=None: [])
    monkeypatch.setattr(er, "_resolve_fallback_candidates", lambda key, owner=None: [])
    calls = []

    async def fake(candidates, messages, **kw):
        calls.append(1)
        yield "data: " + json.dumps({"delta": '{"reflection": "I felt a cut-off'}) + "\n\n"
        yield ERR
        yield "data: " + json.dumps({"type": "finish", "reason": "stop"}) + "\n\n"
    monkeypatch.setattr(lc, "stream_llm_with_fallback", fake)
    fn = _run(A.resolve_prose_llm_fn(A._resolve_llm_fn, "u"))
    fn.calls = calls
    return fn


def test_the_completion_fn_raises_on_an_error_frame_and_does_not_retry(failing_fn):
    with pytest.raises(RuntimeError):
        _run(failing_fn([{"role": "user", "content": "x"}]))
    assert len(failing_fn.calls) == 1


def test_house_reflections_takes_its_failure_path(failing_fn):
    from src import orwell_house_reflections as M
    assert _run(M._attempt(failing_fn, [{"role": "user", "content": "x"}])) is None


def test_npc_minds_words_takes_its_failure_path(failing_fn):
    from src import orwell_npc_minds_words as M
    assert _run(M._attempt(failing_fn, [{"role": "user", "content": "x"}], lambda t: {"x": t})) is None


def test_gen_competitions_stores_nothing(failing_fn):
    from src import orwell_gen_competitions as M
    wrote = []

    async def staging():
        return {"dropOrder": [{"id": "a"}, {"id": "b"}], "week": 1, "kind": "k"}

    async def write(f):
        wrote.append(f)
        return {"accepted": True}
    out = _run(M.author_competition(staging, failing_fn, write))
    assert out == {"accepted": False, "reason": "llm-failed"} and wrote == []


def test_zeitgeist_stores_nothing(failing_fn):
    from src import orwell_zeitgeist as M
    wrote = []

    async def research():
        return ""

    async def write(f):
        wrote.append(f)
        return {"accepted": True}
    out = _run(M.capture_zeitgeist(research, failing_fn, write, captured_for="d", captured_at="t"))
    assert out == {"accepted": False, "reason": "llm-failed"} and wrote == []


def test_offscreen_texture_stores_nothing(failing_fn):
    from src import orwell_offscreen_texture as M
    wrote = []

    async def write(eid, prose):
        wrote.append(prose)
        return {"ok": True}
    assert _run(M.voice_scene({"eventId": "e1", "participants": []}, failing_fn, write)) is False and wrote == []


def test_day_condense_stores_nothing(failing_fn, monkeypatch):
    from src import orwell_day_condense as M
    monkeypatch.setattr(M, "visible_day_text", lambda history, day: "something happened today. " * 20)
    wrote = []

    async def write(day, text, **kw):
        wrote.append(text)
        return {"accepted": True}
    async def ledger():
        return [{"day": 1, "tier": "day"}]
    out = _run(M.condense_day("u", 1, llm_fn=failing_fn, history=[], ledger_fn=ledger, write_fn=write))
    assert out["accepted"] is False and out["reason"] == "error" and wrote == []  # the raise lands in condense_day's own failsoft


def test_cast_identity_and_producer_authoring_take_their_failure_path(failing_fn):
    from src import orwell_cast_identity as I
    from src import orwell_producer_authoring as PA
    wrote = []

    async def write(f):
        wrote.append(f)
        return {"accepted": True}
    assert _run(I.seed_cast_identity([{"id": "npc:1", "name": "A B"}], failing_fn, write)) == 0
    out = _run(PA.author_producer(failing_fn, write, producer={"id": "p"}))
    assert wrote == [] and out.get("accepted") is False


def test_cast_authoring_writes_nothing_and_makes_no_strict_reparse(failing_fn):
    wrote = []

    async def write(p):
        wrote.append(p)
        return {"accepted": True}
    n = _run(A.author_cast([{"id": "npc:1", "name": "Npc One", "age": 30, "genderPresentation": "woman"}], failing_fn, write, user="u"))
    assert n == 0 and wrote == []
    assert len(failing_fn.calls) == 1  # one call, no strict-JSON reparse or retry ladder rode over the error frame


def test_a_length_cut_reply_whose_doubled_cap_retry_ends_in_an_error_frame_raises(monkeypatch):
    """The first reply is cut at finish_reason=length, the retry at the doubled cap ends in an error frame: the frame is
    never returned as the completion (the off-screen texture writer would store it as scene prose)."""
    monkeypatch.setattr(er, "resolve_endpoint", lambda prefix, owner=None: (_URL, "stub-chat-model", {}))
    monkeypatch.setattr(er, "resolve_utility_fallback_candidates", lambda owner=None: [])
    monkeypatch.setattr(er, "_resolve_fallback_candidates", lambda key, owner=None: [])
    calls = []

    async def fake(candidates, messages, **kw):
        calls.append(1)
        if len(calls) == 1:
            yield "data: " + json.dumps({"delta": '{"scene": "cut off mid'}) + "\n\n"
            yield "data: " + json.dumps({"type": "finish", "reason": "length"}) + "\n\n"
        else:
            yield ERR
            yield "data: " + json.dumps({"type": "finish", "reason": "stop"}) + "\n\n"
    monkeypatch.setattr(lc, "stream_llm_with_fallback", fake)
    fn = _run(A.resolve_prose_llm_fn(A._resolve_llm_fn, "u"))
    with pytest.raises(RuntimeError, match="provider-error-frame"):
        _run(fn([{"role": "user", "content": "x"}]))
    assert len(calls) == 2  # the length retry ran once, then the error raised
