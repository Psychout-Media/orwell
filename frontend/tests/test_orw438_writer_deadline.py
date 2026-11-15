"""ORW-438: the writer's wall-clock ceiling is a hard deadline, one stalled call retries once, and a card the writer has
not finished never shows genesis's nameless first draft. Stub writers only; no model call."""
import asyncio
import json
import time

from conftest import _run

from src import orwell_cast_authoring as ca
from routes import orwell_routes as R

CEILING = 0.3
CLEANUP_S = 2.0  # a stalled TLS close: cleanup after the cancel takes this long


async def _stalls_forever_with_slow_cleanup():
    try:
        await asyncio.sleep(3600)
        yield "never"
    finally:
        try:
            await asyncio.sleep(CLEANUP_S)
        except BaseException:
            await asyncio.sleep(CLEANUP_S)


def test_ceiling_releases_the_caller_at_the_ceiling_not_after_the_cleanup():
    async def go():
        t0 = time.monotonic()
        try:
            async for _ in ca._bounded_stream(_stalls_forever_with_slow_cleanup(), wall_clock_s=CEILING):
                pass
        except ca.AuthoringDeadline as e:
            assert "wall-clock ceiling" in str(e)
            return time.monotonic() - t0
        raise AssertionError("no deadline raised")

    elapsed = _run(go())
    assert CEILING <= elapsed < CEILING + 0.5, elapsed  # the old wrapper waited ~CLEANUP_S longer (see the PR timings)


def test_a_fast_stream_is_unchanged_and_a_provider_error_still_surfaces():
    async def ok():
        for c in ("a", "b"):
            yield c

    async def boom():
        yield "a"
        raise RuntimeError("provider down")

    async def collect(g):
        return [c async for c in ca._bounded_stream(g, wall_clock_s=5)]

    assert _run(collect(ok())) == ["a", "b"]
    try:
        _run(collect(boom()))
    except RuntimeError as e:
        assert "provider down" in str(e)
    else:
        raise AssertionError("error swallowed")


_PC = {"heightBuild": "lean", "skinTone": "tan", "hair": "short brown hair", "facialFeatures": "a square jaw",
       "distinguishingMark": "none notable", "ageLook": "thirties", "style": "plain"}
_GOOD = json.dumps({"biography": "Liam pours wine in Waco and he never misses a sunrise. Friends call him loyal, and his cellar is famous.",
                    "vocation": "sommelier", "physicalCharacteristics": _PC})
_NPC = {"id": "npc:1", "name": "Liam Colvin", "genderPresentation": "man", "age": 30, "hometown": "Waco, Texas",
        "vocation": "sommelier", "biography": "A seeded floor biography that the engine keeps when the writer omits its own.",
        "physicalCharacteristics": _PC}


def _drive(stalls, npcs, concurrency=1):
    calls, writes = [], []

    async def llm_fn(messages):
        calls.append(time.monotonic())
        if len(calls) in stalls:
            async for _ in ca._bounded_stream(_stalls_forever_with_slow_cleanup(), wall_clock_s=CEILING):
                pass
        return _GOOD

    async def write_fn(p):
        writes.append(p)
        return {"accepted": True}

    t0 = time.monotonic()
    n = _run(ca.author_cast([dict(x) for x in npcs], llm_fn, write_fn, concurrency=concurrency, user="u438"))
    return n, calls, writes, time.monotonic() - t0


def test_one_stalled_call_retries_once_on_a_fresh_request_and_the_card_is_written():
    ca.reset_attempts("u438")
    n, calls, writes, elapsed = _drive({1}, [_NPC])
    assert n == 1 and len(calls) == 2 and len(writes) == 1
    assert ca.attempts_spent("u438")["npc:1"] == 2  # both calls spent from the per-houseguest budget
    assert elapsed < CEILING + 1.0, elapsed


def test_two_stalls_fall_to_the_floor_after_exactly_one_retry():
    ca.reset_attempts("u438")
    n, calls, writes, _ = _drive({1, 2}, [_NPC])
    assert n == 0 and len(calls) == 2 and writes == []


def test_the_authoring_slot_is_free_at_the_ceiling_so_the_next_houseguest_starts_then():
    ca.reset_attempts("u438")
    other = {**_NPC, "id": "npc:2", "name": "Ada Rowe"}
    n, calls, writes, elapsed = _drive({1}, [_NPC, other], concurrency=1)
    assert n == 2
    # call 2 (the retry) and call 3 (the next houseguest) both started well before the stalled call's cleanup ended
    assert calls[2] - calls[0] < CLEANUP_S, calls
    assert elapsed < CLEANUP_S


# ---- what the player sees ----
def test_a_card_the_writer_has_not_finished_hides_genesis_nameless_first_draft():
    card = {"id": "npc:3", "name": "Samir Nesbitt", "authored": True,
            "biography": "Runs compliance for a regional credit union and sings in a choir.",
            "identityConcept": "A soft-spoken apprentice.", "vocation": "funeral service apprentice",
            "physicalCharacteristics": {"hair": "short"}}
    persona = R._public_persona(card)
    assert "biography" not in persona and persona["vocation"] == "funeral service apprentice"


def test_a_finished_card_and_a_named_biography_are_shown():
    pc = {"hair": "short", "wardrobe": ["a", "b"], "onCamera": "kitchen", "photoHair": "short"}
    done = {"id": "npc:3", "name": "Samir Nesbitt", "authored": True, "biography": "Runs compliance for a credit union.", "physicalCharacteristics": pc}
    assert R._public_persona(done)["biography"].startswith("Runs compliance")
    named = {"id": "npc:3", "name": "Samir Nesbitt", "authored": False, "biography": "Samir grew up in Converse. He sings."}
    assert "biography" in R._public_persona(named)
