"""Audit T20 (headline) — identity propagation is ASSERTED behaviorally, not grepped.

The gap: every FE test monkeypatched orwell_engine's per-tool functions, so deleting
``user=`` from any orwell route (or ``owner=`` from a chat-tool relay) still passed the
whole suite — the engine sandbox key (0021 cross-user isolation) had zero behavioral
coverage. This is the test-side twin of audit E29 (the route code already resolves the
effective owner; nothing proved it kept doing so).

These tests pin the chain at the WIRE: a fake HTTP transport stands in for the engine
client's shared httpx client and records the exact ``X-Orwell-User`` header each engine
call would carry. The real route / the real chat-tool relay runs above it, so deleting
``user=`` anywhere in the chain (route -> client function -> ``_user_headers``) blanks
the header and fails loudly. Covered (the T20 headline only):

  * one /api/orwell/* route (GET /state) end-to-end: auth tier -> route -> client -> header;
  * the binding write route (POST /decision) under the caller's identity;
  * the chat-tool relay path (src/tool_implementations.do_* with owner=);
  * two different owners produce two different asserted identities (both paths);
  * an anonymous caller sends NO X-Orwell-User header (B67/ops A2: the ENGINE decides
    the anonymous policy; the front-end must not invent an identity).

Name-agnostic; no engine process needed (and none is ever reachable: the transport is
faked and the endpoint is pinned to the discard port).
"""

import importlib
import json

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_routes = importlib.import_module("routes.orwell_routes")
tool_impl = importlib.import_module("src.tool_implementations")


def _run(coro):
    """Run on a PRIVATE loop. The shared per-thread loop can carry tasks an EARLIER test left pending (a fire-and-forget kickoff); `run_until_complete` on
    it would also run those, and they post through the patched engine transport - a second request in `transport.requests`, so `(req,) = ...` failed
    ('too many values to unpack') depending only on which tests shared the xdist worker. A fresh loop runs exactly this test's coroutine."""
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# --- hermetic pin: even a transport-patch slip must never reach a live 8765 engine -----

@pytest.fixture(autouse=True)
def _hermetic_engine_url(monkeypatch):
    monkeypatch.setenv("ORWELL_ENGINE_MCP_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("BBAI_ENGINE_MCP_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(orwell_engine, "ENGINE_URL", "http://127.0.0.1:9")


# --- the fake wire ---------------------------------------------------------------------

class _FakeResponse:
    status_code = 200

    def __init__(self, result):
        self._result = result

    def json(self):
        return {"result": self._result}


class _FakeTransport:
    """Stands in for orwell_engine's shared httpx AsyncClient; records every request the
    engine would have received — url, tool name, and (the point) the identity headers."""

    is_closed = False

    def __init__(self, result=None):
        self.requests = []
        self._result = result if result is not None else {"started": True}

    async def post(self, url, json=None, headers=None, timeout=None):
        self.requests.append({
            "url": url,
            "tool": (json or {}).get("name"),
            "headers": dict(headers or {}),
        })
        return _FakeResponse(self._result)


@pytest.fixture
def transport(monkeypatch):
    t = _FakeTransport()
    monkeypatch.setattr(orwell_engine, "_shared_client", lambda: t)
    return t


def _client() -> TestClient:
    """The orwell router under a minimal auth tier: the real app's auth middleware stamps
    the resolved user onto request.state; here each request asserts its caller via the
    x-test-user header, so one client can play two different owners."""
    app = FastAPI()

    @app.middleware("http")
    async def _auth_tier(request: Request, call_next):
        request.state.current_user = request.headers.get("x-test-user") or None
        return await call_next(request)

    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app)


# --- the /api/orwell/* route path ------------------------------------------------------

def test_state_route_asserts_the_calling_users_identity_on_the_wire(transport):
    r = _client().get("/api/orwell/state", headers={"x-test-user": "owner-a"})
    assert r.status_code == 200
    (req,) = transport.requests
    assert req["tool"] == "getGameState"
    assert "/player/call" in req["url"]
    # THE assertion T20 found missing: the engine call carries the calling user's identity.
    assert req["headers"].get("X-Orwell-User") == "owner-a"


def test_two_owners_produce_two_identities_on_the_route(transport):
    client = _client()
    client.get("/api/orwell/state", headers={"x-test-user": "owner-a"})
    client.get("/api/orwell/state", headers={"x-test-user": "owner-b"})
    users = [r["headers"].get("X-Orwell-User") for r in transport.requests]
    assert users == ["owner-a", "owner-b"]  # never collapsed into one shared sandbox (0021)


def test_decision_route_binds_under_the_callers_identity(transport):
    r = _client().post(
        "/api/orwell/decision",
        json={"kind": "eviction-vote", "vote": "npc:2"},
        headers={"x-test-user": "owner-a"},
    )
    assert r.status_code == 200
    (req,) = transport.requests
    assert req["tool"] == "submitDecision"
    assert req["headers"].get("X-Orwell-User") == "owner-a"


# --- the chat-tool relay path (the agent's do_* tools take owner=) ----------------------

def test_tool_relay_passes_the_owner_to_the_engine(transport):
    res = _run(tool_impl.do_get_game_state("", owner="owner-a"))
    assert res.get("exit_code") == 0
    (req,) = transport.requests
    assert req["tool"] == "getGameState"
    assert req["headers"].get("X-Orwell-User") == "owner-a"


def test_tool_relay_distinguishes_two_owners(transport):
    decision = json.dumps({"kind": "deal-offer", "vote": "accept"})
    assert _run(tool_impl.do_submit_decision(decision, owner="owner-a")).get("exit_code") == 0
    assert _run(tool_impl.do_submit_decision(decision, owner="owner-b")).get("exit_code") == 0
    users = [
        r["headers"].get("X-Orwell-User")
        for r in transport.requests
        if r["tool"] == "submitDecision"
    ]
    assert users == ["owner-a", "owner-b"]


def test_anonymous_caller_sends_no_user_header(transport):
    # B67/ops A2: anonymous sends NO header — the engine defaults or refuses; the front-end
    # must not mint an identity of its own.
    res = _run(tool_impl.do_get_game_state("", owner=None))
    assert res.get("exit_code") == 0
    (req,) = transport.requests
    assert "X-Orwell-User" not in req["headers"]


def test_a_task_left_pending_by_an_earlier_test_cannot_add_a_request_to_this_one(transport):
    """The ordering leak itself: leave a pending engine call on the SHARED loop, as an earlier test can, then run the relay. Only this test's call is recorded."""
    import asyncio
    shared = asyncio.get_event_loop()

    async def leaked():
        await asyncio.sleep(0)
        await orwell_engine.get_game_state(user="someone-else")

    pending = shared.create_task(leaked())
    try:
        assert _run(tool_impl.do_get_game_state("", owner="owner-a")).get("exit_code") == 0
        (req,) = transport.requests
        assert req["headers"].get("X-Orwell-User") == "owner-a"
    finally:
        pending.cancel()
        try:
            shared.run_until_complete(pending)
        except BaseException:  # noqa: BLE001 - cancellation of our own probe task
            pass
