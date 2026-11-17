"""ORW-609 (widened): a recorded scene carries who ACTED. The 0055 extraction proposes an optional `actor` (a houseguest who did the act to the player); only an NPC id actually in the scene survives, the player or
anything else is dropped (the scene stays the player's own act, byte-identical to before). It rides the staged fold, the settle call, the engine wrapper (as the event's initiator) and the model-callable tool. Roles only."""
import asyncio
import importlib
import inspect

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")
fl = importlib.import_module("src.fold_ledger")
ti = importlib.import_module("src.tool_implementations")
ts = importlib.import_module("src.tool_schemas")


def test_validate_actor_must_be_a_houseguest_in_the_scene():
    assert al._validate_actor("npc:1", ["npc:1", "npc:2"]) == "npc:1"
    assert al._validate_actor("npc:9", ["npc:1"]) is None  # off-scene: dropped, never coerced
    assert al._validate_actor("player", ["npc:1"]) is None  # the player is the default, not an actor
    assert al._validate_actor(None, ["npc:1"]) is None
    assert al._validate_actor(3, ["npc:1"]) is None
    assert al._validate_actor({"id": "npc:1"}, ["npc:1"]) is None


def test_wrapper_sends_the_actor_as_the_initiator_and_defaults_to_the_player(monkeypatch):
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append(args)
        return {"eventId": "e"}

    monkeypatch.setattr(oe, "_call", fake_call)
    asyncio.run(oe.record_interaction("c", with_ids=["npc:2"], initiator="npc:1"))
    asyncio.run(oe.record_interaction("c", with_ids=["npc:2"]))
    assert seen[0]["initiator"] == "npc:1" and "npc:1" in seen[0]["witnessSet"] and "player" in seen[0]["witnessSet"]
    assert seen[1]["initiator"] == "player"  # no actor => the request is byte-identical to today


def test_staged_fold_carries_the_actor_only_when_there_is_one():
    fl._PENDING.clear()
    fl.stage_pending_fold("u", "s", content="c", with_ids=["npc:1"], kind="conflict", consequence=None,
                          felt_minutes=None, idempotency_key="k", actor="npc:1")
    fl.stage_pending_fold("u", "s", content="c2", with_ids=["npc:1"], kind="conflict", consequence=None,
                          felt_minutes=None, idempotency_key="k2")
    q = fl._PENDING[fl._key("u", "s")]
    assert q[0]["actor"] == "npc:1" and "actor" not in q[1]  # an old-shape entry is unchanged
    fl._PENDING.clear()


def test_persisted_entry_shape_accepts_an_actor_and_refuses_a_junk_one():
    bsp = importlib.import_module("src.belt_state_persist")
    base = dict(content="c", with_ids=["npc:1"], kind="conflict", consequence=None, felt_minutes=None, idempotency_key="k", row_anchor=None)
    assert bsp._valid_fold_entry({**base, "actor": "npc:1"})
    assert bsp._valid_fold_entry(base)
    assert not bsp._valid_fold_entry({**base, "actor": {"x": 1}})


def test_extraction_asks_for_the_actor_with_rules_and_no_samples():
    txt = al._SCENE_EXTRACT_INSTRUCTIONS
    assert '"actor"' in txt and "Add `actor` ONLY when a houseguest, not the player" in txt
    assert "e.g. a houseguest" not in txt


def test_settle_and_belt_forward_the_actor_only_when_present():
    src = inspect.getsource(al)
    assert '**({"initiator": entry["actor"]} if entry.get("actor") else {})' in src
    assert '**({"initiator": actor} if actor else {})' in src
    assert 'actor = _validate_actor(obj.get("actor"), ids)' in src


def test_model_callable_tool_takes_the_actor(monkeypatch):
    props = next(t for t in ts.FUNCTION_TOOL_SCHEMAS if t["function"]["name"] == "recordInteraction")["function"]["parameters"]["properties"]
    assert props["actor"]["type"] == "string"
    seen = []

    async def fake_record(text, **kw):
        seen.append(kw)
        return {"eventId": "e"}

    async def fake_refresh(owner, res):
        return None

    monkeypatch.setattr(oe, "record_interaction", fake_record)
    monkeypatch.setattr(ti, "_refresh_after_model_progression", fake_refresh)
    asyncio.run(ti.do_record_interaction('{"content":"x","withIds":["npc:1"],"kind":"conflict","actor":"npc:1"}', owner="u"))
    asyncio.run(ti.do_record_interaction('{"content":"x","withIds":["npc:1"],"kind":"conflict","actor":"npc:7"}', owner="u"))
    asyncio.run(ti.do_record_interaction('{"content":"x","withIds":["npc:1"],"kind":"conflict"}', owner="u"))
    assert seen[0]["initiator"] == "npc:1"
    assert "initiator" not in seen[1] and "initiator" not in seen[2]  # an unknown or absent actor leaves the call as it was
