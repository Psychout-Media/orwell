"""#1336 — the #1313 house-entry-gate residuals, formalized.

Residual (1) — the STATUS-POLL race. The engine flips ``started=True`` internally the instant
createCharacter commits, while the gate HOLDS the tool return for the authoring wait. The
``_house_entry_overlay`` mask in ``routes/orwell_routes.py`` is the latch (kept — no new
castingHouse phase enum); this file formalizes its DoD: **the status projection can never claim
``started`` while the entry gate holds**, proven by polling /status and /state concurrently DURING
a stubbed slow authoring pass. The FE-side gap is closed by stamping the hold marker synchronously
with the committed create result (zero awaits in between, ``src/tool_implementations.py``).

(Scope note: the mask is FE-process-side. The sub-millisecond cross-process window while the
engine's HTTP response is still in flight is not closable by an FE mask — an engine-side
``castingHouse`` phase would be the future option if it ever matters.)

Residual (3) — gate-wait UX. During the hold the player used to see only the generic tool-running
node; the "Production is finalizing your casting…" card fired only on the tool RESULT. chat.js now
paints it at ``tool_start`` for createCharacter, so the holding copy shows for the whole wait
(source-pinned here; the card itself is exercised in the browser lane —
test_1336_finalizing_card_browser.py).

Residual (2) — the prewarmed-branch #976 fall-through (ADR 0013) — is covered in
test_adr0013_photo_requires_authoring.py.

Roles only — every string is a generic probe, never cast material.
"""
import asyncio
import importlib
import json
import os
import re

import httpx
import pytest
from fastapi import FastAPI

ti = importlib.import_module("src.tool_implementations")
oe = importlib.import_module("src.orwell_engine")
ca = importlib.import_module("src.orwell_cast_authoring")
cid = importlib.import_module("src.orwell_cast_identity")
orwell_routes = importlib.import_module("routes.orwell_routes")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


def _started_res():
    """A started-season engine result with a full 15-NPC house + portrait prompts."""
    house = [{"id": "player", "name": "The Player"}]
    prompts = [{"houseguestId": "player", "name": "The Player", "prompt": "headshot"}]
    for i in range(1, 16):
        house.append({"id": f"npc:{i}", "name": f"Houseguest {i}"})
        prompts.append({"houseguestId": f"npc:{i}", "name": f"Houseguest {i}", "prompt": "headshot"})
    return {"started": True, "house": house, "portraitPrompts": prompts}


# ── residual (1): poll /status + /state DURING a stubbed slow authoring pass ─────────


def test_status_projection_never_claims_started_during_a_slow_hold(monkeypatch, run):
    """THE #1336 DoD test: drive the REAL do_create_character with the gate ON and a SLOW stubbed
    authoring pass, and poll the REAL /api/orwell/status + /api/orwell/state routes concurrently
    the whole time. No poll may ever claim ``started`` (or surface a pending decision card) while
    the entry gate holds; the moment the tool returns started, the projections pass through again."""
    # The unauthenticated route polls resolve to the DEFAULT user — the tool call must run as the
    # same user or the overlay (keyed per user) would rightly not engage for these polls.
    OWNER = None
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    ca.clear_house_entry_gate_block(OWNER)

    committed = {"v": False}  # the engine's internal started flip — set the instant create commits

    async def fake_create(*a, **k):
        committed["v"] = True  # the engine season is LIVE from here on
        return _started_res()
    monkeypatch.setattr(oe, "create_character", fake_create)

    async def fake_state(user=None, timeout=None, **k):
        # The restart probe (pre-commit) sees a not-started game; every later read sees the live
        # season — exactly the engine truth the overlay must mask mid-hold.
        return {"started": committed["v"], "moment": "premiere", "house": []}
    monkeypatch.setattr(oe, "get_game_state", fake_state)

    async def fake_status(user=None, **k):
        return {"started": committed["v"], "week": 1, "pending": {"kind": "hoh-intent"}}
    monkeypatch.setattr(oe, "game_status", fake_status)

    # No background authoring/identity tasks — the gate is what we exercise.
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)

    async def _gate(owner):
        return True
    monkeypatch.setattr(ca, "house_entry_gate_active", _gate)

    async def slow_ready(owner, **k):
        # The stubbed SLOW authoring pass — yields repeatedly so concurrent polls land mid-hold.
        for _ in range(8):
            await asyncio.sleep(0.01)
        return {"ready": True, "authored": 14, "total": 15, "missing": 1}
    monkeypatch.setattr(ca, "await_house_ready", slow_ready)

    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())

    async def _drive():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            task = asyncio.create_task(ti.do_create_character('{"playerName":"P"}', owner=OWNER))
            polls = []
            while not task.done():
                r1 = await client.get("/api/orwell/status")
                polls.append(("status", r1.json()))
                r2 = await client.get("/api/orwell/state")
                polls.append(("state", r2.json()))
                await asyncio.sleep(0.002)
            res = await task
            after_status = (await client.get("/api/orwell/status")).json()
            after_state = (await client.get("/api/orwell/state")).json()
            return polls, res, after_status, after_state

    try:
        polls, res, after_status, after_state = run(_drive())
    finally:
        ca.clear_house_entry_gate_block(OWNER)

    # The tool itself returned the started season (the slow pass ended ready).
    assert res["exit_code"] == 0
    out = json.loads(res["output"])
    assert out.get("started") is True

    # THE INVARIANT: not one concurrent poll — status or state — ever claimed a started game
    # (nor leaked a pending decision card) while the entry gate held the tool return.
    offenders = [(route, body) for route, body in polls if body.get("started") is True]
    assert offenders == [], \
        f"a concurrent poll claimed started mid-hold (#1336 residual 1): {offenders[:3]}"

    # And we genuinely polled MID-HOLD (the overlay engaged, not just pre-commit passes).
    overlaid = [body for _route, body in polls if "castingHouse" in body]
    assert len(overlaid) >= 3, \
        f"the slow pass must be observed mid-hold by several polls (saw {len(overlaid)})"
    assert all((b.get("castingHouse") or {}).get("state") == "authoring" for b in overlaid)
    assert all(b.get("pending") is None for b in overlaid), \
        "no decision card may surface through the overlay while holding"

    # Gate cleared with the started return ⇒ the projections pass through again.
    assert ca.house_entry_gate_status(OWNER) is None
    assert after_status.get("started") is True and after_state.get("started") is True


def test_hold_marker_is_stamped_synchronously_with_the_committed_create(monkeypatch, run):
    """The FE-side gap-closer: the hold marker must be set in the SAME task step as receiving the
    committed create result — before the portrait section's awaits ever run — so the first
    possible interleaved poll already reads the latch. Proven by asserting the marker is visible
    from the very first await point after the create returns (the gate check is hoisted BEFORE
    the create, so nothing async separates commit from stamp)."""
    OWNER = "stamp-1336"
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    ca.clear_house_entry_gate_block(OWNER)

    seen = {}

    async def fake_create(*a, **k):
        seen["marker_before_commit"] = ca.house_entry_gate_status(OWNER)
        return _started_res()
    monkeypatch.setattr(oe, "create_character", fake_create)

    async def fake_state(*a, **k):
        return {"started": False}
    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)

    async def _gate(owner):
        return True
    monkeypatch.setattr(ca, "house_entry_gate_active", _gate)

    # The prewarm probe is the FIRST await-bearing section after the create returns; a poll could
    # interleave there. The marker must ALREADY be set by then.
    import src.orwell_prewarm as pw
    real_warm_state = pw.warm_state

    def spy_warm_state(user=None):
        seen.setdefault("marker_at_first_post_create_seam", ca.house_entry_gate_status(OWNER))
        return real_warm_state(user)
    monkeypatch.setattr(pw, "warm_state", spy_warm_state)

    async def _ready(owner, **k):
        return {"ready": True, "authored": 15, "total": 15, "missing": 0}
    monkeypatch.setattr(ca, "await_house_ready", _ready)

    res = run(ti.do_create_character('{"playerName":"P"}', owner=OWNER))
    assert res["exit_code"] == 0
    assert seen.get("marker_before_commit") is None, "no hold before the engine commits"
    assert seen.get("marker_at_first_post_create_seam") is not None, (
        "the hold marker must be stamped synchronously with the committed create result — "
        "BEFORE the portrait section (the first post-create await) runs"
    )
    assert ca.house_entry_gate_status(OWNER) is None, "cleared once the gate passes"


# ── residual (1) formalized: the overlay is wired on every started-bearing projection ─


def test_both_status_and_state_routes_route_through_the_overlay():
    """Source pin: /api/orwell/status and /api/orwell/state must BOTH return through
    ``_house_entry_overlay`` (the one status-read latch). A new started-bearing projection must
    join them — never bypass the mask."""
    src = _read("routes/orwell_routes.py")
    assert src.count("return _house_entry_overlay(") + src.count("_project_for_browser(_house_entry_overlay(") >= 2, (   # ORW-768: /status returns the overlay through its closed shape
        "/status and /state must both return through _house_entry_overlay — the latch has "
        "exactly one seam, and both started-bearing projections must use it"
    )
    # The overlay masks started, drops the pending card, and reports the castingHouse phase.
    body = src[src.index("def _house_entry_overlay"):]
    body = body[:body.index("\ndef ", 10)]
    assert 'out["started"] = False' in body
    assert 'out["pending"] = None' in body
    assert '"castingHouse"' in body


# ── residual (3): the finalizing card shows DURING the hold, not only on the result ──


def _chat_tool_start_block():
    js = _read("static/js/chat.js")
    start = js.index("} else if (json.type === 'tool_start') {")
    end = js.index("} else if (json.type === 'tool_progress') {")
    assert end > start
    return js[start:end]


def test_finalizing_card_paints_at_tool_start_for_create_character():
    """Source pin (#1336 residual 3): the gate can hold the createCharacter return for a whole
    authoring pass, so the 'Production is finalizing your casting…' card must begin at
    ``tool_start`` — DURING the hold — not only on the tool result."""
    block = _chat_tool_start_block()
    assert "createCharacter" in block and "window._orwellFinalizing.begin()" in block, (
        "chat.js's tool_start handler must paint the finalizing card when createCharacter STARTS "
        "(the gate-wait UX — the hold must never read as a generic frozen tool node)"
    )
    # The active flag rides along so the narration-token / finally clears still fire.
    assert "_orwellFinalizingActive = true" in block


def test_tool_result_repaint_and_clears_are_preserved():
    """The original result-time begin stays (idempotent safety re-paint), and both clear paths
    (first narration token + the finally safety net) remain."""
    js = _read("static/js/chat.js")
    assert js.count("window._orwellFinalizing.begin()") >= 2, \
        "both the tool_start paint and the tool_output re-paint must exist"
    assert js.count("window._orwellFinalizing.end()") >= 2, \
        "the narration-token clear and the finally safety net must both remain"


def test_finalizing_begin_is_idempotent_in_source():
    """begin() must stay idempotent — the tool_start paint plus the tool_output re-paint may
    never stack two cards."""
    js = _read("static/js/orwellFinalizing.js")
    assert re.search(r"if \(document\.getElementById\(ID\)\) return", js), \
        "orwellFinalizing.begin() must no-op when the card is already showing"
