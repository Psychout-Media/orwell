"""ORW-379: with zero clocks ON, no real-world time is shown on chat bubbles (no '05:41 AM' stamp, no wall time in the
hover). The in-world moment stamp stays. Drives the REAL chatRenderer.addMessage in headless chromium."""
import os
import re
import subprocess
import sys
import time
import urllib.request

import pytest

from _settle import app_ready

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_HARNESS = r"""
async () => {
  const chat = window.chatModule; const box = document.getElementById('chat-history');
  if (!chat || !chat.addMessage || !box) return { error: 'chat module missing' };
  box.innerHTML = '';
  const when = '2026-06-27T05:41:00.000Z';
  chat.addMessage('user', 'hello there', null, { timestamp: when });
  chat.addMessage('assistant', 'The houseguests gather.', 'm', { timestamp: when, game_moment: 'Week 1 · Premiere · Night' });
  chat.addMessage('assistant', 'Casting talk.', 'm', { timestamp: when });
  const rows = Array.from(box.querySelectorAll('.role-timestamp')).map(e => ({
    text: e.textContent.trim(), title: e.title || '', shown: getComputedStyle(e).display !== 'none', moment: e.classList.contains('role-timestamp-moment') }));
  return { zero: document.body.hasAttribute('data-zero-clocks'), rows };
}
"""


from _ports import free_port as _free_port  # ORW-414: one shared free-port helper


def _boot(env, port):
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-379-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(600):  # ORW-414: poll every 0.2 s (same 120 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            raise RuntimeError("uvicorn exited early")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2); return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate(); raise RuntimeError("server never ready")


def test_no_real_wall_time_on_bubbles_with_zero_clocks():
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(os.environ); env.setdefault("AUTH_ENABLED", "false"); env.setdefault("ORWELL_GAME_BUILD", "1")
    port = _free_port(); proc = None
    try:
        proc, base = _boot(env, port)
        with sync_playwright() as pw:
            try:
                br = pw.chromium.launch()
            except Exception as e:
                pytest.skip(f"chromium unavailable: {e}")
            pg = br.new_page(); pg.goto(base + "/", wait_until="load", timeout=30000); app_ready(pg)
            res = pg.evaluate(_HARNESS); br.close()
    finally:
        if proc is not None:
            proc.terminate()
            try: proc.wait(timeout=10)
            except Exception: proc.kill()
    assert not res.get("error"), res.get("error")
    assert res["zero"], "the page must carry data-zero-clocks when the setting is on (default)"
    clock = re.compile(r"\d{1,2}:\d{2}")
    for r in res["rows"]:
        if r["shown"]:
            assert not clock.search(r["text"]), f"a visible stamp shows a real time: {r}"
        assert not clock.search(r["title"]), f"a hover shows the real time: {r}"
    assert any(r["shown"] and r["moment"] for r in res["rows"]), "the in-world moment stamp must stay visible"
