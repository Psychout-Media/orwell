"""B4 slice 6: the 0055 auto-record belt can carry a casual assurance ('you're safe with me') to the engine. Only the closed `kind` and WHO made it come from the model; no number crosses; the field is
forwarded only when well-formed and rides the staged fold + the settle call + the engine wrapper. The engine ignores it unless ORWELL_ASSURANCES is on. Roles only."""
import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")
fl = importlib.import_module("src.fold_ledger")


def test_validate_assurance_player_default_and_closed_kind():
    assert al._validate_assurance({"kind": "safe"}, ["npc:1"]) == {"kind": "safe"}
    assert al._validate_assurance({"kind": "vote", "by": "player"}, ["npc:1"]) == {"kind": "vote"}
    assert al._validate_assurance({"kind": "bribe"}, ["npc:1"]) is None
    assert al._validate_assurance("safe", ["npc:1"]) is None
    assert al._validate_assurance(None, ["npc:1"]) is None


def test_validate_assurance_npc_speaker_must_be_in_the_scene():
    assert al._validate_assurance({"kind": "loyal", "by": "npc:1"}, ["npc:1", "npc:2"]) == {"kind": "loyal", "from": "npc:1"}
    assert al._validate_assurance({"kind": "loyal", "by": "npc:9"}, ["npc:1"]) is None  # off-scene speaker dropped, never coerced
    assert al._validate_assurance({"kind": "safe", "sincerity": 0.1}, ["npc:1"]) == {"kind": "safe"}  # no number crosses


def test_record_interaction_wrapper_forwards_only_a_wellformed_assurance(monkeypatch):
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append(args)
        return {"eventId": "e"}

    monkeypatch.setattr(oe, "_call", fake_call)
    asyncio.run(oe.record_interaction("c", with_ids=["npc:1"], assurance={"kind": "safe", "sincerity": 0.2, "x": 1}))
    asyncio.run(oe.record_interaction("c", with_ids=["npc:1"], assurance={"kind": "nope"}))
    asyncio.run(oe.record_interaction("c", with_ids=["npc:1"]))
    assert seen[0]["assurance"] == {"kind": "safe"}  # only kind/from survive
    assert "assurance" not in seen[1] and "assurance" not in seen[2]  # malformed / absent => byte-identical request


def test_staged_fold_carries_the_assurance():
    fl._PENDING.clear()
    fl.stage_pending_fold("u", "s", content="c", with_ids=["npc:1"], kind="strategy", consequence=None,
                          felt_minutes=None, idempotency_key="k", assurance={"kind": "safe"})
    fl.stage_pending_fold("u", "s", content="c2", with_ids=["npc:1"], kind="strategy", consequence=None,
                          felt_minutes=None, idempotency_key="k2")
    q = fl._PENDING[fl._key("u", "s")]
    assert q[0]["assurance"] == {"kind": "safe"} and q[1]["assurance"] is None
    fl._PENDING.clear()


def test_belt_prompt_and_settle_wire_it():
    import inspect
    src = inspect.getsource(al)
    assert '**({"assurance": entry["assurance"]} if entry.get("assurance") else {})' in src  # the settle call forwards it ONLY when present (stubs / old calls byte-identical)
    assert "_validate_assurance(obj.get(\"assurance\"), ids)" in src
    assert "NEVER any number or magnitude" in src  # the no-number rule still governs the extraction
