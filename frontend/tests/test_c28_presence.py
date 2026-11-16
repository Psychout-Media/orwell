"""C28 — the presence strip (feature 0049, FE half): whereabouts() rendered as an AMBIENT,
dismissible ground for lingering play (ADR 0003 §4/§7). The route is read-only and fail-open;
the strip carries no control that progresses the game (the B66 augment guard covers that
structurally — these tests pin the route + mount).
"""

import importlib
import os

from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def test_whereabouts_route_passes_the_engine_view_through(monkeypatch):
    async def fake(user=None):
        return {
            "room": "backyard",
            "present": [{"id": "npc:2", "name": "A"}],
            "nearby": [{"room": "kitchen", "present": [{"id": "npc:5", "name": "B"}]}],
        }

    monkeypatch.setattr(orwell_engine, "whereabouts", fake)
    r = _client().get("/api/orwell/whereabouts")
    assert r.status_code == 200
    body = r.json()["whereabouts"]
    assert body["room"] == "backyard"
    assert body["nearby"][0]["room"] == "kitchen"


def test_whereabouts_route_fails_open(monkeypatch):
    async def boom(user=None):
        raise RuntimeError("engine down")

    monkeypatch.setattr(orwell_engine, "whereabouts", boom)
    r = _client().get("/api/orwell/whereabouts")
    assert r.status_code == 200
    assert r.json() == {"whereabouts": None, "unavailable": True}  # fails open (200, never a blocked page); the flag tells the strip it is a failed read


def test_whereabouts_route_pregame_is_null(monkeypatch):
    async def pregame(user=None):
        return None

    monkeypatch.setattr(orwell_engine, "whereabouts", pregame)
    r = _client().get("/api/orwell/whereabouts")
    assert r.json() == {"whereabouts": None}


def test_presence_strip_is_mounted_and_ambient():
    html = open(os.path.join(FRONTEND, "static", "index.html"), encoding="utf-8").read()
    assert "orwellPresence.js" in html

    js = open(os.path.join(FRONTEND, "static", "js", "orwellPresence.js"), encoding="utf-8").read()
    # Ambient, never click-to-act: it is a rail gadget ("Where You Are") that composes the
    # OrwellGadget kit (#640) — NO interactive control at all (the old floating dismiss strip
    # covered the composer/chat), and the module never POSTs anywhere (reads state + whereabouts).
    assert js.count("addEventListener(\"click\"") == 0
    # #640: the rail/sidebar mount is the kit's job now — the gadget composes the kit, which
    # owns the #gadget-rail-body → #sidebar → body fallback chain (one place).
    assert "OrwellGadgetKit.create(" in js              # composes the kit (mounted by it)
    assert "POST" not in js and "method:" not in js
    assert "/api/orwell/whereabouts" in js and "/api/orwell/state" in js
    # Game-build gated + fail-open.
    assert "dataset.gameBuild" in js
    assert "render(null)" in js
