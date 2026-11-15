"""Answers for every pending decision kind the engine can emit, for the real-loop tests that drive a game by hand (test_a64_week1_clock_real_loop).
Mirrors `features/support/answerPending.ts`. Kept free of heavy imports so a plain (non-browser) test can check it covers the engine's whole kind list. Roles only."""

# Kinds that are INTENTIONALLY never auto-answered by a shared driver (the engine surfaces a floated deal through chat; self-evict is the OOC walk-out confirmation).
NEVER_AUTO_ANSWERED = frozenset({"deal-offer", "self-evict", "ceremony-step"})  # ceremony-step (ORW-281 4a): a watch step, answered by advanceGame, never a decision


def _first(p):
    opts = [o["id"] for o in (p.get("options") or [])]
    return opts[0] if opts else None


def _stance(p, default):
    return (p.get("stances") or [None])[0] or _first(p) or default


ANSWERS = {
    "comp-round": lambda p: {"kind": "comp-round", "intent": "compete"},
    "comp-intent": lambda p: {"kind": "comp-intent", "intent": "compete"},
    "nominations": lambda p: {"kind": "nominations", "choice": [o["id"] for o in (p.get("options") or [])][:2]},
    "veto-decision": lambda p: {"kind": "veto-decision", "use": False},
    "replacement": lambda p: {"kind": "replacement", "replacement": _first(p)},
    "houseguests-choice": lambda p: {"kind": "houseguests-choice", "vote": _first(p)},
    "eviction-vote": lambda p: {"kind": "eviction-vote", "vote": _first(p)},
    "tie-break": lambda p: {"kind": "tie-break", "vote": _first(p)},
    "final-eviction": lambda p: {"kind": "final-eviction", "vote": _first(p)},
    "juror-vote": lambda p: {"kind": "juror-vote", "vote": _first(p)},
    "goodbye-message": lambda p: {"kind": "goodbye-message", "vote": _first(p) or "respectful"},
    "exit-interview": lambda p: {"kind": "exit-interview", "vote": _stance(p, "gracious")},
    "spectator-choice": lambda p: {"kind": "spectator-choice", "vote": "watch"},
    "finale-interview": lambda p: {"kind": "finale-interview", "vote": _stance(p, "gracious")},
    "juror-question": lambda p: {"kind": "juror-question", "statement": "What was your biggest move?"},
    "finale-statement": lambda p: {"kind": "finale-statement", "statement": "I played my own game."},
    "finale-answer": lambda p: {"kind": "finale-answer", "appeal": (p.get("appeals") or ["own-game"])[0]},
    "secret-veto": lambda p: {"kind": "secret-veto", "use": False},
}


def answer_for(p):
    """The submitDecision request that answers pending `p`. Raises (never defaults) on a kind with no answer, so a new engine kind fails loudly."""
    k = p["kind"]
    if k not in ANSWERS:
        raise KeyError(f"no scripted answer for pending kind {k!r} - add it to tests/_a64_decisions.py (or NEVER_AUTO_ANSWERED)")
    return ANSWERS[k](p)
