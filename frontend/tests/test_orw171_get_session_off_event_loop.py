"""ORW-171 slice 3: the hot async reads call the blocking session_manager.get_session OFF the event loop. A stub get_session blocks 0.5 s; a ticker running on the SAME loop must keep ticking while the route waits. No model."""
import asyncio
import time

import httpx
import pytest
from fastapi import FastAPI

from core.models import ChatMessage
from routes import history_routes
from routes.history_routes import setup_history_routes


class _Session:
    model = "m"
    endpoint_url = "u"
    name = "n"
    mode = "chat"

    def __init__(self):
        self.history = [ChatMessage(role="user", content="hi", metadata={"_db_id": "id1", "_seq": 1})]


class _SlowMgr:
    def get_session(self, sid):
        time.sleep(0.5)  # the blocking DB work
        return _Session()


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_history_route_does_not_block_the_event_loop(monkeypatch):
    monkeypatch.setattr(history_routes, "_verify_session_owner", lambda *a, **k: None)
    import routes.chat_helpers as ch
    monkeypatch.setattr(ch, "player_visible_history", lambda session, rows: rows)
    app = FastAPI()
    app.include_router(setup_history_routes(_SlowMgr()))

    async def go():
        gaps, stop = [], asyncio.Event()

        async def ticker():
            last = time.monotonic()
            while not stop.is_set():
                await asyncio.sleep(0.02)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        t = asyncio.create_task(ticker())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            r = await c.get("/api/history/s1")
        stop.set()
        await t
        return r, max(gaps)

    r, worst = _run(go())
    assert r.status_code == 200 and r.json()["history"]
    assert worst < 0.2, f"the event loop stalled {worst:.2f}s while get_session ran - it is still on the loop"


def test_source_pin_the_hot_reads_use_to_thread():
    from pathlib import Path
    root = Path(__file__).resolve().parents[1] / "routes"
    assert "asyncio.to_thread(session_manager.get_session, session_id)" in (root / "history_routes.py").read_text()
    chat = (root / "chat_routes.py").read_text()
    assert chat.count("asyncio.to_thread(session_manager.get_session, session)") == 2
