"""ORW-292: a bare progress prompt on a turn where the board advanced skips the in-loop scene
extraction (one utility call saved); real talk, or a board that did not move, still extracts."""
import asyncio
import pytest


def _setup(monkeypatch, beat_now):
    from routes import chat_helpers as ch
    monkeypatch.setattr(ch, "last_beat_seq", lambda owner: beat_now)


@pytest.mark.parametrize("msg,before,now,skip", [
    ("next", 5, 6, True),                       # progress-only + board advanced -> skip
    ("continue", 5, 5, False),                  # board did not move -> still extracts
    ("next", None, 6, False),                   # no baseline -> fail-open
    ("let's go, I want to tell Maeve she is the real threat", 5, 6, False),  # real talk -> scene
    ("I nominate them", 5, 6, False),
])
def test_gate(monkeypatch, msg, before, now, skip):
    from src.agent_loop import _progress_only_board_advanced
    _setup(monkeypatch, now)
    assert _progress_only_board_advanced("u", msg, before) is skip


def test_extraction_calls_per_turn_before_after(monkeypatch):
    """Count utility calls with a fake llm_call_async: the gate saves the _auto_record_scene call."""
    from src.agent_loop import _progress_only_board_advanced
    _setup(monkeypatch, 6)
    calls = []

    async def fake_call(*a, **k):
        calls.append(k.get("call_class"))
        return '{"withIds":[]}'

    async def turn(msg, gated):
        # the in-loop belt site: gate -> one extraction call
        if not (gated and _progress_only_board_advanced("u", msg, 5)):
            await fake_call(call_class="utility-extraction")

    async def run():
        for m in ["next"] * 10:
            await turn(m, gated=False)
        before = len(calls)
        calls.clear()
        for m in ["next"] * 10:
            await turn(m, gated=True)
        return before, len(calls)

    before, after = asyncio.new_event_loop().run_until_complete(run())
    assert (before, after) == (10, 0)


def test_call_site_is_gated():
    import inspect, src.agent_loop as al
    src = inspect.getsource(al)
    assert "not _progress_only_board_advanced(" in src
