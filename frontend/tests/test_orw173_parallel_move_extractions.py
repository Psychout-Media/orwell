"""ORW-173: the player-move and NPC-move belts' two extraction LLM calls run CONCURRENTLY (they only read the narration), while the
engine writes stay sequential and in the original order. No model is called: llm_call_async and the engine are stubbed.

SYNC tests only - drive coroutines via run_until_complete.
"""
import asyncio
import importlib
import re
from pathlib import Path

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")

_HOUSE = [{"id": "npc:1", "name": "Houseguest One"}, {"id": "npc:2", "name": "Houseguest Two"}]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _gather(monkeypatch, fake_llm):
    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    return _run(al._gather_move_extractions("n", "u", _HOUSE, "http://x", "m", {}, "bob"))


def test_the_two_extractions_overlap_in_time(monkeypatch):
    events = []

    async def fake_llm(*a, **k):
        kind = "npc" if "moves" in k["messages"][0]["content"] else "player"
        events.append(("start", kind))
        await asyncio.sleep(0.05)
        events.append(("end", kind))
        return '{"room":"kitchen"}' if kind == "player" else '{"moves":[]}'

    pm, nm = _gather(monkeypatch, fake_llm)
    assert pm == '{"room":"kitchen"}' and nm == '{"moves":[]}'
    # both started before either finished = concurrent (serial would be start,end,start,end)
    assert [e[0] for e in events[:2]] == ["start", "start"], events


def test_one_extraction_failing_does_not_skip_the_other(monkeypatch):
    async def fake_llm(*a, **k):
        if "moves" in k["messages"][0]["content"]:
            raise RuntimeError("boom")
        return '{"room":"kitchen"}'

    pm, nm = _gather(monkeypatch, fake_llm)
    assert pm == '{"room":"kitchen"}'
    assert nm == ""  # that belt then no-ops exactly like a failed call did before


def test_apply_with_prefetched_raw_makes_no_llm_call_and_keeps_write_order(monkeypatch):
    order = []

    async def no_llm(*a, **k):
        raise AssertionError("an extraction was prefetched; the belt must not call the model again")

    async def fake_move_to(room, user=None, **k):
        order.append(("player", room))
        return {"room": room}

    async def fake_backfill(owner, fn, *a, **k):
        return await fn(*a, **{kk: vv for kk, vv in k.items() if kk == "user"})

    async def fake_whereabouts(user=None):
        return {"room": "living-room"}

    async def fake_move_hg(hid, room, user=None):
        order.append(("npc", hid, room))
        return {"status": "moved"}

    monkeypatch.setattr(llm_core, "llm_call_async", no_llm)
    monkeypatch.setattr(orwell_engine, "move_to", fake_move_to)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_whereabouts)
    monkeypatch.setattr(orwell_engine, "move_houseguest", fake_move_hg)
    monkeypatch.setattr(al, "_backfill_with_cas", fake_backfill)

    async def go():
        ok = await al._auto_move_player("n", "u", "http://x", "m", {}, "bob", raw='{"room":"kitchen"}')
        n = await al._auto_move_npc("n", "u", _HOUSE, "http://x", "m", {}, "bob",
                                    raw='{"moves":[{"id":"npc:1","room":"backyard"}]}')
        return ok, n

    ok, n = _run(go())
    assert ok is True and n == 1
    assert order == [("player", "kitchen"), ("npc", "npc:1", "backyard")]


def test_call_site_gathers_extractions_but_applies_in_order():
    src = (Path(__file__).resolve().parent.parent / "src" / "agent_loop.py").read_text()
    g = src.index("_gather_move_extractions(\n                            _turn_narration_visible")
    p = src.index("raw=_pm_raw", g)
    n = src.index("raw=_nm_raw", p)
    assert g < p < n, "player write must be applied before the NPC write"
    assert re.search(r"if _want_move and _want_npc_move:", src[g - 400:g])
