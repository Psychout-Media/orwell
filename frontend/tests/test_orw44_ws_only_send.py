"""ORW-44 slice 2 (Ryne: 'Drop it' - WebSocket only): in the game build a turn NEVER goes out as an SSE POST. With the socket working the turn rides it (the a58/F5 suites). On a network that blocks WebSockets
the send is refused cleanly: no /api/chat_stream request, the player's text is back in the composer, and a clear message says why. Real browser against the live stack. Roles only; no model."""
import pytest

from test_m0_3_midgen_join import STUB, _stack  # noqa: F401
from test_p0h_day1_clock_e2e import _session

pytestmark = pytest.mark.browser

BLOCK_WS = "window.WebSocket = function () { throw new Error('blocked by the network'); };"


def test_a_network_that_blocks_websockets_cannot_send_and_is_told_why(_stack):  # noqa: F811
    from playwright.sync_api import sync_playwright
    _session(_stack, "ws44")
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_context().new_page()
        page.add_init_script(BLOCK_WS)
        posts = []
        page.on("request", lambda r: posts.append(r.url) if "/api/chat_stream" in r.url else None)
        page.goto(_stack["fe"] + "/", wait_until="load")
        page.wait_for_timeout(2500)
        STUB.script.append({"deltas": ["this reply must never be requested"], "delay": 0})
        page.fill("#message", "hello from a blocked network")
        page.keyboard.press("Enter")
        page.wait_for_function("() => /blocks the live connection/i.test(document.body.innerText)", timeout=20000)
        assert posts == [], f"the game build must not POST /api/chat_stream: {posts}"
        assert page.input_value("#message") == "hello from a blocked network"
        assert page.evaluate("() => Array.from(document.querySelectorAll('#chat-history .msg-user')).every(e => !e.textContent.includes('hello from a blocked network'))")
        STUB.script.clear()
        browser.close()
