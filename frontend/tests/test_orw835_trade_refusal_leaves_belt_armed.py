"""ORW-835 (tradeSecret) - a model-driven tradeSecret the ENGINE REFUSED (a typed `refused`: not-learned / already-spent / no-recipient; or an error / null) recorded nothing, so the
omission remains: the trade belt may run once more that turn, but never for the fact+recipient pair the engine just refused, and not at all when the lever itself is `capped`. A trade
the recipient `declined` was ADJUDICATED (the engine took the call), and a struck one, both still stand the belt down. Real `stream_agent_loop` + the stateful stand-in of
`_orw835_harness`. Telemetry stays success-gated. Roles only."""
import pytest

import _orw835_harness as h


@pytest.fixture(autouse=True)
def _reset():
    h.reset_loop_state()
    yield


def _go(monkeypatch, **kw):
    return h.drive(monkeypatch, belt="trade", **kw)


def _model(fact, to):
    return [("tradeSecret", {"factId": fact, "toNpcId": to})]


def test_a_refused_model_trade_leaves_the_belt_armed_for_another_pair(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=_model("fact:a", "npc:1"), spent=("fact:a",), extraction='{"factId":"fact:b","toNpcId":"npc:1","askKind":"a vote"}')
    assert engine["calls"] == [("trade", "fact:a", "npc:1"), ("trade", "fact:b", "npc:1")]   # the model's refused call, then the belt's different one
    assert engine["traded"] == [("fact:b", "npc:1")] and belts.count("auto-trade-secret") == 1


def test_a_refused_recipient_is_not_re_asked_but_the_same_fact_to_another_recipient_is_a_new_ask(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=_model("fact:a", "npc:9"), extraction='{"factId":"fact:a","toNpcId":"npc:9","askKind":"a vote"}')
    assert engine["calls"] == [("trade", "fact:a", "npc:9")] and engine["traded"] == [] and "auto-trade-secret" not in belts   # same pair: never re-issued
    other, belts = _go(monkeypatch, model_calls=_model("fact:a", "npc:9"), extraction='{"factId":"fact:a","toNpcId":"npc:1","askKind":"a vote"}')
    assert other["calls"] == [("trade", "fact:a", "npc:9"), ("trade", "fact:a", "npc:1")] and other["traded"] == [("fact:a", "npc:1")]
    assert belts.count("auto-trade-secret") == 1


def test_a_lever_the_engine_refused_as_capped_is_not_asked_again(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=_model("fact:a", "npc:1"), capped=True, extraction='{"factId":"fact:b","toNpcId":"npc:1","askKind":"x"}')
    assert engine["calls"] == [("trade", "fact:a", "npc:1")] and "auto-trade-secret" not in belts


def test_a_model_trade_the_recipient_declined_was_adjudicated_and_stands_the_belt_down(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=_model("fact:a", "npc:1"), decline=(("fact:a", "npc:1"),), extraction='{"factId":"fact:b","toNpcId":"npc:1","askKind":"x"}')
    assert engine["calls"] == [("trade", "fact:a", "npc:1")] and "auto-trade-secret" not in belts   # `declined` is the engine's answer, not a refusal


def test_a_model_trade_the_engine_took_still_stands_the_belt_down(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=_model("fact:a", "npc:1"), extraction='{"factId":"fact:b","toNpcId":"npc:1","askKind":"x"}')
    assert engine["calls"] == [("trade", "fact:a", "npc:1")] and engine["traded"] == [("fact:a", "npc:1")] and "auto-trade-secret" not in belts


def test_a_belt_trade_the_engine_refuses_again_is_not_counted(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=_model("fact:a", "npc:1"), spent=("fact:a",), unlearned=("fact:b",), extraction='{"factId":"fact:b","toNpcId":"npc:1","askKind":"x"}')
    assert engine["calls"] == [("trade", "fact:a", "npc:1"), ("trade", "fact:b", "npc:1")] and engine["traded"] == []
    assert "auto-trade-secret" not in belts   # success-gated: a typed refusal is never a fired belt


def test_with_no_model_call_the_belt_still_fires_once(monkeypatch):
    engine, belts = _go(monkeypatch, model_calls=[], extraction='{"factId":"fact:a","toNpcId":"npc:1","askKind":"a vote"}')
    assert engine["calls"] == [("trade", "fact:a", "npc:1")] and belts.count("auto-trade-secret") == 1
