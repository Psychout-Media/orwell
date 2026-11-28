"""ORW-1014, prod's first real session (2026-11-28): the unbound-local crash on an act-first move, the no-call pre-filter, the casting skip and the metric gaps.
Codes and names only: no player text from prod is quoted here."""
import ast
import asyncio
import importlib
import json
import logging
import pathlib

import pytest

af = importlib.import_module("src.act_first")
ledger = importlib.import_module("src.orwell_sync_ledger")
ROOMS = ["kitchen", "living-room", "dining-room", "backyard", "hallway", "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge", "hoh-room", "storage-room", "diary-room", "landing"]
CTX = {"here": "living-room", "people": ["Levi Stone", "Dana Cole"], "room_names": {}}


def test_direct_applied_is_bound_before_the_round_loop():
    """Prod 01:48Z: an act-first move committed at the slot, the loop reached `if not _direct_applied` and raised UnboundLocalError (the turn died, no ledger row). It must be bound before the loop."""
    src = (pathlib.Path(__file__).resolve().parents[1] / "src" / "agent_loop.py").read_text()
    fn = next(n for n in ast.walk(ast.parse(src)) if isinstance(n, ast.AsyncFunctionDef) and n.name == "_stream_agent_loop_impl")
    loop_at = next(i for i, n in enumerate(fn.body) if isinstance(n, ast.For) and getattr(n.target, "id", "") == "round_num")
    bound = [n for n in fn.body[:loop_at] if isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "_direct_applied" for t in n.targets)]
    assert bound, "_direct_applied must be assigned at function level before the round loop"


@pytest.mark.parametrize("text", ["Nice to meet you all, my name is Ryne.", "Cheese and coffee, you are my kind of people", "I dont really want to pick yet, I would rather wait"])
def test_talk_with_nothing_to_ground_never_spends_a_call(text):
    assert af.can_commit_nothing(af.clean_text(text), ROOMS, CTX) is True
    calls = []

    async def call(**k):
        calls.append(k)
        return []
    d = asyncio.run(af.decide(text, ROOMS, ctx=CTX, fence="", call=call))
    assert calls == [] and d["outcome"] in ("skipped:ungrounded", "skipped:no-cue")


@pytest.mark.parametrize("text", ["I head to the kitchen", "let's look for Levi", "going to bedroom A", "I go outside to the yard", "I claim a bed in this room"])
def test_a_message_that_grounds_a_room_or_a_person_still_gets_the_call(text):
    assert af.can_commit_nothing(af.clean_text(text), ROOMS, CTX) is False


def test_an_offered_step_answer_or_sleep_keeps_the_call():
    ctx = dict(CTX, pending_kind="deal-offer")
    assert af.can_commit_nothing("yes", ROOMS, ctx) is False
    ctx = dict(CTX, sleep_ok=True)
    assert af.can_commit_nothing("I am going to bed now", ROOMS, ctx) is False
    assert af.can_commit_nothing("Hello everyone", ROOMS, ctx) is True


def test_the_prefilter_never_skips_what_the_validator_could_commit():
    """By construction: for every text the validator could commit a move/bed/search for (a room or name in the words), the filter keeps the call."""
    for room, words in (("kitchen", "the kitchen"), ("backyard", "the yard"), ("bathroom", "the toilet"), ("lounge", "the lounge"), ("bedroom-b", "bedroom B")):
        assert af.can_commit_nothing("I go to " + words, ROOMS, CTX) is False, room


class _Eng:
    async def get_game_state(self, user=None, **k):
        return {"started": False, "house": []}

    async def game_status(self, user=None):
        raise AssertionError("the casting interview must not reach the board")


def test_the_casting_interview_is_not_given_to_act_first():
    pm = importlib.import_module("src.orwell_player_move")

    async def call(**k):
        raise AssertionError("no model call in casting")

    class Sess:
        endpoint_url = "https://api.deepseek.com"
        model = "deepseek-flash"
    import os
    os.environ["ORWELL_ACT_FIRST"] = "1"
    try:
        assert asyncio.run(pm.act_first_before_narrator("I want to go to the kitchen", "u", "m", sess=Sess(), engine=_Eng(), call=call)) is False
    finally:
        os.environ.pop("ORWELL_ACT_FIRST", None)


@pytest.fixture
def led(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "l.json")
    ledger._PENDING_BELTS.clear()
    ledger._PENDING_FORCED.clear()
    ledger._RECORDED.clear()
    ledger._CASTING_TURNS.clear()
    yield ledger
    ledger._PENDING_BELTS.clear()


def test_a_turn_that_never_wrote_its_row_gets_one_and_keeps_its_own_belts(led, caplog):
    caplog.set_level(logging.INFO)
    base = led.recorded_count("u")
    led.note_belt_fire("u", "act-first:moveTo")
    led.note_belt_fire("u", "premiere-arrival-pre-release")
    led.record_unledgered_turn("u", session="s", reason="failed")
    assert led.recorded_count("u") == base  # not a ledger turn: the baseline compare in the loop is untouched
    led.record_turn("u", session="s", turn_id="2")  # the next turn: nothing leaked onto it
    rows = led.get_recent("u")
    assert rows[0]["unledgered"] == "failed" and rows[0]["drivenBy"] == "narrator" and "act-first:moveTo" in rows[0]["beltsFired"]
    assert rows[1]["beltsFired"] == {} and "unledgered" not in rows[1]
    t = led.get_driver_totals("u")
    assert t["turns"] == 2 and t["unledgeredTurns"] == 1 and t["engineFlowTurns"] == 1
    line = next(r.getMessage() for r in caplog.records if "unledgered=failed" in r.getMessage())
    assert "flow=[premiere-arrival-pre-release]" in line


def test_casting_messages_are_counted_not_rowed(led, caplog):
    caplog.set_level(logging.INFO)
    led.note_belt_fire("u", "casting-record-belt")
    led.park_pending_unledgered_turn("u")
    assert led.get_driver_totals("u")["castingTurns"] == 1 and led.get_recent("u") == []
    assert any("casting turn" in r.getMessage() for r in caplog.records)


def test_scheduled_flow_is_reported_but_never_changes_the_driver(led):
    """The written definition: premiere arrival belts are engine-scheduled flow. They were never belt-driven, and listing them does not move drivenBy or either rate."""
    belts = {"premiere-arrival-pre-release": 1, "desync-reground-voiced": 1}
    assert led.scheduled_flow_belts(belts) == ["premiere-arrival-pre-release"]
    assert led.classify_driver([], belts) == "none"
    assert led.classify_driver([], dict(belts, **{"auto-record-scene": 1})) == "belt"  # a real belt next to it still counts
    assert led.scheduled_flow_belts({"auto-record-scene": 1, "forced-advance:stall": 1}) == []  # nothing that replaces a player act or a narrator call is ever scheduled flow
