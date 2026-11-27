"""ORW-1030: a houseguest who agrees to walk with the player stays with the player as an ENGINE fact until the player ends it. Driven through the real update/enforce hooks against a fake
engine whose presence drifts the companion away between turns (the prod fault: vanished or swapped for another within a turn). Also: the narrated-move belt no longer drops a companion's
arrival into the player's room as 'unrequested'. Roles only."""
import asyncio
import importlib

import pytest

oc = importlib.import_module("src.orwell_companions")
oe = importlib.import_module("src.orwell_engine")
al = importlib.import_module("src.agent_loop")

USER = "u-orw1030"
CAST = {"npc:a": "Alpha Role", "npc:b": "Bravo Role", "npc:c": "Charlie Role"}


class FakeHouse:
    def __init__(self):
        self.player = "kitchen"
        self.where = {"npc:a": "kitchen", "npc:b": "kitchen", "npc:c": "lounge"}
        self.moves = []

    async def whereabouts(self, user=None, **kw):
        return {"room": self.player, "present": [{"id": i, "name": CAST[i]} for i, r in self.where.items() if r == self.player]}

    async def move_houseguest(self, hid, room, user=None):
        self.moves.append((hid, room))
        if self.where.get(hid) == room:
            return {"status": "noop"}
        self.where[hid] = room
        return {"status": "moved", "beatSeq": 9}


@pytest.fixture
def house(monkeypatch):
    h = FakeHouse()
    monkeypatch.setattr(oe, "whereabouts", h.whereabouts)
    monkeypatch.setattr(oe, "move_houseguest", h.move_houseguest)
    oc.clear(USER)
    yield h
    oc.clear(USER)


def _run(c):
    return asyncio.run(c)


def test_an_agreed_companion_survives_engine_drift_and_the_player_moving(house):
    _run(oc.update(USER, "Alpha, come with me to the lounge", "Alpha nods and falls in beside you."))
    assert list(oc.companions_of(USER)) == ["npc:a"]
    house.player = "lounge"; house.where["npc:b"] = "lounge"   # the player walks; the engine's drift left the companion behind and put another houseguest in
    house.where["npc:a"] = "kitchen"
    assert _run(oc.enforce(USER)) == 1
    assert house.where["npc:a"] == "lounge" and ("npc:a", "lounge") in house.moves
    assert "Alpha Role" in oc.steer_line(USER) and "Bravo" not in oc.steer_line(USER)


def test_only_the_named_houseguest_is_registered(house):
    _run(oc.update(USER, "I'll go with just Alpha", "Alpha grins; Bravo waves you off."))
    assert list(oc.companions_of(USER)) == ["npc:a"]


def test_a_refusal_in_the_narration_registers_nobody(house):
    _run(oc.update(USER, "Alpha, walk with me", "Alpha declines, not now."))
    assert oc.companions_of(USER) == {}


def test_the_player_ends_it_and_only_then(house):
    _run(oc.update(USER, "Alpha and Bravo, come with me", "Alpha and Bravo follow."))
    assert set(oc.companions_of(USER)) == {"npc:a", "npc:b"}
    _run(oc.update(USER, "what a day", "You talk."))
    assert set(oc.companions_of(USER)) == {"npc:a", "npc:b"}, "a plain turn never ends a companion"
    _run(oc.update(USER, "Bravo, you stay here", "Bravo stays."))
    assert set(oc.companions_of(USER)) == {"npc:a"}
    _run(oc.update(USER, "I'll go alone now", "You head off."))
    assert oc.companions_of(USER) == {}
    assert oc.steer_line(USER) == ""


def test_control_without_a_companion_the_drifted_houseguest_is_not_reseated(house):
    house.where["npc:a"] = "lounge"
    assert _run(oc.enforce(USER)) == 0 and house.moves == []


def test_the_narrated_move_belt_keeps_a_companions_arrival_in_the_players_room(monkeypatch, house):
    oc._COMPANIONS[USER] = {"npc:a": "Alpha Role"}
    assert al._companion_ids(USER) == {"npc:a"}
    src = open(al.__file__, encoding="utf-8").read()
    assert "hid not in _companion_ids(owner)" in src
