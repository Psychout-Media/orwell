"""ORW-328 - a houseguest who talked to the player and then walked out of the room in the same narration is still a WITNESS of the scene.

The NPC move belt relocates them first; the scene belt's presence check then read the post-move board, called the only participant
"off-scene", dropped the record, and the E22 guard logged a fallback for a real talk turn. Stubbed engine and llm, roles only.
"""
import asyncio
import importlib
import json

import pytest

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")
fl = importlib.import_module("src.fold_ledger")

ROSTER = [{"id": f"npc:{n}", "name": f"Houseguest {n}"} for n in range(1, 5)]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    fl.clear_all()
    yield
    fl.clear_all()


def _stub(monkeypatch, *, present, moved_status="moved"):
    writes = []
    monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

    async def whereabouts(user=None):
        return {"room": "bedroom-a", "present": [{"id": i} for i in present]}

    async def state(owner=None, **k):
        return {"asleep": [], "pending": None}

    async def move(hid, room, user=None):
        return {"status": moved_status}

    async def backfill(owner, fn, *args, **kw):
        writes.append(args)
        return {"ok": True}

    monkeypatch.setattr(oe, "whereabouts", whereabouts)
    monkeypatch.setattr(oe, "get_game_state", state)
    monkeypatch.setattr(oe, "move_houseguest", move)
    monkeypatch.setattr(al, "_backfill_with_cas", backfill)
    monkeypatch.setattr(al, "_note_belt", lambda *a, **k: None)

    async def nogate(*a, **k):
        return None
    monkeypatch.setattr(al, "_scene_check_gate", nogate)
    return writes


SCENE = json.dumps({"withIds": ["npc:1"], "kind": "strategy", "content": "They traded reads on the week.", "feltMinutes": 30})


def _record():
    return _run(al._auto_record_scene("They talked.", "I ask for their read.", ROSTER, "http://x", "m", {}, "o", raw=SCENE))


def test_participant_who_walked_out_of_the_room_still_records(monkeypatch):
    writes = _stub(monkeypatch, present=["npc:2"])  # the board AFTER the move: npc:1 is elsewhere
    fl.note_walked_out("o", {"npc:1"})
    assert _record() is True and len(writes) == 1


def test_without_the_hint_an_off_scene_participant_is_still_dropped(monkeypatch):
    writes = _stub(monkeypatch, present=["npc:2"])
    assert _record() is False and writes == []


def test_hint_is_consumed_once_and_expires(monkeypatch):
    _stub(monkeypatch, present=["npc:2"])
    fl.note_walked_out("o", {"npc:1"})
    assert fl.consume_walked_out("o") == {"npc:1"}
    assert fl.consume_walked_out("o") == set()
    fl.note_walked_out("o", {"npc:1"})
    monkeypatch.setattr(fl, "_WALKED_OUT_TTL_S", -1.0)
    assert fl.consume_walked_out("o") == set()


def test_move_belt_notes_only_those_who_shared_the_room(monkeypatch):
    _stub(monkeypatch, present=["npc:1"])
    raw = json.dumps({"moves": [{"id": "npc:1", "room": "kitchen"}, {"id": "npc:3", "room": "kitchen"}]})
    n = _run(al._auto_move_npc("They left.", "hello", ROSTER, "http://x", "m", {}, "o", raw=raw))
    assert n == 2
    assert fl.consume_walked_out("o") == {"npc:1"}  # npc:3 was never in the room, so it is not a witness


def test_a_turn_with_no_moves_clears_a_stale_hint(monkeypatch):
    _stub(monkeypatch, present=["npc:1"])
    fl.note_walked_out("o", {"npc:1"})
    _run(al._auto_move_npc("Nothing moved.", "hello", ROSTER, "http://x", "m", {}, "o", raw=json.dumps({"moves": []})))
    assert fl.consume_walked_out("o") == set()
