"""ORW-977 (PT-2, "premiere arrivals never shown to the player"): a whole staged premiere played turn by turn through the front end's own hooks (framing, due-arrival release, the narrator's reply,
the post-turn voicing note), the engine stubbed as a board that follows the real shape: the houseguests drawn before the player's slot are already inside (only in `arrivedNames`), every later
houseguest arrives one per advance and is `justArrived`. The scripted narrator voices only what the prompt hands it (the arrival shown as just arrived, plus any the ENTRANCES OWED steer lists).
Pins: every houseguest who walks in after the player is named in the reply of the very turn the engine committed them (not a turn late, not never); the old path (commit silently AFTER the reply)
is the control and fails that. Roles only; invented labels."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

USER = "u-orw977"
NPCS = [f"Guest{chr(65 + i)} Role{chr(65 + i)}" for i in range(15)]
PLAYER_POS = 4
INSIDE_AT_START = PLAYER_POS - 1  # drawn before the player's slot: already in the room when the player walks in
TOTAL = 16


def _board(n):
    ent = {"stage": "entrances", "index": n + (1 if n >= INSIDE_AT_START else 0), "total": TOTAL, "playerPosition": PLAYER_POS, "arrivedNames": NPCS[:n]}
    if n > INSIDE_AT_START:
        ent["justArrived"] = {"id": f"npc:{n}", "name": NPCS[n - 1]}
    return {"phase": "premiere", "pending": None, "premiere": {"entrance": ent}}


@pytest.fixture(autouse=True)
def _clean():
    stores = [ch._ARRIVALS_NAMED, ch._ARRIVALS_FRAMED, ch._ARRIVAL_VOICE_HOLDS, ch._SCHEDULE_STEER, ch._CEREMONY_UNVOICED,
              ch._PREMIERE_ENTRANCE_STAGE, ch._PRE_RESOLVED_ADVANCE, al._TURNS_SINCE_PROGRESS, ch._PREMIERE_RELEASED_THIS_TURN]
    for d in stores:
        d.clear()
    yield
    for d in stores:
        d.clear()


def _play(monkeypatch, *, pre_release: bool, max_turns=80):
    """Returns {name: (turn committed, turn first named in a reply)} for every houseguest who arrives after the player."""
    board = {"n": INSIDE_AT_START + 1}  # the player has walked in; the first post-player arrival is on the board
    committed, named = {}, {}
    turn = {"t": 0}

    async def advance_game(**kw):
        board["n"] += 1
        committed[NPCS[board["n"] - 1]] = turn["t"]
        return {"event": {"beat": "entrance"}}

    async def fetch(user, retry=False):
        return _board(board["n"])

    monkeypatch.setattr(oe, "advance_game", advance_game)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)
    committed[NPCS[board["n"] - 1]] = 1  # already on the board when the first turn is framed
    key = ch._runway_key(USER)
    belt = al._belt_key(USER)
    for t in range(1, max_turns + 1):
        turn["t"] = t
        state = _board(board["n"])
        ch.note_premiere_turn(USER, state)
        if pre_release:
            state = asyncio.run(ch.maybe_release_premiere_arrival(USER, state, retry=False, player_msg="I look around the room"))
        steer = ch._SCHEDULE_STEER.get(key, "")
        ent = state["premiere"]["entrance"]
        ja = (ent.get("justArrived") or {}).get("name")
        reply = " ".join(f"{n} is in the room." for n in NPCS if n == ja or n in steer)  # voices what the prompt hands it
        ch.note_premiere_narration(USER, reply)
        for n in NPCS:
            if n in reply:
                named.setdefault(n, t)
        ch._SCHEDULE_STEER.pop(key, None)
        ch._PRE_RESOLVED_ADVANCE.clear()
        ch._PREMIERE_RELEASED_THIS_TURN.discard(key)
        al._TURNS_SINCE_PROGRESS[belt] = al._TURNS_SINCE_PROGRESS.get(belt, 0) + 1
        # the old path: the web tier's end-of-turn belt commits the due arrival silently AFTER the reply
        if not pre_release and ch._premiere_arrival_due(USER, _board(board["n"]), "I look around the room"):
            asyncio.run(advance_game())
            al._TURNS_SINCE_PROGRESS[belt] = 0
        if board["n"] >= len(NPCS) and NPCS[-1] in named:
            break
    post = NPCS[INSIDE_AT_START:]
    return {n: (committed.get(n), named.get(n)) for n in post}


def test_every_post_player_arrival_is_named_in_the_turn_it_is_committed(monkeypatch):
    out = _play(monkeypatch, pre_release=True)
    assert len(out) == len(NPCS) - INSIDE_AT_START
    for n, (c, v) in out.items():
        assert c is not None and v is not None, f"{n} was never {'committed' if c is None else 'named in a reply'}"
        assert v == c, f"{n} was committed in turn {c} but first named in turn {v}"


def test_control_the_silent_after_reply_commit_names_arrivals_a_turn_late(monkeypatch):
    out = _play(monkeypatch, pre_release=False)
    late = [n for n, (c, v) in out.items() if c is not None and (v is None or v != c)]
    assert late, "the control must show the old fault (an arrival committed after the reply is not in that reply), or the test above proves nothing"
