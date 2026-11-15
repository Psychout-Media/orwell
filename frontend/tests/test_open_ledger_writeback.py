"""ORW-407 slice 1: the FE half of the open-ledger write-back. The extraction is injectable (no live model). Pins: exactly
{text, speaker, addressedTo, kind} is sent, ids outside the present list / entries not involving the player / over-long
text are dropped before the engine sees them, `kind` stays free text, failures are silent, and the engine wrapper
dispatches the registered tool name."""
import asyncio

from src import orwell_open_ledger as ol

NARR = "In the kitchen, a houseguest leans in and says she will never put the player on the block, then laughs it off over coffee."
PRESENT = [{"id": "npc:3", "name": "Someone"}]


def run(coro):
    return asyncio.run(coro)


def test_clean_entries_bounds_and_free_kind():
    raw = {"entries": [
        {"text": ' "I will keep you safe" ', "speaker": "npc:3", "addressedTo": ["player"], "kind": "  an oath of loyalty  "},
        {"text": "i will keep you safe", "speaker": "npc:3", "addressedTo": ["player"], "kind": "dup"},
        {"text": "x" * 241, "speaker": "npc:3", "addressedTo": ["player"], "kind": "long"},
        {"text": "who is that", "speaker": "npc:9", "addressedTo": ["player"], "kind": "unknown id"},
        {"text": "npc to npc", "speaker": "npc:3", "addressedTo": ["npc:3"], "kind": "k"},
        {"text": "not the player", "speaker": "npc:3", "addressedTo": [], "kind": "k"},
        {"text": "c", "speaker": "player", "addressedTo": ["npc:3"], "kind": ""},
        {"text": "d", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"},
    ]}
    out = ol.clean_entries(raw, {"npc:3"})
    assert out == [
        {"text": "I will keep you safe", "speaker": "npc:3", "addressedTo": ["player"], "kind": "an oath of loyalty"},
        {"text": "c", "speaker": "player", "addressedTo": ["npc:3"], "kind": "claim"},
    ]  # capped at 2, kind is whatever the model said
    assert ol.clean_entries(None, {"npc:3"}) == [] and ol.clean_entries({"entries": "no"}, {"npc:3"}) == []


def test_writes_exactly_four_fields():
    sent = []

    async def llm(_m):
        return 'hmm {"entries":[{"text":"I will never vote you out","speaker":"npc:3","addressedTo":["player"],"kind":"promise"}]}'

    async def write(p):
        sent.append(p)
        return {"accepted": True, "entryId": "open:1"}

    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, write)) == 1
    assert sent == [{"text": "I will never vote you out", "speaker": "npc:3", "addressedTo": ["player"], "kind": "promise"}]
    assert set(sent[0]) == {"text", "speaker", "addressedTo", "kind"}


def test_skips_short_narration_empty_room_and_empty_extraction():
    calls = []

    async def llm(_m):
        calls.append(1)
        return '{"entries":[]}'

    async def write(_p):
        raise AssertionError("must not write")

    assert run(ol.capture_open_ledger("short", PRESENT, llm, write)) == 0 and not calls
    assert run(ol.capture_open_ledger(NARR, [], llm, write)) == 0 and not calls
    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, write)) == 0 and calls


def test_failures_are_silent_and_refusals_not_counted():
    async def boom(_m):
        raise RuntimeError("model down")

    async def never(_p):
        raise AssertionError("must not write")

    assert run(ol.capture_open_ledger(NARR, PRESENT, boom, never)) == 0

    async def llm(_m):
        return '{"entries":[{"text":"a","speaker":"player","addressedTo":["npc:3"],"kind":"k"}]}'

    async def refuse(_p):
        return {"accepted": False, "reason": "not-present"}

    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, refuse)) == 0

    async def broken(_p):
        raise RuntimeError("engine down")

    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, broken)) == 0


def test_engine_wrapper_dispatches_the_registered_tool(monkeypatch):
    from src import orwell_engine as oe
    seen = {}

    async def fake_call(tool, args, user=None):
        seen.update(tool=tool, args=args, user=user)
        return {"accepted": True}

    monkeypatch.setattr(oe, "_call", fake_call)
    entry = {"text": "t", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k", "junk": 1}
    assert run(oe.record_open_ledger(entry, user="u")) == {"accepted": True}
    assert seen == {"tool": "recordOpenLedger", "args": {"text": "t", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"}, "user": "u"}
