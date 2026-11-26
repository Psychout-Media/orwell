"""ORW-835 (exposeSecret) - a model-driven exposeSecret the ENGINE REFUSED (a typed `refused`: not-learned / already-spent / no-subject; or an error / null) recorded nothing, so the
omission remains: the expose belt may run once more that turn, but never for the fact the engine just refused, and not at all when the lever itself is `capped`. An expose that went out
stands the belt down. Real `stream_agent_loop` + the stateful stand-in of `_orw835_harness`. Telemetry stays success-gated. Roles only."""
import pytest

import _orw835_harness as h


@pytest.fixture(autouse=True)
def _reset():
    h.reset_loop_state()
    yield


def _go(monkeypatch, **kw):
    return h.drive(monkeypatch, belt="expose", **kw)


def test_a_refused_model_expose_leaves_the_belt_armed_for_another_fact(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("exposeSecret", {"factId": "fact:a"})], spent=("fact:a",), extraction='{"factId":"fact:b"}')
    assert engine["calls"] == [("expose", "fact:a"), ("expose", "fact:b")]   # the model's refused call, then the belt's different one
    assert engine["exposed"] == ["fact:b"] and belts.count("auto-expose-secret") == 1


def test_the_belt_never_re_exposes_the_fact_the_engine_just_refused(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("exposeSecret", {"factId": "fact:a"})], spent=("fact:a",), extraction='{"factId":"fact:a"}')
    assert engine["calls"] == [("expose", "fact:a")] and engine["exposed"] == [] and "auto-expose-secret" not in belts


def test_a_model_expose_the_tool_layer_rejected_leaves_the_belt_armed_for_a_real_known_fact(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("exposeSecret", {"bluff": True})], extraction='{"factId":"fact:a"}')
    assert engine["calls"] == [("expose", "fact:a")]   # a bluff with no subject is an error result (exit 1) that never reached the engine: the belt, grounded in a known fact, still fires
    assert engine["exposed"] == ["fact:a"] and belts.count("auto-expose-secret") == 1


def test_a_lever_the_engine_refused_as_capped_is_not_asked_again(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("exposeSecret", {"factId": "fact:a"})], capped=True, extraction='{"factId":"fact:b"}')
    assert engine["calls"] == [("expose", "fact:a")] and "auto-expose-secret" not in belts


def test_a_model_expose_the_engine_took_still_stands_the_belt_down(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("exposeSecret", {"factId": "fact:a"})], extraction='{"factId":"fact:b"}')
    assert engine["calls"] == [("expose", "fact:a")] and engine["exposed"] == ["fact:a"] and "auto-expose-secret" not in belts


def test_a_belt_expose_the_engine_refuses_again_is_not_counted(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("exposeSecret", {"factId": "fact:a"})], spent=("fact:a",), unlearned=("fact:b",), extraction='{"factId":"fact:b"}')
    assert engine["calls"] == [("expose", "fact:a"), ("expose", "fact:b")] and engine["exposed"] == []
    assert "auto-expose-secret" not in belts   # success-gated: a typed refusal is never a fired belt


def test_with_no_model_call_the_belt_still_fires_once(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[], extraction='{"factId":"fact:a"}')
    assert engine["calls"] == [("expose", "fact:a")] and belts.count("auto-expose-secret") == 1
