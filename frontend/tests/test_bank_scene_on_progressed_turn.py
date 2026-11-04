"""A real talk COUNTS even when the same turn advances (Ryne 2026-11-04: "if you have a real talk and say let's move on in the same message, the talk still counts").

Live finding (A-7, DeepSeek playtest): in 8 of 8 public-confrontation turns neither the model nor the
auto-record-scene belt wrote the scene to the consequence loop. Root cause: on the premiere's third
same-gate turn the L-F3 loop-break fires `forced-advance`, which commits the beat SILENTLY and ENDS the turn
(`break`) — so the finishing block that runs `_auto_record_scene` was never reached ("narrated but never
recorded"). The fix banks the shown scene BEFORE the silent commit. This drives the REAL `stream_agent_loop`.

Roles only — no houseguest names from any corpus.
"""
import asyncio
import json
import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_LEVERS = {}  # the per-test lists the A-10b back-fill fakes append to

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"}]
SCENE = ("The dining room goes quiet. Contestant Alpha sets down a fork and answers the accusation "
         "flatly, eyes on you, while Contestant Beta watches from the far end of the table.")


import pytest


@pytest.fixture(autouse=True)
def _reset_belt_state():
    """The belt ladders keep per-owner module state (silent-force streak, stall level, anti-stale holds);
    earlier forced advances in this file would otherwise trip the anti-stale CAP and hold the next one."""
    from src import agent_loop as al
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
                 "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    yield


def _drive(monkeypatch, *, tools, scene=SCENE, user_msg="I call out Contestant Alpha, then say: okay, let's move on."):
    """One player turn through the REAL stream_agent_loop. `tools` = the tool names the MODEL calls in round 1 (e.g. ["advanceGame"])."""
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.tool_index as ti

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: False)

    async def fake_state(owner=None, **_k):
        return {"phase": "premiere", "moment": "premiere", "week": 1, "beatSeq": 1, "pending": None,
                "house": ROSTER, "started": True}

    advanced = []

    async def fake_advance(*a, **k):
        advanced.append(1)
        return {"beatSeq": 2, "phase": "hoh-competition", "pending": None, "event": None}

    async def fake_engine_record(*a, **k):
        return {"eventId": "e1"}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "advance_game", fake_advance)
    monkeypatch.setattr(oe, "record_interaction", fake_engine_record)

    recorded = []

    async def fake_record(narration, last_user, house, *a, **k):
        recorded.append(narration)
        return True

    async def _noop(*a, **k):
        return False

    monkeypatch.setattr(al, "_auto_record_scene", fake_record)
    for n in ("_auto_record_deal", "_auto_confide", "_auto_expose_secret", "_auto_trade_secret"):
        monkeypatch.setattr(al, n, _noop)
    monkeypatch.setattr(al, "_note_belt", lambda *a, **k: None)

    rounds = {"n": 0}

    async def fake_stream(candidates, messages, **kwargs):
        i = rounds["n"]
        rounds["n"] += 1
        yield 'data: ' + json.dumps({"delta": scene}) + '\n\n'
        if i == 0 and tools:
            yield 'data: ' + json.dumps({"type": "tool_calls", "calls": [
                {"id": f"c{k}", "name": t, "arguments": "{}"} for k, t in enumerate(tools)]}) + '\n\n'
        yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        gen = al.stream_agent_loop(
            "https://api.deepseek.com/chat/completions", "deepseek-flash",
            [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": user_msg}],
            max_rounds=3, game_mode="game", owner="u")
        async for _ in gen:
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return recorded, advanced


def test_a_real_talk_plus_a_model_advance_in_one_turn_is_banked_exactly_once(monkeypatch):
    recorded, advanced = _drive(monkeypatch, tools=["advanceGame"])
    assert advanced, "precondition: the MODEL advanced the beat in this turn"
    assert len(recorded) == 1, f"the talk must still count: exactly one fold, got {len(recorded)}"


def test_a_real_talk_alone_is_banked_once(monkeypatch):
    recorded, advanced = _drive(monkeypatch, tools=[])  # (the stall belt may advance; irrelevant here)
    assert len(recorded) == 1


def test_a_solo_scene_plus_a_model_advance_banks_nothing(monkeypatch):
    recorded, advanced = _drive(monkeypatch, tools=["advanceGame"], scene=SOLO_SCENE, user_msg="I sit alone, then move on.")
    assert advanced
    assert recorded == []


def test_a_scene_the_model_already_recorded_is_not_folded_twice(monkeypatch):
    recorded, advanced = _drive(monkeypatch, tools=["recordInteraction", "advanceGame"])
    assert advanced
    assert recorded == [], "the model's own recordInteraction wins; the belt must not double-fold"


SOLO_SCENE = "The backyard is empty. You sit on the grass and watch the light move across the pool."


def test_a_bare_move_on_with_no_talk_is_not_a_scene(monkeypatch):
    """Control: the readiness cue alone carries no talk - nothing to bank."""
    recorded, advanced = _drive(monkeypatch, tools=["advanceGame"], scene=SOLO_SCENE, user_msg="let's move on")
    assert recorded == []


def test_the_talk_detector_needs_substance_beyond_the_cue():
    from src import agent_loop as al
    m = lambda s: [{"role": "user", "content": s}]
    assert al._lull_message_carries_talk(m("I confront Contestant Alpha about the lie. Okay, let's move on."))
    assert not al._lull_message_carries_talk(m("let's move on"))
    assert not al._lull_message_carries_talk(m("ok, I'm ready"))
