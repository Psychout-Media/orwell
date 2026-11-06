"""ORW-104: the player's chat reaches the engine's assurance (B4) and heard-about-me (B24) fields, both from the 0055 belt and the model-driven recordInteraction tool. Closed-set only: the model
proposes the closed kind/nature + WHO; no number or free text crosses. Roles only."""
import asyncio
import importlib
import inspect
import json

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")
fl = importlib.import_module("src.fold_ledger")
ti = importlib.import_module("src.tool_implementations")
ts = importlib.import_module("src.tool_schemas")


def test_validate_heard_about_me_closed_nature_and_in_scene_npc_teller():
    v = al._validate_heard_about_me
    assert v({"nature": "targeting", "by": "npc:1"}, ["npc:1", "npc:2"]) == {"nature": "targeting", "from": "npc:1"}
    assert v({"nature": "betrayal", "by": "npc:1", "text": "x", "n": 3}, ["npc:1"]) == {"nature": "betrayal", "from": "npc:1"}
    assert v({"nature": "gossip", "by": "npc:1"}, ["npc:1"]) is None  # closed set
    assert v({"nature": "targeting", "by": "npc:9"}, ["npc:1"]) is None  # off-scene teller dropped
    assert v({"nature": "targeting", "by": "player"}, ["player", "npc:1"]) is None  # the player telling is not this field
    assert v({"nature": "targeting"}, ["npc:1"]) is None  # a teller is required
    assert v("targeting", ["npc:1"]) is None and v(None, ["npc:1"]) is None


def test_wrapper_forwards_only_wellformed_heard_about_me(monkeypatch):
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append(args)
        return {"eventId": "e"}

    monkeypatch.setattr(oe, "_call", fake_call)
    asyncio.run(oe.record_interaction("c", with_ids=["npc:1"], heard_about_me={"nature": "targeting", "from": "npc:1", "text": "free"}))
    asyncio.run(oe.record_interaction("c", with_ids=["npc:1"], heard_about_me={"nature": "nope"}))
    asyncio.run(oe.record_interaction("c", with_ids=["npc:1"]))
    assert seen[0]["heardAboutMe"] == {"nature": "targeting", "from": "npc:1"}
    assert "heardAboutMe" not in seen[1] and "heardAboutMe" not in seen[2]


def test_staged_fold_carries_heard_about_me():
    fl._PENDING.clear()
    fl.stage_pending_fold("u", "s", content="c", with_ids=["npc:1"], kind="gossip", consequence=None, felt_minutes=None,
                          idempotency_key="k", heard_about_me={"nature": "betrayal", "from": "npc:1"})
    fl.stage_pending_fold("u", "s", content="c2", with_ids=["npc:1"], kind="gossip", consequence=None, felt_minutes=None, idempotency_key="k2")
    q = fl._PENDING[fl._key("u", "s")]
    assert q[0]["heard_about_me"] == {"nature": "betrayal", "from": "npc:1"} and q[1]["heard_about_me"] is None
    fl._PENDING.clear()


def test_belt_prompt_asks_for_it_and_settle_and_direct_call_forward_it():
    src = inspect.getsource(al)
    assert '"heardAboutMe":{"nature"' in src
    assert '_validate_heard_about_me(obj.get("heardAboutMe"), ids)' in src
    assert '**({"heard_about_me": entry["heard_about_me"]} if entry.get("heard_about_me") else {})' in src
    assert '**({"heard_about_me": heard_about_me} if heard_about_me else {})' in src
    assert "heard_about_me=heard_about_me)" in src  # staged


def _run_tool(monkeypatch, args):
    seen = []

    async def fake_ri(text, **kw):
        seen.append(kw)
        return {"eventId": "e"}

    monkeypatch.setattr(oe, "record_interaction", fake_ri)
    r = asyncio.run(ti.do_record_interaction(json.dumps(args), owner="u"))
    assert r["exit_code"] == 0
    return seen[0]


def test_model_driven_tool_forwards_assurance_and_heard_about_me(monkeypatch):
    kw = _run_tool(monkeypatch, {"content": "c", "withIds": ["npc:1", "npc:2"], "assurance": {"kind": "safe"},
                                 "heardAboutMe": {"nature": "targeting", "by": "npc:1"}})
    assert kw["assurance"] == {"kind": "safe"}
    assert kw["heard_about_me"] == {"nature": "targeting", "from": "npc:1"}


def test_model_driven_tool_npc_assurance_and_junk_dropped(monkeypatch):
    kw = _run_tool(monkeypatch, {"content": "c", "withIds": ["npc:1"], "assurance": {"kind": "vote", "by": "npc:1", "sincerity": 0.1},
                                 "heardAboutMe": {"nature": "targeting", "by": "npc:9"}})
    assert kw["assurance"] == {"kind": "vote", "from": "npc:1"}
    assert "heard_about_me" not in kw  # off-scene teller dropped
    kw = _run_tool(monkeypatch, {"content": "c", "withIds": ["npc:1"], "assurance": {"kind": "bribe"}})
    assert "assurance" not in kw and "heard_about_me" not in kw


def test_tool_schema_advertises_both_with_closed_enums():
    fn = next(t for t in ts.FUNCTION_TOOL_SCHEMAS if t["function"]["name"] == "recordInteraction")["function"]["parameters"]["properties"]
    assert fn["assurance"]["properties"]["kind"]["enum"] == ["safe", "vote", "loyal"]
    assert fn["heardAboutMe"]["properties"]["nature"]["enum"] == ["targeting", "betrayal"]
