"""A29 class fix (FE half): every FE-driven engine call that COMMITS and whose result the FE used to discard now adopts the post-commit beatSeq the engine echoes (one test per site), so the next
compare-and-swap call is not a self-inflicted stale-beat 409. Roles only. SYNC tests (run_until_complete)."""
import asyncio
import importlib

ti = importlib.import_module("src.tool_implementations")
al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
ch = importlib.import_module("routes.chat_helpers")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _seed(owner, n=10):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq(owner, {"beatSeq": n})


def test_diary_room_tool_adopts_the_token(monkeypatch):
    _seed("o1")

    async def fake(entry, user=None):
        return {"recorded": True, "beatSeq": 11}

    monkeypatch.setattr(orwell_engine, "diary_room", fake)
    _run(ti.do_diary_room('{"entry":"a private thought"}', owner="o1"))
    assert ch.last_beat_seq("o1") == 11


def test_mark_houseguest_met_tool_adopts_the_token(monkeypatch):
    _seed("o2")

    async def fake(hg_id, user=None, via=None):
        return {"complete": False, "metCount": 1, "beatSeq": 11}

    monkeypatch.setattr(orwell_engine, "mark_houseguest_met", fake)
    _run(ti.do_mark_houseguest_met('{"id":"npc:1"}', owner="o2"))
    assert ch.last_beat_seq("o2") == 11


def test_a_null_result_leaves_the_token_alone(monkeypatch):
    _seed("o3")

    async def fake(hg_id, user=None, via=None):
        return None

    monkeypatch.setattr(orwell_engine, "mark_houseguest_met", fake)
    _run(ti.do_mark_houseguest_met('{"id":"npc:1"}', owner="o3"))
    assert ch.last_beat_seq("o3") == 10
