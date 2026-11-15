"""ORW-274 - the sender's own WebSocket holder must not stay `msg msg-ai streaming` (no footer) after the turn settles.

Root cause (traced live in ~1 of 25 golden-flow runs, tests/test_orw191_golden_flows.py): over the WS transport the sender's holder is `msg msg-ai streaming`, pinned by `_wsPinRound` and
stamped with its `data-db-id` at `message_saved`. Nothing on the WS leg removes `streaming` / mounts the footer except the history reconcile. The `done` frame releases every stream lock and runs
softReloadHistory; when the id order was already "converged" (the adopt pass had the holder's id), the reconcile returned without finalizing, because only `data-kept-live` / `data-live-holder`
bubbles counted as unfinalized. The reply text was fully in the bubble but the bubble stayed `streaming` with zero footer buttons forever (and every later reconcile skipped it: `.streaming` is never
rebuilt/pruned elsewhere).

Fix (chatReconcile.js): a `.msg-ai.streaming` bubble with no footer is unfinalized too, so a settle with no live stream rebuilds it from the authoritative log.

The runtime check drives the REAL softReloadHistory over a stubbed /api/history with the exact post-`done` DOM; it fails on the pre-fix reconcile.
"""
import os

import pytest

from test_873_dedup_received import _app, _plant_dom, _assistant, _user, FRONTEND  # noqa: F401

_HARNESS = r"""
async () => {
  const chat = window.chatModule, sess = window.sessionModule, SID = 'orw274-session';
  sess.setCurrentSessionId(SID);
  const SERVER = { history: window.__serverHistory, model: 'test-model' };
  const _origFetch = window.fetch;
  window.fetch = async (url, opts) => (typeof url === 'string' && url.indexOf('/api/history/' + SID) !== -1)
    ? new Response(JSON.stringify(SERVER), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : _origFetch(url, opts);
  try { await chat.softReloadHistory(SID); } finally { window.fetch = _origFetch; }
  const ai = Array.from(document.querySelectorAll('#chat-history .msg.msg-ai'));
  return { count: ai.length, classes: ai.map(e => e.className), footers: ai.map(e => e.querySelectorAll('.msg-footer button').length) };
}
"""

_HIST = [_user(1, "u1", "hi"), _assistant(2, "a1", "Welcome to the house.")]
_PLANT = """
  box.insertAdjacentHTML('beforeend', '<div class="msg msg-user" data-db-id="u1"><div class="body">hi</div></div>');
  box.insertAdjacentHTML('beforeend', '<div class="msg msg-ai streaming" data-db-id="a1"><div class="body"><div class="stream-content">Welcome to the house.</div></div></div>');
"""


def test_source_pin_streaming_holder_counts_as_unfinalized():
    js = open(os.path.join(FRONTEND, "static/js/chatReconcile.js"), encoding="utf-8").read()
    assert ".msg.msg-ai.streaming" in js[js.index("const liveUnfinalized"):js.index("const converged =")]


def test_converged_but_unfinalized_streaming_sender_holder_is_finalized(_app):  # noqa: F811
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        page.wait_for_timeout(3500)
        page.evaluate("(h) => { window.__serverHistory = h; }", _HIST)
        _plant_dom(page, _PLANT)
        result = page.evaluate(_HARNESS)
        browser.close()
    assert result["count"] == 1, result
    assert "streaming" not in result["classes"][0], f"the settled reply is still a streaming bubble: {result}"
    assert result["footers"][0] > 0, f"the settled reply has no footer actions: {result}"
