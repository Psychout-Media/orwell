"""ORW-166 slice 4 - GET /api/orwell/state answers a conditional GET: an ETag over the served body, 304 with no
body on a matching If-None-Match, a fresh 200 once the state changes. The 200 body is byte-identical to the
un-etagged JSON. No model; roles only."""
import importlib
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

oe = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")


@pytest.fixture
def client_and_state(monkeypatch):
    state = {"started": True, "beatSeq": 1, "week": 1}

    async def fake_polled(user=None, timeout=None):
        return dict(state)

    monkeypatch.setattr(oe, "get_game_state_polled", fake_polled)
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app), state


def test_first_get_returns_an_etag_and_the_same_body_as_plain_json(client_and_state):
    c, state = client_and_state
    r = c.get("/api/orwell/state")
    assert r.status_code == 200
    assert r.headers["etag"].startswith('W/"')
    assert r.headers["cache-control"] == "no-cache"
    assert r.json()["beatSeq"] == 1
    assert json.loads(r.content)["week"] == 1


def test_matching_if_none_match_gets_304_with_no_body(client_and_state):
    c, _ = client_and_state
    etag = c.get("/api/orwell/state").headers["etag"]
    r = c.get("/api/orwell/state", headers={"If-None-Match": etag})
    assert r.status_code == 304
    assert r.content == b""
    assert r.headers["etag"] == etag


def test_a_changed_state_gets_a_200_with_the_new_body(client_and_state):
    c, state = client_and_state
    etag = c.get("/api/orwell/state").headers["etag"]
    state["beatSeq"] = 2
    r = c.get("/api/orwell/state", headers={"If-None-Match": etag})
    assert r.status_code == 200
    assert r.json()["beatSeq"] == 2
    assert r.headers["etag"] != etag


def test_a_change_with_the_same_beatseq_still_busts_the_etag(client_and_state):
    c, state = client_and_state
    etag = c.get("/api/orwell/state").headers["etag"]
    state["week"] = 2  # e.g. an overlay field: the ETag covers the whole body, not beatSeq alone
    assert c.get("/api/orwell/state", headers={"If-None-Match": etag}).status_code == 200


def test_unmatched_or_listed_validators(client_and_state):
    c, _ = client_and_state
    etag = c.get("/api/orwell/state").headers["etag"]
    assert c.get("/api/orwell/state", headers={"If-None-Match": 'W/"other"'}).status_code == 200
    assert c.get("/api/orwell/state", headers={"If-None-Match": f'W/"other", {etag}'}).status_code == 304
