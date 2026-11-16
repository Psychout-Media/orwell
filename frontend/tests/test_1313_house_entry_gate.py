"""#1313 (P0) — the house-entry authoring gate: the game must NEVER start on the deterministic
FLOOR cast (0/15 authored).

`do_create_character` must HOLD house entry until the cast is authored to the FULL cast size
(`HOUSE_READY_MIN_AUTHORED == 15/15` — PO ruling 2026-07-10: the deterministic seeded floor is
NEVER a viable cast identity in prod, so the gate is the whole cast, not a tolerance band), but
ONLY when authoring can actually run — a real utility model resolves — and the operator has not
set the `ORWELL_ALLOW_FLOOR_START=1` escape hatch. With no model (the whole LLM-stubbed test suite)
the gate is OFF and start is instant, byte-identical to before.

The gate is a LATCH, not just a masked tool response: the engine season is live internally the
instant create_character commits, so while the gate holds, the /status and /state projections must
overlay the authoring/holding state (never a started game), and the post-start kicks skipped by a
refused entry (the 0062 zeitgeist) must run exactly once when the gate later clears.

Roles only — every string is a generic probe, never cast material.
"""
import asyncio
import importlib
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ti = importlib.import_module("src.tool_implementations")
oe = importlib.import_module("src.orwell_engine")
ca = importlib.import_module("src.orwell_cast_authoring")
cid = importlib.import_module("src.orwell_cast_identity")
orwell_routes = importlib.import_module("routes.orwell_routes")


def _started_res():
    """A started-season engine result with a full 15-NPC house + portrait prompts."""
    house = [{"id": "player", "name": "The Player"}]
    prompts = [{"houseguestId": "player", "name": "The Player", "prompt": "headshot"}]
    for i in range(1, 16):
        house.append({"id": f"npc:{i}", "name": f"Houseguest {i}"})
        prompts.append({"houseguestId": f"npc:{i}", "name": f"Houseguest {i}", "prompt": "headshot"})
    return {"started": True, "house": house, "portraitPrompts": prompts}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    """Stub the engine create + the identity/portrait kickoffs so the test drives only the gate."""
    async def fake_create(*a, **k):
        return _started_res()
    monkeypatch.setattr(oe, "create_character", fake_create)

    # Neutralise the early restart-probe engine read (no live engine in-process).
    async def fake_state(*a, **k):
        return {"started": False}
    monkeypatch.setattr(oe, "get_game_state", fake_state)

    # The identity seed chains authoring in the fallback branch — stub it to a no-op so no background
    # authoring tasks are scheduled (the gate itself is what we exercise, via await_house_ready stubs).
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)
    yield


def _make_ready(*, ready, authored, total=None):
    """Readiness-result stub — `total` defaults to the module's cast-size constant so a future
    cast-size change flows through automatically (never a stale hardcoded 15)."""
    total = ca._HOUSE_READY_TOTAL_DEFAULT if total is None else total

    async def _fn(owner, **k):
        return {"ready": ready, "authored": authored, "total": total,
                "missing": max(0, total - authored)}
    return _fn


async def _async_true(owner):
    return True


# ── (a) the runtime gate ─────────────────────────────────────────────────────────────

def test_gate_holds_start_when_cast_underauthored(monkeypatch, run):
    """Gate ON + authoring below the threshold ⇒ NOT started + a visible casting-in-progress state,
    and the background gate-clear watch is armed (the deferred zeitgeist rides on it)."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    monkeypatch.setattr(ca, "house_entry_gate_active", _async_true)
    monkeypatch.setattr(ca, "await_house_ready", _make_ready(ready=False, authored=3))
    watch = {"n": 0, "on_ready": None}

    def fake_watch(owner, on_ready=None, **k):
        watch["n"] += 1
        watch["on_ready"] = on_ready
        return True
    monkeypatch.setattr(ca, "kickoff_house_ready_watch", fake_watch)

    res = run(ti.do_create_character('{"playerName":"P"}', owner="bob"))
    assert res["exit_code"] == 0
    out = json.loads(res["output"])
    assert out.get("started") is False, "the game must NOT start on an under-authored floor cast"
    ch = out.get("castingHouse") or {}
    assert ch.get("state") == "authoring"
    assert ch.get("authored") == 3 and ch.get("total") == 15
    assert isinstance(out.get("message"), str) and out["message"], "a player-visible pending message"
    # a LOUD health marker was recorded (never a silent floor start)
    marker = ca.house_entry_gate_status("bob")
    assert marker is not None and marker.get("authored") == 3
    # and the gate-clear watch was armed with the deferred post-start kick
    assert watch["n"] == 1 and callable(watch["on_ready"])
    ca.clear_house_entry_gate_block("bob")


def test_held_start_still_reports_a_strategy_style_substitution(monkeypatch, run):
    """ORW-208 (review of #2252): the holding return skips the normal result, so it must carry the engine's strategy-style
    substitution itself (health note + narrator line), or the substitution goes silent for a held start."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    adj = {"requested": "strategic", "applied": "emotional", "archetype": "wildcard"}

    async def fake_create(*a, **k):
        return {**_started_res(), "strategyStyleAdjusted": adj}
    monkeypatch.setattr(oe, "create_character", fake_create)
    monkeypatch.setattr(ca, "house_entry_gate_active", _async_true)
    monkeypatch.setattr(ca, "await_house_ready", _make_ready(ready=False, authored=3))
    monkeypatch.setattr(ca, "kickoff_house_ready_watch", lambda owner, on_ready=None, **k: True)
    ep = importlib.import_module("src.enrichment_policy")
    notes = []
    monkeypatch.setattr(ep, "record_runtime_failure", lambda *a, **k: notes.append(a))
    res = run(ti.do_create_character('{"playerName":"P"}', owner="orw208-hold"))
    out = json.loads(res["output"])
    assert out.get("started") is False and (out.get("castingHouse") or {}).get("state") == "authoring"
    assert out.get("strategyStyleAdjusted") == adj
    assert 'stored strategy style is "emotional"' in out.get("strategyStyleNote", "")
    assert any(a[1] == "casting-strategy-style" for a in notes)
    ca.clear_house_entry_gate_block("orw208-hold")


def test_gate_allows_start_when_cast_authored(monkeypatch, run):
    """Gate ON + the FULL cast authored ⇒ the game STARTS (normal started result)."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    ca.clear_house_entry_gate_block("carol")
    monkeypatch.setattr(ca, "house_entry_gate_active", _async_true)
    monkeypatch.setattr(ca, "await_house_ready",
                        _make_ready(ready=True, authored=ca.HOUSE_READY_MIN_AUTHORED))

    res = run(ti.do_create_character('{"playerName":"P"}', owner="carol"))
    assert res["exit_code"] == 0
    out = json.loads(res["output"])
    assert out.get("started") is True, "an authored cast lets the game start"
    assert ca.house_entry_gate_status("carol") is None, "a clean start leaves no block marker"


def test_hold_marker_is_set_before_the_readiness_wait(monkeypatch, run):
    """The status latch: the holding marker must be visible DURING the wait (a concurrent /status
    poll overlays off it), and cleared once the gate passes."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)
    monkeypatch.setattr(ca, "house_entry_gate_active", _async_true)
    seen = {}

    async def _ready_capturing(owner, **k):
        seen["marker_during_wait"] = ca.house_entry_gate_status(owner)
        return {"ready": True, "authored": 15, "total": 15, "missing": 0}
    monkeypatch.setattr(ca, "await_house_ready", _ready_capturing)

    res = run(ti.do_create_character('{"playerName":"P"}', owner="hank"))
    assert res["exit_code"] == 0
    assert seen.get("marker_during_wait") is not None, \
        "the hold marker must be set BEFORE the readiness wait (the /status overlay reads it)"
    assert seen["marker_during_wait"].get("state") == "authoring"
    assert ca.house_entry_gate_status("hank") is None, "cleared once the gate passes"


def test_escape_hatch_forces_immediate_start(monkeypatch, run):
    """ORWELL_ALLOW_FLOOR_START=1 ⇒ gate OFF: the game starts immediately, authoring never awaited."""
    monkeypatch.setenv("ORWELL_ALLOW_FLOOR_START", "1")
    called = {"n": 0}

    async def _must_not_wait(owner, **k):
        called["n"] += 1
        return {"ready": False, "authored": 0, "total": 15, "missing": 15}
    monkeypatch.setattr(ca, "await_house_ready", _must_not_wait)

    res = run(ti.do_create_character('{"playerName":"P"}', owner="dave"))
    assert res["exit_code"] == 0
    out = json.loads(res["output"])
    assert out.get("started") is True, "the escape hatch must start immediately"
    assert called["n"] == 0, "the readiness poll must never run when the gate is off"


def test_no_model_means_gate_off(monkeypatch, run):
    """No utility model resolves ⇒ authoring can't run ⇒ gate OFF (instant start, never a deadlock)."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)

    async def _no_model(owner):
        return None
    monkeypatch.setattr(ca, "_resolve_llm_fn", _no_model)
    called = {"n": 0}

    async def _spy(owner, **k):
        called["n"] += 1
        return {"ready": False, "authored": 0, "total": 15, "missing": 15}
    monkeypatch.setattr(ca, "await_house_ready", _spy)

    res = run(ti.do_create_character('{"playerName":"P"}', owner="erin"))
    out = json.loads(res["output"])
    assert out.get("started") is True
    assert called["n"] == 0, "with no model the gate is off — no readiness wait"


# ── the gate-active decision ─────────────────────────────────────────────────────────

def test_house_entry_gate_active_decision(monkeypatch, run):
    """ON iff a real utility model resolves AND the escape hatch is unset."""
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)

    async def _model(owner):
        return lambda messages: "{}"
    monkeypatch.setattr(ca, "_resolve_llm_fn", _model)
    assert run(ca.house_entry_gate_active("u")) is True

    # escape hatch forces OFF even with a model
    monkeypatch.setenv("ORWELL_ALLOW_FLOOR_START", "1")
    assert run(ca.house_entry_gate_active("u")) is False

    # no model ⇒ OFF
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)

    async def _none(owner):
        return None
    monkeypatch.setattr(ca, "_resolve_llm_fn", _none)
    assert run(ca.house_entry_gate_active("u")) is False


# ── the gate threshold IS the full cast (PO ruling 2026-07-10) ──────────────────────

def test_house_ready_min_authored_equals_full_cast_size():
    """PO ruling 2026-07-10: the deterministic seeded floor is NEVER a viable cast identity in
    prod, so the gate threshold must equal the FULL NPC cast size — no tolerance band, no NPC may
    enter the house un-authored. Pins the invariant (threshold == cast total) rather than a literal
    number, so a future cast-size change can't silently reopen the gap this ruling closed."""
    assert ca.HOUSE_READY_MIN_AUTHORED == ca._HOUSE_READY_TOTAL_DEFAULT == 15


# ── await_house_ready poll semantics ─────────────────────────────────────────────────

def test_await_house_ready_returns_on_threshold(monkeypatch, run):
    """Polls completeness and returns ready the moment authored crosses the threshold — pinned to
    the INVARIANT (`HOUSE_READY_MIN_AUTHORED`, the full cast size), never a literal number, so a
    future cast-size change can't silently reopen the gap."""
    threshold = ca.HOUSE_READY_MIN_AUTHORED
    total = ca._HOUSE_READY_TOTAL_DEFAULT
    seq = iter([{"authored": threshold - 1, "total": total, "missing": total - (threshold - 1)},
                {"authored": threshold, "total": total, "missing": total - threshold}])

    async def _comp(owner):
        try:
            return next(seq)
        except StopIteration:
            return {"authored": threshold, "total": total, "missing": total - threshold}
    monkeypatch.setattr(ca, "authoring_completeness_for", _comp)
    monkeypatch.setattr(ca, "_kick_backfill_for_stragglers", lambda owner: _noop())

    out = run(ca.await_house_ready("u", timeout=5, poll_interval=0.01))
    assert out["ready"] is True and out["authored"] == threshold


def test_await_house_ready_times_out_below_threshold(monkeypatch, run):
    """A cast that never reaches the threshold returns not-ready after the (tiny) timeout — no hang."""
    async def _comp(owner):
        return {"authored": 2, "total": 15, "missing": 13}
    monkeypatch.setattr(ca, "authoring_completeness_for", _comp)
    monkeypatch.setattr(ca, "_kick_backfill_for_stragglers", lambda owner: _noop())

    out = run(ca.await_house_ready("u", timeout=0.05, poll_interval=0.01))
    assert out["ready"] is False and out["authored"] == 2


async def _noop():
    return None


# ── the status-read latch: /status and /state overlay the holding state ─────────────

@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def test_status_reports_holding_state_during_gate_hold(monkeypatch, client):
    """While the gate holds, /status must report started:false + the castingHouse phase — the engine
    season is already live internally, and the raw projection would leak a started game mid-hold."""
    async def fake_status(user=None, **k):
        return {"started": True, "week": 1, "pending": {"kind": "hoh-intent"}}
    monkeypatch.setattr(orwell_routes.orwell_engine, "game_status", fake_status)

    ca.begin_house_entry_hold(None, {"authored": 4, "total": 15, "missing": 11})
    try:
        body = client.get("/api/orwell/status").json()
        assert body["started"] is False, "/status must not report a started game while holding"
        ch = body.get("castingHouse") or {}
        assert ch.get("state") == "authoring" and ch.get("authored") == 4 and ch.get("total") == 15
        assert body.get("pending") is None, "no decision card may render while holding"
    finally:
        ca.clear_house_entry_gate_block(None)
    # gate cleared ⇒ byte-identical pass-through (started again visible)
    body2 = client.get("/api/orwell/status").json()
    assert body2["started"] is True and body2["pending"] == {"kind": "hoh-intent"}


def test_state_reports_holding_state_during_gate_hold(monkeypatch, client):
    """Same latch on the /state (get_game_state) projection the HUD panels poll."""
    async def fake_state(user=None, timeout=None, **k):
        return {"started": True, "moment": "premiere", "house": []}
    monkeypatch.setattr(orwell_routes.orwell_engine, "get_game_state", fake_state)

    ca.begin_house_entry_hold(None, {"authored": 2, "total": 15, "missing": 13})
    try:
        body = client.get("/api/orwell/state").json()
        assert body["started"] is False
        assert (body.get("castingHouse") or {}).get("authored") == 2
    finally:
        ca.clear_house_entry_gate_block(None)
    body2 = client.get("/api/orwell/state").json()
    assert body2["started"] is True, "no hold ⇒ pass-through"


def test_overlay_never_touches_a_not_started_projection(client, monkeypatch):
    """Pre-game (casting interview) the projection is already started:false — the overlay must not
    invent a castingHouse phase there (it only masks a LIVE engine season during a hold)."""
    async def fake_status(user=None, **k):
        return {"started": False}
    monkeypatch.setattr(orwell_routes.orwell_engine, "game_status", fake_status)
    ca.begin_house_entry_hold(None, {"authored": 1, "total": 15})
    try:
        body = client.get("/api/orwell/status").json()
        assert body["started"] is False and "castingHouse" not in body
    finally:
        ca.clear_house_entry_gate_block(None)


# ── the gate-clear watch: deferred post-start kicks fire exactly once ────────────────

def test_watch_clears_marker_and_fires_post_start_exactly_once(monkeypatch, run):
    """A refused entry arms ONE watch; when authoring lands, the watch clears the holding overlay
    and runs the deferred post-start kick (the zeitgeist) exactly once."""
    monkeypatch.setattr(ca, "await_house_ready",
                        _make_ready(ready=True, authored=ca.HOUSE_READY_MIN_AUTHORED))
    gs = importlib.import_module("src.orwell_game_session")
    pushed = {"n": 0}
    monkeypatch.setattr(gs, "publish_game_updated",
                        lambda user=None: pushed.__setitem__("n", pushed["n"] + 1))
    calls = {"n": 0}

    async def _drive():
        ca.begin_house_entry_hold("w1", {"authored": 3, "total": 15})
        armed1 = ca.kickoff_house_ready_watch(
            "w1", on_ready=lambda: calls.__setitem__("n", calls["n"] + 1))
        # a second kick while one is armed must NOT arm another (the exactly-once guarantee)
        armed2 = ca.kickoff_house_ready_watch(
            "w1", on_ready=lambda: calls.__setitem__("n", calls["n"] + 1))
        for _ in range(6):
            await asyncio.sleep(0)
        return armed1, armed2
    armed1, armed2 = run(_drive())
    assert armed1 is True and armed2 is False
    assert calls["n"] == 1, "the deferred post-start kick must fire exactly once"
    assert ca.house_entry_gate_status("w1") is None, "the holding overlay is cleared on gate-clear"
    assert pushed["n"] == 1, "open pages get a server-side game-updated push on gate-clear"


def test_watch_keeps_marker_when_still_underauthored(monkeypatch, run):
    """A watch that expires below the threshold keeps the holding marker (stay loud, never a silent
    floor start) and never fires the post-start kick."""
    async def _never_ready(owner, **k):
        return {"ready": False, "authored": 5, "total": 15, "missing": 10}
    monkeypatch.setattr(ca, "await_house_ready", _never_ready)
    calls = {"n": 0}

    async def _drive():
        ca.begin_house_entry_hold("w2", {"authored": 3, "total": 15})
        ca.kickoff_house_ready_watch("w2", on_ready=lambda: calls.__setitem__("n", calls["n"] + 1))
        for _ in range(6):
            await asyncio.sleep(0)
    run(_drive())
    try:
        assert calls["n"] == 0
        marker = ca.house_entry_gate_status("w2")
        assert marker is not None and marker.get("authored") == 5
    finally:
        ca.clear_house_entry_gate_block("w2")


# ── env parsing (CodeRabbit minor): malformed values fall back, never raise ─────────

def test_env_float_malformed_value_falls_back(monkeypatch):
    monkeypatch.setenv("ORWELL_TEST_FLOAT_1313", "not-a-number")
    assert ca._env_float("ORWELL_TEST_FLOAT_1313", 42.0) == 42.0
    monkeypatch.setenv("ORWELL_TEST_FLOAT_1313", "3.5")
    assert ca._env_float("ORWELL_TEST_FLOAT_1313", 42.0) == 3.5
    monkeypatch.setenv("ORWELL_TEST_FLOAT_1313", "  ")
    assert ca._env_float("ORWELL_TEST_FLOAT_1313", 7.0) == 7.0
    monkeypatch.delenv("ORWELL_TEST_FLOAT_1313", raising=False)
    assert ca._env_float("ORWELL_TEST_FLOAT_1313", 7.0) == 7.0
