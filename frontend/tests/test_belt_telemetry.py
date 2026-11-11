"""Product gap #3 — belt-fire telemetry (docs/design/undercall-seam-structural.md §5).

Every FE guardrail belt that error-corrects a model under-call now COUNTS its firing in the
Vault-free 0065 sync ledger, so playtests can MEASURE belt reliance instead of feeling it:

  * ``orwell_sync_ledger.note_belt_fire(user, belt)`` — fail-soft in-memory buffer (names +
    small counts only; the same coercion floor as every ledger field);
  * ``record_turn`` drains the buffer into the turn entry's ``beltsFired`` map;
  * ``get_belt_totals(user)`` — ring + pending aggregate, per-user scoped.

Also pins (source-level) that every named belt call site actually notes its fire, and that the
agent-loop helper is fail-soft. Roles only — belt/tool NAMES are app capabilities, never a body.

T0-4 (telemetry + probe arm, docs/audits/2026-07-21-campaign-report-and-exhaustive-backlog.md)
adds a SIBLING, ATTEMPT-counted dimension for forced ``tool_choice`` specifically — a live
playtest logged 20 forced selections against only 7 honored ``beltsFired`` counts, and the
ledger had no record of the other 13 at all. ``note_forced_choice`` / ``forcedChoice`` /
``get_forced_choice_totals`` record EVERY resolved attempt with an honored/ignored outcome,
additive to (never redefining) the success-gated ``note_belt_fire`` contract above.
"""

import importlib
import os

import pytest

ledger = importlib.import_module("src.orwell_sync_ledger")

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@pytest.fixture(autouse=True)
def _tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "orwell_sync_ledger.json")
    ledger._PENDING_BELTS.clear()
    ledger._PENDING_FORCED.clear()
    yield
    ledger._PENDING_BELTS.clear()
    ledger._PENDING_FORCED.clear()


# ── the buffer → record_turn drain ───────────────────────────────────────────────────────────


def test_noted_fires_drain_into_the_next_recorded_turn():
    ledger.note_belt_fire("player", "auto-record-scene")
    ledger.note_belt_fire("player", "auto-record-scene")
    ledger.note_belt_fire("player", "forced-tool-choice:advanceGame")
    ledger.record_turn("player", session="s", turn_id="t")
    e = ledger.get_recent("player")[0]
    assert e["beltsFired"] == {"auto-record-scene": 2, "forced-tool-choice:advanceGame": 1}
    # drained: a second turn with no new fires records an empty map
    ledger.record_turn("player", session="s", turn_id="t2")
    assert ledger.get_recent("player")[-1]["beltsFired"] == {}


def test_explicit_belts_fired_arg_merges_with_the_buffer():
    ledger.note_belt_fire("player", "casting-nudge")
    ledger.record_turn("player", session="s", turn_id="t",
                       belts_fired={"casting-nudge": 1, "advance-stall-nudge": 3})
    e = ledger.get_recent("player")[0]
    assert e["beltsFired"] == {"casting-nudge": 2, "advance-stall-nudge": 3}


def test_multi_count_note_and_default_n():
    ledger.note_belt_fire("player", "premiere-meet-belt", 4)
    ledger.record_turn("player", session="s", turn_id="t")
    assert ledger.get_recent("player")[0]["beltsFired"] == {"premiere-meet-belt": 4}


# ── the Vault-free coercion floor ────────────────────────────────────────────────────────────


def test_belt_names_are_clipped_and_counts_coerced():
    big = "belt " + "x" * 500
    ledger.note_belt_fire("player", big)
    ledger.note_belt_fire("player", "ok-belt", "not-a-number")  # coerces to 0 ⇒ dropped
    ledger.note_belt_fire("player", "neg-belt", -5)  # non-positive ⇒ dropped
    ledger.note_belt_fire("player", "", 3)  # empty name ⇒ dropped
    ledger.record_turn("player", session="s", turn_id="t")
    belts = ledger.get_recent("player")[0]["beltsFired"]
    assert list(belts.values()) == [1]
    (name,) = belts.keys()
    assert len(name) <= ledger._MAX_NAME_LEN  # a body can never ride a belt name


def test_belt_map_is_bounded_at_the_name_cap():
    for i in range(ledger._MAX_NAMES + 20):
        ledger.note_belt_fire("player", f"belt-{i}")
    ledger.record_turn("player", session="s", turn_id="t")
    assert len(ledger.get_recent("player")[0]["beltsFired"]) <= ledger._MAX_NAMES


def test_garbage_belts_fired_arg_records_empty_map():
    ledger.record_turn("player", session="s", turn_id="t", belts_fired="not-a-dict")
    assert ledger.get_recent("player")[0]["beltsFired"] == {}


def test_note_belt_fire_never_raises_on_garbage():
    class _Evil:
        def __str__(self):
            raise RuntimeError("no name for you")
    ledger.note_belt_fire("player", _Evil())
    ledger.note_belt_fire("player", None)
    ledger.note_belt_fire(None, "default-belt")  # missing user maps to "default"


# ── get_belt_totals: ring + pending, per-user scoped ─────────────────────────────────────────


def test_belt_totals_sum_the_ring_and_the_pending_buffer():
    ledger.note_belt_fire("player", "auto-record-scene")
    ledger.record_turn("player", session="s", turn_id="t1")  # → ring
    ledger.note_belt_fire("player", "auto-record-scene")
    ledger.record_turn("player", session="s", turn_id="t2")  # → ring
    ledger.note_belt_fire("player", "auto-record-scene")     # still pending (no turn yet)
    ledger.note_belt_fire("player", "casting-nudge")         # pending only
    totals = ledger.get_belt_totals("player")
    assert totals == {"auto-record-scene": 3, "casting-nudge": 1}


def test_belt_totals_are_per_user_isolated():
    ledger.note_belt_fire("player-a", "auto-record-scene")
    ledger.note_belt_fire("player-b", "casting-nudge")
    assert ledger.get_belt_totals("player-a") == {"auto-record-scene": 1}
    assert ledger.get_belt_totals("player-b") == {"casting-nudge": 1}
    assert ledger.get_belt_totals("player-c") == {}


def test_no_auth_default_bucket_is_measurable_without_a_recorded_turn():
    # Under AUTH_ENABLED=false the belts note under user=None → the "default" sentinel; even
    # though the loop's ledger hook records nothing without an owner, totals stay readable.
    ledger.note_belt_fire(None, "advance-stall-nudge")
    assert ledger.get_belt_totals(None) == {"advance-stall-nudge": 1}
    assert ledger.get_belt_totals("default") == {"advance-stall-nudge": 1}


def test_clear_drops_the_pending_buffer_too():
    ledger.note_belt_fire("player", "auto-record-scene")
    ledger.record_turn("player", session="s", turn_id="t")
    ledger.note_belt_fire("player", "auto-record-scene")
    ledger.clear("player")
    assert ledger.get_belt_totals("player") == {}


def test_log_line_carries_the_belt_counts(caplog):
    import logging
    ledger.note_belt_fire("player", "auto-record-scene", 2)
    with caplog.at_level(logging.INFO, logger="src.orwell_sync_ledger"):
        ledger.record_turn("player", session="s", turn_id="t")
    lines = [r.getMessage() for r in caplog.records if "sync-ledger turn" in r.getMessage()]
    assert len(lines) == 1 and "auto-record-scene:2" in lines[0]


# ── T0-4: ATTEMPT-counted forced-tool_choice telemetry (honored/ignored outcome) ────────────────
# Additive sibling to note_belt_fire/beltsFired/get_belt_totals above — those keep their existing
# success-gated contract untouched (every test above still passes unmodified). This dimension
# answers the denominator question success-gating structurally can't: how many forced selections
# were ATTEMPTED, and of those, how many actually landed (honored) vs were ignored.


def test_note_forced_choice_counts_honored_and_ignored_separately():
    ledger.note_forced_choice("player", "advanceGame", honored=True)
    ledger.note_forced_choice("player", "advanceGame", honored=True)
    ledger.note_forced_choice("player", "advanceGame", honored=False)
    ledger.note_forced_choice("player", "runCompetition", honored=False)
    totals = ledger.get_forced_choice_totals("player")
    assert totals == {
        "advanceGame": {"honored": 2, "ignored": 1, "attempted": 3},
        "runCompetition": {"honored": 0, "ignored": 1, "attempted": 1},
    }


def test_forced_choice_drains_into_the_next_recorded_turn():
    ledger.note_forced_choice("player", "advanceGame", honored=True)
    ledger.note_forced_choice("player", "advanceGame", honored=False)
    ledger.record_turn("player", session="s", turn_id="t")
    e = ledger.get_recent("player")[0]
    assert e["forcedChoice"] == {"advanceGame": {"honored": 1, "ignored": 1}}
    # drained: a second turn with no new attempts records an empty map
    ledger.record_turn("player", session="s", turn_id="t2")
    assert ledger.get_recent("player")[-1]["forcedChoice"] == {}
    # and beltsFired stays completely untouched by the new dimension
    assert e["beltsFired"] == {}


def test_forced_choice_explicit_arg_merges_with_the_buffer():
    ledger.note_forced_choice("player", "advanceGame", honored=True)
    ledger.record_turn("player", session="s", turn_id="t",
                       forced_choice={"advanceGame": {"honored": 2, "ignored": 1}})
    e = ledger.get_recent("player")[0]
    assert e["forcedChoice"] == {"advanceGame": {"honored": 3, "ignored": 1}}


def test_forced_choice_totals_sum_the_ring_and_the_pending_buffer():
    ledger.note_forced_choice("player", "advanceGame", honored=True)
    ledger.record_turn("player", session="s", turn_id="t1")  # → ring
    ledger.note_forced_choice("player", "advanceGame", honored=False)  # still pending
    totals = ledger.get_forced_choice_totals("player")
    assert totals == {"advanceGame": {"honored": 1, "ignored": 1, "attempted": 2}}


def test_forced_choice_totals_are_per_user_isolated():
    ledger.note_forced_choice("player-a", "advanceGame", honored=True)
    ledger.note_forced_choice("player-b", "runCompetition", honored=False)
    assert ledger.get_forced_choice_totals("player-a") == {
        "advanceGame": {"honored": 1, "ignored": 0, "attempted": 1}}
    assert ledger.get_forced_choice_totals("player-b") == {
        "runCompetition": {"honored": 0, "ignored": 1, "attempted": 1}}
    assert ledger.get_forced_choice_totals("player-c") == {}


def test_forced_choice_map_is_bounded_and_names_clipped():
    for i in range(ledger._MAX_FORCED_TOOLS + 20):
        ledger.note_forced_choice("player", f"tool-{i}", honored=True)
    assert len(ledger.get_forced_choice_totals("player")) <= ledger._MAX_FORCED_TOOLS
    big = "tool " + "x" * 500
    ledger.note_forced_choice("player2", big, honored=False)
    (name,) = ledger.get_forced_choice_totals("player2").keys()
    assert len(name) <= ledger._MAX_NAME_LEN


def test_note_forced_choice_never_raises_on_garbage():
    class _Evil:
        def __str__(self):
            raise RuntimeError("no name for you")
    ledger.note_forced_choice("player", _Evil(), honored=True)
    ledger.note_forced_choice("player", None, honored=False)
    ledger.note_forced_choice(None, "advanceGame", honored=True)  # missing user → "default"
    assert ledger.get_forced_choice_totals("default") == {
        "advanceGame": {"honored": 1, "ignored": 0, "attempted": 1}}


def test_clear_drops_the_pending_forced_buffer_too():
    ledger.note_forced_choice("player", "advanceGame", honored=True)
    ledger.record_turn("player", session="s", turn_id="t")
    ledger.note_forced_choice("player", "advanceGame", honored=False)
    ledger.clear("player")
    assert ledger.get_forced_choice_totals("player") == {}


def test_log_line_carries_the_forced_choice_outcomes(caplog):
    import logging
    ledger.note_forced_choice("player", "advanceGame", honored=True)
    ledger.note_forced_choice("player", "advanceGame", honored=False)
    with caplog.at_level(logging.INFO, logger="src.orwell_sync_ledger"):
        ledger.record_turn("player", session="s", turn_id="t")
    lines = [r.getMessage() for r in caplog.records if "sync-ledger turn" in r.getMessage()]
    assert len(lines) == 1 and "advanceGame:h1/i1" in lines[0]


# ── the agent-loop helper is fail-soft ───────────────────────────────────────────────────────


def test_agent_loop_note_belt_is_fail_soft(monkeypatch):
    al = importlib.import_module("src.agent_loop")

    def boom(*_a, **_k):
        raise RuntimeError("telemetry store on fire")

    monkeypatch.setattr(ledger, "note_belt_fire", boom)
    al._note_belt("player", "auto-record-scene")  # must not raise


def test_agent_loop_note_belt_counts_into_the_ledger():
    al = importlib.import_module("src.agent_loop")
    al._note_belt("player", "eviction-reveal-steer")
    assert ledger.get_belt_totals("player") == {"eviction-reveal-steer": 1}


def test_agent_loop_note_forced_choice_is_fail_soft(monkeypatch):
    al = importlib.import_module("src.agent_loop")

    def boom(*_a, **_k):
        raise RuntimeError("telemetry store on fire")

    monkeypatch.setattr(ledger, "note_forced_choice", boom)
    al._note_forced_choice("player", "advanceGame", honored=True)  # must not raise


def test_agent_loop_note_forced_choice_counts_into_the_ledger():
    al = importlib.import_module("src.agent_loop")
    al._note_forced_choice("player", "advanceGame", honored=True)
    al._note_forced_choice("player", "advanceGame", honored=False)
    assert ledger.get_forced_choice_totals("player") == {
        "advanceGame": {"honored": 1, "ignored": 1, "attempted": 2}}


# ── T0-4 source pin: the forced-choice attempt is resolved at BOTH outcomes ──────────────────
# The success-gated `_note_belt(owner, "forced-tool-choice:"...)` note (pinned above) fires only
# on a landed match, and test_1659_r4_escalation.py pins that its OWN `_forced_belt_tool = None`
# clear sits within 120 chars of that note — so the honored `_note_forced_choice` call sits AFTER
# the clear (using `block.tool_type`, which still holds the just-matched tool name) rather than
# between the note and the clear. `_note_forced_choice` must resolve BOTH outcomes so no attempt
# is dropped.
#
# CodeRabbit MAJOR (PR #1821): the ORIGINAL ignored-resolution site (right after the per-round
# tool-call loop) is UNREACHABLE for the exact F2 case this telemetry exists to catch — the model
# calls ZERO tools — because every branch inside the giant `if not tool_blocks:` block ends in a
# `continue`/`break` back to the top of the round loop before that post-loop code ever runs. The
# fix adds a SECOND, EARLIER resolution site immediately after `tool_blocks` is parsed (before
# `if not tool_blocks:` and everything downstream of it), so an unmatched/absent forced tool is
# caught before any early continue/break can skip it. Two call sites now exist for the SAME
# `honored=False` shape: the early one (reachable on every path, incl. zero tool calls) and the
# original post-loop one (kept as an idempotent safety net — a no-op once the marker is cleared
# early).


def test_forced_choice_attempt_is_resolved_honored_at_the_belt_note_site():
    src = _src("src/agent_loop.py")
    note_at = src.index('_note_belt(owner, "forced-tool-choice:"')
    tail = src[note_at:note_at + 300]
    assert '_note_forced_choice(owner, block.tool_type, honored=True)' in tail
    clear_idx = tail.index('_forced_belt_tool = None')
    assert clear_idx < tail.index('_note_forced_choice')
    # And the clear itself stays close to the note (test_1659_r4_escalation.py's own 120-char pin).
    assert clear_idx < 120


def test_forced_choice_attempt_is_resolved_ignored_at_two_sites_early_and_safety_net():
    src = _src("src/agent_loop.py")
    # TWO reconciliation sites for the SAME ignored shape: the early one (right after
    # `_resolve_tool_blocks`, reachable even on a zero-tool-call round) and the post-loop
    # safety net (kept for defense in depth — a no-op once the early site has already cleared
    # the marker).
    assert src.count('_note_forced_choice(owner, _forced_belt_tool, honored=False)') == 2
    resolve_at = src.index('tool_blocks, used_native = _resolve_tool_blocks(')
    honored_note_at = src.index('_note_forced_choice(owner, block.tool_type, honored=True)')
    early_ignored_at = src.index('_note_forced_choice(owner, _forced_belt_tool, honored=False)')
    late_ignored_at = src.index('_note_forced_choice(owner, _forced_belt_tool, honored=False)',
                                early_ignored_at + 1)
    # Ordering: tool_blocks resolved → EARLY ignored-check → (much later) the honored check
    # inside the per-block loop → the LATE post-loop safety net.
    assert resolve_at < early_ignored_at < honored_note_at < late_ignored_at

    # The early site sits BEFORE the giant `if not tool_blocks:` branch (and everything nested
    # inside it) — i.e. before the force-answer synthesis / intent-nudge / live-game lull-nudge
    # logic that would `continue`/`break` past a later check on the exact zero-tool-call round.
    not_tool_blocks_at = src.index('if not tool_blocks:', early_ignored_at)
    assert early_ignored_at < not_tool_blocks_at

    # The early site's own guard + clear, close by (a tight, self-contained check).
    early_tail = src[early_ignored_at - 120:early_ignored_at + 150]
    assert 'if _forced_belt_tool and not any(' in early_tail
    assert '_forced_belt_tool = None' in early_tail

    # The late (post-loop) site's guard + clear, unchanged shape.
    late_tail = src[late_ignored_at - 40:late_ignored_at + 120]
    assert 'if _forced_belt_tool:' in late_tail
    assert '_forced_belt_tool = None' in late_tail


# ── source pins: every named belt call site notes its fire ──────────────────────────────────
# The registry of stable belt tokens lives in docs/design/undercall-seam-structural.md §5.
# Tightened (CodeRabbit, PR #1377): each token must appear as the BELT ARGUMENT of an actual
# note-belt CALL expression — `…note_belt*(<user-ident>, "token"…)` — so a comment or docstring
# mention can never satisfy the pin. Matches `_note_belt`, `note_belt_fire`, and the shared
# `note_belt` wrapper (incl. the `_sync_ledger_note_belt` import alias), with `owner`/`user`/
# `_force_owner` as the first argument.

import re


def _src(rel):
    with open(os.path.join(_BASE, *rel.split("/")), encoding="utf-8") as fh:
        return fh.read()


def _assert_belt_call(src, token, where):
    """Assert `token` (a belt-name string literal, opening quote included) appears as the
    second argument of a real note-belt call — not merely anywhere in the file."""
    pat = re.compile(
        r'note_belt(?:_fire)?\(\s*(?:owner|user|_force_owner)\s*,\s*' + re.escape(token))
    assert pat.search(src), f"belt telemetry CALL site missing in {where}: {token}"


def test_every_agent_loop_belt_notes_its_fire_as_a_real_call():
    src = _src("src/agent_loop.py")
    for token in (
        '"advance-stall-nudge"',
        '"forced-advance:"',              # _commit_advance_silently (preview-commit / stall / forced-stall)
        '"forced-tool-choice:"',          # the ONE gated note site (live beat-force + casting force)
        '"auto-record-scene"',
        '"auto-record-deal"',
        '"auto-answer-deal-offer"',
        '"auto-confide"',
        '"auto-expose-secret"',
        '"auto-trade-secret"',
        '"auto-move-player"',
        '"auto-move-npc"',
        '"premiere-meet-belt"',
        '"casting-record-belt"',
        '"casting-nudge"',
        '"casting-finalize-force"',
        '"eviction-reveal-steer"',
        '"ceremony-narration-steer"',
    ):
        _assert_belt_call(src, token, "agent_loop.py")


def test_framing_and_gate_belts_note_their_fire_as_real_calls():
    ch = _src("routes/chat_helpers.py")
    _assert_belt_call(ch, '"pre-resolve-npc-ceremony"', "chat_helpers.py")
    _assert_belt_call(ch, '"headshot-on-file-framing"', "chat_helpers.py")
    ti = _src("src/tool_implementations.py")
    _assert_belt_call(ti, '"house-entry-gate-hold"', "tool_implementations.py")


def test_success_gated_belts_fire_only_after_the_helper_applied():
    """CodeRabbit MAJOR (PR #1377): a no-op/failed extraction must never count as a belt fire —
    that would poison the exact measurement this telemetry exists to create. Pin the shape:
    each success-gated belt's note call sits AFTER its awaited helper in source order (inside
    the success branch), never before it, and the once-per-turn counter still precedes the
    helper call (cap behavior preserved)."""
    src = _src("src/agent_loop.py")
    for helper, token in (
        ("_auto_move_player", '"auto-move-player"'),
        ("_auto_move_npc", '"auto-move-npc"'),
        ("_auto_record_deal", '"auto-record-deal"'),
        ("_auto_answer_deal_offer", '"auto-answer-deal-offer"'),
        ("_auto_confide", '"auto-confide"'),
        ("_auto_expose_secret", '"auto-expose-secret"'),
        ("_auto_trade_secret", '"auto-trade-secret"'),
        ("_auto_record_scene", '"auto-record-scene"'),
    ):
        note_at = src.index("_note_belt(owner, " + token)
        # The nearest awaited helper call BEFORE the note must be this belt's own helper —
        # i.e. the note fires after (and therefore gated on) the helper's result.
        call_at = src.rindex("await " + helper + "(", 0, note_at)
        between = src[call_at:note_at].replace("await " + helper + "(", "", 1)
        assert "await _auto_" not in between, (
            f"{token}: note is not adjacent to its own helper's success branch")
        # And the belt's once-per-turn counter increment still precedes the helper call —
        # scoped to the belt's own `if _want_*` gate (not a fixed-width lookback), so the
        # increment asserted is the one inside THIS belt's branch.
        gate_at = src.rindex("if _want_", 0, call_at)
        assert re.search(r"_turn_\w+ \+= 1", src[gate_at:call_at]), (
            f"{token}: once-per-turn counter increment missing inside the belt's gate")


def test_forced_tool_choice_notes_only_after_the_forced_call_landed():
    """Greptile P1 (PR #1377) — the forcing-path twin of the success-gating pin above: selecting
    the `tool_choice` wire directive is an ATTEMPT; the belt counts only when the forced call
    actually LANDED as a tool event this round (a provider/stream failure after selection must
    never drain as a belt fire — §5: a count means an applied correction, never an attempt)."""
    src = _src("src/agent_loop.py")
    # Exactly ONE note site for the forcing belts (both the live beat-force and the casting
    # force funnel through it) …
    assert src.count('_note_belt(owner, "forced-tool-choice:"') == 1
    note_at = src.index('_note_belt(owner, "forced-tool-choice:"')
    # … sitting AFTER the round's tool event is appended and guarded on the MATCHING tool.
    append_at = src.rindex("tool_events.append(tool_event)", 0, note_at)
    guard = src[append_at:note_at]
    assert "if _forced_belt_tool and block.tool_type == _forced_belt_tool" in guard, (
        "the forced-tool-choice note must be gated on the forced tool actually landing")
    # Both SELECTION sites stash the pending marker instead of noting directly.
    assert '_forced_belt_tool = str(_forced_tool_choice["function"]["name"])' in src  # live force
    assert "_forced_belt_tool = _CASTING_FINALIZE_TOOL" in src                        # casting force
    # And the marker is cleared after one note (a repeat call never double-counts).
    assert "_forced_belt_tool = None" in src[note_at:note_at + 300]


# ── L-F3 (#1742) Greptile P2 — the loop-break belt is success-gated too ─────────────────────
# Selecting `_ADVANCE_LOOP_BREAK_NUDGE`/`_PENDING_LOOP_BREAK_NUDGE` is only an ATTEMPT; the belt
# must count only once an OBSERVED resolution lands (a progression tool fired, the framed gate
# changed, or a forced advance committed) — never a bare selection that leaves the SAME gate
# stalled next turn.


def test_loop_break_selection_sites_stash_instead_of_noting_directly():
    src = _src("src/agent_loop.py")
    assert '_LOOP_BREAK_PENDING_NOTE[_belt_key(owner)] = "loop-break-pending"' in src
    assert '_LOOP_BREAK_PENDING_NOTE[_belt_key(owner)] = "loop-break-advance"' in src
    # Neither selection site notes the belt directly.
    assert '_note_belt(owner, "loop-break-pending")' not in src
    assert '_note_belt(owner, "loop-break-advance")' not in src


def test_loop_break_note_never_fires_while_the_same_gate_stays_stalled():
    # The exact scenario Greptile flagged: a nudge is SELECTED (stashed) but the model ignores it —
    # the beat is still stalled on the SAME gate next turn. No progression, no gate change ⇒ NO
    # belt fire, and the stash survives so a later real resolution can still be credited.
    al = importlib.import_module("src.agent_loop")
    led = importlib.import_module("src.orwell_sync_ledger")
    led._PENDING_BELTS.clear()
    key = "test-belt-telemetry-loop-break-still-stalled"
    al._LOOP_BREAK_PENDING_NOTE.pop(key, None)
    gate = (1, "hoh-competition", "comp-round", "comp-round")
    al._LOOP_LAST_FRAMED_KEY[key] = gate  # the gate the streak was tracking

    al._LOOP_BREAK_PENDING_NOTE[key] = "loop-break-advance"
    al._note_loop_break_if_resolved(key, "player-lf3-stalled", progressed=False, current_gate=gate)
    assert led.get_belt_totals("player-lf3-stalled") == {}  # NO fire — ignored nudge, same gate
    assert al._LOOP_BREAK_PENDING_NOTE.get(key) == "loop-break-advance"  # stash still pending


def test_loop_break_note_fires_once_progression_is_observed():
    al = importlib.import_module("src.agent_loop")
    led = importlib.import_module("src.orwell_sync_ledger")
    led._PENDING_BELTS.clear()
    key = "test-belt-telemetry-loop-break-resolved"
    al._LOOP_BREAK_PENDING_NOTE.pop(key, None)
    al._LOOP_LAST_FRAMED_KEY.pop(key, None)
    gate = (1, "hoh-competition", "comp-round", "comp-round")
    al._LOOP_LAST_FRAMED_KEY[key] = gate
    al._LOOP_BREAK_PENDING_NOTE[key] = "loop-break-advance"

    # Still stalled — no belt fire yet.
    al._note_loop_break_if_resolved(key, "player-lf3", progressed=False, current_gate=gate)
    assert led.get_belt_totals("player-lf3") == {}
    assert al._LOOP_BREAK_PENDING_NOTE.get(key) == "loop-break-advance"

    # A progression tool fires (the model complied, or a forced advance committed) — NOW it counts,
    # and the stash clears so a repeat call never double-notes.
    al._note_loop_break_if_resolved(key, "player-lf3", progressed=True, current_gate=gate)
    assert led.get_belt_totals("player-lf3") == {"loop-break-advance": 1}
    assert key not in al._LOOP_BREAK_PENDING_NOTE
    al._note_loop_break_if_resolved(key, "player-lf3", progressed=True, current_gate=gate)
    assert led.get_belt_totals("player-lf3") == {"loop-break-advance": 1}  # unchanged — no double-count


def test_loop_break_note_fires_when_the_gate_itself_changed():
    # A forced advance / a peer turn moved the beat WITHOUT this turn's tool_events showing a
    # progression tool (`_commit_advance_silently` bypasses the normal tool-call path) — the
    # gate-changed branch is the OTHER way a resolution is observed.
    al = importlib.import_module("src.agent_loop")
    led = importlib.import_module("src.orwell_sync_ledger")
    led._PENDING_BELTS.clear()
    key = "test-belt-telemetry-loop-break-gate-changed"
    al._LOOP_BREAK_PENDING_NOTE.pop(key, None)
    old_gate = (1, "hoh-competition", "comp-round", "comp-round")
    new_gate = (1, "hoh-competition", "comp-round-2", "comp-round")
    al._LOOP_LAST_FRAMED_KEY[key] = old_gate
    al._LOOP_BREAK_PENDING_NOTE[key] = "loop-break-pending"

    al._note_loop_break_if_resolved(key, "player-lf3-gate", progressed=False, current_gate=new_gate)
    assert led.get_belt_totals("player-lf3-gate") == {"loop-break-pending": 1}
    assert key not in al._LOOP_BREAK_PENDING_NOTE


# ── T0-4 BEHAVIORAL: the zero-tool-call forced round (CodeRabbit MAJOR, PR #1821) ───────────────
# Drives the real `stream_agent_loop` end to end (mirrors test_tool_choice_force.py's
# `_drive_loop_capture_tool_choice` harness) against a stubbed transport that returns PLAIN TEXT
# with NO tool call at all — the exact F2 case this telemetry exists to catch: the model was
# forced to call a tool and simply didn't call ANY. Before the fix this round never reached a
# resolution site (every branch inside `if not tool_blocks:` continues/breaks first), so
# `get_forced_choice_totals` stayed empty even though a real forced attempt was ignored.

import asyncio

OR_URL = "https://openrouter.ai/api/v1/chat/completions"


def _drive_zero_tool_call_forced_round(monkeypatch, *, owner="t04-zero-tool-owner"):
    """Frame a force-candidate beat (hoh-competition → advanceGame), stub the wire so the model
    answers with plain narration and ZERO tool calls, and drive one round of the real loop."""
    al = importlib.import_module("src.agent_loop")
    ch = importlib.import_module("routes.chat_helpers")
    oe = importlib.import_module("src.orwell_engine")
    ti = importlib.import_module("src.tool_index")

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)

    _real_get_setting = al.get_setting

    def fake_get_setting(key, default=None):
        if key == "force_tool_choice_at_beats":
            return True
        return _real_get_setting(key, default)

    monkeypatch.setattr(al, "get_setting", fake_get_setting)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)

    # A force-candidate beat: hoh-competition → the engine names advanceGame.
    framed_key = ("w1", "hoh-competition", "hoh-competition")
    ch._LAST_FRAMED_BEAT_KEY[owner] = framed_key
    ch._LAST_FRAMED_REQUIRED_LEVER[owner] = "advanceGame"

    async def fake_status(user=None):
        return {"pending": None}
    monkeypatch.setattr(oe, "game_status", fake_status)

    # The stubbed wire: a normal narration reply, deliberately carrying NO tool_call_delta / no
    # native tool call at all — the model ignored the forced tool_choice entirely.
    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: {"delta": "The house is quiet tonight."}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        async for _ in al.stream_agent_loop(
            OR_URL, "z-ai/glm-4.7",
            [{"role": "system", "content": "narrator"}, {"role": "user", "content": "what happens"}],
            max_rounds=1, game_mode="game", owner=owner,
        ):
            pass

    try:
        asyncio.get_event_loop().run_until_complete(drive())
    finally:
        ch._LAST_FRAMED_BEAT_KEY.pop(owner, None)
        ch._LAST_FRAMED_REQUIRED_LEVER.pop(owner, None)


def test_zero_tool_call_forced_round_records_exactly_one_ignored_attempt(monkeypatch):
    ledger.clear("t04-zero-tool-owner")
    _drive_zero_tool_call_forced_round(monkeypatch)
    totals = ledger.get_forced_choice_totals("t04-zero-tool-owner")
    assert totals == {"advanceGame": {"honored": 0, "ignored": 1, "attempted": 1}}, totals
    # And the SUCCESS-GATED belt contract is untouched by this ignored attempt — an ignored
    # forced call is NEVER an applied correction, so beltsFired must stay empty (the
    # success-gated `note_belt_fire` semantics this fix must not redefine).
    assert ledger.get_belt_totals("t04-zero-tool-owner") == {}
