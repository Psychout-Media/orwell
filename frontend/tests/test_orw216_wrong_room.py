"""ORW-216: a houseguest the narrator PLACES IN THE WRONG ROOM (the prod miss: two houseguests "walking the yard" while the engine had them in the kitchen, then an out-of-character fix). The presence wall
already drops OFF-SCENE / adjacent / evicted houseguests staged in the player's scene, and the ADR 0009 pre-emission guard holds an EVICTED houseguest placed in a room; neither checks an in-view houseguest
against the room the engine has them in. This adds the post-turn, closed-set, next-turn re-ground (never edits prose, ADR 0005 #1) that also asks for an IN-CHARACTER correction. Pure: no model. Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")

STATE = {
    "whereabouts": {
        "room": "kitchen",
        "present": [{"id": "npc:1", "name": "Alice Hart"}, {"id": "npc:2", "name": "Bruno Lane"}],
        "nearby": [{"room": "backyard", "present": [{"id": "npc:3", "name": "Cleo Park"}]}],
    },
    "house": [{"name": "Alice Hart", "status": "active"}, {"name": "Bruno Lane", "status": "active"},
              {"name": "Cleo Park", "status": "active"}, {"name": "Dana Moss", "status": "active"}],
}
ROOMS = {"Alice Hart": "kitchen", "Bruno Lane": "kitchen", "Cleo Park": "backyard"}


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def test_the_facts_carry_the_known_rooms():
    f = ch._presence_facts(STATE)
    assert f["npc_rooms"] == ROOMS


def test_the_prod_miss_two_in_the_kitchen_walking_the_yard_is_flagged():
    hits = ch._wrong_room_claims("Alice Hart strolls the yard while Bruno Lane wanders along the fence.", ROOMS)
    assert [n for n, _ in hits] == ["Alice Hart"] or [n for n, _ in hits] == ["Alice Hart", "Bruno Lane"]
    assert all(r == "kitchen" for _, r in hits)
    assert [n for n, _ in ch._wrong_room_claims("Natalia says Axel and Bruno Lane were walking the yard together.", ROOMS)] == ["Bruno Lane"]
    both = ch._wrong_room_claims("Alice Hart strolls the yard. Bruno Lane wanders the yard too.", ROOMS)
    assert sorted(n for n, _ in both) == ["Alice Hart", "Bruno Lane"] and all(r == "kitchen" for _, r in both)


def test_the_right_room_a_mention_without_a_room_and_an_aside_are_not_flagged():
    assert ch._wrong_room_claims("Alice Hart leans on the kitchen counter.", ROOMS) == []
    assert ch._wrong_room_claims("Bruno Lane shrugs and says nothing.", ROOMS) == []
    assert ch._wrong_room_claims("((Production: Bruno Lane is in the yard.))", ROOMS) == []
    # a sentence naming both the real and another room (a move that crosses) is left alone
    assert ch._wrong_room_claims("Alice Hart walks from the kitchen out to the yard.", ROOMS) == []
    # someone whose room is unknown (not in view) is never judged
    assert ch._wrong_room_claims("Dana Moss walks the yard.", ROOMS) == []


def _check(monkeypatch, text, key):
    async def fake_state(user=None, **k):
        return STATE
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    ch._DESYNC_REGROUND.pop(ch._desync_key(key), None)
    _run(ch.record_post_turn_wrong_room_check(key, text))
    return ch._DESYNC_REGROUND.get(ch._desync_key(key))


def test_a_wrong_room_placement_queues_an_in_character_reground(monkeypatch):
    got = _check(monkeypatch, "Bruno Lane strolls the yard, whistling.", "u216a")
    assert got and "Bruno Lane is in the kitchen" in got and "IN CHARACTER" in got
    assert "Alice" not in got


def test_a_correct_scene_queues_nothing(monkeypatch):
    assert _check(monkeypatch, "Bruno Lane sits at the kitchen island and eats.", "u216b") is None


def test_someone_who_departed_since_the_send_is_exempt(monkeypatch):
    st = {**STATE, "whereabouts": {**STATE["whereabouts"], "sinceSend": {"departed": ["Bruno Lane"], "arrived": []}}}

    async def fake_state(user=None, **k):
        return st
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    ch._DESYNC_REGROUND.pop(ch._desync_key("u216c"), None)
    _run(ch.record_post_turn_wrong_room_check("u216c", "Bruno Lane strolls the yard, whistling."))
    assert ch._DESYNC_REGROUND.get(ch._desync_key("u216c")) is None


def test_the_check_is_wired_into_the_post_turn_path():
    src = importlib.import_module("src.agent_loop")
    import inspect
    text = inspect.getsource(src)
    assert "record_post_turn_wrong_room_check(owner, _turn_narration_full)" in text
