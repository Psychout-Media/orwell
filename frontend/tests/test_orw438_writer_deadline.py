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


def test_a_fast_stream_cannot_outrun_the_consumer():
    """Review of #2752: an unbounded queue let a generator that never awaits run to completion before the consumer
    got a single chunk (and starved the deadline). The producer may run only a few chunks ahead."""
    produced = [0]

    async def firehose():
        for i in range(20000):
            produced[0] += 1
            yield i

    async def go():
        seen_ahead = []
        # ORW-983: close the wrapper ourselves. Breaking out of an `async for` leaves its `finally` (the pump's cancel) to the garbage collector, which can run it in a LATER test, after this
        # loop is closed: the pump is still blocked on its full queue of ("chunk", n) items, and "Event loop is closed" / "Queue ... is bound to a different event loop" surfaced in whichever test
        # was running then (test_orw566c_group_identity went red twice on main that way).
        stream = ca._bounded_stream(firehose(), wall_clock_s=5)
        try:
            async for _ in stream:
                seen_ahead.append(produced[0] - len(seen_ahead) - 1)
                if len(seen_ahead) >= 50:
                    break
        finally:
            await stream.aclose()
            await asyncio.sleep(0)  # let the cancelled pump finish inside this loop
        return max(seen_ahead)

    assert _run(go()) <= 8


def test_an_abandoned_stream_cannot_write_after_the_cancel():
    writes = []

    async def slow():
        try:
            for i in range(1000):
                await asyncio.sleep(0.01)
                yield i
        finally:
            writes.append("closed")

    async def go():
        async for c in ca._bounded_stream(slow(), wall_clock_s=0.05):
            pass

    try:
        _run(go())
    except ca.AuthoringDeadline:
        pass
    else:
        raise AssertionError("no deadline")
    n = len(writes)
    _run(asyncio.sleep(0.2))
    assert len(writes) <= n + 1  # the cancelled pump finished its cleanup once and produced nothing further


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
_GOOD = json.dumps({"biography": "Namea pours wine in Waco and he never misses a sunrise. Friends call him loyal, and his cellar is famous.",
                    "vocation": "sommelier", "physicalCharacteristics": _PC})
_NPC = {"id": "npc:1", "name": "Namea Surnamea", "genderPresentation": "man", "age": 30, "hometown": "Waco, Texas",
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
    other = {**_NPC, "id": "npc:2", "name": "Nameb Surnameb"}
    n, calls, writes, elapsed = _drive({1}, [_NPC, other], concurrency=1)
    assert n == 2
    # call 2 (the retry) and call 3 (the next houseguest) both started well before the stalled call's cleanup ended
    assert calls[2] - calls[0] < CLEANUP_S, calls
    assert elapsed < CLEANUP_S


# ---- what the player sees: decided by provenance, never by the text ----
DRAFT = "Runs compliance for a regional credit union and sings in a choir."


def test_the_draft_is_hidden_only_while_the_engine_marks_it_as_genesis_draft():
    card = {"id": "npc:3", "name": "Namec Surnamec", "authored": True, "biography": DRAFT, "biographyDraft": True,
            "vocation": "funeral service apprentice", "physicalCharacteristics": {"hair": "short"}}
    persona = R._public_persona(card)
    assert "biography" not in persona and persona["vocation"] == "funeral service apprentice"


def test_a_finished_card_shows_its_biography_whatever_it_says():
    for text in (DRAFT, "Loves puzzles.", "Spent a decade somewhere."):
        done = {"id": "npc:3", "name": "Namec Surnamec", "authored": True, "biography": text}  # marker cleared by the writer
        assert R._public_persona(done)["biography"] == text


def test_honorific_and_initial_names_and_legacy_cards_are_never_hidden():
    for name in ("Dr. Mara Voss", "J.T. Baker", "Alex Rowe"):
        legacy = {"id": "npc:3", "name": name, "authored": False, "biography": "Loves puzzles."}  # an older save: no marker
        assert R._public_persona(legacy)["biography"] == "Loves puzzles."
    assert ca.is_genesis_draft_biography({"biographyDraft": False, "biography": "x"}) is False


# ---- the gap: genesis draft + a writer that returns no biography must not leave the card hidden and un-retried ----
_NO_BIO = json.dumps({"vocation": "sommelier", "physicalCharacteristics": _PC})


def test_writer_omits_the_biography_once_the_card_is_retried_by_the_backfill_and_then_finishes():
    ca.reset_attempts("u438b")
    npc = {**_NPC, "biography": DRAFT, "biographyDraft": True, "authored": True, "identityConcept": "A calm wine person who hums."}
    replies = [_NO_BIO, _NO_BIO, _GOOD]  # first pass: the writer and its one strict retry both omit it; backfill pass: returns it
    writes = []

    async def llm_fn(messages):
        return replies.pop(0)

    async def write_fn(p):
        writes.append(p)
        return {"accepted": True}

    # pass 1: the draft is NOT a floor, so the card is not written as authored
    assert _run(ca.author_cast([dict(npc)], llm_fn, write_fn, user="u438b")) == 0 and writes == []
    assert not ca._has_floor_biography(npc)
    # the card still counts as unfinished, so the backfill takes it again (and the roster says so as a boolean)
    assert ca.unauthored_ids("u438b", [npc]) == ["npc:1"]
    assert ca.unauthored_ids("u438b", [{"id": "npc:1", "status": "active", "authored": True, "storyMissing": True}]) == ["npc:1"]
    # pass 2 (the backfill): the writer returns the biography and the card is written
    assert _run(ca.author_cast([dict(npc)], llm_fn, write_fn, user="u438b")) == 1
    assert "biography" in writes[0]
    finished = {**npc, "biography": writes[0]["biography"]}
    finished.pop("biographyDraft")  # the engine clears it when recordCastProfile lands the biography
    assert ca.unauthored_ids("u438b", [finished]) == [] or ca.card_missing_story(finished) is False
