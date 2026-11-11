"""Batch C gate #7 (2026-07-11 narrator-prompt audit) — SINGLE-TENANT framing parity.

The NAR-1 / P2-11 lesson: under the auth-off posture the owner actually runs (`AUTH_ENABLED=false`),
the FE-internal `user` is `None`. A whole family of per-turn belts/stores keyed naively on `user`
collapsed to `.get(None)` and went SILENTLY INERT single-tenant — including the additive "Since your
last turn: …" delta line, which used to bail on `user is None` and so never rendered for the exact
posture the owner runs. The stall/pacing belts got NAR-1 test coverage; the FRAMING lines did not.

This gate drives the framing with `user=None` and asserts the delta line still renders — parity with
the multi-user path — so the single-tenant delta line can never silently die again.

Mirrors test_0065_delta_wiring.py's fakes; roles only, throwaway ids inside payloads.
"""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


_SID = "sess-single-tenant"


def _framing_fakes(monkeypatch, *, delta):
    """Stub every engine read apply_game_framing makes so the game-active branch builds a frame."""
    async def fake_state(user=None, retry=None, timeout=None, **kw):
        return {"started": True, "moment": "social", "phase": "veto-competition",
                "week": 3, "house": [{"id": "player", "status": "active"}], "beatSeq": 6}

    async def fake_moment(moment=None, user=None, timeout=None, **_kw):
        return {"systemPrompt": "GAME CONTEXT: the full authoritative board for grounding."}

    async def fake_status(user=None):
        return {"week": 3, "phase": "veto-competition", "hoh": None, "nominees": [],
                "veto": {"holder": None, "used": False, "players": []}, "pending": None, "beatSeq": 6}

    async def fake_delta(since, user=None):
        return delta

    async def fake_advance(*a, **k):
        return {"beatSeq": 6}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "state_delta", fake_delta)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)


@pytest.fixture(autouse=True)
def _clean_none_keyed_state():
    """Clear the None-keyed (single-tenant) framing state around each test."""
    def _wipe():
        for d in (chat_helpers._LAST_BEAT_SEQ, chat_helpers._LAST_BEAT_SIG, chat_helpers._DESYNC_REGROUND,
                  chat_helpers._SESSION_GAME_FRAMED):
            try:
                if isinstance(d, set):
                    d.discard(None)
                    d.discard(_SID)
                else:
                    d.pop(chat_helpers._beat_seq_key(None), None)
                    d.pop(None, None)
            except Exception:
                pass
        try:
            chat_helpers.clear_social_runway(None)
        except Exception:
            pass
    _wipe()
    yield
    _wipe()


# ── the tight unit: the delta line renders for user=None ────────────────────────────────────────

def test_maybe_delta_line_renders_for_user_none(monkeypatch):
    # The P2-11 fix: _maybe_delta_line no longer bails on `user is None`. With a last-seen token and a
    # non-empty delta, it renders the line single-tenant exactly as it does for a named user.
    async def fake_delta(since, user=None):
        assert user is None  # the single-tenant path passes None through unchanged
        assert since == 7
        return {"beatSeq": 9, "changes": {"hoh": {"from": None, "to": "npc:4"}}, "events": [],
                "fullRefresh": False}
    monkeypatch.setattr(orwell_engine, "state_delta", fake_delta)
    line = _run(chat_helpers._maybe_delta_line(None, 7))
    assert line and line.startswith("Since your last turn:") and "hoh" in line, (
        "the single-tenant (user=None) delta line did not render — the NAR-1/P2-11 regression is back"
    )


# ── the integration: apply_game_framing(user=None) appends the delta line ────────────────────────

def test_framing_appends_delta_line_single_tenant(monkeypatch):
    # A prior turn left a last-seen beatSeq under the SAME stable single-tenant key the framing reads.
    chat_helpers._LAST_BEAT_SEQ[chat_helpers._beat_seq_key(None)] = 4
    _framing_fakes(monkeypatch, delta={
        "beatSeq": 6, "changes": {"hoh": {"from": None, "to": "npc:9"}}, "events": [],
        "fullRefresh": False})
    chat_helpers._SESSION_GAME_FRAMED.add(_SID)
    preface = []
    _run(chat_helpers.apply_game_framing(preface, None, session_id=_SID))
    gm = preface[0]["content"]
    # The full authoritative GAME CONTEXT block is present (additive, never replaced)…
    assert "GAME CONTEXT" in gm
    # …and the tight diff line was appended even though user is None (the parity the gate protects).
    assert "Since your last turn:" in gm and "hoh" in gm, (
        "apply_game_framing(user=None) did not append the delta line — single-tenant framing drifted "
        "from the multi-user path (the NAR-1 lesson, now for framing lines)"
    )


def test_framing_named_user_and_none_reach_delta_parity(monkeypatch):
    # Explicit parity: the SAME delta renders the line for a named user AND for user=None.
    delta = {"beatSeq": 6, "changes": {"phase": {"from": "noms", "to": "veto"}}, "events": [],
             "fullRefresh": False}

    def _drive(user):
        chat_helpers._LAST_BEAT_SEQ[chat_helpers._beat_seq_key(user)] = 4
        chat_helpers._SESSION_GAME_FRAMED.add(_SID)
        preface = []
        _run(chat_helpers.apply_game_framing(preface, user, session_id=_SID))
        return preface[0]["content"]

    _framing_fakes(monkeypatch, delta=delta)
    named = _drive("u-parity")
    # reset the per-session-framed marker so the None drive rebuilds identically
    chat_helpers._SESSION_GAME_FRAMED.discard(_SID)
    none_ = _drive(None)
    assert ("Since your last turn:" in named) and ("Since your last turn:" in none_), (
        "delta-line rendering differs between a named user and single-tenant (user=None)"
    )
    # cleanup the named-user key this test seeded
    chat_helpers._LAST_BEAT_SEQ.pop(chat_helpers._beat_seq_key("u-parity"), None)
    chat_helpers._SESSION_GAME_FRAMED.discard(_SID)
    try:
        chat_helpers.clear_social_runway("u-parity")
    except Exception:
        pass
