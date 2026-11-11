"""ORW-223 slice 1: the FE half of the room-canon write-back (canon ledger v1, house map only).

The extraction is injectable, so no live model is needed. Pins: exactly {roomId, feature} is sent, over-long / non-string /
duplicate features are dropped before the engine ever sees them, a failing model or engine is silent, and the engine wrapper
dispatches the registered tool name."""
import asyncio

from src import orwell_room_canon as rc

LONG = "The kitchen light buzzed over the island while someone hummed and the fridge door swung open and closed again."


def run(coro):
    return asyncio.run(coro)


def test_clean_features_bounds():
    out = rc.clean_features({"features": ["  a chipped\nmug  ", "a chipped mug", "x" * 121, 7, "", "a faded blanket", "a third thing"]})
    assert out == ["a chipped mug", "a faded blanket"]  # normalized, de-duplicated, over-long dropped, capped at 2
    assert rc.clean_features(None) == [] and rc.clean_features({"features": "nope"}) == []


def test_writes_exactly_room_and_feature():
    sent = []

    async def llm(_m):
        return 'thinking... {"features":["a chipped mug on the ledge"]}'

    async def write(p):
        sent.append(p)
        return {"accepted": True, "entryId": "canon:1"}

    assert run(rc.capture_room_canon(LONG, "kitchen", llm, write)) == 1
    assert sent == [{"roomId": "kitchen", "feature": "a chipped mug on the ledge"}]


def test_skips_short_narration_missing_room_and_empty_extraction():
    calls = []

    async def llm(_m):
        calls.append(1)
        return '{"features":[]}'

    async def write(_p):
        raise AssertionError("must not write")

    assert run(rc.capture_room_canon("short", "kitchen", llm, write)) == 0 and not calls
    assert run(rc.capture_room_canon(LONG, None, llm, write)) == 0 and not calls
    assert run(rc.capture_room_canon(LONG, "kitchen", llm, write)) == 0 and calls


def test_failures_are_silent_and_refusals_are_not_counted():
    async def boom(_m):
        raise RuntimeError("model down")

    async def never(_p):
        raise AssertionError("must not write")

    assert run(rc.capture_room_canon(LONG, "kitchen", boom, never)) == 0

    async def llm(_m):
        return '{"features":["a hidden hatch"]}'

    async def refuse(_p):
        return {"accepted": False, "reason": "lexicon"}

    assert run(rc.capture_room_canon(LONG, "kitchen", llm, refuse)) == 0

    async def broken(_p):
        raise RuntimeError("engine down")

    assert run(rc.capture_room_canon(LONG, "kitchen", llm, broken)) == 0


def test_engine_wrapper_dispatches_the_registered_tool(monkeypatch):
    from src import orwell_engine as oe
    seen = {}

    async def fake_call(tool, args, user=None):
        seen.update(tool=tool, args=args, user=user)
        return {"accepted": True}

    monkeypatch.setattr(oe, "_call", fake_call)
    assert run(oe.record_room_canon("kitchen", "a chipped mug", user="u")) == {"accepted": True}
    assert seen == {"tool": "recordRoomCanon", "args": {"roomId": "kitchen", "feature": "a chipped mug"}, "user": "u"}
