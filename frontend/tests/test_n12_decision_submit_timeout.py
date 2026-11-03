"""N-12 (playtest, Med) - the goodbye card stuck on "Locking in..." for 5+ minutes after submit.

The confirm handler awaited the decision POST (or the WS `decision` ack) with NO bound: a submit that never gets an answer (a hung upstream, a socket
that swallowed the frame) left the button disabled on "Locking in..." forever, with no error and no retry. Fix: bound the submit
(`_DECISION_SUBMIT_TIMEOUT_MS`, 30 s; overridable via `window.__orwellDecisionTimeoutMs` for tests), abort the fetch, and fall into the existing error
path with a distinct "taking too long" message that re-enables Confirm. Retrying is SAFE: the payload carries a stable at-most-once idempotency key
derived from the card's pending signature, so a lost-200 retry is a verbatim engine replay (CON-4).

Run: cd frontend && .venv/bin/python -m pytest tests/test_n12_decision_submit_timeout.py
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


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


def test_submit_is_bounded_in_source():
    js = _read("static/js/orwellDecision.js")
    assert "_DECISION_SUBMIT_TIMEOUT_MS" in js
    assert "AbortController" in js[js.index("confirm.addEventListener(\"click\""):], "the fetch must be abortable on timeout"
    assert "taking too long" in js, "a distinct, honest timeout message"


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
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-n12-"), "app.db"),
    )
    port = _free_port()
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-n12-{port}.log", "w"), stderr=subprocess.STDOUT)
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
async () => {
  window.__orwellDecisionTimeoutMs = 600;
  window.OrwellWs = undefined;                               // force the HTTP path
  const _origFetch = window.fetch;
  let posts = 0;
  window.fetch = (url, opts) => {
    if (typeof url === 'string' && url.indexOf('/api/orwell/decision') !== -1) {
      posts++;
      return new Promise((_res, rej) => {                    // a POST that never answers (until aborted)
        const sig = opts && opts.signal;
        if (sig) sig.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return _origFetch(url, opts);
  };
  const pending = { kind: 'goodbye-message', by: { id: 'player', name: 'P' },
                    options: [{ id: 'gracious', name: 'gracious' }, { id: 'bitter', name: 'bitter' }], binding: true };
  window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending } }));
  await new Promise(r => setTimeout(r, 800));
  const card = document.getElementById('orwell-decision-card');
  if (!card) return { error: 'no decision card rendered' };
  card.querySelector('.odec-opt').click();
  await new Promise(r => setTimeout(r, 150));
  const confirm = card.querySelector('.odec-confirm');
  confirm.click();
  const during = { label: confirm.textContent, disabled: confirm.disabled };
  await new Promise(r => setTimeout(r, 1800));              // well past the 600 ms bound
  const after = { label: confirm.textContent, disabled: confirm.disabled, err: (card.querySelector('.odec-err') || {}).textContent || '' };
  confirm.click();                                           // and it is RETRYABLE
  await new Promise(r => setTimeout(r, 150));
  window.fetch = _origFetch;
  return { during, after, posts, retried: posts >= 2 };
}
"""


def test_a_hung_submit_times_out_visibly_and_is_retryable(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        page = browser.new_page()
        page.goto(_app + "/", wait_until="load", timeout=30000)
        page.wait_for_timeout(3500)
        r = page.evaluate(_HARNESS)
        browser.close()
    assert "error" not in r, r.get("error")
    assert "Locking in" in r["during"]["label"] and r["during"]["disabled"], r
    assert r["after"]["disabled"] is False, f"Confirm must be re-enabled after the timeout: {r}"
    assert "Locking in" not in r["after"]["label"], r
    assert "taking too long" in r["after"]["err"].lower(), r
    assert r["retried"], f"the player can retry (a second POST goes out): {r}"
