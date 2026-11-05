"""Feature 0118 (Phase 2, in-game-time pivot) — the TIMED, telegraphed ceremony interrupt.

When the engine reports the scheduled ceremony time has ARRIVED (the Vault-free day-schedule `due`
flag), the FE's forced-advance nudge must fire the ceremony REGARDLESS of a conversational lull —
production calls the whole house together at the scheduled in-game hour (owner ruling 2026-07-12:
ceremonies are a HARD, telegraphed interrupt; only bedtime is soft).

The signal is cached at framing (`chat_helpers._LAST_MILESTONE_DUE`) and read in the agent loop's
advance-nudge decision. This class of belt has a documented single-tenant KEYING footgun (see
test_nar1_belt_key_owner_none.py): the write side lives in chat_helpers keyed `user or "default"` and
the read side lives in agent_loop keyed `_belt_key(owner)` — they MUST resolve to the same bucket or
the belt is silently inert under AUTH_ENABLED=false. So the core assertions here are the keying
round-trip plus source-pins on the exact sites, matching that established shape.
"""
import importlib
import os

agent_loop = importlib.import_module("src.agent_loop")
from routes import chat_helpers  # noqa: E402

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_src(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ════════════════════════════════════════════════════════════════════════════
#  The cache exists and the keying agrees between the write (chat_helpers) and
#  the read (agent_loop) sides — the single-tenant footgun this class of belt hits.
# ════════════════════════════════════════════════════════════════════════════

def test_the_due_cache_exists():
    assert isinstance(chat_helpers._LAST_MILESTONE_DUE, dict)


def test_write_key_matches_read_key_single_tenant_and_real_owner():
    # chat_helpers stashes under `user or "default"`; agent_loop reads under `_belt_key(owner)`.
    # They must resolve to the SAME bucket, or the timed interrupt is silently inert single-tenant.
    for user in (None, "", "alice", "bob"):
        write_key = user or "default"
        assert write_key == agent_loop._belt_key(user)


def test_due_round_trips_owner_none():
    """A write under owner=None (the AUTH_ENABLED=false posture the owner runs) is visible to the read."""
    chat_helpers._LAST_MILESTONE_DUE.pop("default", None)
    try:
        # Absent ⇒ the read defaults False (clock off / no schedule ⇒ byte-identical lull-only pacing).
        assert bool(chat_helpers._LAST_MILESTONE_DUE.get(agent_loop._belt_key(None))) is False
        # The framing write does: _LAST_MILESTONE_DUE[user or "default"] = True
        chat_helpers._LAST_MILESTONE_DUE[None or "default"] = True
        # The agent loop reads: _LAST_MILESTONE_DUE.get(_belt_key(owner))
        assert bool(chat_helpers._LAST_MILESTONE_DUE.get(agent_loop._belt_key(None))) is True
    finally:
        chat_helpers._LAST_MILESTONE_DUE.pop("default", None)


def test_real_owners_do_not_collide():
    chat_helpers._LAST_MILESTONE_DUE.pop("alice", None)
    chat_helpers._LAST_MILESTONE_DUE.pop("bob", None)
    try:
        chat_helpers._LAST_MILESTONE_DUE["alice" or "default"] = True
        assert bool(chat_helpers._LAST_MILESTONE_DUE.get(agent_loop._belt_key("alice"))) is True
        assert bool(chat_helpers._LAST_MILESTONE_DUE.get(agent_loop._belt_key("bob"))) is False
    finally:
        chat_helpers._LAST_MILESTONE_DUE.pop("alice", None)
        chat_helpers._LAST_MILESTONE_DUE.pop("bob", None)


# ════════════════════════════════════════════════════════════════════════════
#  Source-pins on the exact wiring (the decision is inline in the finishing block).
# ════════════════════════════════════════════════════════════════════════════

def test_chat_helpers_stashes_due_from_the_day_schedule():
    src = _read_src("routes", "chat_helpers.py")
    assert "_LAST_MILESTONE_DUE" in src
    # Keyed the same "default"-fallback way as _LAST_FRAMED_BEAT_KEY, sourced from daySchedule.due.
    assert '_LAST_MILESTONE_DUE[user or "default"]' in src
    assert 'game_state.get("daySchedule")' in src


def test_agent_loop_reads_due_under_belt_key_and_wires_it_into_want_advance():
    src = _read_src("src", "agent_loop.py")
    # The read is keyed via _belt_key(owner) so it matches the chat_helpers write single-tenant.
    assert "_LAST_MILESTONE_DUE.get(_belt_key(owner))" in src
    # The bypass fires the forced advance on a due milestone even off a lull, but never on a turn that
    # already progressed and never while a social runway is deliberately held (never-fast-forward guard).
    gates = _read_src("src", "agent_gates.py")  # A60: the gate expressions live in agent_gates.py now (verbatim)
    assert "milestone_due and (not progressed) and not runway_holding" in gates
    assert "milestone_due=_milestone_due" in src  # ...and the loop still feeds it


def test_due_bypass_is_bounded_by_the_per_turn_advance_cap():
    # The timed interrupt is still ONE advance per turn (it lives inside the same _MAX cap), never a
    # runaway force-march.
    src = _read_src("src", "agent_loop.py")
    assert "turn_advance_nudges < max_advance_nudges and (" in _read_src("src", "agent_gates.py")  # A60
    assert "max_advance_nudges=_MAX_ADVANCE_NUDGES_PER_TURN" in src
