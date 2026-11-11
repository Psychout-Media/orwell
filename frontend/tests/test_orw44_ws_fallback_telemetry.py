"""ORW-44 slice 1: a permanent WS -> SSE downgrade is reported (once per page load, with its reason) as a NON-red client fail-soft event, so the transport decision has data. Source pins on orwellWs.js plus the beacon route
behaviour (accepted, logged, never red). No model."""
import re
from pathlib import Path

import pytest

SRC = (Path(__file__).resolve().parents[1] / "static" / "js" / "orwellWs.js").read_text()


def test_go_fallback_reports_once_and_not_red():
    body = SRC[SRC.index("function _goFallback(reason) {"):]
    body = body[:body.index("_rejectPending(\"ws-fallback\")")]
    assert body.index('if (_mode === "fallback") return;') < body.index("OrwellReport.fail('ws:fallback'")
    call = re.search(r"OrwellReport\.fail\('ws:fallback'.*?\);", body, re.S).group(0)
    assert "red:" not in call and "corrected: 'SSE transport'" in call


def test_the_beacon_route_accepts_the_surface_and_never_raises_red_for_it():
    pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from routes import orwell_routes
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    client = TestClient(app)
    r = client.post("/api/orwell/fe-report", json={"surface": "ws:fallback", "errorClass": "handshake", "detail": "this page load continues on the SSE transport", "corrected": "SSE transport"})
    assert r.status_code == 204
    r2 = client.post("/api/orwell/fe-report", json={"surface": "ws:fallback", "errorClass": "handshake", "detail": "x", "red": True})
    assert r2.status_code == 204  # asking for red on a non-allowlisted surface is silently ignored (A42): the test below pins that it is not allowlisted
    src = (Path(__file__).resolve().parents[1] / "routes" / "orwell_routes.py").read_text()
    allow = re.search(r"_FE_RED_SURFACES = frozenset\(\{(.*?)\}\)", src, re.S).group(1)
    assert "ws:fallback" not in allow
