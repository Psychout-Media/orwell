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


# ── part (4): the guard reads the SAME send-time snapshot the narrator is handed (whereabouts.sinceSend, #2321) ──
def _wall_state(monkeypatch, text, since):
    state = dict(STATE, whereabouts=dict(STATE["whereabouts"], sinceSend=since))

    async def fake_state(user=None, **k):
        return state
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    return _run(ch.screen_presence_wall("u249b", text))


def test_someone_who_left_since_the_send_is_staged_in_their_departure_beat_not_dropped(monkeypatch):
    # Cleo is now next door (backyard), but she walked out AFTER the player's last message - the narrator is told to voice it, so the guard must not eat it.
    text = "Cleo leans on the counter, says, \"I'm out of here,\" and strides off. Alice shrugs."
    assert _wall_state(monkeypatch, text, {"arrived": [], "departed": ["Cleo Park"]}) == text


def test_the_same_line_without_the_snapshot_is_still_dropped(monkeypatch):
    text = "Cleo leans on the counter, says, \"I'm out of here,\" and strides off. Alice shrugs."
    out = _wall_state(monkeypatch, text, {"arrived": [], "departed": []})
    assert "Cleo" not in out and "Alice shrugs" in out


def test_the_facts_carry_the_snapshot_names():
    facts = ch._presence_facts(dict(STATE, whereabouts=dict(STATE["whereabouts"], sinceSend={"arrived": ["Bruno Lane"], "departed": ["Cleo Park"]})))
    assert facts["exempt"] == {"Bruno Lane", "Cleo Park"}
