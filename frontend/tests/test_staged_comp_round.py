"""0006 staged-rounds evolution (FE side) — the per-round competition prompt.

A competition now plays out in VISIBLE elimination rounds: each round the player picks their approach
for THAT round (compete / throw / play-safe) based on who is still in. Anti-sycophancy is preserved PER
ROUND — the structured per-round selection is committed before the round resolves and posted ENGINE-DIRECT
(never read from prose), and a finished round can't be re-labeled. These tests pin the FE relay + barrier:

  1. the relay accepts `comp-round` as a valid binding decision kind and forwards the STRUCTURED `intent`
     (never prose) engine-direct;
  2. the pending barrier HARD-BLOCKS the model from narrating a comp result past an open `comp-round`
     (the engine, never the model, decides who survives — so a past round can't be re-labeled);
  3. the per-round prompt re-issues each round (the engine surfaces a fresh `comp-round` pending with the
     narrowed still-in field) and the relay forwards each one independently.

Roles only — no names.
"""
import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
chat_helpers = importlib.import_module("routes.chat_helpers")


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def test_relay_accepts_comp_round_and_forwards_structured_intent(client, monkeypatch):
    """The structured per-round approach posts engine-direct as `intent` — never parsed from prose."""
    seen = {}

    async def _capture(decision, user=None, **_kw):
        seen.update(decision)
        return {"started": True, "status": {"pending": None}}

    monkeypatch.setattr(orwell_engine, "submit_decision", _capture)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)

    r = client.post("/api/orwell/decision", json={"kind": "comp-round", "intent": "throw"})
    assert r.status_code == 200, r.text
    # The relay forwarded the STRUCTURED selection — the engine reads `intent`, never prose.
    assert seen.get("kind") == "comp-round"
    assert seen.get("intent") == "throw"


def test_comp_round_is_a_recognized_decision_kind(client, monkeypatch):
    """`comp-round` is in the relay's allow-list (an unknown kind is a 400, not a silent drop)."""
    assert "comp-round" in orwell_routes._DECISION_KINDS if hasattr(orwell_routes, "_DECISION_KINDS") else True

    async def _ok(decision, user=None, **_kw):
        return {"started": True}

    monkeypatch.setattr(orwell_engine, "submit_decision", _ok)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)
    # A recognized kind is accepted (200); a bogus kind is refused (400) — the allow-list is real.
    assert client.post("/api/orwell/decision", json={"kind": "comp-round", "intent": "compete"}).status_code == 200
    assert client.post("/api/orwell/decision", json={"kind": "not-a-kind", "intent": "compete"}).status_code == 400


def test_pending_barrier_blocks_narrating_past_an_open_comp_round(client):
    """The engine decides the comp; while a `comp-round` pending is open the model must NOT narrate a
    winner past it (so a finished round can never be retroactively re-labeled — anti-sycophancy)."""
    directive = chat_helpers._pending_barrier_directive(
        {"kind": "comp-round", "round": 2, "prompt": "Round 2 — set your approach", "by": {"name": "You"}}
    )
    assert directive, "an open comp-round pending must raise the hard-block barrier directive"
    low = directive.lower()
    # The directive pins the model to the decision and forbids advancing the fiction past it.
    assert "comp-round" in low or "approach" in low or "decision" in low
    # It must forbid narrating a competition result / beat past the open round.
    assert "do not" in low or "must not" in low or "forbid" in low or "never" in low


def test_per_round_prompt_re_issues_as_the_field_narrows(client, monkeypatch):
    """Each elimination round surfaces a FRESH `comp-round` pending (a smaller still-in field); the relay
    forwards each one independently — adaptation is forward, round by round."""
    posted = []

    async def _round(decision, user=None, **_kw):
        posted.append(decision)
        # After resolving round N, the engine surfaces round N+1 (a smaller field) until the last.
        n = len(posted)
        if n < 3:
            still = [{"id": f"npc({i})", "name": f"HG{i}"} for i in range(6 - n)]
            return {"started": True, "pending": {"kind": "comp-round", "round": n + 1, "stillIn": still}}  # ORW-769: the card's response carries `pending` at the top level (the closed shape the page reads)
        return {"started": True, "pending": None}

    monkeypatch.setattr(orwell_engine, "submit_decision", _round)
    monkeypatch.setattr(orwell_engine, "remember_pending", lambda *a, **k: None)

    # Drive three rounds, each posting the per-round approach; the field narrows each time.
    fields = []
    res = client.post("/api/orwell/decision", json={"kind": "comp-round", "intent": "compete"}).json()
    for _ in range(3):
        pending = res.get("pending")
        if not pending or pending.get("kind") != "comp-round":
            break
        fields.append(len(pending.get("stillIn") or []))
        res = client.post("/api/orwell/decision", json={"kind": "comp-round", "intent": "compete"}).json()

    assert len(posted) >= 3, "the player was prompted across multiple rounds"
    # The still-in field surfaced and narrowed across the rounds (strictly smaller each re-prompt).
    assert len(fields) >= 2
    for i in range(1, len(fields)):
        assert fields[i] < fields[i - 1], f"the still-in field must narrow each round: {fields}"
