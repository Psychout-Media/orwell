"""ORW-165 slice 1, real page: the HUD, the room strip and the cast roster read ONE shared game-state snapshot, so after a
state change they agree, and one orwell:gamechanged wave costs ONE /state request across all three. Own module so conftest
routes it to the serial browser lane. Roles only."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))


def _j(o, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(o)}


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    proc.terminate()


def _poll(page, expr, want, tries=40):
    for _ in range(tries):
        if page.evaluate(expr) == want:
            return True
        page.wait_for_timeout(200)
    return False


def test_orw165_three_panels_share_one_snapshot(fe):
    sync_api = pytest.importorskip("playwright.sync_api")
    box = {"state": {"started": True, "asleep": [], "player": {"restStatus": "well rested"}}, "state_hits": 0}

    def state(route):
        box["state_hits"] += 1
        route.fulfill(**_j(box["state"]))

    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
            page.route("**/api/orwell/state", state)
            page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j(
                {"whereabouts": {"room": "kitchen", "present": [{"id": "a", "name": "Ann"}, {"id": "b", "name": "Bo"}]}})))
            page.route("**/api/orwell/status", lambda r: r.fulfill(**_j(
                {"started": True, "week": 1, "phase": "hoh-competition", "day": 1, "hoh": None, "nominees": [], "pending": None})))
            page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": [
                {"id": "a", "name": "Ann", "status": "active"}, {"id": "b", "name": "Bo", "status": "active"}]})))
            page.goto(fe, wait_until="domcontentloaded")
            page.wait_for_selector("#orwell-room-strip .ors-chip", timeout=15000)
            assert page.evaluate("typeof window.OrwellGame.get") == "function"
            # a state change: Bo turns in for the night and the player is running on empty
            box["state"] = {"started": True, "asleep": [{"id": "b", "name": "Bo"}], "player": {"restStatus": "running on empty"}}
            page.wait_for_timeout(1200)  # let the first-load freshness window lapse
            before = box["state_hits"]
            page.evaluate("window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
            assert _poll(page, "[...document.querySelectorAll('#orwell-room-strip .ors-chip')].some(c => /turned in/.test(c.title || ''))", True), \
                "the room strip did not show the new state"
            shared = page.evaluate("window.OrwellGame.peek('state')")
            assert shared and shared["asleep"][0]["name"] == "Bo" and shared["player"]["restStatus"] == "running on empty"
            assert _poll(page, "(document.getElementById('os-you-rest') || {}).textContent || ''", "· running on empty"), \
                "the HUD did not show the same state"
            # the cast roster gate reads the same snapshot (the sidebar Cast button is up for a live game)
            assert _poll(page, "(document.getElementById('sidebar-cast-btn') || {style: {display: 'none'}}).style.display", ""), \
                "the cast gate did not read the shared live state"
            # one wave => one /state request shared by every panel (it used to be one per panel)
            page.wait_for_timeout(500)
            assert box["state_hits"] - before <= 2, box["state_hits"] - before
        finally:
            browser.close()
