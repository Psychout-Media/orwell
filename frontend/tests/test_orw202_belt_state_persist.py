"""ORW-202 - the narrator's pacing / stall / re-ground bookkeeping survives a front-end restart.

Round trip across a simulated restart, a season reset clears the persisted copy, a corrupt or missing file
is ignored, restore never overwrites live state, and source pins that the turn end saves and startup
restores. No model; roles only.
"""
import importlib
import os

import pytest

bsp = importlib.import_module("src.belt_state_persist")
agent_loop = importlib.import_module("src.agent_loop")
chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_P = "u-orw202-player"
_O = "u-orw202-other"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(bsp, "BELT_STATE_PATH", tmp_path / "belt.json")
    ints, rg = bsp._stores()
    saved = {n: dict(s) for n, s in ints.items()}, dict(rg)
    for s in ints.values():
        s.clear()
    rg.clear()
    yield
    for n, s in ints.items():
        s.clear()
        s.update(saved[0][n])
    rg.clear()
    rg.update(saved[1])


def _fill():
    ints, rg = bsp._stores()
    ints["_TURNS_SINCE_PROGRESS"][_P] = 3
    ints["_ADVANCE_STALL_LEVEL"][_P] = 2
    ints["_ADVANCE_STALL_FLAGS"][_P] = 1
    ints["_SILENT_FORCE_ADVANCE_STREAK"][_P] = 4
    ints["_ANTI_STALE_CAP_HOLDS"][_P] = 5
    ints["_TURNS_SINCE_PROGRESS"][_O] = 9
    rg[_P] = "first correction\n\nsecond correction"


def _clear():
    ints, rg = bsp._stores()
    for s in ints.values():
        s.clear()
    rg.clear()


def test_round_trip_across_a_simulated_restart():
    _fill()
    bsp.save_now()
    _clear()
    assert bsp.restore() == 7
    ints, rg = bsp._stores()
    assert ints["_TURNS_SINCE_PROGRESS"] == {_P: 3, _O: 9}
    assert ints["_ADVANCE_STALL_LEVEL"] == {_P: 2}
    assert ints["_ADVANCE_STALL_FLAGS"] == {_P: 1}
    assert ints["_SILENT_FORCE_ADVANCE_STREAK"] == {_P: 4}
    assert ints["_ANTI_STALE_CAP_HOLDS"] == {_P: 5}
    assert rg == {_P: "first correction\n\nsecond correction"}


def test_restore_never_overwrites_live_state():
    _fill()
    bsp.save_now()
    ints, rg = bsp._stores()
    ints["_TURNS_SINCE_PROGRESS"].clear()
    ints["_TURNS_SINCE_PROGRESS"][_P] = 99
    bsp.restore()
    assert ints["_TURNS_SINCE_PROGRESS"] == {_P: 99}


def test_a_season_reset_clears_the_persisted_copy_for_that_user_only():
    _fill()
    bsp.save_now()
    orwell_engine._notify_season_reset(_P)
    _clear()
    bsp.restore()
    ints, rg = bsp._stores()
    assert _P not in ints["_ADVANCE_STALL_LEVEL"] and _P not in ints["_ANTI_STALE_CAP_HOLDS"]
    assert _P not in rg
    assert ints["_TURNS_SINCE_PROGRESS"].get(_P) is None
    assert ints["_TURNS_SINCE_PROGRESS"].get(_O) == 9, "another player's state survives"


@pytest.mark.parametrize("content", ["{not json", "[]", '{"ints": "x", "reground": 5}', '{"ints": {"_ADVANCE_STALL_LEVEL": {"u": "str", "v": true}}}'])
def test_a_corrupt_file_is_ignored(content):
    bsp.BELT_STATE_PATH.write_text(content, encoding="utf-8")
    assert bsp.restore() == 0
    ints, rg = bsp._stores()
    assert not any(ints.values()) and not rg


def test_a_missing_file_is_ignored():
    assert not bsp.BELT_STATE_PATH.exists()
    assert bsp.restore() == 0


def test_source_pins_turn_end_saves_and_startup_restores():
    src = open(os.path.join(FRONTEND, "src", "agent_loop.py"), encoding="utf-8").read()
    wrapper = src.split("async def stream_agent_loop(", 1)[1].split("async def _stream_agent_loop_impl", 1)[0]
    assert "belt_state_persist.save_soon()" in wrapper.split("finally:", 1)[1]
    app = open(os.path.join(FRONTEND, "app.py"), encoding="utf-8").read()
    assert "belt_state_persist.restore()" in app
