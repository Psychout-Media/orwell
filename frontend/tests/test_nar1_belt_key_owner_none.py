"""NAR-1 (product-review, 2026-07) — the stall/pacing belt lattice must persist state SINGLE-TENANT.

`_FIRST_WEEK_HINT`, `_TURNS_SINCE_PROGRESS`, and `_ADVANCE_STALL_LEVEL` (all in `agent_loop.py`),
plus the `_LAST_FRAMED_BEAT_KEY` read sites that key off `owner`, used a MISMATCHED key between
their write and read sides: several writes were gated `if owner:` / `if owner is not None:` (a
no-op single-tenant) or written under the raw `owner` value, while every read fell back to
`owner or ""` — a DIFFERENT key than either the raw `None` a gated write skipped, or (for
`_LAST_FRAMED_BEAT_KEY`, whose write lives in `chat_helpers.py`) the `"default"` sentinel the
writer actually used.

Net effect under `AUTH_ENABLED=false` (`owner=None` every turn — a legitimate home-deploy
posture and the one the product owner runs): the lull-based stall clock could never go stale, the
L39b forced-advance escalation ladder could never climb past its first rung, the first-week pacing
hint never engaged, and the ADR-0011 peer-advance/framed-beat-key comparison always read empty —
so the ENTIRE reactive stall-nudge/forced-advance belt stood down single-tenant, leaving only the
proactive `tool_choice` force (GLM-only, kill-switch-able) as a net.

This mirrors `test_1014_guard_owner_none.py`'s established shape for this class of bug: a
behavioral round-trip proving write and read now agree under `owner=None`, plus source-pins on
the exact sites. Cross-user isolation is unweakened by construction — a real (truthy) `owner`
always keys on its own identity via `_belt_key`, exactly as before; only the `owner=None` path
changes, from "silently inert" to "shares the single-tenant `default` bucket".
"""
import importlib
import os

agent_loop = importlib.import_module("src.agent_loop")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read_src(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ════════════════════════════════════════════════════════════════════════════
#  _belt_key — the resolver itself
# ════════════════════════════════════════════════════════════════════════════

def test_belt_key_resolves_none_to_the_shared_default_sentinel():
    assert agent_loop._belt_key(None) == "default"
    assert agent_loop._belt_key("") == "default"  # falsy string collapses the same way


def test_belt_key_is_a_no_op_for_a_real_owner():
    # A real user ALWAYS keys on its own identity — never the shared sentinel. Cross-user
    # isolation is unweakened: two distinct real owners can never collide via this resolver.
    assert agent_loop._belt_key("alice") == "alice"
    assert agent_loop._belt_key("bob") == "bob"
    assert agent_loop._belt_key("alice") != agent_loop._belt_key("bob")


# ════════════════════════════════════════════════════════════════════════════
#  Round-trip: a write under owner=None is now VISIBLE to the read owner=None sees
# ════════════════════════════════════════════════════════════════════════════

def test_first_week_hint_round_trips_owner_none():
    """THE REGRESSION: `_effective_advance_grace(None)` reads `_FIRST_WEEK_HINT.get(_belt_key(None))`.
    Before the fix, the write site gated on `if owner is not None:` and NEVER wrote when owner was
    None, so this always fell back to the standard grace — the brisker first-week pacing could
    never engage single-tenant. Simulating the (now-unconditional) write proves read and write
    agree."""
    agent_loop._FIRST_WEEK_HINT.pop("default", None)
    try:
        assert agent_loop._effective_advance_grace(None) == agent_loop._ADVANCE_GRACE_TURNS
        # The write site now does: _FIRST_WEEK_HINT[_belt_key(owner)] = True (unconditional).
        agent_loop._FIRST_WEEK_HINT[agent_loop._belt_key(None)] = True
        assert agent_loop._effective_advance_grace(None) == agent_loop._FIRST_WEEK_GRACE_TURNS
    finally:
        agent_loop._FIRST_WEEK_HINT.pop("default", None)


def test_turns_since_progress_round_trips_owner_none():
    """THE REGRESSION: the write site used to be `if owner: _TURNS_SINCE_PROGRESS[owner] = ...` —
    a no-op when owner is None — while the read fell back to `.get(owner or "", 0)`. A staleness
    clock that never increments can never go stale, so the lull advance-nudge could never fire
    single-tenant. Proves the SAME key now serves both sides."""
    key = agent_loop._belt_key(None)
    agent_loop._TURNS_SINCE_PROGRESS.pop(key, None)
    try:
        assert agent_loop._TURNS_SINCE_PROGRESS.get(key, 0) == 0
        agent_loop._TURNS_SINCE_PROGRESS[key] = (
            0 if False else agent_loop._TURNS_SINCE_PROGRESS.get(key, 0) + 1)
        assert agent_loop._TURNS_SINCE_PROGRESS.get(key, 0) == 1
        grace = agent_loop._effective_advance_grace(None)
        for _ in range(grace):
            agent_loop._TURNS_SINCE_PROGRESS[key] = agent_loop._TURNS_SINCE_PROGRESS.get(key, 0) + 1
        assert agent_loop._TURNS_SINCE_PROGRESS.get(key, 0) >= grace, \
            "the staleness clock must be able to reach the grace threshold single-tenant"
    finally:
        agent_loop._TURNS_SINCE_PROGRESS.pop(key, None)


def test_advance_stall_level_round_trips_owner_none():
    """THE REGRESSION: the read was `.get(owner or "", 0)` while the write was a raw, ungated
    `_ADVANCE_STALL_LEVEL[owner] = _level + 1` — under owner=None the write landed at key `None`,
    which the `owner or ""` read (key `""`) can never see, so `_level` was pinned at 0 forever and
    the L39b force threshold (`_ADVANCE_FORCE_LEVEL`) could never be reached single-tenant."""
    key = agent_loop._belt_key(None)
    agent_loop._ADVANCE_STALL_LEVEL.pop(key, None)
    try:
        for expected in range(1, agent_loop._ADVANCE_FORCE_LEVEL + 1):
            level = agent_loop._ADVANCE_STALL_LEVEL.get(key, 0)
            agent_loop._ADVANCE_STALL_LEVEL[key] = level + 1
            assert agent_loop._ADVANCE_STALL_LEVEL.get(key, 0) == expected
        # The ladder actually reaches the force threshold single-tenant now.
        assert agent_loop._ADVANCE_STALL_LEVEL.get(key, 0) >= agent_loop._ADVANCE_FORCE_LEVEL
    finally:
        agent_loop._ADVANCE_STALL_LEVEL.pop(key, None)


def test_last_framed_beat_key_shares_the_default_sentinel_with_chat_helpers():
    """`_LAST_FRAMED_BEAT_KEY` is WRITTEN in chat_helpers.py (`user or "default"`) and READ in
    agent_loop.py. Before the fix, two of the three read sites used `owner or ""` — a different
    key than the writer's `"default"` — so the F14 eviction-drain and the ADR-0011 peer-advance
    comparison never saw a framed beat single-tenant. `_belt_key` must match chat_helpers' own
    sentinel exactly (not just be internally self-consistent)."""
    chat_helpers = importlib.import_module("routes.chat_helpers")
    key = agent_loop._belt_key(None)
    chat_helpers._LAST_FRAMED_BEAT_KEY[key] = (7, "eviction", "reveal")
    try:
        # chat_helpers' own writer keys under `user or "default"` — same sentinel.
        assert key == (None or "default")
        fk = chat_helpers._LAST_FRAMED_BEAT_KEY.get(agent_loop._belt_key(None))
        assert fk == (7, "eviction", "reveal")
    finally:
        chat_helpers._LAST_FRAMED_BEAT_KEY.pop(key, None)


# ════════════════════════════════════════════════════════════════════════════
#  Source-pins — every touch site now routes through `_belt_key`
# ════════════════════════════════════════════════════════════════════════════

def test_every_belt_store_site_routes_through_belt_key():
    src = _read_src("src", "agent_loop.py")
    # No remaining `owner or ""` fallback anywhere near these three stores (the mismatched key
    # this whole fix removes). A few OTHER, unrelated `owner or ""`-shaped strings may still exist
    # elsewhere in the file for different purposes, so we scope the check to each store's own name.
    for store in ("_FIRST_WEEK_HINT", "_TURNS_SINCE_PROGRESS", "_ADVANCE_STALL_LEVEL"):
        assert f'{store}.get(owner or "")' not in src, store
        assert f'{store}.get(owner or "", 0)' not in src, store
        assert f"{store}[owner]" not in src, store
    assert '_LAST_FRAMED_BEAT_KEY.get(owner or "")' not in src
    assert "def _belt_key(owner)" in src


def test_f14_and_narr3_belt_no_longer_gated_on_owner():
    """The surface-the-pending (F14/#1013) and invented-houseguest (NARR-3/#613) belts are
    CORRECTNESS nets, not per-user observability — their callees (`game_status(user=owner)`,
    `record_post_turn_roster_check` via `_desync_key`) already handle `owner=None`. Gating the
    whole block on `owner` truthiness stood both belts down entirely single-tenant. Distinguish
    this from the OTHER two `if _is_live_game and owner:` gates in the file (the sync-ledger and
    token-ledger observability blocks), which stay owner-gated ON PURPOSE and must NOT be touched
    by this fix."""
    src = _read_src("src", "agent_loop.py")
    pend = src.index('surface-the-pending belt: emitting open player pending')
    head = src.rindex("if _is_live_game:", 0, pend)
    window = src[head:pend]
    assert "if _is_live_game and owner:" not in window
    # "F14 (#1013)" labels three related sites in this file; the one immediately preceding this
    # gate is the SURFACE-THE-PENDING belt itself.
    assert "F14 (#1013)" in src[head:pend]
    # The two legitimate owner-gated observability blocks are UNCHANGED — still gated.
    # Deliberate re-pin (ORW-292): the TOKEN-ledger write is no longer owner-gated - under auth-off the owner is None, and gating on it meant a whole live game logged no token usage at all (it now meters
    # under the ledger's own "default" bucket). The sync-ledger observability block is the one that stays owner-gated; the F14/NARR-3 correctness belt must still not be one of the gated blocks.
    assert src.count("if _is_live_game and owner:") == 1, (
        "expected exactly 1 remaining owner-gated block (the sync-ledger observability one) — "
        "the F14/NARR-3 correctness belt and (ORW-292) the token ledger must not be gated on owner")
