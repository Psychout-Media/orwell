"""ORW-704 (the playtest where 4 of 15 entrances were never named and houseguests introduced themselves again and again). Roles only; the names are generated labels. The engine releases one arrival per advance but shows the
narrator only the latest, so an arrival a reply did not name (or one a second release overtook) was never shown to the player; the toast batch stayed on the board and was re-introduced every turn. SYNC tests through the
real framing hook (`note_premiere_turn`) and the real post-turn hook (`note_premiere_narration`)."""
import importlib

ch = importlib.import_module("routes.chat_helpers")
USER = "orw704-user"
NPCS = [f"Guest{chr(65 + i)} Role{chr(65 + i)}" for i in range(15)]  # fifteen houseguests; the player is the sixteenth, entering at slot 4
PLAYER_POS = 4


def _state(arrived_npcs: int, stage: str = "entrances", speakers=None):
    """The board as the narrator's framing reads it after `arrived_npcs` houseguests (not counting the player) have walked in."""
    index = arrived_npcs + (1 if arrived_npcs >= PLAYER_POS - 1 else 0)
    names = NPCS[:arrived_npcs]
    ent = {"stage": stage, "index": index, "total": 16, "playerPosition": PLAYER_POS, "arrivedNames": names}
    if names:
        ent["justArrived"] = {"id": f"npc:{arrived_npcs}", "name": names[-1]}
    if speakers is not None:
        ent["speakers"] = speakers
    return {"phase": "premiere", "premiere": {"entrance": ent}}


def _reset():
    for d in (ch._ARRIVALS_NAMED, ch._ARRIVALS_FRAMED, ch._ARRIVAL_VOICE_HOLDS, ch._TOAST_BATCH_NAMED, ch._SCHEDULE_STEER, ch._CEREMONY_UNVOICED):
        d.clear()


def _frame(arrived: int, **kw) -> str:
    ch.note_premiere_turn(USER, _state(arrived, **kw))
    return ch._SCHEDULE_STEER.pop(ch._runway_key(USER), "")


def test_every_arrival_is_named_even_when_replies_skip_some_and_releases_overtake_the_narrator():
    _reset()
    voiced = set()
    skipped_own_turn = {NPCS[4], NPCS[9], NPCS[13]}  # replies that never name the houseguest the game just showed
    arrived = 0
    while arrived < 15:
        arrived += 2 if arrived in (6, 11) else 1  # twice a second release overtook the narrator: the framing never saw the middle arrival
        steer = _frame(arrived)
        reply = ""
        if NPCS[arrived - 1] not in skipped_own_turn:
            reply += f"{NPCS[arrived - 1]} walks in. "
        reply += " ".join(f"{n} looks round." for n in NPCS if n in steer)  # the narrator voices whoever the steer lists
        ch.note_premiere_narration(USER, reply)
        voiced |= {n for n in NPCS if n in reply}
    # the circle is called: one more framing on the tour stage carries whoever is still owed
    steer = _frame(15, stage="tour")
    voiced |= {n for n in NPCS if n in steer}
    assert voiced == set(NPCS), f"never named: {sorted(set(NPCS) - voiced)}"


def test_an_arrival_already_named_is_not_owed_again():
    _reset()
    for arrived in range(1, 9):
        steer = _frame(arrived)
        assert "ENTRANCES OWED" not in steer
        ch.note_premiere_narration(USER, f"{NPCS[arrived - 1]} walks in.")


def test_the_next_release_waits_for_an_unnamed_arrival_then_runs_out():
    _reset()
    _frame(6)
    assert ch.arrival_voice_hold(USER, "a quiet room, nobody new named") is True
    assert ch.arrival_voice_hold(USER, "still quiet") is True
    assert ch.arrival_voice_hold(USER, "still quiet") is False  # bounded: the hold never stalls the premiere
    _frame(7)
    assert ch.arrival_voice_hold(USER, f"{NPCS[6]} steps in") is False


def test_a_toast_batch_already_voiced_is_not_introduced_again():
    _reset()
    batch = [{"id": "npc:1", "name": NPCS[0]}, {"id": "npc:2", "name": NPCS[1]}]
    assert "ALREADY BEEN VOICED" not in _frame(15, stage="toast", speakers=batch)
    ch.note_premiere_narration(USER, f"{NPCS[0]} raises a glass. {NPCS[1]} grins.")
    again = _frame(15, stage="toast", speakers=batch)
    assert "ALREADY BEEN VOICED" in again and NPCS[0] in again and NPCS[1] in again
    nxt = [{"id": "npc:3", "name": NPCS[2]}]
    assert "ALREADY BEEN VOICED" not in _frame(15, stage="toast", speakers=nxt)
