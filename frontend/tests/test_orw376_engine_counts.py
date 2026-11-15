"""ORW-376 — the headcount wall beyond the premiere. The engine's `whereabouts.counts` (player INCLUDED) is the one
truth for "how many of us are here / left / voting"; a stated count it contradicts is dropped and the next turn is
re-grounded. Roles only; no model calls; no engine."""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")

_USER = "u-orw376"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)
    yield
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)


def _wa(others=3, house=12, voters=None):
    c = {"room": others + 1, "others": others, "house": house}
    if voters is not None:
        c["voters"] = voters
    return {"room": "kitchen", "present": [{"id": f"n{i}", "name": f"N{i}"} for i in range(others)], "nearby": [], "counts": c}


def _fake(monkeypatch, wa, premiere=None):
    async def w(user=None):
        if isinstance(wa, Exception):
            raise wa
        return wa

    async def p(user=None):
        return premiere
    monkeypatch.setattr(orwell_engine, "whereabouts", w)
    monkeypatch.setattr(orwell_engine, "premiere_intros", p)


def _emit(s):
    return _run(chat_helpers.screen_streamed_headcount(_USER, s))


def test_room_claim_without_the_player_is_dropped(monkeypatch):
    _fake(monkeypatch, _wa(others=3))  # room 4
    assert _emit("There are three of us in here.") is False
    assert "HEADCOUNT" in (chat_helpers._DESYNC_REGROUND.get(_USER) or "")
    assert "4 people, you included" in chat_helpers._DESYNC_REGROUND[_USER]
    assert _run(chat_helpers.screen_headcount_wall(_USER, "The three of us. Fine.")) == " Fine."


def test_room_claim_with_the_player_passes(monkeypatch):
    _fake(monkeypatch, _wa(others=3))
    assert _emit("The four of us.") is True
    assert _emit("There are four of us in here.") is True
    assert _USER not in chat_helpers._DESYNC_REGROUND


def test_other_three_passes_and_other_five_is_dropped(monkeypatch):
    _fake(monkeypatch, _wa(others=3))
    assert _emit("The other three, in here.") is True
    assert _emit("The other five in here.") is False


def test_house_claim(monkeypatch):
    _fake(monkeypatch, _wa(house=12))
    assert _emit("Twelve of us left.") is True
    assert _emit("Eleven of us left.") is False


def test_vote_claim_may_reach_voters_plus_the_hoh_tiebreak_but_no_further(monkeypatch):
    """The wall allows `voters + 1` (the HOH's tie-break ballot), so 8 votes with 7 voters passes and 9 does not (review of #2656)."""
    _fake(monkeypatch, _wa(house=10, voters=7))
    assert _emit("It is a 5-2 vote.") is True
    assert _emit("It is a 5-3 vote.") is True   # 8 = 7 voters + the HOH tie-break
    assert _emit("It is a 6-3 vote.") is False  # 9
    assert _emit("It is a 9-3 vote.") is False
    assert _emit("Nine votes to evict.") is False


def test_subgroup_idiom_and_pair_are_never_claims(monkeypatch):
    _fake(monkeypatch, _wa(others=3))
    for s in ("The three of us should vote together.", "One of us is lying.", "The two of us walk out.", "He counts three people."):
        assert _emit(s) is True


def test_runs_outside_the_premiere_and_yields_to_it_inside(monkeypatch):
    _fake(monkeypatch, _wa(others=3), premiere=None)
    assert _emit("The three of us.") is False


def test_fails_open_on_a_failed_read_and_on_missing_counts(monkeypatch):
    _fake(monkeypatch, RuntimeError("down"))
    assert _emit("The three of us.") is True
    _fake(monkeypatch, {"room": "kitchen", "present": []})
    assert _emit("The three of us.") is True
    assert _USER not in chat_helpers._DESYNC_REGROUND


def test_no_claim_means_no_engine_read(monkeypatch):
    async def boom(user=None):
        raise AssertionError("read")
    monkeypatch.setattr(orwell_engine, "whereabouts", boom)
    assert _emit("They laugh by the couch.") is True


def test_roster_framing_states_the_count_player_included():
    out = chat_helpers._whereabouts_barrier_directive(_wa(others=3, house=12, voters=9))
    assert "In this room: 4 people, you included (you + 3 houseguests)" in out
    assert "Voting tonight: 9 people" in out
