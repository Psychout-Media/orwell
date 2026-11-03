"""A-14 N-14 — a ceremony must be COMMITTED by the engine before that turn's narration is written. Playtest: the
player said "let's go ahead to the nominations ceremony"; the pre-resolve consumed only the night-gate `day-break`
beat and returned "let the model drive the ceremony this turn", so the narrator invented the ceremony (handing keys to
the very people the engine then nominated) and a belt committed `advanceGame` silently AFTER the text. When the
player asked to move on and a day-break was consumed, the pre-resolve now also resolves the ceremony beat in the SAME
pass, so the framing carries the engine's real outcome. Roles only."""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


@pytest.fixture(autouse=True)
def _clean():
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u")
    yield
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u")


def _wire(monkeypatch):
    calls = []
    board = {"phase": "nominations", "moment": "nominations", "week": 1, "started": True, "nominees": [], "pending": None}

    async def status(user=None):
        return {"phase": board["phase"], "pending": None, "nominees": [{"id": n, "name": n} for n in board["nominees"]]}

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(len(calls) + 1)
        if len(calls) == 1:   # the night-gate
            return {"event": {"beat": "day-break", "content": "The house turns in for the night, and a new day dawns."}, "announcements": []}
        board.update(phase="veto-competition", moment="veto-competition", nominees=["Pick-One", "Pick-Two"])
        return {"event": {"beat": "nominations", "content": "HOH nominates Pick-One and Pick-Two"},
                "announcements": [{"id": "ann:1", "kind": "nominations", "week": 1, "beatSeq": 9,
                                   "headline": "HOH has nominated Pick-One and Pick-Two for eviction.", "subjects": []}]}

    async def state(user=None, **kw):
        return dict(board)

    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "advance_game", advance)
    monkeypatch.setattr(oe, "get_game_state", state)
    return calls, board


def test_a_ready_player_after_a_day_break_gets_the_ceremony_committed_before_narration(monkeypatch):
    calls, board = _wire(monkeypatch)
    start = {"phase": "nominations", "moment": "nominations", "week": 1, "started": True, "nominees": [], "pending": None}
    out = _run(ch._pre_resolve_npc_ceremony("u", start, retry=False, player_msg="Let's go ahead to the nominations ceremony."))
    assert len(calls) == 2, "the day-break AND the ceremony were both resolved in this pass"
    assert out.get("phase") == "veto-competition" and out.get("nominees") == ["Pick-One", "Pick-Two"], \
        "the framing state carries the ENGINE's committed nominees, not an assumption"
    owed = ch.pop_pending_chyron("u")
    assert owed and owed[0]["id"] == "ann:1", "the committed ceremony's announcement is owed to the player"
    assert "Pick-One" in (ch._aired_fact_steer("u") or ""), "the next scene is grounded on who the engine picked"


def test_without_the_ready_cue_only_the_day_break_is_consumed_and_the_turn_holds_for_social(monkeypatch):
    calls, board = _wire(monkeypatch)
    start = {"phase": "nominations", "moment": "nominations", "week": 1, "started": True, "nominees": [], "pending": None}
    ch._RUNWAY_LAST_DONE[ch._runway_key("u")] = ch._runway_sig(start)  # the beat's runway is already spent: nothing else holds it
    out = _run(ch._pre_resolve_npc_ceremony("u", start, retry=False, player_msg="I wander into the kitchen and chat."))
    assert len(calls) <= 1, "no readiness ⇒ never the ceremony too (a held social morning)"
    assert out.get("moment") == "social"
    assert board["nominees"] == [], "nothing the narration could contradict was committed"


def test_the_second_advance_never_runs_when_a_player_decision_is_pending_after_the_day_break(monkeypatch):
    calls, board = _wire(monkeypatch)

    async def status(user=None):
        return {"phase": "nominations", "pending": {"kind": "nominations"} if calls else None, "nominees": []}

    monkeypatch.setattr(oe, "game_status", status)
    start = {"phase": "nominations", "moment": "nominations", "week": 1, "started": True, "nominees": [], "pending": None}
    _run(ch._pre_resolve_npc_ceremony("u", start, retry=False, player_msg="Let's go ahead to the nominations ceremony."))
    assert len(calls) == 1, "the player is the decider now — never auto-resolve their card"
