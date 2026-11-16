"""0155 / ORW-330 slice 6 - the open ledger as the safety net: a claim the narration makes about houseguests carries its structured form
{kind, subject, object?} to the engine, which gives it its truth and plants the listeners' beliefs. Roles only (npc:N ids)."""
import asyncio

from src import orwell_open_ledger as ol
from src import orwell_engine as oe

KNOWN = {"npc:1": "Speaker", "npc:2": "Listener", "npc:3": "Subject", "npc:4": "Third"}
ALLOWED = {"npc:1", "npc:2", "npc:3"}


def _one(claim):
    raw = {"entries": [{"text": "they are coming for you", "speaker": "npc:1", "addressedTo": ["npc:2"], "kind": "claim", "about": "npc:3", "claim": claim}]}
    return ol.clean_entries(raw, ALLOWED, KNOWN)[0]


def test_a_well_formed_claim_rides_with_the_entry_and_names_resolve_to_ids():
    assert _one({"kind": "targets-you", "subject": "npc:3"})["claim"] == {"kind": "targets-you", "subject": "npc:3"}
    assert _one({"kind": "voted-against", "subject": "Subject", "object": "Third"})["claim"] == {"kind": "voted-against", "subject": "npc:3", "object": "npc:4"}


def test_a_claim_the_engine_would_not_understand_is_dropped_but_the_entry_stays():
    for bad in [{"kind": "is-a-wizard", "subject": "npc:3"}, {"kind": "targets-you", "subject": "nobody"}, {"kind": "going-after", "subject": "npc:3"},
                {"kind": "going-after", "subject": "npc:3", "object": "npc:3"}, "targets-you", None]:
        e = _one(bad)
        assert "claim" not in e, bad
        assert e["text"] == "they are coming for you"


def test_the_write_back_sends_the_claim_only_when_there_is_one(monkeypatch):
    sent = []

    async def fake_call(name, args, user=None):
        sent.append((name, args))
        return {"accepted": True}

    monkeypatch.setattr(oe, "_call", fake_call)
    base = {"text": "t", "speaker": "npc:1", "addressedTo": ["npc:2"], "kind": "claim"}
    asyncio.run(oe.record_open_ledger(dict(base)))
    asyncio.run(oe.record_open_ledger({**base, "claim": {"kind": "targets-you", "subject": "npc:3"}}))
    assert "claim" not in sent[0][1]
    assert sent[1][1]["claim"] == {"kind": "targets-you", "subject": "npc:3"}


def test_the_claim_set_matches_the_engine():
    src = open("../src/engine/spokenClaims.ts", encoding="utf-8").read()
    for k in ol.CLAIM_KINDS:
        assert f'"{k}",' in src, k
