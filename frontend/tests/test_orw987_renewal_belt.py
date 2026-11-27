"""ORW-987: an ally's spoken renewal of a deal that ran out was never recorded, so the player ended the week with no live deal.

The deal back-fill belt (0039) is the same error correction: it now also fires on renewal language, and its extraction counts a renewal both sides agree to as a deal struck now. The engine still decides
(makeDeal), and the model-driven call keeps precedence. Roles only.
"""
import pytest

from src import agent_loop as al


@pytest.mark.parametrize("line", [
    "We're still good, you and me.",
    "Same deal next week?",
    "Our deal still stands, right?",
    "I want to renew it for this week.",
    "Let's re-up before nominations.",
    "Same as last week: you keep me, I keep you.",
])
def test_renewal_language_wakes_the_deal_belt(line):
    assert al._DEAL_SIGNAL_RE.search(line), line


@pytest.mark.parametrize("line", [
    "The kitchen is still a mess.",
    "I slept the same as ever.",
    "He sat down with the same face as always.",
])
def test_ordinary_talk_does_not(line):
    assert not al._DEAL_SIGNAL_RE.search(line), line


def test_the_extraction_is_told_a_renewal_counts():
    import inspect
    src = inspect.getsource(al._auto_record_deal)
    assert "RENEWAL" in src and "struck now" in src


# ── telemetry: a renewal the extraction flags is reported on its own, only when the engine applied the deal ──
import asyncio  # noqa: E402
import importlib  # noqa: E402

importlib.import_module("src.agent_tools")  # prime the agent_tools <-> tool_schemas import cycle
import src.orwell_engine as oe  # noqa: E402
import src.llm_core as llm_core  # noqa: E402

_HOUSE = [{"id": "npc:3", "name": "Role A"}, {"id": "npc:7", "name": "Role B"}]


def _belt(monkeypatch, extraction, engine_reply):
    calls = []

    async def _post(path, name, args, user, timeout=None):
        calls.append((name, args))
        return engine_reply

    async def fake_llm(*a, **k):
        return extraction

    monkeypatch.setattr(oe, "_post_tool", _post)
    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    return calls


def _run_belt(narration="We're still good, you and me, same deal this week."):
    applied, renewed = [], []
    out = asyncio.new_event_loop().run_until_complete(
        al._auto_record_deal(narration, "same deal again?", _HOUSE, "url", "m", {}, "owner", applied_out=applied, renewed_out=renewed))
    return out, applied, renewed


_ACCEPTED = {"id": "deal:1", "kind": "safety", "terms": "t", "status": "open", "parties": []}


def test_an_applied_renewal_is_reported_as_a_renewal(monkeypatch):
    calls = _belt(monkeypatch, '{"deals":[{"withId":"npc:3","kind":"safety","terms":"the same protection again","renewal":true}]}', _ACCEPTED)
    out, applied, renewed = _run_belt()
    assert out is True and applied == ["npc:3"] and renewed == ["npc:3"]
    assert [c[0] for c in calls].count("makeDeal") == 1   # recorded through the engine, terms as spoken


def test_a_new_deal_is_not_reported_as_a_renewal(monkeypatch):
    _belt(monkeypatch, '{"deals":[{"withId":"npc:3","kind":"safety","terms":"neither nominates the other","renewal":false}]}', _ACCEPTED)
    out, applied, renewed = _run_belt()
    assert out is True and applied == ["npc:3"] and renewed == []


def test_a_refused_renewal_counts_nothing(monkeypatch):
    _belt(monkeypatch, '{"deals":[{"withId":"npc:3","kind":"safety","terms":"the same protection again","renewal":true}]}',
          {"refused": True, "reason": "didnt-trust-you"})
    out, applied, renewed = _run_belt()
    assert out is False and applied == [] and renewed == []
