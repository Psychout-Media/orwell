"""ORW-948 - the house-entry gate must not wait for houseguests the public read withholds.

Prod, 2026-11-26 (a live playthrough): `do_create_character` held house entry with "cast 7/7 authored" and the hold
never cleared. During the premiere the engine's public read lists only the houseguests who have walked in (ORW-710)
and counts the rest in `unarrivedCount`; the gate compared that arrived count to the full-cast threshold (15), which
can never pass while entrances are still running. The watch expired and kept the hold, so `/state` and `/status`
kept reporting `started: false` for a season that was being played: no Cast button, no Where You Are gadget, no
decision card.

Pinned here:
  - `authoring_completeness_for` carries the engine's `unarrivedCount` beside its counts (a number, never a card);
  - `await_house_ready` takes the withheld houseguests off the threshold, so a fully authored arrived cast is ready;
  - an arrived houseguest still on the floor keeps the gate held (the rule the gate exists for);
  - with nobody withheld the full-cast threshold is unchanged.

Roles only - every string is a generic probe, never cast material.
"""
import importlib

from conftest import _run

ca = importlib.import_module("src.orwell_cast_authoring")
orwell_engine = importlib.import_module("src.orwell_engine")

_FULL = ca.HOUSE_READY_MIN_AUTHORED


async def _noop():
    return None


def _arrived(n, *, authored=True):
    """`n` arrived houseguests as the engine's public read hands them over (a real authored entry carries its story)."""
    return [{"id": f"npc:{i}", "name": f"Houseguest {i}", "status": "active", "authored": authored,
             "biography": "Grew up near the water and still fixes boats.", "identityConcept": "a boat-fixer who reads a room",
             "physicalCharacteristics": {"wardrobe": ["tee"], "onCamera": "arms folded", "photoHair": "short"}}
            for i in range(1, n + 1)]


def _stub_state(monkeypatch, state):
    async def fake_state(user=None, **k):
        return state
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)


def _stub_completeness(monkeypatch, comp):
    async def _comp(owner):
        return dict(comp)
    monkeypatch.setattr(ca, "authoring_completeness_for", _comp)
    monkeypatch.setattr(ca, "_kick_backfill_for_stragglers", lambda owner: _noop())


def test_completeness_carries_the_unarrived_count(monkeypatch):
    """Seven houseguests are in, eight are still to walk in: the counts cover the seven and the eight ride as a number."""
    _stub_state(monkeypatch, {"started": True, "player": {"id": "player", "name": "The Player", "status": "active"},
                              "house": _arrived(7), "unarrivedCount": 8})
    comp = _run(ca.authoring_completeness_for("u"))
    assert comp["total"] == 7 and comp["authored"] == 7 and comp["missing"] == 0
    assert comp["unarrived"] == 8


def test_completeness_is_unchanged_when_nobody_is_withheld(monkeypatch):
    """No `unarrivedCount` (the flag off, or everyone is in): the dict has no `unarrived` key, as before."""
    _stub_state(monkeypatch, {"started": True, "player": {"id": "player", "name": "The Player", "status": "active"},
                              "house": _arrived(3)})
    assert "unarrived" not in _run(ca.authoring_completeness_for("u"))
    _stub_state(monkeypatch, {"started": True, "house": _arrived(3), "unarrivedCount": 0})
    assert "unarrived" not in _run(ca.authoring_completeness_for("u"))


def test_gate_is_ready_when_every_arrived_houseguest_is_authored(monkeypatch):
    """The prod case: 7 of 7 arrived cards authored, 8 withheld. The gate opens (it held for good before)."""
    _stub_completeness(monkeypatch, {"total": 7, "authored": 7, "missing": 0, "unarrived": _FULL - 7})
    out = _run(ca.await_house_ready("u", timeout=0.05, poll_interval=0.01))
    assert out["ready"] is True and out["authored"] == 7 and out["unarrived"] == _FULL - 7


def test_gate_still_holds_for_an_arrived_houseguest_on_the_floor(monkeypatch):
    """Two of the seven arrived houseguests are still on the floor: the gate holds, withheld cast or not."""
    _stub_completeness(monkeypatch, {"total": 7, "authored": 5, "missing": 2, "unarrived": _FULL - 7})
    out = _run(ca.await_house_ready("u", timeout=0.05, poll_interval=0.01))
    assert out["ready"] is False and out["authored"] == 5


def test_full_cast_threshold_is_unchanged_when_nobody_is_withheld(monkeypatch):
    """Control: with no withheld houseguests, 7 authored of a full cast is NOT ready (the threshold stays the full cast)."""
    _stub_completeness(monkeypatch, {"total": _FULL, "authored": 7, "missing": _FULL - 7})
    out = _run(ca.await_house_ready("u", timeout=0.05, poll_interval=0.01))
    assert out["ready"] is False and "unarrived" not in out


def test_watch_clears_the_hold_for_a_premiere_cast(monkeypatch):
    """End to end on the marker: with the arrived cast authored, the background watch clears the hold instead of expiring with it."""
    _stub_completeness(monkeypatch, {"total": 7, "authored": 7, "missing": 0, "unarrived": _FULL - 7})
    monkeypatch.setattr(importlib.import_module("src.orwell_game_session"), "publish_game_updated", lambda owner: None, raising=False)
    owner = "orw948-watch"
    ca.record_house_entry_gate_block(owner, {"authored": 7, "total": 7, "missing": 0})
    fired = []

    async def _drive():
        assert ca.kickoff_house_ready_watch(owner, on_ready=lambda: fired.append(1), timeout=1, poll_interval=0.01) is True
        task = ca._HOUSE_READY_WATCHES.get(ca._safe_user(owner))
        await task

    try:
        _run(_drive())
        assert ca.house_entry_gate_status(owner) is None, "the hold is cleared once the arrived cast is authored"
        assert fired == [1], "the deferred post-start kicks run exactly once"
    finally:
        ca.clear_house_entry_gate_block(owner)
