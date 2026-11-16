"""ORW-260: the cast-authoring lane (the deeper backstories, 0058) latches a strict failure like the cast skeleton does. Mutation-checked by hand: drop the mark_strict_failed calls and these go red."""
import asyncio

from src import orwell_cast_authoring as A
from src import enrichment_policy as ep


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


async def _bad_llm(*a, **k):
    return "not json at all"


async def _noop_write(profile):
    return {"ok": True}


def test_a_run_that_leaves_a_houseguest_on_the_floor_latches_under_strict(monkeypatch):
    monkeypatch.setattr(ep, "is_strict", lambda: True)
    A.clear_strict_failed("u-a")
    cast = [{"id": "npc:1", "name": "Role One"}]
    _run(A.author_cast(cast, _bad_llm, _noop_write, user="u-a"))
    assert A.strict_failed("u-a") is True


def test_soft_policy_keeps_the_legacy_silent_floor(monkeypatch):
    monkeypatch.setattr(ep, "is_strict", lambda: False)
    A.clear_strict_failed("u-b")
    _run(A.author_cast([{"id": "npc:1", "name": "Role One"}], _bad_llm, _noop_write, user="u-b"))
    assert A.strict_failed("u-b") is False


def test_no_model_under_strict_latches_and_a_fresh_run_re_evaluates(monkeypatch):
    monkeypatch.setattr(ep, "is_strict", lambda: True)

    async def _none(_owner):
        return None
    monkeypatch.setattr(A, "resolve_authoring_llm_fn", _none)
    A.clear_strict_failed("u-c")
    assert _run(A.run_authoring([{"id": "npc:1"}], "u-c")) == 0
    assert A.strict_failed("u-c") is True
    A.mark_strict_failed("u-d")
    _run(A.run_authoring([{"id": "npc:1"}], "u-d"))  # still no model: stays latched (re-evaluated, not stuck-cleared)
    assert A.strict_failed("u-d") is True


def test_latch_is_per_owner_and_cleared_by_the_new_season_scrub():
    A.mark_strict_failed("u-e")
    assert A.strict_failed("u-e") and not A.strict_failed("u-other")
    from src import orwell_prewarm
    orwell_prewarm.reset_user_season("u-e")
    assert A.strict_failed("u-e") is False


def test_review_2375_an_old_run_failing_after_a_season_reset_does_not_latch_the_new_cast(monkeypatch):
    """A slow run from the previous season fails after the new season began: its failure must not latch the flag against the new cast."""
    monkeypatch.setattr(ep, "is_strict", lambda: True)
    release = asyncio.Event()

    async def _slow_bad(*a, **k):
        await release.wait()
        return "not json at all"

    # drive through the real run id handling: begin a run, reset the season, then let the old run fail
    A.begin_authoring_run("u-stale")
    old_ctx_id = A._RUN_ID.get()

    async def old_run():
        A._RUN_ID.set(old_ctx_id)
        await A.author_cast([{"id": "npc:1", "name": "Role One"}], _slow_bad, _noop_write, user="u-stale")

    async def main():
        task = asyncio.ensure_future(old_run())
        await asyncio.sleep(0)
        A.clear_strict_failed("u-stale")  # the new season scrub (reset_user_season)
        release.set()
        await task
    asyncio.get_event_loop().run_until_complete(main())
    assert A.strict_failed("u-stale") is False
    # a run that is still current keeps its loud failure
    A.begin_authoring_run("u-stale")
    release.set()
    _run(A.author_cast([{"id": "npc:1", "name": "Role One"}], _slow_bad, _noop_write, user="u-stale"))
    assert A.strict_failed("u-stale") is True
