"""ORW-409: one briefing per turn, no block contradicting another. Roles only."""
from routes import chat_helpers as ch
from routes.briefing_audit import audit_briefing


def _m(*blocks):
    return [{"role": "system", "content": "\n\n".join(blocks)}]


def test_audit_flags_due_now_and_not_called_in_one_prompt():
    hang = ch._hang_out_steer({"stopReason": "event-due", "minutes": 60})
    not_due = ch._schedule_not_due_steer("hoh-competition", "afternoon")
    assert [c["fact"] for c in audit_briefing(_m(hang, not_due))] == ["event-due"]


def test_audit_flags_part_of_day_and_presence():
    tod = "- Time of day: evening (engine truth)\n- Part of the day: late night (engine truth)."
    assert [c["fact"] for c in audit_briefing(_m(tod))] == ["part-of-day"]
    ctx = "    With you: Role A (new), Role B (new)."
    mv = "MOVEMENT IN THE ROOM (engine truth) — Role B has left the kitchen. Voice it."
    assert [c["fact"] for c in audit_briefing(_m(ctx, mv))] == ["presence"]


def test_audit_passes_a_clean_prompt():
    ctx = "- Time of day: evening (engine truth)\n- Part of the day: evening (engine truth).\n    With you: Role A (new)."
    mv = "MOVEMENT IN THE ROOM (engine truth) — Role B has left the kitchen. Voice it."
    assert audit_briefing(_m(ctx, mv, ch._schedule_not_due_steer("hoh-competition", "afternoon"))) == []


def test_hang_out_not_due_gives_one_consistent_steer():
    steer = ch._reconcile_hang_out_steer(ch._hang_out_steer({"stopReason": "event-due", "minutes": 60}), {"daySchedule": {"due": False}})
    full = _m(steer, ch._schedule_not_due_steer("hoh-competition", "afternoon"))
    assert audit_briefing(full) == []
    assert "scheduled event is on now" not in steer


def test_hang_out_due_or_no_schedule_unchanged():
    raw = ch._hang_out_steer({"stopReason": "event-due", "minutes": 60})
    assert ch._reconcile_hang_out_steer(raw, {"daySchedule": {"due": True}}) == raw
    assert ch._reconcile_hang_out_steer(raw, {}) == raw


def test_with_you_no_one_is_compared_with_the_briefings_awake_set():
    """review of #2755: "With you: No one" was skipped, so a prompt claiming nobody was present passed while the board had an awake houseguest there."""
    from routes.briefing import Briefing
    msgs = [{"role": "system", "content": "    With you: No one."}]
    here = Briefing(location="kitchen", present=("Houseguest A",))
    assert [f["fact"] for f in audit_briefing(msgs, here)] == ["presence"]
    assert audit_briefing(msgs, Briefing(location="kitchen", present=("Houseguest A",), asleep=("Houseguest A",))) == []
    assert audit_briefing(msgs, Briefing(location="kitchen")) == []
