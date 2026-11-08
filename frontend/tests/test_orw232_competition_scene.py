"""ORW-232 slice 1 (Ryne's playtest: the first HOH felt awkward - transitions in and out not role-played, it sat in its own text boxes, and it was only 2-3 boxes of who was eliminated and who won; prod logs showed
three comp rounds pre-resolved in 0.2 seconds with "wins Head of Household" never voiced): the FE hands the narrator the competition the engine walked, in ENGINE ORDER, as facts to voice as ONE continuous scene
(lead-in, every round as a beat, the winner by name, the walk back inside). The engine decides everything. Roles only."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


LOG = [
    ("comp-elimination", "Houseguest One, Houseguest Two are out; 5 remain"),
    ("comp-elimination", "Houseguest Three is out; 4 remain"),
    ("comp-elimination", "Houseguest Four, Houseguest Five are out; 2 remain"),
    ("hoh-competition", "Houseguest Six wins Head of Household"),
]


def test_the_steer_carries_every_round_in_engine_order_and_the_winner():
    t = ch._competition_scene_steer(LOG)
    assert t.index("Houseguest One") < t.index("Houseguest Three") < t.index("Houseguest Four"), "rounds must stay in engine order"
    for need in ("1. Houseguest One", "2. Houseguest Three", "3. Houseguest Four"):
        assert need in t
    assert "WINNER: Houseguest Six wins Head of Household" in t, "the winner is always handed over (and must be voiced)"


def test_the_steer_asks_for_one_continuous_scene_not_a_list_or_a_burst():
    low = ch._competition_scene_steer(LOG).lower()
    for need in ("one continuous scene", "lead-in", "every round", "in the order given", "walk back inside", "winner, by name"):
        assert need in low, need
    assert "never merge them into a list" in low and "never skip a round" in low


def test_the_steer_without_a_crown_yet_still_orders_the_rounds_and_names_no_winner():
    t = ch._competition_scene_steer(LOG[:2])
    assert "WINNER:" not in t and "1. Houseguest One" in t and "2. Houseguest Three" in t


def test_the_pre_resolve_hops_accumulate_the_whole_competition_for_the_one_scene(monkeypatch):
    """A READY player's competition is driven to its result in one pass (up to 8 hops); every hop's beat lands in the record, so the narrator is handed rounds AND the winner, never only the last beat."""
    ch.clear_social_runway("u232")
    ch._SCHEDULE_STEER.pop(ch._runway_key("u232"), None)
    seq = list(LOG)
    state = {"phase": "hoh-competition", "week": 1, "beatSeq": 1}

    async def fake_status(user=None, **kw):
        return {"beatSeq": 1, "pending": None}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        k, c = seq.pop(0)
        return {"event": {"beat": k, "content": c}, "beatSeq": 2}

    async def fake_state(user=None, **kw):
        # the phase leaves the competition only after the crown
        return dict(state, phase="nominations" if not seq else "hoh-competition")

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    _run(ch._pre_resolve_npc_ceremony("u232", dict(state), retry=False, player_msg="run it, who won?"))
    steer = ch._SCHEDULE_STEER.get(ch._runway_key("u232")) or ""
    assert "1. Houseguest One" in steer and "3. Houseguest Four" in steer, steer
    assert "WINNER: Houseguest Six wins Head of Household" in steer, steer
    assert not seq, "all four beats were walked in the one pass"


# ── the per-round box is compacted (real JS executed in Node, like test_l42) ───────────────────
import json as _json
import os as _os
import shutil as _shutil
import subprocess as _subprocess

import pytest as _pytest

_STATIC = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "static", "js")


def _outcome(tool, output):
    node = _shutil.which("node")
    if not node:
        _pytest.skip("node not available")
    mod = _os.path.join(_STATIC, "orwellToolBeats.js").replace("\\", "/")
    script = (f"import('file://{mod}').then(m => {{ const c = {_json.dumps([[tool, output]])}; "
              f"console.log(JSON.stringify(c.map(([t,o]) => m.orwellBeatOutcome(t,o)))); }});")
    p = _subprocess.run([node, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return _json.loads(p.stdout.strip().splitlines()[-1])[0]


def test_a_round_box_is_compacted_to_a_progress_line():
    out = _outcome("advanceGame", {"event": {"beat": "comp-elimination", "content": "Houseguest One, Houseguest Two are out; 5 remain"}})
    assert out == "🧗 The competition: 5 remain"
    assert "Houseguest One" not in out, "who fell is prose now, not a box"


def test_the_crown_keeps_its_full_outcome():
    out = _outcome("advanceGame", {"event": {"beat": "hoh-competition", "content": "Houseguest Six wins Head of Household"}})
    assert "Houseguest Six wins Head of Household" in out
