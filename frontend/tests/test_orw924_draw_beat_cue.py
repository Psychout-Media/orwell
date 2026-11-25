"""ORW-924 (FE server half): the hidden draw-beat cue is armed ONLY by a Continue press that carried the engine's `vetoDrawBeat`, is a beat turn exactly once, is never read as a progress /
readiness message (it must not advance the ceremony), and a hand-typed copy with no armed press is an ordinary player message (it keeps its clock charge). Roles only."""

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
CUE = json.loads('"' + re.search(r'const DRAW_BEAT_CUE = "(.*)";', JS).group(1) + '"')


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clean():
    chat_helpers._DRAW_BEAT_ARMED.clear()
    chat_helpers._VOTE_BEAT_ARMED.clear()
    yield
    chat_helpers._DRAW_BEAT_ARMED.clear()
    chat_helpers._VOTE_BEAT_ARMED.clear()


def _advance_returning(view, monkeypatch):
    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return view
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)


def test_a_press_with_the_draw_beat_fact_arms_the_cue_once(client, monkeypatch):
    _advance_returning({"beatSeq": 9, "vetoDrawBeat": {"step": "chips", "stepNumber": 1}, "pending": None}, monkeypatch)
    r = client.post("/api/orwell/ceremony-continue")
    assert r.status_code == 200 and r.json()["drawBeatCue"] is True    # the page sends the cue only on this marker
    assert chat_helpers.consume_draw_beat_cue(CUE, None) is True       # the beat turn: no clock, no player-move parse
    assert chat_helpers.consume_draw_beat_cue(CUE, None) is False      # one press, one beat turn


def test_a_press_without_the_draw_beat_fact_arms_nothing(client, monkeypatch):
    _advance_returning({"beatSeq": 9, "eviction": {"stage": "votes"}, "pending": None}, monkeypatch)
    r = client.post("/api/orwell/ceremony-continue")
    assert r.status_code == 200 and "drawBeatCue" not in r.json()
    assert chat_helpers.consume_draw_beat_cue(CUE, None) is False


def test_the_draw_cue_and_the_vote_cue_do_not_arm_each_other():
    chat_helpers.arm_vote_beat_cue(None)
    assert chat_helpers.consume_draw_beat_cue(CUE, None) is False
    chat_helpers.arm_draw_beat_cue(None)
    assert chat_helpers.consume_draw_beat_cue(CUE, None) is True


def test_a_hand_typed_copy_with_no_armed_press_is_an_ordinary_message():
    assert chat_helpers.consume_draw_beat_cue(CUE, None) is False
    chat_helpers.arm_draw_beat_cue(None)
    assert chat_helpers.consume_draw_beat_cue("an ordinary line from the player", None) is False   # not the cue: the arm stays for the real one
    assert chat_helpers.consume_draw_beat_cue(CUE, None) is True


def test_the_cue_is_never_a_progress_or_readiness_message_so_it_cannot_advance_the_ceremony():
    assert chat_helpers._is_progress_only_message(CUE) is False
    assert chat_helpers._player_signals_ready(CUE) is False
    assert agent_loop._is_production_cue(CUE) is True                  # hidden on every device; never a lull / ready signal


def test_the_cue_text_has_no_stock_example_phrasing_and_the_page_fires_it_only_on_the_marker():
    assert not re.search(r"e\.g\.|for example|such as", CUE, re.I)
    assert "res.drawBeatCue === true && res.vetoDrawBeat" in JS
