"""ORW-1167: a confidence said to one houseguest was folded as witnessed by three others the narration had put out of earshot.

The engine seats each houseguest in a zone of a big room (the yard); a person in another zone is seen, never heard, and the engine now marks them `outOfEarshot` in `whereabouts.present`.
The scene fold, the promise back-fill and the presence wall all read that mark: the witnesses of a confidence are the people in the conversation within earshot, never every name in the room, and
a houseguest out of earshot does not speak into the player's end of the room. Roles only; the extraction model is faked, nothing is spent.
"""
import asyncio
import importlib

import pytest

from src import agent_loop as al

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")

HOUSE = [{"id": "npc:10", "name": "Confidant One"}, {"id": "npc:11", "name": "Far Bystander"},
         {"id": "npc:12", "name": "Near Bystander"}, {"id": "npc:15", "name": "Far Walker"}]
PRESENT = [{"id": "npc:12", "name": "Near Bystander"},
           {"id": "npc:11", "name": "Far Bystander", "outOfEarshot": True},
           {"id": "npc:15", "name": "Far Walker", "outOfEarshot": True}]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _drive(monkeypatch, extraction, present=PRESENT):
    cap = {}

    async def fake_llm(*a, **k):
        return extraction

    async def fake_record(content, with_ids=None, kind=None, consequence=None, expected_beat_seq=None, idempotency_key=None, felt_minutes=None, user=None):
        cap["with_ids"] = with_ids
        return {"recorded": True, "beatSeq": 2}

    async def fake_wb(user=None):
        return {"room": "backyard", "zone": "poolside", "present": present, "nearby": []}

    chat_helpers._LAST_BEAT_SEQ["owner"] = 1
    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "record_interaction", fake_record)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_wb)
    ok = _run(al._auto_record_scene("A vulnerable word at the pool.", "I am honest with you, and scared you will repeat it.", HOUSE, "http://x", "m", {}, "owner"))
    return ok, cap


def test_confidence_fold_names_only_who_is_in_earshot(monkeypatch):
    ok, cap = _drive(monkeypatch, '{"withIds":["npc:12","npc:11","npc:15"],"kind":"strategy","content":"the player confided a fear"}')
    assert ok is True
    assert cap["with_ids"] == ["npc:12"], f"the out-of-earshot houseguests joined the fold: {cap}"


def test_all_participants_out_of_earshot_folds_nothing(monkeypatch):
    ok, cap = _drive(monkeypatch, '{"withIds":["npc:11","npc:15"],"kind":"strategy","content":"the player confided a fear"}')
    assert ok is False
    assert "with_ids" not in cap


def test_promise_backfill_is_heard_only_in_earshot(monkeypatch):
    staged = {}

    async def fake_llm(*a, **k):
        return '{"withIds":["npc:12","npc:11"],"assurance":{"kind":"loyal"}}'

    async def fake_wb(user=None):
        return {"room": "backyard", "present": PRESENT, "nearby": []}

    async def fake_record(content, with_ids=None, **k):
        staged["with_ids"] = with_ids
        return {"recorded": True, "beatSeq": 2}

    from src import fold_ledger as fl
    monkeypatch.setattr(fl, "stage_pending_fold", lambda *a, **k: staged.update(with_ids=k.get("with_ids")) or True)
    chat_helpers._LAST_BEAT_SEQ["owner"] = 1
    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_wb)
    monkeypatch.setattr(orwell_engine, "record_interaction", fake_record)
    _run(al._auto_record_promise("I am with you, you have my word.", HOUSE, "http://x", "m", {}, "owner"))
    assert staged.get("with_ids") == ["npc:12"], staged


def test_scene_extraction_instruction_forbids_naming_the_whole_room():
    assert "never every name in the room" in al._SCENE_EXTRACT_INSTRUCTIONS
    assert "out of earshot" in al._SCENE_EXTRACT_INSTRUCTIONS


def _state():
    return {"whereabouts": {"room": "backyard", "present": PRESENT, "nearby": []},
            "house": [{"name": h["name"], "status": "active"} for h in HOUSE]}


def _wall(monkeypatch, text):
    async def gs(user=None):
        return _state()
    monkeypatch.setattr(orwell_engine, "get_game_state", gs)
    return _run(chat_helpers.screen_presence_wall("u-orw1167", text, carry={}))


def test_wall_drops_the_line_of_a_houseguest_out_of_earshot(monkeypatch):
    text = ('Far Walker has drifted off toward the pergola.\n\n@[Far Walker] — "Then I will say my piece." He steps closer.'
            '\n\n@[Near Bystander] — "Same here." She nods.')
    out = _wall(monkeypatch, text)
    assert "say my piece" not in out
    assert "drifted off toward the pergola" in out
    assert "Same here." in out


def test_wall_keeps_a_far_houseguest_described_but_not_speaking(monkeypatch):
    text = "Far Bystander and Far Walker have taken the far end of the deck, talking low."
    assert _wall(monkeypatch, text) == text
