"""A/B 2026-11-04 (scene circuit-breaker cuts, both narrator arms): a player who typed "Run the veto competition. Who won?" /
"Go to the veto ceremony." got ONE staged beat per turn (the draw, then 'X answers wrong and is out') while the narrator, asked who won,
voiced the whole result -> the scene breaker cut it. Two fixes pinned here: (1) a plain navigation imperative ("go to the veto ceremony",
"run the veto competition") IS readiness; (2) a ready player's COMPETITION is driven to its result in the SAME pre-resolve pass (bounded),
so the narration voices the engine's real winner. A lingering player still gets one beat per turn. Roles only."""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")


def _run(c):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(c)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.mark.parametrize("msg", [
    "Go to the veto ceremony.", "Run the veto competition. Who won?", "Go to nominations. Who is nominated?",
    "Take me to the veto competition.", "Run the competition and tell me who wins.", "Continue to eviction night.",
    "Go on to the veto ceremony and then eviction night.", "Head to the nominations.", "Skip to the eviction.",
])
def test_navigation_imperatives_are_readiness(msg):
    assert ch._player_signals_ready(msg), msg


@pytest.mark.parametrize("msg", [
    "Go to the kitchen and talk to Sam.", "I go to the veto ceremony with Sam, whispering the whole way.",
    "Run to Sam and tell him the veto competition is rigged.", "Go to Sam and ask who he would nominate.",
    "Tell Sam I will go to the veto ceremony with him.", "Run the kitchen conversation back, what did Sam say?",
])
def test_scheming_that_merely_mentions_a_ceremony_is_not_readiness(msg):
    assert not ch._player_signals_ready(msg), msg


@pytest.fixture(autouse=True)
def _clean():
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None)
    yield
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None)


def _wire(monkeypatch, rounds=4, pending_after=None):
    calls = []
    board = {"phase": "veto-competition", "moment": "veto-competition", "week": 1, "started": True, "pending": None, "vetoHolder": None}

    async def status(user=None):
        return {"phase": board["phase"], "pending": board["pending"]}

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(len(calls) + 1)
        if pending_after is not None and len(calls) == pending_after:
            board["pending"] = {"kind": "comp-round"}
        if len(calls) >= rounds:
            board.update(phase="veto-ceremony", moment="veto-ceremony", vetoHolder="Winner-One")
            return {"event": {"beat": "veto-result", "content": "Winner-One wins the Power of Veto"}, "announcements": [
                {"id": "ann:veto", "kind": "veto", "week": 1, "beatSeq": 9, "headline": "Winner-One won the Power of Veto.", "subjects": []}]}
        return {"event": {"beat": "comp-round", "content": f"round {len(calls)}"}, "announcements": []}

    async def state(user=None, **kw):
        return dict(board)

    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "advance_game", advance)
    monkeypatch.setattr(oe, "get_game_state", state)
    return calls, board


START = {"phase": "veto-competition", "moment": "veto-competition", "week": 1, "started": True, "pending": None}


def _spent(user="u"):
    ch._RUNWAY_LAST_DONE[ch._runway_key(user)] = ch._runway_sig(START)


def test_a_ready_player_gets_the_competition_driven_to_its_result_in_one_pass(monkeypatch):
    calls, board = _wire(monkeypatch, rounds=4)
    out = _run(ch._pre_resolve_npc_ceremony("u", dict(START), retry=False, player_msg="Run the veto competition. Who won?"))
    assert len(calls) == 4, "every staged round was walked in this pass"
    assert out.get("vetoHolder") == "Winner-One", "the framing state carries the engine's real winner"
    assert any(a["id"] == "ann:veto" for a in ch.pop_pending_chyron("u")), "the result's announcement is owed to the player"


def test_a_lingering_player_still_gets_one_beat_per_turn(monkeypatch):
    calls, board = _wire(monkeypatch, rounds=4)
    _spent()
    _run(ch._pre_resolve_npc_ceremony("u", dict(START), retry=False, player_msg="I wander into the kitchen and chat with Sam."))
    assert len(calls) == 1


def test_the_drive_stops_at_a_player_decision(monkeypatch):
    calls, board = _wire(monkeypatch, rounds=6, pending_after=2)
    _run(ch._pre_resolve_npc_ceremony("u", dict(START), retry=False, player_msg="Run the veto competition."))
    assert len(calls) == 2, "the player's card leads — never auto-resolved"


def test_the_drive_is_bounded(monkeypatch):
    calls, board = _wire(monkeypatch, rounds=10_000)
    _run(ch._pre_resolve_npc_ceremony("u", dict(START), retry=False, player_msg="Run the veto competition."))
    assert 2 <= len(calls) <= 12, len(calls)


def test_the_eviction_reveal_stays_one_beat_per_turn_even_for_a_ready_player(monkeypatch):
    calls, board = _wire(monkeypatch, rounds=10_000)
    board.update(phase="eviction", moment="eviction")
    start = dict(START, phase="eviction", moment="eviction")
    ch._RUNWAY_LAST_DONE[ch._runway_key("u")] = ch._runway_sig(start)
    _run(ch._pre_resolve_npc_ceremony("u", start, retry=False, player_msg="Continue to eviction night."))
    assert len(calls) == 1, "E12: the staged ballot reveal is never collapsed"
