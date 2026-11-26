"""ORW-750 part 1: the player asks for a private word, the houseguest agrees on screen, and the model never calls askToTalkAlone, so nothing moves. The belt calls the lever; the engine decides.
BEHAVIOURAL: the real agent loop with a scripted model; the extraction and the engine are stubbed. Roles only.
"""
import pytest

from src import agent_loop as al
from test_orw310_bedtime_belt import _drive


def _run(monkeypatch, text, extract, calls=None, outcome="accepted"):
    asked, belts_seen = [], {}
    from src import orwell_engine as oe

    async def fake_ask(npc, room=None, private=None, *a, **k):
        asked.append((npc, private))
        return {"outcome": outcome, "beatSeq": 5}

    async def fake_state(user=None, **k):
        return {"started": True, "phase": "social", "house": [{"id": "npc:1", "name": "Ana Reed", "status": "active"}]}

    async def fake_belt_llm(**kw):
        return extract

    monkeypatch.setattr(oe, "ask_to_talk_alone", fake_ask)
    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(al, "_belt_llm", fake_belt_llm)
    _, belts, _, _ = _drive(monkeypatch, text=text, scripts=[{"deltas": ["Ana nods. \"Sure, follow me.\""], **({"calls": calls} if calls else {})}, {"deltas": ["They step out."]}],
                            status={"started": True, "phase": "social", "timeOfDay": "evening", "pending": None})
    return asked, belts


def test_an_agreed_private_word_calls_the_lever(monkeypatch):
    asked, belts = _run(monkeypatch, "Ana, can we talk alone for a minute?", '{"agreed": true, "npc": "npc:1", "private": true}')
    assert asked == [("npc:1", True)] and belts.get("auto-talk-alone") == 1


@pytest.mark.parametrize("extract", ['{"agreed": false, "npc": null}', '{"agreed": true, "npc": "npc:9"}'])
def test_no_agreement_or_an_unknown_houseguest_calls_nothing(monkeypatch, extract):
    asked, belts = _run(monkeypatch, "Can we talk alone?", extract)
    assert asked == [] and "auto-talk-alone" not in belts


def test_an_engine_refusal_counts_no_belt(monkeypatch):
    asked, belts = _run(monkeypatch, "Can we talk in private?", '{"agreed": true, "npc": "npc:1"}', outcome="declined")
    assert asked and "auto-talk-alone" not in belts


def test_ordinary_talk_does_not_wake_it(monkeypatch):
    asked, _ = _run(monkeypatch, "Good morning, everyone.", '{"agreed": true, "npc": "npc:1"}')
    assert asked == []
