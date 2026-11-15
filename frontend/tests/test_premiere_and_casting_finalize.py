"""Audit 2026-06-20 (live LLM walkthrough) — the two launch-blocking progression fixes.

The model reliably UNDER-CALLS the engine's progression tools at the two hand-offs that
bookend premiere day, and the existing guardrails didn't cover them:

  A — the game won't START: createCharacter is never called even with casting ready + the
      player asking, partly because the model is never told the cast headshot is on file.
  B — the premiere won't ADVANCE: the model narrates introductions but under-calls
      markHouseguestMet, so the meet-everyone gate (feature #380) never completes.

These cover the FE error-correction added for both (the deep streaming-loop fallbacks
themselves are exercised live; here we pin the unit-testable seams).
"""

import asyncio
import importlib

orwell_engine = importlib.import_module("src.orwell_engine")
orwell_portraits = importlib.import_module("src.orwell_portraits")
chat_helpers = importlib.import_module("routes.chat_helpers")
agent_loop = importlib.import_module("src.agent_loop")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# --- A/C: the casting frame tells the model the headshot is on file -------------------

def _pre_game_casting(monkeypatch):
    chat_helpers._GAME_WAS_ACTIVE.clear()
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)  # game build defaults ON

    async def fake_state(user=None):
        return {"started": False, "moment": "character-creation"}

    async def fake_mp(moment=None, user=None, **_kw):
        return {"systemPrompt": "CASTING-PROMPT"}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)


def test_casting_frame_announces_the_headshot_when_on_file(monkeypatch):
    _pre_game_casting(monkeypatch)
    monkeypatch.setattr(orwell_portraits, "intake_status",
                        lambda user: {"present": True, "finalized": True, "candidates": 0})
    monkeypatch.setattr(orwell_portraits, "user_avatar_path", lambda user: "/x.png")
    preface = [{"role": "system", "content": "base"}]
    _run(chat_helpers.apply_game_framing(preface, "p"))
    content = preface[0]["content"]
    assert content.startswith("CASTING-PROMPT")
    assert chat_helpers.CASTING_HEADSHOT_ON_FILE_NOTE in content
    assert "already on file" in chat_helpers.CASTING_HEADSHOT_ON_FILE_NOTE.lower()


def test_casting_frame_omits_the_note_when_no_headshot(monkeypatch):
    _pre_game_casting(monkeypatch)
    monkeypatch.setattr(orwell_portraits, "intake_status",
                        lambda user: {"present": False, "finalized": False, "candidates": 0})
    monkeypatch.setattr(orwell_portraits, "user_avatar_path", lambda user: None)
    preface = [{"role": "system", "content": "base"}]
    _run(chat_helpers.apply_game_framing(preface, "p"))
    assert chat_helpers.CASTING_HEADSHOT_ON_FILE_NOTE not in preface[0]["content"]


def test_casting_headshot_check_failopen_never_breaks_the_turn(monkeypatch):
    _pre_game_casting(monkeypatch)

    def boom(user):
        raise RuntimeError("portraits down")

    monkeypatch.setattr(orwell_portraits, "intake_status", boom)
    preface = [{"role": "system", "content": "base"}]
    # must not raise; the casting prompt still frames the turn
    _run(chat_helpers.apply_game_framing(preface, "p"))
    assert preface[0]["content"].startswith("CASTING-PROMPT")


# --- B: premiere intros that the model narrated but didn't mark get auto-marked -------

def _premiere_intros_view(remaining_names):
    return {
        "complete": False,
        "metCount": 1,
        "total": len(remaining_names) + 1,
        "remaining": [{"houseguest": {"id": f"npc:{i}", "name": n}}
                      for i, n in enumerate(remaining_names, 1)],
        "met": [],
    }


def test_auto_mark_marks_only_houseguests_named_in_the_narration(monkeypatch):
    marked = []

    async def fake_intros(user=None):
        return _premiere_intros_view(["Fiona Haynes", "Dawn Vega", "Quinn Mayer"])

    async def fake_mark(hid, user=None, via=None):  # #1318: the belt now passes via="belt"
        marked.append(hid)
        return {"complete": False}

    monkeypatch.setattr(orwell_engine, "premiere_intros", fake_intros)
    monkeypatch.setattr(orwell_engine, "mark_houseguest_met", fake_mark)

    narration = ("Fiona steps forward with a wave, and a beat later Quinn introduces himself "
                 "from the couch. Nobody's mentioned the third one yet.")
    n = _run(agent_loop._auto_mark_premiere_intros(narration, "p"))
    assert n == 2
    assert set(marked) == {"npc:1", "npc:3"}  # Fiona + Quinn; Dawn untouched (not introduced)


def test_auto_mark_matches_full_name_too(monkeypatch):
    marked = []
    monkeypatch.setattr(orwell_engine, "premiere_intros",
                        lambda user=None: _async(_premiere_intros_view(["Dawn Vega"])))

    async def fake_mark(hid, user=None, via=None):  # #1318: the belt now passes via="belt"
        marked.append(hid)
    monkeypatch.setattr(orwell_engine, "mark_houseguest_met", fake_mark)
    n = _run(agent_loop._auto_mark_premiere_intros("Then Dawn Vega took the floor.", "p"))
    assert n == 1 and marked == ["npc:1"]


def test_auto_mark_noop_with_empty_or_no_owner(monkeypatch):
    assert _run(agent_loop._auto_mark_premiere_intros("", "p")) == 0
    assert _run(agent_loop._auto_mark_premiere_intros("Anyone", None)) == 0


def test_auto_mark_failopen_when_intros_fetch_raises(monkeypatch):
    async def boom(user=None):
        raise RuntimeError("engine down")
    monkeypatch.setattr(orwell_engine, "premiere_intros", boom)
    # must not raise
    assert _run(agent_loop._auto_mark_premiere_intros("Fiona said hi", "p")) == 0


# --- the casting-finalize fallback constants are wired (the deep loop is tested live) -

def test_casting_finalize_force_threshold_and_nudges_present():
    assert agent_loop._CASTING_FORCE_LEVEL == len(agent_loop._CASTING_NUDGES)
    assert agent_loop._CASTING_NUDGES, "there must be at least one casting finalize nudge"
    assert "createCharacter" in agent_loop._CASTING_NUDGES[0]
    assert isinstance(agent_loop._CASTING_STALL_LEVEL, dict)


def _async(value):
    async def _c(*a, **k):
        return value
    return _c()
