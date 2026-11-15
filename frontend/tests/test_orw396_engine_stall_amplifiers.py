"""ORW-396 - a slow engine must not be amplified by the front end.

Pins: /status answers inside the poll bound (no 30 s x 3 tries); in-flight reads are keyed by timeout class (an 8 s
read never joins a 3 s call); the browser coalescer keeps one pending request instead of re-issuing after its TTL;
POST /api/orwell/fe-report works with no session cookie (it promises 204 always). Roles only, no game data.
"""
import asyncio
import importlib
import os
import shutil
import subprocess
import textwrap
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src import engine_read_cache as cache
from src import orwell_engine

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(FRONTEND, "static", "js", "orwellReadCoalesce.js")


@pytest.fixture(autouse=True)
def _cache_on(monkeypatch):
    monkeypatch.setenv("ORWELL_STATE_CACHE_TTL_MS", "400")
    cache.clear()
    yield
    cache.clear()


def test_status_route_answers_within_the_poll_bound_when_the_engine_stalls(monkeypatch):
    import httpx
    monkeypatch.setattr(orwell_engine, "_POLL_TIMEOUT", 1.0)
    seen = []

    async def stalled(path, name, args, user, timeout):
        seen.append(timeout)
        try:  # emulate httpx: the per-call timeout is what bounds a stalled engine (the engine itself sleeps 20 s)
            await asyncio.wait_for(asyncio.sleep(20), timeout if timeout is not None else 30)
        except asyncio.TimeoutError:
            raise httpx.ReadTimeout("stalled")
        return {}

    monkeypatch.setattr(orwell_engine, "_post_tool_once", stalled)
    orwell_routes = importlib.import_module("routes.orwell_routes")
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    t0 = time.monotonic()
    r = TestClient(app, raise_server_exceptions=False).get("/api/orwell/status")
    assert time.monotonic() - t0 < 9, "status must answer inside the poll bound, not hang to the 45 s middleware"
    assert r.status_code in (200, 502, 503)
    assert seen == [1.0], f"one try on the poll timeout, no 30 s x 3 retries: {seen}"


def test_inflight_reads_are_keyed_by_timeout_class():
    calls = []

    def fetcher(tag):
        async def f():
            calls.append(tag)
            await asyncio.sleep(0.05)
            return {"tag": tag}
        return f

    async def go():
        return await asyncio.gather(
            cache.read("getGameState", "u1", fetcher("short"), timeout_class=3),
            cache.read("getGameState", "u1", fetcher("long"), timeout_class=8),
            cache.read("getGameState", "u1", fetcher("long2"), timeout_class=8))
    out = asyncio.run(go())
    assert calls == ["short", "long"], "different timeout classes must not share one in-flight call"
    assert out[1] == out[2], "same class still single-flights"


def test_polled_state_passes_its_timeout_as_the_class(monkeypatch):
    seen = []

    async def fake_state(user=None, timeout=None):
        seen.append(timeout)
        return {"beatSeq": 1}
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    asyncio.run(orwell_engine.get_game_state_polled(user="u", timeout=8))
    assert seen == [8]


@pytest.mark.skipif(not shutil.which("node"), reason="node required")
def test_coalescer_keeps_the_pending_request_past_the_ttl(tmp_path):
    harness = tmp_path / "h.js"
    harness.write_text(textwrap.dedent(f"""
        let n = 0, release; const listeners = {{}};
        global.window = global;
        global.location = {{ href: "http://x/" }};
        global.addEventListener = (e, f) => {{ listeners[e] = f; }};
        global.fetch = () => {{ n++; return new Promise(r => {{ release = () => r({{ ok: true, clone() {{ return this; }} }}); }}); }};
        require({JS!r});
        (async () => {{
          const assert = require("assert");
          const a = fetch("/api/orwell/status");
          await new Promise(r => setTimeout(r, 1300));   // past the 1 s TTL, still pending
          const b = fetch("/api/orwell/status");
          assert.strictEqual(n, 1, "a pending request is joined, not re-issued");
          release(); await Promise.all([a, b]);
          console.log("ok");
        }})().catch(e => {{ console.error(e); process.exit(1); }});
    """))
    r = subprocess.run(["node", str(harness)], capture_output=True, text=True)
    assert r.returncode == 0 and "ok" in r.stdout, r.stderr


def test_fe_report_is_204_without_a_session_cookie():
    import app as app_module
    with TestClient(app_module.app) as c:
        r = c.post("/api/orwell/fe-report", json={"surface": "x", "errorClass": "e", "detail": "d"})
        assert r.status_code == 204
