"""ORW-1038: the engine's intent parser moves the player before the narrator, then the post-reply move belt could write a second move from the narration over it (the later writer won). Once the engine
moved or refused the player's own words, the belt stands down for that turn. BEHAVIOURAL: the real agent loop, scripted model, stubbed extraction and engine. Roles only.
"""
import asyncio

from src import agent_loop as al
from src import orwell_player_move
from test_orw310_bedtime_belt import _drive


class _Engine:
    def __init__(self, move):
        self.move = move

    async def resolve_player_move(self, text, key, user=None, **extra):
        return {"playerMove": self.move}


def _run(monkeypatch, engine_move):
    moves = []
    from src import orwell_engine as oe

    async def fake_move(room, user=None, **k):
        moves.append(room)
        return {"ok": True}

    async def fake_extract(*a, **k):
        return '{"room":"backyard"}'

    monkeypatch.setattr(oe, "move_to", fake_move)
    monkeypatch.setattr(al, "_move_player_extract", fake_extract)
    text = "I go to the kitchen."
    asyncio.new_event_loop().run_until_complete(orwell_player_move.resolve_player_move_before_narrator(text, "orw310", "m1", engine=_Engine(engine_move)))
    _drive(monkeypatch, text=text, scripts=[{"deltas": ["You step out into the backyard."]}], status={"started": True, "phase": "social", "timeOfDay": "evening", "pending": None})
    return moves


def test_the_belt_stands_down_when_the_engine_moved(monkeypatch):
    assert _run(monkeypatch, {"from": "living-room", "to": "kitchen"}) == []


def test_the_belt_stands_down_when_the_engine_refused(monkeypatch):
    assert _run(monkeypatch, {"refused": True, "reason": "the house is gathered"}) == []


def test_the_belt_still_follows_when_the_engine_read_no_move(monkeypatch):
    assert _run(monkeypatch, None) == ["backyard"]
