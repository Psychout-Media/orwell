"""P4 (Coordinator 2026-11-04, after the live double-eviction freeze): EVERY phase the engine can sit in must be either DRIVEN by the front-end (the pre-resolve +
the agent loop's advance-phase belts) or waiting on a player decision card. A phase that is entered but never driven freezes the game (found live: `twist-reveal`
sat for 34+ turns). The engine's phase list is the shared fixture `tests/fixtures/engine_status_phases.json`, itself guarded against the engine by
tests/unit/statusPhasesFixture.test.ts — so a newly added engine phase fails one of the two guards until someone decides how it is driven. Roles only."""
import importlib
import json
from pathlib import Path

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")

FIX = json.loads((Path(__file__).parent / "fixtures" / "engine_status_phases.json").read_text())
PHASES = FIX["phases"]
EXEMPT = FIX["exempt"]


def test_every_engine_phase_is_driven_by_the_preresolve():
    driven = set(ch._CEREMONY_RESOLVE_PHASES) | set(ch._COMP_DRIVE_PHASES)
    missing = [p for p in PHASES if p not in EXEMPT and p not in driven]
    assert not missing, f"phase(s) the engine can sit in but the pre-resolve never drives (a freeze): {missing}"


def test_every_engine_phase_is_an_agent_loop_advance_phase():
    missing = [p for p in PHASES if p not in EXEMPT and p not in al._ADVANCE_PHASES]
    assert not missing, f"phase(s) the stall/lull nudges do not cover (a freeze if the model under-calls advanceGame): {missing}"


def test_the_exemptions_are_real_phases_with_a_reason():
    for p, why in EXEMPT.items():
        assert p in PHASES and why.strip()


# --- behavioural: the pre-resolve actually advances each newly-driven phase (stubbed engine) ---------------------------------------------------------------------
import asyncio  # noqa: E402

import pytest  # noqa: E402

oe = importlib.import_module("src.orwell_engine")


@pytest.mark.parametrize("phase", ["twist-reveal", "battle-back", "final-eviction"])
def test_the_preresolve_advances_the_newly_driven_phases(monkeypatch, phase):
    calls = []
    board = {"phase": phase, "moment": phase, "week": 7, "started": True, "pending": None}

    async def status(user=None):
        return {"phase": phase, "pending": None}

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(1)
        return {"event": {"beat": phase, "content": "the production reveal"}, "announcements": []}

    async def get_state(user=None, **kw):
        return {**board, "phase": "hoh-competition", "moment": "hoh-competition"}

    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "advance_game", advance)
    monkeypatch.setattr(oe, "get_game_state", get_state)
    ch.clear_social_runway("u-drv")
    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(ch._pre_resolve_npc_ceremony("u-drv", dict(board), retry=False, player_msg="hello there"))
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())
    assert calls == [1], f"{phase}: the pre-resolve must drive it (one advance) — a frozen phase otherwise"
