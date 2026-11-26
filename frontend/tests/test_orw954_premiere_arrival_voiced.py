"""ORW-954 - a premiere arrival the web tier commits is in the moment prompt the narrator writes from (released BEFORE the reply), not committed silently after it;
and the entrance cadence counter survives a restart (the shutdown flush). Roles only; invented labels; no model, no engine (the engine calls are stubbed)."""
import asyncio
import importlib
import os

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
bsp = importlib.import_module("src.belt_state_persist")
oe = importlib.import_module("src.orwell_engine")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
USER = "u-orw954"
NPCS = [f"Guest{chr(65 + i)} Role{chr(65 + i)}" for i in range(15)]


def _state(arrived: int, stage="entrances", pending=None):
    ent = {"stage": stage, "index": arrived + (1 if arrived >= 3 else 0), "total": 16, "playerPosition": 4, "arrivedNames": NPCS[:arrived]}
    if arrived:
        ent["justArrived"] = {"id": f"npc:{arrived}", "name": NPCS[arrived - 1]}
    return {"phase": "premiere", "pending": pending, "premiere": {"entrance": ent}}


@pytest.fixture(autouse=True)
def _clean():
    stores = [ch._ARRIVALS_NAMED, ch._ARRIVALS_FRAMED, ch._ARRIVAL_VOICE_HOLDS, ch._SCHEDULE_STEER, ch._CEREMONY_UNVOICED,
              ch._PREMIERE_ENTRANCE_STAGE, ch._PRE_RESOLVED_ADVANCE, al._TURNS_SINCE_PROGRESS, ch._PREMIERE_RELEASED_THIS_TURN]
    for d in stores:
        d.clear()
    yield
    for d in stores:
        d.clear()


def _wire(monkeypatch, board):
    """Stub the engine: advance_game moves `board['n']` forward; the state read returns the board at that point."""
    calls = []

    async def advance_game(**kw):
        board["n"] += 1
        calls.append(kw)
        return {"event": {"beat": "entrance"}}

    async def fetch(user, retry=False):
        return _state(board["n"])

    monkeypatch.setattr(oe, "advance_game", advance_game)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)
    return calls


def _framed(n):
    s = _state(n)
    ch.note_premiere_turn(USER, s)
    return s


def test_due_arrival_is_released_before_the_reply_and_is_what_the_narrator_is_framed_on(monkeypatch):
    board = {"n": 6}
    calls = _wire(monkeypatch, board)
    s = _framed(6)
    ch.note_premiere_narration(USER, f"{NPCS[5]} is here.")  # the previous arrival was named
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 1  # one turn since the last release: this turn is the 2nd, the cadence is due
    out = asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg="what is the kitchen like"))
    assert len(calls) == 1 and board["n"] == 7
    assert out["premiere"]["entrance"]["justArrived"]["name"] == NPCS[6]  # the narrator is framed on the NEW arrival
    assert ch._ARRIVALS_FRAMED[ch._runway_key(USER)][-1] == NPCS[6]
    assert ch._CEREMONY_UNVOICED[ch._desync_key(USER)]["names"] == [NPCS[6]]  # the same-turn voicing check is about the arrival that is in the prompt
    assert al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] == 0
    assert ch.consume_pre_resolved_advance("") or ch.consume_pre_resolved_advance(USER)  # the end-of-turn backstop stands down (auth-off key too)
    assert ch.premiere_release_already_this_turn(USER)  # the narrator's own advanceGame this turn is answered "held"


def test_not_due_on_the_first_turn_after_a_release(monkeypatch):
    board = {"n": 6}
    calls = _wire(monkeypatch, board)
    s = _framed(6)
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 0
    out = asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg="hello there"))
    assert not calls and out is s


@pytest.mark.parametrize("kind", ["production_cue", "pending", "toast", "unvoiced_previous"])
def test_never_released_when_the_arrival_should_wait(monkeypatch, kind):
    board = {"n": 6}
    calls = _wire(monkeypatch, board)
    s = _framed(6)
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 5
    msg = "chat"
    if kind == "production_cue":
        msg = "(Production cue - something)"
    elif kind == "pending":
        s = _state(6, pending={"kind": "x"})
    elif kind == "toast":
        s = _state(6, stage="toast")
        ch.note_premiere_turn(USER, s)
    elif kind == "unvoiced_previous":
        pass  # nothing named yet: the latest arrival is still owed
    out = asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg=msg))
    assert not calls and out is s


def test_unvoiced_hold_is_bounded(monkeypatch):
    board = {"n": 6}
    calls = _wire(monkeypatch, board)
    s = _framed(6)
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 5
    for _ in range(ch._ARRIVAL_VOICE_HOLD_CAP):
        asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg="chat"))
    assert not calls
    asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg="chat"))
    assert len(calls) == 1  # never a stall


def test_engine_hiccup_leaves_the_turn_as_it_was(monkeypatch):
    async def boom(**kw):
        raise RuntimeError("engine down")
    monkeypatch.setattr(oe, "advance_game", boom)
    s = _framed(6)
    ch.note_premiere_narration(USER, f"{NPCS[5]} is here.")
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 3
    assert asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg="chat")) is s


def test_owed_steer_is_not_duplicated_by_the_restamp(monkeypatch):
    board = {"n": 9}
    _wire(monkeypatch, board)
    s = _framed(9)  # arrivals 5.. unnamed -> owed paragraph written once
    ch.note_premiere_narration(USER, f"{NPCS[8]} is here.")
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 1
    asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg="chat"))
    assert (ch._SCHEDULE_STEER.get(ch._runway_key(USER)) or "").count("ENTRANCES OWED") <= 1


def test_source_pins_the_call_site_runs_after_the_pre_resolve_and_before_the_moment_prompt():
    src = open(os.path.join(FRONTEND, "routes", "chat_helpers.py"), encoding="utf-8").read()
    a = src.index("game_state = await _pre_resolve_npc_ceremony(\n            user, game_state, retry=game_build")
    b = src.index("maybe_release_premiere_arrival(user, game_state, retry=game_build", a)
    c = src.index('moment = game_state.get("moment")', a)
    assert a < b < c


def test_entrance_counter_survives_a_restart_and_shutdown_flushes_it(tmp_path, monkeypatch):
    monkeypatch.setattr(bsp, "BELT_STATE_PATH", tmp_path / "belt.json")
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 1
    bsp.save_now()  # what the shutdown hook calls
    al._TURNS_SINCE_PROGRESS.clear()  # the process restarts: empty stores
    assert bsp.restore() >= 1
    assert al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] == 1
    # a corrupt file is tolerated
    (tmp_path / "belt.json").write_text("{not json", encoding="utf-8")
    al._TURNS_SINCE_PROGRESS.clear()
    assert bsp.restore() == 0
    app_src = open(os.path.join(FRONTEND, "app.py"), encoding="utf-8").read()
    i = app_src.index("async def _shutdown_event")
    assert "belt_state_persist" in app_src[i:i + 900]


def test_no_release_when_the_pre_resolve_already_walked_a_beat_this_turn(monkeypatch):
    """Review of #3270: one engine advance per turn. If `_pre_resolve_npc_ceremony` already advanced (#670 flag set), the arrival release stands down."""
    board = {"n": 6}
    calls = _wire(monkeypatch, board)
    s = _framed(6)
    ch.note_premiere_narration(USER, f"{NPCS[5]} is here.")
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 1  # the cadence alone would say due
    ch.mark_pre_resolved_advance(USER)
    out = asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg="what is the kitchen like"))
    assert calls == [] and board["n"] == 6 and out is s
