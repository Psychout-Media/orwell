"""ORW-270: every provider-stream failure is attributable in the server log, and the client
'technical interlude' path beacons. Roles only, no names."""
import asyncio
import importlib
import logging
import os

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

llm_core = importlib.import_module("src.llm_core")
orwell_routes = importlib.import_module("routes.orwell_routes")
BASE = os.path.dirname(os.path.dirname(__file__))

SECRET = "sk-abcdef1234567890SECRET"


def _read(*parts):
    with open(os.path.join(BASE, *parts), encoding="utf-8") as f:
        return f.read()


async def _drain(url, model, handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    llm_core._get_http_client = lambda: client  # noqa: E731
    out = []
    async for c in llm_core.stream_llm(url, model, [{"role": "user", "content": "hi"}]):
        out.append(c)
    await client.aclose()
    return out


@pytest.fixture(autouse=True)
def _restore_client():
    orig = llm_core._get_http_client
    yield
    llm_core._get_http_client = orig


def test_redactor_strips_key_and_authorization():
    t = llm_core._redact_for_log(
        f"bad\n key {SECRET} Authorization: Bearer abc.def-123 and Bearer zzz999 api_key=\"hunter2xyz\"")
    assert SECRET not in t and "abc.def-123" not in t and "zzz999" not in t and "hunter2xyz" not in t
    assert "\n" not in t
    assert len(llm_core._redact_for_log("x" * 1000)) == 300


def test_non200_logs_status_host_model_body_and_event_unchanged(caplog):
    def handler(req):
        return httpx.Response(502, text=f"upstream  boom\nkey {SECRET}")
    caplog.set_level(logging.WARNING)
    out = asyncio.run(_drain("https://prov.example.test/v1/chat/completions?x=secret", "role-model", handler))
    assert out and out[0].startswith("event: error")
    msgs = [r.getMessage() for r in caplog.records if "provider stream failed" in r.getMessage()]
    assert msgs, caplog.text
    m = msgs[0]
    assert "status=502" in m and "host=https://prov.example.test" in m and "model=role-model" in m
    assert "elapsed=" in m and "upstream boom" in m
    assert SECRET not in m and "x=secret" not in m


def test_read_timeout_and_network_error_log(caplog):
    caplog.set_level(logging.WARNING)

    def to(req):
        raise httpx.ReadTimeout("t", request=req)

    def ne(req):
        raise httpx.ReadError("n", request=req)
    out1 = asyncio.run(_drain("https://prov.example.test/v1/chat/completions", "m", to))
    out2 = asyncio.run(_drain("https://prov.example.test/v1/chat/completions", "m", ne))
    assert "Read timeout" in out1[0] and "Network error" in out2[0]
    text = caplog.text
    assert "provider stream failed: read-timeout host=https://prov.example.test model=m" in text
    assert "provider stream failed: network-error host=https://prov.example.test model=m" in text


def test_source_pin_all_three_branches_log():
    src = _read("src", "llm_core.py")
    assert src.count('_log_stream_failure("read-timeout"') == 3
    assert src.count('_log_stream_failure("network-error"') == 3
    assert src.count('_log_stream_failure(f"status={r.status_code}"') == 3
    assert "_stream_t0 = time.monotonic()" in src


def test_agent_loop_error_branch_logs():
    src = _read("src", "agent_loop.py")
    assert "[orwell] agent stream error: round=" in src
    assert "_summarize_stream_error" in src


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app, raise_server_exceptions=False)


def test_client_error_route_sanitises(client, caplog):
    caplog.set_level(logging.WARNING)
    r = client.post("/api/orwell/client-error", json={
        "kind": "stream-error", "status": 502,
        "message": f"bad\x00\x07 {SECRET} " + "y" * 500, "sessionId": "role-session"})
    assert r.status_code == 204
    rec = [x.getMessage() for x in caplog.records if "client stream error" in x.getMessage()]
    assert rec and SECRET not in rec[0] and "\x00" not in rec[0] and "status=502" in rec[0]
    assert len(rec[0]) < 500


def test_client_error_route_rate_limits_and_drops_malformed(client, caplog):
    caplog.set_level(logging.WARNING)
    assert client.post("/api/orwell/client-error", content="nope").status_code == 204
    for _ in range(45):
        assert client.post("/api/orwell/client-error", json={"kind": "stream-error", "message": "m"}).status_code == 204
    n = len([x for x in caplog.records if "client stream error" in x.getMessage()])
    assert n == 30


def test_chat_js_beacons_on_interlude_paths():
    js = _read("static", "js", "chat.js")
    assert "/api/orwell/client-error" in js
    assert js.count("_beaconStreamError(json.") == 2
    i = js.index("function _beaconStreamError")
    body = js[i:i + 1200]
    assert "orwell:gamechanged" not in body and "orwellGameChanged" not in body
    assert body.count("catch") >= 3
