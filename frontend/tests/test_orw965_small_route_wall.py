"""ORW-965 (Vault Wall, wall audit 3c): /api/orwell/cast-progress, /hall-of-fame and /knowledge hand the browser a CLOSED shape (unknown keys dropped at every level), the same technique as ORW-768/769, on top of the
field-by-field sanitizers two of them already had: a key a sanitizer or the engine adds later never reaches the page until a screen reads it and it is added to the shape. Three layers: planted sentinels through the real
routes (with a positive control), allowlist-by-construction, and an independently written path list. (/retrospective, the fourth route, is ORW-976.) Roles only."""
from __future__ import annotations

import importlib
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
S = "ZZ-sentinel-965"

SHAPES = {"cast": orwell_routes._BROWSER_CAST_PROGRESS_SHAPE, "hall": orwell_routes._BROWSER_HALL_SHAPE, "knowledge": orwell_routes._BROWSER_KNOWLEDGE_SHAPE}
ALLOWED = {
    "cast": {"phase", "total", "faces", "facesRetrying"},
    "hall": {"seasons[].season", "seasons[].placement", "seasons[].result", "seasons[].castSize", "seasons[].winnerName", "seasons[].runnerUpName", "seasons[].compWins",
             "seasons[].bestMove.kind", "seasons[].bestMove.actor", "seasons[].bestMove.subject", "seasons[].worstBetrayal.kind", "seasons[].worstBetrayal.actor", "seasons[].worstBetrayal.subject"},
    "knowledge": {"started", "items[].content", "items[].source.kind", "items[].source.who", "items[].source.firsthand", "items[].subject.id", "items[].subject.name"},
}


def _paths(v, p=""):
    out = set()
    if isinstance(v, dict):
        for k, x in v.items():
            out |= _paths(x, f"{p}.{k}" if p else k)
    elif isinstance(v, list):
        for x in v:
            out |= _paths(x, p + "[]")
        if not v:
            out.add(p + "[]*")
    else:
        out.add(p)
    return out


def _outside(route, body):
    allowed = ALLOWED[route]
    parents = {a[:i] for a in allowed for i in range(len(a)) if a[i] in ".["}
    return sorted(x for x in _paths(body) if not (x in allowed or x in parents or x.endswith("[]*") or x == ""))


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


@pytest.mark.parametrize("route", sorted(SHAPES))
def test_every_dict_level_of_every_shape_is_closed(route):
    def fill(spec):
        if spec is True:
            return "v"
        if isinstance(spec, dict):
            d = {k: fill(s) for k, s in spec.items()}
            d["zzUnknownKey"] = S
            return d
        return [fill(spec[0])]
    full = {k: fill(s) for k, s in SHAPES[route].items()}
    full["zzUnknownTop"] = S
    out = orwell_routes._project_for_browser(full, SHAPES[route])
    assert S not in json.dumps(out) and "zzUnknown" not in json.dumps(out)
    assert not _outside(route, out), _outside(route, out)


def test_the_path_checker_itself_catches_a_planted_key():
    assert _outside("cast", {"phase": "faces", "attempts": 3}) == ["attempts"]
    assert _outside("knowledge", {"started": True, "items": [{"content": "c", "confidence": 0.4}]}) == ["items[].confidence"]
    assert _outside("hall", {"seasons": [{"season": 1, "eventIds": ["e"]}]}) == ["seasons[].eventIds[]"]
    assert not _outside("cast", {"phase": "none"})


def test_cast_progress_keeps_what_the_cue_reads_and_drops_the_bookkeeping(client, monkeypatch):
    prewarm = importlib.import_module("src.orwell_prewarm")
    raw = {"phase": "faces", "authored": 11, "faces": 7, "total": 15, "attempts": 2, "facesRetrying": 1, "castSecret": S, "profile": {"hidden": S}}
    assert json.dumps(raw).count(S) == 2  # positive control
    monkeypatch.setattr(prewarm, "cast_progress", lambda user=None, **kw: raw)
    body = client.get("/api/orwell/cast-progress").json()
    assert body == {"phase": "faces", "total": 15, "faces": 7, "facesRetrying": 1}
    monkeypatch.setattr(prewarm, "cast_progress", lambda user=None, **kw: {"phase": "none"})
    assert client.get("/api/orwell/cast-progress").json() == {"phase": "none"}


def test_hall_of_fame_is_the_whitelist_held_to_a_closed_shape(client, monkeypatch):
    raw = {"seasons": [{"season": 2, "placement": 1, "result": "won", "castSize": 16, "winnerName": "Role One", "runnerUpName": "Role Two", "counts": {"compWins": 4, "votes": S},
                        "bestMove": {"kind": "blindside", "actor": "Role One", "subject": "Role Three", "eventId": S}, "worstBetrayal": {"kind": "broken-deal", "actor": "Role Two", "subject": "Role One", "why": S},
                        "hiddenNote": S, "eventIds": [S]}, {"season": 1, "placement": 3, "result": "evicted", "castSize": 16}]}
    assert json.dumps(raw).count(S) == 5

    async def fake(user=None):
        return raw
    monkeypatch.setattr(orwell_engine, "hall_of_fame", fake)
    body = client.get("/api/orwell/hall-of-fame").json()
    assert S not in json.dumps(body) and not _outside("hall", body), _outside("hall", body)
    assert [s["season"] for s in body["seasons"]] == [2, 1] and body["seasons"][0]["compWins"] == 4 and body["seasons"][0]["bestMove"] == {"kind": "blindside", "actor": "Role One", "subject": "Role Three"}


def test_knowledge_is_the_whitelist_held_to_a_closed_shape(client, monkeypatch):
    visible = {"knowledge": [{"content": "Role Two said they are close to Role Three.", "pathway": "told-by:npc:2", "subject": "npc:3", "confidence": 0.31, "origin": S, "truth": S, "factId": S},
                             {"content": "You saw Role Two leave.", "pathway": "witnessed:evt:9", "subject": "npc:2", "bearing": S}]}
    state = {"house": [{"id": "npc:2", "name": "Role Two"}, {"id": "npc:3", "name": "Role Three"}]}
    assert json.dumps(visible).count(S) == 4

    async def fake_visible(user=None):
        return visible

    async def fake_state(user=None, timeout=None):
        return state
    monkeypatch.setattr(orwell_engine, "get_visible_state", fake_visible)
    monkeypatch.setattr(orwell_engine, "get_game_state_polled", fake_state)
    body = client.get("/api/orwell/knowledge").json()
    assert S not in json.dumps(body) and "0.31" not in json.dumps(body) and not _outside("knowledge", body), _outside("knowledge", body)
    assert body["started"] is True and len(body["items"]) == 2
    assert body["items"][0]["source"] == {"kind": "told", "who": "Role Two", "firsthand": False} and body["items"][0]["subject"] == {"id": "npc:3", "name": "Role Three"}
    assert body["items"][1]["source"]["firsthand"] is True


def test_the_fail_open_answers_keep_their_shape(client, monkeypatch):
    async def boom(user=None):
        raise RuntimeError("engine down " + S)
    monkeypatch.setattr(orwell_engine, "get_visible_state", boom)
    assert client.get("/api/orwell/knowledge").json() == {"started": False, "items": []}
    monkeypatch.setattr(orwell_engine, "hall_of_fame", boom)
    assert client.get("/api/orwell/hall-of-fame").json() == {"seasons": []}
