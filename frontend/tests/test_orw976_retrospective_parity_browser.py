"""ORW-976 - browser parity: the retrospective window renders the SAME text from the raw engine view and from the closed view the route now returns. A key the shape dropped that the page reads would blank part of the
end-of-season screen, which the player sees once. Real app + real orwellRetrospective.js in headless Chromium; every view is populated (distinct text per field, the lie/secret-ballot/came-clean branches on), the raw view also
carries engine-only extras. Roles only."""
import importlib
import json

import pytest

from test_orw98_retro_extras_browser import _app, _open_vault  # noqa: F401  (the shared real-app fixture + opener)
from test_orw976_retrospective_wall import ALLOWED

pytestmark = pytest.mark.browser
routes = importlib.import_module("routes.orwell_routes")
INTS = {"week", "day", "night", "startedWeek", "leftWeek", "firedWeek", "reflectionNights"}
BOOLS = {"aired": False, "toldToYou": True, "true": False}
OVERRIDE = {"honesty": "lie", "source": "npc-confessional"}


def _build(paths):
    """The raw view, built from the independently written path list (never from the shape, or a key dropped from the shape would drop out of both sides)."""
    root = {}
    for path in sorted(paths):
        node, parts = root, path.split(".")
        for i, part in enumerate(parts):
            last = i == len(parts) - 1
            is_list = part.endswith("[]")
            key = part[:-2] if is_list else part
            if last:
                val = BOOLS.get(key, OVERRIDE.get(key, 3 if key in INTS else f"T[{path}]"))
                if is_list:
                    node.setdefault(key, []).append(val)
                else:
                    node[key] = val
            elif is_list:
                lst = node.setdefault(key, [])
                if not lst:
                    lst.append({})
                node = lst[0]
            else:
                node = node.setdefault(key, {})
    return root


def _with_extras(v):
    if isinstance(v, dict):
        v = {k: _with_extras(x) for k, x in v.items()}
        v["zzEngineOnly"] = "ZZ-extra"
        return v
    if isinstance(v, list):
        return [_with_extras(x) for x in v]
    return v


def _all_open(page):
    page.evaluate("document.querySelectorAll('#orwell-retro details').forEach(d => d.open = true)")
    return page.inner_text("#orwell-retro")


def test_the_window_renders_the_same_from_the_raw_and_the_closed_view(_app):
    from playwright.sync_api import sync_playwright
    clean = _build(ALLOWED)["retrospective"]
    raw = _with_extras(clean)
    raw.update({"dealPlans": {"x": "ZZ-extra"}, "socialMap": {"people": []}, "americasFavorite": {"id": "npc:9", "name": "ZZ-extra"}, "winner": {"id": "npc:3", "name": "ZZ-extra"}})
    closed = routes._project_for_browser({"retrospective": raw}, routes._BROWSER_RETROSPECTIVE_SHAPE)["retrospective"]
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        texts = []
        for body in (raw, closed):
            page = browser.new_page()
            _open_vault(page, _app, body)
            texts.append(_all_open(page))
            page.close()
        browser.close()
    raw_text, closed_text = texts
    for needle in ("How the votes really fell", "How the jury voted", "The exit interviews", "The Diary Room reel", "The house you never saw", "The rumor mill", "Your edit", "The reunion",
                   "You and them", "The groups of the house", "What they said, and what drove it", "The house you lived in", "Who came clean", "Where the house gathered", "Their nights", "(a lie)"):
        assert needle in raw_text, f"the fixture does not exercise {needle!r} (the parity below would be vacuous)"
    assert "ZZ-extra" not in raw_text and "ZZ-extra" not in closed_text
    assert closed_text == raw_text, "the closed view renders differently from the raw one"
