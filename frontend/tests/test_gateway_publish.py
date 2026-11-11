"""Gateway publish-game-updated + narration history tests (2026-07-22 R-PAR-4, #1879).

THE BUG: every gateway turn folded consequences but never pushed a game-updated event,
so web sessions never learned about the gateway turn until their next poll (which under
default-ON WS mode is cancelled entirely — orwellStatusPanel.js:852-877).  The gateway's
narration call was also memoryless: it only passed system + user messages, so the gateway
could not remember its own prior replies in the shared transcript surface.

THE FIX:
1. After fold_gateway_turn, call orwell_game_session.publish_game_updated(user) so every
   web device on the user's canonical session reconciles its HUD instantly.
2. Before the narration call, load recent assistant messages from the canonical session
   transcript and inject them into the messages list so the gateway remembers its own
   prior replies.
"""
from __future__ import annotations

import asyncio
import os
import sys

_FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _FRONTEND not in sys.path:
    sys.path.insert(0, _FRONTEND)

import gateway.handler as handler  # noqa: E402
import src.orwell_engine as orwell_engine  # noqa: E402
import src.orwell_cast_authoring as cast_authoring  # noqa: E402
import src.orwell_game_session as orwell_game_session  # noqa: E402
from core import models as _models  # noqa: E402

# Roles only — a plain two-NPC roster, never cast material.
_HOUSE = [
    {"id": "npc:1", "name": "Alex", "status": "active"},
    {"id": "npc:2", "name": "Jordan", "status": "active"},
]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _stub_reads(monkeypatch, *, present_ids=None):
    """Stub the read-only engine calls every gateway turn makes."""
    async def fake_get_game_state(user=None, timeout=None):
        return {"started": True, "house": _HOUSE}

    async def fake_get_moment_prompt(moment=None, user=None, timeout=None, **_kw):
        return {"systemPrompt": "You are in the Big Brother house."}

    async def fake_whereabouts(user=None):
        return {"present": [{"id": i, "name": n} for i, n in
                            ((h["id"], h["name"]) for h in _HOUSE if h["id"] in (present_ids or set()))]}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_get_game_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_get_moment_prompt)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_whereabouts)


def _capture_record_interaction(monkeypatch):
    """Stub orwell_engine.record_interaction, capturing every call's kwargs."""
    calls = []

    async def fake_record_interaction(content, with_ids=None, initiator="player", kind=None,
                                       consequence=None, expected_beat_seq=None,
                                       idempotency_key=None, felt_minutes=None, user=None):
        calls.append({
            "content": content, "with_ids": with_ids, "initiator": initiator, "kind": kind,
            "consequence": consequence, "idempotency_key": idempotency_key,
            "felt_minutes": felt_minutes, "user": user,
        })
        return {"eventId": "evt-test-1"}

    monkeypatch.setattr(orwell_engine, "record_interaction", fake_record_interaction)
    return calls


# ── 1. Gateway turn publishes game-updated ────────────────────────────────────────────────

class TestGatewayTurnPublishesGameUpdated:
    """Every gateway turn must push game-updated so web HUDs stay in sync."""

    def test_gateway_turn_publishes_game_updated(self, monkeypatch):
        """After a gateway turn, publish_game_updated is called with the correct user."""
        _stub_reads(monkeypatch, present_ids={"npc:1"})
        _capture_record_interaction(monkeypatch)

        async def fake_llm_fn(messages):
            return "You reassure Alex in the kitchen."

        async def fake_resolve(owner):
            return fake_llm_fn

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        # Spy on publish_game_updated
        published_users = []
        orig_publish = orwell_game_session.publish_game_updated

        def fake_publish(user):
            published_users.append(user)
            orig_publish(user)  # call through (will pass harmlessly — no session bound)

        monkeypatch.setattr(orwell_game_session, "publish_game_updated", fake_publish)

        reply = _run(handler.handle_platform_turn(
            "telegram", "telegram:publish-a",
            "I told Alex I trust her.",
            orwell_user="user_gw_pub_a",
        ))

        assert reply and "not paired" not in reply.lower()
        # publish_game_updated was called exactly once with the right user
        assert published_users == ["user_gw_pub_a"], (
            f"expected publish_game_updated(['user_gw_pub_a']), got {published_users}"
        )

    def test_publish_failure_does_not_swallow_reply(self, monkeypatch):
        """If publish_game_updated raises, the gateway reply still reaches the player."""
        _stub_reads(monkeypatch, present_ids={"npc:1"})
        _capture_record_interaction(monkeypatch)

        async def fake_llm_fn(messages):
            return "You and Alex discuss the vote."

        async def fake_resolve(owner):
            return fake_llm_fn

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        # Force a failure on publish
        def fake_publish_crash(user):
            raise RuntimeError("publish transport failure")

        monkeypatch.setattr(orwell_game_session, "publish_game_updated", fake_publish_crash)

        reply = _run(handler.handle_platform_turn(
            "telegram", "telegram:publish-b",
            "I talk strategy with Alex.",
            orwell_user="user_gw_pub_b",
        ))

        # Reply must still arrive (best-effort, fail-soft)
        assert reply
        assert "Alex" in reply or "vote" in reply or "strategy" in reply


# ── 2. Narration has history ──────────────────────────────────────────────────────────────

class TestGatewayNarrationHasHistory:
    """The narration messages list includes recent assistant messages from the session transcript."""

    def test_narration_includes_prior_assistant_messages(self, monkeypatch):
        """When the canonical session has prior assistant messages, they appear in the messages list."""
        _stub_reads(monkeypatch, present_ids={"npc:1"})
        _capture_record_interaction(monkeypatch)

        async def fake_llm_fn(messages):
            # Verify history is present in the messages list
            roles = [m["role"] for m in messages]
            assert "system" == roles[0], f"expected system first, got roles={roles}"
            assert "assistant" in roles, f"expected assistant in roles, got {roles}"
            assert "user" == roles[-1], f"expected user last, got roles={roles}"
            # Return a reply that signals history was seen
            history_msgs = [m for m in messages if m["role"] == "assistant"]
            if history_msgs:
                return "I remember what I said before, thanks to the session history."
            return "No history found."

        async def fake_resolve(owner):
            return fake_llm_fn

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        # Mock session with prior assistant messages
        from core.models import Session, ChatMessage

        mock_session = Session(
            id="mock-gw-session",
            name="gateway-chat",
            endpoint_url="http://mock",
            model="mock-model",
        )
        mock_session.history = [
            ChatMessage(role="user", content="Tell me about Alex"),
            ChatMessage(role="assistant", content="Alex is a loyal houseguest this week."),
            ChatMessage(role="user", content="What about Jordan?"),
            ChatMessage(role="assistant", content="Jordan seems more strategic."),
        ]

        orig_get_game_session = orwell_game_session.get_game_session

        def fake_get_game_session(user):
            return "mock-gw-session"

        monkeypatch.setattr(orwell_game_session, "get_game_session", fake_get_game_session)

        # We need to mock the session_manager to return our mock_session
        # For test isolation, we replace get_session on the global session manager
        orig_sm = _models._session_manager

        class MockSM:
            def get_session(self, session_id):
                return mock_session

        _models._session_manager = MockSM()

        try:
            reply = _run(handler.handle_platform_turn(
                "telegram", "telegram:history-a",
                "What was I saying before?",
                orwell_user="user_gw_hist_a",
            ))

            assert reply
            assert "I remember what I said before" in reply, (
                f"Expected history signal, got: {reply}"
            )
        finally:
            _models._session_manager = orig_sm
            monkeypatch.undo()

    def test_no_history_when_no_session_bound(self, monkeypatch):
        """When no canonical session is bound, narration still works with just system+user."""
        _stub_reads(monkeypatch, present_ids=set())
        _capture_record_interaction(monkeypatch)

        async def fake_llm_fn(messages):
            roles = [m["role"] for m in messages]
            assert "system" == roles[0], f"expected system first, got roles={roles}"
            assert "user" == roles[-1], f"expected user last, got roles={roles}"
            assert "assistant" not in roles, (
                f"expected NO assistant when no session bound, got roles={roles}"
            )
            return "No history loaded because no session is bound — that's fine."

        async def fake_resolve(owner):
            return fake_llm_fn

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        # Return None from get_game_session (no session bound)
        def fake_get_game_session(user):
            return None

        monkeypatch.setattr(orwell_game_session, "get_game_session", fake_get_game_session)

        reply = _run(handler.handle_platform_turn(
            "telegram", "telegram:no-session",
            "What's happening?",
            orwell_user="user_gw_no_sess",
        ))

        assert reply
