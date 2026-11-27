"""ORW-934: the engine walked the player's search for a houseguest; the narrator is handed the legs and told to voice one passage and invent nothing."""
from routes.chat_helpers import _player_search_directive


def test_directive_lists_the_legs_in_order_and_the_outcome():
    d = _player_search_directive({
        "target": {"id": "n1", "name": "Robert"}, "outcome": "found", "reason": "found Robert in the bedroom a", "minutes": 6,
        "legs": [{"room": "hallway", "roomName": "hallway", "present": []},
                 {"room": "bedroom-a", "roomName": "bedroom A", "present": [{"id": "n1", "name": "Robert"}]}],
    })
    assert d and "PLAYER SEARCH" in d
    assert d.index("1. the hallway: nobody there") < d.index("2. the bedroom A: Robert there")
    assert "found" in d and "about 6 minutes" in d
    assert "Invent no sighting" in d


def test_no_search_no_directive():
    assert _player_search_directive(None) is None
    assert _player_search_directive("x") is None
