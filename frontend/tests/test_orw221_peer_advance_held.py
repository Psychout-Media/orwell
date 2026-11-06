"""ORW-221: while production holds a scheduled event the model is framed on the held `social` moment, but the raw engine moment is what the loop reads back. That mismatch flagged a false
"ADR0011 peer-advance" on every held turn (32 times) and reset the stall ladder. Held must be compared against held. Roles only."""
import importlib

al = importlib.import_module("src.agent_loop")
peer = al._peer_advanced_since_framing


def test_a_held_turn_is_not_a_peer_advance_when_only_the_moment_differs():
    framed = (1, "hoh-competition", "social")      # held: the framing overrode the moment to `social`
    raw_now = (1, "hoh-competition", "hoh-competition")  # the raw engine moment read back this turn
    assert peer(False, framed, raw_now) is False


def test_a_held_turn_with_an_open_pending_is_not_a_peer_advance_either():
    framed = (1, "hoh-competition", "social", "comp-intent")
    raw_now = (1, "hoh-competition", "hoh-competition")
    assert peer(False, framed, raw_now, "comp-intent") is False


def test_a_real_peer_move_during_a_hold_is_still_detected():
    """A phase / week change (or a resolved pending) under a held framing is still a peer advance."""
    framed = (1, "hoh-competition", "social")
    assert peer(False, framed, (1, "nominations", "nominations")) is True
    assert peer(False, framed, (2, "hoh-competition", "hoh-competition")) is True
    assert peer(False, (1, "hoh-competition", "social", "comp-intent"), (1, "hoh-competition", "hoh-competition"), None) is True


def test_the_unheld_contract_is_unchanged():
    assert peer(False, (1, "hoh-competition", "hoh-competition"), (1, "hoh-competition", "hoh-competition")) is False
    assert peer(False, (1, "hoh-competition", "hoh-competition"), (1, "nominations", "nominations")) is True
    assert peer(True, (1, "a", "social"), (1, "b", "b")) is False  # this turn progressed itself
    assert peer(False, None, (1, "a", "b")) is False
    assert peer(False, (1, "a", "social"), None) is False
