"""ORW-1168: the escort reader, the commit (accepted and declined), and the narrated-move belt's rule for an invitation that names nobody. Roles only; no model."""
import asyncio
import importlib

af = importlib.import_module("src.act_first")
pm = importlib.import_module("src.orwell_player_move")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

ROSTER = {"npc:a": "Alpha Role", "npc:b": "Bravo Role", "npc:c": "Charlie Role"}
CTX = {"room_names": {}, "here": "backyard", "rooms": list(al._HOUSE_ROOMS), "roster": ROSTER, "recent_ids": ["npc:a", "npc:c"], "addressee": "npc:b"}


def test_a_pronoun_invite_names_the_last_houseguest_spoken_of_and_the_last_room():
    got = af.escort_intent("Why dont we go inside and invite her outside?", CTX)
    assert got == {"id": "npc:a", "name": "Alpha Role", "room": "backyard"}


def test_an_unnamed_come_with_is_for_the_one_just_addressed_and_the_named_person_is_where_they_go():
    got = af.escort_intent("Yeah, I wanted to join Charlie outside, do you wanna come with? Chat on the way?", CTX)
    assert got == {"id": "npc:b", "name": "Bravo Role", "room": "backyard"}


def test_a_named_invite_and_a_bring():
    assert af.escort_intent("Bravo, come with me to the kitchen", CTX)["id"] == "npc:b"
    assert af.escort_intent("bring Charlie out to the yard", CTX)["id"] == "npc:c"


def test_no_escort_without_a_place_or_when_hedged_or_refused():
    assert af.escort_intent("do you wanna come with?", CTX) is None
    assert af.escort_intent("what if I invite her outside", CTX) is None
    assert af.escort_intent("I will not invite her outside", CTX) is None
    assert af.escort_intent("I grab a bed in the kitchen", CTX) is None


class FakeEngine:
    def __init__(self, outcome):
        self.outcome = outcome
        self.asked = []
        self.room = "kitchen"

    async def get_game_state(self, user=None):
        return {"started": True, "house": [{"id": i, "name": n, "status": "active"} for i, n in ROSTER.items()]}

    async def game_status(self, user=None):
        return {}

    async def whereabouts(self, user=None, **kw):
        return {"room": self.room, "present": [{"id": "npc:b", "name": "Bravo Role"}], "roomNames": {}}

    async def ask_to_talk_alone(self, npc, room=None, private=None, expected_beat_seq=None, user=None):
        self.asked.append((npc, room, private))
        return {"outcome": self.outcome, "room": room}


def _commit(outcome, monkeypatch):
    eng = FakeEngine(outcome)
    moved = []

    async def fake_move(content, owner=None):
        import json
        moved.append(json.loads(content)["room"])
        return {"output": content, "exit_code": 0}
    ti = importlib.import_module("src.tool_implementations")
    monkeypatch.setattr(ti, "do_move_to", fake_move)
    pay = asyncio.run(pm.escort_before_narrator("Yeah, do you wanna come outside with me? Chat on the way?", "u-1168", "m1", previous_reply="@[Bravo Role] Got a minute?", engine=eng))
    return eng, moved, pay


def test_an_accepted_escort_moves_her_then_the_player_and_tells_the_narrator(monkeypatch):
    eng, moved, pay = _commit("accepted", monkeypatch)
    assert eng.asked == [("npc:b", "backyard", False)] and moved == ["backyard"]
    assert pay["committed"] and any("AGREED" in n for n in pay["notes"]) and pm.escort_declined_ids("u-1168") == set()


def test_a_declined_escort_still_moves_the_player_and_the_narrator_is_told_she_stayed(monkeypatch):
    eng, moved, pay = _commit("declined", monkeypatch)
    assert moved == ["backyard"]
    assert any("did NOT come" in n and "saying no" in n for n in pay["notes"])
    assert pm.escort_declined_ids("u-1168") == {"npc:b"}


def test_the_belt_honours_an_unnamed_invite_but_never_over_a_decline():
    assert al._player_invited_unnamed("Why dont we go inside and invite her outside?", ROSTER)
    assert not al._player_invited_unnamed("Why dont we go inside and invite Alpha outside?", ROSTER)
    assert not al._player_invited_unnamed("I walk to the kitchen", ROSTER)


def test_the_belt_drops_a_narrated_arrival_the_engine_declined_and_regrounds(monkeypatch):
    ch = importlib.import_module("routes.chat_helpers")
    moves = []

    async def whereabouts(user=None, **kw):
        return {"room": "backyard", "present": []}

    async def move_houseguest(hid, room, user=None):
        moves.append((hid, room))
        return {"status": "moved"}
    monkeypatch.setattr(oe, "whereabouts", whereabouts)
    monkeypatch.setattr(oe, "move_houseguest", move_houseguest)
    queued = []
    monkeypatch.setattr(ch, "_reground_enqueue", lambda k, d: queued.append(d) or True)
    house = [{"id": i, "name": n} for i, n in ROSTER.items()]
    raw = '{"moves":[{"id":"npc:a","room":"backyard"}]}'
    narration = "@[Alpha Role] Fine, let's go.\n\nShe walks out to the pool deck."

    # accepted by the unnamed-invite rule
    n = asyncio.run(al._auto_move_npc(narration, "Why dont we go inside and invite her outside?", house, "", "", {}, "u-belt", raw=raw))
    assert n == 1 and moves == [("npc:a", "backyard")]
    # an arrival nobody asked for is dropped, and the contradiction is queued for the next turn
    moves.clear()
    n = asyncio.run(al._auto_move_npc(narration, "I look around the yard.", house, "", "", {}, "u-belt", raw=raw))
    assert n == 0 and moves == [] and queued and "RE-GROUND ON WHO CAME" in queued[-1]
    # the engine said no to this escort: the narration cannot move her over it
    pm._ESCORT_DECLINED["u-belt"] = {"npc:a"}
    n = asyncio.run(al._auto_move_npc(narration, "Why dont we go inside and invite her outside?", house, "", "", {}, "u-belt", raw=raw))
    assert n == 0 and moves == []
