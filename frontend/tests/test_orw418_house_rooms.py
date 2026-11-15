"""ORW-418 (Ryne: "the narrator locks me in a room"): the front end's move belts offered 9 of the engine's 13 rooms, so the hallway, lounge, dining room and bedroom C
were unreachable, and "lounge" was told to mean the living room. The belts now read the engine's own room list."""
import os
import re

import pytest

from src import agent_loop as al
from src import house_rooms as hr

ENGINE_TS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "src", "domain", "house.ts")
MISSING = ["hallway", "lounge", "dining-room", "bedroom-c"]


def _engine_rooms():
    m = re.search(r"export const HOUSE_ROOMS: readonly Room\[\] = \[(.*?)\];", open(ENGINE_TS, encoding="utf-8").read(), re.S)
    return re.findall(r'"([a-z-]+)"', m.group(1))


def test_the_belt_list_is_the_engines_list():
    if os.path.exists(ENGINE_TS):  # a frontend-only checkout has no engine source (house_rooms.py carries a _FALLBACK for that layout)
        assert list(al._HOUSE_ROOMS) == _engine_rooms()
    assert len(al._HOUSE_ROOMS) == 13


@pytest.mark.skipif(not os.path.exists(ENGINE_TS), reason="a frontend-only checkout has no engine source to compare the fallback with")  # review of #2751; CI checks out the whole repo and runs it
def test_the_vendored_fallback_has_not_drifted_from_the_engine():
    assert list(hr._FALLBACK) == _engine_rooms()


@pytest.mark.parametrize("room", MISSING)
def test_each_formerly_unreachable_room_is_offered_and_accepted(room):
    assert room in al._HOUSE_ROOMS
    assert room in al._player_move_instructions()
    assert room in al._npc_move_instructions()


def test_lounge_is_its_own_room_not_the_living_room():
    for text in (al._player_move_instructions(), al._npc_move_instructions()):
        assert '"lounge"/"couch" → living-room' not in text
        assert "lounge" in text
