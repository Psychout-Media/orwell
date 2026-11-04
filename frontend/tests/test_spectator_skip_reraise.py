"""E-1 (2026-11-04): a WATCHING pre-jury evictee must be able to switch to SKIP. The model cannot commit the card-only spectator-choice, so a skip request
re-raises the SAME card (engine `raiseSpectatorChoice`) and the player confirms ON the card. Three seams: the intent belt (their words), the route (the visible
"Skip ahead to the finale" control), and the engine wrapper. Roles only."""
import asyncio

import pytest

from routes import chat_helpers as ch
from src import orwell_engine as oe


@pytest.mark.parametrize("msg", [
    "skip ahead to the finale", "I want to skip ahead", "Actually, I changed my mind: skip ahead to the finale. Submit my spectator choice as skip.",
    "just skip to the end", "fast forward to the finale", "fast-forward", "jump ahead to the finale", "take me straight to the finale",
    "show me how it ends", "let me see how it ends", "skip the rest", "skip it all",
])
def test_a_skip_request_is_recognised(msg):
    assert ch._player_wants_to_skip_ahead(msg) is True, msg


@pytest.mark.parametrize("msg", [
    "", "hi", "what happened this week?", "keep watching", "I'll keep watching", "who won the veto?", "continue", "advance",
    "I tell Role A to skip the argument and talk to Role B", "skip a rock across the pool",
])
def test_ordinary_messages_are_not_a_skip_request(msg):
    assert ch._player_wants_to_skip_ahead(msg) is False, msg


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_the_belt_raises_the_card_for_a_watching_evictee_who_asks_to_skip(monkeypatch):
    calls = []

    async def fake_raise(user=None, **kw):
        calls.append(user)
        return {"pending": {"kind": "spectator-choice"}}

    monkeypatch.setattr(oe, "raise_spectator_choice", fake_raise)
    gs = {"started": True, "phase": "hoh-competition", "pending": None, "player": {"status": "evicted", "spectator": "watch"}}
    assert _run(ch.maybe_raise_spectator_choice("u", gs, "skip ahead to the finale")) is True
    assert calls == ["u"]


@pytest.mark.parametrize("gs,msg", [
    ({"started": True, "pending": None, "player": {"status": "evicted", "spectator": "skip"}}, "skip ahead"),        # already skipping (irreversible)
    ({"started": True, "pending": None, "player": {"status": "active"}}, "skip ahead"),                              # an active player
    ({"started": True, "pending": {"kind": "spectator-choice"}, "player": {"status": "evicted", "spectator": "watch"}}, "skip ahead"),  # card already open
    ({"started": True, "pending": None, "player": {"status": "evicted", "spectator": "watch"}}, "keep watching"),    # no skip intent
])
def test_the_belt_never_fires_when_it_should_not(monkeypatch, gs, msg):
    calls = []

    async def fake_raise(user=None, **kw):
        calls.append(user)
        return {}

    monkeypatch.setattr(oe, "raise_spectator_choice", fake_raise)
    assert _run(ch.maybe_raise_spectator_choice("u", gs, msg)) is False
    assert calls == []


def test_the_belt_is_fail_soft(monkeypatch):
    async def boom(user=None, **kw):
        raise RuntimeError("engine down")

    monkeypatch.setattr(oe, "raise_spectator_choice", boom)
    gs = {"started": True, "pending": None, "player": {"status": "evicted", "spectator": "watch"}}
    assert _run(ch.maybe_raise_spectator_choice("u", gs, "skip ahead")) is False


def test_the_engine_wrapper_calls_the_right_tool(monkeypatch):
    seen = {}

    async def fake_call(name, args, user=None, **kw):
        seen["name"], seen["args"] = name, args
        return {"ok": True}

    monkeypatch.setattr(oe, "_call", fake_call)
    assert _run(oe.raise_spectator_choice(user="u")) == {"ok": True}
    assert seen["name"] == "raiseSpectatorChoice"


def test_skip_ahead_control_and_route_are_wired():
    """E-1: the visible 'Skip ahead to the finale' control posts to a real route that calls the engine lever (the card, not the click, confirms the skip)."""
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    js = (root / "static/js/orwellStatusPanel.js").read_text()
    assert 'id="os-skip"' in js and "Skip ahead to the finale" in js
    assert "/api/orwell/spectator/raise" in js and "orwellGameChanged" in js
    assert 'pl.status === "evicted" && pl.spectator === "watch"' in js
    routes = (root / "routes/orwell_routes.py").read_text()
    assert '@router.post("/spectator/raise")' in routes and "raise_spectator_choice" in routes
