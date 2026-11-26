"""ORW-976 (Vault Wall, wall audit 3e): /api/orwell/retrospective hands the browser a CLOSED shape (unknown keys dropped at every level), the same technique as ORW-768/769/965. The retrospective is the post-crown unseal (the
ONE sanctioned place the hidden story is told), so its shape is exactly what the window reads: a field the engine adds later (dealPlans, socialMap, a count, a raw id inside a view) never reaches the page until a screen reads it
and it is added to the shape. Layers: planted sentinels through the real route (with a positive control), allowlist-by-construction, an independently written path list, the page's own reads checked against the shape, and the
gate (404 while the season is live) kept. Roles only."""
from __future__ import annotations

import importlib
import json
import os
import re

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
S = "ZZ-sentinel-976"
SHAPE = orwell_routes._BROWSER_RETROSPECTIVE_SHAPE
JS = os.path.join(os.path.dirname(__file__), "..", "static", "js", "orwellRetrospective.js")

N = "{id,name}"
# written independently of the shape: every path the window renders, one per line
ALLOWED = {
    "retrospective.twists[].kind", "retrospective.twists[].firedWeek",
    "retrospective.evictionVotes[].week", "retrospective.evictionVotes[].evictee.id", "retrospective.evictionVotes[].evictee.name",
    "retrospective.evictionVotes[].votes[].voter.id", "retrospective.evictionVotes[].votes[].voter.name",
    "retrospective.evictionVotes[].votes[].votedFor.id", "retrospective.evictionVotes[].votes[].votedFor.name",
    "retrospective.juryVotes.votes[].juror.id", "retrospective.juryVotes.votes[].juror.name",
    "retrospective.juryVotes.votes[].votedFor.id", "retrospective.juryVotes.votes[].votedFor.name",
    "retrospective.exitInterviews[].week", "retrospective.exitInterviews[].evictee.id", "retrospective.exitInterviews[].evictee.name",
    "retrospective.exitInterviews[].stance", "retrospective.exitInterviews[].message",
    "retrospective.finaleInterview.stance", "retrospective.finaleInterview.message",
    "retrospective.pullQuoteReel[].week", "retrospective.pullQuoteReel[].quotes[].quote", "retrospective.pullQuoteReel[].quotes[].speaker", "retrospective.pullQuoteReel[].quotes[].source",
    "retrospective.playerConfessionals[]",
    "retrospective.houseYouNeverSaw[].houseguest.id", "retrospective.houseYouNeverSaw[].houseguest.name", "retrospective.houseYouNeverSaw[].leftWeek", "retrospective.houseYouNeverSaw[].reflectionNights[]",
    "retrospective.houseYouNeverSaw[].seasonAim.aim", "retrospective.houseYouNeverSaw[].seasonAim.why[]",
    "retrospective.houseYouNeverSaw[].goals[].from", "retrospective.houseYouNeverSaw[].goals[].aim", "retrospective.houseYouNeverSaw[].goals[].ended", "retrospective.houseYouNeverSaw[].goals[].why[]",
    "retrospective.houseYouNeverSaw[].decisions[].week", "retrospective.houseYouNeverSaw[].decisions[].day", "retrospective.houseYouNeverSaw[].decisions[].act",
    "retrospective.houseYouNeverSaw[].decisions[].real", "retrospective.houseYouNeverSaw[].decisions[].said", "retrospective.houseYouNeverSaw[].decisions[].aired", "retrospective.houseYouNeverSaw[].decisions[].honesty",
    "retrospective.houseYouNeverSaw[].longCon.mark", "retrospective.houseYouNeverSaw[].longCon.from", "retrospective.houseYouNeverSaw[].longCon.plan", "retrospective.houseYouNeverSaw[].longCon.ended", "retrospective.houseYouNeverSaw[].longCon.why[]",
    "retrospective.houseYouNeverSaw[].reflections[].night", "retrospective.houseYouNeverSaw[].reflections[].text",
    "retrospective.yourEdit.episodes[].title", "retrospective.yourEdit.episodes[].authoredTitle", "retrospective.yourEdit.heroes[].line", "retrospective.yourEdit.villains[].line", "retrospective.yourEdit.you.line",
    "retrospective.reunion.threads[].line", "retrospective.yourStories.stories[].line", "retrospective.groupLife.groups[].line", "retrospective.decisionReveal.decisions[].line",
    "retrospective.houseCulture.leans[]", "retrospective.territory.crowds[]",
    "retrospective.comingClean.stories[].liar", "retrospective.comingClean.stories[].about", "retrospective.comingClean.stories[].versions[].to", "retrospective.comingClean.stories[].versions[].said",
    "retrospective.comingClean.stories[].versions[].week", "retrospective.comingClean.stories[].versions[].true", "retrospective.comingClean.stories[].versions[].confessedTo[]", "retrospective.comingClean.stories[].versions[].loopedIn[]",
    "retrospective.hiddenStory[].type", "retrospective.hiddenStory[].content",
}
for _k in ("biggest", "aboutYou"):
    for _f in ("claim", "startedWeek", "toldToYou", "starter.id", "starter.name", "passedOn[].id", "passedOn[].name", "believers[].id", "believers[].name"):
        ALLOWED.add(f"retrospective.rumorMill.{_k}[].{_f}")


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
    parents = {a[:i] for a in ALLOWED for i in range(len(a)) if a[i] in ".["}
    return sorted(x for x in _paths(body) if not (x in ALLOWED or x in parents or x.endswith("[]*") or x == ""))


def _fill(spec, tag="v"):
    if spec is True:
        return tag
    if isinstance(spec, dict):
        d = {k: _fill(s, tag) for k, s in spec.items()}
        d["zzUnknownKey"] = S
        return d
    return [_fill(spec[0], tag)]


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


def test_every_dict_level_of_the_shape_is_closed_and_equals_the_independent_path_list():
    full = {k: _fill(s) for k, s in SHAPE.items()}
    full["zzUnknownTop"] = S
    out = orwell_routes._project_for_browser(full, SHAPE)
    assert S not in json.dumps(out) and "zzUnknown" not in json.dumps(out)
    assert not _outside(out), _outside(out)
    # and the reverse: every independently listed path survives (a path dropped from the shape would blank a section of the window)
    got = _paths(out)
    missing = sorted(a for a in ALLOWED if a not in got)
    assert not missing, missing


def test_the_path_checker_catches_a_planted_key():
    assert _outside({"retrospective": {"twists": [{"kind": "k", "firedWeek": 2, "seed": 9}]}}) == ["retrospective.twists[].seed"]
    assert _outside({"retrospective": {"dealPlans": {"x": 1}}}) == ["retrospective.dealPlans.x"]


def test_the_page_reads_only_keys_the_shape_carries():
    js = open(JS, encoding="utf-8").read()
    reads = set(re.findall(r"\bunsealed\.([A-Za-z]+)", js))
    top = set(SHAPE["retrospective"])
    assert reads, "the page reads no unsealed key (the regex is stale)"
    assert reads <= top, f"the page reads {sorted(reads - top)} but the shape drops them"


def _retro_with_planted_fields():
    base = {k: _fill(s, "plain text") for k, s in SHAPE["retrospective"].items()}

    def plant(v):
        if isinstance(v, dict):
            v["zzEngineOnly"] = S
            for x in list(v.values()):
                plant(x)
        elif isinstance(v, list):
            for x in v:
                plant(x)
    plant(base)
    base.update({"dealPlans": {"secret": S}, "socialMap": {"people": [{"id": "npc:1", "name": S}]}, "americasFavorite": {"id": "npc:2", "name": S}, "winner": {"id": "npc:3", "name": S}, "weeks": 14})
    return base


def test_the_route_drops_everything_the_window_does_not_read_and_keeps_what_it_does(client, monkeypatch):
    async def done(user=None):
        return _retro_with_planted_fields()
    monkeypatch.setattr(orwell_engine, "season_retrospective", done)
    r = client.get("/api/orwell/retrospective")
    assert r.status_code == 200
    body = r.json()
    assert S not in json.dumps(body) and "zzEngineOnly" not in json.dumps(body)
    assert not _outside(body), _outside(body)
    # positive control: what the window reads is still there
    retro = body["retrospective"]
    assert retro["hiddenStory"][0]["content"] == "plain text" and retro["twists"][0]["kind"] == "plain text"
    assert retro["houseYouNeverSaw"][0]["decisions"][0]["real"] == "plain text"
    assert retro["comingClean"]["stories"][0]["versions"][0]["confessedTo"] == ["plain text"]


def test_the_gate_still_404s_while_the_season_is_live(client, monkeypatch):
    async def live(user=None):
        return None
    monkeypatch.setattr(orwell_engine, "season_retrospective", live)
    r = client.get("/api/orwell/retrospective")
    assert r.status_code == 404 and "still live" in r.json()["error"]
