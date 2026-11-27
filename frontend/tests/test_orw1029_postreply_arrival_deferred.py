"""ORW-1029: a staged premiere arrival committed silently AFTER the reply is never in that reply (prod 11-26: entrances 11, 12 and 14 committed, never narrated). The end-of-turn stall belt must leave a due
arrival to the next turn's pre-reply release (`maybe_release_premiere_arrival`), at most one turn in a row so the net survives a pre-release that cannot run. Roles only."""
import asyncio
import importlib
import pathlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

USER = "u-orw1029"


def _board(n):
    return {"phase": "premiere", "pending": None, "premiere": {"entrance": {"stage": "entrances", "index": n, "total": 16, "playerPosition": 3, "arrivedNames": [], "justArrived": {"id": f"npc:{n}", "name": f"Guest{n} Role"}}}}


@pytest.fixture(autouse=True)
def _clean():
    stores = [ch._ARRIVALS_NAMED, ch._ARRIVALS_FRAMED, ch._ARRIVAL_VOICE_HOLDS, ch._ARRIVAL_POSTREPLY_DEFERS, ch._SCHEDULE_STEER, ch._PREMIERE_ENTRANCE_STAGE, ch._PRE_RESOLVED_ADVANCE, al._TURNS_SINCE_PROGRESS]
    for d in stores:
        d.clear()
    yield
    for d in stores:
        d.clear()


def test_a_due_arrival_is_deferred_once_then_the_net_commits():
    ch.note_premiere_turn(USER, _board(5))
    assert ch.premiere_entrance_active(USER)
    assert ch.defer_postreply_arrival_commit(USER) is True, "the first post-reply commit is left for the next turn's pre-reply release"
    assert ch.defer_postreply_arrival_commit(USER) is False, "bounded: a second one in a row commits (the net when the pre-release cannot run)"
    assert ch.defer_postreply_arrival_commit(USER) is True, "the counter restarts after the net fired"


def test_the_pre_reply_release_restarts_the_deferral_and_commits_before_the_reply(monkeypatch):
    committed = []

    async def advance_game(**kw):
        committed.append(1)
        return {"event": {"beat": "entrance"}}

    async def fetch(user, retry=False):
        return _board(6)

    monkeypatch.setattr(oe, "advance_game", advance_game)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)
    ch.note_premiere_turn(USER, _board(5))
    assert ch.defer_postreply_arrival_commit(USER) is True
    al._TURNS_SINCE_PROGRESS[al._belt_key(USER)] = 5  # the staleness clock was left untouched by the deferral, so the next turn finds the arrival due
    state = asyncio.run(ch.maybe_release_premiere_arrival(USER, _board(5), retry=False, player_msg="I look around the room"))
    assert committed == [1] and state["premiere"]["entrance"]["index"] == 6
    assert ch._ARRIVAL_POSTREPLY_DEFERS == {}


def test_outside_the_staged_premiere_nothing_is_deferred():
    assert ch.defer_postreply_arrival_commit(USER) is False


def test_the_visible_scene_stall_commit_consults_the_deferral():
    src = (pathlib.Path(__file__).resolve().parents[1] / "src" / "agent_loop.py").read_text()
    i = src.index("defer_postreply_arrival_commit(owner)")
    assert src.index('_commit_advance_silently(\n                                    "preview-commit"', i) > i
    assert "not _previewed_uncommitted and not _decision_undelivered" in src[i - 300:i]
