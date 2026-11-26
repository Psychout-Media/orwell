"""ORW-1003: the narration placed the player in a room they never went to; the engine kept their real room, so the player read the wrong one. BEHAVIOURAL on the presence guard with a stubbed board.
Roles only: the engine has the player in the living room.
"""
import asyncio

import pytest

from routes import chat_helpers
from test_a2_presence_wall import _async, _house, _state

_BOARD = _state("living-room", present=["Ana Reed"], house=_house(active=["Ana Reed"]))


def _wall(monkeypatch, text):
    from src import orwell_engine
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(_BOARD))
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(chat_helpers.screen_presence_wall("orw1003", text))
    finally:
        loop.close()


@pytest.mark.parametrize("sentence", [
    "You drift into the bathroom, the tiles cold.",
    "You're back in the kitchen now.",
    "You find yourself alone in the storage room.",
    "You follow her out into the backyard.",
])
def test_a_sentence_putting_the_player_elsewhere_is_dropped(monkeypatch, sentence):
    out = _wall(monkeypatch, sentence + " Ana Reed looks up.")
    assert sentence not in out and "Ana Reed looks up." in out


@pytest.mark.parametrize("sentence", [
    "You sink deeper into the couch in the living room.",
    "You could go to the kitchen if you wanted.",
    "Do you walk into the bathroom?",
    'Ana Reed says, "You walk into that kitchen and they pounce."',
    "You hear laughter from the kitchen.",
])
def test_nothing_else_is_touched(monkeypatch, sentence):
    assert sentence in _wall(monkeypatch, sentence)
