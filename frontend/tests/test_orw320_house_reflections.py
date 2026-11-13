"""ORW-320 (ORW-253 slice 7, spec docs/features/0146 "the house you never saw", amendment 2026-11-13): the post-crown nightly-reflection writer.

Utility model only; each call sees ONE houseguest's own unsealed story as of that night; a failed call is retried ONCE, then skipped with an admin
alert; no model => alert and nothing invented. Injected fakes; no live model. Roles only.
"""
import asyncio
import json

from src import orwell_house_reflections as hr

STORY_A = {
    "houseguest": {"id": "npc:1", "name": "Role A"}, "reflectionNights": [3, 20],
    "reflections": [],
    "seasonAim": {"aim": "run the house", "why": ["who they are"]},
    "goals": [{"horizon": "week", "aim": "get Role B out", "from": "day 3, week 1", "why": ["a grudge"], "ended": "it worked on day 9"},
              {"horizon": "week", "aim": "get Role C out", "from": "day 15, week 3", "why": [], "ended": "still alive when the season ended"}],
    "decisions": [{"week": 1, "day": 3, "act": "nominated Role B", "real": "their goal to get Role B out", "said": '"nothing personal"', "aired": True, "honesty": "lie"},
                  {"week": 3, "day": 15, "act": "nominated Role C", "real": "a bond", "said": '"x"', "aired": True, "honesty": "truth"}],
    "longCon": {"mark": "Role D", "from": "day 12, week 2", "plan": "x", "ended": "it worked on day 40", "why": []},
}
STORY_B = {"houseguest": {"id": "npc:2", "name": "Role B"}, "reflectionNights": [3], "reflections": [], "goals": [{"aim": "SECRET-B-ONLY", "from": "day 1, week 1", "why": [], "ended": "x"}], "decisions": []}
GOOD = json.dumps({"reflection": "I smiled at everyone today and kept my plan to myself."})


def run(coro):
    return asyncio.run(coro)


def test_story_through_holds_back_the_future():
    s = hr.story_through(STORY_A, 3)
    blob = json.dumps(s)
    assert "get Role C out" not in blob, "a goal formed after the night is unknown that night"
    assert "nominated Role C" not in blob
    assert "Role D" not in blob, "the long con had not begun"
    assert s["goals"][0]["ended"] == "still open", "an ending after the night reads as still open"
    late = hr.story_through(STORY_A, 20)
    assert late["longCon"]["ended"] == "still running", "day 40 is after night 20"


def test_each_call_sees_one_houseguest_only_and_never_the_written_reflections():
    seen = []

    async def llm(msgs):
        seen.append(json.dumps(msgs))
        return GOOD

    async def write(req):
        return {"accepted": len(req["reflections"]), "rejected": 0}

    out = run(hr.write_reflections([STORY_A, STORY_B], llm, write))
    assert out["accepted"] == 3 and out["skipped"] == 0
    assert len(seen) == 3
    assert sum("SECRET-B-ONLY" in s for s in seen) == 1, "only B's own call carries B's story"
    assert not any("SECRET-B-ONLY" in s for s in seen if "get Role B out" in s)


def test_retry_once_then_skip_and_the_good_ones_are_written():
    calls = {"n": 0}

    async def flaky(msgs):
        calls["n"] += 1
        return "no json" if calls["n"] in (1,) else GOOD

    written = []

    async def write(req):
        written.append(req)
        return {"accepted": len(req["reflections"]), "rejected": 0}

    out = run(hr.write_reflections([STORY_B], flaky, write))
    assert calls["n"] == 2 and out["accepted"] == 1 and out["skipped"] == 0, "one retry rescued it"

    calls["n"] = 0

    async def broken(msgs):
        calls["n"] += 1
        raise RuntimeError("provider down")

    out = run(hr.write_reflections([STORY_B], broken, write))
    assert calls["n"] == 2, "exactly one retry"
    assert out["skipped"] == 1 and out["accepted"] == 0
    assert len(written) == 1, "nothing written for the skipped night"


def test_parse_validates_words_and_voice():
    assert hr.parse_reflection(GOOD)
    assert hr.parse_reflection(json.dumps({"reflection": " ".join(["I"] * 61)})) is None, "over 60 words"
    assert hr.parse_reflection(json.dumps({"reflection": "They plotted all day."})) is None, "not first person"
    assert hr.parse_reflection('{"reflection": 5}') is None
    assert hr.parse_reflection("prose " + GOOD + " tail")


def test_already_written_nights_are_not_asked_again():
    s = {**STORY_A, "reflections": [{"night": 3, "text": "x"}]}
    asked = []

    async def llm(msgs):
        asked.append(msgs)
        return GOOD

    async def write(req):
        assert [r["night"] for r in req["reflections"]] == [20]
        return {"accepted": 1, "rejected": 0}

    run(hr.write_reflections([s], llm, write))
    assert len(asked) == 1
    assert not hr.pending([{**STORY_B, "reflections": [{"night": 3, "text": "x"}]}])
    assert hr.pending([STORY_B])


def test_skips_raise_an_admin_alert(monkeypatch):
    alerts = []
    monkeypatch.setattr(hr, "_alert", lambda owner, key, what: alerts.append(key))

    async def resolve(owner):
        async def bad(msgs):
            raise RuntimeError("down")
        return bad

    import src.orwell_cast_authoring as ca
    monkeypatch.setattr(ca, "_resolve_llm_fn", resolve)
    out = run(hr.run_reflections("u1", [STORY_B]))
    assert out["skipped"] == 1
    assert alerts == ["house-reflections:skipped"]


def test_no_model_alerts_once_and_invents_nothing(monkeypatch):
    alerts = []
    monkeypatch.setattr(hr, "_alert", lambda owner, key, what: alerts.append(key))

    async def resolve(owner):
        return None

    import src.orwell_cast_authoring as ca
    monkeypatch.setattr(ca, "_resolve_llm_fn", resolve)
    assert run(hr.run_reflections("u2", [STORY_B]))["reason"] == "no-model"
    assert alerts == ["house-reflections:no-model"]


def test_kickoff_is_idempotent_and_skips_when_nothing_is_missing(monkeypatch):
    runs = []

    async def fake_run(owner, stories):
        runs.append(len(stories))
        return {}

    monkeypatch.setattr(hr, "run_reflections", fake_run)
    hr._ATTEMPTED.clear(); hr._IN_FLIGHT.clear()
    retro = {"winner": {"id": "npc:9"}, "houseYouNeverSaw": [STORY_A, STORY_B]}

    async def go():
        hr.kickoff_house_reflections("u3", retro)
        hr.kickoff_house_reflections("u3", retro)   # a second open of the Vault does not start a second run
        hr.kickoff_house_reflections("u4", {"winner": {"id": "npc:9"}, "houseYouNeverSaw": [{**STORY_B, "reflections": [{"night": 3, "text": "x"}]}]})
        hr.kickoff_house_reflections("u5", None)
        await asyncio.sleep(0.05)

    run(go())
    assert runs == [2]


def test_wiring_the_route_kicks_it_and_the_model_lever_output_drops_the_story():
    routes = open("routes/orwell_routes.py", encoding="utf-8").read()
    assert "orwell_house_reflections.kickoff_house_reflections(_current_user(request), retro)" in routes
    impl = open("src/tool_implementations.py", encoding="utf-8").read()
    assert 'k != "houseYouNeverSaw"' in impl
    eng = open("src/orwell_engine.py", encoding="utf-8").read()
    assert '_call("recordNpcReflections"' in eng
