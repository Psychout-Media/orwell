"""0208 B3 (ORW-665): the hall of fame screen - the player's finished seasons, readable outside any game.

Three halves: the route (public facts only, fail-soft empty), the pure rendering model run in Node, and source-pinned
conventions (kit window, textContent only, no second dispatcher of the game-changed event, loaded + rail-mirrored).
Roles only; no names.
"""
import importlib
import json
import pathlib
import shutil
import subprocess

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")

FE = pathlib.Path(__file__).resolve().parents[1]
JS = FE / "static" / "js" / "orwellHallOfFame.js"
SRC = JS.read_text(encoding="utf-8")


def _record(season, **extra):
    base = {"season": season, "placement": 2, "result": "runner-up", "castSize": 16, "winnerId": "npc:SECRET",
            "bestMoveEventId": "evt-secret", "winnerName": "Winner", "runnerUpName": "Player",
            "counts": {"compWins": 3, "betrayalsReceived": 9, "dealsBroken": 4},
            "bestMove": {"kind": "comp-win", "actor": "Player"},
            "worstBetrayal": {"kind": "betrayal", "actor": "HOH", "subject": "Player", "vaultNote": "hidden"}}
    base.update(extra)
    return base


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def _stub(monkeypatch, view=None, exc=None):
    async def fake(user=None, **_kw):
        if exc:
            raise exc
        return view
    monkeypatch.setattr(orwell_engine, "hall_of_fame", fake)


def test_route_returns_public_facts_newest_first_and_drops_everything_else(client, monkeypatch):
    _stub(monkeypatch, {"seasonsPlayed": 2, "won": 0, "seasons": [_record(1), _record(2)]})
    body = client.get("/api/orwell/hall-of-fame").json()
    assert [s["season"] for s in body["seasons"]] == [2, 1]
    flat = json.dumps(body)
    for leaked in ("npc:SECRET", "evt-secret", "vaultNote", "betrayalsReceived", "dealsBroken"):
        assert leaked not in flat
    s = body["seasons"][0]
    assert s["compWins"] == 3 and s["winnerName"] == "Winner"
    assert s["worstBetrayal"] == {"kind": "betrayal", "actor": "HOH", "subject": "Player"}


def test_route_is_an_empty_hall_with_no_game_or_any_failure(client, monkeypatch):
    _stub(monkeypatch, exc=orwell_engine.EngineToolError("no active game for this user"))
    assert client.get("/api/orwell/hall-of-fame").json() == {"seasons": []}
    _stub(monkeypatch, exc=RuntimeError("boom"))
    assert client.get("/api/orwell/hall-of-fame").json() == {"seasons": []}
    _stub(monkeypatch, view=None)
    assert client.get("/api/orwell/hall-of-fame").json() == {"seasons": []}


def _node(script):
    node = shutil.which("node")
    if not node:
        pytest.skip("node not available")
    p = subprocess.run([node, "-e", script], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout)


def _model(view):
    script = ("global.window = {}; require(%s); process.stdout.write(JSON.stringify(window.OrwellHallOfFame.model(%s)))"
              % (json.dumps(str(JS)), json.dumps(view)))
    return _node(script)


def test_model_lists_newest_first_with_the_engines_fields_as_labelled_rows():
    out = _model({"seasons": [
        {"season": 1, "placement": 4, "result": "jury", "castSize": 16, "winnerName": "A"},
        {"season": 2, "placement": 1, "result": "won", "castSize": 16, "winnerName": "P", "runnerUpName": "B", "compWins": 2,
         "bestMove": {"kind": "comp-win", "actor": "P"}, "worstBetrayal": {"kind": "betrayal", "actor": "X", "subject": "P"}},
    ]})
    assert [s["title"] for s in out] == ["Season 2", "Season 1"]
    rows = dict(map(tuple, out[0]["rows"]))
    assert rows["Winner"] == "P" and rows["Runner-up"] == "B" and rows["Placement"] == "1 / 16"
    assert rows["Best move"] == "comp win · P" and rows["Worst betrayal"] == "betrayal · X · P"
    older = dict(map(tuple, out[1]["rows"]))
    assert "Best move" not in older and "Runner-up" not in older and "Competition wins" not in older


def test_empty_and_malformed_views_have_no_rows():
    assert _model({"seasons": []}) == []
    assert _model(None) == []
    assert _model({"seasons": "x"}) == []


def test_render_builds_list_markup_or_the_empty_note():
    script = """
global.window = {};
require(%s);
const mk = (tag) => ({ tag, children: [], className: '', textContent: '', appendChild(c) { this.children.push(c); return c; },
  get firstChild() { return this.children[0] || null; }, removeChild(c) { this.children.splice(this.children.indexOf(c), 1); } });
const doc = { createElement: mk };
const a = mk('div'), b = mk('div');
const n = window.OrwellHallOfFame.render({ seasons: [{ season: 1, placement: 1, result: 'won' }] }, a, doc);
const e = window.OrwellHallOfFame.render({ seasons: [] }, b, doc);
process.stdout.write(JSON.stringify({ n, e, list: a.children[0].tag, item: a.children[0].children[0].tag,
  dl: a.children[0].children[0].children[1].tag, empty: b.children[0].className }));
""" % json.dumps(str(JS))
    out = _node(script)
    assert out == {"n": 1, "e": 0, "list": "ol", "item": "li", "dl": "dl", "empty": "ohf-empty"}


def test_source_conventions():
    assert "innerHTML" not in SRC.replace("btn.innerHTML = \"<svg", "")  # only the static sidebar icon markup
    assert "OrwellWindowKit.create" in SRC
    assert "new CustomEvent" not in SRC and "dispatchEvent" not in SRC  # g15: the one dispatcher lives in platform.js
    assert "/api/orwell/hall-of-fame" in SRC
    assert 'dataset.gameBuild !== "1"' in SRC
    index = (FE / "static" / "index.html").read_text(encoding="utf-8")
    assert "orwellHallOfFame.js" in index
    layout = (FE / "static" / "js" / "sidebar-layout.js").read_text(encoding="utf-8")
    assert "rail-hall-of-fame" in layout and "sidebar-hall-btn" in layout


def test_the_tool_is_not_a_model_lever():
    for name in ("tool_schemas.py", "agent_tools.py"):
        assert "hallOfFame" not in (FE / "src" / name).read_text(encoding="utf-8")
