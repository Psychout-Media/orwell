"""Lane 6 — FE framing & turn integrity (2026-06-10 full-product-audit findings).

Covers, with behavior-level tests wherever the seam allows:
  P2  — the re-entry moment is requested on the first game turn of a (re)opened session;
  P8  — single datetime header + the slim prompt-safety policy on framed game-build turns;
  E16 — player-authored preset personas never ride the GM stack on a game turn;
  E94 — an attachment on a game turn adds the one-line "the player is showing something"
        scene framing while the GM framing stays intact;
  E22 — the server-side guard for "narrated but never recorded" (code, not prompt wording);
  E23 — the agent contract forbids blind retries of committing tools (pinned in c14);
  E24/P7 — incognito cannot strip game framing under the game build;
  E25 — the sync route refuses a game turn BEFORE persisting the user message;
  E29 — orwell routes resolve the EFFECTIVE user (bearer tokens map to their real owner);
  W2  — the per-session SSE event stream verifies session ownership.

Roles only — no houseguest names; tool/vertical names are app capabilities.
"""

import asyncio
import importlib
import os
import pathlib

import pytest

orwell_engine = importlib.import_module("src.orwell_engine")
chat_helpers = importlib.import_module("routes.chat_helpers")

FRONTEND = pathlib.Path(__file__).parent.parent
CHAT_ROUTES_SRC = (FRONTEND / "routes" / "chat_routes.py").read_text(encoding="utf-8")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _live_game(monkeypatch, *, moment="social", prompt="GM-PROMPT"):
    """A reachable engine with a started season; returns the per-call capture dict."""
    chat_helpers._GAME_WAS_ACTIVE.clear()
    chat_helpers._SESSION_GAME_FRAMED.clear()
    captured = {"moments": []}

    async def fake_state(user=None, timeout=None):
        return {"started": True, "moment": moment}

    async def fake_mp(m=None, user=None, **_kw):
        captured["moments"].append(m)
        return {"systemPrompt": prompt}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    return captured


# ── P2: the re-entry moment on session (re)open ─────────────────────────────────────


def test_first_game_turn_of_an_unseen_session_requests_re_entry(monkeypatch):
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    captured = _live_game(monkeypatch)
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-1"))
    assert captured["moments"] == [chat_helpers.RE_ENTRY_MOMENT]


def test_subsequent_turns_in_the_same_session_use_the_phase_moment(monkeypatch):
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    captured = _live_game(monkeypatch)
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-1"))
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-1"))
    assert captured["moments"] == [chat_helpers.RE_ENTRY_MOMENT, "social"]


def test_a_new_session_mid_season_gets_its_own_re_entry(monkeypatch):
    # The exact P2 scenario: a fresh chat opened mid-season is a fresh context — it opens
    # on THE RECORD (recalled from the stores), not zero history (ADR 0003 §6).
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    captured = _live_game(monkeypatch)
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-1"))
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-2"))
    assert captured["moments"] == [chat_helpers.RE_ENTRY_MOMENT, chat_helpers.RE_ENTRY_MOMENT]


def test_the_casting_session_premiere_is_not_a_re_entry(monkeypatch):
    # The session that hosted the casting interview has full context — when the season
    # starts in that same session, the premiere plays as the premiere.
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    chat_helpers._GAME_WAS_ACTIVE.clear()
    chat_helpers._SESSION_GAME_FRAMED.clear()
    captured = {"moments": []}

    async def pre_state(user=None, timeout=None):
        return {"started": False, "moment": "character-creation"}

    async def fake_mp(m=None, user=None, **_kw):
        captured["moments"].append(m)
        return {"systemPrompt": "PROMPT"}

    monkeypatch.setattr(orwell_engine, "get_game_state", pre_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-1"))  # the interview turn

    async def live_state(user=None, timeout=None):
        return {"started": True, "moment": "premiere"}

    monkeypatch.setattr(orwell_engine, "get_game_state", live_state)
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-1"))
    assert captured["moments"][-1] == "premiere"  # not re-entry


def test_no_session_id_means_no_re_entry_rewrite(monkeypatch):
    # Direct callers without a session (legacy paths) keep the phase moment.
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    captured = _live_game(monkeypatch)
    _run(chat_helpers.apply_game_framing([], "p"))
    assert captured["moments"] == ["social"]


def test_unmark_returns_the_sessions_re_entry(monkeypatch):
    # E25/P2 interplay: a refused turn gives the session its re-entry beat back.
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    captured = _live_game(monkeypatch)
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-1"))
    chat_helpers.unmark_session_framed("sess-1")
    _run(chat_helpers.apply_game_framing([], "p", session_id="sess-1"))
    assert captured["moments"] == [chat_helpers.RE_ENTRY_MOMENT, chat_helpers.RE_ENTRY_MOMENT]


# ── P8: prompt minimalism on framed game-build turns ────────────────────────────────


def test_game_turn_drops_the_standalone_datetime_header(monkeypatch):
    # The agent loop prepends its own datetime — the chat-preface copy was a ~100-token
    # double header on every game turn.
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    _live_game(monkeypatch)
    from src.user_time import current_datetime_prompt
    preface = [{"role": "system", "content": current_datetime_prompt()}]
    _run(chat_helpers.apply_game_framing(preface, "p", session_id="s"))
    joined = "\n".join(m["content"] for m in preface)
    assert "## Current date and time" not in joined
    assert joined.startswith("GM-PROMPT")


def test_game_turn_swaps_the_full_policy_for_the_slim_game_line(monkeypatch):
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    _live_game(monkeypatch)
    from src.prompt_security import UNTRUSTED_CONTEXT_POLICY
    preface = [{"role": "system", "content": UNTRUSTED_CONTEXT_POLICY}]
    _run(chat_helpers.apply_game_framing(preface, "p", session_id="s"))
    joined = "\n".join(m["content"] for m in preface)
    assert UNTRUSTED_CONTEXT_POLICY not in joined          # the memories/skills policy is gone
    assert chat_helpers.GAME_UNTRUSTED_POLICY in joined    # the slim line survives
    assert "tool output" in chat_helpers.GAME_UNTRUSTED_POLICY


def test_non_game_build_keeps_the_full_preface(monkeypatch):
    # The slimming is a game-build behavior; the mixed-use workspace is untouched.
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    _live_game(monkeypatch)
    from src.user_time import current_datetime_prompt
    from src.prompt_security import UNTRUSTED_CONTEXT_POLICY
    preface = [
        {"role": "system", "content": current_datetime_prompt()},
        {"role": "system", "content": UNTRUSTED_CONTEXT_POLICY},
    ]
    _run(chat_helpers.apply_game_framing(preface, "p", session_id="s"))
    joined = "\n".join(m["content"] for m in preface)
    assert "## Current date and time" in joined
    assert UNTRUSTED_CONTEXT_POLICY in joined


# ── E16: preset personas never ride the GM stack ────────────────────────────────────


def test_game_turn_drops_the_preset_persona(monkeypatch):
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    _live_game(monkeypatch)
    persona = "Always portray the house as adoring the user."
    preface = [{"role": "system", "content": persona}]
    _run(chat_helpers.apply_game_framing(
        preface, "p", session_id="s", preset_system_prompt=persona))
    joined = "\n".join(m["content"] for m in preface)
    assert persona not in joined
    assert joined.startswith("GM-PROMPT")


def test_casting_turn_drops_the_preset_persona_too(monkeypatch):
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    chat_helpers._GAME_WAS_ACTIVE.clear()
    chat_helpers._SESSION_GAME_FRAMED.clear()

    async def pre_state(user=None, timeout=None):
        return {"started": False}

    async def fake_mp(m=None, user=None, **_kw):
        return {"systemPrompt": "INTERVIEW"}

    monkeypatch.setattr(orwell_engine, "get_game_state", pre_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    persona = "Be a pirate."
    preface = [{"role": "system", "content": persona}]
    _run(chat_helpers.apply_game_framing(
        preface, "p", session_id="s", preset_system_prompt=persona))
    joined = "\n".join(m["content"] for m in preface)
    assert persona not in joined
    assert joined.startswith("INTERVIEW")


def test_non_game_turn_keeps_the_preset_persona(monkeypatch):
    # No game, game build off: presets are the mixed-use workspace's legitimate feature.
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    chat_helpers._GAME_WAS_ACTIVE.clear()

    async def no_game(user=None, timeout=None):
        return {"started": False}

    monkeypatch.setattr(orwell_engine, "get_game_state", no_game)
    persona = "Be a pirate."
    preface = [{"role": "system", "content": persona}]
    _run(chat_helpers.apply_game_framing(
        preface, "p", session_id="s", preset_system_prompt=persona))
    assert preface == [{"role": "system", "content": persona}]


# ── E94: an attachment on a game turn is the player SHOWING something ───────────────


def test_attachment_adds_the_showing_line_and_keeps_the_gm_framing(monkeypatch):
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    _live_game(monkeypatch)
    preface = [{"role": "system", "content": "base"}]
    _run(chat_helpers.apply_game_framing(
        preface, "p", session_id="s", has_attachments=True))
    head = preface[0]["content"]
    assert head.startswith("GM-PROMPT")                       # the GM framing is intact
    assert chat_helpers.ATTACHMENT_SCENE_FRAMING in head      # the one-line addition rides it
    assert "SHOWING it to" in chat_helpers.ATTACHMENT_SCENE_FRAMING
    assert "record the beat" in chat_helpers.ATTACHMENT_SCENE_FRAMING


def test_no_attachment_means_no_showing_line(monkeypatch):
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    _live_game(monkeypatch)
    preface = [{"role": "system", "content": "base"}]
    _run(chat_helpers.apply_game_framing(preface, "p", session_id="s"))
    assert chat_helpers.ATTACHMENT_SCENE_FRAMING not in preface[0]["content"]


def test_build_chat_context_passes_the_attachment_flag():
    src = (FRONTEND / "routes" / "chat_helpers.py").read_text(encoding="utf-8")
    assert "has_attachments=bool(preprocessed.attachment_meta)" in src


# ── E22: narrated-but-never-recorded is enforced in code ────────────────────────────


def _capture_record(monkeypatch):
    calls = []

    async def fake_record(content, with_ids=None, initiator="player", kind=None,
                          expected_beat_seq=None, idempotency_key=None, user=None):
        # #1537: the E22 floor digest now routes through _backfill_with_cas, which threads a stable
        # at-most-once idempotency_key — accept it so the fake matches the real call shape.
        calls.append({"content": content, "user": user, "idempotency_key": idempotency_key})
        return {"recorded": True}

    monkeypatch.setattr(orwell_engine, "record_interaction", fake_record)
    return calls


def test_unrecorded_game_turn_gets_a_fallback_record(monkeypatch):
    calls = _capture_record(monkeypatch)
    narration = "The kitchen goes quiet as the player walks in. " * 5
    before = chat_helpers.unrecorded_turn_fallback_count()
    recorded = _run(chat_helpers.ensure_turn_recorded(
        "u", "I size up the room.", narration, ["getGameState", "whereabouts"]))
    assert recorded is True
    assert len(calls) == 1
    assert calls[0]["user"] == "u"
    # the digest is bounded and carries both sides of the exchange
    assert "I size up the room." in calls[0]["content"]
    assert len(calls[0]["content"]) <= 2 * chat_helpers.GAME_TURN_DIGEST_CHARS + 120
    # and the counter ticked (the prompt-compliance signal)
    assert chat_helpers.unrecorded_turn_fallback_count() == before + 1


def test_turn_with_an_engine_write_is_not_double_recorded(monkeypatch):
    calls = _capture_record(monkeypatch)
    narration = "A long narrated beat that the model already recorded properly. " * 4
    recorded = _run(chat_helpers.ensure_turn_recorded(
        "u", "msg", narration, ["getGameState", "recordInteraction"]))
    assert recorded is False
    assert calls == []


def test_every_engine_write_kind_suppresses_the_fallback(monkeypatch):
    narration = "Something meaningful happened in the house tonight, at length. " * 4
    for write in sorted(chat_helpers.GAME_ENGINE_WRITE_TOOLS):
        calls = _capture_record(monkeypatch)
        assert _run(chat_helpers.ensure_turn_recorded("u", "m", narration, [write])) is False
        assert calls == []


def test_trivial_narration_is_not_force_recorded(monkeypatch):
    calls = _capture_record(monkeypatch)
    assert _run(chat_helpers.ensure_turn_recorded("u", "hi", "Hey.", [])) is False
    assert calls == []


def test_agent_done_path_wires_the_guard():
    # The enforcement point: the agent-stream completion fires the guard on game turns.
    assert "ensure_turn_recorded(" in CHAT_ROUTES_SRC
    assert "if ctx.game_active and full_response:" in CHAT_ROUTES_SRC
    assert "_agent_tools_called" in CHAT_ROUTES_SRC


# ── L18: the E22 fallback is single-flight per user (no engine-write pileup) ─────────


def test_concurrent_same_user_fallbacks_do_not_stack(monkeypatch):
    """L18 — the fallback is fired fire-and-forget at [DONE]; without single-flight, several
    under-called turns in a row stack racing recordInteraction commits onto the engine's
    per-user queue and stall the next live turn (the observed 'hang then 502'). While one
    fallback is in flight for a user, a second is SKIPPED — only one engine write goes out."""
    gate = asyncio.Event()
    calls = []

    async def slow_record(content, with_ids=None, initiator="player", kind=None,
                          expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append({"user": user})
        await gate.wait()  # hold the write 'in flight' like a slow late-season commit
        return {"recorded": True}

    monkeypatch.setattr(orwell_engine, "record_interaction", slow_record)
    narration = "The house holds its breath as the player makes a move. " * 4

    async def scenario():
        first = asyncio.create_task(chat_helpers.ensure_turn_recorded("solo", "a", narration, []))
        await asyncio.sleep(0)  # let the first reach the in-flight state and block on the gate
        assert chat_helpers.fallback_in_flight("solo") is True
        # A second under-called turn for the SAME user while the first is in flight: skipped.
        second = await chat_helpers.ensure_turn_recorded("solo", "b", narration, [])
        assert second is False
        gate.set()
        assert await first is True
        # exactly one engine write went out despite two under-called turns
        assert [c["user"] for c in calls] == ["solo"]
        # and once the first drains, the user is free to record again
        assert chat_helpers.fallback_in_flight("solo") is False

    _run(scenario())


def test_a_different_user_is_never_blocked_by_anothers_in_flight_fallback(monkeypatch):
    """L18 — per-user isolation (0021) holds for the guard too: user B's fallback fires even
    while user A's is in flight (single-flight is keyed per user, never a global lock)."""
    gate = asyncio.Event()
    calls = []

    async def record(content, with_ids=None, initiator="player", kind=None,
                     expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(user)
        if user == "A":
            await gate.wait()
        return {"recorded": True}

    monkeypatch.setattr(orwell_engine, "record_interaction", record)
    narration = "A tense beat unfolds in the living room at length. " * 4

    async def scenario():
        a = asyncio.create_task(chat_helpers.ensure_turn_recorded("A", "x", narration, []))
        await asyncio.sleep(0)
        assert chat_helpers.fallback_in_flight("A") is True
        # B sails through while A is held.
        assert await chat_helpers.ensure_turn_recorded("B", "y", narration, []) is True
        gate.set()
        assert await a is True
        assert "B" in calls and "A" in calls

    _run(scenario())


def test_a_failed_fallback_releases_the_in_flight_slot(monkeypatch):
    """L18 — a raised recordInteraction must not wedge the slot shut (else one engine hiccup
    permanently disables the guard for that user). The finally-release proves it reopens."""
    async def boom(content, with_ids=None, initiator="player", kind=None,
                   expected_beat_seq=None, idempotency_key=None, user=None):
        raise RuntimeError("engine said no")

    monkeypatch.setattr(orwell_engine, "record_interaction", boom)
    narration = "Something went sideways in the backyard, recounted fully. " * 4
    assert _run(chat_helpers.ensure_turn_recorded("z", "m", narration, [])) is False
    assert chat_helpers.fallback_in_flight("z") is False  # slot released despite the failure


# ── #1105: the E22 fallback routes through the RICHER extraction first ───────────────
#
# The model called recordInteraction ~once a whole game while the E22 fallback fired dozens of
# times with a generic, descriptor-less digest — so per ADR 0005 the engine applied only the
# deterministic kind-floor fold and the relationship SHAPE the scene implied was FLATTENED. The
# fix routes the fallback through the same constrained extraction the 0055 _auto_record_scene
# belt uses (model-proposed {withIds, kind, content, consequence}), so the fallback carries scene
# shape — falling back to the flat floor digest ONLY when no model/house resolves or it hiccups.


def test_e22_fallback_prefers_the_rich_extraction(monkeypatch):
    """When the richer extraction banks a scene-shape fold, the E22 fallback does NOT also write
    a second, flatter floor digest for the same turn (no double record, the rich fold wins)."""
    floor_calls = _capture_record(monkeypatch)
    rich_calls = []

    async def fake_rich(user, player_message, narration):
        rich_calls.append({"user": user, "msg": player_message})
        return True  # banked a scene-shape fold via _auto_record_scene's own recordInteraction

    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", fake_rich)
    narration = "The kitchen goes quiet as the player works the room at length. " * 4
    recorded = _run(chat_helpers.ensure_turn_recorded(
        "u", "I press my ally and warm up to the swing vote.", narration, ["getGameState"]))
    assert recorded is True
    # the rich belt ran; the flat floor digest did NOT (no descriptor-less double record)
    assert len(rich_calls) == 1 and rich_calls[0]["user"] == "u"
    assert floor_calls == []
    # the slot is released afterward (no wedge)
    assert chat_helpers.fallback_in_flight("u") is False


def test_e22_fallback_drops_to_the_floor_digest_when_rich_extraction_declines(monkeypatch):
    """No model / no house / a solo beat / a hiccup ⇒ the richer path returns False, and the
    bounded kind-floor digest still GUARANTEES the under-called turn folds SOMETHING (the 0023
    consequence loop never silently drops a scene)."""
    floor_calls = _capture_record(monkeypatch)

    async def decline_rich(user, player_message, narration):
        return False  # e.g. no utility model configured, or a solo internal beat

    monkeypatch.setattr(chat_helpers, "_e22_rich_extract", decline_rich)
    narration = "A tense beat unfolds as the player sizes up the house, recounted in full. " * 4
    recorded = _run(chat_helpers.ensure_turn_recorded(
        "u", "I size up the room.", narration, ["getGameState"]))
    assert recorded is True
    # exactly the legacy floor digest landed (both sides of the exchange, bounded)
    assert len(floor_calls) == 1
    assert "I size up the room." in floor_calls[0]["content"]
    assert len(floor_calls[0]["content"]) <= 2 * chat_helpers.GAME_TURN_DIGEST_CHARS + 120


def test_e22_rich_extraction_no_house_declines_without_a_model_call(monkeypatch):
    """_e22_rich_extract returns False (and never reaches the LLM) when the engine reports no
    house roster — the floor digest then stands. Proves the rich path is fail-soft end to end."""
    async def empty_state(user, timeout=None):
        return {"started": True, "house": []}

    monkeypatch.setattr(orwell_engine, "get_game_state", empty_state)
    out = _run(chat_helpers._e22_rich_extract("u", "msg", "A long narrated beat. " * 5))
    assert out is False


# ── E24/P7: incognito cannot strip game framing under the game build ────────────────


def test_incognito_is_inert_for_framing_under_the_game_build(monkeypatch):
    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    _live_game(monkeypatch)
    preface = [{"role": "system", "content": "base"}]
    ea, ga, fd = _run(chat_helpers.apply_game_framing(
        preface, "p", True, session_id="s"))  # incognito=True
    assert (ea, ga, fd) == (True, True, False)
    assert preface[0]["content"].startswith("GM-PROMPT")  # framed despite incognito


def test_incognito_still_skips_framing_when_the_game_build_is_off(monkeypatch):
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    _live_game(monkeypatch)
    preface = [{"role": "system", "content": "base"}]
    ea, ga, fd = _run(chat_helpers.apply_game_framing(preface, "p", True, session_id="s"))
    assert (ea, ga, fd) == (False, False, False)
    assert preface == [{"role": "system", "content": "base"}]


def test_stream_route_forces_incognito_off_under_the_game_build():
    # The route-level belt: the toggle itself is inert server-side under the game build.
    block = CHAT_ROUTES_SRC[CHAT_ROUTES_SRC.index('incognito = str(form_data.get("incognito"'):]
    block = block[:700]
    assert "game_build_enabled" in block
    assert "incognito = False" in block


# ── E25: the sync route refuses a game turn before persisting ───────────────────────


def test_sync_game_409_fires_before_build_chat_context():
    # The hoisted pre-check must precede the context build (which persists the user
    # message); the post-context check survives only as a belt that discards the row.
    sync = CHAT_ROUTES_SRC[: CHAT_ROUTES_SRC.index("async def chat_stream")]
    hoist = sync.index("_pre_state = await _oe.get_game_state")
    build = sync.index("ctx = await build_chat_context(")
    assert hoist < build
    assert "discard_last_user_message(sess)" in sync
    assert "unmark_session_framed(session)" in sync


def test_discard_last_user_message_pops_the_trailing_user_row():
    class _Msg:
        def __init__(self, role):
            self.role = role
            self.metadata = {}

    class _Sess:
        def __init__(self):
            self.history = [_Msg("assistant"), _Msg("user")]
            self.message_count = 2

    sess = _Sess()
    chat_helpers.discard_last_user_message(sess)
    assert [m.role for m in sess.history] == ["assistant"]
    assert sess.message_count == 1
    # idempotent / safe when the tail isn't a user message
    chat_helpers.discard_last_user_message(sess)
    assert [m.role for m in sess.history] == ["assistant"]


# ── E29: orwell routes resolve the EFFECTIVE user ───────────────────────────────────


def _orwell_client(monkeypatch, overrides, *, token_owner):
    """A TestClient over the real orwell router with middleware-equivalent state stamped
    the way app.py stamps a bearer-token caller (current_user="api", api_token_owner=owner)."""
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    for name, fn in overrides.items():
        monkeypatch.setattr(orwell_engine, name, fn)
    orwell_routes = importlib.import_module("routes.orwell_routes")
    importlib.reload(orwell_routes)

    app = FastAPI()

    @app.middleware("http")
    async def stamp(request: Request, call_next):
        request.state.current_user = "api"
        request.state.api_token = True
        request.state.api_token_owner = token_owner
        return await call_next(request)

    app.include_router(orwell_routes.setup_orwell_routes())
    return TestClient(app, raise_server_exceptions=False)


def test_bearer_callers_resolve_to_their_token_owner_not_api(monkeypatch):
    seen = []

    async def fake_state(user=None, timeout=None):
        seen.append(user)
        return {"started": False}

    client = _orwell_client(monkeypatch, {"get_game_state": fake_state}, token_owner="owner-a")
    assert client.get("/api/orwell/state").status_code == 200
    client_b = _orwell_client(monkeypatch, {"get_game_state": fake_state}, token_owner="owner-b")
    assert client_b.get("/api/orwell/state").status_code == 200
    # Two different owners' tokens reach the engine as two DISTINCT users — never one "api".
    assert seen == ["owner-a", "owner-b"]
    assert "api" not in seen


def test_cookie_sessions_are_unchanged(monkeypatch):
    seen = []

    async def fake_state(user=None, timeout=None):
        seen.append(user)
        return {"started": False}

    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    orwell_routes = importlib.import_module("routes.orwell_routes")
    importlib.reload(orwell_routes)
    app = FastAPI()

    @app.middleware("http")
    async def stamp(request: Request, call_next):
        request.state.current_user = "cookie-user"
        request.state.api_token = False
        return await call_next(request)

    app.include_router(orwell_routes.setup_orwell_routes())
    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/api/orwell/state").status_code == 200
    assert seen == ["cookie-user"]


# ── W2: the SSE event stream verifies session ownership ─────────────────────────────


def test_chat_events_verifies_session_ownership():
    # The one session endpoint that skipped _verify_session_owner (any authenticated user
    # could subscribe to another user's activity stream). Assert the guard sits between
    # the route decorator and the subscribe call.
    start = CHAT_ROUTES_SRC.index('@router.get("/api/chat/events/{session_id}")')
    end = CHAT_ROUTES_SRC.index("session_events.subscribe(session_id)", start)
    handler = CHAT_ROUTES_SRC[start:end]
    assert "_verify_session_owner(request, session_id)" in handler
