"""ORW-167 slice 1: a game turn that changed the game through an engine tool sends exactly ONE game-updated ping at turn end; a read-only turn or a non-game turn sends none. No model."""
import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")
ogs = importlib.import_module("src.orwell_game_session")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _drive(monkeypatch, tools, game_mode=True, owner="ping-user"):
    pings = []
    monkeypatch.setattr(ogs, "publish_game_updated", lambda u: pings.append(u))

    async def fake_inner(name, args=None, user=None, timeout=None):
        return {}
    monkeypatch.setattr(oe, "_call_inner", fake_inner)

    async def fake_impl(*a, **k):
        for t in tools:
            await oe._call(t, {}, user=owner)
            yield "data: {}\n\n"
    monkeypatch.setattr(al, "_stream_agent_loop_impl", fake_impl)

    async def go():
        return [e async for e in al.stream_agent_loop("u", "m", [], owner=owner, game_mode=game_mode)]
    _run(go())
    return pings


def test_a_mutating_game_turn_pings_exactly_once(monkeypatch):
    assert _drive(monkeypatch, ["recordInteraction", "moveTo", "advanceGame"]) == ["ping-user"]


def test_a_read_only_game_turn_sends_no_ping(monkeypatch):
    assert _drive(monkeypatch, ["getGameState", "whereabouts"]) == []


def test_a_non_game_turn_sends_no_ping(monkeypatch):
    assert _drive(monkeypatch, ["advanceGame"], game_mode=False) == []
