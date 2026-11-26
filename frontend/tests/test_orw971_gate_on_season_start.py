"""ORW-971 (1) - a gate-ON season start through the real web-tier path.

Prod, 2026-11-26: a real season sat held at house entry for hours. No test caught it because every gate test stubs the
authored count and CI runs with no model, so the gate is OFF there. Here the gate is turned on the way production does it
(a model resolves, the floor-start hatch is unset) and nothing about readiness is stubbed: `do_create_character`,
`house_entry_gate_active`, `await_house_ready`, `authoring_completeness_for`, the roster-card derivation, the watch, the
hold marker, the season checklist and the `/state` route all run for real. Only the engine (its reads and its create) and
the model are fakes.

The cast is 15 houseguests with the premiere's entrances running: the player has walked in, eight houseguests have, seven
have not, so the engine's public read shows only the arrived and counts the rest in `unarrivedCount`, while the pipeline
read has all fifteen. Pinned: with all 15 cards authored `/state` reports a started game (not the overlay), the hold marker is
cleared and the checklist records the hold done; with 14 of 15 authored the overlay holds. On the ORW-948 build (the gate
comparing the arrived count with 15) the positive test fails.

Roles only - every name is an invented probe.
"""
import asyncio
import importlib
import json

import httpx
import pytest
from fastapi import FastAPI

ti = importlib.import_module("src.tool_implementations")
oe = importlib.import_module("src.orwell_engine")
ca = importlib.import_module("src.orwell_cast_authoring")
cid = importlib.import_module("src.orwell_cast_identity")
sc = importlib.import_module("src.orwell_season_checklist")
zg = importlib.import_module("src.orwell_zeitgeist")
pa = importlib.import_module("src.orwell_producer_authoring")
words = importlib.import_module("src.orwell_npc_minds_words")
orwell_routes = importlib.import_module("routes.orwell_routes")
gs = importlib.import_module("src.orwell_game_session")

OWNER = None  # what the route resolves for an unauthenticated probe; the marker and the checklist key on the same owner
N = 15
ARRIVED = 8   # houseguests (besides the player) who have walked in; the player is not the last to enter


def _card(i, *, authored):
    c = {"id": f"npc:{i}", "name": f"Houseguest {i}", "status": "active", "authored": authored}
    if authored:
        c.update(biography="Grew up near the water and still fixes boats.", identityConcept="a boat-fixer who reads a room",
                 physicalCharacteristics={"wardrobe": ["tee"], "onCamera": "arms folded", "photoHair": "short"})
    return c


class FakeEngine:
    """The engine's reads, as the premiere serves them. `authored` is the set of NPC numbers whose card is authored."""

    def __init__(self):
        self.authored = set()
        self.pipeline_ok = True

    def _house(self, nums):
        return [_card(i, authored=i in self.authored) for i in nums]

    async def get_game_state(self, user=None, **k):
        return {"started": True, "moment": "premiere", "player": {"id": "player", "name": "The Player", "status": "active"},
                "house": self._house(range(1, ARRIVED + 1)), "unarrivedCount": N - ARRIVED}

    async def pipeline_cast(self, user=None, **k):
        if not self.pipeline_ok:
            raise RuntimeError("engine without the pipeline read")
        return {"started": True, "total": N, "unarrivedCount": N - ARRIVED, "house": self._house(range(1, N + 1))}

    async def create_character(self, *a, **k):
        house = [{"id": "player", "name": "The Player"}] + [{"id": f"npc:{i}", "name": f"Houseguest {i}"} for i in range(1, N + 1)]
        return {"started": True, "house": house}


@pytest.fixture
def eng(monkeypatch):
    e = FakeEngine()
    monkeypatch.setattr(oe, "create_character", e.create_character)
    monkeypatch.setattr(oe, "get_game_state", e.get_game_state)
    monkeypatch.setattr(oe, "get_game_state_polled", e.get_game_state)
    monkeypatch.setattr(oe, "pipeline_cast", e.pipeline_cast)

    async def no_warm(*a, **k):
        return {"warmed": False}
    monkeypatch.setattr(oe, "pre_seed_cast", no_warm)

    # The gate is turned ON the way production does: the escape hatch is unset and a model resolves.
    monkeypatch.delenv("ORWELL_ALLOW_FLOOR_START", raising=False)

    async def model(owner, *a, **k):
        return lambda messages: "{}"
    monkeypatch.setattr(ca, "_resolve_llm_fn", model)

    # Short waits; no real authoring, identity seeding or post-start work (the kicks are counted).
    monkeypatch.setattr(ca, "_HOUSE_READY_INLINE_S", 0.05)
    monkeypatch.setattr(ca, "_HOUSE_READY_POLL_S", 0.01)
    monkeypatch.setattr(ca, "_HOUSE_READY_WATCH_TIMEOUT_S", 5.0)
    monkeypatch.setattr(ca, "kickoff_authoring_backfill", lambda ids, owner=None, **k: None)
    monkeypatch.setattr(cid, "kickoff_identity", lambda *a, **k: None)
    kicks = []
    monkeypatch.setattr(zg, "kickoff_capture", lambda owner: kicks.append("world_snapshot"))
    monkeypatch.setattr(pa, "kickoff_producer_authoring", lambda owner: kicks.append("producer_persona"))
    monkeypatch.setattr(words, "kickoff_npc_minds_words", lambda owner: kicks.append("habits_culture"))
    monkeypatch.setattr(gs, "publish_game_updated", lambda owner: None, raising=False)
    e.kicks = kicks
    ca._HOUSE_ENTRY_GATE_BLOCKS.clear()
    ca._HOUSE_READY_WATCHES.clear()
    yield e
    for t in list(ca._HOUSE_READY_WATCHES.values()):
        try:
            t.cancel()
        except RuntimeError:  # its loop is already closed
            pass
    ca._HOUSE_ENTRY_GATE_BLOCKS.clear()
    ca._HOUSE_READY_WATCHES.clear()


def _app_client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://probe")


async def _start(run_watch_for=0.0):
    out = json.loads((await ti.do_create_character('{"playerName":"P"}', owner=OWNER))["output"])
    if run_watch_for:
        await asyncio.sleep(run_watch_for)
    return out


async def _state(client):
    r = await client.get("/api/orwell/state")
    assert r.status_code == 200, r.text
    return r.json()


def _hold_step():
    return sc.get_record(OWNER)["steps"]["house_hold"]


def test_the_gate_is_on_in_this_setup(eng, run):
    """Control: the real decision, unstubbed, says ON here (so the tests below exercise the gate, not the CI default of OFF)."""
    assert run(ca.house_entry_gate_active(OWNER)) is True


@pytest.mark.parametrize("pipeline_ok", [True, False], ids=["full-cast-read", "met-only-read"])
def test_a_fully_authored_cast_opens_the_season(eng, run, pipeline_ok):
    """The player is not last in; the fifteen cards get authored while the entrances run. The hold clears, `/state` reports a started game,
    the checklist records the hold done and the deferred post-start steps are kicked once. `met-only-read` is the engine without the full-cast read (ORW-948)."""
    eng.pipeline_ok = pipeline_ok
    cast = set(range(1, N + 1)) if pipeline_ok else set(range(1, ARRIVED + 1))  # the met-only read can only ever see the arrived cards

    async def go():
        async with _app_client() as client:
            # nothing authored yet at the moment of creation: the holding card, the watch armed, the overlay up
            eng.authored = set()
            first = await _start()
            assert first["started"] is False and first["castingHouse"]["state"] == "authoring"
            assert ca.house_entry_gate_status(OWNER) is not None
            assert _hold_step()["detail"] == "held"
            held = await _state(client)
            assert held["started"] is False and held["castingHouse"]["state"] == "authoring"
            # the cast lands; the background watch releases the hold
            eng.authored = cast
            for _ in range(300):
                if ca.house_entry_gate_status(OWNER) is None:
                    break
                await asyncio.sleep(0.02)
            st = await _state(client)
            return st

    st = run(go())
    assert ca.house_entry_gate_status(OWNER) is None, "the hold marker is cleared once the cast is authored"
    assert st["started"] is True and "castingHouse" not in st, "/state reports a started game, not the overlay"
    assert _hold_step()["status"] == "done" and _hold_step()["detail"] == "released"
    assert sorted(eng.kicks) == ["habits_culture", "producer_persona", "world_snapshot"], "the deferred post-start steps run exactly once"


def test_one_card_short_keeps_the_overlay(eng, run):
    """14 of 15 authored (one still to walk in is on the floor): the gate holds, the overlay stays, the checklist keeps the hold owed."""
    eng.authored = set(range(1, N))  # npc:15, an unarrived houseguest, is on the floor

    async def go():
        async with _app_client() as client:
            first = await _start(run_watch_for=0.3)  # several watch polls
            return first, await _state(client)

    first, st = run(go())
    assert first["started"] is False and first["castingHouse"]["authored"] == N - 1 and first["castingHouse"]["total"] == N
    assert st["started"] is False and st["castingHouse"]["authored"] == N - 1
    assert ca.house_entry_gate_status(OWNER) is not None
    assert _hold_step()["status"] == "owed" and _hold_step()["detail"] == "held"
    assert eng.kicks == [], "no post-start step runs while the season is held"
