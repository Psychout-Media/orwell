"""ADR 0006 — the persisted time-of-day setting is applied to the engine even in multiuser mode.

Prod bundle 2026-06-22 logged `Failed to apply time-of-day setting on boot: missing user identity`.
Root cause: setTimeOfDay is a process-global engine flag with no sandbox to route through at boot,
and it isn't a sandbox-creating tool — so a userless (or unknown-user) boot call is refused under
ORWELL_ENGINE_MULTIUSER. The fix applies the persisted setting LAZILY on the first framed turn, once
a real user's sandbox exists, passing that user so the call routes cleanly. Latched once-per-process,
fail-soft (a failure leaves the latch down so a later turn retries).

Harness mirrors test_lane6_turn_integrity.py (drive the real apply_game_framing with a mocked engine).
Roles only — `user` is a plain account token, never a houseguest name.
"""

import asyncio
import importlib

orwell_engine = importlib.import_module("src.orwell_engine")
chat_helpers = importlib.import_module("routes.chat_helpers")
app_settings = importlib.import_module("src.settings")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _framed_engine(monkeypatch, *, tod_enabled, set_tod):
    """A reachable, started-season engine; `set_tod` is the spy installed on set_time_of_day."""
    chat_helpers._GAME_WAS_ACTIVE.clear()
    chat_helpers._SESSION_GAME_FRAMED.clear()
    chat_helpers._TIME_OF_DAY_APPLIED = False  # reset the once-per-process latch

    async def fake_state(user=None, timeout=None):
        return {"started": True, "moment": "social"}

    async def fake_mp(m=None, user=None, **_kw):
        return {"systemPrompt": "GM"}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    monkeypatch.setattr(orwell_engine, "set_time_of_day", set_tod)
    monkeypatch.setattr(app_settings, "get_setting",
                        lambda key, default=None: tod_enabled if key == "time_of_day_enabled" else default)


def test_persisted_time_of_day_applied_with_the_user_on_first_framed_turn(monkeypatch):
    calls = []

    async def set_tod(enabled, user=None):
        calls.append((enabled, user))
        return {"ok": True}

    _framed_engine(monkeypatch, tod_enabled=False, set_tod=set_tod)

    _run(chat_helpers.apply_game_framing([], "player-a", session_id="s1"))
    # The persisted value is pushed WITH the framed user — so it routes through that user's existing
    # sandbox instead of being refused like the userless boot apply was.
    assert calls == [(False, "player-a")]


def test_apply_is_latched_once_per_process(monkeypatch):
    calls = []

    async def set_tod(enabled, user=None):
        calls.append((enabled, user))
        return {"ok": True}

    _framed_engine(monkeypatch, tod_enabled=True, set_tod=set_tod)

    _run(chat_helpers.apply_game_framing([], "player-a", session_id="s1"))
    _run(chat_helpers.apply_game_framing([], "player-a", session_id="s1"))
    _run(chat_helpers.apply_game_framing([], "player-b", session_id="s2"))
    assert calls == [(True, "player-a")], "applied exactly once for the whole process, not per turn/user"


def test_apply_retries_after_a_transient_failure(monkeypatch):
    calls = []

    async def flaky_set_tod(enabled, user=None):
        calls.append((enabled, user))
        if len(calls) == 1:
            raise RuntimeError("engine busy")  # first attempt fails — latch must stay DOWN
        return {"ok": True}

    _framed_engine(monkeypatch, tod_enabled=True, set_tod=flaky_set_tod)

    _run(chat_helpers.apply_game_framing([], "player-a", session_id="s1"))  # fails, no latch
    _run(chat_helpers.apply_game_framing([], "player-a", session_id="s1"))  # retries, succeeds, latches
    _run(chat_helpers.apply_game_framing([], "player-a", session_id="s1"))  # latched — no third call
    assert len(calls) == 2, "a failed apply leaves the latch down so a later turn retries, then latches"
