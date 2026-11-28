"""ORW-1069 / ORW-1053: LLM-free table of the promise polarity and hedge reading, from the audit's own lines plus more. No model."""
import pytest

from src import agent_loop as al


@pytest.mark.parametrize("line,kind,want", [
    ("I am voting Lorenzo out, I swear", "vote", "vote-out"),
    ("I won't tell anyone. I'm voting Lorenzo out, I swear.", "vote", "vote-out"),
    ("I'll send Lorenzo home, you have my word", "vote", "vote-out"),
    ("I swear I'm putting Lorenzo up", "loyal", "nominate"),
    ("I'm going after Lorenzo, I promise", "loyal", "nominate"),
    ("I will vote to keep you if you win HOH", "vote", "conditional"),
    ("I'll keep you safe unless someone better comes along", "loyal", "conditional"),
    ("Assuming you don't put me up, you're safe", "loyal", "conditional"),
    ("I'll probably vote to keep you", "vote", "hedged"),
    ("Maybe I won't vote you out", "vote", "hedged"),
    ("I'll try to keep you safe", "loyal", "hedged"),
    ("Hopefully I can keep you off the block", "loyal", "hedged"),
    ("I will not vote you out, I swear", "vote", None),
    ("I've got your back, you have my vote", "vote", None),
    ("I won't put you up", "loyal", None),
    ("I would never nominate you", "loyal", None),
    ("I'm keeping you, I swear", "vote", None),
])
def test_polarity_and_hedge_table(line, kind, want):
    assert al._promise_words_unfit(line, kind) == want


def test_scene_extraction_drops_a_mislabelled_vote_out_promise_but_keeps_the_scene(monkeypatch):
    import asyncio
    import src.llm_core as lc
    import src.orwell_engine as oe
    recorded = []

    async def fake_llm(*a, **k):
        return ('{"withIds":["npc:1"],"kind":"strategy","content":"The player swore to vote Contestant Alpha out.",'
                '"promise":{"what":"no-evict-vote","subject":"npc:1"}}')

    async def fake_wb(*a, **k):
        return {"present": [{"id": "npc:1"}]}

    async def fake_record(*a, **k):
        recorded.append(k)
        return {"ok": True}

    monkeypatch.setattr(lc, "llm_call_async", fake_llm)
    monkeypatch.setattr(oe, "whereabouts", fake_wb)
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    monkeypatch.setattr(al, "_backfill_with_cas", lambda owner, fn, *a, **k: fn(*a, **k))
    house = [{"id": "npc:1", "name": "Contestant Alpha"}]
    asyncio.new_event_loop().run_until_complete(
        al._auto_record_scene("They talk.", "I am voting Alpha out, I swear", house, "u", "m", {}, "u"))
    assert recorded and "promise" not in recorded[0]
