"""ORW-747: the retrospective leftovers on the front end.

The territory crowd words (0176 part 2) and the coming-clean record (0203) are the retrospective WINDOW's (rendered as text, kept off the host
model's context like the house culture and the rumor mill: the coming-clean record runs to ~100 KB in a measured season); the alliances in the
edit (0200) stay in the host model's `seasonRetrospective` result, because the narrator words the cut from the facts. Roles only.
"""
import asyncio
import importlib
import json
import os

orwell_engine = importlib.import_module("src.orwell_engine")
tool_implementations = importlib.import_module("src.tool_implementations")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_crowd_words_leave_the_host_context_and_the_narrator_keeps_the_rest(monkeypatch):
    async def done(user=None):
        return {
            "winner": {"id": "npc:3", "name": "Role W"},
            "territory": {"crowds": ["the kitchen crowd"]},
            "comingClean": {"stories": [{"liar": "Role A", "about": "Role B", "versions": [{"to": "Role C", "said": "x", "true": False, "week": 2, "confessedTo": ["Role C"], "loopedIn": []}]}]},
            "yourEdit": {"episodes": [{"week": 1, "moments": [], "title": "Week 1", "alliances": [{"name": "the pact", "members": ["Role A", "Role B"], "what": "formed"}]}]},
        }

    monkeypatch.setattr(orwell_engine, "season_retrospective", done)
    out = json.loads(asyncio.run(tool_implementations.do_season_retrospective(""))["output"])
    assert "territory" not in out
    assert "comingClean" not in out
    assert out["yourEdit"]["episodes"][0]["alliances"][0]["name"] == "the pact"


def test_the_window_renders_the_crowd_words_and_who_came_clean_as_text():
    js = open(os.path.join(FRONTEND, "static", "js", "orwellRetrospective.js"), encoding="utf-8").read()
    for key, title in (("unsealed.territory", "Where the house gathered"), ("unsealed.comingClean", "Who came clean")):
        i = js.index(key)
        block = js[i:i + 1400]
        assert title in block
        assert "innerHTML" not in block
