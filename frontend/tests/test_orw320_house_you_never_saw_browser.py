"""ORW-320 (spec 0146 slice 7) - the retrospective window renders "the house you never saw": ONE collapsed section per houseguest, the lie marked
beside what they said, names/days only. Real app + real orwellRetrospective.js in headless Chromium; routes stubbed with the engine's documented
shape. No model. Roles only. Auto-marked ``browser`` by conftest."""
import json

import pytest

from test_orw98_retro_extras_browser import _app, _open_vault, _RETRO  # noqa: F401

_HOUSE = [
    {"houseguest": {"id": "npc:1", "name": "Role Alpha"}, "leftWeek": 2, "reflectionNights": [3], "reflections": [{"night": 3, "text": "I counted the days."}],
     "seasonAim": {"aim": "run the house", "why": ["who they are (mastermind)"]},
     "goals": [{"horizon": "week", "aim": "get Role Delta out", "from": "day 3, week 1", "why": ["they read Role Delta as a threat"], "ended": "it worked on day 9"}],
     "decisions": [{"week": 1, "day": 3, "act": "nominated Role Delta", "real": "their goal to get Role Delta out; they saw them as a threat", "said": "\"it is purely strategic, nothing personal\"", "aired": True, "honesty": "lie"},
                   {"week": 2, "day": 9, "act": "voted to evict Role Delta", "real": "a bond", "said": "\"I never knew where you stood\"", "aired": False, "honesty": "truth"}],
     "longCon": {"mark": "Role Echo", "from": "day 12, week 2", "plan": "Role Echo cut after the jury starts", "ended": "it worked on day 40", "why": ["a real bond with Role Echo"]}},
    {"houseguest": {"id": "npc:2", "name": "Role Bravo"}, "reflectionNights": [], "reflections": [], "goals": [], "decisions": []},
]


def test_one_collapsed_section_per_houseguest_with_the_lie_marked(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 390, "height": 800})
        text = _open_vault(page, _app, {**_RETRO, "houseYouNeverSaw": _HOUSE})
        assert "The house you never saw" in text
        secs = page.query_selector_all("#orwell-retro details.oretro-house")
        assert len(secs) == 2, "one section per houseguest"
        assert all(s.get_attribute("open") is None for s in secs), "collapsed by default"
        assert "out in week 2" in page.inner_text("#orwell-retro details.oretro-house >> nth=0 >> summary")
        h = page.evaluate("document.querySelector('#orwell-retro details.oretro-house summary').getBoundingClientRect().height")
        assert h >= 44, "a phone tap target"
        page.click("#orwell-retro details.oretro-house >> nth=0 >> summary")
        body = page.inner_text("#orwell-retro details.oretro-house >> nth=0")
        assert "run the house" in body and "get Role Delta out" in body and "it worked on day 9" in body
        assert "nothing personal" in body and "(a lie)" in body and page.query_selector("#orwell-retro .oretro-lie")
        assert "Secret ballot, never said aloud" in body
        assert "Their long con" in body and "Role Echo" in body
        assert "I counted the days." in body
        assert "npc:" not in page.inner_text("#orwell-retro")
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no horizontal page scroll"
        browser.close()


def test_absent_story_renders_no_section(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        text = _open_vault(page, _app, {"winner": None, "hiddenStory": [], "twists": []})
        assert "The house you never saw" not in text
        browser.close()
