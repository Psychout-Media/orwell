"""The PENDING-DECISION BARRIER covers EVERY player decision kind (the chat↔engine DESYNC gate).

The Python half of the standing chat↔engine sync audit (the TS half lives in
`tests/integration/syncAudit.test.ts`). CI cannot drive the real, non-deterministic LLM, so we
do not test the narration itself — we test the thing that PREVENTS desync deterministically: the
pending-decision barrier (`routes.chat_helpers._pending_barrier_directive`). When the engine sits
BLOCKED on a player decision, the barrier is the forceful GM directive that HARD-BLOCKS the model
from narrating PAST it (no new day / week / ceremony) — the fix for the live bug where the GM
role-played into the next week while the engine waited on a goodbye-message.

A barrier that covered only the kinds we happened to think of would silently let a NEW (or rarer)
player pending slip past — and that single gap is a desync. So this gate asserts that for EVERY
player decision kind the engine can raise, the barrier returns a forceful, well-formed directive.
The decision-kind set is `routes.orwell_routes._DECISION_KINDS` / `PendingDecisionView.kind`
(src/ports/GameSession.ts); we pin the full list here so a new engine kind that isn't covered
trips this test.

Mirrors the import/style of `frontend/tests/test_pending_barrier.py`. Roles only — no names.
"""

import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")


# The COMPLETE set of player decision kinds the engine can block on (frontend/routes/orwell_routes.py
# `_DECISION_KINDS`, mirrored by src/ports/GameSession.ts `PendingDecisionView.kind`). Pinned here so
# a new engine decision kind that the barrier does not cover fails this gate.
_DECISION_KINDS = [
    "nominations",
    "veto-decision",
    "comp-intent",
    "comp-round",  # 0006 staged-rounds: the per-round competition approach
    "houseguests-choice",
    "replacement",
    "eviction-vote",
    "tie-break",
    "final-eviction",
    "goodbye-message",
    "finale-statement",
    "finale-answer",
    "juror-question",
    "juror-vote",
    # 0130: the player-evictee's exit interview (posture + optional words) rides the same seam.
    "exit-interview",
    # 0133: an early-evicted player's spectator choice and finale-night interview (both real pendings).
    "spectator-choice",
    "finale-interview",
    # 0061: the confirmed self-eviction rides the same validated decision seam (and gets the barrier).
    "self-evict",
    # 0025: the reactive-twist secret veto (the holder's private play / hold).
    "secret-veto",
    # 0123: the player's in-chat answer to a houseguest's deal offer. Accepted by every relay, but per
    # the PO ruling (2026-11-01) it is NEVER a pending card — so it is not barrier-covered below.
    "deal-offer",
    # ORW-281 4a: a WATCH step of a staged ceremony (answered by advanceGame; the engine refuses submitDecision for it).
    "ceremony-step",
]
# The kinds the engine can actually BLOCK on as a pending (deal-offer is open state, never a pending).
_PENDING_KINDS = [k for k in _DECISION_KINDS if k != "deal-offer"]


def _barrier_for(kind: str) -> str:
    """Build the barrier for one player pending of `kind` (a player decider, with a prompt)."""
    return chat_helpers._pending_barrier_directive(
        {"kind": kind, "by": {"id": "player", "name": "P"}, "prompt": "do the thing"}
    )


def test_no_pending_returns_none():
    """No player pending → no barrier (the turn is framed exactly as before)."""
    assert chat_helpers._pending_barrier_directive(None) is None


def test_decision_kinds_list_matches_the_engine_set():
    """Keep this gate's pinned list in lockstep with the engine's _DECISION_KINDS. If the engine
    grows a new decision kind, this surfaces the drift here (so the per-kind coverage below is
    actually exhaustive). Read the route module's set without importing the heavy app."""
    # Every relay (REST, WS, the model's tool) reads ONE source now — orwell_engine.DECISION_KINDS
    # (PR C, 2026-11: three hand-copied sets had drifted and rejected deal-offer/secret-veto).
    # test_decision_kinds_master.py pins that source to the engine union; this gate pins it to its list.
    from src.orwell_engine import DECISION_KINDS

    assert set(DECISION_KINDS) == set(_DECISION_KINDS), (
        "orwell_engine.DECISION_KINDS drifted from this gate's pinned list "
        f"(engine-only={set(DECISION_KINDS) - set(_DECISION_KINDS)}, "
        f"gate-only={set(_DECISION_KINDS) - set(DECISION_KINDS)}) — update both."
    )
    assert "exit-interview" in DECISION_KINDS  # issue #1864


def test_every_player_decision_kind_gets_a_forceful_barrier():
    """The core gate: NO player pending kind may slip the barrier. For each kind the barrier must
    (i) name the decision/kind, and (ii) forbid advancing past it — the desync language plus an
    explicit time-skip ban (no new week / day / ceremony)."""
    for kind in _PENDING_KINDS:
        out = _barrier_for(kind)
        assert out and isinstance(out, str), f"{kind}: barrier was empty / not a string"
        low = out.lower()

        # (i) it NAMES the decision/kind.
        assert kind in out, f"{kind}: barrier does not name the decision kind"

        # (ii) it FORBIDS advancing past the decision — the desync language is present.
        assert "desync" in low, f"{kind}: barrier missing the 'desync' language"
        assert (
            "not allowed" in low or "forbidden" in low or "not" in low
        ), f"{kind}: barrier does not forbid advancing"
        assert "past this decision" in low or "past it" in low, (
            f"{kind}: barrier does not reference advancing PAST the decision"
        )

        # ...and it explicitly forbids a new week / day / ceremony time-skip (the live bug was the
        # GM skipping into the NEXT WEEK past a pending).
        assert "new day" in low, f"{kind}: barrier does not forbid a new day"
        assert "next week" in low, f"{kind}: barrier does not forbid advancing to the next week"
        assert "ceremony" in low, f"{kind}: barrier does not forbid a new ceremony"

        # ...and it pins the model to taking the player's choice via the engine.
        assert "submitDecision" in out, f"{kind}: barrier does not steer to submitDecision"


def test_barrier_names_the_decider_and_quotes_the_engine_prompt():
    """The barrier identifies WHO must decide and quotes the engine's own instruction, for each
    kind — so the model is pinned to the SPECIFIC pending, never a generic stall."""
    for kind in _PENDING_KINDS:
        out = chat_helpers._pending_barrier_directive(
            {"kind": kind, "by": {"id": "player", "name": "P"}, "prompt": "Make the call now."}
        )
        assert out, f"{kind}: no barrier"
        assert "P" in out, f"{kind}: barrier does not name the decider"
        assert "Make the call now." in out, f"{kind}: barrier does not quote the engine prompt"
