"""0025 (ORWELL_REACTIVE_TWISTS, OFF in deploy) — the player's `secret-veto` pending is answerable
through the front-end. The 2026-10-25 audit's latent break was that the FE could not submit this kind
(relay allowlists, schema enum, no card). #1911 closed those; this pins the whole FE chain so it cannot
regress while the flag stays off: the HTTP relay, the WS relay set, the model's submitDecision schema
enum, and the decision card's wire payload. The engine end is tests/unit/secretVetoBoundary.test.ts.
Roles only — no names.
"""
import importlib
import os
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


@pytest.mark.parametrize("use", [True, False])
def test_http_relay_forwards_secret_veto_with_its_boolean(client, monkeypatch, use):
    seen = {}

    async def fake_submit(decision, user=None, **_kw):
        seen.update(decision)
        return {"event": None, "pending": None, "status": {"week": 2}}

    monkeypatch.setattr(orwell_engine, "submit_decision", fake_submit)
    r = client.post("/api/orwell/decision", json={"kind": "secret-veto", "use": use})
    assert r.status_code == 200
    # `use: false` (HOLD) must survive the relay — a dropped falsy field would read as a malformed answer.
    assert seen.get("kind") == "secret-veto" and seen.get("use") is use


def test_ws_relay_and_model_schema_share_the_one_kind_source():
    ws = importlib.import_module("routes.ws_routes")
    assert "secret-veto" in ws._DECISION_KINDS
    assert ws._DECISION_KINDS is orwell_engine.DECISION_KINDS
    importlib.import_module("src.agent_tools")  # import order: tool_schemas has a cycle with agent_tools
    schemas = importlib.import_module("src.tool_schemas")
    enums = []

    def walk(o):
        if isinstance(o, dict):
            if o.get("enum") and "secret-veto" in o["enum"]:
                enums.append(o["enum"])
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(schemas.FUNCTION_TOOL_SCHEMAS)
    assert enums, "the model's submitDecision schema must advertise secret-veto"


def test_decision_card_builds_a_play_hold_card_and_posts_an_explicit_boolean():
    js = _read("static", "js", "orwellDecision.js")
    # The card branch: two explicit choices, no person pick.
    branch = js[js.index('kind === "secret-veto") {'):][:900]
    assert "Play the secret veto" in branch and "Hold it" in branch
    # The wire payload: an explicit choice only (null until chosen ⇒ Confirm stays disabled), then a boolean.
    assert re.search(r'kind === "secret-veto"\) return useVeto === null \? null : \{ kind, use: useVeto === true \}', js)
    # It is a high-stakes (irreversible, one-time) kind and has a title + a "choose to enable Confirm" hint.
    assert re.search(r'HIGH_STAKES_KINDS\s*=\s*new Set\(\[.*?"secret-veto".*?\]\)', js, re.S)
    assert '"secret-veto": "Your secret veto' in js
    assert 'kind === "secret-veto") return "Choose to play your secret veto or hold it' in js


def test_fast_forward_resolvers_answer_secret_veto_with_an_explicit_boolean():
    """The throwaway fast-forward resolvers must clear a secret-veto pending with `use` set (the engine
    boundary refuses a missing boolean), or a flag-on matrix/finish run would stall on it."""
    py = _read("scripts", "responsive_matrix.py")
    assert re.search(r'if kind == "secret-veto":.*?return \{"kind": kind, "use": False\}', py, re.S)
    mjs = open(os.path.join(os.path.dirname(FRONTEND), "docs", "audits", "playtest-harness", "s4ff.mjs"),
               encoding="utf-8").read()
    assert "case 'secret-veto': return { kind: 'secret-veto', use: false }" in mjs
