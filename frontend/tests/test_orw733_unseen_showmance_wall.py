"""ORW-733 (Vault Wall): the browser's `/api/orwell/state` never carries a showmance the player has not seen.

The engine's state read lists the PUBLIC showmances ("the house knows") for the NARRATOR to voice. No screen renders them, and the house knowing is not the player having seen it,
so the browser projection drops the field (and every other narrator-only top-level key) by construction. Roles only; sentinels are not names.
"""
from __future__ import annotations

import importlib
import json

orwell_routes = importlib.import_module("routes.orwell_routes")
_project = orwell_routes._browser_state_projection

SENTINEL_A, SENTINEL_B = "ZZ-sentinel-partner-one", "ZZ-sentinel-partner-two"


def _engine_state():
    return {
        "started": True, "beatSeq": 7, "phase": "social", "week": 2, "moment": "social", "finished": False, "pending": None, "eviction": None,
        "ceremony": {"hoh": None, "nominees": [], "veto": {"holder": None, "used": False, "players": []}},
        "whereabouts": {"room": "kitchen", "present": []}, "player": {"id": "player", "name": "P"}, "deals": [],
        "house": [{"id": "npc:1", "name": SENTINEL_A, "status": "active", "biography": "x" * 20}],
        "showmances": [{"a": SENTINEL_A, "b": SENTINEL_B}],
        "notorietyLegend": ["a legend"], "returningHouseguests": [{"name": SENTINEL_B}], "diaryRoomInvite": {"invite": True}, "alliances": [{"name": "n"}],
        "openDealOffer": {"from": SENTINEL_B}, "juryHouse": {"x": 1},
    }


def test_positive_control_the_engine_state_really_carries_the_showmance():
    raw = _engine_state()
    assert SENTINEL_B in json.dumps(raw["showmances"])


def test_the_browser_projection_drops_the_showmance_and_every_narrator_key():
    out = _project(_engine_state())
    for k in ("showmances", "notorietyLegend", "returningHouseguests", "diaryRoomInvite", "alliances", "openDealOffer", "juryHouse"):
        assert k not in out, k
    assert SENTINEL_B not in json.dumps(out)  # the pair's partner is named nowhere in the browser state
    assert out["house"][0]["name"] == SENTINEL_A  # the roster tile (a houseguest the player has met) still renders
    assert set(out) <= orwell_routes._BROWSER_STATE_KEYS


def test_a_new_unlisted_key_is_dropped_by_construction():
    st = _engine_state()
    st["someFutureNarratorField"] = {"secret": SENTINEL_B}
    out = _project(st)
    assert "someFutureNarratorField" not in out and SENTINEL_B not in json.dumps(out)


def test_the_panel_keys_survive():
    out = _project(_engine_state())
    for k in ("started", "beatSeq", "phase", "week", "moment", "ceremony", "whereabouts", "player", "house", "deals", "pending", "eviction", "finished"):
        assert k in out, k
