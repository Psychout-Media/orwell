"""P4b (Coordinator: 'the comp card can't appear before 12:00 on day 1 on ANY path — the readiness cue, "run the HOH comp", the stall belts'). The pre-resolve due-gate and the
belts' production_is_holding already cover the FE-issued advances; the MODEL's own `advanceGame` tool call (it was told "run the HOH competition") was the open path. While the
pre-resolve is holding a not-yet-due scheduled event for this player, the model's advanceGame is answered with an in-fiction 'production hasn't called the house in yet'
note and NOTHING is advanced. When nothing is held (due / released by the logged cap / no clock) the call goes through unchanged. Roles only."""
import asyncio
import importlib
import json

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")
ti = importlib.import_module("src.tool_implementations")


def _run(c):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(c)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.fixture(autouse=True)
def _clean():
    ch.clear_social_runway("u-gate")
    yield
    ch.clear_social_runway("u-gate")


def _stub(monkeypatch):
    calls = []

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(1)
        return {"started": True, "event": {"beat": "hoh-competition", "content": "x"}, "pending": None}

    monkeypatch.setattr(oe, "advance_game", advance)
    return calls


def test_a_held_event_blocks_the_models_own_advance(monkeypatch):
    calls = _stub(monkeypatch)
    ch._PRODUCTION_HOLD[ch._runway_key("u-gate")] = ("1:hoh-competition", 3)
    res = _run(ti.do_advance_game("", owner="u-gate"))
    assert calls == [], "the model must not be able to start a not-yet-due event"
    out = json.loads(res["output"]) if res["output"].lstrip().startswith("{") else {"note": res["output"]}
    assert "production" in json.dumps(out).lower() and "not yet" in json.dumps(out).lower().replace("hasn't", "not yet") or "yet" in json.dumps(out).lower()
    assert res.get("exit_code", 0) == 0


def test_nothing_held_the_advance_goes_through(monkeypatch):
    calls = _stub(monkeypatch)
    _run(ti.do_advance_game("", owner="u-gate"))
    assert calls == [1]


def test_the_premiere_count_alone_does_not_block_the_models_advance(monkeypatch):
    """The champagne-circle close IS the model's first advanceGame during the premiere — only a pre-resolve-held SCHEDULED event blocks the lever."""
    calls = _stub(monkeypatch)
    ch.note_premiere_turn("u-gate", {"started": True, "phase": "premiere"})
    assert ch.premiere_is_holding("u-gate") is True
    _run(ti.do_advance_game("", owner="u-gate"))
    assert calls == [1]
