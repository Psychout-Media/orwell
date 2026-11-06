"""ORW-210: MENTIONING a houseguest must never pull them into the room (ADR 0009 D2 belt amended).

Ryne's playtest case: the player NAMES an absent houseguest; the narrator writes their entrance; the
`_auto_move_npc` belt used to relay that as a real engine move, so they appeared and reacted as if they
had heard. The belt now drops an arrival into the PLAYER'S room unless the player's message actually
asked that houseguest to come. Moves elsewhere in the house, and an explicit summons, still land.

SYNC tests only - drive coroutines via run_until_complete.
"""
import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")

_HOUSE = [{"id": "npc:1", "name": "Axel Stone"}, {"id": "npc:2", "name": "Bea Park"}]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _wire(monkeypatch, extraction_json, calls, player_room="kitchen"):
    async def fake_llm(*a, **k):
        return extraction_json

    async def fake_move(houseguest_id, room, user=None):
        calls.append((houseguest_id, room))
        return {"status": "moved", "whereabouts": {"room": room, "present": [], "nearby": []}}

    async def fake_whereabouts(user=None):
        return {"room": player_room, "present": [], "nearby": []}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "move_houseguest", fake_move)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_whereabouts)


def test_naming_an_absent_houseguest_does_not_pull_them_in(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"kitchen"}]}', calls)
    out = _run(al._auto_move_npc("Axel strolls in, grinning, having overheard.",
                                 "I wonder what Axel thinks of the vote.", _HOUSE, "u", "m", {}, "o"))
    assert out == 0 and calls == [], "mentioning Axel must leave him where he is"


def test_an_explicit_summons_still_moves_them(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"kitchen"}]}', calls)
    out = _run(al._auto_move_npc("Axel wanders over.", "Go get Axel and bring him to the kitchen.",
                                 _HOUSE, "u", "m", {}, "o"))
    assert out == 1 and calls == [("npc:1", "kitchen")]


def test_a_move_elsewhere_in_the_house_still_lands(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:2","room":"backyard"}]}', calls)
    out = _run(al._auto_move_npc("Bea heads out back.", "I keep cooking.", _HOUSE, "u", "m", {}, "o"))
    assert out == 1 and calls == [("npc:2", "backyard")]


def test_player_summoned_matcher():
    assert al._player_summoned("Can you ask Axel to come over?", "Axel Stone")
    assert not al._player_summoned("I wonder about Axel.", "Axel Stone")
    assert not al._player_summoned("come here", "Axel Stone")
