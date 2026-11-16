"""ORW-359 - a decision card keeps the player's pick when the same decision is dispatched again (a live run's eviction vote card never enabled Confirm).

The same pending reaches the card from several seams (the chat tool-output seam, the surface-the-pending belt, a socket state frame, the backstop poll), and `render()` rebuilt the card from scratch each
time: a player who had picked a houseguest saw the pick cleared and Confirm go grey under their cursor. Reproduced on a real staged game (the engine's own `eviction-vote` pending, two nominees): select a
name, Confirm enabled; dispatch the SAME pending again, nothing selected, Confirm disabled. In a REAL browser: a repeat of the same decision leaves the card (and the pick) alone; a DIFFERENT decision still
replaces it; a dispatch with no pending removes the card. (Dismissal and completion/redispatch are also exercised below.)

Run: cd frontend && .venv/bin/python -m pytest tests/test_orw359_decision_card_keeps_pick.py
"""
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

from _settle import app_ready

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


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
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            pytest.skip("uvicorn exited early")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            break
        except Exception:
            time.sleep(0.2)
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
  window.OrwellWs = undefined;
  const mk = (ids, prompt) => ({ kind: 'eviction-vote', by: { id: 'player', name: 'P' }, prompt, pick: 1, options: ids.map(i => ({ id: i, name: 'Houseguest ' + i })), ceremony: { kind: 'eviction', step: 2, of: 16, stepId: 'votes' } });
  const send = (p) => window.dispatchEvent(new CustomEvent('orwell:pending', { detail: { pending: p } }));
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const state = () => { const d = document.getElementById('orwell-decision-card'); if (!d) return null; return { confirmDisabled: d.querySelector('.odec-confirm').disabled, pressed: Array.from(d.querySelectorAll('.odec-opt')).map(o => o.getAttribute('aria-pressed')), names: Array.from(d.querySelectorAll('.odec-opt')).map(o => o.textContent.trim()) }; };
  const out = {};
  const a = mk(['npc:3', 'npc:11'], 'Cast your vote to evict one of the two nominees.');
  send(a); await wait(700);
  out.first = state();
  document.querySelectorAll('#orwell-decision-card .odec-opt')[0].click(); await wait(150);
  out.picked = state();
  const node = document.getElementById('orwell-decision-card');
  send(mk(['npc:3', 'npc:11'], 'Cast your vote to evict one of the two nominees.')); await wait(300); // the SAME decision, again
  out.afterSame = state(); out.sameNode = node === document.getElementById('orwell-decision-card');
  send(mk(['npc:4', 'npc:5'], 'Cast your vote to evict one of the two nominees.')); await wait(300); // a DIFFERENT decision
  out.afterDifferent = state();
  send(null); await wait(200); out.afterNone = state();
  // ORW-507: a FINISHED card (odec-done) is not kept by the guard: the same decision dispatched again rebuilds it, nothing picked.
  const b = mk(['npc:6', 'npc:7'], 'Cast your vote to evict one of the two nominees.');
  send(b); await wait(700);
  document.querySelectorAll('#orwell-decision-card .odec-opt')[0].click(); await wait(150);
  const doneNode = document.getElementById('orwell-decision-card');
  doneNode.classList.add('odec-done');
  send(mk(['npc:6', 'npc:7'], 'Cast your vote to evict one of the two nominees.')); await wait(400);
  out.doneRebuilt = document.getElementById('orwell-decision-card') !== doneNode; out.afterDone = state();
  send(null); await wait(200);
  // ORW-507: a DISMISSED card stays gone (the x removes it; the guard has nothing mounted to keep and must not bring it back on its own).
  send(mk(['npc:8', 'npc:9'], 'Cast your vote to evict one of the two nominees.')); await wait(700);
  document.querySelector('#orwell-decision-card .odec-x').click(); await wait(300);
  out.afterDismiss = state();
  return out;
}
"""


def test_a_repeat_of_the_same_decision_keeps_the_pick_and_a_different_one_replaces_it(_app):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch()
        except Exception as e:
            pytest.skip(f"chromium unavailable: {e}")
        try:
            page = browser.new_page()
            page.goto(_app + "/", wait_until="load", timeout=30000)
            app_ready(page)
            r = page.evaluate(_HARNESS)
        finally:
            browser.close()  # ORW-507: never leave Chromium behind on a setup/evaluate error
    assert r["first"] and r["first"]["confirmDisabled"] is True, f"Confirm is grey until a name is picked: {r}"
    assert r["picked"]["confirmDisabled"] is False and r["picked"]["pressed"] == ["true", "false"], r
    assert r["afterSame"]["pressed"] == ["true", "false"], f"the SAME decision dispatched again must leave the pick alone: {r}"
    assert r["afterSame"]["confirmDisabled"] is False, f"and Confirm stays enabled: {r}"
    assert r["sameNode"] is True, "the card is not rebuilt for a repeat of the same decision"
    assert [n.replace("HN", "", 1) for n in r["afterDifferent"]["names"]] == ["Houseguest npc:4", "Houseguest npc:5"] and r["afterDifferent"]["pressed"] == ["false", "false"], f"a different decision replaces the card, nothing picked: {r}"
    assert r["afterNone"] is None, "no pending removes the card"
    assert r["doneRebuilt"] is True and r["afterDone"]["pressed"] == ["false", "false"], f"a finished card is rebuilt, not kept: {r}"
    assert r["afterDismiss"] is None, f"a dismissed card is gone: {r}"
