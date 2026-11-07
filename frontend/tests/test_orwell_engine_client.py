"""Engine-client behavior: tell "no active game" (a normal pre-game state) apart from a real engine
outage, and report concrete reasons for VISIBLE front-end error surfacing.

The engine refuses a no-game user with a 404 `{"error":"no active game for this user"}` (the knownUser
guard — it won't mint a sandbox for a probe). The front-end must read that as `started:false`, NOT as
an outage, or a brand-new player gets a confusing "live feeds are down" message instead of casting.
Name-agnostic; httpx is faked with REAL `httpx.Response` objects so status/JSON/raise_for_status behave.
"""
import importlib

import httpx
import pytest

orwell_engine = importlib.import_module("src.orwell_engine")


def _resp(status: int, *, payload=None, text=None) -> httpx.Response:
    req = httpx.Request("POST", orwell_engine.ENGINE_URL.rstrip("/") + "/player/call")
    if payload is not None:
        return httpx.Response(status, json=payload, request=req)
    return httpx.Response(status, text=text or "", request=req)


class _FakeClient:
    """Stands in for httpx.AsyncClient: returns a prepared response, or raises a transport error."""
    def __init__(self, *, resp=None, exc=None):
        self._resp, self._exc = resp, exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_a):
        return False

    async def post(self, *_a, **_k):
        if self._exc:
            raise self._exc
        return self._resp

    async def get(self, *_a, **_k):
        if self._exc:
            raise self._exc
        return self._resp


def _patch(monkeypatch, *, resp=None, exc=None):
    monkeypatch.setattr(orwell_engine.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp, exc=exc))


def _run(coro):
    # A PRIVATE event loop per call (ORW-229 review flake). With the thread's shared loop, a fire-and-forget task another test left on it
    # (e.g. the competition-fiction kickoff, which calls competitionStagingView) woke up while this module drove the loop, went through the
    # transport patched here and overwrote the recorded last error: under xdist, last_engine_error() named competitionStagingView instead of
    # advanceGame. A private loop never runs anyone else's tasks. Not asyncio.run(): it clears the thread's current loop for later tests.
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture(autouse=True)
def _reset_last_error():
    orwell_engine._clear_error()
    yield
    orwell_engine._clear_error()


# --- "no active game" is a pre-game STATE, not an outage --------------------------------

def test_get_game_state_maps_no_active_game_404_to_started_false(monkeypatch):
    _patch(monkeypatch, resp=_resp(404, payload={"error": "no active game for this user"}))
    assert _run(orwell_engine.get_game_state(user="fresh")) == {"started": False}


def test_get_game_state_propagates_a_real_outage(monkeypatch):
    # Connection refused (engine not running / wrong URL) → must RAISE so framing fails closed.
    _patch(monkeypatch, exc=httpx.ConnectError("refused"))
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine.get_game_state(user="x"))


def test_get_game_state_propagates_a_proxy_5xx_without_a_structured_body(monkeypatch):
    # A gateway 502 (HTML, no engine JSON) means the engine is unreachable behind a proxy — an outage.
    _patch(monkeypatch, resp=_resp(502, text="<html>bad gateway</html>"))
    with pytest.raises(httpx.HTTPStatusError):
        _run(orwell_engine.get_game_state(user="x"))


def test_call_surfaces_a_structured_engine_error_as_EngineToolError(monkeypatch):
    _patch(monkeypatch, resp=_resp(400, payload={"error": "bad args"}))
    with pytest.raises(orwell_engine.EngineToolError) as ei:
        _run(orwell_engine._call("recordInteraction", {}, user="x"))
    assert ei.value.status == 400 and ei.value.no_game is False


def test_call_returns_the_result_on_success(monkeypatch):
    _patch(monkeypatch, resp=_resp(200, payload={"result": {"started": True, "phase": "premiere"}}))
    assert _run(orwell_engine.get_game_state(user="x")) == {"started": True, "phase": "premiere"}


# --- health detail for the visible banner ----------------------------------------------

def test_health_detail_ok(monkeypatch):
    _patch(monkeypatch, resp=_resp(200, payload={"ok": True}))
    d = _run(orwell_engine.engine_health_detail())
    assert d["ok"] is True and d["engineUrl"]


def test_health_detail_reports_the_concrete_reason_when_down(monkeypatch):
    _patch(monkeypatch, exc=httpx.ConnectError("All connection attempts failed"))
    d = _run(orwell_engine.engine_health_detail())
    assert d["ok"] is False
    assert "ConnectError" in d["error"] and "connection attempts failed" in d["error"]
    assert _run(orwell_engine.engine_health()) is False  # bool wrapper agrees


# --- last-error tracking: "engine up but erroring" is reported, normal states are not ----

def test_run_drives_a_private_loop_so_a_stray_task_on_the_shared_loop_never_wakes_up():
    """The root cause of the xdist flake: another test's background task on the shared loop must not run during this module's calls."""
    import asyncio
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        shared = asyncio.get_event_loop()
    woke = []

    async def stray():
        woke.append(True)

    task = shared.create_task(stray())
    try:
        _run(asyncio.sleep(0))
        assert woke == [] and not task.done()
    finally:
        task.cancel()
        shared.run_until_complete(asyncio.gather(task, return_exceptions=True))


def test_failed_tool_call_records_the_last_error_and_success_clears_it(monkeypatch):
    _patch(monkeypatch, resp=_resp(500, payload={"error": "internal error"}))
    with pytest.raises(orwell_engine.EngineToolError):
        _run(orwell_engine._call("advanceGame", {}, user="x"))
    le = orwell_engine.last_engine_error()
    assert le and le["tool"] == "advanceGame" and le["kind"] == "tool-error"
    assert "internal error" in le["error"]

    _patch(monkeypatch, resp=_resp(200, payload={"result": {"ok": True}}))
    _run(orwell_engine._call("gameStatus", {}, user="x"))
    assert orwell_engine.last_engine_error() is None  # healthy again


def test_transport_failure_records_kind_unreachable(monkeypatch):
    _patch(monkeypatch, exc=httpx.ConnectError("refused"))
    with pytest.raises(httpx.ConnectError):
        _run(orwell_engine._call("gameStatus", {}, user="x"))
    le = orwell_engine.last_engine_error()
    assert le and le["kind"] == "unreachable" and "ConnectError" in le["error"]


def test_the_pre_game_no_active_game_refusal_is_never_recorded_as_an_error(monkeypatch):
    _patch(monkeypatch, resp=_resp(404, payload={"error": "no active game for this user"}))
    assert _run(orwell_engine.get_game_state(user="fresh")) == {"started": False}
    assert orwell_engine.last_engine_error() is None  # a normal state, not a technical problem


def test_a_recorded_error_expires_after_the_ttl(monkeypatch):
    _patch(monkeypatch, resp=_resp(500, payload={"error": "boom"}))
    with pytest.raises(orwell_engine.EngineToolError):
        _run(orwell_engine._call("advanceGame", {}, user="x"))
    assert orwell_engine.last_engine_error() is not None
    orwell_engine._LAST_ERROR["ts"] -= orwell_engine._LAST_ERROR_TTL_S + 1  # age it out
    assert orwell_engine.last_engine_error() is None


def test_health_detail_carries_a_recent_tool_error_while_the_engine_is_up(monkeypatch):
    orwell_engine._record_error("advanceGame", "tool-error", "internal error (HTTP 500)")
    _patch(monkeypatch, resp=_resp(200, payload={"ok": True}))
    d = _run(orwell_engine.engine_health_detail())
    assert d["ok"] is True  # the process answers /health …
    assert d["lastError"]["tool"] == "advanceGame"  # … but the recent failure is reported
    assert "internal error" in d["lastError"]["error"]
    assert d["lastError"]["ageSeconds"] >= 0


def test_admin_calls_share_the_same_error_semantics(monkeypatch):
    _patch(monkeypatch, resp=_resp(400, payload={"error": "bad mechanic"}))
    with pytest.raises(orwell_engine.EngineToolError):
        _run(orwell_engine.inspect_non_vault_state(user="x"))
    le = orwell_engine.last_engine_error()
    assert le and le["tool"] == "inspectNonVaultState" and le["kind"] == "tool-error"
