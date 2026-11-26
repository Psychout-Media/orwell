"""ORW-1025: cast-authoring and photo-check degrades are counted (record_soft_failure, RED on /admin/status),
and the authoring output cap starts above the size that forced a doubled retry on every cast."""
import asyncio

import pytest

from src import log_rings
from src import orwell_portrait_check as C
from src import token_policy as tp


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture
def seen(monkeypatch):
    got = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **kw: got.append((cls, str(exc), kw)))
    return got


def test_background_authoring_cap_is_above_the_3000_that_hit_length():
    assert tp.resolve_token_policy("background-authoring", {})["max_tokens"] >= 6000


def test_portrait_check_skip_is_counted_with_the_exception_class(monkeypatch, seen):
    import src.orwell_portraits as P
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(C, "check_enabled", lambda u: True)

    async def boom(*a, **k):
        raise asyncio.TimeoutError()

    monkeypatch.setattr(C, "_call", boom)
    assert _run(C.check_portrait(b"png", {}, "u")) is None
    assert [c for c, _, _ in seen] == ["portrait-check:skipped"]
    assert "TimeoutError" in seen[0][1]


def test_unverified_photo_is_counted(monkeypatch, seen):
    import src.orwell_portraits as P
    monkeypatch.setattr(C, "facts_from_prompt", lambda p: {})
    monkeypatch.setattr(C, "has_border", lambda png: False)
    monkeypatch.setattr(C, "check_enabled", lambda u: True)
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)

    async def none(*a, **k):
        return None

    monkeypatch.setattr(C, "check_portrait", none)
    png, meta = _run(P._portrait_check_pass(b"png", "prompt", "u", None))
    assert meta == {"unverified": True}
    assert [c for c, _, _ in seen] == ["portraits:photo-unverified"]
