"""F-2/F-4 (A-11 playtest, #1781): a beat the FE PRE-RESOLVED (engine-committed during framing) must reach the
player even when the model returns blank/skips it, and the next scene must be grounded on it. Roles only."""
import asyncio
import importlib
import os

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*p):
    return open(os.path.join(_ROOT, *p), encoding="utf-8").read()


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers.clear_social_runway("u")
    yield
    chat_helpers.clear_social_runway("u")


ANN = {"id": "a1", "kind": "hoh-winner", "week": 1, "beatSeq": 5, "headline": "The HOH wins Head of Household.", "subjects": []}


def test_a_preresolved_advance_owes_its_announcements_to_the_client(monkeypatch):
    async def fake_status(user=None):
        return {"phase": "nominations", "pending": None}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return {"event": {"content": "HOH nominates A and B"}, "announcements": [ANN]}

    async def fake_state(user=None, **kw):
        return {"started": True, "phase": "veto-competition", "moment": "veto-competition", "nominees": ["A", "B"]}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    state = {"started": True, "phase": "nominations", "moment": "nominations", "nominees": []}
    for _ in range(chat_helpers._SOCIAL_RUNWAY_TURNS + 2):
        _run(chat_helpers._pre_resolve_npc_ceremony("u", state, retry=False))
        if chat_helpers._PENDING_CHYRON:
            break
    owed = chat_helpers.pop_pending_chyron("u")
    assert owed == [ANN], "the engine announcement of a pre-resolved beat must be owed to the player"
    assert chat_helpers.pop_pending_chyron("u") == [], "consumed once"


def test_the_committed_beat_grounds_the_next_scenes_then_expires():
    chat_helpers.stash_preresolved_announcements("u", {"announcements": [ANN]})
    first = chat_helpers._aired_fact_steer("u")
    second = chat_helpers._aired_fact_steer("u")
    third = chat_helpers._aired_fact_steer("u")
    assert first and "The HOH wins Head of Household." in first and "never say it has not happened yet" in first
    assert second and not third, "grounding rides exactly _AIRED_STEER_TURNS turns"


def test_no_announcements_means_no_steer_and_no_debt():
    chat_helpers.stash_preresolved_announcements("u", {"event": {"content": "x"}})
    chat_helpers.stash_preresolved_announcements("u", None)
    assert chat_helpers.pop_pending_chyron("u") == [] and chat_helpers._aired_fact_steer("u") is None


def test_the_pre_resolves_own_runway_clear_never_deletes_the_debt_it_just_stashed():
    chat_helpers.stash_preresolved_announcements("u", {"announcements": [ANN]})
    chat_helpers.clear_social_runway("u")  # the pre-resolve calls this when it lands on a player decision
    assert chat_helpers.pop_pending_chyron("u") == [ANN]


def test_a_season_with_no_live_game_drops_a_stale_debt():
    chat_helpers.stash_preresolved_announcements("u", {"announcements": [ANN]})
    chat_helpers.clear_preresolve_debt("u")
    assert chat_helpers.pop_pending_chyron("u") == [] and chat_helpers._aired_fact_steer("u") is None


def test_the_loop_emits_the_debt_before_any_model_round_and_the_client_dispatches_it():
    loop = _read("src", "agent_loop.py")
    head = loop.split("round_texts = []   # Cleaned text per round for history reload", 1)[1][:900]
    assert "pop_pending_chyron(owner)" in head and '{"announcements": _owed}' in head
    chat_js = _read("static", "js", "chat.js")
    assert "Array.isArray(json.announcements)" in chat_js and "'orwell:announcements'" in chat_js.split("Array.isArray(json.announcements)", 1)[1][:300]
    # the pre-resolve stashes at its commit point
    assert "stash_preresolved_announcements(user, adv)" in _read("routes", "chat_helpers.py")
