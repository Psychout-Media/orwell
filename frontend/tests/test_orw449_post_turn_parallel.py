"""ORW-449: the two side records made after a narrated turn (room canon, open ledger) run ALONGSIDE the consequence belts.

Measured on a real 65-turn game the helper model calls after a turn ran strictly one after another (median 2.9 s, p90 5.6 s per
turn). Neither side record moves the beat counter or reads what the belts write, so they no longer have to finish before the first
belt starts. The belt chain itself is untouched. These tests drive the REAL `stream_agent_loop`.

Roles only - no houseguest names from any corpus.
"""
import asyncio
import json

import pytest

from tests.test_bank_scene_on_progressed_turn import ROSTER, SCENE, _reset_belt_state  # noqa: F401  (autouse fixture)


def _drive(monkeypatch, *, parallel=True, canon=None, ledger=None, belt=None):
    """One player turn through the real loop. Returns the ordered event log: "<lane>+" when a lane starts, "<lane>-" when it ends,
    "done" when the turn's stream has finished. `canon` / `ledger` / `belt` override a lane's body (an async callable)."""
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.orwell_open_ledger as ol
    import src.orwell_room_canon as rc
    import src.tool_index as ti

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.delenv("ORWELL_FLAGS_OFF", raising=False)
    if parallel:
        monkeypatch.delenv("ORWELL_POST_TURN_PARALLEL", raising=False)
    else:
        monkeypatch.setenv("ORWELL_POST_TURN_PARALLEL", "0")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: False)

    async def fake_state(owner=None, **_k):
        return {"phase": "premiere", "moment": "premiere", "week": 1, "beatSeq": 1, "pending": None, "house": ROSTER, "started": True}

    async def fake_advance(*a, **k):
        return {"beatSeq": 2, "phase": "hoh-competition", "pending": None, "event": None}

    async def fake_engine_record(*a, **k):
        return {"eventId": "e1"}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "advance_game", fake_advance)
    monkeypatch.setattr(oe, "record_interaction", fake_engine_record)

    ev: list = []
    seen: dict = {}

    def lane(name, pause, override):
        async def run(*a, **k):
            ev.append(name + "+")
            seen.setdefault(name, []).append(a[0] if a else None)
            if override is not None:
                await override()
            else:
                await asyncio.sleep(pause)
            ev.append(name + "-")
            return True
        return run

    monkeypatch.setattr(rc, "after_turn", lane("canon", 0.05, canon))
    monkeypatch.setattr(ol, "after_turn", lane("ledger", 0.05, ledger))
    monkeypatch.setattr(al, "_auto_record_scene", lane("belt", 0.02, belt))

    async def _noop(*a, **k):
        return False

    for n in ("_auto_record_deal", "_auto_confide", "_auto_expose_secret", "_auto_trade_secret"):
        monkeypatch.setattr(al, n, _noop)
    monkeypatch.setattr(al, "_note_belt", lambda *a, **k: None)

    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: ' + json.dumps({"delta": SCENE}) + '\n\n'
        yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        gen = al.stream_agent_loop(
            "https://api.deepseek.com/chat/completions", "deepseek-flash",
            [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": "I call out Contestant Alpha in front of everyone."}],
            max_rounds=3, game_mode="game", owner="u")
        async for _ in gen:
            pass
        ev.append("done")

    asyncio.get_event_loop().run_until_complete(drive())
    return ev, seen


def _first(ev, name):
    assert name in ev, f"{name} never happened: {ev}"
    return ev.index(name)


def test_the_side_records_run_alongside_the_belt_chain_and_each_other(monkeypatch):
    ev, _ = _drive(monkeypatch)
    # each lane started before the others had finished: they overlap instead of queueing
    assert _first(ev, "ledger+") < _first(ev, "canon-")
    assert _first(ev, "canon+") < _first(ev, "ledger-")
    assert _first(ev, "canon+") < _first(ev, "belt-")
    assert _first(ev, "belt+") < _first(ev, "canon-")   # the belt no longer waits for the side records to finish
    # ... and the turn does not end until every lane has
    done = _first(ev, "done")
    assert max(_first(ev, "canon-"), _first(ev, "ledger-"), _first(ev, "belt-")) < done


def test_the_switch_restores_one_after_another(monkeypatch):
    ev, _ = _drive(monkeypatch, parallel=False)
    order = [e for e in ev if e != "done"]
    assert order[:6] == ["canon+", "canon-", "ledger+", "ledger-", "belt+", "belt-"], order


def test_both_modes_hand_every_lane_the_same_input(monkeypatch):
    _, together = _drive(monkeypatch)
    _, in_turn = _drive(monkeypatch, parallel=False)
    assert together == in_turn and set(together) == {"canon", "ledger", "belt"}
    assert all(len(v) == len(in_turn[k]) for k, v in together.items())  # same number of calls per lane


def test_a_side_record_that_fails_does_not_stop_the_other_lanes_or_the_turn(monkeypatch):
    async def boom():
        raise RuntimeError("room canon failed")

    ev, _ = _drive(monkeypatch, canon=boom)
    assert "canon-" not in ev
    assert "ledger-" in ev and "belt-" in ev and ev[-1] == "done"


def test_a_slow_side_record_holds_the_end_of_the_turn_but_not_the_belt(monkeypatch):
    async def slow():
        await asyncio.sleep(0.2)

    ev, _ = _drive(monkeypatch, ledger=slow)
    assert _first(ev, "belt-") < _first(ev, "ledger-") < _first(ev, "done")


def test_a_cancelled_turn_does_not_leave_its_side_records_running(monkeypatch):
    async def cancelled():
        await asyncio.sleep(0.01)   # let the side records start
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        _drive(monkeypatch, belt=cancelled)


def test_a_cancelled_turn_cancels_the_side_records_mid_call(monkeypatch):
    ev: list = []

    async def cancelled():
        await asyncio.sleep(0.01)
        raise asyncio.CancelledError()

    async def watch():
        try:
            await asyncio.sleep(5)
        except asyncio.CancelledError:
            ev.append("side-cancelled")
            raise

    with pytest.raises(asyncio.CancelledError):
        _drive(monkeypatch, belt=cancelled, canon=watch, ledger=watch)
    assert ev == ["side-cancelled", "side-cancelled"]


def test_the_flag_reads_default_on_and_obeys_the_global_off_switch(monkeypatch):
    from src import agent_loop as al
    monkeypatch.delenv("ORWELL_FLAGS_OFF", raising=False)
    monkeypatch.delenv("ORWELL_POST_TURN_PARALLEL", raising=False)
    assert al._post_turn_parallel_enabled() is True
    for off in ("0", "false", "no", "off"):
        monkeypatch.setenv("ORWELL_POST_TURN_PARALLEL", off)
        assert al._post_turn_parallel_enabled() is False
    monkeypatch.setenv("ORWELL_POST_TURN_PARALLEL", "1")
    monkeypatch.setenv("ORWELL_FLAGS_OFF", "1")
    assert al._post_turn_parallel_enabled() is False
