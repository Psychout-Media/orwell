"""A-14 N-2/N-3 — an engine announcement committed on ANY path (a model/belt `advanceGame`, a failed turn, a card
submit) must still reach the player: framing already reads the engine's `stateDelta` every turn, so announcements
in that delta are OWED to the client (the chyron) and ground the next scene, deduped by id with the pre-resolve
stash. Roles only."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


@pytest.fixture(autouse=True)
def _clean():
    ch.clear_preresolve_debt("u")
    yield
    ch.clear_preresolve_debt("u")


A1 = {"id": "ann:1", "kind": "hoh-winner", "week": 1, "beatSeq": 7, "headline": "A is the new Head of Household.", "subjects": []}
A2 = {"id": "ann:2", "kind": "comp-round-result", "week": 1, "beatSeq": 6, "headline": "B and C are out of the competition; 7 remain.", "subjects": []}


def _delta(monkeypatch, anns, seq=9):
    async def fake(since, user=None):
        return {"beatSeq": seq, "fullRefresh": False, "announcements": anns}
    monkeypatch.setattr(oe, "state_delta", fake)


def test_delta_announcements_are_owed_and_ground_the_next_scene(monkeypatch):
    _delta(monkeypatch, [A2, A1])
    _run(ch._maybe_delta_line("u", 3))
    owed = ch.pop_pending_chyron("u")
    assert [a["id"] for a in owed] == ["ann:2", "ann:1"]
    steer = ch._aired_fact_steer("u")
    assert steer and "B and C are out of the competition" in steer and "A is the new Head of Household" in steer
    assert "never say it has not happened yet" in steer


def test_the_same_announcement_is_never_owed_twice_across_paths(monkeypatch):
    ch.stash_preresolved_announcements("u", {"announcements": [A1]})
    _delta(monkeypatch, [A1, A2])
    _run(ch._maybe_delta_line("u", 3))
    ids = [a["id"] for a in ch.pop_pending_chyron("u")]
    assert sorted(ids) == ["ann:1", "ann:2"] and len(ids) == 2, "ann:1 was already owed via the pre-resolve stash"
    _delta(monkeypatch, [A1, A2])
    _run(ch._maybe_delta_line("u", 3))
    assert ch.pop_pending_chyron("u") == [], "already delivered ids are never re-owed"


def test_an_empty_or_full_refresh_delta_owes_nothing(monkeypatch):
    _delta(monkeypatch, [])
    _run(ch._maybe_delta_line("u", 3))
    assert ch.pop_pending_chyron("u") == [] and ch._aired_fact_steer("u") is None

    async def fake(since, user=None):
        return {"beatSeq": 9, "fullRefresh": True, "announcements": [A1]}
    monkeypatch.setattr(oe, "state_delta", fake)
    _run(ch._maybe_delta_line("u", 3))
    assert ch.pop_pending_chyron("u") == [], "a fullRefresh carries no reliable slice — never replay history onto the player"
