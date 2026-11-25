"""ORW-919 (Fable week-1 playtest, turns 169-172 and 186-191): the Continue presses through the veto ceremony committed the veto's use and the replacement nominee, and through
eviction night the result: the player saw them only on the card, with no narration until they typed again, and the count was never voiced. A press whose result carries a ceremony
result (`veto-decision` / `replacement-nominee` / `eviction-result` announcements) now arms a hidden beat cue, the same kind ORW-771 (vote) and ORW-924 (draw) arm: the narrator voices the beat at once, with no player bubble and no clock
charge. A press with no such fact arms nothing; a hand-typed copy is an ordinary message. Roles only."""
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
    m = re.search(r'const CEREMONY_RESULT_BEAT_CUE = "(.*)";', JS)
    assert m, "the page carries the veto-ceremony beat cue"
    return json.loads('"' + m.group(1) + '"')


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean():
    for d in ("_DRAW_BEAT_ARMED", "_VOTE_BEAT_ARMED", "_CEREMONY_RESULT_BEAT_ARMED"):
        getattr(chat_helpers, d, {}).clear()
    yield
    for d in ("_DRAW_BEAT_ARMED", "_VOTE_BEAT_ARMED", "_CEREMONY_RESULT_BEAT_ARMED"):
        getattr(chat_helpers, d, {}).clear()


def _advance_returning(view, monkeypatch):
    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return view
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)


ANN = lambda kind: {"id": f"a:{kind}", "kind": kind, "week": 1, "beatSeq": 9, "headline": "x", "subjects": []}


@pytest.mark.parametrize("kind", ["veto-decision", "replacement-nominee", "eviction-result"])
def test_a_press_that_commits_the_veto_ceremony_arms_the_cue_once(client, monkeypatch, kind):
    _advance_returning({"beatSeq": 9, "announcements": [ANN(kind)], "pending": None}, monkeypatch)
    r = client.post("/api/orwell/ceremony-continue")
    assert r.status_code == 200 and r.json()["ceremonyResultBeatCue"] is True
    assert chat_helpers.consume_ceremony_result_beat_cue(_cue(), None) is True
    assert chat_helpers.consume_ceremony_result_beat_cue(_cue(), None) is False


def test_a_press_that_already_armed_the_vote_beat_does_not_also_arm_the_result_beat(client, monkeypatch):
    _advance_returning({"beatSeq": 9, "eviction": {"voteBeat": {"sealed": True}}, "announcements": [ANN("eviction-result")], "pending": None}, monkeypatch)
    r = client.post("/api/orwell/ceremony-continue")
    assert r.json().get("voteBeatCue") is True and "ceremonyResultBeatCue" not in r.json()


def test_a_press_with_other_or_no_announcements_arms_nothing(client, monkeypatch):
    _advance_returning({"beatSeq": 9, "announcements": [ANN("nominations")], "pending": None}, monkeypatch)
    r = client.post("/api/orwell/ceremony-continue")
    assert r.status_code == 200 and "ceremonyResultBeatCue" not in r.json()
    assert chat_helpers.consume_ceremony_result_beat_cue(_cue(), None) is False


def test_the_cue_is_a_beat_turn_never_a_progress_message_and_a_typed_copy_is_ordinary():
    cue = _cue()
    assert chat_helpers.consume_ceremony_result_beat_cue(cue, None) is False
    assert chat_helpers._is_progress_only_message(cue) is False and chat_helpers._player_signals_ready(cue) is False
    assert agent_loop._is_production_cue(cue) is True
    assert "res.ceremonyResultBeatCue === true" in JS
