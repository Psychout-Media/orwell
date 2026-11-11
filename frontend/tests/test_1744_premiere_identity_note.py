"""#1744 [L-F2/F7] — intro/casting re-ask loops: the defensive framing hardening.

Two live-observed re-ask relapses, mitigated FE-side (the golden gates stub the LLM, so live-verify
across >=3 seeds is owed; this pins the defensive framing that ships in the meantime):

  F2 — premiere roll-call relapse: the champagne-circle gate re-demanded the player's identity
       (name / hometown / job / one real thing) despite casting having it on file. FIX: a premiere-only
       framing note that states the identity is ESTABLISHED (on file from casting) so the beat is a
       GREETING, not a fresh identity demand. It rides ONLY a started game at the premiere moment (the
       engine reports a `premiere` view), NOT a casting turn.

  F7 — casting question-sail: the interviewer re-asked ANSWERED questions for ~8 turns. FIX: a casting
       framing note that forbids re-asking an answered question and finalizes once the required fields
       are on file. It rides EVERY pre-game (casting) turn — kills the RE-ASK, not the finalize variance.

Source-pinned (the notes exist and are wired into the framing path) + behavioral (drive
`apply_game_framing` with a fake engine at the premiere moment vs. the casting moment and assert the
right note appears in the right place, and not the other).
"""
import asyncio
import importlib
import os
import re

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ── source-pin: the notes exist and are wired into the framing path ─────── #

def test_premiere_identity_note_exists_and_is_premiere_gated():
    """The F2 note exists, states identity is on file / greet-don't-interrogate, and is wired into
    apply_game_framing gated on the engine's `premiere` view (never on a casting turn)."""
    note = chat_helpers.PREMIERE_IDENTITY_ON_FILE_NOTE
    assert isinstance(note, str) and note.strip()
    low = note.lower()
    assert "on file" in low
    assert "casting" in low
    assert "greet" in low
    # it forbids the fresh identity demand / interrogation
    assert "interrogate" in low or "introduce themselves" in low

    src = _read("routes", "chat_helpers.py")
    # wired into the framing path, gated on the engine's premiere view
    assert "PREMIERE_IDENTITY_ON_FILE_NOTE" in src
    m = re.search(
        r'if isinstance\(game_state\.get\("premiere"\), dict\):\s*\n\s*'
        r'gm_prompt = gm_prompt \+ "\\n\\n" \+ PREMIERE_IDENTITY_ON_FILE_NOTE',
        src,
    )
    assert m, "F2 note must be appended to gm_prompt gated on the engine's `premiere` view"


def test_casting_no_reask_note_exists_and_rides_pregame_framing():
    """The F7 note exists, forbids re-asking an answered question, and is wired onto the pre-game
    (casting) framing path."""
    note = chat_helpers.CASTING_NO_REASK_NOTE
    assert isinstance(note, str) and note.strip()
    low = note.lower()
    assert "re-ask" in low or "re-extract" in low
    assert "already answered" in low or "already given" in low or "has given" in low
    # it still steers to finalize once required fields are on file
    assert "createcharacter" in low

    src = _read("routes", "chat_helpers.py")
    assert 'pre_prompt = pre_prompt + "\\n\\n" + CASTING_NO_REASK_NOTE' in src


# ── behavioral: the right note at the right moment ──────────────────────── #

def _wire_common(monkeypatch):
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)

    async def fake_status(user=None):
        return {"phase": "premiere", "pending": None}

    async def no_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return None

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", no_advance)


def test_premiere_moment_includes_identity_note(monkeypatch):
    """A STARTED game at the premiere moment (engine reports a `premiere` view) frames the turn with
    the F2 identity note appended to the moment prompt."""
    async def fake_state(user=None, **kw):
        return {
            "started": True,
            "phase": "premiere",
            "moment": "premiere",
            # a live premiere view (whole house met at the champagne circle — powerReachable true)
            "premiere": {"total": 16, "metCount": 16, "hotReads": 3,
                         "complete": True, "powerReachable": True,
                         "champagneCircle": "gathered"},
        }

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": "MOMENT-PROMPT"}

    _wire_common(monkeypatch)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)

    preface = []
    _engine, game_active, _feed = _run(
        chat_helpers.apply_game_framing(preface, "u1744a", False, session_id="sess-1744a")
    )
    assert game_active is True
    content = preface[0]["content"]
    assert content.startswith("MOMENT-PROMPT")
    # F2 present at the premiere...
    assert chat_helpers.PREMIERE_IDENTITY_ON_FILE_NOTE in content
    assert "on file" in content.lower() and "greet" in content.lower()
    # ...and the casting F7 note is NOT on a started-game turn.
    assert chat_helpers.CASTING_NO_REASK_NOTE not in content


def test_non_premiere_started_moment_omits_identity_note(monkeypatch):
    """A started game PAST the premiere (no `premiere` view) must NOT carry the F2 note — it is
    premiere-only, so it can't leak into mid-season turns."""
    async def fake_state(user=None, **kw):
        return {"started": True, "phase": "hoh-competition", "moment": "hoh-competition"}

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": "MOMENT-PROMPT"}

    _wire_common(monkeypatch)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)

    preface = []
    _engine, game_active, _feed = _run(
        chat_helpers.apply_game_framing(preface, "u1744b", False, session_id="sess-1744b")
    )
    assert game_active is True
    content = preface[0]["content"]
    assert chat_helpers.PREMIERE_IDENTITY_ON_FILE_NOTE not in content


def test_casting_moment_includes_no_reask_note_not_premiere_note(monkeypatch):
    """A pre-game (casting) turn carries the F7 no-re-ask note and NOT the F2 premiere identity note."""
    async def fake_state(user=None, **kw):
        # no started game ⇒ the casting branch
        return {"started": False, "moment": "casting-interview"}

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": "CASTING-PROMPT"}

    # no headshot on file ⇒ isolate the F7 note from the headshot note
    class _FakePortraits:
        @staticmethod
        def intake_status(user):
            return {}

        @staticmethod
        def user_avatar_path(user):
            return None

    _wire_common(monkeypatch)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setitem(__import__("sys").modules, "src.orwell_portraits", _FakePortraits)

    preface = []
    _engine, game_active, _feed = _run(
        chat_helpers.apply_game_framing(preface, "u1744c", False, session_id="sess-1744c")
    )
    assert game_active is False
    content = preface[0]["content"]
    assert content.startswith("CASTING-PROMPT")
    # F7 present at casting...
    assert chat_helpers.CASTING_NO_REASK_NOTE in content
    # ...and the premiere F2 note does NOT appear on a casting turn.
    assert chat_helpers.PREMIERE_IDENTITY_ON_FILE_NOTE not in content
