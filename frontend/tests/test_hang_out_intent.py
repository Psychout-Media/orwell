"""'Hang out until X': FE intent recognition + the engine-stop steer + the fail-open wiring. Roles only."""
import asyncio

import pytest

from routes import chat_helpers as ch


@pytest.mark.parametrize("msg", [
    "I'll hang out here and socialize until the competition starts",
    "let's just chill until something happens",
    "I wait around till someone comes to talk to me",
    "kick back in the lounge for a while",
    "I want to relax for the rest of the morning",
    "Hang out in the kitchen until production calls us",
])
def test_intent_recognised(msg):
    assert ch.hang_out_intent(msg)


@pytest.mark.parametrize("msg", [
    "wait, what did you just say?",
    "I wait for the HOH to speak",
    "Tell Sam I want to talk",
    "Can we start the HOH comp?",
    "", None,
])
def test_non_intent_ignored(msg):
    assert not ch.hang_out_intent(msg)


def test_steer_voices_each_engine_stop_without_inventing():
    cases = {
        "event-due": {"stopReason": "event-due", "minutes": 95},
        "pulled": {"stopReason": "pulled", "minutes": 40, "detail": {"by": "diary-room"}},
        "npc-approach": {"stopReason": "npc-approach", "minutes": 60, "detail": {"npc": "the Role"}},
        "observed": {"stopReason": "observed", "minutes": 25, "detail": {"kind": "overheard-whisper", "who": ["A", "B"]}},
        "bedtime": {"stopReason": "bedtime", "minutes": 120},
        "max-beats": {"stopReason": "max-beats", "minutes": 180},
    }
    for reason, res in cases.items():
        steer = ch._hang_out_steer(res)
        assert "engine-decided" in steer and f"{res['minutes']} in-game minutes" in steer
        assert "Invent no ceremony" in steer
    assert "Diary Room" in ch._hang_out_steer(cases["pulled"])
    assert "the Role comes over" in ch._hang_out_steer(cases["npc-approach"])
    assert "A and B" in ch._hang_out_steer(cases["observed"])
    assert "bedtime is the player's own call" in ch._hang_out_steer(cases["bedtime"])


def test_steer_carries_the_engine_stop_line_for_every_stop_kind():
    """ORW-22: the engine's player-facing line rides the steer so the reply must put the stop on screen; absent line => unchanged steer."""
    for reason in ("event-due", "pulled", "npc-approach", "observed", "bedtime", "max-beats"):
        res = {"stopReason": reason, "minutes": 40, "detail": {"npc": "Role", "by": "production", "kind": "someone-moved", "who": ["A"]}}
        assert "shows the player this" not in ch._hang_out_steer(res)
        res["stopLine"] = f"LINE for {reason}."
        steer = ch._hang_out_steer(res)
        assert f'"LINE for {reason}."' in steer and "Invent no ceremony" in steer


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_maybe_hang_out_arms_steer_only_on_ok(monkeypatch):
    from src import orwell_engine
    calls = []

    async def fake(expected_beat_seq=None, max_beats=None, user=None):
        calls.append(expected_beat_seq)
        return {"ok": True, "stopReason": "npc-approach", "minutes": 50, "detail": {"npc": "Role"}, "beatSeq": 9}

    monkeypatch.setattr(orwell_engine, "hang_out", fake)
    ch._HANGOUT_STEER.clear()
    assert _run(ch.maybe_hang_out("u", {"started": True}, "let's chill until something happens")) is True
    assert "Role comes over" in ch._HANGOUT_STEER[ch._runway_key("u")]
    ch._HANGOUT_STEER.clear()

    async def refused(expected_beat_seq=None, max_beats=None, user=None):
        return {"ok": False, "reason": "disabled", "beats": 0, "minutes": 0, "beatSeq": 3}

    monkeypatch.setattr(orwell_engine, "hang_out", refused)
    assert _run(ch.maybe_hang_out("u", {"started": True}, "chill until the comp")) is False
    assert not ch._HANGOUT_STEER


def test_maybe_hang_out_skips_without_intent_game_or_with_pending(monkeypatch):
    from src import orwell_engine

    async def boom(**kw):
        raise AssertionError("engine must not be called")

    monkeypatch.setattr(orwell_engine, "hang_out", boom)
    assert _run(ch.maybe_hang_out("u", {"started": True}, "hello there")) is False
    assert _run(ch.maybe_hang_out("u", {"started": False}, "chill until the comp")) is False
    assert _run(ch.maybe_hang_out("u", {"started": True, "pending": {"kind": "x"}}, "chill until the comp")) is False


def test_maybe_hang_out_is_fail_open(monkeypatch):
    from src import orwell_engine

    async def broken(**kw):
        raise RuntimeError("engine down")

    monkeypatch.setattr(orwell_engine, "hang_out", broken)
    assert _run(ch.maybe_hang_out("u", {"started": True}, "chill until the comp")) is False
