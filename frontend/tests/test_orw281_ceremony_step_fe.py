"""ORW-281 4b (FE half): a staged-ceremony WATCH step (pending kind `ceremony-step`) is voiced by the model,
moved on by the player's Continue (POST /api/orwell/ceremony-continue -> advanceGame), and never by the model."""

import importlib
import pathlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
chat_helpers = importlib.import_module("routes.chat_helpers")
JS = (pathlib.Path(__file__).resolve().parent.parent / "static" / "js" / "orwellDecision.js").read_text()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def test_directive_for_a_watch_step_forbids_the_model_advancing_it():
    d = chat_helpers._pending_barrier_directive(
        {"kind": "ceremony-step", "prompt": "The HOH steps up.", "by": {"name": "Alex"}})
    assert d and "WATCH step" in d and "Continue button" in d
    assert "Do NOT call advanceGame" in d
    # the generic "submit it via submitDecision" tail must not be what steers this kind
    assert "then submit it via submitDecision" not in d.split("Your ONLY job")[1]


def test_continue_route_advances_exactly_once_and_returns_the_next_pending(client, monkeypatch):
    calls = []

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(idempotency_key)
        return {"beatSeq": 9, "event": {"beat": "x"}, "pending": {"kind": "ceremony-step", "text": "next"}}

    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    r = client.post("/api/orwell/ceremony-continue")
    assert r.status_code == 200 and r.json()["pending"]["text"] == "next"
    assert len(calls) == 1


def test_continue_route_surfaces_an_engine_refusal_with_its_status(client, monkeypatch):
    async def boom(**_kw):
        raise orwell_engine.EngineToolError("nope", status=400)

    monkeypatch.setattr(orwell_engine, "advance_game", boom)
    assert client.post("/api/orwell/ceremony-continue").status_code == 400


def test_card_renders_text_and_a_continue_that_posts_the_route():
    assert 'pending.kind === "ceremony-step"' in JS and "renderCeremonyStep(pending)" in JS
    assert "/api/orwell/ceremony-continue" in JS
    assert 'btn.textContent = "Continue"' in JS
    # a watch card is not a decision: no stakes skin, never binding
    assert 'card.dataset.binding = "false"' in JS
