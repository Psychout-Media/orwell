"""ORW-27 (A87): a keyboard-only Playwright pass. Tab through the composer and the sidebar/sessions chrome (the send button is disabled while the composer is empty, so it is not a Tab stop) in a real page and assert each focus stop shows a VISIBLE focus indicator (a non-none
outline, or a box-shadow ring) when reached by keyboard. Static CSS pins live in test_837_focus_ring_keyboard_only.py; this proves the rendered result. (The decision card needs a live pending decision and is
covered by the real-loop browser tests, not by this chrome-only pass.) Reuses the F3 stack (real FE + engine, stub LLM, SSE path). Roles only."""
from __future__ import annotations

import pytest

from test_f3_drop_after_saved_no_recovery import _post_form, _stack  # noqa: F401

pytestmark = pytest.mark.browser

PROBE = """() => { const e = document.activeElement; if (!e || e === document.body) return null;
  const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && cs.outlineColor !== 'transparent' && !/rgba\\(\\s*\\d+,\\s*\\d+,\\s*\\d+,\\s*0\\s*\\)/.test(cs.outlineColor);
  const shadow = cs.boxShadow && cs.boxShadow !== 'none';
  return { tag: e.tagName.toLowerCase(), id: e.id || '', cls: (e.className && e.className.baseVal === undefined ? e.className : '').toString().slice(0, 60),
    label: (e.getAttribute('aria-label') || e.title || e.textContent || '').trim().slice(0, 40), visible: r.width > 0 && r.height > 0, ring: !!(outline || shadow), focusVisible: e.matches(':focus-visible') }; }"""


def test_keyboard_tab_stops_in_the_composer_and_sidebar_show_a_visible_ring(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    fbase = _stack["fe"]
    sess = _post_form(fbase, "/api/session", {"name": "orw27-kbd", "model": "stub-narrator", "skip_validation": "true", "endpoint_id": _stack["endpoint_id"]}).get("id")
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
        page.focus("#message")
        stops = []
        for _ in range(40):
            page.keyboard.press("Tab")
            page.wait_for_timeout(60)
            s = page.evaluate(PROBE)
            if s:
                stops.append(s)
        browser.close()
    visible = [s for s in stops if s["visible"]]
    assert len(visible) >= 5, f"the keyboard pass must reach real controls (got {len(visible)}): {stops[:5]}"
    keyboard_reached = [s for s in visible if s["focusVisible"]]
    assert len(keyboard_reached) == len(visible), "every Tab stop must match :focus-visible (keyboard-modality focus)"
    bare = sorted({f"{s['tag']}#{s['id']}" for s in keyboard_reached if not s["ring"]})
    # ORW-268: the composer used to be the one named exception (its CSS said `outline: none`); it now has a keyboard ring, so EVERY keyboard Tab stop must show one.
    assert bare == [], f"keyboard focus stops with NO visible ring: {bare}"
    ids = {x["id"] for x in visible}
    assert "message" in ids, "the pass must reach the composer"
    assert any(i.startswith("sidebar-") for i in ids), f"the pass must reach the sidebar controls: {sorted(ids)}"
