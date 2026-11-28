"""ORW-1141: the presence strip never flips between "just you" and a set of faces with no turn and no
engine move between. /whereabouts picks live or the per-turn frozen snapshot on every read; the pick is
now latched while the frame and the live occupancy are unchanged."""

import importlib

from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
chat_helpers = importlib.import_module("routes.chat_helpers")
whereabouts_source = importlib.import_module("src.whereabouts_source")

FACES = [{"id": f"npc:{i}", "name": f"Guest {i}"} for i in range(4)]
FROZEN = {"room": "kitchen", "present": FACES, "nearby": []}
LIVE_ALONE = {"room": "kitchen", "present": [], "nearby": []}
USER = "orw1141"


def _client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def _setup(monkeypatch, live_box):
    whereabouts_source.reset()
    chat_helpers.freeze_capture_whereabouts(USER, FROZEN)

    async def fake(user=None):
        return dict(live_box[0])

    monkeypatch.setattr(orwell_engine, "whereabouts", fake)
    monkeypatch.setattr(orwell_routes, "_current_user", lambda request: USER)


def _present(c):
    return [p["id"] for p in c.get("/api/orwell/whereabouts").json()["whereabouts"]["present"]]


def test_source_does_not_flip_when_nothing_moved(monkeypatch):
    live = [LIVE_ALONE]
    _setup(monkeypatch, live)
    c = _client()
    first = _present(c)
    assert len(first) == 4  # the frozen board the prose was grounded in
    # the freeze flag drops (the model issued a move the FE could not capture) but the engine's occupancy is unchanged
    chat_helpers._TURN_FREEZE_OK[USER] = False
    assert _present(c) == first  # on main this read flipped to the live board: "Just you here"


def test_source_does_not_flip_back_to_faces(monkeypatch):
    live = [LIVE_ALONE]
    _setup(monkeypatch, live)
    chat_helpers._TURN_FREEZE_OK[USER] = False
    c = _client()
    assert _present(c) == []
    chat_helpers._TURN_FREEZE_OK[USER] = True
    assert _present(c) == []  # on main this read flipped to four faces


def test_an_engine_move_releases_the_latch(monkeypatch):
    live = [LIVE_ALONE]
    _setup(monkeypatch, live)
    c = _client()
    assert len(_present(c)) == 4
    chat_helpers._TURN_FREEZE_OK[USER] = False
    live[0] = {"room": "kitchen", "present": [FACES[0]], "nearby": []}  # a real engine move
    assert _present(c) == ["npc:0"]


def test_a_new_turn_releases_the_latch(monkeypatch):
    live = [LIVE_ALONE]
    _setup(monkeypatch, live)
    c = _client()
    assert len(_present(c)) == 4
    chat_helpers._TURN_FREEZE_OK[USER] = False
    assert len(_present(c)) == 4
    chat_helpers.freeze_capture_whereabouts(USER, {"room": "kitchen", "present": [], "nearby": []})
    assert _present(c) == []
