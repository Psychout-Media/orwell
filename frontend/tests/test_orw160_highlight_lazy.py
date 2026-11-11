"""ORW-160: highlight.js (119 KB) must NOT load at boot; it loads once, on demand, when the first code block appears, and then colours it. Real page (F3 stack, stub LLM). Roles only."""
from __future__ import annotations

import pytest

from test_f3_drop_after_saved_no_recovery import _post_form, _stack  # noqa: F401

pytestmark = pytest.mark.browser


def test_highlight_js_loads_only_when_a_code_block_appears(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    fbase = _stack["fe"]
    sess = _post_form(fbase, "/api/session", {"name": "orw160", "model": "stub-narrator", "skip_validation": "true", "endpoint_id": _stack["endpoint_id"]}).get("id")
    assert sess
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        hits: list[str] = []
        page.on("request", lambda r: hits.append(r.url) if "highlight.min.js" in r.url else None)
        page.goto(fbase + "/", wait_until="load", timeout=30000)
        page.wait_for_function("() => !!(window.sessionModule && window.sessionModule.selectSession)", timeout=15000)
        page.wait_for_timeout(2500)
        assert hits == [], f"highlight.js must not load at boot: {hits}"
        assert page.evaluate("() => !!window.hljs") is False
        # a code block appears in the chat: it loads once and colours the block
        page.evaluate("""() => { const h = document.getElementById('chat-history') || document.body;
          const pre = document.createElement('pre'); const code = document.createElement('code'); code.className = 'language-python'; code.textContent = 'def f():\\n    return 1\\n';
          pre.appendChild(code); h.appendChild(pre); }""")
        page.wait_for_function("() => !!window.hljs", timeout=10000)
        page.wait_for_function("() => document.querySelector('pre code').classList.contains('hljs')", timeout=10000)
        assert len(hits) == 1, f"loaded exactly once: {hits}"
        browser.close()
