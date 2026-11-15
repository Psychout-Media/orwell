"""ORW-383: the night-status widget lists who is AWAKE (day and night). Browser check across one night: the state mocked at
/api/orwell/state goes evening -> late night (two up) -> morning (everyone up); the widget must follow on each
`orwell:gamechanged`. This test dispatches that event by hand: it covers the widget's render from the state, NOT the
trigger that fires the event at the bed-to-morning rollover, and not the list kept during staged ceremonies."""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def _boot(env, port):
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(port)],
                            cwd=FRONTEND, env=env, stdout=open(f"/tmp/fe-383-{port}.log", "w"), stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError("uvicorn exited early")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2); return proc, base
        except Exception:
            time.sleep(1)
    proc.terminate(); raise RuntimeError("server never ready")


def _nm(*names):
    return [{"id": f"npc:{i}", "name": n} for i, n in enumerate(names)]


STATES = [
    {"started": True, "timeOfDay": "evening", "dayNumber": 1, "awake": _nm("Ada Q", "Bo R", "Cy S"), "asleep": []},
    {"started": True, "timeOfDay": "night", "dayNumber": 1, "awake": _nm("Ada Q", "Bo R"), "asleep": _nm("Cy S")},
    {"started": True, "timeOfDay": "morning", "dayNumber": 2, "awake": _nm("Ada Q", "Bo R", "Cy S"), "asleep": []},
]


def test_widget_lists_who_is_awake_and_follows_the_night():
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    env = dict(os.environ); env.setdefault("AUTH_ENABLED", "false"); env.setdefault("ORWELL_GAME_BUILD", "1")
    port = _free_port(); proc = None; seen = []
    try:
        proc, base = _boot(env, port)
        with sync_playwright() as pw:
            try:
                br = pw.chromium.launch()
            except Exception as e:
                pytest.skip(f"chromium unavailable: {e}")
            pg = br.new_page()
            cur = {"i": 0}
            pg.route("**/api/orwell/state", lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(STATES[cur["i"]])))
            pg.goto(base + "/", wait_until="load", timeout=30000); pg.wait_for_timeout(3000)
            for i in range(len(STATES)):
                cur["i"] = i
                pg.evaluate("() => window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
                pg.wait_for_timeout(1200)
                seen.append(pg.evaluate("() => (document.getElementById('orwell-night') || {}).innerText || ''"))
            br.close()
    finally:
        if proc is not None:
            proc.terminate()
            try: proc.wait(timeout=10)
            except Exception: proc.kill()
    assert "Ada" in seen[0] and "Cy" in seen[0] and "turned in" not in seen[0].lower(), seen
    assert "Cy" not in seen[1] and "Ada" in seen[1] and "Bo" in seen[1], seen          # night: only the two still up
    assert "Cy" in seen[2] and "Ada" in seen[2] and "turned in" not in seen[2].lower(), seen  # morning: everyone up again
