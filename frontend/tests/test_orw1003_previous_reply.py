"""ORW-1003: the previous reply reaches the engine's intent-first move, so "head over there" and "I follow her" can be resolved. Roles only."""
import asyncio

from src import orwell_player_move


class _Engine:
    def __init__(self):
        self.calls = []

    async def resolve_player_move(self, text, key, user=None, **extra):
        self.calls.append((text, extra))
        return {"playerMove": None}


def test_the_previous_reply_is_passed_on():
    eng = _Engine()
    asyncio.new_event_loop().run_until_complete(
        orwell_player_move.resolve_player_move_before_narrator("I follow them.", "u", "m1", engine=eng, previous_reply="A houseguest heads out."))
    assert eng.calls == [("I follow them.", {"previous_reply": "A houseguest heads out."})]


def test_without_one_the_call_is_as_before():
    eng = _Engine()
    asyncio.new_event_loop().run_until_complete(orwell_player_move.resolve_player_move_before_narrator("I go to the kitchen.", "u", "m2", engine=eng))
    assert eng.calls == [("I go to the kitchen.", {})]
