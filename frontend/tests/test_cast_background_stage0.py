"""Casting in the background, stage 0: a failed cast warm heals itself, the server starts the portraits, and every
image request goes through one process-wide queue (at most 3 in flight; an in-flight-credits 402 is back-pressure)."""
import asyncio

import pytest

from src import orwell_prewarm as P
from src import orwell_portraits as PO

_RES = {
    "warmed": True, "seed": 5,
    "house": [{"id": "npc:1", "name": "A"}, {"id": "npc:2", "name": "B"}],
    "portraitPrompts": [{"houseguestId": "npc:1", "name": "A", "prompt": "a"},
                        {"houseguestId": "npc:2", "name": "B", "prompt": "b"}],
}


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _settle(cond, timeout=3.0):
    async def _w():
        t = 0.0
        while not cond() and t < timeout:
            await asyncio.sleep(0.01)
            t += 0.01
        return cond()
    return _run(_w())


class _Engine:
    async def pre_seed_cast(self, user=None):
        return _RES


class _Genesis:
    async def run_genesis(self, cast, seed, user):
        return {"committed": 0}


class _Identity:
    async def run_identity(self, cast, user, seed=None):
        return 0


class _Authoring:
    """Fails (strict latch set) for the first `fail_runs` runs, then succeeds and authors everyone."""
    def __init__(self, fail_runs):
        self.fail_runs = fail_runs
        self.runs = 0
        self._failed = False

    def strict_failed(self, user):
        return self._failed

    def kickoff_authoring(self, cast, user, then=None, on_authored=None, write=None, seed=None):
        self.runs += 1
        self._failed = self.runs <= self.fail_runs
        if not self._failed:
            for c in cast:
                on_authored(c["id"])
        then()


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    P.reset()
    monkeypatch.setattr(P, "_RETRY_BACKOFF_S", (0.01,))
    shots = []
    monkeypatch.setattr(PO, "kickoff_authored_reshoot", lambda hid, user: shots.append(hid) or True)
    from src import orwell_house_authoring
    async def _noop(seed, owner):
        return {}
    monkeypatch.setattr(orwell_house_authoring, "run_house", _noop)
    yield shots
    P.reset()


def _warm(auth, **kw):
    return _run(P.prewarm_cast("u", engine=_Engine(), authoring=auth, identity=_Identity(), genesis=_Genesis(), **kw))


def test_warm_that_fails_twice_then_succeeds(_clean):
    auth = _Authoring(fail_runs=2)
    _warm(auth)
    assert _settle(lambda: auth.runs == 3 and P._STATE["u"].ok)
    assert auth.runs == 3  # one first run + two retries, then it stopped
    _run(asyncio.sleep(0.1))
    assert auth.runs == 3


def test_later_prewarm_call_after_failure_restarts_it(monkeypatch):
    monkeypatch.setattr(P, "_RETRY_BACKOFF_S", (3600.0,))  # the backoff alone would never fire in this test
    auth = _Authoring(fail_runs=1)
    _warm(auth)
    assert _settle(lambda: P._STATE["u"].author_done.is_set())
    assert auth.runs == 1 and not P._STATE["u"].ok
    again = _warm(auth)  # the browser asks again: not a no-op
    assert again.get("restarted") is True
    assert _settle(lambda: auth.runs == 2 and P._STATE["u"].ok)


def test_retries_stop_when_the_interview_ends(monkeypatch):
    monkeypatch.setattr(P, "_RETRY_BACKOFF_S", (0.05,))
    auth = _Authoring(fail_runs=99)
    _warm(auth)
    assert _settle(lambda: auth.runs >= 2)
    P.interview_ended("u")
    n = auth.runs
    _run(asyncio.sleep(0.3))
    assert auth.runs <= n + 1


def test_restart_warm_starts_a_retry_after_a_refusal(monkeypatch):
    monkeypatch.setattr(P, "_RETRY_BACKOFF_S", (3600.0,))
    auth = _Authoring(fail_runs=1)
    _warm(auth)
    assert _settle(lambda: P._STATE["u"].author_done.is_set())
    res = _run(P.restart_warm("u"))
    assert res["restarted"] is True
    assert _settle(lambda: auth.runs == 2 and P._STATE["u"].ok)


def test_server_starts_portraits_with_no_browser_call(_clean):
    shots = _clean
    auth = _Authoring(fail_runs=0)
    _warm(auth)  # no warm_portraits call from a browser anywhere
    assert _settle(lambda: set(shots) == {"npc:1", "npc:2"})
    assert P.warm_state("u")["portraitsStarted"] is True
    again = _run(P.warm_portraits("u"))  # the browser's own call is a harmless duplicate
    assert again.get("alreadyStarted") or again.get("started")


# ── the process-wide image queue ─────────────────────────────────────────────────

@pytest.fixture
def img(monkeypatch):
    PO._IMAGE_GATES.clear()
    monkeypatch.setattr(PO, "portrait_parallel", lambda user=None: 3)
    monkeypatch.setitem(PO._PROVIDER_PROVEN, "ok", True)
    PO.reset_billing_breaker()
    monkeypatch.setitem(PO._PROVIDER_PROVEN, "ok", True)
    yield
    PO.reset_billing_breaker()


def test_thirteen_requests_never_exceed_three_in_flight(img, monkeypatch):
    live = {"n": 0, "max": 0}

    async def inner(prompt, user, reference_png=None, keep_identity=True, _ctx=None):
        live["n"] += 1
        live["max"] = max(live["max"], live["n"])
        await asyncio.sleep(0.02)
        live["n"] -= 1
        return b"png"

    monkeypatch.setattr(PO, "_generate_one_inner", inner)

    async def go():
        return await asyncio.gather(*[PO._generate_one(f"p{i}", "u") for i in range(13)])

    out = _run(go())
    assert out == [b"png"] * 13
    assert live["max"] == 3


def test_in_flight_402_requeues_and_never_opens_the_breaker(img, monkeypatch):
    monkeypatch.setattr(PO, "INFLIGHT_RETRY_WAITS_S", (0.01, 0.01, 0.01))
    monkeypatch.setattr(PO, "INFLIGHT_RETRY_WAITS", (0.01, 0.01, 0.01))  # the inner (ORW-480) re-ask layer sleeps real seconds otherwise
    calls = {"n": 0}

    async def inner(prompt, user, reference_png=None, keep_identity=True, _ctx=None):
        calls["n"] += 1
        _ctx["host"] = "openrouter.ai"
        if calls["n"] <= 2:
            PO._note_gen_error("http-402", "This request would exceed your available credits given your current in-flight requests")
            return None
        return b"png"

    monkeypatch.setattr(PO, "_generate_one_inner", inner)
    assert _run(PO._generate_one("p", "u")) == b"png"
    assert calls["n"] == 3
    assert not PO.billing_breaker_open()


def test_in_flight_402_that_never_clears_still_does_not_trip_the_breaker(img, monkeypatch):
    monkeypatch.setattr(PO, "INFLIGHT_RETRY_WAITS_S", (0.01,))
    monkeypatch.setattr(PO, "INFLIGHT_RETRY_WAITS", (0.01,))  # the inner (ORW-480) re-ask layer sleeps real seconds otherwise

    async def inner(prompt, user, reference_png=None, keep_identity=True, _ctx=None):
        _ctx["host"] = "openrouter.ai"
        PO._note_gen_error("http-402", "would exceed your available credits given your current in-flight requests")
        return None

    monkeypatch.setattr(PO, "_generate_one_inner", inner)
    assert _run(PO._generate_one("p", "u")) is None
    assert not PO.billing_breaker_open()


def test_a_real_402_still_opens_the_breaker(img, monkeypatch):
    monkeypatch.setattr(PO, "INFLIGHT_RETRY_WAITS_S", (0.01,))
    monkeypatch.setattr(PO, "INFLIGHT_RETRY_WAITS", (0.01,))  # the inner (ORW-480) re-ask layer sleeps real seconds otherwise
    calls = {"n": 0}

    async def inner(prompt, user, reference_png=None, keep_identity=True, _ctx=None):
        calls["n"] += 1
        _ctx["host"] = "openrouter.ai"
        PO._note_gen_error("http-402", "Insufficient credits")
        return None

    monkeypatch.setattr(PO, "_generate_one_inner", inner)
    assert _run(PO._generate_one("p", "u")) is None
    assert calls["n"] == 1  # real billing error: no requeue
    assert PO.billing_breaker_open()


def test_finalize_refusal_starts_a_warm_and_tells_the_producer_the_truth(monkeypatch):
    from src import tool_implementations as T
    started = []

    async def fake_restart(user=None):
        started.append(user)
        return {"restarted": True}

    monkeypatch.setattr(P, "restart_warm", fake_restart)
    msg = _run(T._refusal_with_warm("u", "Casting can't finalize yet."))
    assert started == ["u"]
    assert "NOT cast yet" in msg and "do not go quiet" in msg and msg.startswith("Casting can't finalize yet.")

    async def none_started(user=None):
        return {"restarted": False, "reason": "prewarm-failed"}

    monkeypatch.setattr(P, "restart_warm", none_started)
    assert _run(T._refusal_with_warm("u", "plain")) == "plain"
