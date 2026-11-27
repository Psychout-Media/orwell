"""ORW-1009 (prod 2026-11-26, 47 turns): the 8 `sync:dropped-fold` alarms of that session, replayed against today's ledger rule.

The coordinator's aggregate read of that session's front-end journal (counts and tool names only) gave the engine's bump causes per gap:
4x [noteMessage, recordInteraction, recordInteraction], 2x [noteMessage, resolvePlayerMove, resolvePlayerMove],
1x [noteMessage, resolvePlayerMove, recordInteraction], 1x [noteMessage, resolvePlayerMove, resolvePlayerMove, recordInteraction].
Each is the front end's OWN writes: the user's message, the move belt's `resolvePlayerMove` and the scene belt's settled `recordInteraction`.
The alarm fired, so the ledger had counted fewer writes than bumps: one dispatch per tool, the extra bump being that dispatch's own
in-game-clock society tick (ORW-1017). #3350 (merged after that session) reads it as a same-call tick or a counting miss, never a red dropped fold.
These cases pin it, so a later change to the rule cannot bring that session's eight false alarms back. Roles only."""
import importlib

import pytest

ledger = importlib.import_module("src.orwell_sync_ledger")


def _bumps(*tools, start):
    return {"bumps": [{"seq": start + i, "tool": t} for i, t in enumerate(tools)], "truncated": False}


def _classify(tools, dispatched):
    since = 10
    counted = sum(dispatched.values())  # one counted write per dispatch, all of them landed between the turns
    info = {"since": since, "before": since + len(tools), "dispatched": dispatched, "counted": counted, "counted_writes": counted}
    return ledger.classify_gap(info, _bumps(*tools, start=since + 1))


PROD_GAPS = [
    (["noteMessage", "recordInteraction", "recordInteraction"], {"noteMessage": 1, "recordInteraction": 1}),
    (["noteMessage", "resolvePlayerMove", "resolvePlayerMove"], {"noteMessage": 1, "resolvePlayerMove": 1}),
    (["noteMessage", "resolvePlayerMove", "recordInteraction"], {"noteMessage": 1, "resolvePlayerMove": 1, "recordInteraction": 1}),
    (["noteMessage", "resolvePlayerMove", "resolvePlayerMove", "recordInteraction"], {"noteMessage": 1, "resolvePlayerMove": 1, "recordInteraction": 1}),
]


@pytest.mark.parametrize("tools,dispatched", PROD_GAPS)
def test_each_prod_gap_pattern_is_explained_not_a_dropped_fold(tools, dispatched):
    out = _classify(tools, dispatched)
    assert out is not None and out["kind"] in ("counting-miss", "same-call-tick"), out  # neither raises the red dropped-fold alarm


def test_the_same_patterns_from_a_window_this_front_end_did_not_dispatch_stay_red():
    # the control: the rule still alarms when those bumps were not this front end's own writes
    for tools, _ in PROD_GAPS:
        assert _classify(tools, {"noteMessage": 1})["kind"] == "unexplained", tools
