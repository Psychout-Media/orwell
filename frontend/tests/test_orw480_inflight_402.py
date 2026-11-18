"""ORW-480: a 402 that only says other requests are in flight (a busy account, fifteen photos asked at once) is asked again after a wait and never opens the
hour-long billing breaker; a plain 402 still opens it."""
import asyncio
import importlib

import pytest

P = importlib.import_module("src.orwell_portraits")
INFLIGHT = "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credit"


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    P.reset_billing_breaker()
    slept = []

    async def _sleep(s):
        slept.append(s)

    monkeypatch.setattr(P.asyncio, "sleep", _sleep)
    yield slept
    P.reset_billing_breaker()


def _fake_inner(monkeypatch, answers):
    calls = []

    async def inner(prompt, user, reference_png=None, keep_identity=True, _ctx=None):
        calls.append(prompt)
        ans = answers[min(len(calls) - 1, len(answers) - 1)]
        if _ctx is not None:
            _ctx["host"] = "api.provider.test"
        if ans is None:
            P._set_gen_state("http-402", INFLIGHT)
            return None
        if ans == "plain":
            P._set_gen_state("http-402", "Insufficient credits")
            return None
        return b"PNG:ok"

    monkeypatch.setattr(P, "_generate_one_inner", inner)
    return calls


def test_the_classifier_reads_only_the_in_flight_402():
    assert P.is_inflight_credit_refusal("http-402", INFLIGHT)
    assert not P.is_inflight_credit_refusal("http-402", "Insufficient credits")
    assert not P.is_inflight_credit_refusal("http-429", "in-flight")


def test_an_in_flight_refusal_waits_and_asks_again_without_a_breaker(monkeypatch, _clean):
    calls = _fake_inner(monkeypatch, [None, None, "ok"])
    png = _run(P._generate_one("p", "u"))
    assert png == b"PNG:ok" and len(calls) == 3
    assert _clean == [10.0, 25.0]
    assert not P.billing_breaker_open()


def test_a_plain_402_still_opens_the_breaker_after_one_call(monkeypatch):
    calls = _fake_inner(monkeypatch, ["plain"])
    assert _run(P._generate_one("p", "u")) is None
    assert len(calls) == 1 and P.billing_breaker_open()


def test_the_photo_brief_writer_is_on_by_default():
    from src import orwell_photo_brief as B
    assert B.brief_enabled("nobody") is True
