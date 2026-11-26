"""ORW-733 follow-up B (Vault Wall): `/api/orwell/state` is a closed shape at EVERY nesting level, not only at the top.

The top-level allowlist (#3122) left the NESTED content of `whereabouts`, `ceremony`, `eviction`, `pending`, `player`, `premiere`, `casting` and `deals` as the engine wrote it. The route now projects onto
`_BROWSER_STATE_SHAPE` (see its comment for the screen that reads each key). Two layers here: a unit layer with a planted sentinel in every nested class (and a positive control that the raw state
carries them), an allowlist-by-construction proof (an unknown key at any dict level is dropped), and a real-stack walk of a played week where every payload the browser would get is held to the
explicit path list below. Roles only; sentinels are not names.
"""
from __future__ import annotations

import importlib
import json

import pytest

from test_m0_3_midgen_join import _stack  # noqa: F401  (the shared real-stack fixture)

orwell_routes = importlib.import_module("routes.orwell_routes")
_project = orwell_routes._browser_state_projection

S = "ZZ-sentinel-nested"

# The explicit, independently written list of paths the browser may hold (`[]` = list element). A path outside it fails, whatever the route's spec says.
ALLOWED_PATHS = {
    "started", "beatSeq", "finished", "week", "phase", "moment", "timeOfDay", "earlyMorning", "dayNumber", "unarrivedCount",
    "player.id", "player.name", "player.status", "player.evictedSeq", "player.spectator", "player.restStatus",
    "house[].id", "house[].name", "house[].status", "house[].evictedSeq", "house[].lastSeenMood",
    "asleep[].id", "asleep[].name", "awake[].id", "awake[].name",
    "deals[].id", "deals[].parties[].id", "deals[].parties[].name", "deals[].kind", "deals[].terms", "deals[].status", "deals[].term.expiresWeek", "deals[].term.vague", "deals[].packageId",
    "deals[].parts[].id", "deals[].parts[].parties[].id", "deals[].parts[].parties[].name", "deals[].parts[].kind", "deals[].parts[].terms", "deals[].parts[].status",
    "deals[].parts[].term.expiresWeek", "deals[].parts[].term.vague", "deals[].parts[].packageId",
    "premiere.met[].houseguest.id", "premiere.met[].houseguest.name", "premiere.met[].met", "premiere.remaining[].houseguest.id", "premiere.remaining[].houseguest.name", "premiere.remaining[].met",
    "premiere.complete", "premiere.metCount", "premiere.total", "premiere.champagneCircle",
    "daySchedule.headerPhase", "daySchedule.next", "daySchedule.phase", "daySchedule.due", "daySchedule.minutesUntil", "daySchedule.todaysEvent", "daySchedule.tomorrow", "daySchedule.finalHohPart",
    "watching.moments[]", "casting.missing[]",
    "castingHouse.state", "castingHouse.authored", "castingHouse.total", "castingHouse.missing", "enterHouse.available", "enterHouse.label", "enterHouse.reason",
    "ceremony.hoh.id", "ceremony.hoh.name", "ceremony.nominees[].id", "ceremony.nominees[].name", "ceremony.veto.holder.id", "ceremony.veto.holder.name", "ceremony.veto.used",
    "ceremony.veto.players[].id", "ceremony.veto.players[].name",
    "eviction.stage", "eviction.evictee.id", "eviction.evictee.name", "eviction.nominees[].id", "eviction.nominees[].name",
    "pending.kind",
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
            out.add(p + "[]*")  # an empty list: the key itself is the path (checked against its parent below)
    else:
        out.add(p)
    return out


def _outside(body):
    # a null (or an empty list) at an OBJECT/LIST key of the shape (`pending: null`, `ceremony.hoh: null`) is allowed: it carries nothing; only a leaf path outside the list fails
    parents = {a[: i] for a in ALLOWED_PATHS for i in range(len(a)) if a[i] in ".["}
    return sorted(x for x in _paths(body) if x.rstrip("*") not in ALLOWED_PATHS and x.rstrip("*").rstrip("[]") not in parents and not x.endswith("[]*"))


def _raw():
    """An engine state with a planted sentinel in every nested class the browser must not hold."""
    ref = {"id": "npc:1", "name": "Houseguest One"}
    return {
        "started": True, "beatSeq": 9, "phase": "veto-ceremony", "week": 3, "moment": "veto-ceremony", "finished": False, "timeOfDay": "evening", "dayNumber": 12, "unarrivedCount": 0,
        "whereabouts": {"room": "kitchen", "present": [{"id": "npc:2", "name": "Houseguest Two", "tell": S}], "tracked": [{"id": "npc:3", "name": "Three", "room": S, "pathway": S}],
                        "conspicuous": [S], "nearby": [{"room": "bedroom", "present": [{"id": "npc:4", "name": S}]}], "houseEvent": {"comp": {"premise": S}}},
        "ceremony": {"hoh": ref, "nominees": [ref], "veto": {"holder": ref, "used": True, "players": [ref], "decision": S, "plannedOutcome": S}, "plannedReplacement": S},
        "eviction": {"stage": "vote", "evictee": ref, "nominees": [ref], "votesRevealed": [{"votedFor": {"id": "npc:1", "name": S}, "voter": S}]},
        "pending": {"kind": "eviction-vote", "prompt": S, "options": [{"id": "npc:1", "name": S, "note": S}], "stillIn": [{"id": "npc:1", "name": S}], "by": ref, "round": 2},
        "player": {"id": "player", "name": "P", "status": "active", "restStatus": "rested", "archetype": S, "strategyStyle": S, "castingCard": {"characterType": S}},
        "house": [{"id": "npc:1", "name": "Houseguest One", "status": "active", "biography": S}],
        "deals": [{"id": "d1", "parties": [{"id": "player", "name": "P", "trust": S}], "kind": "safety", "terms": "t", "status": "open", "term": {"expiresWeek": 5, "vague": False, "magnitude": S}, "hiddenNote": S}],
        "premiere": {"met": [{"houseguest": ref, "met": True, "archetype": S}], "remaining": [], "complete": True, "metCount": 16, "total": 16, "hotReads": 15, "powerReachable": True,
                     "entrance": {"arrivedNames": [S], "playerPosition": 3}},
        "casting": {"missing": ["castPhoto"], "known": {"backstory": S}, "next": S, "ready": True, "finalizable": True},
        "daySchedule": {"next": "eviction", "phase": "evening", "due": True, "minutesUntil": 0, "plannedWinner": S},
        "watching": {"moments": ["a public line"], "digest": S},
        "asleep": [{"id": "npc:5", "name": "Five", "fatigue": S}], "awake": [{"id": "npc:6", "name": "Six", "mood": S}],
    }


def test_positive_control_the_raw_state_really_carries_every_planted_field():
    raw = json.dumps(_raw())
    assert raw.count(S) >= 20  # the sentinel is present in the raw engine state many times over


def test_no_nested_planted_field_reaches_the_browser_and_the_screen_keys_survive():
    out = _project(_raw())
    assert S not in json.dumps(out), "a planted nested field reached the browser"
    assert "whereabouts" not in out  # the presence strip reads the frozen /whereabouts route; the live read never rides /state
    assert _outside(out) == []
    # what the screens read is still there
    assert out["player"] == {"id": "player", "name": "P", "status": "active", "restStatus": "rested"}
    assert out["house"][0] == {"id": "npc:1", "name": "Houseguest One", "status": "active"}
    assert out["deals"][0]["parties"] == [{"id": "player", "name": "P"}] and out["deals"][0]["term"] == {"expiresWeek": 5, "vague": False}
    assert out["premiere"]["met"][0] == {"houseguest": {"id": "npc:1", "name": "Houseguest One"}, "met": True}
    assert out["casting"] == {"missing": ["castPhoto"]}
    assert out["pending"] == {"kind": "eviction-vote"}
    assert out["asleep"] == [{"id": "npc:5", "name": "Five"}] and out["awake"] == [{"id": "npc:6", "name": "Six"}]
    assert out["daySchedule"]["next"] == "eviction" and "plannedWinner" not in out["daySchedule"]
    assert out["ceremony"]["veto"] == {"holder": {"id": "npc:1", "name": "Houseguest One"}, "used": True, "players": [{"id": "npc:1", "name": "Houseguest One"}]}


def test_every_dict_level_of_the_shape_is_closed_by_construction():
    """An unknown key planted at EVERY object level of the shape is dropped (the nested allowlist is by construction, not by a list of known leaks)."""
    shape = orwell_routes._BROWSER_STATE_SHAPE

    def fill(spec):
        if spec is True:
            return "v"
        if isinstance(spec, dict):
            d = {k: fill(s) for k, s in spec.items()}
            d["zzUnknownKey"] = S
            return d
        return [fill(spec[0])]

    full = {k: fill(s) for k, s in shape.items()}
    full["zzUnknownTop"] = S
    out = _project(full)
    assert S not in json.dumps(out)
    assert _outside(out) == []
    assert set(_paths(out)) >= {"player.id", "ceremony.veto.holder.id", "deals[].parts[].terms", "premiere.met[].houseguest.name"}  # and the whole shape still comes through


def test_a_wrong_kind_under_a_scalar_key_is_dropped_not_forwarded():
    out = _project({"started": True, "week": {"secret": S}, "player": [S], "house": {"x": S}, "pending": {"kind": {"x": S}}})
    assert S not in json.dumps(out)


# ── the real stack: every payload the browser gets while a week is played is inside the explicit path list ──
@pytest.mark.browser
def test_real_stack_walk(_stack_walk):
    seen, raw_paths = _stack_walk
    assert seen, "the walk observed no browser payload"
    bad = sorted(set().union(*[set(_outside(b)) for b in seen]))
    assert bad == [], f"a non-screen nested key reached the browser: {bad}"
    # positive control: the engine's own read really carried fields the browser did not (the leak surface existed)
    assert any(p.startswith("whereabouts.") for p in raw_paths), "precondition: the raw engine state carries whereabouts"
    browser_keys = set().union(*[set(b) for b in seen])
    assert "whereabouts" not in browser_keys
    assert {"player", "house", "week"} <= browser_keys  # and the panels' keys did arrive


@pytest.fixture
def _stack_walk(_stack, monkeypatch):  # noqa: F811
    import urllib.request

    import _a64_walk
    from _a64_walk import NOMINEE_SEEDS, _walk_seeded_week

    seen, raw_paths = [], set()
    real = _a64_walk._schedule

    def spy(stack):
        s, st = real(stack)
        with urllib.request.urlopen(stack["fe"] + "/api/orwell/state", timeout=30) as r:
            seen.append(json.loads(r.read() or b"{}"))
        raw_paths.update(_paths(st))
        return s, st

    monkeypatch.setattr(_a64_walk, "_schedule", spy)
    _walk_seeded_week(_stack, NOMINEE_SEEDS, "block", "orw733-nested")
    return seen, raw_paths
