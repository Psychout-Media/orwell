"""A65 / ORW-97 — the FE reads the engine's typed `held` from advanceGame (ORWELL_ADVANCE_GATE) instead of treating it as a silent no-op advance.

The engine refuses an ordinary beat before the schedule says an event is due and returns `held: {next, minutesUntil}` (nothing committed, beatSeq unchanged).
The FE must (a) give the MODEL a clear tool result carrying `held` + the next due time so it narrates the wait, (b) arm the production hold so the stall-nudge /
forced-advance ladder does not re-force an advance the engine is holding (no spin), (c) keep the pre-resolve social, not 'pre-resolved'. Roles only."""
import asyncio
import importlib
import json

import pytest

ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")
ti = importlib.import_module("src.tool_implementations")

HELD = {"started": True, "beatSeq": 7, "held": {"next": "veto-competition", "minutesUntil": 95}}


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


@pytest.fixture(autouse=True)
def _clean():
    ch._PRODUCTION_HOLD.clear(); ch._SCHEDULE_STEER.clear(); ch._PRE_RESOLVED_ADVANCE.pop("u", None)
    yield
    ch._PRODUCTION_HOLD.clear(); ch._SCHEDULE_STEER.clear(); ch._PRE_RESOLVED_ADVANCE.pop("u", None)


def test_model_advance_returns_a_clear_held_result_and_arms_the_hold(monkeypatch):
    remembered = []

    async def adv(expected_beat_seq=None, idempotency_key=None, user=None):
        return dict(HELD)

    monkeypatch.setattr(oe, "advance_game", adv)
    monkeypatch.setattr(oe, "remember_pending", lambda *a, **k: remembered.append(a))
    out = _run(ti.do_advance_game("{}", owner="u"))
    assert out["exit_code"] == 0
    body = json.loads(out["output"])
    assert body["held"] is True and body["next"] == "veto-competition" and body["minutesUntil"] == 95
    assert "95" in body["note"] and "do not" in body["note"].lower()
    assert remembered == [], "a held advance is not a new board; no pending to remember"
    assert ch.production_is_holding("u"), "the stall-nudge / forced-advance ladder reads this and must not re-force"
    assert "95" in ch._SCHEDULE_STEER.get(ch._runway_key("u"), ""), "the narrator is handed the wait"


def test_preresolve_holds_social_and_does_not_count_a_held_advance_as_resolved(monkeypatch):
    async def status(user=None):
        return {"phase": "veto-competition", "pending": None}

    async def adv(expected_beat_seq=None, idempotency_key=None, user=None):
        return dict(HELD)

    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "advance_game", adv)
    st = {"phase": "veto-competition", "moment": "veto-competition", "week": 1, "started": True, "pending": None}  # no daySchedule: only the engine knows
    out = _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="Run the veto competition."))
    assert out.get("moment") == "social"
    assert not ch.consume_pre_resolved_advance("u"), "a refused advance must not mark the turn pre-resolved"
    assert ch.production_is_holding("u")


def test_no_held_is_byte_identical(monkeypatch):
    assert ch.note_engine_held("u", {"beatSeq": 3}) is False
    assert ch.note_engine_held("u", None) is False
    assert not ch.production_is_holding("u")


def test_silent_forced_advance_in_agent_loop_reads_held():
    import pathlib
    src = pathlib.Path(__file__).resolve().parents[1].joinpath("src", "agent_loop.py").read_text()
    i = src.index("async def _commit_advance_silently")
    j = src.index("return True", src.index("committed advanceGame silently", i))
    assert "note_engine_held" in src[i:j], "the silent/forced advance must stop on an engine `held` (no progress credit, no re-force)"


def test_an_engine_hold_never_sticks_once_the_board_no_longer_says_not_due(monkeypatch):
    ch._PRODUCTION_HOLD[ch._runway_key("u")] = ("engine-held", 1)
    calls = []

    async def status(user=None):
        return {"phase": "veto-competition", "pending": None}

    async def adv(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(1)
        return {"beatSeq": 8, "event": {"beat": "comp-round", "content": "b"}, "announcements": []}

    async def state(user=None, **kw):
        return {"phase": "veto-competition", "moment": "veto-competition", "week": 1, "started": True, "pending": None}

    monkeypatch.setattr(oe, "game_status", status); monkeypatch.setattr(oe, "advance_game", adv); monkeypatch.setattr(oe, "get_game_state", state)
    st = {"phase": "veto-competition", "moment": "veto-competition", "week": 1, "started": True, "pending": None}
    _run(ch._pre_resolve_npc_ceremony("u", st, retry=False, player_msg="Run the veto competition."))
    assert calls, "the gate is re-tested (not stuck behind a stale engine-armed hold)"
    assert not ch.production_is_holding("u")


def test_post_goodbye_tail_stops_on_a_held_instead_of_spinning(monkeypatch):
    rr = importlib.import_module("routes.orwell_routes")
    calls = []

    async def adv(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(1)
        return {"beatSeq": 5, "held": {"next": "nominations", "minutesUntil": 30}}

    monkeypatch.setattr(oe, "advance_game", adv)
    start = {"beatSeq": 5, "phase": "eviction"}
    out = _run(rr._advance_through_eviction_night(start, "u", "k"))
    assert out is start and len(calls) == 1
