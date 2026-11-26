"""ORW-769 (Vault Wall, part 3 of ORW-768): the response the decision card's own script reads, POST /api/orwell/decision and POST /api/orwell/ceremony-continue, is a CLOSED shape: unknown keys are dropped at every
level, so a field the engine's advance/submit result gains later (a vote's tally, a ballot's voter, a planned outcome, an announcement's subjects) never reaches the page until a script reads it and it is added to the
shape. orwellDecision.js reads, off a Continue press: beatSeq, announcements[].id/kind/headline, voteBeatCue / drawBeatCue / ceremonyResultBeatCue, eviction.voteBeat.sealed, a truthy vetoDrawBeat and `pending` (the
next card); off a decision POST: beatSeq. Three layers as in ORW-768: planted sentinels through the real routes (with a positive control), allowlist-by-construction, and an independently written path list. Roles only."""
from __future__ import annotations

import importlib
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
S = "ZZ-sentinel-769"
SHAPE = orwell_routes._BROWSER_ADVANCE_SHAPE

# The paths a script (or the state a stale reconcile hands back) may hold. A path outside it fails, whatever the shape says. The /state paths are exactly the ones /api/orwell/state already serves.
ALLOWED = {
    "beatSeq", "announcements[].id", "announcements[].kind", "announcements[].headline", "voteBeatCue", "drawBeatCue", "ceremonyResultBeatCue", "decisionBeatCue",
    "eviction.voteBeat.sealed", "eviction.stage", "eviction.evictee.id", "eviction.evictee.name", "eviction.nominees[].id", "eviction.nominees[].name", "vetoDrawBeat.step",
    "pending.kind", "pending.prompt", "pending.text", "pending.pick", "pending.binding", "pending.round", "pending.options[].id", "pending.options[].name",
    "pending.stillIn[].id", "pending.stillIn[].name", "pending.appeals[]", "pending.juror.id", "pending.juror.name", "pending.finalist.id", "pending.finalist.name",
    "pending.jurorBrief[].finalist.id", "pending.jurorBrief[].finalist.name", "pending.jurorBrief[].heard[]", "pending.evictee.id", "pending.evictee.name",
    "pending.offer.from.id", "pending.offer.from.name", "pending.offer.kind", "pending.offer.terms", "pending.ceremony.kind", "pending.ceremony.step", "pending.ceremony.of",
}
STATE_PATH_ROOTS = {"started", "finished", "week", "phase", "moment", "timeOfDay", "earlyMorning", "dayNumber", "unarrivedCount", "player", "house", "asleep", "awake", "deals", "premiere",
                    "daySchedule", "watching", "casting", "castingHouse", "enterHouse", "ceremony"}


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


def _outside(body):
    bad = []
    for x in _paths(body):
        y = x[:-3] if x.endswith("[]*") else x
        root = y.split(".")[0].split("[")[0]
        if y in ALLOWED or x.endswith("[]*") or root in STATE_PATH_ROOTS or any(a.startswith(y + ".") or a.startswith(y + "[") for a in ALLOWED):
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


def _raw_advance():
    ref = _ref()
    return {
        "beatSeq": 41, "voteBeatCue": True, "drawBeatCue": True, "ceremonyResultBeatCue": True, "tally": S, "plannedOutcome": S, "ballots": [{"voter": S, "votedFor": ref}], "reason": S,
        "announcements": [{"id": "a1", "kind": "eviction-result", "week": 3, "beatSeq": 41, "headline": "Role One is evicted.", "subjects": [dict(ref, trust=S)], "detail": {"by": ref, "votes": {"evict": 9, "keep": 4}, "secret": S}}],
        "eviction": {"stage": "result", "evictee": ref, "nominees": [ref], "votesRevealed": [S], "voteBeat": {"sealed": True, "ballotSeq": 5, "voter": S}},
        "vetoDrawBeat": {"step": "field", "players": [ref], "plan": S},
        "pending": {"kind": "ceremony-step", "text": "The votes are read", "ceremony": {"kind": "eviction", "step": 2, "of": 5, "stepId": S}, "by": dict(ref, loyalty=S), "stances": [S], "plannedOutcome": S},
    }


def test_positive_control_the_raw_result_carries_every_planted_field():
    assert json.dumps(_raw_advance()).count(S) >= 10


@pytest.mark.parametrize("route", ["ceremony-continue", "decision"])
def test_the_route_drops_every_planted_field_and_keeps_what_the_card_script_reads(client, monkeypatch, route):
    async def fake_advance(**kw):
        return _raw_advance()

    async def fake_submit(decision, **kw):
        return _raw_advance()

    async def fake_tail(decision, res, user, kind, ik=None):
        return res
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "submit_decision", fake_submit)
    monkeypatch.setattr(orwell_routes, "_post_decision_tail", fake_tail)
    r = client.post("/api/orwell/ceremony-continue") if route == "ceremony-continue" else client.post("/api/orwell/decision", json={"kind": "eviction-vote", "vote": "npc:1"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert S not in json.dumps(body), f"{route}: a planted field survived"
    assert not _outside(body), _outside(body)
    for gone in ("tally", "plannedOutcome", "ballots", "reason"):
        assert gone not in body, gone
    # what the card script reads is intact
    assert body["beatSeq"] == 41 and body["voteBeatCue"] is True and body["drawBeatCue"] is True and body["ceremonyResultBeatCue"] is True
    assert body["announcements"] == [{"id": "a1", "kind": "eviction-result", "headline": "Role One is evicted."}]
    assert body["eviction"]["voteBeat"] == {"sealed": True} and "votesRevealed" not in body["eviction"]
    assert body["vetoDrawBeat"] == {"step": "field"}
    assert body["pending"]["kind"] == "ceremony-step" and body["pending"]["ceremony"] == {"kind": "eviction", "step": 2, "of": 5}
    for gone in ("by", "stances", "plannedOutcome"):
        assert gone not in body["pending"], gone


def test_a_stale_beat_reconcile_answers_with_the_closed_state_not_the_raw_read(client, monkeypatch):
    class Stale(orwell_engine.EngineToolError):
        pass

    async def fake_advance(**kw):
        raise orwell_engine.EngineToolError("stale-beat", status=409)

    async def fake_state(user=None):
        return {"beatSeq": 50, "phase": "eviction", "week": 3, "house": [dict(_ref(), trust=S)], "flavourSeed": {"note": S}, "pending": {"kind": "ceremony-step", "by": S}}

    async def fake_handle(user, e):
        return None
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    ch = importlib.import_module("routes.chat_helpers")
    monkeypatch.setattr(ch, "_is_stale_beat_error", lambda e: True)
    monkeypatch.setattr(ch, "_handle_stale_beat", fake_handle)
    r = client.post("/api/orwell/ceremony-continue")
    assert r.status_code == 200, r.text
    body = r.json()
    assert S not in json.dumps(body) and "flavourSeed" not in body
    assert body["beatSeq"] == 50 and body["house"] == [{"id": "npc:1", "name": "Role One"}] and body["pending"] == {"kind": "ceremony-step"}


# ── layer 2: allowlist by construction ─────────────────────────────────────────────────────────
def test_every_dict_level_of_the_advance_shape_is_closed():
    def fill(spec):
        if spec is True:
            return "v"
        if isinstance(spec, dict):
            if "*" in spec:
                return {"k": fill(spec["*"]), "x": {"y": S}}
            d = {k: fill(s) for k, s in spec.items()}
            d["zzUnknownKey"] = S
            return d
        return [fill(spec[0])]
    full = {k: fill(s) for k, s in SHAPE.items()}
    full["zzUnknownTop"] = S
    out = orwell_routes._project_for_browser(full, SHAPE)
    assert S not in json.dumps(out) and "zzUnknown" not in json.dumps(out)
    assert not _outside(out), _outside(out)


def test_the_path_checker_itself_catches_a_planted_key():
    assert _outside({"beatSeq": 1, "tally": 3}) == ["tally"]
    assert _outside({"pending": {"kind": "x", "by": {"id": "a"}}}) and _outside({"announcements": [{"id": "a", "subjects": [{"id": "x"}]}]})
    assert not _outside({"beatSeq": 1, "announcements": [{"id": "a", "kind": "k", "headline": "h"}], "pending": {"kind": "ceremony-step"}})


def test_a_non_dict_result_passes_through_untouched_and_content_never_does():
    assert orwell_routes._project_for_browser(None, SHAPE) is None
    assert orwell_routes._project_for_browser({"vetoDrawBeat": [S], "pending": {"kind": {"x": S}}}, SHAPE) == {"vetoDrawBeat": None, "pending": {"kind": None}}
