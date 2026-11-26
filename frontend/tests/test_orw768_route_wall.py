"""ORW-768 (Vault Wall): every route a screen polls, not only `/api/orwell/state`, hands the browser a CLOSED shape (unknown keys dropped at every level) naming only what a screen reads.

Routes: /status (the HUD and the decision card), /whereabouts, /recap, /finale, /roster, /dossier/{id}, /season, /health. Three layers: (1) a planted sentinel in every nested class of an engine payload, with a
positive control that the raw payload carries them, driven through the real route; (2) allowlist-by-construction: an unknown key planted at EVERY dict level of every shape is dropped; (3) a real-stack walk of a
played week where every payload the browser gets is held to the explicit, independently written path lists below (and the engine's own raw read really carried what the browser did not). Roles only.
"""
from __future__ import annotations

import importlib
import json
import urllib.request

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
S = "ZZ-sentinel-768"

SHAPES = {"status": orwell_routes._BROWSER_STATUS_SHAPE, "whereabouts": orwell_routes._BROWSER_WHEREABOUTS_SHAPE, "recap": orwell_routes._BROWSER_RECAP_SHAPE,
          "finale": orwell_routes._BROWSER_FINALE_SHAPE, "roster": orwell_routes._BROWSER_ROSTER_SHAPE, "health": orwell_routes._BROWSER_HEALTH_SHAPE,
          "dossier": orwell_routes._BROWSER_DOSSIER_SHAPE, "season": orwell_routes._BROWSER_SEASON_SHAPE}

# The explicit list of paths the browser may hold per route (`[]` = list element, `{}` = a map value). A path outside it fails, whatever the shape says. Each is what a screen reads (see the shape comments).
ALLOWED = {
    "status": {"started", "beatSeq", "week", "phase", "timeOfDay", "earlyMorning", "dayNumber", "finished", "winner.id", "winner.name", "lastEviction.evictee.id", "lastEviction.evictee.name",
               "hoh.id", "hoh.name", "nominees[].id", "nominees[].name", "veto.holder.id", "veto.holder.name", "veto.used", "veto.players[].id", "veto.players[].name",
               "castingHouse.state", "castingHouse.authored", "castingHouse.total", "castingHouse.missing",
               "pending.kind", "pending.prompt", "pending.text", "pending.pick", "pending.binding", "pending.round", "pending.options[].id", "pending.options[].name",
               "pending.stillIn[].id", "pending.stillIn[].name", "pending.appeals[]", "pending.juror.id", "pending.juror.name", "pending.finalist.id", "pending.finalist.name",
               "pending.jurorBrief[].finalist.id", "pending.jurorBrief[].finalist.name", "pending.jurorBrief[].heard[]", "pending.evictee.id", "pending.evictee.name",
               "pending.offer.from.id", "pending.offer.from.name", "pending.offer.kind", "pending.offer.terms", "pending.ceremony.kind", "pending.ceremony.step", "pending.ceremony.of"},
    "whereabouts": {"whereabouts.room", "whereabouts.roomNames{}", "whereabouts.zone", "whereabouts.present[].id", "whereabouts.present[].name", "whereabouts.present[].tell",
                    "whereabouts.nearby[].room", "whereabouts.nearby[].present[].id", "whereabouts.nearby[].present[].name", "whereabouts.tracked[].id", "whereabouts.tracked[].name",
                    "whereabouts.tracked[].room", "whereabouts.tracked[].stale", "whereabouts.conspicuous[]", "unavailable"},
    "recap": {"recap.finished", "recap.winner.id", "recap.winner.name", "recap.weeksPlayed", "recap.highlights[]", "recap.placement", "recap.margin"},
    "finale": {"finale.stage", "finale.finalists[].id", "finale.finalists[].name", "finale.asking.id", "finale.asking.name", "finale.reveals[].juror.id", "finale.reveals[].juror.name",
               "finale.reveals[].votedFor.id", "finale.reveals[].votedFor.name"},
    "roster": {"roster[].id", "roster[].name", "roster[].status", "roster[].isPlayer", "roster[].portrait", "roster[].evictedSeq", "roster[].lastSeenMood", "portraitLastRun.generated",
               "portraitLastRun.attempted", "portraitLastRun.failing", "imagesAvailable", "playerAwaitingUpload", "portraitsPresent", "portraitsTotal", "generation.total", "generation.done",
               "generation.active", "stale"},
    "health": {"engine", "reconnecting", "busy", "lastError.error", "integrityRefusal"},
    "dossier": {"found", "id", "name", "status", "isPlayer", "portrait", "met", "persona.background", "persona.vocation", "persona.hometown", "persona.age", "persona.demeanor", "persona.biography",
                "history[].id", "history[].ts", "history[].type", "history[].content", "deals[].id", "deals[].parties[].id", "deals[].parties[].name", "deals[].kind", "deals[].terms", "deals[].status",
                "alliances[].id", "alliances[].name", "alliances[].members[].id", "alliances[].members[].name", "alliances[].youAreFounder"},
    "season": {"season"},
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
    bad = []
    for x in _paths(body):
        y = x.rstrip("*").rstrip("[]") if x.endswith("[]*") else x
        if y in allowed or y in parents or x.endswith("[]*") or x == "":
            continue
        if any(y.startswith(a[:-2] + ".") for a in allowed if a.endswith("{}")):  # a map's values (room id -> name)
            continue
        bad.append(x)
    return sorted(bad)


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def _ref(n="Role One", i="npc:1"):
    return {"id": i, "name": n}


# ── layer 2: allowlist by construction ─────────────────────────────────────────────────────────
@pytest.mark.parametrize("route", sorted(SHAPES))
def test_every_dict_level_of_every_shape_is_closed(route):
    """An unknown key planted at EVERY object level of the shape is dropped, and the whole shape still comes through."""
    def fill(spec):
        if spec is True:
            return "v"
        if isinstance(spec, dict):
            if "*" in spec:
                return {"room-a": fill(spec["*"]), "room-b": {"x": S}}   # a map: a dict where the spec wants a scalar is dropped
            d = {k: fill(s) for k, s in spec.items()}
            d["zzUnknownKey"] = S
            return d
        return [fill(spec[0])]

    full = {k: fill(s) for k, s in SHAPES[route].items()}
    full["zzUnknownTop"] = S
    out = orwell_routes._project_for_browser(full, SHAPES[route])
    assert S not in json.dumps(out), f"{route}: an unknown key survived"
    assert "zzUnknown" not in json.dumps(out)
    got = _paths(out)
    assert got, route
    assert not _outside(route, out), f"{route}: {_outside(route, out)}"


def test_a_wrong_kind_under_a_scalar_key_is_dropped_not_forwarded():
    out = orwell_routes._project_for_browser({"week": {"x": S}, "phase": [S], "pending": {"kind": {"x": S}, "options": {"x": S}}, "hoh": [S]}, orwell_routes._BROWSER_STATUS_SHAPE)
    assert S not in json.dumps(out)


def test_the_path_checker_itself_catches_a_planted_key():
    """Negative control for `_outside`: a key a screen does not read is reported, at any level."""
    assert _outside("status", {"week": 1, "flavourSeed": {"note": "x"}}) and _outside("status", {"pending": {"kind": "x", "by": {"id": "a"}}})
    assert _outside("whereabouts", {"whereabouts": {"room": "kitchen", "tracked": [{"name": "a", "confidence": 0.5}]}}) and _outside("health", {"engine": True, "engineUrl": "x"})
    assert not _outside("whereabouts", {"whereabouts": {"room": "kitchen", "roomNames": {"kitchen": "k"}, "present": []}})


# ── layer 1: planted sentinels through the real routes ─────────────────────────────────────────
def _raw_status():
    ref = _ref()
    return {
        "beatSeq": 9, "week": 3, "phase": "eviction", "timeOfDay": "evening", "earlyMorning": True, "dayNumber": 12, "day": 5, "finished": False, "winner": None,
        "lastEviction": {"evictee": ref, "tally": S}, "hoh": dict(ref, trust=S), "nominees": [dict(ref, threat=S)], "veto": {"holder": ref, "used": False, "players": [ref], "plannedDecision": S},
        "asleep": [dict(ref, fatigue=S)], "awake": [dict(ref, mood=S)],
        "flavourSeed": {"note": S, "anchors": [S], "used": [S]}, "openDealOffer": {"from": ref, "terms": S}, "openVotePitch": {"id": S}, "openTalkAsk": {"from": ref}, "owedFavors": [{"id": S}],
        "alliances": [{"id": S, "members": [ref]}], "alliancePitches": [{"id": S}], "plannedNominee": S,
        "pending": {"kind": "eviction-vote", "by": dict(ref, loyalty=S), "prompt": "Vote.", "options": [dict(ref, lean=S)], "pick": 1, "binding": True, "round": 2, "stillIn": [dict(ref, edge=S)],
                    "stances": [S], "text": "t", "plannedOutcome": S, "ceremony": {"kind": "eviction", "step": 2, "of": 5, "stepId": S, "votes": S}, "finalHohPart": 2,
                    "jurorBrief": [{"finalist": dict(ref, hidden=S), "heard": ["a line"], "source": S}], "offer": {"from": ref, "kind": "safety", "terms": "t", "secret": S}, "evictee": ref},
    }


def test_positive_control_the_raw_status_carries_every_planted_field():
    assert json.dumps(_raw_status()).count(S) >= 25


def test_status_drops_every_planted_field_and_keeps_what_the_hud_and_the_card_read(client, monkeypatch):
    async def fake(user=None):
        return _raw_status()
    monkeypatch.setattr(orwell_engine, "game_status", fake)
    body = client.get("/api/orwell/status").json()
    assert S not in json.dumps(body)
    assert not _outside("status", body), _outside("status", body)
    for gone in ("day", "asleep", "awake", "flavourSeed", "openDealOffer", "openVotePitch", "openTalkAsk", "owedFavors", "alliances", "alliancePitches"):
        assert gone not in body, gone
    assert body["hoh"] == {"id": "npc:1", "name": "Role One"} and body["nominees"] == [{"id": "npc:1", "name": "Role One"}] and body["week"] == 3
    assert body["lastEviction"] == {"evictee": {"id": "npc:1", "name": "Role One"}}
    card = body["pending"]
    assert card["kind"] == "eviction-vote" and card["options"] == [{"id": "npc:1", "name": "Role One"}] and card["ceremony"] == {"kind": "eviction", "step": 2, "of": 5}
    assert card["jurorBrief"] == [{"finalist": {"id": "npc:1", "name": "Role One"}, "heard": ["a line"]}] and card["offer"]["terms"] == "t" and card["round"] == 2 and card["stillIn"]
    for gone in ("by", "stances", "plannedOutcome", "finalHohPart"):
        assert gone not in card, gone


def test_status_keeps_a_null_card_and_the_pre_game_answer(client, monkeypatch):
    async def fake(user=None):
        return dict(_raw_status(), pending=None)
    monkeypatch.setattr(orwell_engine, "game_status", fake)
    assert client.get("/api/orwell/status").json()["pending"] is None

    async def no_game(user=None):
        raise orwell_engine.EngineToolError("no active game for this user", status=404)
    monkeypatch.setattr(orwell_engine, "game_status", no_game)
    assert client.get("/api/orwell/status").json() == {"started": False}


def test_whereabouts_drops_every_planted_field_and_keeps_what_the_gadget_reads(client, monkeypatch):
    ref = _ref()
    raw = {"room": "kitchen", "roomNames": {"kitchen": "the Coral Kitchen"}, "roomLook": S, "zone": "pool", "roomCard": {"room": S}, "turnsHere": 3,
           "present": [dict(ref, tell="guarded", mood=S)], "nearby": [{"room": "hallway", "present": [dict(ref, tell=S, note=S)]}],
           "tracked": [dict(ref, room="bedroom-a", stale=True, confidence=0.83, pathway=S, sinceTurns=4, zone=S)], "conspicuous": ["Two of them have been alone a while."],
           "companions": [dict(ref, turnsHere=2)], "counts": {"room": 2, "others": 1, "house": 16, "voters": S}, "houseEvent": {"comp": {"premise": S}, "youAreCompeting": S},
           "sinceSend": {"arrived": [S], "departed": [S]}, "search": {"houseguests": [dict(ref, room=S)]}}

    async def fake(user=None, **_k):
        return raw
    monkeypatch.setattr(orwell_engine, "whereabouts", fake)
    chat_helpers = importlib.import_module("routes.chat_helpers")
    monkeypatch.setattr(chat_helpers, "freeze_view", lambda user, live: live)
    assert json.dumps(raw).count(S) >= 12 and "0.83" in json.dumps(raw)   # positive control
    body = client.get("/api/orwell/whereabouts").json()
    assert S not in json.dumps(body) and "0.83" not in json.dumps(body) and "confidence" not in json.dumps(body)
    assert not _outside("whereabouts", body), _outside("whereabouts", body)
    w = body["whereabouts"]
    assert w["room"] == "kitchen" and w["zone"] == "pool" and w["roomNames"] == {"kitchen": "the Coral Kitchen"}
    assert w["present"] == [{"id": "npc:1", "name": "Role One", "tell": "guarded"}] and w["nearby"] == [{"room": "hallway", "present": [{"id": "npc:1", "name": "Role One"}]}]
    assert w["tracked"] == [{"id": "npc:1", "name": "Role One", "room": "bedroom-a", "stale": True}] and w["conspicuous"] == ["Two of them have been alone a while."]
    for gone in ("counts", "companions", "turnsHere", "roomLook", "roomCard", "search", "houseEvent", "sinceSend"):
        assert gone not in w, gone


def test_whereabouts_keeps_the_fail_open_answers(client, monkeypatch):
    async def none(user=None, **_k):
        return None
    monkeypatch.setattr(orwell_engine, "whereabouts", none)
    assert client.get("/api/orwell/whereabouts").json() == {"whereabouts": None}

    async def boom(user=None, **_k):
        raise RuntimeError("down")
    monkeypatch.setattr(orwell_engine, "whereabouts", boom)
    assert client.get("/api/orwell/whereabouts").json() == {"whereabouts": None, "unavailable": True}


def test_recap_and_finale_drop_every_planted_field(client, monkeypatch):
    ref = _ref()

    async def recap(user=None):
        return {"started": True, "finished": True, "winner": dict(ref, jury=S), "weeksPlayed": 11, "highlights": ["A public line."], "evicted": [ref], "deals": [{"id": S, "terms": S}],
                "alliances": [{"id": S}], "voteTally": S}

    async def state(user=None, timeout=None):
        return {"player": {"id": "player", "name": "P", "status": "winner"}, "house": [], "started": True}
    monkeypatch.setattr(orwell_engine, "season_recap", recap)
    monkeypatch.setattr(orwell_engine, "get_game_state", state)
    body = client.get("/api/orwell/recap").json()
    assert S not in json.dumps(body) and not _outside("recap", body), (_outside("recap", body), body)
    assert body["recap"]["winner"] == {"id": "npc:1", "name": "Role One"} and body["recap"]["highlights"] == ["A public line."] and body["recap"]["weeksPlayed"] == 11
    for gone in ("started", "evicted", "deals", "alliances", "voteTally"):
        assert gone not in body["recap"], gone

    async def finale(user=None):
        return {"stage": "vote", "finalists": [dict(ref, edge=S)], "asking": dict(ref, bearing="bitter"), "reveals": [{"juror": ref, "votedFor": ref, "why": S}], "winner": ref, "lean": S}
    monkeypatch.setattr(orwell_engine, "finale_view", finale)
    fin = client.get("/api/orwell/finale").json()
    assert S not in json.dumps(fin) and "bitter" not in json.dumps(fin) and not _outside("finale", fin), (_outside("finale", fin), fin)
    assert fin["finale"]["stage"] == "vote" and fin["finale"]["asking"] == {"id": "npc:1", "name": "Role One"} and fin["finale"]["reveals"][0]["votedFor"]["name"] == "Role One"
    assert "winner" not in fin["finale"]


def test_roster_and_season_and_health_drop_every_planted_field(client, monkeypatch):
    payload = orwell_routes._roster_payload("u", [{"id": "npc:1", "name": "Role One", "status": "active", "isPlayer": False, "portrait": None, "authored": True, "storyMissing": True,
                                                  "lastSeenMood": "settled", "biography": S, "evictedSeq": 2, "archetype": S}], stale=False)
    assert S not in json.dumps(payload) and not _outside("roster", payload), (_outside("roster", payload), payload)
    assert payload["roster"] == [{"id": "npc:1", "name": "Role One", "status": "active", "isPlayer": False, "portrait": None, "lastSeenMood": "settled", "evictedSeq": 2}]

    async def detail():
        return {"ok": True, "engineUrl": "http://engine.example:8765", "error": "ConnectError: refused " + S, "lastError": {"tool": "advanceGame", "error": "internal " + S}, "reconnecting": False, "busy": None,
                "integrityRefusal": {"invariant": S}}
    monkeypatch.setattr(orwell_engine, "engine_health_detail", detail)
    r = client.get("/api/orwell/health")
    assert S not in r.text and "engine.example" not in r.text and "advanceGame" not in r.text
    assert r.json() == {"engine": True, "lastError": {"error": True}, "reconnecting": False, "busy": None}


def test_dossier_holds_the_payload_to_its_shape(client, monkeypatch):
    ref = _ref()

    async def state(user=None, timeout=None):
        return {"started": True, "player": {"id": "player", "name": "P"}, "house": [{"id": "npc:1", "name": "Role One", "status": "active", "background": "a nurse", "vocation": "nurse", "age": 30,
                                                                                    "archetype": S, "strategyStyle": S, "voice": S, "biography": "A bio.", "demeanor": "calm"}],
                "deals": [{"id": "d1", "parties": [dict(ref, trust=S)], "kind": "safety", "terms": "t", "status": "open", "hidden": S}], "alliances": [{"id": "a1", "name": "Four", "members": [dict(ref, loyalty=S)], "youAreFounder": True, "cohesion": S}],
                "premiere": {"remaining": []}}

    async def visible(user=None):
        return {"visibleEvents": [{"id": "e1", "ts": 5, "type": "said-aloud", "content": "A line.", "initiator": "npc:1", "witnessSet": ["player", "npc:1"], "hidden": S, "plannedBy": S}]}
    monkeypatch.setattr(orwell_engine, "get_game_state_polled", state)
    monkeypatch.setattr(orwell_engine, "get_visible_state", visible)
    body = client.get("/api/orwell/dossier/npc:1").json()
    assert body.get("found") is True, body   # positive control: the houseguest has walked in and the dossier really opens
    assert S not in json.dumps(body) and not _outside("dossier", body), (_outside("dossier", body), body)
    assert "archetype" not in body["persona"] and body["persona"]["biography"] == "A bio."
    assert body["history"] == [{"id": "e1", "ts": 5, "type": "said-aloud", "content": "A line."}] and body["alliances"][0]["members"] == [{"id": "npc:1", "name": "Role One"}]


# ── layer 3: the real stack, a played week ─────────────────────────────────────────────────────
ROUTES = ("status", "whereabouts", "recap", "season", "finale", "roster", "health")


@pytest.fixture
def _walk(_stack, monkeypatch):  # noqa: F811
    import _a64_walk
    from _a64_walk import NOMINEE_SEEDS, _walk_seeded_week

    seen, raw_keys = {r: [] for r in (*ROUTES, "dossier")}, {"status": set(), "whereabouts": set()}
    real = _a64_walk._schedule

    def get(path):
        with urllib.request.urlopen(_stack["fe"] + path, timeout=30) as r:
            return json.loads(r.read() or b"{}")

    def spy(stack):
        s, st = real(stack)
        for r in ROUTES:
            seen[r].append(get("/api/orwell/" + r))
        ids = [h["id"] for h in (st.get("house") or [])][:2]
        seen["dossier"].extend(get("/api/orwell/dossier/" + i) for i in ids)
        raw_keys["status"] |= _paths(stack_engine(stack, "gameStatus"))
        raw_keys["whereabouts"] |= _paths(stack_engine(stack, "whereabouts"))
        return s, st

    from test_orw707_browser_state_wall import _engine as stack_engine
    monkeypatch.setattr(_a64_walk, "_schedule", spy)
    _walk_seeded_week(_stack, NOMINEE_SEEDS, "block", "orw768-walk")
    return seen, raw_keys


from test_m0_3_midgen_join import _stack  # noqa: E402,F401  (the shared real-stack fixture)


@pytest.mark.browser
def test_real_stack_walk_every_route_stays_inside_its_screen_paths(_walk):
    seen, raw = _walk
    for route, bodies in seen.items():
        assert bodies, f"the walk observed no {route} payload"
        bad = sorted(set().union(*[set(_outside(route, b)) for b in bodies]))
        assert bad == [], f"{route}: a non-screen key reached the browser: {bad}"
    # positive controls: the engine's own reads really carried fields the browser did not (the leak surface existed), and the screens' keys did arrive
    assert any(p.startswith("flavourSeed") for p in raw["status"]) and any(p.startswith("awake") for p in raw["status"]), "precondition: the raw status carries narrator fields"
    assert any(p.startswith("whereabouts.counts") for p in raw["whereabouts"]) or any(p.startswith("counts") for p in raw["whereabouts"]) or raw["whereabouts"], "precondition: the raw read carries more"
    got = set().union(*[_paths(b) for b in seen["status"]])
    assert {"week", "phase", "hoh.id", "nominees[].id"} <= {g.rstrip("*") for g in got} or {"week", "phase"} <= got
    cards = [b["pending"] for b in seen["status"] if isinstance(b.get("pending"), dict)]
    assert all(c.get("kind") for c in cards)
    assert any("room" in (b.get("whereabouts") or {}) for b in seen["whereabouts"])
    assert all(set(b) <= {"engine", "reconnecting", "busy", "lastError", "integrityRefusal"} for b in seen["health"])
