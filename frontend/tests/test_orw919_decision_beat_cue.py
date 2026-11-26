"""ORW-919 (Fable week-1 playtest): after a pick on a decision card the message box was PRE-FILLED ("I'm committing to this round", even for play-safe) and nothing happened until
the player pressed Send. F-NEW-5 amended (Coordinator ruling, 2026-11-25): a successful submit arms ONE hidden production cue, the ORW-771/924 kind, and the page sends it at once,
so the narrator voices the locked-in beat. No player bubble, no clock charge, no words sent for the player; armed only by a successful decision; a cue that cannot go out leaves
the box EMPTY (nothing is ever pre-filled). Roles only."""
import importlib
import json
import pathlib
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
chat_helpers = importlib.import_module("routes.chat_helpers")
agent_loop = importlib.import_module("src.agent_loop")
JS = (pathlib.Path(__file__).resolve().parent.parent / "static" / "js" / "orwellDecision.js").read_text()


def _cue():
    m = re.search(r'const DECISION_BEAT_CUE = "(.*)";', JS)
    assert m, "the page carries the decision beat cue"
    return json.loads('"' + m.group(1) + '"')


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean():
    getattr(chat_helpers, "_DECISION_BEAT_ARMED", {}).clear()
    yield
    getattr(chat_helpers, "_DECISION_BEAT_ARMED", {}).clear()


def test_a_successful_submit_arms_one_decision_beat(client, monkeypatch):
    async def fake_submit(decision, user=None, **_kw):
        return {"event": None, "pending": None, "beatSeq": 4}
    monkeypatch.setattr(orwell_engine, "submit_decision", fake_submit)
    r = client.post("/api/orwell/decision", json={"kind": "nominations", "choice": ["npc:1", "npc:2"]})
    assert r.status_code == 200 and r.json().get("decisionBeatCue") is True
    assert chat_helpers.consume_decision_beat_cue(_cue(), None) is True
    assert chat_helpers.consume_decision_beat_cue(_cue(), None) is False


def test_a_refused_submit_arms_nothing(client, monkeypatch):
    async def fake_submit(decision, user=None, **_kw):
        raise orwell_engine.EngineToolError("illegal pick", status=400)
    monkeypatch.setattr(orwell_engine, "submit_decision", fake_submit)
    r = client.post("/api/orwell/decision", json={"kind": "nominations", "choice": ["npc:1", "npc:2"]})
    assert r.status_code == 400
    assert chat_helpers.consume_decision_beat_cue(_cue(), None) is False


def test_the_cue_is_a_hidden_beat_turn_and_never_a_progress_or_ready_message():
    cue = _cue()
    assert agent_loop._is_production_cue(cue) is True
    assert chat_helpers._is_progress_only_message(cue) is False and chat_helpers._player_signals_ready(cue) is False
    assert not re.search(r"e\.g\.|for example|such as", cue, re.I)


def test_the_page_never_prefills_the_message_box_and_fires_the_cue_after_a_success():
    assert "box.value = " not in JS and "prefillCueFor" not in JS and "committing to this round" not in JS
    i = JS.index("_fireBeatCue(DECISION_BEAT_CUE)")
    assert JS.rindex('card.classList.add("odec-done")', 0, i) > JS.rindex("/api/orwell/decision", 0, i), "fired only after the submit succeeded"


def test_a_beat_cue_turn_is_recognised_so_the_advance_belts_stand_down():
    """The finale walk found it: the decision cue's turn ran the stall belt, which silently committed advanceGame past the next step card. Every beat cue is recognised and the
    agent loop's want-advance gate stands down for it (source pin on the gate; the cue texts are the page's own)."""
    for name in ("DECISION_BEAT_CUE", "CEREMONY_RESULT_BEAT_CUE", "VOTE_BEAT_CUE", "DRAW_BEAT_CUE"):
        text = json.loads('"' + re.search(r'const ' + name + r' = "(.*)";', JS).group(1) + '"')
        assert agent_loop._is_beat_cue(text) is True, name
    assert agent_loop._is_beat_cue("next") is False and agent_loop._is_beat_cue("(Production cue — continue the casting interview.)") is False
    src = (pathlib.Path(agent_loop.__file__)).read_text()
    assert "if _want_advance and _is_beat_cue(_extract_last_user_message(messages)" in src


def test_a_beat_cue_turn_never_runs_the_pre_resolve():
    """The second seam the finale walk hit: the framing's pre-resolve advanced the finale on the decision cue's turn. A beat cue returns the board untouched, before any engine call."""
    import asyncio
    calls = []

    async def boom(*a, **k):
        calls.append(1)
        raise AssertionError("no engine call on a beat-cue turn")
    orig = orwell_engine.game_status
    orwell_engine.game_status = boom
    try:
        board = {"phase": "finale", "started": True}
        out = asyncio.new_event_loop().run_until_complete(chat_helpers._pre_resolve_npc_ceremony(None, board, retry=False, player_msg=_cue()))
    finally:
        orwell_engine.game_status = orig
    assert out is board and calls == []
