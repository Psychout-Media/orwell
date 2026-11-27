"""ORW-713 - the real path, no state injection: in a started season, the sidebar New Chat -> confirm ends the
season through the one restart door and opens a NEW casting in a FRESH chat; the old chat stays readable.

Real engine + real front-end + the scripted stub model (test_m0_3_midgen_join._stack)."""
import json
import os
import sys
import urllib.request

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _settle import app_ready  # noqa: E402
from test_m0_3_midgen_join import _stack  # noqa: E402,F401
from test_p0h_day1_clock_e2e import _session  # noqa: E402

pytestmark = pytest.mark.browser


def _get(stack, path):
    return json.loads(urllib.request.urlopen(stack["fe"] + path, timeout=15).read())


def test_new_chat_confirm_ends_the_season_and_opens_a_fresh_casting_chat(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    old_sid = _session(_stack, "season one chat")
    assert _get(_stack, "/api/orwell/state").get("started") is True, "the stack starts a live season"

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_context().new_page()
        page.goto(_stack["fe"] + "/", wait_until="load")
        app_ready(page, names=("chatModule", "sessionModule"))
        page.wait_for_function("() => fetch('/api/orwell/game-session').then(r => r.json()).then(j => !!j.sessionId)", timeout=30000)
        bound_before = _get(_stack, "/api/orwell/game-session").get("sessionId")
        page.evaluate("document.getElementById('sidebar-brand-btn').click()")
        dialog = page.locator("button", has_text="End season, start new")
        dialog.wait_for(timeout=20000)
        body = page.inner_text("body")
        assert "End this season and start a new one?" in body and "Leave my season" not in body
        dialog.click()
        # the season really ends: the engine is back at casting (no started game) ...
        page.wait_for_function(
            "() => fetch('/api/orwell/state').then(r => r.json()).then(s => s.started !== true)", timeout=30000)
        # ... and the player is in a NEW chat, not the old season's
        # (the fresh chat is opened by the restart seam; with no preferred model resolvable in this stack it is the
        # blank welcome chat, whose session row is created on the first send, so "not the old chat" is the claim)
        page.wait_for_function(
            "(old) => window.sessionModule.getCurrentSessionId() !== old && window._orwellRestartArmed === false",
            arg=bound_before, timeout=30000)
        new_sid = page.evaluate("window.sessionModule.getCurrentSessionId()")
        browser.close()

    assert new_sid != bound_before
    bound_after = _get(_stack, "/api/orwell/game-session").get("sessionId")
    assert bound_after != bound_before, "the canonical game chat is no longer the old season's chat (a new season gets a new chat)"
    listing = _get(_stack, "/api/sessions")
    ids = [s.get("id") for s in (listing if isinstance(listing, list) else listing.get("sessions", [])) if isinstance(s, dict)]
    assert old_sid in ids, "the old season's chat stays in the list, readable as a past season"
