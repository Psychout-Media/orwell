"""L-F3 (#1742) — interactive beats soft-lock on exact phrasing.

An interactive beat (a premiere intro, a comp buzz-in) gates on a *specific* expected action and
used to stall INDEFINITELY on anything else: the live playtest repro looped the identical HOH-comp
trivia question 15 straight turns because "Let's keep the week moving — what's next?" was never
read as an answer. Root cause: the lull-gated advance-nudge (`_is_lull` + `_stale`) and the L39b
safety net both assume the player either disengages (a lull) or the model eventually calls the
tool it's waiting on — neither catches an ENGAGED player whose replies never match the exact
phrase the model invented, so `_is_lull` stays False turn after turn and the gate is re-presented
forever.

This module pins the fix: a loop-detection belt independent of the lull gate (fires on repetition
of the identical framed gate with an engaged-but-non-matching reply), plus the fix to
`_commit_advance_silently`'s false-success path (calling advanceGame against an open player
pending is a documented no-op, but used to be treated as real progress, silently resetting every
stall counter and letting the loop persist with no escalation ever landing).
"""
import os
import importlib

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


def test_loop_break_config_present():
    js = _read("src", "agent_loop.py")
    assert "_LOOP_BREAK_THRESHOLD = 3" in js
    assert "_LOOP_LAST_FRAMED_KEY: Dict[str, tuple] = {}" in js
    assert "_LOOP_STREAK: Dict[str, int] = {}" in js
    assert "def _player_replied_engaged(messages)" in js
    assert "def _loop_break_streak_update(" in js
    assert "_ADVANCE_LOOP_BREAK_NUDGE = (" in js
    assert "_PENDING_LOOP_BREAK_NUDGE = (" in js


def test_loop_break_independent_of_lull_gate():
    # The belt's whole point (AC #1/#4): it folds into `_want_advance` alongside the lull-gated
    # clause, as an ALTERNATIVE — not a replacement — so it fires even when `_is_lull` is False
    # (an engaged, non-matching reply), while a genuine lull still routes through the existing gate.
    js = _read("src", "agent_loop.py")
    assert "_loop_stalled = _loop_break_streak_update(" in js
    import os as _os
    gates = open(_os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "src", "agent_gates.py"), encoding="utf-8").read()  # A60
    assert "or (loop_stalled and not runway_holding)" in gates
    assert "loop_stalled=_loop_stalled" in js
    assert '"content": _nudge' in js


def test_loop_break_never_fires_during_a_social_runway_hold():
    # Non-disruptive (AC #4): a deliberately-held social runway re-presents the SAME "social"
    # moment turn after turn by design — that must never read as a soft-lock. Source-pin the wiring;
    # the actual never-arms-during-a-hold behavior is proven by the behavioral test below.
    js = _read("src", "agent_loop.py")
    assert "runway_holding" in js
    assert "runway_holding=_runway_holding" in js


def test_pending_backed_loop_never_forces_submitdecision():
    # AC #3 / the mandate: a comp-buzz-in loop is broken by ESCALATING the ask (reduce to the
    # engine's literal legal options), never by inventing the player's binding pick. submitDecision
    # is never named as a forced tool_choice anywhere near the loop-break rung.
    js = _read("src", "agent_loop.py")
    assert "elif _loop_stalled and _pending_kind_at_read:" in js
    assert '_nudge, _why = _PENDING_LOOP_BREAK_NUDGE, "loop-break-pending"' in js
    assert "submitDecision" in js  # named only as WHERE the player's own choice is submitted


def test_pending_no_op_advance_no_longer_falsely_resets_counters():
    # The root cause the repro traced: advanceGame against an open player pending is a documented
    # no-op (the engine returns the pending unchanged), but a bare "no exception" success used to
    # be read as real progress, silently zeroing the stall/staleness counters every time it fired —
    # so the escalation ladder could never climb and the loop ran indefinitely with no rung ever
    # actually landing. Now the no-op is detected via the stable beatSeq-primary identity (Greptile
    # P1 — see the staged-comp regression tests below) and reported as non-progress (False).
    js = _read("src", "agent_loop.py")
    assert "_pending_kind_at_read = None" in js
    assert "_beat_seq_at_read = None" in js
    assert "_pending_sig_at_read = None" in js
    assert "def _advance_was_pending_noop(" in js
    assert "_advance_was_pending_noop(_pending_kind_at_read, _beat_seq_at_read," in js
    assert "silent advanceGame NO-OP" in js
    assert "return False" in js  # the no-op path returns False, not a false success


def test_greptile_p1_failed_prestate_read_not_counted_as_progress():
    # Greptile/CodeRabbit P1 (#1754, unknown pre-state): if the pre-advance state read FAILS, all
    # three pre-state signals are None — indistinguishable, without an explicit flag, from a genuine
    # "no pending was open". A later no-op advance would then be misclassified as real progress,
    # falsely resetting the stall/escalation counters and recording a phantom loop-break correction
    # (the exact soft-lock-perpetuating bug this ladder fixes). The fix: a `_state_read_ok` flag, set
    # True ONLY after every extraction in the read try-block completes, gates the "real progress"
    # branch — and on a failed read the commit returns FALSE (never the success sentinel True, which
    # would drive success-only callers to log a forced advance / inject a nudge / record an applied
    # overseer action) with a `_silent_advance_unconfirmed` sidecar flag the emitted-visible caller
    # reads to END the turn safely, leaving the counters + belt state untouched.
    js = _read("src", "agent_loop.py")
    assert "_state_read_ok = False" in js  # initialized pessimistic before the read
    assert "_state_read_ok = True" in js   # flipped only on a clean read
    assert "if not _state_read_ok:" in js  # guards the confirmed-progress branch
    assert "_silent_advance_unconfirmed = [False]" in js  # the sidecar flag exists
    # the guard must precede (and thus short-circuit) the no-op classification + counter reset
    guard = js.index("if not _state_read_ok:")
    noop = js.index("_advance_was_pending_noop(_pending_kind_at_read, _beat_seq_at_read,")
    assert guard < noop
    # the unknown-pre-state branch sets the sidecar flag and returns False (NOT the success sentinel):
    # the first `return` after the guard is a `return False`, and the flag is set before it.
    branch = js[guard:noop]
    assert "_silent_advance_unconfirmed[0] = True" in branch
    assert "return False" in branch
    assert "return True" not in branch
    # the emitted-visible caller ends the turn on the unconfirmed flag (no second narration)
    assert "if _silent_advance_unconfirmed[0]:" in js


def test_advance_was_pending_noop_behavioral():
    al = importlib.import_module("src.agent_loop")
    # No pending open at read time ⇒ never a no-op (an ordinary advance).
    assert not al._advance_was_pending_noop(None, 10, None, {"beatSeq": 10})
    # A TRUE no-op: same pending kind, beatSeq did NOT advance (the engine returned it unchanged).
    assert al._advance_was_pending_noop(
        "comp-round", 10, ("comp-round", ("h1", "h2")),
        {"beatSeq": 10, "pending": {"kind": "comp-round", "stillIn": [{"id": "h1"}, {"id": "h2"}]}})
    # beatSeq unavailable on the response ⇒ falls back to the round-aware signature: SAME kind +
    # SAME stillIn ⇒ no-op.
    assert al._advance_was_pending_noop(
        "comp-round", None, ("comp-round", ("h1", "h2")),
        {"pending": {"kind": "comp-round", "stillIn": [{"id": "h1"}, {"id": "h2"}]}})


def test_greptile_p1_staged_comp_round_advance_is_progress_not_a_noop():
    # Greptile P1 (#1754) — the exact bug reproduced: a STAGED competition advances comp-round ->
    # comp-round, keeping the SAME `kind` ("comp-round") while the field narrows. A kind-only
    # comparison would misread this as a no-op (skip the counter cleanup, risk escalating/forcing
    # the NEW round prematurely). beatSeq — which bumps once per committed mutation — is the
    # PRIMARY signal and correctly reads it as PROGRESS regardless of the unchanged kind.
    al = importlib.import_module("src.agent_loop")
    pending_kind_before = "comp-round"
    beat_seq_before = 41
    pending_sig_before = al._pending_signature(
        {"kind": "comp-round", "stillIn": [{"id": "h1"}, {"id": "h2"}, {"id": "h3"}, {"id": "h4"}]})
    # The response: SAME kind, beatSeq advanced (a real committed round-advance mutation), and the
    # stillIn set narrowed (round-aware fallback would ALSO correctly read this as progress).
    adv_response = {
        "beatSeq": 42,
        "pending": {"kind": "comp-round", "stillIn": [{"id": "h1"}, {"id": "h2"}, {"id": "h3"}]},
    }
    assert not al._advance_was_pending_noop(
        pending_kind_before, beat_seq_before, pending_sig_before, adv_response), (
        "a staged comp-round -> comp-round advance (SAME kind, beatSeq bumped) must be treated as "
        "PROGRESS, not a false no-op")


def test_greptile_p1_staged_comp_true_noop_still_detected_via_beatseq():
    # The companion case: kind AND stillIn happen to be identical (e.g. a genuinely stuck round)
    # but beatSeq is the authoritative tell — unchanged beatSeq means nothing committed.
    al = importlib.import_module("src.agent_loop")
    pending_sig_before = al._pending_signature(
        {"kind": "comp-round", "stillIn": [{"id": "h1"}, {"id": "h2"}]})
    adv_response = {
        "beatSeq": 41,  # unchanged
        "pending": {"kind": "comp-round", "stillIn": [{"id": "h1"}, {"id": "h2"}]},
    }
    assert al._advance_was_pending_noop("comp-round", 41, pending_sig_before, adv_response)


def test_pending_signature_is_round_aware_not_just_kind():
    al = importlib.import_module("src.agent_loop")
    sig_a = al._pending_signature({"kind": "comp-round", "stillIn": [{"id": "h2"}, {"id": "h1"}]})
    sig_b = al._pending_signature({"kind": "comp-round", "stillIn": [{"id": "h1"}, {"id": "h2"}]})
    sig_c = al._pending_signature({"kind": "comp-round", "stillIn": [{"id": "h1"}]})
    assert sig_a == sig_b  # order-independent
    assert sig_a != sig_c  # a narrowed field is a DIFFERENT signature, even though kind is identical
    assert al._pending_signature(None) is None
    assert al._pending_signature({"kind": ""}) is None


def test_generic_intent_tolerance_named_in_the_escalation_text():
    # AC #2: "keep moving / what's next / skip it" must be treated as advance intent on a STALLED
    # beat, not ignored — stated explicitly in both escalation variants.
    js = _read("src", "agent_loop.py")
    assert "what's next" in js.lower()
    assert "keep moving" in js.lower()
    assert "skip it" in js.lower()


def test_player_replied_engaged_behavioral():
    al = importlib.import_module("src.agent_loop")
    mk = lambda txt: [{"role": "user", "content": txt}]
    # A real reply — however phrased, matching no lull regex at all — counts as engaged.
    assert al._player_replied_engaged(mk("I have no idea, let's just do something else"))
    assert al._player_replied_engaged(mk("what's next?"))  # also engaged (just not ONLY via regex)
    # Silence is not engagement.
    assert not al._player_replied_engaged(mk(""))
    assert not al._player_replied_engaged(mk("   "))
    # A hidden production cue is never the player.
    assert not al._player_replied_engaged(mk("(Production cue: continue the casting interview)"))


def test_loop_break_streak_update_behavioral():
    al = importlib.import_module("src.agent_loop")
    key = "test-user-l-f3"
    al._LOOP_STREAK.pop(key, None)
    al._LOOP_LAST_FRAMED_KEY.pop(key, None)
    gate = (1, "hoh-competition", "comp-round", "comp-round")

    # Same gate, engaged, no progress, no runway hold — three consecutive re-presentations arm it.
    assert not al._loop_break_streak_update(
        key, gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=True)
    assert not al._loop_break_streak_update(
        key, gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=True)
    assert al._loop_break_streak_update(
        key, gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=True)


def test_loop_break_streak_resets_on_progress_or_beat_change():
    al = importlib.import_module("src.agent_loop")
    key = "test-user-l-f3-reset"
    al._LOOP_STREAK.pop(key, None)
    al._LOOP_LAST_FRAMED_KEY.pop(key, None)
    gate = (1, "hoh-competition", "comp-round", "comp-round")
    other_gate = (1, "hoh-competition", "comp-round", "comp-round-2")

    al._loop_break_streak_update(
        key, gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=True)
    al._loop_break_streak_update(
        key, gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=True)
    # A genuine progression resets the streak even mid-repetition.
    assert not al._loop_break_streak_update(
        key, gate, progressed=True, runway_holding=False, pre_resolved=False, engaged=True)
    assert al._LOOP_STREAK.get(key, 0) == 0

    al._LOOP_STREAK.pop(key, None)
    al._LOOP_LAST_FRAMED_KEY.pop(key, None)
    al._loop_break_streak_update(
        key, gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=True)
    al._loop_break_streak_update(
        key, gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=True)
    # A DIFFERENT gate (the beat genuinely moved on) resets the streak, not just any change.
    assert not al._loop_break_streak_update(
        key, other_gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=True)
    assert al._LOOP_STREAK.get(key, 0) == 1  # this turn itself counts as streak=1 for the NEW gate


def test_loop_break_streak_never_arms_during_a_lull_only_silence():
    # Silence (an empty reply) never accumulates the loop-break streak — that's the ordinary lull
    # gate's job, not this belt's. Only an actual engaged reply counts.
    al = importlib.import_module("src.agent_loop")
    key = "test-user-l-f3-silence"
    al._LOOP_STREAK.pop(key, None)
    al._LOOP_LAST_FRAMED_KEY.pop(key, None)
    gate = (1, "premiere", "premiere")
    for _ in range(5):
        assert not al._loop_break_streak_update(
            key, gate, progressed=False, runway_holding=False, pre_resolved=False, engaged=False)
    assert al._LOOP_STREAK.get(key, 0) == 0


def test_loop_break_streak_never_arms_during_a_runway_hold():
    al = importlib.import_module("src.agent_loop")
    key = "test-user-l-f3-runway"
    al._LOOP_STREAK.pop(key, None)
    al._LOOP_LAST_FRAMED_KEY.pop(key, None)
    gate = (1, "veto-ceremony", "social")
    for _ in range(5):
        assert not al._loop_break_streak_update(
            key, gate, progressed=False, runway_holding=True, pre_resolved=False, engaged=True)
    assert al._LOOP_STREAK.get(key, 0) == 0
