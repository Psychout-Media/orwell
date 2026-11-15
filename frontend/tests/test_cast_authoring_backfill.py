"""Deep cast-authoring reliability spine — the SAME backfill/observability the 0051 portraits have.

Root cause closed here: LLM deep cast-authoring kicked off ONLY from the createCharacter / pre-warm
path, fire-and-forget with NO retry, backfill, or observability — so when the utility model was
absent/flaky at game start, every houseguest stayed a thin deterministic-FLOOR template forever (the
anti-"sameness" mandate #1 fails silently). This mirrors `orwell_portraits.{missing_portrait_ids,
completeness,portrait_completeness,kickoff_backfill}` for authoring.

A1 (ship-blocker, "the phantom-houseguest root") note: this backfill re-targets houseguests whose
`authored` flag is not-true (`unauthored_ids`, below) — that flag flips true off the PUBLIC facets
(biography/physicalCharacteristics/vocation), NOT off whether the name specifically landed. So a
houseguest whose name was refused by the engine's introduced-houseguest name-lock (because the
player already met them) but whose other authored facets DID land still flips `authored: true` and
drops out of future backfill targeting — the backfill never hammers a locked name in a retry loop.
The name-lock itself, and `author_cast`'s tolerance of a partial-field accept, are both covered in
`test_l28b_cast_authoring.py::test_l28b_author_cast_tolerates_the_engine_dropping_the_name_field`;
the engine-side invariant is `tests/unit/castNameRace.test.ts` (TS repo root).

Roles only — no names. The engine client and the authoring path are monkeypatched (never a real model).
Covers:
  • unauthored_ids: ACTIVE NPCs whose `authored` is not-true, EXCLUDING the player + departed
  • authoring_completeness: {total, authored, missing} math over the active NPC cast
  • kickoff_authoring_backfill: kicks, debounces per-user, respects force (authoring path stubbed)
  • the roster route kicks the authoring backfill (and not when complete)
  • POST /api/orwell/cast-authoring/backfill — {kicked, missing}, player-reachable, fail-open
  • the /admin/status (GET /api/admin/health) payload carries castAuthoring completeness
  • POST /api/admin/ops/reauthor-cast — admin-gated debug lever
"""

import asyncio
import importlib

import pytest
from conftest import _run
from fastapi import FastAPI
from fastapi.testclient import TestClient

A = importlib.import_module("src.orwell_cast_authoring")
orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
ahr = importlib.import_module("routes.admin_health_routes")


def _kick(ids, user, force=False):
    """Drive kickoff_authoring_backfill from INSIDE a running loop (the production posture: an async
    FastAPI route), then yield so the scheduled background task completes."""
    async def _inner():
        res = A.kickoff_authoring_backfill(ids, user, force=force)
        await asyncio.sleep(0)
        return res
    return _run(_inner())


@pytest.fixture(autouse=True)
def _clean_debounce(monkeypatch):
    """A clean per-test debounce table (mirrors the portraits tmp fixture)."""
    monkeypatch.setattr(A, "_LAST_AUTHORING_BACKFILL_AT", {})


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture
def admin_client():
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())
    app.include_router(ahr.setup_admin_status_page())
    return TestClient(app, raise_server_exceptions=False)


# A roster-card shape (what _roster_cards yields): id/name/status/isPlayer/portrait + the engine's
# `authored` flag. The HOUSE (rich skeleton) carries the same `authored` so the live cast resolution
# can filter on it; tests construct `authored` as needed (per the pinned contract).
_STATE = {
    "started": True,
    "player": {"id": "player", "name": "The Player", "status": "active", "authored": False},
    "house": [
        {"id": "npc:1", "name": "Houseguest One", "status": "active", "authored": True,
         "biography": "Grew up near the water and still fixes boats.", "identityConcept": "a boat-fixer who reads a room",
         "physicalCharacteristics": {"wardrobe": ["tee"], "onCamera": "arms folded", "photoHair": "short"}},  # a real authored entry carries its story (ORW-437)
        {"id": "npc:2", "name": "Houseguest Two", "status": "active", "authored": False},
        {"id": "npc:3", "name": "Houseguest Three", "status": "jury", "authored": False},
        {"id": "npc:4", "name": "Houseguest Four", "status": "active"},  # absent ⇒ floor
    ],
}


def _stub_state(monkeypatch, state=_STATE):
    async def fake_state(user=None, **k):
        return state
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)


# ── unauthored_ids: the one definition of "still on the floor" ─────────────────────────────

def test_unauthored_ids_flags_floor_npcs_and_excludes_the_player():
    cards = [
        {"id": "player", "status": "active", "isPlayer": True, "authored": False},  # excluded (player)
        {"id": "npc:1", "status": "active", "authored": True},    # authored — skip
        {"id": "npc:2", "status": "active", "authored": False},   # floor — flag
        {"id": "npc:3", "status": "active"},                      # authored absent ⇒ floor — flag
        {"id": "npc:4", "status": "jury", "authored": False},     # departed — never re-authored
        {"id": "npc:5", "status": "evicted"},                     # departed — never re-authored
    ]
    assert A.unauthored_ids("u", cards) == ["npc:2", "npc:3"]


def test_unauthored_ids_excludes_the_player_even_without_the_isplayer_flag():
    """The player is human-authored at OOBE — id "player" is excluded regardless of how the card
    flags it (a parallel engine change adds `authored`; the player just never has a deep-author path)."""
    cards = [
        {"id": "player", "status": "active", "authored": False},  # excluded by id
        {"id": "npc:1", "status": "active", "authored": False},
    ]
    assert A.unauthored_ids("u", cards) == ["npc:1"]


def test_unauthored_ids_empty_when_every_npc_authored():
    cards = [
        {"id": "player", "status": "active", "isPlayer": True, "authored": True},
        {"id": "npc:1", "status": "active", "authored": True},
        {"id": "npc:2", "status": "active", "authored": True},
    ]
    assert A.unauthored_ids("u", cards) == []


# ── authoring_completeness: the counter math ───────────────────────────────────────────────

def test_authoring_completeness_counts_active_npcs_only():
    cards = [
        {"id": "player", "status": "active", "isPlayer": True, "authored": False},  # excluded
        {"id": "npc:1", "status": "active", "authored": True},    # authored
        {"id": "npc:2", "status": "active", "authored": False},   # floor
        {"id": "npc:3", "status": "active"},                      # floor (absent)
        {"id": "npc:4", "status": "jury", "authored": False},     # departed — excluded
    ]
    # 3 active NPCs (1,2,3); 1 authored; 2 on the floor. The player + jury are NOT counted.
    assert A.authoring_completeness("u", cards) == {"total": 3, "authored": 1, "missing": 2, "givenUp": []}


def test_authoring_completeness_all_authored():
    cards = [
        {"id": "npc:1", "status": "active", "authored": True},
        {"id": "npc:2", "status": "active", "authored": True},
    ]
    assert A.authoring_completeness("u", cards) == {"total": 2, "authored": 2, "missing": 0, "givenUp": []}


def test_authoring_completeness_for_derives_from_the_public_projection(monkeypatch):
    _stub_state(monkeypatch)
    # _STATE: npc:1 authored; npc:2 + npc:4 on the floor; npc:3 is jury (excluded); player excluded.
    comp = _run(A.authoring_completeness_for("u"))
    assert comp == {"total": 3, "authored": 1, "missing": 2, "givenUp": []}


def test_authoring_completeness_for_is_none_pre_game_and_engine_down(monkeypatch):
    async def pre_game(user=None, **k):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", pre_game)
    assert _run(A.authoring_completeness_for("u")) is None

    async def down(user=None, **k):
        raise RuntimeError("engine unreachable")
    monkeypatch.setattr(orwell_engine, "get_game_state", down)
    assert _run(A.authoring_completeness_for("u")) is None


# ── kickoff_authoring_backfill: kicks, debounces, respects force ───────────────────────────

def test_kickoff_authoring_backfill_kicks_and_debounces_per_user(monkeypatch):
    runs = []

    async def fake_backfill(ids, user):
        runs.append((tuple(ids), user))
        return 0
    monkeypatch.setattr(A, "backfill_unauthored", fake_backfill)

    assert _kick(["npc:2"], "dave") is True
    assert _kick(["npc:2"], "dave") is False  # inside the window
    assert _kick(["npc:2"], "erin") is True   # other user unaffected
    assert len(runs) == 2

    # Window elapsed -> allowed again.
    A._LAST_AUTHORING_BACKFILL_AT["dave"] -= A.AUTHORING_BACKFILL_DEBOUNCE_S + 1
    assert _kick(["npc:2"], "dave") is True
    assert len(runs) == 3


def test_kickoff_authoring_backfill_force_bypasses_the_debounce(monkeypatch):
    runs = []

    async def fake_backfill(ids, user):
        runs.append(user)
        return 0
    monkeypatch.setattr(A, "backfill_unauthored", fake_backfill)

    assert _kick(["npc:2"], "fay") is True
    assert _kick(["npc:2"], "fay") is False         # debounced
    assert _kick(["npc:2"], "fay", force=True) is True  # explicit act runs NOW
    assert len(runs) == 2


def test_kickoff_authoring_backfill_noops_on_empty_missing_set(monkeypatch):
    async def boom(ids, user):
        raise AssertionError("must not run with nothing on the floor")
    monkeypatch.setattr(A, "backfill_unauthored", boom)
    assert _kick([], "gail") is False
    # An empty kick must NOT consume the debounce window.
    assert A.authoring_backfill_allowed("gail") is True


def test_kickoff_authoring_backfill_never_raises_into_the_caller(monkeypatch):
    async def explode(ids, user):
        raise RuntimeError("authoring blew up")
    monkeypatch.setattr(A, "backfill_unauthored", explode)
    # The kick schedules the failing task and returns True; the done-callback swallows the error.
    assert _kick(["npc:2"], "hank") is True


# ── backfill_unauthored: re-authors ONLY the floor NPCs via the authoring path ─────────────

def test_backfill_unauthored_reauthors_only_the_requested_floor_npcs(monkeypatch):
    _stub_state(monkeypatch)
    seen = {}

    async def fake_run_authoring(cast, owner, on_authored=None):
        seen["ids"] = [c.get("id") for c in cast]
        seen["owner"] = owner
        seen["on_authored"] = on_authored
        return len(cast)
    monkeypatch.setattr(A, "run_authoring", fake_run_authoring)

    # Ask for npc:2 + npc:4 (both on the floor) — npc:1 is authored, npc:3 is jury; the live cast
    # resolution filters the engine's `house` to exactly the requested ids, never the player.
    written = _run(A.backfill_unauthored(["npc:2", "npc:4"], "iris"))
    assert written == 2
    assert sorted(seen["ids"]) == ["npc:2", "npc:4"]
    assert seen["owner"] == "iris"


def test_backfill_unauthored_noops_pre_game_and_on_empty(monkeypatch):
    async def fake_run_authoring(cast, owner, on_authored=None):
        raise AssertionError("must not author pre-game / with nothing requested")
    monkeypatch.setattr(A, "run_authoring", fake_run_authoring)

    # Empty request — short-circuits before any state read.
    assert _run(A.backfill_unauthored([], "u")) == 0

    async def pre_game(user=None, **k):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", pre_game)
    assert _run(A.backfill_unauthored(["npc:2"], "u")) == 0


def test_backfill_unauthored_skips_ids_not_in_the_live_house(monkeypatch):
    _stub_state(monkeypatch)
    seen = {}

    async def fake_run_authoring(cast, owner, on_authored=None):
        seen["ids"] = [c.get("id") for c in cast]
        return len(cast)
    monkeypatch.setattr(A, "run_authoring", fake_run_authoring)

    # "player" + a stale/unknown id are filtered out; only the real floor NPC remains.
    written = _run(A.backfill_unauthored(["player", "npc:2", "npc:999"], "u"))
    assert written == 1 and seen["ids"] == ["npc:2"]


def test_backfill_unauthored_wires_the_adr0013_portrait_reshoot(monkeypatch):
    """ADR 0013 (2026-07-13): the LATE-authoring seam — each NPC authored via the backfill fires the
    per-NPC portrait (re)shoot, so a face shot from the pre-authoring floor heals the moment its
    authoring lands (and a face-less NPC gets its FIRST face from the authored prompt)."""
    _stub_state(monkeypatch)
    reshoots = []
    orwell_portraits = importlib.import_module("src.orwell_portraits")
    monkeypatch.setattr(orwell_portraits, "kickoff_authored_reshoot",
                        lambda hid, user: reshoots.append((hid, user)) or True)

    async def fake_run_authoring(cast, owner, on_authored=None):
        # the real path fires on_authored per successful write-back — simulate both landing
        for c in cast:
            if on_authored:
                on_authored(c.get("id"))
        return len(cast)
    monkeypatch.setattr(A, "run_authoring", fake_run_authoring)

    written = _run(A.backfill_unauthored(["npc:2", "npc:4"], "iris"))
    assert written == 2
    assert sorted(h for h, _u in reshoots) == ["npc:2", "npc:4"]
    assert all(u == "iris" for _h, u in reshoots)


# ── the roster route kicks the authoring backfill ──────────────────────────────────────────

def test_roster_kicks_authoring_backfill_for_floor_npcs(client, monkeypatch):
    _stub_state(monkeypatch)
    # The roster's portrait backfill must not interfere with this test.
    monkeypatch.setattr(orwell_routes.orwell_portraits, "image_generation_available", lambda u: False)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "portrait_ref", lambda u, hid: None)

    kicked = {}

    def fake_kick(missing, user):
        kicked["missing"] = list(missing)
        return True
    monkeypatch.setattr(orwell_routes.orwell_cast_authoring, "kickoff_authoring_backfill", fake_kick)

    body = client.get("/api/orwell/roster").json()
    assert len(body["roster"]) == 5  # player + 4 house
    # npc:1 authored, npc:3 jury, player excluded → npc:2 + npc:4 on the floor.
    assert kicked["missing"] == ["npc:2", "npc:4"]


def test_roster_does_not_kick_authoring_when_complete(client, monkeypatch):
    state = {
        "started": True,
        "player": {"id": "player", "name": "P", "status": "active", "authored": True},
        "house": [
            {"id": "npc:1", "name": "One", "status": "active", "authored": True},
            {"id": "npc:2", "name": "Two", "status": "active", "authored": True},
        ],
    }
    _stub_state(monkeypatch, state)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "image_generation_available", lambda u: False)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "portrait_ref", lambda u, hid: None)

    def boom(missing, user):
        raise AssertionError("authoring backfill must not kick when the cast is fully authored")
    monkeypatch.setattr(orwell_routes.orwell_cast_authoring, "kickoff_authoring_backfill", boom)

    assert client.get("/api/orwell/roster").status_code == 200


def test_roster_never_blocks_on_an_authoring_kick_failure(client, monkeypatch):
    _stub_state(monkeypatch)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "image_generation_available", lambda u: False)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "portrait_ref", lambda u, hid: None)

    def boom(missing, user):
        raise RuntimeError("kick exploded")
    monkeypatch.setattr(orwell_routes.orwell_cast_authoring, "kickoff_authoring_backfill", boom)

    r = client.get("/api/orwell/roster")
    assert r.status_code == 200  # fail-open: the roster still serves
    assert len(r.json()["roster"]) == 5


# ── POST /api/orwell/cast-authoring/backfill (the manual lever) ────────────────────────────

def test_authoring_backfill_route_returns_kicked_and_missing(client, monkeypatch):
    _stub_state(monkeypatch)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "portrait_ref", lambda u, hid: None)

    calls = {}

    def fake_kick(missing, user, force=False):
        calls["force"] = force
        return True
    monkeypatch.setattr(orwell_routes.orwell_cast_authoring, "kickoff_authoring_backfill", fake_kick)

    body = client.post("/api/orwell/cast-authoring/backfill").json()
    assert body == {"kicked": True, "missing": ["npc:2", "npc:4"]}
    # the MANUAL lever forces past the auto-poll debounce
    assert calls["force"] is True


def test_authoring_backfill_route_pre_game_and_engine_down_fail_open(client, monkeypatch):
    async def pre_game(user=None, **k):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", pre_game)
    body = client.post("/api/orwell/cast-authoring/backfill").json()
    assert body == {"kicked": False, "missing": []}

    async def down(user=None, **k):
        raise RuntimeError("engine unreachable")
    monkeypatch.setattr(orwell_engine, "get_game_state", down)
    r = client.post("/api/orwell/cast-authoring/backfill")
    assert r.status_code == 200
    assert r.json()["kicked"] is False


def test_authoring_backfill_route_is_player_reachable(client, monkeypatch):
    """NOT admin-gated: authoring reads the Vault-free public roster + writes back through
    recordCastProfile (same exposure as the roster itself)."""
    monkeypatch.setenv("AUTH_ENABLED", "true")
    _stub_state(monkeypatch)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "portrait_ref", lambda u, hid: None)
    monkeypatch.setattr(orwell_routes.orwell_cast_authoring, "kickoff_authoring_backfill",
                        lambda missing, user, force=False: True)
    assert client.post("/api/orwell/cast-authoring/backfill").status_code == 200


# ── /admin/status payload carries cast-authoring completeness ──────────────────────────────

def test_admin_health_payload_carries_cast_authoring_completeness(admin_client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")  # require_admin's documented bypass
    _stub_state(monkeypatch)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "portrait_ref", lambda u, hid: None)

    body = admin_client.get("/api/admin/health").json()
    ca = body["castAuthoring"]
    assert ca["total"] == 3 and ca["authored"] == 1 and ca["missing"] == 2
    assert sorted(ca["missingIds"]) == ["npc:2", "npc:4"]


def test_admin_health_cast_authoring_pre_game_carries_run_state(admin_client, monkeypatch):
    """2026-07-12 (owner: the debug bundle showed castAuthoring: null while casting was the exact
    window the pipeline runs in): pre-game is no longer null-blind — the payload carries a small
    Vault-free run-state block instead (pregame flag + give-ups + the house-entry hold marker)."""
    monkeypatch.setenv("AUTH_ENABLED", "false")

    async def pre_game(user=None, **k):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", pre_game)
    body = admin_client.get("/api/admin/health").json()
    ca = body["castAuthoring"]
    assert isinstance(ca, dict) and ca.get("pregame") is True
    assert isinstance(ca.get("givenUp"), list)
    assert "houseEntryHold" in ca
    # Vault-free: flags / ids / timestamps only — never cast content keys. `prewarm` is the
    # pre-warm pipeline's own run state (authorStarted/authorDone/promptCount — counts and
    # flags only), the pre-game completion signal the golden driver waits on (2026-07-17).
    assert set(ca) <= {"pregame", "givenUp", "houseEntryHold", "prewarm"}
    pw = ca.get("prewarm")
    if isinstance(pw, dict):
        assert set(pw) <= {"authorStarted", "portraitsStarted", "authorDone",
                           "promptCount", "nextSeasonArmed"}


# ── POST /api/admin/ops/reauthor-cast (the admin debug lever) ──────────────────────────────

def test_reauthor_cast_lever_is_admin_gated(admin_client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    assert admin_client.post("/api/admin/ops/reauthor-cast").status_code == 403


def test_reauthor_cast_lever_kicks_force_for_admin(admin_client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")  # require_admin's documented bypass
    _stub_state(monkeypatch)
    monkeypatch.setattr(orwell_routes.orwell_portraits, "portrait_ref", lambda u, hid: None)

    seen = {}

    def fake_kick(missing, user, force=False):
        seen["missing"] = list(missing)
        seen["force"] = force
        return True
    monkeypatch.setattr(A, "kickoff_authoring_backfill", fake_kick)

    body = admin_client.post("/api/admin/ops/reauthor-cast").json()
    assert body["reauthored"] is True
    assert body["queued"] == 2 and body["kicked"] is True
    assert seen["missing"] == ["npc:2", "npc:4"] and seen["force"] is True


def test_reauthor_cast_lever_refuses_pre_game(admin_client, monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")

    async def pre_game(user=None, **k):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", pre_game)
    body = admin_client.post("/api/admin/ops/reauthor-cast").json()
    assert body["reauthored"] is False and "no active game" in body["reason"]
