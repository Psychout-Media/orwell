"""ORW-786: a model-written recordInteraction `withIds` that is not the engine's canonical id form (a name-shaped id) was refused whole by the engine shape guard, and the model retried the same ids six times. The tool boundary resolves them against the roster. Roles only."""
import asyncio
import importlib
import json

ti = importlib.import_module("src.tool_implementations")
orwell_engine = importlib.import_module("src.orwell_engine")

HOUSE = [{"id": "npc:3", "name": "Alpha Bravo"}, {"id": "npc:4", "name": "Charlie Delta"}, {"id": "npc:5", "name": "Alpha Echo"}]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _drive(monkeypatch, with_ids):
    seen = {}

    async def fake_state(user=None, timeout=None):
        return {"house": HOUSE}

    async def fake_record(text, with_ids=None, user=None, **kw):
        seen["with_ids"] = with_ids
        return {"eventId": "e1"}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "record_interaction", fake_record)
    out = _run(ti.do_record_interaction(json.dumps({"content": "a scene", "withIds": with_ids}), owner="o786"))
    return seen, out


def test_name_shaped_ids_resolve_to_canonical(monkeypatch):
    seen, out = _drive(monkeypatch, ["npc:charlie-delta", "npc:4", "Delta"])
    assert seen["with_ids"] == ["npc:4"]
    assert out["exit_code"] == 0


def test_ambiguous_and_unknown_are_dropped_not_guessed(monkeypatch):
    seen, out = _drive(monkeypatch, ["npc:alpha", "npc:nobody", "3"])
    assert seen["with_ids"] == ["npc:3"]
    assert "left out" in json.loads(out["output"])["note"]


def test_canonical_ids_skip_the_roster_read(monkeypatch):
    async def boom(user=None, timeout=None):
        raise AssertionError("roster read for canonical ids")
    monkeypatch.setattr(orwell_engine, "get_game_state", boom)

    async def fake_record(text, with_ids=None, user=None, **kw):
        return {"eventId": "e1", "ids": with_ids}
    monkeypatch.setattr(orwell_engine, "record_interaction", fake_record)
    out = _run(ti.do_record_interaction(json.dumps({"content": "x", "withIds": ["npc:3", "player"]}), owner="o786"))
    assert json.loads(out["output"])["ids"] == ["npc:3", "player"]
