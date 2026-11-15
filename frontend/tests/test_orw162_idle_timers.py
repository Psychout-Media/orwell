"""ORW-162: the page must come to rest. A real-page idle probe (F3 stack, stub LLM): after boot and a few seconds, no interval created by a loading Spinner may still be alive (the model-list loading spinner used to leak a 150 ms interval on every refresh, ~7 wakeups a second forever),
and the total timer callbacks in a 5 s idle window stay under a budget. Roles only."""
from __future__ import annotations

import pytest

from test_f3_drop_after_saved_no_recovery import _post_form, _stack  # noqa: F401

pytestmark = pytest.mark.browser

INIT = """
(() => {
  window.__t = { live: {}, ticks: 0 };
  const where = () => (new Error().stack || '').split('\\n').slice(3, 6).join(' | ');
  const oi = window.setInterval, oc = window.clearInterval;
  window.setInterval = function (fn, ms, ...a) {
    const w = where();
    const wrapped = typeof fn === 'function' ? function () { window.__t.ticks++; return fn.apply(this, arguments); } : fn;
    const id = oi.call(window, wrapped, ms, ...a); window.__t.live[id] = { ms, w }; return id;
  };
  window.clearInterval = function (id) { delete window.__t.live[id]; return oc.call(window, id); };
})();
"""


def test_no_leaked_spinner_interval_and_idle_ticks_stay_under_budget(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    fbase = _stack["fe"]
    sess = _post_form(fbase, "/api/session", {"name": "orw162", "model": "stub-narrator", "skip_validation": "true", "endpoint_id": _stack["endpoint_id"]}).get("id")
    assert sess
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.add_init_script(INIT)
        page.goto(fbase + "/", wait_until="load", timeout=30000)
        page.wait_for_function("() => !!(window.sessionModule && window.sessionModule.selectSession)", timeout=15000)
        page.wait_for_timeout(4000)
        page.evaluate("() => { window.__t.ticks = 0; }")
        page.wait_for_timeout(5000)
        r = page.evaluate("() => ({ ticks: window.__t.ticks, live: Object.values(window.__t.live) })")
        browser.close()
    leaked = [x for x in r["live"] if "Spinner.start" in x["w"]]
    assert leaked == [], f"a loading spinner interval is still alive while idle: {leaked}"
    assert r["ticks"] <= 60, f"idle interval callbacks in 5 s over budget: {r['ticks']} (live intervals: {len(r['live'])})"
