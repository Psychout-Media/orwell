"""ORW-499 — a turn still running when the season restarts must not write last season's pacing state back.

The restart usually happens INSIDE a turn (the model calls createCharacter with a confirmed restart and the
same agent loop keeps running), so its stall / force-advance writes land AFTER the season-reset listener has
cleared the stores. A per-owner season generation is bumped by the reset; a turn that began in an older
generation clears the pacing stores again when it ends. Roles only; no names.
"""

import asyncio
import importlib

import pytest

agent_loop = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")

_PLAYER = "u-orw499-player"
_OTHER = "u-orw499-other"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _write_old_season_pacing(owner):
    key = agent_loop._belt_key(owner)
    agent_loop._ADVANCE_STALL_LEVEL[key] = 3
    agent_loop._TURNS_SINCE_PROGRESS[key] = 9
    agent_loop._SILENT_FORCE_ADVANCE_STREAK[key] = 2
    return key


@pytest.fixture(autouse=True)
def _clean():
    def wipe():
        for owner in (_PLAYER, _OTHER):
            for store in agent_loop._SEASON_PACING_STORES:
                for key in (owner, agent_loop._belt_key(owner)):
                    try:
                        store.pop(key, None)
                    except Exception:
                        pass
    wipe()
    yield
    wipe()


def _drive_turn(monkeypatch, body, owner=_PLAYER):
    async def fake_impl(*a, **kw):
        await body()
        yield "data: x\n\n"
    monkeypatch.setattr(agent_loop, "_stream_agent_loop_impl", fake_impl)

    async def go():
        return [e async for e in agent_loop.stream_agent_loop(owner=owner)]
    return _run(go())


def _stub_create(monkeypatch):
    async def fake_call(tool, args, user=None, **kw):
        return {"started": True, "phase": "premiere"}
    monkeypatch.setattr(orwell_engine, "_call", fake_call)


def test_a_turn_that_restarts_the_season_leaves_the_pacing_stores_empty(monkeypatch):
    _stub_create(monkeypatch)
    key = agent_loop._belt_key(_PLAYER)

    async def body():
        _write_old_season_pacing(_PLAYER)  # season 1 pacing, before the restart tool
        await orwell_engine.create_character("The Player", confirm_restart=True, user=_PLAYER)
        _write_old_season_pacing(_PLAYER)  # the same loop keeps running and writes AFTER the reset

    _drive_turn(monkeypatch, body)
    assert key not in agent_loop._ADVANCE_STALL_LEVEL
    assert key not in agent_loop._TURNS_SINCE_PROGRESS
    assert key not in agent_loop._SILENT_FORCE_ADVANCE_STREAK


def test_a_turn_with_no_restart_keeps_its_pacing_state(monkeypatch):
    async def body():
        _write_old_season_pacing(_PLAYER)

    _drive_turn(monkeypatch, body)
    assert agent_loop._ADVANCE_STALL_LEVEL[agent_loop._belt_key(_PLAYER)] == 3


def test_another_owners_restart_does_not_clear_this_owners_turn(monkeypatch):
    _stub_create(monkeypatch)

    async def body():
        _write_old_season_pacing(_PLAYER)
        await orwell_engine.create_character("The Player", confirm_restart=True, user=_OTHER)

    _drive_turn(monkeypatch, body)
    assert agent_loop._ADVANCE_STALL_LEVEL[agent_loop._belt_key(_PLAYER)] == 3


def test_a_turn_begun_after_the_restart_keeps_its_writes(monkeypatch):
    _stub_create(monkeypatch)
    _run(orwell_engine.create_character("The Player", confirm_restart=True, user=_PLAYER))

    async def body():
        _write_old_season_pacing(_PLAYER)

    _drive_turn(monkeypatch, body)
    assert agent_loop._ADVANCE_STALL_LEVEL[agent_loop._belt_key(_PLAYER)] == 3
