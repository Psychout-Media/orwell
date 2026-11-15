"""ORW-458 - the cast card (dossier) never shows the archetype, even when the route sends it. Real app + real scripts in headless
Chromium, routes stubbed. No model. Own module so conftest routes it to the serial browser lane."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

ROSTER = [
    {"id": "player", "name": "Role Player", "status": "active", "isPlayer": True, "portrait": None},
    {"id": "npc:1", "name": "Namea Surnamea", "status": "active", "portrait": None},
]


def _j(o, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(o)}


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    rm.stop_fe(proc)


@pytest.mark.browser
def test_the_dossier_shows_strategy_but_never_the_archetype(fe):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 1200, "height": 800}).new_page()
            page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({})))
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": ROSTER, "imagesAvailable": False})))
            page.route("**/api/orwell/dossier/**", lambda r: r.fulfill(**_j({
                "found": True, "id": "npc:1", "name": "Namea Surnamea", "status": "active", "isPlayer": False, "portrait": None,
                # a (hypothetical) older server that still sends the label: the page must not render it either
                "persona": {"archetype": "The Strategist", "strategyStyle": "social", "vocation": "Nurse", "hometown": "Macon, Georgia"},
                "history": [], "deals": [], "alliances": []})))
            page.goto(fe, wait_until="domcontentloaded")
            for _ in range(60):
                if page.evaluate("!!(window.OrwellDossier && document.getElementById('chat-history'))"):
                    break
                page.wait_for_timeout(250)
            page.evaluate("window.OrwellDossier.open('npc:1')")
            page.wait_for_selector("#orwell-dossier #od-name:visible", timeout=8000)
            text = ""
            for _ in range(40):
                text = page.evaluate("document.getElementById('orwell-dossier').innerText")
                if "Nurse" in text:
                    break
                page.wait_for_timeout(150)
            assert "Nurse" in text and "Strategy" in text and "social" in text
            assert "Archetype" not in text and "The Strategist" not in text
        finally:
            browser.close()
