"""ORW-480: when the interview-time warm failed (an outage), the create-time belt runs the identity step again so genders, heritages and ages cohere with the names."""
import asyncio
import importlib
import pathlib

I = importlib.import_module("src.orwell_cast_identity")


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_the_belt_runs_identity_when_none_is_applied_and_not_twice():
    I._APPLIED.clear()
    calls = []

    async def run(cast, owner, seed=None):
        calls.append(seed)
        I._APPLIED[str(owner)] = seed
        return 3

    assert _run(I.ensure_identity([{"id": "npc:1"}], "u", 7, run=run)) == 3
    assert _run(I.ensure_identity([{"id": "npc:1"}], "u", 7, run=run)) == 0
    assert calls == [7]
    assert _run(I.ensure_identity([{"id": "npc:1"}], "u", 8, run=run)) == 3   # a new season's seed runs again


def test_a_failing_identity_never_raises():
    I._APPLIED.clear()

    async def boom(cast, owner, seed=None):
        raise RuntimeError("402")

    assert _run(I.ensure_identity([{"id": "npc:1"}], "u", 1, run=boom)) == 0


def test_create_character_calls_the_belt_after_genesis():
    src = (pathlib.Path(__file__).resolve().parent.parent / "src" / "tool_implementations.py").read_text(encoding="utf-8")
    assert src.index("_genesis_kick.run_genesis(") < src.index("_identity_belt.ensure_identity(")
