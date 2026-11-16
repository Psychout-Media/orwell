"""Batch C gate #4 (2026-07-11 narrator-prompt audit) — PENDING-HINT semantics.

`chat_helpers._PENDING_KIND_HINTS` steers the model on the SPECIFIC pending decision the player owes.
Each key must be a REAL engine pending-decision kind (a typo / renamed kind silently falls through to
the generic hint, and the specific steering is dead) — and the `comp-round` hint must encode the
engine's once-only ruling (the staged-competition approach is declared ONCE up front and covers the
whole comp; the later rounds are drama over an already-decided result, NOT a fresh choice each round).
The audit found nothing pinned either invariant.

Reads the engine kind union from src/ports/GameSession.ts as text (like test_c13_lever_drift.py).
"""
import importlib
import os
import re

chat_helpers = importlib.import_module("routes.chat_helpers")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(FRONTEND)


def _engine_pending_kinds() -> set[str]:
    """The `kind` union of the engine's PendingDecisionView (the canonical set of pending kinds)."""
    with open(os.path.join(REPO, "src", "ports", "GameSession.ts"), encoding="utf-8") as f:
        ts = f.read()
    start = ts.index("interface PendingDecisionView {")
    end = ts.index("by: NamedRef", start)
    block = ts[start:end]
    return set(re.findall(r'"([a-z-]+)"', block))


def test_pending_kind_hints_are_all_real_engine_kinds():
    engine_kinds = _engine_pending_kinds()
    # Sanity: the parser found the real union (not a fragment).
    assert len(engine_kinds) >= 12, f"parsed too few pending kinds ({engine_kinds}) — parser drift"
    hint_keys = set(chat_helpers._PENDING_KIND_HINTS.keys())
    assert hint_keys, "no pending-kind hints — chat_helpers._PENDING_KIND_HINTS shape changed"
    bogus = sorted(hint_keys - engine_kinds)
    assert not bogus, (
        f"_PENDING_KIND_HINTS keys are not real PendingDecisionView kinds: {bogus} — a typo/renamed "
        "kind silently falls back to the generic hint and its specific steering is dead"
    )


def test_comp_round_hint_encodes_the_once_only_ruling():
    hint = chat_helpers._PENDING_KIND_HINTS.get("comp-round")
    assert hint, "the comp-round pending hint is missing"
    low = hint.lower()
    # The engine ruling (0006 staged-rounds): approach is declared ONCE, up front, and locked — the
    # later elimination rounds are NOT a fresh choice each round. The hint must carry that semantics
    # so the model does not re-ask the player's approach as the field narrows.
    assert "once" in low, "comp-round hint must say the approach is declared ONCE"
    assert "not a fresh choice each round" in low, (
        "comp-round hint must state the later rounds are NOT a fresh choice each round"
    )
    assert "never re-ask" in low or "not re-ask" in low, (
        "comp-round hint must forbid re-asking the approach as the field thins"
    )


def test_comp_round_pending_kind_is_a_real_engine_kind():
    # The specific kind the once-only ruling is about must exist in the engine (belt-and-suspenders
    # with the general test above, and a clear failure if `comp-round` is ever renamed engine-side).
    assert "comp-round" in _engine_pending_kinds()


def test_comp_round_hint_answers_a_non_answer_with_a_short_waiting_line():
    """ORW-543: 'next' on an open approach card must not re-narrate the scene; the hint says so and
    keeps the once-only ruling (no new engine content: the card choices are the closed set)."""
    hint = chat_helpers._PENDING_KIND_HINTS["comp-round"]
    assert "non-answer" in hint and "never a re-narrated scene" in hint
    assert "not a fresh choice each round" in hint.lower()
