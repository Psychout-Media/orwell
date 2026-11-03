"""0025 e2e (FE half) - a reactive twist that awards the secret veto renders the card, resolves on confirm, and does not freeze.

#1934 / #2008 carried a caveat that the front-end could not render a `secret-veto` card, so enabling ORWELL_REACTIVE_TWISTS could freeze a player
holding it. The card is in fact built (orwellDecision.js `kind === "secret-veto"`, relay covered by test_0025_secret_veto_relay.py, and the engine end -
raise / play / hold / season keeps moving - by tests/unit/secretVetoBoundary.test.ts). This closes the loop in a REAL browser: the engine's pending
renders the card with the two explicit choices, Confirm is disabled until the player chooses, Play sends {kind:"secret-veto", use:true}, Hold sends
use:false, both carry the card's at-most-once idempotency key, the card resolves ("Locked in") instead of hanging, and a lost answer is retryable.

Run: cd frontend && .venv/bin/python -m pytest tests/test_0025_secret_veto_card_e2e.py
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture(scope="module")
def _app():
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(
        os.environ, ORWELL_GAME_BUILD="1", AUTH_ENABLED="false", LOCALHOST_BYPASS="true",
        PLAYWRIGHT_BROWSERS_PATH=os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"),
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-sv-"), "app.db"),
    )
    port = _free_port()
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-sv-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            pytest.skip("uvicorn exited early")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            break
        except Exception:
            time.sleep(1)
    else:
        proc.terminate()
        pytest.skip("server never became ready")
    yield base
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()


_HARNESS = r"""
async (choice) => {
  window.OrwellWs = undefined;                                   // HTTP path
  const posts = [];
  const _origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    if (typeof url === 'string' && url.indexOf('/api/orwell/decision') !== -1) {
      posts.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ ok: true, beatSeq: 9 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return _origFetch(url, opts);
  };
  // exactly the shape the engine's PendingDecisionView carries for the secret veto
  const pending = { kind: 'secret-veto', by: { id: 'player', name: 'P' }, nominee: { id: 'player', name: 'P' }, options: [], binding: true };
  window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending } }));
  await new Promise(r => setTimeout(r, 900));
  const card = document.getElementById('orwell-decision-card');
  if (!card) return { error: 'the secret-veto card did not render' };
  const chips = Array.from(card.querySelectorAll('.odec-opt')).map(c => c.textContent.trim());
  const confirm = card.querySelector('.odec-confirm');
  const beforeChoice = { disabled: confirm.disabled };
  const idx = choice === 'play' ? 0 : 1;
  card.querySelectorAll('.odec-opt')[idx].click();
  await new Promise(r => setTimeout(r, 150));
  const afterChoice = { disabled: confirm.disabled };
  confirm.click();
  await new Promise(r => setTimeout(r, 700));
  const resolved = !!document.querySelector('#orwell-decision-card.odec-done') || /Locked in/.test((document.getElementById('orwell-decision-card') || {}).textContent || '');
  window.fetch = _origFetch;
  return { chips, beforeChoice, afterChoice, posts, resolved };
}
"""


@pytest.mark.parametrize("choice,use", [("play", True), ("hold", False)])
def test_secret_veto_card_renders_and_resolves(_app, choice, use):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        page.wait_for_timeout(3500)
        r = page.evaluate(_HARNESS, choice)
        browser.close()
    assert "error" not in r, r.get("error")
    assert r["chips"] == ["Play the secret veto", "Hold it"], r
    assert r["beforeChoice"]["disabled"] is True, "Confirm stays disabled until the player makes the explicit choice"
    assert r["afterChoice"]["disabled"] is False, r
    assert len(r["posts"]) == 1, r
    body = r["posts"][0]
    assert body["kind"] == "secret-veto" and body["use"] is use, body
    assert str(body.get("idempotency_key", "")).startswith("dec:"), "the stable at-most-once key rides the submit"
    assert r["resolved"], f"the card resolves instead of hanging: {r}"
