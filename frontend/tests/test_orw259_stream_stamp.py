"""ORW-259: a streaming reply that never settles (interrupted / stopped / dropped) must not show the real wall clock ("11:06 PM") in its header. While a game is on screen the live holder is created with the most recent in-world moment (M2-6); with no game bubble yet it keeps the neutral wall-clock stamp (casting, chat mode), exactly as before. Real page (F3 stack, stub LLM), the chat request is held open so the reply never settles. Roles only."""
from __future__ import annotations

import re

import pytest

from test_f3_drop_after_saved_no_recovery import _post_form, _send_first_message, _stack  # noqa: F401

pytestmark = pytest.mark.browser

MOMENT = "Week 2 · Veto competition · Evening"
WALL = re.compile(r"^\d{1,2}:\d{2}\s?(AM|PM)?$", re.I)


def _holder_stamp(page):
    return page.evaluate("""() => { const hs = [...document.querySelectorAll('#chat-history .msg-ai')]; const h = hs[hs.length - 1]; if (!h) return null;
      const s = h.querySelector('.role-timestamp'); return s ? {text: s.textContent.trim(), moment: s.classList.contains('role-timestamp-moment')} : null; }""")


def _run(_stack, seed_moment):  # noqa: F811
    from playwright.sync_api import sync_playwright
    fbase = _stack["fe"]
    sess = _post_form(fbase, "/api/session", {"name": "orw259", "model": "stub-narrator", "skip_validation": "true", "endpoint_id": _stack["endpoint_id"]}).get("id")
    assert sess
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.goto(fbase + "/", wait_until="load", timeout=30000)
        page.wait_for_function("() => !!(window.sessionModule && window.sessionModule.selectSession)", timeout=15000)
        page.wait_for_timeout(2500)
        if seed_moment:
            page.evaluate("""(m) => { const h = document.getElementById('chat-history'); const d = document.createElement('div'); d.className = 'msg msg-ai';
              d.innerHTML = '<div class="role">Production <span class="role-timestamp role-timestamp-moment">' + m + '</span></div><div class="body">earlier beat</div>'; h.appendChild(d); }""", seed_moment)
        # hold every chat request open: the reply is created but never settles
        page.route(re.compile(r".*/api/(chat|agent)[^?]*$"), lambda route: None)
        _send_first_message(page, "hello there")
        page.wait_for_function("() => document.querySelectorAll('#chat-history .msg-ai').length >= %d" % (2 if seed_moment else 1), timeout=15000)
        page.wait_for_timeout(600)
        stamp = _holder_stamp(page)
        browser.close()
    return stamp


def test_unsettled_reply_in_a_game_keeps_the_in_world_moment_not_the_wall_clock(_stack):  # noqa: F811
    stamp = _run(_stack, MOMENT)
    assert stamp is not None, "the streaming holder must exist"
    assert stamp["text"] == MOMENT and stamp["moment"] is True, f"expected the in-world moment, got {stamp}"


def test_with_no_game_bubble_the_neutral_wall_clock_stamp_is_unchanged(_stack):  # noqa: F811
    stamp = _run(_stack, None)
    assert stamp is not None
    assert WALL.match(stamp["text"]) and stamp["moment"] is False, f"expected the neutral wall clock, got {stamp}"
