"""#1659 R4 — Escalation that actually escalates (bundle failure seam 4).

The live-bundle audit (issue #1659) found the advance-stall family *diagnosed* a wedged season
but never ESCALATED: "13 advance-stall-family flags -> beltTotals['advance-stall-nudge'] = 1; the
L39b forced-advanceGame rung never fired". Root cause for the force never firing: the CONSECUTIVE
ladder (`_ADVANCE_STALL_LEVEL`) is popped clean every time the FE force-commits a beat for the
model, so a model that CHRONICALLY under-calls advanceGame is handed a fresh gentle ladder at each
new beat and the force keeps restarting from zero.

R4 (this slice) adds a SESSION-cumulative stall-flag tally (`_ADVANCE_STALL_FLAGS`) that survives
those FE cover-ups and arms the SAME L39b force once N flags accrue since the model last progressed
on its own — so the escalation actually escalates. It also pins that the markHouseguestMet belt and
the forced-tool rung reach `get_belt_totals` ONLY as APPLIED / OBSERVED fires (the success-gated
telemetry contract in `test_belt_telemetry.py`, which this file must not weaken).

Scope: FE agent-loop + belt telemetry ONLY. No engine / prompt / tool-schema / golden touch. The
error-correct-the-omission ruling holds — the belt only guarantees the SKIPPED advanceGame happens
(a closed-set progression the engine dictates); it never authors content and never forces
submitDecision, and the force stays gated on a lull + the beat-moved re-read guard.

Style: source pins over `agent_loop.py` (the escalation runs against the real engine only in the
live play-through harness) + ledger-behavioral checks over `orwell_sync_ledger`.
"""
import importlib
import os
import re

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ledger = importlib.import_module("src.orwell_sync_ledger")
al = importlib.import_module("src.agent_loop")


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


AGENT_SRC = _read("src", "agent_loop.py")


@pytest.fixture(autouse=True)
def _tmp_store(tmp_path, monkeypatch):
    """Isolate the belt-fire ledger per test (mirrors test_belt_telemetry.py)."""
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "orwell_sync_ledger.json")
    ledger._PENDING_BELTS.clear()
    yield
    ledger._PENDING_BELTS.clear()


# ══════════════════════════════════════════════════════════════════════════════
#  Part 1 — stall-flag count N (session) forces the L39b advanceGame
# ══════════════════════════════════════════════════════════════════════════════


def test_session_force_threshold_is_n3_and_never_precedes_the_consecutive_rung():
    """N≈3 (owner ruling "e.g. 3"). The session threshold is PINNED to the per-beat force rung so
    the session trigger can never fire BEFORE the consecutive rung within one beat — the model
    always gets the full gentle->firmer->forceful text ladder the first time through a beat."""
    assert al._STALL_FLAGS_BEFORE_FORCE == al._ADVANCE_FORCE_LEVEL
    assert al._STALL_FLAGS_BEFORE_FORCE >= 3  # three graduated rungs come first
    # The consecutive rung itself remains == len(nudges) (existing pin, untouched by this slice).
    assert al._ADVANCE_FORCE_LEVEL == len(al._ADVANCE_NUDGES)


def test_session_tally_forces_when_the_consecutive_ladder_keeps_getting_reset():
    """The whole point of seam 4: a chronically-under-calling model that gets force-committed at
    each beat (so `_ADVANCE_STALL_LEVEL` is popped back to 0 every beat) STILL escalates. Simulate
    N stall-nudges with the consecutive ladder reset between each; the session tally reaches the
    force threshold while the consecutive level never does."""
    key = al._belt_key("player-r4")
    al._ADVANCE_STALL_LEVEL.pop(key, None)
    al._ADVANCE_STALL_FLAGS.pop(key, None)
    try:
        forced_via_session = False
        forced_via_consecutive = False
        for _ in range(al._STALL_FLAGS_BEFORE_FORCE):
            # Read BEFORE this turn's bump, exactly like the loop does.
            level = al._ADVANCE_STALL_LEVEL.get(key, 0)
            stall_flags_prior = al._ADVANCE_STALL_FLAGS.get(key, 0)
            # The force condition (as wired in the loop).
            if level >= al._ADVANCE_FORCE_LEVEL:
                forced_via_consecutive = True
            if stall_flags_prior >= al._STALL_FLAGS_BEFORE_FORCE:
                forced_via_session = True
            # This turn's nudge bumps both counters …
            al._ADVANCE_STALL_LEVEL[key] = level + 1
            al._ADVANCE_STALL_FLAGS[key] = stall_flags_prior + 1
            # … then the FE force-commits the beat: the CONSECUTIVE ladder is popped, the SESSION
            # tally is NOT (it clears only on a genuine model advance / peer advance).
            al._ADVANCE_STALL_LEVEL.pop(key, None)
        # Through all N reset-plagued stalls the session force must NEVER have armed early (each
        # turn's read saw fewer than N accrued flags) — that lock-steps it behind the text ladder.
        assert not forced_via_session, "the session force must not arm before N flags have accrued"
        # After N reset-plagued stalls the NEXT turn's read arms the session force, and the
        # consecutive ladder — reset every beat — never did. Run that read exactly as the loop does.
        level = al._ADVANCE_STALL_LEVEL.get(key, 0)
        stall_flags_prior = al._ADVANCE_STALL_FLAGS.get(key, 0)
        if stall_flags_prior >= al._STALL_FLAGS_BEFORE_FORCE:
            forced_via_session = True
        assert level < al._ADVANCE_FORCE_LEVEL, "consecutive ladder should have been reset below the rung"
        assert stall_flags_prior >= al._STALL_FLAGS_BEFORE_FORCE, "session tally must reach the force threshold"
        assert forced_via_session, "the next turn's read must ARM the session force — seam 4's whole point"
        assert not forced_via_consecutive, "the consecutive ladder, reset each beat, must never have forced"
    finally:
        al._ADVANCE_STALL_LEVEL.pop(key, None)
        al._ADVANCE_STALL_FLAGS.pop(key, None)


def test_back_compat_non_stalling_session_never_arms_the_session_force():
    """A session that never lull-stalls keeps `_ADVANCE_STALL_FLAGS` at 0, so the session trigger
    is byte-identical to absent — no forced escalation is armed."""
    key = al._belt_key("fresh-player")
    al._ADVANCE_STALL_FLAGS.pop(key, None)
    try:
        assert al._ADVANCE_STALL_FLAGS.get(key, 0) == 0
        assert not (al._ADVANCE_STALL_FLAGS.get(key, 0) >= al._STALL_FLAGS_BEFORE_FORCE)
    finally:
        al._ADVANCE_STALL_FLAGS.pop(key, None)


def test_force_condition_wires_the_session_trigger_alongside_the_consecutive_one():
    """Source pin: the L39b force `if` gains the session trigger WITHOUT dropping the consecutive
    trigger or the previewed/undelivered guards (a targeted text nudge still wins those)."""
    assert "or _stall_flags_prior >= _STALL_FLAGS_BEFORE_FORCE" in AGENT_SRC
    assert "_level >= _ADVANCE_FORCE_LEVEL" in AGENT_SRC
    assert "and not _previewed_uncommitted and not _decision_undelivered" in AGENT_SRC


def test_session_tally_increments_next_to_the_advance_stall_nudge():
    """Source pin: the session tally is read BEFORE the bump and incremented in lock-step with the
    `advance-stall-nudge` belt fire (so a stall flag is exactly one accrued session flag)."""
    assert "_stall_flags_prior = _ADVANCE_STALL_FLAGS.get(_sl_key, 0)" in AGENT_SRC
    assert "_ADVANCE_STALL_FLAGS[_sl_key] = _stall_flags_prior + 1" in AGENT_SRC
    # The bump sits just after the stall branch's trigger count, inside the same branch. (ORW-1042 moved the `advance-stall-nudge` belt NOTE to where the
    # nudge is sent; the trigger, and the session bump beside it, are where they were.)
    trigger_at = AGENT_SRC.index("_turn_advance_nudges += 1  # the per-turn cap counts the trigger")
    bump_at = AGENT_SRC.index("_ADVANCE_STALL_FLAGS[_sl_key] = _stall_flags_prior + 1")
    assert 0 < bump_at - trigger_at < 400, "the session bump must ride the advance-stall-nudge branch"


def test_session_tally_clears_only_on_real_progress_not_an_fe_forced_commit():
    """Source pin: the session tally clears on a MODEL-driven advance and a peer advance (exactly
    two pop sites) — but NOT inside `_commit_advance_silently`'s success path, so an FE-forced
    commit does not forgive the accrued session pressure (that is what let seam-4 escalate)."""
    assert AGENT_SRC.count("_ADVANCE_STALL_FLAGS.pop(_belt_key(owner), None)") == 2
    # The model-progression reset and the peer-advance reset are the two.
    assert re.search(
        r"if _is_live_game and block\.tool_type in _PROGRESSION_TOOLS:\n"
        r"\s*_ADVANCE_STALL_LEVEL\.pop\(_belt_key\(owner\), None\)\n"
        r"\s*_ADVANCE_STALL_FLAGS\.pop\(_belt_key\(owner\), None\)",
        AGENT_SRC), "model-driven progression must clear the session tally"
    # The forced silent-commit success window (refresh beatSeq -> return True) must NOT pop it.
    refresh_at = AGENT_SRC.index("_ch3._refresh_beat_seq(owner, _adv)")
    return_true_at = AGENT_SRC.index("return True", refresh_at)
    assert "_ADVANCE_STALL_FLAGS.pop" not in AGENT_SRC[refresh_at:return_true_at], (
        "an FE-forced silent commit must NOT clear the session stall tally")


# ══════════════════════════════════════════════════════════════════════════════
#  Part 1 — the forced-advance fire is an APPLIED, success-gated belt count
# ══════════════════════════════════════════════════════════════════════════════


def test_forced_advance_note_is_gated_on_a_committed_advance():
    """Source pin (telemetry contract): the `forced-advance:*` note lives inside the silent-commit
    SUCCESS branch — after the beatSeq refresh, before `return True` — so a reconciled double-stale
    or an errored advance (`return False`) never counts a belt fire. A count = an APPLIED advance."""
    refresh_at = AGENT_SRC.index("_ch3._refresh_beat_seq(owner, _adv)")
    return_true_at = AGENT_SRC.index("return True", refresh_at)
    success_window = AGENT_SRC[refresh_at:return_true_at]
    assert '_note_belt(owner, "forced-advance:"' in success_window, (
        "the forced-advance belt must be noted only after the advance committed")
    # The two non-committing exits (reconciled double-stale, errored) return False WITHOUT a note.
    assert "return False  # board moved twice — reconciled, S1b picks it up" in AGENT_SRC
    reconciled_at = AGENT_SRC.index("_silent_advance_reconciled[0] = True")
    reconciled_return = AGENT_SRC.index("return False", reconciled_at)
    assert '_note_belt(owner, "forced-advance:"' not in AGENT_SRC[reconciled_at:reconciled_return]


def test_forced_advance_applied_fire_reaches_belt_totals():
    """Behavioral: an APPLIED forced-advance fire is aggregated by `get_belt_totals` (the
    playtest-facing 'how belt-reliant was this session' read) — advanceGame is no longer a zero in
    the rollup once the force fires."""
    ledger.note_belt_fire("player", "forced-advance:forced-stall")
    ledger.record_turn("player", session="s", turn_id="t")
    assert ledger.get_belt_totals("player") == {"forced-advance:forced-stall": 1}


# ══════════════════════════════════════════════════════════════════════════════
#  Part 2 — the premiere markHouseguestMet belt reaches beltTotals (applied-gated)
# ══════════════════════════════════════════════════════════════════════════════


def test_premiere_meet_belt_is_wired_success_gated():
    """Source pin: the premiere auto-belt notes `premiere-meet-belt` ONLY when a mark was actually
    APPLIED (`if _marks_now:`), never on a zero-mark no-op — so its beltTotals count is truthful."""
    marks_at = AGENT_SRC.index("await _auto_mark_premiere_intros(_turn_narration, owner) or 0)")
    gate_at = AGENT_SRC.index("if _marks_now:", marks_at)
    note_at = AGENT_SRC.index('_note_belt(owner, "premiere-meet-belt", _marks_now)', gate_at)
    assert gate_at < note_at, "the premiere-meet note must sit inside the `if _marks_now:` success gate"
    assert note_at - gate_at < 120, "the note must be the body of the applied-marks gate"


def test_premiere_meet_applied_fire_reaches_belt_totals():
    """Behavioral: an APPLIED premiere-meet fire (marks > 0) is aggregated by `get_belt_totals`
    (the bundle found it ABSENT — this pins that an applied fire is counted)."""
    ledger.note_belt_fire("player", "premiere-meet-belt", 3)
    ledger.record_turn("player", session="s", turn_id="t")
    assert ledger.get_belt_totals("player") == {"premiere-meet-belt": 3}


# ══════════════════════════════════════════════════════════════════════════════
#  Part 3 — the forced-tool rung shows OBSERVED fires only
# ══════════════════════════════════════════════════════════════════════════════


def test_forced_tool_choice_counts_only_on_an_observed_tool_event():
    """Source pin (twin of test_belt_telemetry's forced-tool pin): the forced-tool-choice belt is
    noted ONLY where the round's tool event was appended AND the block is the MATCHING forced tool
    — selecting the `tool_choice` wire directive is an attempt; a provider/stream failure after
    selection must never count. Cleared after one note so a repeat call never double-counts."""
    append_at = AGENT_SRC.index("tool_events.append(tool_event)")
    guard_at = AGENT_SRC.index(
        "if _forced_belt_tool and block.tool_type == _forced_belt_tool:", append_at)
    note_at = AGENT_SRC.index('_note_belt(owner, "forced-tool-choice:" + _forced_belt_tool)', guard_at)
    assert append_at < guard_at < note_at, "the forced-tool note must be gated on the forced tool landing"
    clear_at = AGENT_SRC.index("_forced_belt_tool = None", note_at)
    assert clear_at - note_at < 120, "the forced-tool marker must be cleared after one note"


def test_observed_forced_tool_fire_reaches_belt_totals():
    """Behavioral: an OBSERVED forced-tool fire is aggregated by `get_belt_totals`."""
    ledger.note_belt_fire("player", "forced-tool-choice:advanceGame")
    ledger.record_turn("player", session="s", turn_id="t")
    assert ledger.get_belt_totals("player") == {"forced-tool-choice:advanceGame": 1}
