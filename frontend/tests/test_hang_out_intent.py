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
    "I wait in the living room for the nominations ceremony.",
    "I spend the whole day socializing around the house and wait for the nominations ceremony this evening.",
    "I sit tight for the HOH competition",
])
def test_intent_recognised(msg):
    assert ch.hang_out_intent(msg)


@pytest.mark.parametrize("msg", [
    "wait, what did you just say?",
    "I wait for the HOH to speak",
    "Tell Sam I want to talk",
    "Can we start the HOH comp?",
    "I wait for the HOH to speak",
    "Wait for me, I want to see the ceremony",
    "She said wait for the ceremony",
    "Should I wait for the ceremony?",
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
    """ORW-22: an engine stop line makes the steer require the stop on screen; absent line => unchanged steer. ORW-917: the line itself is never quoted (it was copied verbatim)."""
    for reason in ("event-due", "pulled", "npc-approach", "observed", "bedtime", "max-beats"):
        res = {"stopReason": reason, "minutes": 40, "detail": {"npc": "Role", "by": "production", "kind": "someone-moved", "who": ["A"]}}
        assert "shows the player this" not in ch._hang_out_steer(res)
        res["stopLine"] = f"LINE for {reason}."
        steer = ch._hang_out_steer(res)
        assert "shows the player this stop" in steer and f"LINE for {reason}." not in steer and "Invent no ceremony" in steer  # ORW-917: never quoted


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_maybe_hang_out_arms_steer_only_on_ok(monkeypatch):
    from src import orwell_engine
    calls = []

    async def fake(expected_beat_seq=None, max_beats=None, user=None, **_kw):
        calls.append(expected_beat_seq)
        return {"ok": True, "stopReason": "npc-approach", "minutes": 50, "detail": {"npc": "Role"}, "beatSeq": 9}

    monkeypatch.setattr(orwell_engine, "hang_out", fake)
    ch._HANGOUT_STEER.clear()
    assert _run(ch.maybe_hang_out("u", {"started": True}, "let's chill until something happens")) is True
    assert "Role comes over" in ch._HANGOUT_STEER[ch._runway_key("u")]
    ch._HANGOUT_STEER.clear()

    async def refused(expected_beat_seq=None, max_beats=None, user=None, **_kw):
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


def test_orw477_steer_says_cut_short_only_when_the_wait_was_interrupted():
    cut = {"ok": True, "stopReason": "npc-approach", "minutes": 45, "detail": {"npc": "Role"}}
    assert "CUT SHORT" in ch._hang_out_steer(cut, 240)
    assert "CUT SHORT" not in ch._hang_out_steer(cut)  # no stated wait
    assert "CUT SHORT" not in ch._hang_out_steer(cut, None)
    ran = {"ok": True, "stopReason": "max-beats", "minutes": 240}
    assert "CUT SHORT" not in ch._hang_out_steer(ran, 240)  # the wait ran its length
    exact = {"ok": True, "stopReason": "npc-approach", "minutes": 240, "detail": {"npc": "Role"}}
    assert "CUT SHORT" not in ch._hang_out_steer(exact, 240)  # nothing short (the engine reports whole minutes, so a direct compare needs no tolerance)


def test_orw477_maybe_hang_out_stores_the_cut_short_steer(monkeypatch):
    from src import orwell_engine

    async def fake(expected_beat_seq=None, max_beats=None, user=None, **kw):
        return {"ok": True, "stopReason": "npc-approach", "minutes": 45, "detail": {"npc": "Role"}, "beatSeq": 9}

    monkeypatch.setattr(orwell_engine, "hang_out", fake)
    ch._HANGOUT_STEER.clear()
    assert _run(ch.maybe_hang_out("u", {"started": True}, "I wait here for four hours")) is True
    assert "CUT SHORT" in ch._HANGOUT_STEER[ch._runway_key("u")]
    ch._HANGOUT_STEER.clear()
