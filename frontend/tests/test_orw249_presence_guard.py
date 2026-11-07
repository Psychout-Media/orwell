"""ORW-249 item 2: the presence wall, generalised to the hard roster. Before: only OFF-SCENE (across the house) and EVICTED houseguests staged in the player's scene were dropped; a houseguest in an ADJACENT room counted as
"in view" and could be staged speaking and acting in the player's room freely - the way the narrator kept putting absent people in the scene (6 off-scene drops in 5 messages on prod). Now anyone not in the player's room who is staged
speaking or acting IN the scene is dropped, except the glimpse/overhear framed as the other room. Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


STATE = {
    "whereabouts": {
        "room": "kitchen",
        "present": [{"id": "npc:1", "name": "Alice Hart"}, {"id": "npc:2", "name": "Bruno Lane"}],
        "nearby": [{"room": "backyard", "present": [{"id": "npc:3", "name": "Cleo Park"}]}],
    },
    "house": [{"name": "Alice Hart", "status": "active"}, {"name": "Bruno Lane", "status": "active"},
              {"name": "Cleo Park", "status": "active"}, {"name": "Dana Moss", "status": "active"}],
}


def _wall(monkeypatch, text):
    async def fake_state(user=None, **k):
        return STATE
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    return _run(ch.screen_presence_wall("u249", text))


def test_an_adjacent_room_houseguest_staged_speaking_in_the_scene_is_dropped(monkeypatch):
    out = _wall(monkeypatch, "Alice slides a mug across. Cleo leans on the counter and says, \"You two look serious.\" Bruno shrugs.")
    assert "Cleo" not in out, out
    assert "Alice slides a mug" in out and "Bruno shrugs" in out


def test_a_quoted_line_from_an_adjacent_houseguest_is_dropped(monkeypatch):
    out = _wall(monkeypatch, "Cleo: \"Mind if I join?\" Alice nods.")
    assert "Cleo" not in out and "Alice nods" in out


def test_an_overheard_glimpse_framed_as_the_other_room_is_kept(monkeypatch):
    text = "Through the open door you hear Cleo laughing out in the backyard. Alice rolls her eyes."
    assert _wall(monkeypatch, text) == text
    text2 = "From next door, Cleo's voice drifts through the wall. Bruno looks up."
    assert _wall(monkeypatch, text2) == text2


def test_the_people_in_the_room_are_never_touched(monkeypatch):
    text = "Alice grins and says, \"Told you.\" Bruno leans back and laughs."
    assert _wall(monkeypatch, text) == text


def test_across_the_house_still_dropped_as_before(monkeypatch):
    out = _wall(monkeypatch, "Dana leans in the doorway. Dana: \"Everyone here?\" Alice looks up.")
    assert "Dana" not in out and "Alice looks up" in out
