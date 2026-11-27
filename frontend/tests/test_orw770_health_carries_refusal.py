"""ORW-770: the player banner reads `integrityRefusal` but /api/orwell/health never sent it, so a refused turn showed the player nothing.

BEHAVIOURAL through the real route: a planted checkpoint refusal for this player reaches the browser as a bare `true` (no tool, kinds or invariant name), and another player's refusal does not. Roles only.
"""
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routes import orwell_routes
from src import orwell_engine


def _client(monkeypatch, me="player-a"):
    async def detail(*a, **k):
        return {"ok": True}

    monkeypatch.setattr(orwell_engine, "engine_health_detail", detail)
    monkeypatch.setattr(orwell_routes, "_current_user", lambda request: me)
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def _plant(monkeypatch, user):
    monkeypatch.setattr(orwell_engine, "_INTEGRITY_REFUSAL", {})
    orwell_engine.note_integrity_refusal(user, "advanceGame", ["degradation"], "deals")


def test_this_players_refusal_reaches_the_banner_as_a_bare_true(monkeypatch):
    _plant(monkeypatch, "player-a")
    body = _client(monkeypatch).get("/api/orwell/health").json()
    assert body.get("integrityRefusal") is True
    assert "degradation" not in json.dumps(body) and "advanceGame" not in json.dumps(body)


def test_another_players_refusal_does_not(monkeypatch):
    _plant(monkeypatch, "player-b")
    assert not _client(monkeypatch).get("/api/orwell/health").json().get("integrityRefusal")
