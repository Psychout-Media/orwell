"""ORW-1019 - a provider that runs out of credit (HTTP 402) is alerted ONCE, paused (no retry storm), and shown as degraded."""
import importlib
import json
from pathlib import Path

import httpx
import pytest
from conftest import _run
from fastapi import FastAPI

pc = importlib.import_module("src.orwell_provider_credit")
llm_core = importlib.import_module("src.llm_core")
log_rings = importlib.import_module("src.log_rings")
ahr = importlib.import_module("routes.admin_health_routes")
ROOT = Path(__file__).resolve().parents[2]
URL = "https://api.deepseek.com/v1/chat/completions"
BODY = '{"error":{"message":"Insufficient Balance"}}'


@pytest.fixture(autouse=True)
def _clean():
    pc.reset()
    yield
    pc.reset()


@pytest.fixture
def alerts(monkeypatch):
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **k: seen.append(cls))
    return seen


def test_first_402_alerts_once_and_repeats_are_rate_limited(alerts):
    for i in range(50):
        assert pc.note("https://api.deepseek.com/x", 402, BODY, now=100.0 + i) is True
    assert alerts == ["provider:credit-exhausted"]
    pc.note("api.deepseek.com", 402, BODY, now=100.0 + pc.ALERT_INTERVAL_S + 1)
    assert len(alerts) == 2


def test_inflight_402_and_other_statuses_are_not_credit_errors(alerts):
    assert pc.note(URL, 402, "would exceed your credits given in-flight requests") is False
    assert pc.note(URL, 500, BODY) is False and pc.note(URL, 429, BODY) is False
    assert alerts == [] and pc.snapshot()["degraded"] is False


def test_blocked_until_one_reprobe_then_clear_on_success(alerts):
    pc.note(URL, 402, BODY, now=0.0)
    assert pc.blocked(URL, now=10.0) is True
    assert pc.blocked(URL, now=pc.REPROBE_S + 1) is False  # the single probe
    assert pc.blocked(URL, now=pc.REPROBE_S + 2) is True   # everyone else still waits
    pc.clear(URL)
    assert pc.blocked(URL, now=pc.REPROBE_S + 3) is False and pc.snapshot()["degraded"] is False


class _Resp:
    def __init__(self, status, body):
        self.status_code, self._b = status, body.encode()
        self.is_success = status < 400
        self.text = body

    async def aread(self):
        return self._b

    async def aiter_lines(self):
        for line in ():
            yield line


class _Stream:
    def __init__(self, client):
        self.c = client

    async def __aenter__(self):
        self.c.calls += 1
        return _Resp(402, BODY)

    async def __aexit__(self, *a):
        return False


class _Client:
    def __init__(self):
        self.calls = 0

    def stream(self, *a, **k):
        return _Stream(self)

    async def post(self, *a, **k):
        self.calls += 1
        return _Resp(402, BODY)


def test_stream_402_makes_one_network_call_then_answers_locally(monkeypatch, alerts):
    client = _Client()
    monkeypatch.setattr(llm_core, "_get_http_client", lambda: client)

    async def one():
        return [c async for c in llm_core.stream_llm(URL, "deepseek-flash", [{"role": "user", "content": "hi"}])]
    first = _run(one())
    assert any("event: error" in c and "402" in c for c in first)
    others = [_run(one()) for _ in range(20)]
    assert client.calls == 1, "a tripped provider must not be called again"
    assert all(any('"status": 402' in c for c in o) for o in others)
    assert alerts == ["provider:credit-exhausted"]


def test_nonstream_402_is_one_call_then_local_402(monkeypatch, alerts):
    client = _Client()
    monkeypatch.setattr(llm_core, "_get_http_client", lambda: client)
    from fastapi import HTTPException
    for _ in range(5):
        with pytest.raises(HTTPException) as ei:
            _run(llm_core.llm_call_async(URL, "deepseek-flash", [{"role": "user", "content": "hi"}]))
        assert ei.value.status_code == 402
    assert client.calls == 1 and alerts == ["provider:credit-exhausted"]


def test_cast_genesis_stops_when_the_text_provider_is_out_of_credit(alerts):
    cg = importlib.import_module("src.orwell_cast_genesis")
    pc.note(URL, 402, BODY)
    calls = []

    async def llm_fn(messages):
        calls.append(1)
        return ""
    roster = [{"id": f"npc:{i}"} for i in range(1, 6)]
    out = _run(cg._gather_chunked_proposal(roster, {}, llm_fn, {r["id"] for r in roster}, None, 5))
    assert calls == [] and not out


def test_admin_alarm_and_endpoint_show_the_degraded_provider(monkeypatch, alerts):
    monkeypatch.setenv("AUTH_ENABLED", "true")
    pc.note(URL, 402, BODY)
    alarms = ahr._compute_alarms({}, credit=pc.snapshot())
    assert [a["code"] for a in alarms if a["code"] == "provider-credit"] == ["provider-credit"]
    assert ahr._compute_alarms({}, credit={"tripped": []}) == [] or all(a["code"] != "provider-credit" for a in ahr._compute_alarms({}, credit={"tripped": []}))
    app = FastAPI()
    app.include_router(ahr.setup_admin_health_routes())

    def cli(host):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(host, 5000)), base_url="http://probe")

    async def go():
        async with cli("127.0.0.1") as c:
            ok = await c.get("/api/admin/provider-credit")
        async with cli("203.0.113.9") as c:
            remote = await c.get("/api/admin/provider-credit")
        return ok, remote
    ok, remote = _run(go())
    assert ok.status_code == 200 and ok.json()["tripped"][0]["host"] == "api.deepseek.com" and ok.json()["degraded"] is True
    assert remote.status_code in (401, 403)
    assert '"/api/admin/provider-credit"' in (ROOT / "frontend" / "app.py").read_text()
    assert "provider_credit_check" in (ROOT / "deploy" / "orwell-doctor.sh").read_text()


def test_daily_spend_reads_the_ledger_rollup(monkeypatch):
    L = importlib.import_module("src.orwell_token_ledger")
    monkeypatch.setattr(L, "_load_rollup", lambda: {"u": {"daily": {"2026-11-25": {"a|m": {"cost": 1.5}, "b|m": {"cost": 0.25}}, "2026-11-26": {"a|m": {"cost": 2}}}}})
    assert pc.daily_spend() == {"2026-11-25": 1.75, "2026-11-26": 2.0}
