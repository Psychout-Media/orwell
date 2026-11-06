"""A60 (#1814 R3): the agent loop's nudge-gate LATTICE, pinned. The five gates now live in src/agent_gates.py as pure functions (a verbatim extraction of the inline expressions in agent_loop). This harness
(1) compares every permutation of every gate against a FROZEN COPY of the original inline expression (so the extraction can never drift), and (2) names the situations that matter (lull / stale / runway / pending
/ progressed / cap) as explicit rows asserting today's behavior. A flipped gate goes red in both. Roles only."""
import importlib
import itertools

g = importlib.import_module("src.agent_gates")
BOOL = (False, True)


# ── frozen copies of the ORIGINAL inline expressions (agent_loop.py before the extraction) ─────────────────────
def ref_advance(n, mx, previewed, undelivered, drain, due, progressed, runway, stalled, lull, stale):
    return (n < mx and (previewed or undelivered or drain or (due and (not progressed) and not runway) or (stalled and not runway) or ((not progressed) and lull and stale and not runway)))


def ref_record(recorded, lull, talk, n, mx):
    return ((not recorded) and ((not lull) or talk) and n < mx)


def ref_move(moved, n, mx, in_user, in_narr):
    return ((not moved) and n < mx and bool(in_user or in_narr))


def ref_npc_move(npc_moved, n, mx, in_narr):
    return ((not npc_moved) and n < mx and bool(in_narr))


def ref_approach(lull, progressed, stale, emitted, n, mx):
    return (lull and (not progressed) and (not stale) and (not emitted) and n < mx)


def test_advance_matches_the_original_for_every_permutation():
    for n in (0, 2):                                       # under / at the per-turn cap of 2
        for combo in itertools.product(BOOL, repeat=9):
            prev, und, drain, due, prog, runway, stalled, lull, stale = combo
            got = g.want_advance(turn_advance_nudges=n, max_advance_nudges=2, previewed_uncommitted=prev, decision_undelivered=und, want_drain_eviction=drain,
                                 milestone_due=due, progressed=prog, runway_holding=runway, loop_stalled=stalled, is_lull=lull, stale=stale)
            assert got == ref_advance(n, 2, prev, und, drain, due, prog, runway, stalled, lull, stale), (n, combo)


def test_record_matches_the_original_and_keeps_the_thunk_lazy():
    for n, recorded, lull, talk in itertools.product((0, 2), BOOL, BOOL, BOOL):
        assert g.want_record(recorded=recorded, is_lull=lull, lull_message_carries_talk=lambda t=talk: t, turn_record_nudges=n, max_record_nudges=2) == ref_record(recorded, lull, talk, n, 2)
    # laziness: the talk check is NOT evaluated when the original would short-circuit (not a lull, or already recorded, or over the cap)
    calls = []
    def probe():
        calls.append(1)
        return True
    g.want_record(recorded=True, is_lull=True, lull_message_carries_talk=probe, turn_record_nudges=0, max_record_nudges=2)
    g.want_record(recorded=False, is_lull=False, lull_message_carries_talk=probe, turn_record_nudges=0, max_record_nudges=2)
    assert calls == [], "the thunk must not run when the original short-circuits"
    g.want_record(recorded=False, is_lull=True, lull_message_carries_talk=probe, turn_record_nudges=0, max_record_nudges=2)
    assert calls == [1]


def test_move_npc_move_and_approach_match_the_original_for_every_permutation():
    for n, moved, a, b in itertools.product((0, 1), BOOL, BOOL, BOOL):
        assert g.want_move(moved=moved, turn_move_nudges=n, max_move_nudges=1, signal_in_user_message=a, signal_in_narration=b) == ref_move(moved, n, 1, a, b)
        assert g.want_npc_move(npc_moved=moved, turn_npc_move_nudges=n, max_npc_move_nudges=1, signal_in_narration=a) == ref_npc_move(moved, n, 1, a)
    for n, lull, prog, stale, emitted in itertools.product((0, 1), BOOL, BOOL, BOOL, BOOL):
        assert g.want_approach(is_lull=lull, progressed=prog, stale=stale, emitted_visible=emitted, turn_approach_nudges=n, max_approach_nudges=1) == ref_approach(lull, prog, stale, emitted, n, 1)


# ── named situations: today's behavior, stated plainly ─────────────────────────────────────────────────────────
BASE = dict(turn_advance_nudges=0, max_advance_nudges=2, previewed_uncommitted=False, decision_undelivered=False, want_drain_eviction=False,
            milestone_due=False, progressed=False, runway_holding=False, loop_stalled=False, is_lull=False, stale=False)


def adv(**kw):
    return g.want_advance(**{**BASE, **kw})


def test_advance_situations():
    assert adv() is False, "an ordinary engaged turn with nothing pending does not nudge an advance"
    assert adv(is_lull=True) is False and adv(is_lull=True, stale=True) is True, "a lull nudges an advance only once the beat is STALE"
    assert adv(is_lull=True, stale=True, runway_holding=True) is False, "the social runway holding suppresses the stale-lull advance"
    assert adv(milestone_due=True) is True, "a due scheduled event is advanced"
    assert adv(milestone_due=True, runway_holding=True) is False, "...unless the runway is holding"
    assert adv(milestone_due=True, progressed=True) is False, "...and never when this turn already progressed"
    assert adv(loop_stalled=True) is True and adv(loop_stalled=True, runway_holding=True) is False
    assert adv(previewed_uncommitted=True, runway_holding=True) is True, "a previewed-but-uncommitted beat is committed even under a runway hold"
    assert adv(decision_undelivered=True, progressed=True) is True, "an undelivered decision is nudged even after progress"
    assert adv(want_drain_eviction=True, runway_holding=True) is True
    assert adv(turn_advance_nudges=2, previewed_uncommitted=True) is False, "the per-turn cap beats every reason"


def test_record_move_approach_situations():
    thunk = lambda v: (lambda: v)
    assert g.want_record(recorded=False, is_lull=False, lull_message_carries_talk=thunk(False), turn_record_nudges=0, max_record_nudges=1) is True, "an engaged (non-lull) turn that recorded nothing is nudged"
    assert g.want_record(recorded=False, is_lull=True, lull_message_carries_talk=thunk(False), turn_record_nudges=0, max_record_nudges=1) is False, "a lull with no talk records nothing"
    assert g.want_record(recorded=False, is_lull=True, lull_message_carries_talk=thunk(True), turn_record_nudges=0, max_record_nudges=1) is True, "a lull whose message carries real talk still counts"
    assert g.want_record(recorded=True, is_lull=False, lull_message_carries_talk=thunk(True), turn_record_nudges=0, max_record_nudges=1) is False, "a model-recorded scene is never double-recorded"
    assert g.want_move(moved=True, turn_move_nudges=0, max_move_nudges=1, signal_in_user_message=True, signal_in_narration=True) is False, "a model-driven move always wins"
    assert g.want_move(moved=False, turn_move_nudges=0, max_move_nudges=1, signal_in_user_message=False, signal_in_narration=True) is True, "the narration alone can trigger the player-move belt (PARITY-2)"
    assert g.want_npc_move(npc_moved=False, turn_npc_move_nudges=0, max_npc_move_nudges=1, signal_in_narration=False) is False
    assert g.want_approach(is_lull=True, progressed=False, stale=False, emitted_visible=False, turn_approach_nudges=0, max_approach_nudges=1) is True, "the lingering window: a lull, not yet stale, nothing shown yet"
    assert g.want_approach(is_lull=True, progressed=False, stale=True, emitted_visible=False, turn_approach_nudges=0, max_approach_nudges=1) is False, "once stale, the advance nudge takes over"
    assert g.want_approach(is_lull=True, progressed=False, stale=False, emitted_visible=True, turn_approach_nudges=0, max_approach_nudges=1) is False, "one narration per turn: never re-prompt after a visible scene"
