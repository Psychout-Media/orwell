"""ORW-1022: the front end sends shapes the engine accepts, and every refusal is a counted class."""
import asyncio
import json

from src import log_rings
from src import orwell_engine as E


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_witness_set_coerces_a_lone_id_and_drops_non_ids():
    w, dropped = E.witness_set_for("player", "npc:3")
    assert w == ["player", "npc:3"] and dropped == 0
    w, dropped = E.witness_set_for("player", ["npc:2", "Some Name", "npc:x", 7])
    assert w == ["player", "npc:2"] and dropped == 3
    w, dropped = E.witness_set_for("npc:9", None)
    assert w == ["npc:9", "player"] and dropped == 0
    w, _ = E.witness_set_for("a name", ["npc:1"])
    assert w == ["player", "npc:1"]


def test_record_interaction_sends_a_valid_array_for_a_string_with_ids(monkeypatch):
    sent = {}

    async def fake_call(name, args, user=None):
        sent["args"] = args
        return {}

    monkeypatch.setattr(E, "_call", fake_call)
    _run(E.record_interaction("a scene", with_ids="npc:4"))
    assert sent["args"]["witnessSet"] == ["player", "npc:4"]


def test_dropped_witness_entries_are_counted(monkeypatch):
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda c, e, **k: seen.append(c))

    async def fake_call(name, args, user=None):
        return {}

    monkeypatch.setattr(E, "_call", fake_call)
    _run(E.record_interaction("a scene", with_ids=["npc:4", "a bare name"]))
    assert seen == ["engine-write:witness-ids-dropped"]


def test_do_record_interaction_accepts_a_string_with_ids(monkeypatch):
    from src import tool_implementations as T
    sent = {}

    async def fake_call(name, args, user=None):
        sent["args"] = args
        return {}

    monkeypatch.setattr(E, "_call", fake_call)

    async def noop(*a, **k):
        return None

    monkeypatch.setattr(T, "_refresh_after_model_progression", noop)
    out = _run(T.do_record_interaction(json.dumps({"content": "a scene", "withIds": "npc:5"}), owner="u"))
    assert out.get("exit_code") == 0, out
    assert sent["args"]["witnessSet"] == ["player", "npc:5"]
