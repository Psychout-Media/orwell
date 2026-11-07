"""#1842: castCoherence from engine createCharacter → #1599 health rollup.

`enforceCastCoherence` auto-corrects cast identity mismatches at game start. The
engine returns `castCoherence` dict with `repaired` count and `houseguests` list.
This test verifies the FE wires it to `enrichment_policy.record_runtime_failure`
so an auto-corrected cast still surfaces RED on /status.

Roles only — every string is a generic probe, never cast material.
"""
import importlib

import pytest

ti = importlib.import_module("src.tool_implementations")
oe = importlib.import_module("src.orwell_engine")
ep = importlib.import_module("src.enrichment_policy")


def _make_cast_coherence(repaired: int, *,
                         guest_ids: list[str] | None = None) -> dict:
    """Build a castCoherence dict with the given number of repaired houseguests."""
    ids = guest_ids or [f"npc:{i}" for i in range(1, repaired + 1)]
    return {
        "repaired": repaired,
        "houseguests": [
            {"id": iid, "action": "repaired"}
            for iid in ids
        ]
    }


def _started_res(coherence: dict | None = None) -> dict:
    """A started-season engine result, optionally including castCoherence."""
    house = [{"id": "player", "name": "The Player"}]
    for i in range(1, 4):
        house.append({"id": f"npc:{i}", "name": f"Houseguest {i}"})
    res = {
        "started": True,
        "house": house,
        "portraitPrompts": [
            {"houseguestId": h["id"], "name": h["name"], "prompt": "headshot"}
            for h in house
        ]
    }
    if coherence is not None:
        res["castCoherence"] = coherence
    return res


# ── fixture: stub the engine create + background noise ─────────────────────

@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """Stub engine create_character and enrichments so tests drive only #1842."""
    async def fake_create(*a, **k):
        return _started_res()
    monkeypatch.setattr(oe, "create_character", fake_create)

    async def fake_state(*a, **k):
        return {"started": False}
    monkeypatch.setattr(oe, "get_game_state", fake_state)

    # Stub portrait/cast-authoring kickoffs to no-ops (not under test).
    import src.orwell_cast_identity as cid
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)

    # Clear failure ledger before each test.
    ep.clear_failures()
    yield
    ep.clear_failures()


# ── (a) engine returns castCoherence with repaired > 0 ──────────────────────

def test_cast_coherence_wires_to_runtime_failure_on_repair(run):
    """When castCoherence has repaired>0, record_runtime_failure fires."""
    # Arrange: engine returns a result WITH a correction.
    coherence = _make_cast_coherence(2)
    orig = oe.create_character

    async def _with_coherence(*a, **k):
        return _started_res(coherence)
    import src.tool_implementations as ti_mod
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(oe, "create_character", _with_coherence)
    try:
        # Act
        res = run(ti.do_create_character('{"playerName":"P"}', owner="bob"))
        # Assert: record_runtime_failure was called → failure ledger has entry
        fails = ep.failures("bob")
        cast_fails = [f for f in fails if f["callClass"] == "cast-coherence"]
        assert len(cast_fails) == 1, (
            f"Expected 1 cast-coherence failure, got {len(cast_fails)}: {fails}")
        entry = cast_fails[0]
        assert "repaired 2" in entry["reason"]
        import json
        detail = json.loads(entry["detail"])
        assert detail["repaired"] == 2
        assert len(detail["houseguests"]) == 2
    finally:
        monkeypatch.undo()


def test_cast_coherence_without_repair_does_not_record(run):
    """castCoherence with repaired=0 must NOT fire a health event."""
    coherence = _make_cast_coherence(0, guest_ids=[])
    coherence["repaired"] = 0
    coherence["houseguests"] = []

    orig = oe.create_character

    async def _with_coherence(*a, **k):
        return _started_res(coherence)
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(oe, "create_character", _with_coherence)
    try:
        res = run(ti.do_create_character('{"playerName":"P"}', owner="alice"))
        fails = ep.failures("alice")
        cast_fails = [f for f in fails if f["callClass"] == "cast-coherence"]
        assert len(cast_fails) == 0, (
            f"Expected 0 cast-coherence failures, got {len(cast_fails)}: {fails}")
    finally:
        monkeypatch.undo()


def test_no_cast_coherence_does_not_record(run):
    """Engine result WITHOUT castCoherence key — no health event."""
    # The autouse fixture returns no castCoherence; just call it normally.
    res = run(ti.do_create_character('{"playerName":"P"}', owner="carol"))
    fails = ep.failures("carol")
    cast_fails = [f for f in fails if f["callClass"] == "cast-coherence"]
    assert len(cast_fails) == 0, (
        f"Expected 0 cast-coherence failures, got {len(cast_fails)}: {fails}")


# ── ORW-145: the record says WHAT was incoherent, and a floored houseguest is never dropped ──────────

def _coherence_with_fields():
    """The engine's `castCoherence` as `enforceCastCoherence` returns it: ids, public field NAMES and the
    action per houseguest (Vault-free by the engine's contract: no prose, no hidden value)."""
    return {
        "repaired": 1,
        "floored": 1,
        "houseguests": [
            {"id": "npc:1", "action": "repaired", "fields": ["biography"]},
            {"id": "npc:2", "action": "floored", "fields": ["appearance", "demeanor"]},
        ],
    }


def _create_with(monkeypatch, run, coherence, owner):
    async def _with_coherence(*a, **k):
        return _started_res(coherence)
    monkeypatch.setattr(oe, "create_character", _with_coherence)
    run(ti.do_create_character('{"playerName":"P"}', owner=owner))
    return [f for f in ep.failures(owner) if f["callClass"] == "cast-coherence"]


def test_the_record_names_the_fields_and_the_action_per_houseguest(run, monkeypatch):
    """ORW-145: the 11-06 prod record carried only ids, so nobody could tell what was incoherent."""
    import json
    fails = _create_with(monkeypatch, run, _coherence_with_fields(), "dora")
    assert len(fails) == 1
    detail = json.loads(fails[0]["detail"])
    assert detail["repaired"] == 1 and detail["floored"] == 1
    by_id = {h["id"]: h for h in detail["houseguests"]}
    assert by_id["npc:1"] == {"id": "npc:1", "action": "repaired", "fields": ["biography"]}
    assert by_id["npc:2"] == {"id": "npc:2", "action": "floored", "fields": ["appearance", "demeanor"]}
    assert "floored 1" in fails[0]["reason"]


def test_a_floored_only_start_is_still_recorded(run, monkeypatch):
    """A houseguest whose contradiction survived the repair is FLOORED (its prose stripped), the worse
    outcome. With repaired == 0 the old wiring recorded nothing at all."""
    import json
    coherence = {"repaired": 0, "floored": 1,
                 "houseguests": [{"id": "npc:3", "action": "floored", "fields": ["biography"]}]}
    fails = _create_with(monkeypatch, run, coherence, "erin")
    assert len(fails) == 1, "a floored houseguest must reach the health rollup"
    detail = json.loads(fails[0]["detail"])
    assert detail["houseguests"] == [{"id": "npc:3", "action": "floored", "fields": ["biography"]}]


def test_the_record_never_carries_anything_but_ids_actions_and_field_names(run, monkeypatch):
    """Vault-free: an unexpected key in the engine's per-houseguest entry is not copied into the record."""
    import json
    coherence = {"repaired": 1, "houseguests": [
        {"id": "npc:1", "action": "repaired", "fields": ["biography"], "prose": "SECRET PROSE"}]}
    fails = _create_with(monkeypatch, run, coherence, "fern")
    assert "SECRET PROSE" not in fails[0]["detail"]
    assert json.loads(fails[0]["detail"])["houseguests"][0] == {
        "id": "npc:1", "action": "repaired", "fields": ["biography"]}
