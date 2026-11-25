"""ORW-910: the consequence belts' extraction model calls are made concurrently up front (extract-only: no engine write), then the belt chain runs in its
usual strict order and each belt's identical request is answered from that prefetch. No live model: `llm_call_async` is a stub with a fixed delay. Roles only."""
import asyncio
import time

import pytest

from src import agent_loop as al


def _stub(monkeypatch, delay=0.4):
    calls = []

    async def fake_llm(**kw):
        calls.append(kw["messages"][0]["content"])
        await asyncio.sleep(delay)
        return '{"answer": "%s"}' % kw["messages"][0]["content"]

    import src.llm_core as core
    monkeypatch.setattr(core, "llm_call_async", fake_llm)
    return calls


def _belt(name, writes):
    """A belt in the real shape: build the request, extract through `_belt_llm`, then write (here: note the write in order)."""
    async def belt(prompt=None):
        raw = await al._belt_llm(url="u", model="m", messages=[{"role": "system", "content": prompt or name}], headers={},
                                 temperature=0.1, max_tokens=100, timeout=5, call_class="utility-extraction", user="u")
        writes.append((name, raw))
        return True
    return belt


def test_an_extract_only_run_calls_once_and_never_writes_then_the_ordered_run_reuses_it(monkeypatch):
    calls = _stub(monkeypatch, 0.01); writes = []
    belt = _belt("deal", writes)

    async def go():
        tok = al._BELT_PREFETCH_CACHE.set({})
        try:
            await al._belt_prefetch_one(belt)
            assert writes == [], "the extract-only run stops before its write"
            assert len(calls) == 1
            await belt()
        finally:
            al._BELT_PREFETCH_CACHE.reset(tok)
    asyncio.run(go())
    assert len(calls) == 1, "the ordered run reused the prefetched answer"
    assert writes == [("deal", '{"answer": "deal"}')]


def test_a_changed_request_calls_live(monkeypatch):
    calls = _stub(monkeypatch, 0.01); writes = []
    belt = _belt("confide", writes)

    async def go():
        tok = al._BELT_PREFETCH_CACHE.set({})
        try:
            await al._belt_prefetch_one(belt, "confide-as-read-before-an-earlier-belt-wrote")
            await belt("confide-as-read-after-it")   # an earlier belt moved the state it reads: another prompt
        finally:
            al._BELT_PREFETCH_CACHE.reset(tok)
    asyncio.run(go())
    assert len(calls) == 2 and writes == [("confide", '{"answer": "confide-as-read-after-it"}')]


def test_three_belts_cost_about_one_extraction_and_still_write_in_order(monkeypatch):
    """The before/after the PR quotes: three belts at 0.4 s each took ~1.2 s one after another; prefetched they take ~0.4 s, writes in the same order."""
    _stub(monkeypatch, 0.4)
    names = ["deal", "confide", "scene"]

    async def run(prefetch):
        writes = []; belts = [_belt(n, writes) for n in names]
        t0 = time.perf_counter()
        tok = al._BELT_PREFETCH_CACHE.set({}) if prefetch else None
        try:
            if prefetch:
                await asyncio.gather(*(asyncio.ensure_future(al._belt_prefetch_one(b)) for b in belts))
            for b in belts:
                await b()
        finally:
            if tok is not None:
                al._BELT_PREFETCH_CACHE.reset(tok)
        return time.perf_counter() - t0, [w[0] for w in writes]

    before, order_before = asyncio.run(run(False))
    after, order_after = asyncio.run(run(True))
    print(f"ORW910 three belts: one after another {before:.2f}s, prefetched {after:.2f}s")
    assert order_before == order_after == names
    assert before >= 1.1 and after < 0.7


def test_the_flag_and_the_prefetchable_set(monkeypatch):
    monkeypatch.delenv("ORWELL_BELT_PREFETCH", raising=False)
    assert al._belt_prefetch_enabled() is True
    monkeypatch.setenv("ORWELL_BELT_PREFETCH", "0")
    assert al._belt_prefetch_enabled() is False
    assert al._auto_record_scene in al._BELT_PREFETCHABLE and al._auto_confide in al._BELT_PREFETCHABLE
    assert (lambda: None) not in al._BELT_PREFETCHABLE   # a stand-in is never run extract-only
