"""ORW-646 / 0203: the player's coming-clean acts ride the EXISTING statement door of the scene belt. Two optional fields, `retracts` and `tellsAbout`, no kind and no claim id; the validator drops anything not in the scene or
not a roster id; the engine wrapper forwards only the well-formed shapes; the extraction prompt states rules only. Roles only."""
import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")
SCENE, ROSTER = ["npc:1", "npc:2"], ["npc:1", "npc:2", "npc:3"]


def test_retracts_form_needs_a_listener_in_the_scene_and_no_tells():
    assert al._validate_statement({"to": "npc:1", "retracts": True}, SCENE, ROSTER) == {"to": "npc:1", "retracts": True}
    assert al._validate_statement({"to": "npc:1", "about": "npc:3", "retracts": True}, SCENE, ROSTER) == {"to": "npc:1", "about": "npc:3", "retracts": True}
    assert al._validate_statement({"to": "npc:3", "retracts": True}, SCENE, ROSTER) is None  # not in the scene
    assert al._validate_statement({"to": "npc:1", "about": "npc:9", "retracts": True}, SCENE, ROSTER) is None  # not a roster id
    assert al._validate_statement({"to": "npc:1", "about": "npc:1", "retracts": True}, SCENE, ROSTER) is None
    assert al._validate_statement({"to": "npc:1", "retracts": "yes"}, SCENE, ROSTER) is None
    assert al._validate_statement({"to": "npc:1", "retracts": True, "tellsAbout": "npc:3"}, SCENE, ROSTER) is None  # never both


def test_tells_about_form_names_another_houseguest():
    assert al._validate_statement({"to": "npc:1", "tellsAbout": "npc:3"}, SCENE, ROSTER) == {"to": "npc:1", "tellsAbout": "npc:3"}
    assert al._validate_statement({"to": "npc:1", "tellsAbout": "npc:1"}, SCENE, ROSTER) is None  # the ally is not the one lied to
    assert al._validate_statement({"to": "npc:1", "tellsAbout": "npc:9"}, SCENE, ROSTER) is None
    assert al._validate_statement({"to": "npc:3", "tellsAbout": "npc:2"}, SCENE, ROSTER) is None


def test_the_old_statement_form_is_unchanged_and_no_claim_id_exists_on_this_side():
    old = {"to": "npc:1", "about": "npc:3", "kind": "going-after", "object": "npc:2"}
    assert al._validate_statement(old, SCENE, ROSTER) == old
    assert al._validate_statement({"to": "npc:1", "about": "npc:3", "kind": "going-after", "object": "npc:2", "retracts": None}, SCENE, ROSTER) == old
    assert "claim" not in str(al._validate_statement({"to": "npc:1", "retracts": True, "claimId": "claim:1"}, SCENE, ROSTER))


def test_wrapper_forwards_only_well_formed_shapes(monkeypatch):
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append(args)
        return {"eventId": "e"}

    monkeypatch.setattr(oe, "_call", fake_call)
    run = lambda st: asyncio.run(oe.record_interaction("c", with_ids=["npc:1"], statement=st))
    run({"to": "npc:1", "retracts": True}); run({"to": "npc:1", "tellsAbout": "npc:3", "claimId": "claim:1"}); run({"to": "npc:1", "retracts": True, "tellsAbout": "npc:3"}); run({"to": "npc:1"}); run(None)
    assert seen[0]["statement"] == {"to": "npc:1", "retracts": True}
    assert seen[1]["statement"] == {"to": "npc:1", "tellsAbout": "npc:3"}  # nothing else crosses
    assert all("statement" not in s for s in seen[2:])  # both, neither, absent: byte-identical to no statement


def test_extraction_prompt_states_rules_with_no_samples():
    txt = al._SCENE_EXTRACT_INSTRUCTIONS
    assert "`retracts`" in txt and "`tellsAbout`" in txt
    assert "e.g." not in txt[txt.index("`retracts`") - 200: txt.index("`tellsAbout`") + 600]
