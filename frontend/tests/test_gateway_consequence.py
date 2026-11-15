"""Gateway consequence-fold tests (2026-07-22 repo gap audit, finding G1).

THE BUG: every player turn taken through the multi-platform gateway (feature 0072 —
``gateway/handler.py::_call_player_turn``) called only READ engine tools
(``getGameState``/``getMomentPrompt``), narrated, and returned — never ``recordInteraction`` or any
other mutating tool. That silently bypassed the whole consequence/memory loop (mandate #4 / feature
0023) for an entire live client surface, and — since no mutating tool ever fired —
``Orchestrator.commitPlayerTurn``'s per-turn bounded off-screen tick never ran either (see
``src/composition/runtime.ts``'s ``registry.setCommit`` funnel, wired from
``EngineCommandsAdapter.recordInteraction``'s own ``onPersist`` call).

THE FIX: ``gateway/consequence.py::fold_gateway_turn`` is a self-contained mirror of the streaming
agent loop's 0055 ``_auto_record_scene`` belt (it does NOT import ``agent_loop.py``), wired into
``handler.py::_call_player_turn`` right after narration. These tests pin the fix at the
``handle_platform_turn`` boundary — a real gateway turn, a stubbed engine.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

_FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _FRONTEND not in sys.path:
    sys.path.insert(0, _FRONTEND)

import gateway.handler as handler  # noqa: E402
import src.log_rings as log_rings  # noqa: E402
import src.orwell_cast_authoring as cast_authoring  # noqa: E402
import src.orwell_engine as orwell_engine  # noqa: E402

# Roles only (CLAUDE.md testing rule) — a plain two-NPC roster, never cast material.
_HOUSE = [
    {"id": "npc:1", "name": "Alex", "status": "active"},
    {"id": "npc:2", "name": "Jordan", "status": "active"},
]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _stub_reads(monkeypatch, *, present_ids=None, whereabouts_raises=False):
    """Stub the read-only engine calls every gateway turn makes: getGameState, getMomentPrompt,
    and (for the fold) whereabouts. Shared across the three scenarios below."""
    async def fake_get_game_state(user=None, timeout=None):
        return {"started": True, "house": _HOUSE}

    async def fake_get_moment_prompt(moment=None, user=None, timeout=None, **_kw):
        return {"systemPrompt": "You are in the Big Brother house."}

    async def fake_whereabouts(user=None):
        if whereabouts_raises:
            raise RuntimeError("presence read blip")
        return {"present": [{"id": i, "name": n} for i, n in
                            ((h["id"], h["name"]) for h in _HOUSE if h["id"] in (present_ids or set()))]}

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_get_game_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_get_moment_prompt)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_whereabouts)


def _capture_record_interaction(monkeypatch, *, raises=False):
    """Stub orwell_engine.record_interaction, capturing every call's kwargs."""
    calls = []

    async def fake_record_interaction(content, with_ids=None, initiator="player", kind=None,
                                       consequence=None, expected_beat_seq=None,
                                       idempotency_key=None, felt_minutes=None, user=None):
        if raises:
            raise RuntimeError("engine: record_interaction transport failure")
        calls.append({
            "content": content, "with_ids": with_ids, "initiator": initiator, "kind": kind,
            "consequence": consequence, "idempotency_key": idempotency_key,
            "felt_minutes": felt_minutes, "user": user,
        })
        return {"eventId": "evt-test-1"}

    monkeypatch.setattr(orwell_engine, "record_interaction", fake_record_interaction)
    return calls


def _capture_soft_failures(monkeypatch):
    """Stub log_rings.record_soft_failure, capturing every RED-eligible call."""
    calls = []

    def fake_record_soft_failure(anomaly_class, exc, *, corrected=None, **ctx):
        calls.append({"anomaly_class": anomaly_class, "exc": exc, "corrected": corrected, **ctx})

    monkeypatch.setattr(log_rings, "record_soft_failure", fake_record_soft_failure)
    return calls


# ── (a) a working extraction model records exactly one Vault-free interaction ──────────────────

class TestGatewayTurnFoldsConsequence:
    def test_records_exactly_one_interaction_with_vault_free_payload(self, monkeypatch):
        _stub_reads(monkeypatch, present_ids={"npc:1"})
        calls = _capture_record_interaction(monkeypatch)

        async def fake_llm_fn(messages):
            sys_content = messages[0]["content"]
            if "Extract the recordable consequence" in sys_content:
                return ('{"withIds":["npc:1"],"kind":"bonding",'
                        '"content":"The player reassured Alex about the vote."}')
            return "You pull Alex aside in the kitchen and reassure her you have her back."

        async def fake_resolve(owner):
            return fake_llm_fn

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        reply = _run(handler.handle_platform_turn(
            "telegram", "telegram:consequence-a",
            "I told Alex I trust her with my vote this week.",
            orwell_user="user_gw_a",
        ))

        # The narration is still delivered normally.
        assert reply and "not paired" not in reply.lower()

        # Exactly one recordInteraction call — the consequence loop actually fired.
        assert len(calls) == 1, f"expected exactly one recordInteraction call, got {calls!r}"
        call = calls[0]
        assert call["with_ids"] == ["npc:1"]
        assert call["kind"] == "bonding"
        assert call["user"] == "user_gw_a"

        # Vault-free payload: only the ordinary recordInteraction fields ever reach the engine —
        # no Vault handle exists on this side of the boundary to begin with, and nothing here
        # smuggles a secret-shaped field or the literal word "vault" into the recorded content.
        allowed_keys = {"content", "with_ids", "initiator", "kind", "consequence",
                       "idempotency_key", "felt_minutes", "user"}
        assert set(call.keys()) <= allowed_keys
        assert "vault" not in json.dumps(call, default=str).lower()

    def test_idle_message_naming_nobody_records_nothing(self, monkeypatch):
        """A solo/idle gateway ping (naming no houseguest) folds nothing — not every message is a
        recordable scene."""
        _stub_reads(monkeypatch, present_ids=set())
        calls = _capture_record_interaction(monkeypatch)

        async def fake_resolve(owner):
            return None  # no model needed for this scenario either way

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        reply = _run(handler.handle_platform_turn(
            "telegram", "telegram:consequence-idle", "what's the weather like today?",
            orwell_user="user_gw_idle",
        ))

        assert reply
        assert calls == []


# ── (b) a fold failure is LOUD (#1599): WARN + RED-eligible, but the reply still returns ───────

class TestGatewayFoldFailureIsLoudNeverSilent:
    def test_fold_failure_emits_red_eligible_event_and_still_returns_narration(self, monkeypatch):
        _stub_reads(monkeypatch, present_ids={"npc:1"})
        # record_interaction itself blows up (an engine-side transport failure) — this is the
        # "genuine failure mid-fold" case, distinct from "no model configured" (test c below).
        _capture_record_interaction(monkeypatch, raises=True)
        soft_failures = _capture_soft_failures(monkeypatch)

        async def fake_llm_fn(messages):
            sys_content = messages[0]["content"]
            if "Extract the recordable consequence" in sys_content:
                return '{"withIds":["npc:1"],"kind":"strategy","content":"They talked strategy."}'
            return "You and Alex huddle by the pool and talk through the coming vote."

        async def fake_resolve(owner):
            return fake_llm_fn

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        reply = _run(handler.handle_platform_turn(
            "telegram", "telegram:consequence-b",
            "I talk to Alex about the vote.",
            orwell_user="user_gw_b",
        ))

        # The player still gets their narration — a fold failure must never swallow the reply.
        assert reply
        assert "Alex" in reply or "pool" in reply

        # And the failure is LOUD: at least one RED-eligible soft-failure event was recorded,
        # never a silent swallow (#1599).
        assert soft_failures, "a fold failure must reach log_rings.record_soft_failure — it did not"
        classes = [c["anomaly_class"] for c in soft_failures]
        assert any(cls.startswith("gateway:") for cls in classes), classes
        assert all(c.get("user") == "user_gw_b" for c in soft_failures if "user" in c)


# ── (c) no model configured ⇒ the deterministic floor still fires ──────────────────────────────

class TestGatewayNoModelDeterministicFloor:
    def test_no_model_wired_still_records_via_name_matched_floor(self, monkeypatch):
        """No usable model resolves for EITHER narration or the extraction call (the gateway's
        placeholder-reply path) — the deterministic floor still folds a kind-less interaction
        naming whoever the player's own message actually names, because the game's consequence
        loop must never depend on a model being configured to record a real player action
        (mandate #4). This is a DELIBERATE design choice (see gateway/consequence.py's module
        docstring): unlike a creative extraction, naming a houseguest already present in the
        player's OWN text is not "engine-authored content" — it is read straight off the turn's
        own context, never invented."""
        _stub_reads(monkeypatch, present_ids={"npc:1", "npc:2"})
        calls = _capture_record_interaction(monkeypatch)

        async def fake_resolve(owner):
            return None  # no default model, no utility model — nothing resolves

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        reply = _run(handler.handle_platform_turn(
            "telegram", "telegram:consequence-c",
            "I told Alex I don't trust Jordan anymore.",
            orwell_user="user_gw_c",
        ))

        # Confirms this really is the "no model" path (the narration placeholder).
        assert "not configured" in reply.lower()

        assert len(calls) == 1, f"expected the deterministic floor to record once, got {calls!r}"
        call = calls[0]
        assert set(call["with_ids"]) == {"npc:1", "npc:2"}
        assert call["kind"] is None  # the floor never guesses a kind (ADR 0005)
        assert call["user"] == "user_gw_c"

    def test_no_model_and_nobody_named_records_nothing(self, monkeypatch):
        """No model AND no houseguest named anywhere in the turn ⇒ nothing recordable — the floor
        never invents a participant."""
        _stub_reads(monkeypatch, present_ids=set())
        calls = _capture_record_interaction(monkeypatch)

        async def fake_resolve(owner):
            return None

        monkeypatch.setattr(cast_authoring, "_resolve_llm_fn", fake_resolve)

        reply = _run(handler.handle_platform_turn(
            "telegram", "telegram:consequence-c2", "just thinking out loud in here",
            orwell_user="user_gw_c2",
        ))

        assert reply
        assert calls == []
