"""ORW-1076: a refused move reaches the narrator with its reason. Roles only."""
from routes import chat_helpers as ch


def test_a_refused_move_is_told_with_its_reason():
    wa = {"room": "living-room", "present": []}
    out = ch._whereabouts_barrier_directive(wa, [], {"refused": True, "reason": "the player knocked and Ana did not let them in", "from": "living-room", "to": "hoh-room"})
    assert "THE PLAYER DID NOT MOVE" in out and "did not let them in" in out
    assert "THE PLAYER DID NOT MOVE" not in ch._whereabouts_barrier_directive(wa, [], None)
