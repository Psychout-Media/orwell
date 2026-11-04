"""PO direction (Ryne, 2026-11-04): PRODUCTION owns the schedule. The player can NOT fire a competition or ceremony early - not with a readiness cue (#2041),
not with "run the veto competition" (#2044's ready-player drive), not by the social runway simply running out. An event fires only at/after its scheduled
in-game time (the engine's `daySchedule.due`); before then the turn stays social with an in-fiction "production hasn't called it yet" cue. Once due, resolving
it (incl. the one-pass competition drive) is unchanged. No `daySchedule` (clock off) => the old behavior exactly. Roles only."""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")


def _run(c):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(c)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.fixture(autouse=True)
def _clean():
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None); ch._PRODUCTION_HOLD.clear()
    yield
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None)


def _state(phase="veto-competition", due=False, with_schedule=True, **kw):
    st = {"phase": phase, "moment": phase, "week": 1, "started": True, "pending": None}
    if with_schedule:
        st["daySchedule"] = {"next": phase, "phase": "afternoon", "due": due}
    st.update(kw)
    return st


def _wire(monkeypatch, rounds=3, due_after_first=False):
    calls = []
    board = {"phase": "veto-competition", "moment": "veto-competition", "week": 1, "started": True, "pending": None,
             "daySchedule": {"next": "veto-competition", "phase": "afternoon", "due": True}}

    async def status(user=None):
        return {"phase": board["phase"], "pending": board["pending"]}

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(len(calls) + 1)
        if len(calls) >= rounds:
            board.update(phase="veto-ceremony", moment="veto-ceremony")
            board["daySchedule"] = {"next": "veto-ceremony", "phase": "afternoon", "due": True}
        return {"event": {"beat": "veto-competition" if len(calls) >= rounds else "comp-round", "content": f"b{len(calls)}"}, "announcements": []}

    async def state(user=None, **kw):
        return dict(board)

    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "advance_game", advance)
    monkeypatch.setattr(oe, "get_game_state", state)
    return calls


def _spent(st, user="u"):
    ch._RUNWAY_LAST_DONE[ch._runway_key(user)] = ch._runway_sig(st)


@pytest.mark.parametrize("msg", ["Run the veto competition. Who won?", "Go to the veto ceremony.", "Let's go! I'm ready.", "run it", "Continue."])
def test_a_ready_player_cannot_fire_a_competition_before_its_scheduled_time(monkeypatch, msg):
    calls = _wire(monkeypatch)
    st = _state(due=False)
    out = _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg=msg))
    assert calls == [], "nothing may fire before the scheduled time"
    assert out.get("moment") == "social", "the turn stays social"
    steer = ch._SCHEDULE_STEER.get(ch._runway_key("u"), "")
    assert "hasn't called" in steer.lower() or "has not called" in steer.lower(), steer


def test_a_lingering_player_does_not_fire_it_either_when_the_runway_simply_runs_out(monkeypatch):
    calls = _wire(monkeypatch)
    st = _state(due=False)
    _spent(st)  # the runway for this beat is spent: before this fix that fired the event whatever the clock said
    _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="I chat with Sam by the couch."))
    assert calls == []


def test_once_due_the_ready_player_gets_the_one_pass_drive(monkeypatch):
    calls = _wire(monkeypatch, rounds=3)
    st = _state(due=True)
    _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="Run the veto competition. Who won?"))
    assert len(calls) == 3, "due: the competition runs to its result in one pass (#2044 unchanged)"
    assert ch._SCHEDULE_STEER.get(ch._runway_key("u")) is None


def test_once_due_a_lingering_player_still_has_the_event_fire_when_the_runway_is_spent(monkeypatch):
    calls = _wire(monkeypatch, rounds=1)
    st = _state(due=True)
    _spent(st)
    _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="I chat with Sam by the couch."))
    assert len(calls) == 1, "the clock brings the due event in on its own"


def test_no_day_schedule_means_the_old_behaviour_exactly(monkeypatch):
    calls = _wire(monkeypatch, rounds=3)
    st = _state(with_schedule=False)
    _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="Run the veto competition. Who won?"))
    assert len(calls) == 3


def test_the_staged_eviction_after_the_reveal_is_never_held_by_the_schedule(monkeypatch):
    calls = _wire(monkeypatch)
    st = _state(phase="eviction", due=False, eviction={"stage": "goodbye", "nominees": [], "votesRevealed": []})
    _spent(st)
    _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="Continue."))
    assert len(calls) == 1, "mid-eviction beats (goodbyes, exit interview) ride the night already started"


def test_a_day_break_is_consumed_but_the_ceremony_behind_it_is_held_until_due(monkeypatch):
    calls = []
    board = {"phase": "nominations", "moment": "nominations", "week": 1, "started": True, "pending": None,
             "daySchedule": {"next": "nominations", "phase": "afternoon", "due": True}}

    async def status(user=None):
        return {"phase": board["phase"], "pending": None}

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(1)
        if len(calls) == 1:  # the night gate: crosses to the next morning, where the nominations are NOT yet due
            board["daySchedule"] = {"next": "nominations", "phase": "afternoon", "due": False}
            return {"event": {"beat": "day-break", "content": "A new day dawns."}, "announcements": []}
        raise AssertionError("the ceremony fired before its scheduled time")

    async def state(user=None, **kw):
        return dict(board)

    monkeypatch.setattr(oe, "game_status", status); monkeypatch.setattr(oe, "advance_game", advance); monkeypatch.setattr(oe, "get_game_state", state)
    out = _run(ch._pre_resolve_npc_ceremony("u", dict(board), retry=False, player_msg="Let's go ahead to the nominations ceremony."))
    assert len(calls) == 1 and out.get("moment") == "social"


def test_a_schedule_without_a_due_flag_never_holds(monkeypatch):
    calls = _wire(monkeypatch, rounds=1)
    st = _state(due=False)
    st["daySchedule"] = {"next": "veto-competition", "phase": "afternoon"}  # unknown - the old behavior, never a silent hold
    _spent(st)
    _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="I chat."))
    assert len(calls) == 1


def test_a_stuck_clock_is_released_after_a_logged_safety_cap(monkeypatch):
    calls = _wire(monkeypatch, rounds=1)
    soft = []
    lr = importlib.import_module("src.log_rings")
    monkeypatch.setattr(lr, "record_soft_failure", lambda *a, **k: soft.append(a[0]))
    st = _state(due=False)
    for i in range(ch._PRODUCTION_HOLD_CAP):
        _run(ch._pre_resolve_npc_ceremony("u", dict(st), retry=False, player_msg="I chat."))
    assert calls == [] and ch.production_is_holding("u")
    _run(ch._pre_resolve_npc_ceremony("u", dict(st), retry=False, player_msg="I chat."))
    assert len(calls) == 1, "the cap releases the event so a stuck clock cannot hang the game"
    assert soft == ["production:hold-cap-hit"] and not ch.production_is_holding("u")


def test_a_due_event_fires_even_mid_runway(monkeypatch):
    """Production interrupts: once due it fires even while a social runway still has turns left."""
    calls = _wire(monkeypatch, rounds=1)
    st = _state(due=True)
    ch._arm_runway("u", ch._runway_sig(st))
    _run(ch._pre_resolve_npc_ceremony("u", dict(st), retry=False, player_msg="I chat with Sam."))
    assert len(calls) == 1


def test_the_agent_loop_treats_a_production_hold_as_holding():
    import os
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = open(os.path.join(base, "src", "agent_loop.py"), encoding="utf-8").read()
    assert "_ch.production_is_holding(owner)" in src


def test_the_hold_cap_and_premiere_window_are_rebased_to_the_five_minute_pace():
    """~48 ordinary messages per 4h block: the safety hold cap must sit well above one block, and the premiere hold must be a full morning (never released early)."""
    assert ch._PREMIERE_SOCIAL_MESSAGES >= 48
    assert ch._PRODUCTION_HOLD_CAP >= 2 * ch._PREMIERE_SOCIAL_MESSAGES, "a hold cap is never reached in ordinary play (a stuck clock only)"
