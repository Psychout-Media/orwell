"""ORW-835 (confide) - a model-driven confide the ENGINE REFUSED (null: an unknown / departed houseguest; or an error) recorded nothing, so the omission remains: the confide belt may run
once more that turn, but never for the houseguest the engine just refused. `{disclosed:false}` is a TAKEN, normal result (the engine rolled and kept the secret) and still stands the belt down.
Real `stream_agent_loop` + the stateful stand-in of `_orw835_harness`. Telemetry stays success-gated. Roles only."""
import pytest

import _orw835_harness as h


@pytest.fixture(autouse=True)
def _reset():
    h.reset_loop_state()
    yield


def _go(monkeypatch, **kw):
    return h.drive(monkeypatch, belt="confide", **kw)


def test_a_refused_model_confide_leaves_the_belt_armed_for_another_houseguest(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("confide", {"npcId": "npc:9"})], extraction='{"npcId":"npc:1"}')
    assert engine["calls"] == [("confide", "npc:9"), ("confide", "npc:1")]   # the model's refused call, then the belt's different one
    assert engine["told"] == ["npc:1"] and belts.count("auto-confide") == 1


def test_the_belt_never_presses_the_houseguest_the_engine_just_refused(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("confide", {"npcId": "npc:2"})], extraction='{"npcId":"npc:2"}', unknown=("npc:2",))
    assert engine["calls"] == [("confide", "npc:2")]   # only the model's call: the refused houseguest is not pressed again
    assert engine["told"] == [] and "auto-confide" not in belts


def test_a_model_confide_the_engine_took_with_nothing_disclosed_still_stands_the_belt_down(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("confide", {"npcId": "npc:1"})], extraction='{"npcId":"npc:2"}', silent=("npc:1",))
    assert engine["calls"] == [("confide", "npc:1")] and "auto-confide" not in belts   # {disclosed:false} is the engine's answer, not a refusal


def test_a_model_confide_that_disclosed_still_stands_the_belt_down(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("confide", {"npcId": "npc:1"})], extraction='{"npcId":"npc:2"}')
    assert engine["calls"] == [("confide", "npc:1")] and engine["told"] == ["npc:1"] and "auto-confide" not in belts


def test_a_belt_confide_the_engine_refuses_again_is_not_counted(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[("confide", {"npcId": "npc:9"})], extraction='{"npcId":"npc:1"}', unknown=("npc:9", "npc:1"))
    assert engine["calls"] == [("confide", "npc:9"), ("confide", "npc:1")] and engine["told"] == []
    assert "auto-confide" not in belts   # success-gated: a null result is never a fired belt


def test_with_no_model_call_the_belt_still_fires_once(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[], extraction='{"npcId":"npc:1"}')
    assert engine["calls"] == [("confide", "npc:1")] and belts.count("auto-confide") == 1
