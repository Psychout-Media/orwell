"""ORW-1077: the presence wall does not cut the exit of a houseguest who walked out because the player came in. Roles only."""
from routes import chat_helpers as ch
from test_a2_presence_wall import _house, _state


def test_the_one_who_left_is_exempt_on_that_turn_only():
    board = _state("living-room", present=["Ana Reed"], house=_house(active=["Ana Reed", "Bo Lane"]))
    assert "Bo Lane" not in ch._presence_facts(board)["exempt"]
    walked = dict(board, walkedIn={"room": "living-room", "reactions": [{"name": "Bo Lane", "line": "makes an excuse", "left": True}, {"name": "Ana Reed", "line": "carries on"}]})
    facts = ch._presence_facts(walked)
    assert "Bo Lane" in facts["exempt"] and "Ana Reed" not in facts["exempt"]
