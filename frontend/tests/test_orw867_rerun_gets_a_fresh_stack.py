"""ORW-867: a rerun of a test that uses a module-scoped stack fixture gets a FRESH stack (the conftest hook), so a first attempt that consumed the stack's state cannot make the rerun fail by construction.

A stand-in `_stack` fixture counts how many times it was built; the first attempt consumes it and fails; the rerun must see a new one. Roles only; no real stack is booted."""
from __future__ import annotations

import pytest

BUILDS = []


@pytest.fixture(scope="module")
def _stack():
    s = {"n": len(BUILDS) + 1, "consumed": False}
    BUILDS.append(s)
    yield s


@pytest.mark.flaky(reruns=1)
def test_a_rerun_boots_a_new_stack_when_the_first_attempt_consumed_the_old_one(_stack):
    if len(BUILDS) == 1:
        # first attempt: consume the shared stack's state, then fail (the hidden first failure)
        _stack["consumed"] = True
        raise AssertionError("first attempt fails after consuming the stack")
    assert len(BUILDS) == 2, "the rerun must have built exactly one new stack"
    assert _stack["consumed"] is False and _stack is BUILDS[1], "the rerun saw the first attempt's consumed stack"
