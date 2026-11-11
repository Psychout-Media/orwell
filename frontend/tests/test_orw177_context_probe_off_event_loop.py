"""ORW-177 slice 2: the context-length probes on `GET /session/{id}/context_info` and `POST /api/session/{id}/compact`
run OFF the event loop. A stub get_context_length blocks 0.5 s; a ticker on the SAME loop must keep ticking. No model."""
import asyncio
import time
from pathlib import Path

import httpx
from fastapi import FastAPI

import src.model_context as mc
from core.models import ChatMessage
from routes import history_routes, session_routes


class _Session:
    model = "m"
    endpoint_url = "http://endpoint/v1/chat/completions"
    name = "n"
    mode = "chat"

    def __init__(self):
        self.history = [ChatMessage(role="user" if i % 2 == 0 else "assistant", content=f"line {i}") for i in range(8)]

    def get_context_messages(self, **k):
        return [{"role": m.role, "content": m.content} for m in self.history]


class _Mgr:
    def get_session(self, sid):
        return _Session()


def _slow_probe(endpoint_url, model):
    time.sleep(0.5)  # the blocking network work
    return 4096


async def _with_ticker(call):
    gaps, stop = [], asyncio.Event()

    async def ticker():
        last = time.monotonic()
        while not stop.is_set():
            await asyncio.sleep(0.02)
            now = time.monotonic()
            gaps.append(now - last)
            last = now

    t = asyncio.create_task(ticker())
    out = await call()
    stop.set()
    await t
    assert len(gaps) >= 10, "the blocking probe never ran (the route returned early), so the test proves nothing"
    return out, max(gaps)


def _fresh(monkeypatch):
    mc._context_ttl_cache.clear()
    mc._context_inflight.clear()
    monkeypatch.setattr(mc, "get_context_length", _slow_probe)


def test_context_info_route_does_not_block_the_event_loop(monkeypatch):
    _fresh(monkeypatch)
    monkeypatch.setattr(session_routes, "_verify_session_owner", lambda *a, **k: None)
    app = FastAPI()
    app.include_router(session_routes.setup_session_routes(_Mgr(), {}))

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.get("/api/session/s1/context_info")

    r, worst = asyncio.run(_with_ticker(go))
    assert r.status_code == 200 and r.json()["context_length"] == 4096, (r.status_code, r.text)
    assert worst < 0.2, f"the event loop stalled {worst:.2f}s in context_info"


def test_compact_route_size_probe_does_not_block_the_event_loop(monkeypatch):
    _fresh(monkeypatch)
    monkeypatch.setattr(history_routes, "_verify_session_owner", lambda *a, **k: None)
    monkeypatch.setattr(history_routes, "_reject_compact_for_game_session", lambda s: None)
    monkeypatch.setattr(history_routes, "_reject_compact_during_active_run", lambda sid: None)

    import src.llm_core as llm

    async def stub_llm(*a, **k):
        raise RuntimeError("stop after the size probe")  # the route reports a failure; only the probe timing matters

    monkeypatch.setattr(llm, "llm_call_async", stub_llm)
    app = FastAPI()
    app.include_router(history_routes.setup_history_routes(_Mgr()))

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            return await c.post("/api/session/s1/compact")

    _, worst = asyncio.run(_with_ticker(go))
    assert worst < 0.2, f"the event loop stalled {worst:.2f}s in compact"


def test_source_pin_the_routes_use_the_async_probe():
    root = Path(__file__).resolve().parents[1] / "routes"
    assert "await get_context_length_async(session.endpoint_url, session.model)" in (root / "session_routes.py").read_text(encoding="utf-8")
    assert "await get_context_length_async(session.endpoint_url, session.model)" in (root / "history_routes.py").read_text(encoding="utf-8")
