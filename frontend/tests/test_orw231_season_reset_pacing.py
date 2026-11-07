"""ORW-231 — a new season must not inherit the last season's agent-loop pacing state.

The agent loop keeps per-owner pacing counters in process memory, keyed only by the owner: the
force-advance streak (`_SILENT_FORCE_ADVANCE_STREAK`), the anti-stale cap holds, the stall level and
flags, the loop-break streak, and their kin. A new season for the same owner (a confirmed restart, the
next season, `/api/orwell/new-game`, a God-Mode sandbox reset) inherited all of it, so leftover state
from season 1 could decide whether season 2 advanced early (found while fixing the a64 test, PR #2281).
`chat_helpers` holds the same kind of turn-steering state (the armed S1b forced-advance escalation, the
social runway and production holds, the cut streak, an owed chyron, the queued next-turn re-grounds).

Every season the engine creates goes through `orwell_engine.create_character` (both restart doors) or
the God-Mode `manage_sandbox("reset")`, which notify `on_season_reset` listeners. These gates pin that
both modules register a reset listener there, that two seasons back to back leave the second starting
at zero, that another player's state is untouched, that a REFUSED create (the live season continues)
keeps its state, and that no per-owner store can be added to the agent loop without joining the reset.

Roles only; no names.
"""

import importlib
import os
import re

import pytest

agent_loop = importlib.import_module("src.agent_loop")
chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_PLAYER = "u-orw231-player"
_OTHER = "u-orw231-other"


def _run(coro):
    import asyncio
    return asyncio.get_event_loop().run_until_complete(coro)


# The agent loop's per-owner pacing stores and a season-1 value for each (what a long stall leaves behind).
_AGENT_STORES = {
    "_FIRST_WEEK_HINT": True,
    "_CASTING_STALL_LEVEL": 2,
    "_CASTING_SUBSTANCE_LEVEL": 1,
    "_TOAST_VOICE_HOLDS": 2,
    "_DEFERRED_FAITH": ["a deferred faith check"],
    "_ADVANCE_STALL_LEVEL": 3,
    "_ADVANCE_STALL_FLAGS": 5,
    "_TURNS_SINCE_PROGRESS": 9,
    "_SILENT_FORCE_ADVANCE_STREAK": 2,
    "_ANTI_STALE_CAP_HOLDS": 2,
    "_LOOP_LAST_FRAMED_KEY": ("w3", "eviction", "eviction"),
    "_LOOP_STREAK": 3,
    "_LOOP_BREAK_PENDING_NOTE": "loop-break-advance",
    "_POSTSEASON_OFFTOPIC_TURNS": 2,
    "_REAPPROACH_LEVEL": 1,
}


def _keys_for(owner):
    """Every key the agent loop's stores use for one owner (`_belt_key`, raw, `or ""`, the faith key)."""
    keys = {owner, owner or "", agent_loop._belt_key(owner), agent_loop._faith_key(owner)}
    return keys


def _seed_season_one(owner):
    for name, value in _AGENT_STORES.items():
        store = getattr(agent_loop, name)
        for key in _keys_for(owner):
            store[key] = value
    # chat_helpers turn-steering state
    chat_helpers._arm_advance_escalation(owner)
    rk = chat_helpers._runway_key(owner)
    chat_helpers._RUNWAY_LEFT[rk] = 2
    chat_helpers._RUNWAY_SIG[rk] = "3:nominations"
    chat_helpers._PRODUCTION_HOLD[rk] = ("3:veto", 4)
    chat_helpers._PREMIERE_MSGS[rk] = 40
    chat_helpers._PREMIERE_CLOCK_STARTED.add(rk)
    chat_helpers._PREMIERE_ENTRANCE_STAGE[rk] = "entrances"
    chat_helpers._PREMIERE_RELEASED_THIS_TURN.add(rk)
    chat_helpers._PENDING_CHYRON[rk] = [{"id": "ann:old-season"}]
    dkey = chat_helpers._desync_key(owner)
    chat_helpers._CUT_STREAK[dkey] = {"count": 2, "seen": None, "cut": None, "line": "an old board"}
    chat_helpers._DESYNC_REGROUND[dkey] = "RE-GROUND ON WHO IS ON THE BLOCK — an old-season correction"


def _assert_season_starts_at_zero(owner):
    for name in _AGENT_STORES:
        store = getattr(agent_loop, name)
        for key in _keys_for(owner):
            assert key not in store, f"{name}[{key!r}] survived into the new season: {store.get(key)!r}"
    assert not chat_helpers.advance_escalation_armed(owner)
    rk = chat_helpers._runway_key(owner)
    for store in (chat_helpers._RUNWAY_LEFT, chat_helpers._RUNWAY_SIG, chat_helpers._PRODUCTION_HOLD,
                  chat_helpers._PREMIERE_MSGS, chat_helpers._PREMIERE_ENTRANCE_STAGE, chat_helpers._PENDING_CHYRON):
        assert rk not in store
    assert rk not in chat_helpers._PREMIERE_CLOCK_STARTED
    assert rk not in chat_helpers._PREMIERE_RELEASED_THIS_TURN
    dkey = chat_helpers._desync_key(owner)
    assert dkey not in chat_helpers._CUT_STREAK
    assert dkey not in chat_helpers._DESYNC_REGROUND


@pytest.fixture(autouse=True)
def _clean():
    def wipe():
        for owner in (_PLAYER, _OTHER, None):
            for name in _AGENT_STORES:
                for key in _keys_for(owner):
                    getattr(agent_loop, name).pop(key, None)
            rk = chat_helpers._runway_key(owner)
            dkey = chat_helpers._desync_key(owner)
            chat_helpers.clear_social_runway(owner)
            chat_helpers.clear_advance_escalation(owner)
            chat_helpers.clear_preresolve_debt(owner)
            chat_helpers._PREMIERE_ENTRANCE_STAGE.pop(rk, None)
            chat_helpers._PREMIERE_RELEASED_THIS_TURN.discard(rk)
            chat_helpers._CUT_STREAK.pop(dkey, None)
            chat_helpers._DESYNC_REGROUND.pop(dkey, None)
    wipe()
    yield
    wipe()


def _stub_engine_create(monkeypatch, result):
    calls = []

    async def fake_call(tool, args, user=None, **kw):
        calls.append((tool, user))
        return result
    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    return calls


# ── both modules listen for a new season ─────────────────────────────────────────────────────────── #

def test_the_agent_loop_and_chat_helpers_register_a_season_reset_listener():
    assert agent_loop._forget_season_pacing in orwell_engine._SEASON_RESET_LISTENERS
    assert chat_helpers._forget_season_pacing in orwell_engine._SEASON_RESET_LISTENERS


# ── two seasons back to back: the second starts at zero ─────────────────────────────────────────── #

def test_a_new_season_starts_with_no_pacing_state_from_the_last(monkeypatch):
    _seed_season_one(_PLAYER)
    _seed_season_one(_OTHER)
    _stub_engine_create(monkeypatch, {"started": True, "phase": "premiere"})
    _run(orwell_engine.create_character("The Player", confirm_restart=True, user=_PLAYER))
    _assert_season_starts_at_zero(_PLAYER)
    # another player's season is untouched (cross-user isolation)
    assert agent_loop._SILENT_FORCE_ADVANCE_STREAK[agent_loop._belt_key(_OTHER)] == 2
    assert agent_loop._ANTI_STALE_CAP_HOLDS[agent_loop._belt_key(_OTHER)] == 2
    assert chat_helpers.advance_escalation_armed(_OTHER)


def test_single_tenant_new_season_starts_at_zero(monkeypatch):
    """AUTH_ENABLED=false: owner is None and the stores key on the "default" sentinel (and `""`)."""
    _seed_season_one(None)
    _stub_engine_create(monkeypatch, {"started": True, "phase": "premiere"})
    _run(orwell_engine.create_character("The Player", confirm_restart=True, user=None))
    _assert_season_starts_at_zero(None)


def test_a_refused_create_keeps_the_live_season_state(monkeypatch):
    """A refusal (a game in progress, casting incomplete) leaves the live season running, so its
    pacing state must survive."""
    _seed_season_one(_PLAYER)
    _stub_engine_create(monkeypatch, {"started": True, "createRefused": "in-progress"})
    _run(orwell_engine.create_character("The Player", user=_PLAYER))
    assert agent_loop._SILENT_FORCE_ADVANCE_STREAK[agent_loop._belt_key(_PLAYER)] == 2
    assert chat_helpers.advance_escalation_armed(_PLAYER)


def test_a_god_mode_sandbox_reset_also_starts_at_zero(monkeypatch):
    _seed_season_one(_PLAYER)

    async def fake_admin_call(tool, args, user=None, **kw):
        return {"ok": True}
    monkeypatch.setattr(orwell_engine, "_admin_call", fake_admin_call)
    _run(orwell_engine.manage_sandbox("reset", user=_PLAYER))
    _assert_season_starts_at_zero(_PLAYER)


def test_the_new_game_route_starts_its_season_through_create_character():
    """`/api/orwell/new-game` reaches the reset through `orwell_engine.create_character` (it notifies)."""
    with open(os.path.join(FRONTEND, "routes", "orwell_routes.py"), encoding="utf-8") as fh:
        src = fh.read()
    body = src[src.index("async def orwell_new_game("):]
    body = body[:body.index("@router.", 10)]
    assert "await orwell_engine.create_character(" in body


# ── the anti-stale belt: season 1's streak can no longer hold season 2's first advance ──────────── #

def test_season_twos_first_stall_is_not_held_by_season_ones_streak(monkeypatch):
    """The leaked state's effect: at the cap, the anti-stale belt HOLDS the next silent forced advance.
    After a new season the streak reads zero, so the hold cannot fire on season 2's first stall."""
    key = agent_loop._belt_key(_PLAYER)
    agent_loop._SILENT_FORCE_ADVANCE_STREAK[key] = agent_loop._SILENT_FORCE_ADVANCE_CAP
    assert agent_loop._SILENT_FORCE_ADVANCE_STREAK.get(key, 0) >= agent_loop._SILENT_FORCE_ADVANCE_CAP
    _stub_engine_create(monkeypatch, {"started": True, "phase": "premiere"})
    _run(orwell_engine.create_character("The Player", confirm_restart=True, user=_PLAYER))
    assert agent_loop._SILENT_FORCE_ADVANCE_STREAK.get(key, 0) < agent_loop._SILENT_FORCE_ADVANCE_CAP


# ── completeness: a new per-owner store cannot dodge the reset ──────────────────────────────────── #

def test_every_per_owner_store_in_the_agent_loop_joins_the_season_reset():
    """Any module-level store declared empty in agent_loop.py (`_NAME: Dict[...] = {}`, `= set()`) is
    per-owner process state; it must be in `_SEASON_PACING_STORES` so a new season starts it at zero."""
    with open(os.path.join(FRONTEND, "src", "agent_loop.py"), encoding="utf-8") as fh:
        src = fh.read()
    declared = set(re.findall(r"^(_[A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=\s*(?:\{\}|dict\(\)|set\(\))", src, re.MULTILINE))
    assert declared, "the scan found no stores (the declaration style changed?)"
    reset = {name for name, value in vars(agent_loop).items()
             if any(value is store for store in agent_loop._SEASON_PACING_STORES)}
    missing = declared - reset
    assert not missing, f"per-owner stores not reset on a new season: {sorted(missing)}"
