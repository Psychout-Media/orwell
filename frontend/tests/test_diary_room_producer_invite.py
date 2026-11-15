"""The producer's Diary-Room INVITATION (0013 §5 / PG-14 / PS-4).

Big Brother's signature backstage ritual is the producer pulling the player aside for a
confessional at a dramatic beat. The engine's `producerPrompt` was built for exactly this and had
ZERO live callers — so the invitation NEVER fired in real play (dead code). It is now live-wired:
`GameSessionAdapter.view()` sets `GameStateView.diaryRoomInvite` at a dramatic beat, and
`apply_game_framing` turns that flag into a one-shot producer aside inviting the player in.

Two guarantees this file pins:
  (a) the invite now FIRES at the intended beat (and only once per beat — an invitation, not a nag);
  (b) the invite preserves the Diary Room's ONE-WAY OOC wall — its directive never opens a pathway
      from Diary-Room content to any NPC's knowledge (that wall is structural in the engine; the
      framing text must never contradict it).
"""

import asyncio
import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── helper unit tests ──────────────────────────────────────────────────── #

def test_no_invite_returns_none():
    # Every routine beat: the engine sends no invite ⇒ no directive.
    assert chat_helpers._diary_room_invite_directive(None) is None
    assert chat_helpers._diary_room_invite_directive({}) is None
    assert chat_helpers._diary_room_invite_directive({"invite": False}) is None
    # Non-dict shapes fail safe.
    assert chat_helpers._diary_room_invite_directive("eviction") is None
    assert chat_helpers._diary_room_invite_directive(0) is None


def test_invite_directive_is_an_optional_aside_not_a_decision():
    out = chat_helpers._diary_room_invite_directive({"invite": True, "reason": "dramatic beat: eviction"})
    assert out and isinstance(out, str)
    low = out.lower()
    # It is an INVITATION, offered lightly, never a forced stop.
    assert "invit" in low
    assert "optional" in low or "if they want" in low
    assert "once" in low  # offered a single time, then let go
    # It is explicitly NOT a decision/vote and must not reopen a staged ceremony (protects the
    # eviction reveal choreography — the eviction moment prompt forbids reopening the DR for a vote).
    assert "not a decision" in low or "not a vote" in low
    assert "reopen" in low


def test_invite_directive_preserves_the_one_way_ooc_wall():
    """(b) — the load-bearing guarantee: the invite text keeps the Diary Room player-OOC. It must
    tell the model that nothing said in the DR reaches any houseguest, and it must NEVER instruct the
    model to let a DR confession inform the house."""
    out = chat_helpers._diary_room_invite_directive({"invite": True})
    low = out.lower()
    # The wall is stated: DR content reaches no houseguest / the house never hears it.
    assert "private" in low
    assert "never reaches any houseguest" in low or "nothing said there ever reaches" in low
    assert "out-of-character" in low or "out of character" in low
    # And the inverse is never suggested — no language that would leak the DR into NPC behavior.
    for banned in ["tell the house", "houseguests learn", "npc reacts", "the house reacts to"]:
        assert banned not in low


# ── integration: the invite rides apply_game_framing at a dramatic beat ─── #

def _fake_engine(monkeypatch, *, moment, invite, week=2):
    async def fake_state(user=None, **kw):
        st = {"started": True, "phase": moment, "moment": moment, "week": week}
        if invite is not None:
            st["diaryRoomInvite"] = invite
        return st

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": "MOMENT-PROMPT"}

    async def fake_status(user=None):
        return {"phase": moment, "pending": None}  # no pending ⇒ no barrier

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)


def test_invite_is_appended_at_a_dramatic_beat(monkeypatch):
    chat_helpers._DR_INVITED_BEATS.pop("u", None)
    _fake_engine(monkeypatch, moment="eviction",
                 invite={"invite": True, "reason": "dramatic beat: eviction"})
    preface = []
    _e, game_active, _f = _run(
        chat_helpers.apply_game_framing(preface, "u", False, session_id="dr-sess-1"))
    assert game_active is True
    content = preface[0]["content"]
    assert content.startswith("MOMENT-PROMPT")
    assert "DIARY-ROOM INVITATION" in content
    # The one-way wall rides in the framed prompt too.
    assert "private" in content.lower()


def test_invite_fires_once_per_beat_not_every_turn(monkeypatch):
    """A dramatic beat spans many turns (an eviction reveal is ~10). The invite must fire ONCE for
    the (game, beat) and stay silent on every subsequent turn of the SAME beat — an invitation, not
    a per-turn nag."""
    chat_helpers._DR_INVITED_BEATS.pop("u", None)
    _fake_engine(monkeypatch, moment="eviction", week=2,
                 invite={"invite": True, "reason": "dramatic beat: eviction"})
    # Turn 1: invited.
    p1 = []
    _run(chat_helpers.apply_game_framing(p1, "u", False, session_id="dr-sess-2"))
    assert "DIARY-ROOM INVITATION" in p1[0]["content"]
    # Turn 2, SAME beat: no second invite.
    p2 = []
    _run(chat_helpers.apply_game_framing(p2, "u", False, session_id="dr-sess-2"))
    assert "DIARY-ROOM INVITATION" not in p2[0]["content"]
    # A NEW dramatic beat (next week's eviction) invites again.
    _fake_engine(monkeypatch, moment="eviction", week=3,
                 invite={"invite": True, "reason": "dramatic beat: eviction"})
    p3 = []
    _run(chat_helpers.apply_game_framing(p3, "u", False, session_id="dr-sess-2"))
    assert "DIARY-ROOM INVITATION" in p3[0]["content"]


def test_no_invite_at_a_routine_beat(monkeypatch):
    chat_helpers._DR_INVITED_BEATS.pop("u", None)
    _fake_engine(monkeypatch, moment="social", invite=None)
    preface = []
    _run(chat_helpers.apply_game_framing(preface, "u", False, session_id="dr-sess-3"))
    assert "DIARY-ROOM INVITATION" not in preface[0]["content"]


def test_dedup_is_cleared_when_the_game_goes_inactive(monkeypatch):
    """A finished/reset game must clear the invited-beat memory so a fresh season invites cleanly
    (week numbers repeat across seasons)."""
    chat_helpers._DR_INVITED_BEATS.pop("u", None)
    _fake_engine(monkeypatch, moment="eviction", week=1,
                 invite={"invite": True, "reason": "dramatic beat: eviction"})
    p1 = []
    _run(chat_helpers.apply_game_framing(p1, "u", False, session_id="dr-sess-4"))
    assert "DIARY-ROOM INVITATION" in p1[0]["content"]
    assert "u" in chat_helpers._DR_INVITED_BEATS

    # Game ends / is reset (no live season).
    async def no_game(user=None, **kw):
        return {"started": False}
    monkeypatch.setattr(orwell_engine, "get_game_state", no_game)
    _run(chat_helpers.apply_game_framing([], "u", False, session_id="dr-sess-4b"))
    assert "u" not in chat_helpers._DR_INVITED_BEATS  # memory cleared


def test_invite_is_fail_open(monkeypatch):
    """A malformed invite shape must never break the framed turn — the GM prompt still applies."""
    chat_helpers._DR_INVITED_BEATS.pop("u", None)
    # A truthy-but-broken invite payload: not a dict ⇒ helper returns None, framing is unchanged.
    _fake_engine(monkeypatch, moment="eviction", invite="not-a-dict")
    preface = []
    _e, game_active, _f = _run(
        chat_helpers.apply_game_framing(preface, "u", False, session_id="dr-sess-5"))
    assert game_active is True
    assert preface[0]["content"].startswith("MOMENT-PROMPT")
    assert "DIARY-ROOM INVITATION" not in preface[0]["content"]


# ── source-pin: the wiring stays live in apply_game_framing ─────────────── #

def test_wiring_stays_in_apply_game_framing():
    import os
    src = open(
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "routes", "chat_helpers.py"),
        encoding="utf-8",
    ).read()
    # apply_game_framing reads the engine's diaryRoomInvite and appends the directive.
    assert 'game_state.get("diaryRoomInvite")' in src
    assert "_diary_room_invite_directive(" in src
    # It dedups per (game, beat) so it's an invitation, not a per-turn nag.
    assert "_DR_INVITED_BEATS" in src
    assert "_dr_beat_key not in _invited" in src
    # Fail-open + cleared on game inactive.
    assert "diary-room invite framing skipped" in src
    assert '_DR_INVITED_BEATS.pop(_gkey, None)' in src
