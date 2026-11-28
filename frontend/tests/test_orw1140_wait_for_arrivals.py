"""ORW-1140 - the player says he will wait for the last arrivals (prod shape, as codes): each turn releases the next entrance, (docs/design/premiere-entrances.md: one entrance per turn). Real chain: note_premiere_turn -> maybe_release_premiere_arrival -> the engine call. Roles only; no model."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

USER = "u-orw1140"
NPCS = [f"Guest{chr(65 + i)} Role{chr(65 + i)}" for i in range(15)]
WAIT = "I would rather wait until everyone gets here and see the last arrivals"


def _state(arrived: int, stage="entrances"):
    ent = {"stage": stage, "index": arrived + (1 if arrived >= 3 else 0), "total": 16, "playerPosition": 4, "arrivedNames": NPCS[:arrived]}
    if arrived and stage == "entrances":
        ent["justArrived"] = {"id": f"npc:{arrived}", "name": NPCS[arrived - 1]}
    return {"phase": "premiere", "pending": None, "premiere": {"entrance": ent}}


@pytest.fixture(autouse=True)
def _clean():
    stores = [ch._ARRIVALS_NAMED, ch._ARRIVALS_FRAMED, ch._ARRIVAL_VOICE_HOLDS, ch._SCHEDULE_STEER, ch._CEREMONY_UNVOICED, ch._PREMIERE_ENTRANCE_STAGE, ch._PRE_RESOLVED_ADVANCE,
              al._TURNS_SINCE_PROGRESS, ch._PREMIERE_RELEASED_THIS_TURN, ch._ENTRANCE_FRAMES]
    for d in stores:
        d.clear()
    yield
    for d in stores:
        d.clear()


def _wire(monkeypatch, board):
    calls = []

    async def advance_game(**kw):
        board["n"] += 1
        calls.append(kw)
        return {"event": {"beat": "entrance"}}

    async def fetch(user, retry=False):
        return _state(board["n"], board["stage"])

    monkeypatch.setattr(oe, "advance_game", advance_game)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)
    return calls


def _turn(board, msg, narration=None):
    ch._PRE_RESOLVED_ADVANCE.clear()
    s = _state(board["n"], board["stage"])
    ch.note_premiere_turn(USER, s)
    out = asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg=msg))
    if narration == "ALL":  # the reply voices every houseguest who is in, as the board stands after this turn's release
        narration = " ".join(f"{n} walks in." for n in NPCS[:board["n"]])
    if narration is not None:
        ch.note_premiere_narration(USER, narration)
    return out


def test_waiting_for_the_arrivals_releases_the_next_entrance_each_turn_until_all_are_in(monkeypatch):
    board = {"n": 11, "stage": "entrances"}
    calls = _wire(monkeypatch, board)
    _turn(board, "hello there", narration=f"{NPCS[10]} is here.")  # not a cue: no release on the first turn after one
    assert not calls
    seen = []
    for i in range(4):
        _turn(board, WAIT, narration="ALL")
        seen.append(board["n"])
    assert seen == [12, 13, 14, 15], "one entrance per turn, none skipped, no jump to the circle"
    assert len(calls) == 4
