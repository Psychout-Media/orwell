"""The pending-decision BARRIER (a chat↔engine DESYNC class).

Found in live play: the engine sat BLOCKED on a player decision (a week-2 goodbye-message the
player must author) while the GM role-played PAST it, narrating into week 3. The engine is the
SOURCE OF TRUTH; the fiction must never advance past an unresolved player decision. The fix
injects a forceful GM directive that HARD-BLOCKS the model from narrating any beat past the
pending and pins it to bringing the player to THAT decision. This is the OPPOSITE of C-02 (an
NPC ceremony with no player step, which is pre-resolved for real) — here the player owes the
decision, so we never resolve it for them; we block the model from skipping it.
"""

import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── helper unit tests ──────────────────────────────────────────────────── #

def test_no_pending_returns_none():
    assert chat_helpers._pending_barrier_directive(None) is None
    assert chat_helpers._pending_barrier_directive({}) is None
    # Non-dict shapes must also fail safe.
    assert chat_helpers._pending_barrier_directive("nominations") is None
    assert chat_helpers._pending_barrier_directive(0) is None


def test_goodbye_message_directive_forbids_advancing_and_names_the_decision():
    pending = {
        "kind": "goodbye-message",
        "by": {"id": "player", "name": "Marcus"},
        "prompt": "Say goodbye to the evictee.",
    }
    out = chat_helpers._pending_barrier_directive(pending)
    assert out and isinstance(out, str)
    low = out.lower()
    # (a) it FORBIDS advancing past the decision — the desync language is present.
    assert "forbidden" in low or "not allowed" in low
    assert "desync" in low
    assert "past this decision" in low
    # ...and it explicitly forbids a new week / day / ceremony time-skip.
    assert "new day" in low and "next week" in low and "ceremony" in low
    # (b) it mentions the decision (kind + who + the quoted engine prompt) and the goodbye hint.
    assert "goodbye-message" in out
    assert "Marcus" in out
    assert "Say goodbye to the evictee." in out
    assert "goodbye" in low


def test_eviction_vote_directive_carries_its_hint():
    pending = {
        "kind": "eviction-vote",
        "by": {"id": "player", "name": "Dana"},
        "prompt": "Cast your vote to evict.",
    }
    out = chat_helpers._pending_barrier_directive(pending)
    assert out and "eviction-vote" in out
    assert "vote" in out.lower()
    assert "submitDecision" in out
    # The barrier still forbids skipping ahead.
    assert "desync" in out.lower()


def test_nominations_directive_carries_its_hint():
    pending = {
        "kind": "nominations",
        "by": {"id": "player", "name": "Priya"},
        "prompt": "Name your two nominees.",
        "options": [{"id": "npc:1", "name": "A"}, {"id": "npc:2", "name": "B"}],
    }
    out = chat_helpers._pending_barrier_directive(pending)
    assert out and "nominations" in out
    low = out.lower()
    assert "two nominees" in low or "name two" in low
    assert "submitDecision" in out
    assert "desync" in low


def test_unlisted_kind_falls_back_to_a_general_directive():
    # A kind with no per-kind hint (veto-decision) still gets a forceful, non-empty barrier.
    pending = {
        "kind": "veto-decision",
        "by": {"id": "player", "name": "Sam"},
        "prompt": "Decide whether to use the veto.",
    }
    out = chat_helpers._pending_barrier_directive(pending)
    assert out and "veto-decision" in out
    assert "submitDecision" in out
    assert "desync" in out.lower()


def test_missing_by_and_prompt_still_safe():
    # A malformed pending (no `by`, no `prompt`) must not raise and must still block.
    out = chat_helpers._pending_barrier_directive({"kind": "replacement"})
    assert out and "replacement" in out
    assert "desync" in out.lower()


# ── integration: the barrier rides apply_game_framing ───────────────────── #

def test_barrier_is_appended_to_the_gm_prompt(monkeypatch):
    """When the engine reports a player pending, the framed game turn's system prompt carries
    the barrier appended to the moment prompt."""
    async def fake_state(user=None, **kw):
        return {"started": True, "phase": "eviction", "moment": "eviction"}

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": "MOMENT-PROMPT"}

    async def fake_status(user=None):
        return {
            "phase": "eviction",
            "pending": {
                "kind": "goodbye-message",
                "by": {"id": "player", "name": "Marcus"},
                "prompt": "Say goodbye to the evictee.",
            },
        }

    async def no_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        # no NPC pre-resolve while a player pending is present (0065: accept the optional sync fields)
        raise AssertionError("must not advance while a player decision is pending")

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", no_advance)
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)

    preface = []
    engine_available, game_active, feed_down = _run(
        chat_helpers.apply_game_framing(preface, "u", False, session_id="sess-1")
    )
    assert game_active is True
    assert preface and preface[0]["role"] == "system"
    content = preface[0]["content"]
    assert content.startswith("MOMENT-PROMPT")
    assert "DESYNC" in content.upper()
    assert "goodbye-message" in content
    assert "Marcus" in content


def test_barrier_is_fail_open(monkeypatch):
    """A game_status hiccup while building the barrier must not break the framed turn — the GM
    prompt is still applied, just without the barrier."""
    async def fake_state(user=None, **kw):
        return {"started": True, "phase": "social", "moment": "social"}

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": "MOMENT-PROMPT"}

    async def boom_status(user=None):
        raise RuntimeError("engine blip")

    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    monkeypatch.setattr(orwell_engine, "game_status", boom_status)
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)

    preface = []
    _engine, game_active, _feed = _run(
        chat_helpers.apply_game_framing(preface, "u", False, session_id="sess-2")
    )
    assert game_active is True
    assert preface and preface[0]["content"].startswith("MOMENT-PROMPT")
    # No barrier appended, but the turn still framed in-character.
    assert "DESYNC" not in preface[0]["content"].upper()


# ── LW9 (audit 2026-06-21): the staged-comp still-in grounding ──────────────── #

def test_comp_round_directive_grounds_the_current_still_in_set():
    """A staged comp narrows each round; the model reliably narrates a STALE (larger) field from its
    own history. The barrier must surface the engine's CURRENT still-in set + exact count and tell the
    model to drop anyone it named earlier who is now gone (roles only — no names)."""
    pending = {
        "kind": "comp-round",
        "by": {"id": "player", "name": "Player"},
        "prompt": "The field narrows — 3 still standing. Still in with you: HG-A, HG-B.",
        "round": 4,
        "stillIn": [
            {"id": "player", "name": "Player"},
            {"id": "npc:1", "name": "HG-A"},
            {"id": "npc:2", "name": "HG-B"},
        ],
    }
    out = chat_helpers._pending_barrier_directive(pending)
    assert out and "comp-round" in out
    low = out.lower()
    assert "narrowed" in low                       # calls out that the field shrank
    assert "exactly these 3" in low                # the EXACT current count (player + 2 still in)
    assert "HG-A" in out and "HG-B" in out         # the engine's current still-in names
    assert "eliminated" in low                     # override stale history
    assert "do not list" in low
    assert "desync" in low                         # still forbids advancing past the decision


def test_comp_round_without_still_in_is_still_a_valid_barrier():
    # No stillIn list ⇒ no spurious grounding, but still a forceful barrier.
    out = chat_helpers._pending_barrier_directive({"kind": "comp-round", "prompt": "Pick your approach."})
    assert out and "comp-round" in out
    assert "desync" in out.lower()
    assert "narrowed" not in out.lower()


def test_non_comp_pending_gets_no_still_in_grounding():
    # A stillIn field on a NON-comp pending must NOT trigger the comp grounding (field-specific).
    pending = {"kind": "eviction-vote", "prompt": "Vote.", "stillIn": [{"id": "npc:1", "name": "HG-A"}]}
    out = chat_helpers._pending_barrier_directive(pending)
    assert out and "narrowed" not in out.lower()


# ── source-pin: the wiring stays in apply_game_framing ──────────────────── #

def test_framing_appends_the_barrier_fail_open():
    import os
    src = open(
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "routes", "chat_helpers.py"),
        encoding="utf-8",
    ).read()
    # apply_game_framing calls the barrier helper and appends it to gm_prompt.
    assert "_pending_barrier_directive(" in src
    assert "gm_prompt = gm_prompt + " in src and "_barrier" in src
    # The fetch is wrapped in try/except (fail-open) and warns on failure.
    barrier_call = src.index("_barrier = _pending_barrier_directive(")
    head = src.rindex("try:", 0, barrier_call)
    assert "except Exception" in src[barrier_call:barrier_call + 600]
    assert "pending barrier skipped" in src
    # It runs after gm_prompt is built (after the FALLBACK_GM_PROMPT assignment) and before the
    # prompt is prepended to the preface.
    fallback = src.index("gm_prompt = (mp or {}).get(\"systemPrompt\") or FALLBACK_GM_PROMPT")
    prepend = src.index('preface[0]["content"] = gm_prompt + "\\n\\n"')
    assert fallback < head < prepend
