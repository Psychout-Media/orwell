"""ORW-807 (0200 your edit): the narrator's own episode titles, authored after the crown by the utility model from the edit's facts and written back to the
engine (``recordEpisodeTitles``). The window shows the authored title in place of the floor. No live model: ``llm_fn`` / ``write_fn`` are stubs. Roles only."""
import asyncio
import json
import pathlib

from src import orwell_episode_titles as et

ROOT = pathlib.Path(__file__).resolve().parents[1]


def _episodes():
    return [
        {"week": 1, "hoh": "The HOH", "evictee": "The Evictee", "moments": [{"kind": "blindside", "actor": "A Houseguest", "subject": "The Evictee"}], "title": "Week 1: A Blindside"},
        {"week": 2, "hoh": "Another", "evictee": "Someone", "close": True, "moments": [], "title": "Week 2: A Close Vote", "authoredTitle": "Already Named"},
        {"week": 3, "crown": "The Winner", "moments": [], "title": "The Crown: The Winner"},
    ]


def _run(coro):
    return asyncio.run(coro)


def test_only_untitled_episodes_are_asked_and_one_write_back_carries_the_usable_titles():
    seen, written = [], []

    async def llm(msgs):
        seen.append(msgs)
        return 'Sure! {"titles": [{"week": 1, "title": "The Knife in the Dark"}, {"week": 3, "title": "Long Live the Queen"}, {"week": 2, "title": "Not asked"}]}'

    async def write(req):
        written.append(req)
        return {"accepted": True, "recorded": len(req["titles"])}

    res = _run(et.write_titles(_episodes(), llm, write))
    assert res == {"recorded": 2, "titled": 2}
    assert written == [{"titles": [{"week": 1, "title": "The Knife in the Dark"}, {"week": 3, "title": "Long Live the Queen"}]}]
    asked = json.loads(seen[0][1]["content"].split("\n", 1)[1])
    assert [e["week"] for e in asked] == [1, 3], "an episode that already has an authored title is never asked again"


def test_the_prompt_carries_the_edit_facts_and_nothing_else():
    msgs = et.title_messages(et.untitled(_episodes()))
    facts = json.loads(msgs[1]["content"].split("\n", 1)[1])
    assert facts[0] == {"week": 1, "hoh": "The HOH", "evictee": "The Evictee", "moments": [{"kind": "blindside", "actor": "A Houseguest", "subject": "The Evictee"}], "floorTitle": "Week 1: A Blindside"}
    assert set(facts[1]) <= {"week", "crown", "floorTitle"}
    assert "never invent" in msgs[0]["content"]


def test_unusable_replies_are_dropped_and_a_second_failure_leaves_the_floor():
    assert et.parse_titles('{"titles": [{"week": 9, "title": "Unknown week"}, {"week": 1, "title": "The fall of npc:3"}, {"week": 1, "title": "' + "word " * 12 + '"}]}', {1}) == []
    assert et.parse_titles('{"titles": [{"week": 1, "title": "  \\"First\\" "}, {"week": 1, "title": "Second"}]}', {1}) == [{"week": 1, "title": "First"}]
    calls = {"n": 0}

    async def bad(msgs):
        calls["n"] += 1
        return "no json here"

    async def write(req):  # pragma: no cover - must not be called
        raise AssertionError("nothing to write")

    assert _run(et.write_titles(_episodes(), bad, write)) == {"recorded": 0, "titled": 0, "reason": "no-usable-reply"}
    assert calls["n"] == 2, "retried once"


def test_nothing_to_title_and_no_model_are_quiet_no_ops(monkeypatch):
    done = [dict(e, authoredTitle="x") for e in _episodes()]

    async def never(msgs):  # pragma: no cover
        raise AssertionError("no call")

    assert _run(et.write_titles(done, never, never))["reason"] == "nothing-to-title"

    async def no_model(owner):
        return None

    import src.orwell_cast_authoring as ca
    monkeypatch.setattr(ca, "_resolve_llm_fn", no_model)
    assert _run(et.run_titles("u", _episodes())) == {"reason": "no-model"}


def test_kickoff_is_a_no_op_before_the_crown_or_when_every_episode_is_titled():
    et.kickoff_episode_titles("u", None)
    et.kickoff_episode_titles("u", {"yourEdit": {"episodes": [dict(e, authoredTitle="x") for e in _episodes()]}})
    assert "u" not in et._IN_FLIGHT


def test_the_window_prefers_the_authored_title_and_the_route_kicks_the_writer():
    js = (ROOT / "static" / "js" / "orwellRetrospective.js").read_text()
    assert "authoredTitle" in js and "_epTitle(e)" in js
    route = (ROOT / "routes" / "orwell_routes.py").read_text()
    assert "orwell_episode_titles.kickoff_episode_titles(_current_user(request), retro)" in route
    eng = (ROOT / "src" / "orwell_engine.py").read_text()
    assert '_call("recordEpisodeTitles"' in eng
