"""ORW-409 slice 2: one briefing per turn. The blocks that restate schedule / time of day read the single briefing, and audit_briefing reports nothing on prompts built this way. Roles only."""
import asyncio
import json

from routes import chat_helpers as ch
from routes.briefing import build_briefing, unify_part_of_day_lines
from routes.briefing_audit import audit_briefing


def _ctx(tod, band, with_you="Role A (new)"):
    # the engine's GAME CONTEXT lines as the prompt carries them under zero clocks
    return (f"\n- Week: 2\n- Phase: nominations\n- Time of day: {tod} (engine truth — set the scene at THIS hour; never narrate a different time of day than the engine reports).\n"
            f"- Part of the day: {band} (engine truth). The house has no clocks, as on the real show: voice the part of the day (light, hush, who is up) and NEVER state a clock time.\n"
            f"    With you: {with_you}.\n")


def _board(label, tod, ds):
    return {"started": True, "clockLabel": label, "timeOfDay": tod, "daySchedule": ds, "asleep": [], "whereabouts": {"room": "kitchen", "present": [{"name": "Role A"}]}}


def _prompt(board, engine_ctx, steers=()):
    b = build_briefing(board, zero_clocks=True)
    return [{"role": "system", "content": "\n\n".join([unify_part_of_day_lines(engine_ctx, b), *steers])}]


def test_briefing_reads_one_board():
    b = build_briefing(_board("11:30pm, Day 2", "night", {"next": "nominations", "phase": "morning", "due": False, "tomorrow": True}), zero_clocks=True)
    assert (b.part_of_day, b.next_event, b.next_day, b.next_part, b.due) == ("night", "nominations", "tomorrow", "morning", False)
    assert (b.location, b.present, b.asleep) == ("kitchen", ("Role A",), ())
    assert b.when("later today") == "tomorrow morning"


def test_zero_clocks_never_yields_a_clock_number():
    b = build_briefing(_board("4:15am, Day 3", "late-night", None), zero_clocks=True)
    assert b.part_of_day == "early morning" and not any(ch_.isdigit() for ch_ in b.part_of_day)


def test_ordinary_evening_turn_is_clean():
    board = _board("6:00pm, Day 2", "evening", {"next": "veto-competition", "phase": "night", "due": False})
    steer = ch._schedule_not_due_steer("nominations", "night", "veto-competition", False, briefing=build_briefing(board, zero_clocks=True))
    assert audit_briefing(_prompt(board, _ctx("evening", "evening"), [steer])) == []
    assert "this night" in steer


def test_night_turn_with_next_event_tomorrow_is_clean():
    board = _board("11:30pm, Day 2", "night", {"next": "nominations", "phase": "morning", "due": False, "tomorrow": True})
    b = build_briefing(board, zero_clocks=True)
    steer = ch._schedule_not_due_steer("hoh-competition", "morning", "nominations", True, briefing=b)
    prem = ch._premiere_not_yet_steer(board["daySchedule"])
    msgs = _prompt(board, _ctx("late-night", "night"), [steer, prem])
    assert audit_briefing(msgs) == []
    assert "tomorrow morning" in steer and "this afternoon" not in prem


def test_time_of_day_line_is_stated_once_and_matches_the_band():
    board = _board("4:15am, Day 3", "late-night", None)
    out = unify_part_of_day_lines(_ctx("late-night", "early morning"), build_briefing(board, zero_clocks=True))
    assert "Time of day:" not in out and out.count("early morning") == 1
    assert audit_briefing([{"role": "system", "content": out}]) == []


def test_time_of_day_line_kept_when_no_part_line():
    b = build_briefing(_board("9:00am, Day 1", "morning", None), zero_clocks=False)
    only = "\n- Time of day: morning (engine truth)\n"
    assert unify_part_of_day_lines(only, b) == only


def test_hang_out_stop_not_due_is_clean_and_due_is_kept():
    board = _board("2:00pm, Day 2", "afternoon", {"next": "hoh-competition", "phase": "evening", "due": False})
    steer = ch._reconcile_hang_out_steer(ch._hang_out_steer({"stopReason": "event-due", "minutes": 60}), board)
    ns = ch._schedule_not_due_steer("hoh-competition", "evening", "hoh-competition", False, briefing=build_briefing(board, zero_clocks=True))
    assert audit_briefing(_prompt(board, _ctx("afternoon", "afternoon"), [steer, ns])) == []
    due = {**board, "daySchedule": {**board["daySchedule"], "due": True}}
    raw = ch._hang_out_steer({"stopReason": "event-due", "minutes": 60})
    assert ch._reconcile_hang_out_steer(raw, due) == raw


def test_turn_in_morning_after_is_clean(monkeypatch):
    from src import agent_loop as al
    from src import orwell_engine as oe
    owner = "orw409"
    night = _ctx("night", "night")
    ch._LAST_FRAMED_MOMENT_VOLATILE[owner] = night
    morning_board = _board("4:15am, Day 3", "late-night", None)
    morning_board["asleep"] = [{"name": "Role B"}]

    async def fake_mp(moment=None, user=None, timeout=None, brief=None):
        return {"systemPrompt": "GAME CONTEXT:\n- roster" + _ctx("late-night", "early morning")}

    board_reads = []

    async def fake_state(user=None, **kw):
        board_reads.append(1)
        return morning_board

    monkeypatch.setattr(oe, "get_moment_prompt", fake_mp)
    monkeypatch.setattr(oe, "get_game_state", fake_state)
    msgs = [{"role": "system", "content": "GAME CONTEXT:\n- roster" + night + "\nTOOLS."}]
    out = json.dumps({"status": {"timeOfDay": "morning", "asleep": [{"id": "n", "name": "Role B"}]}})
    assert asyncio.get_event_loop().run_until_complete(al._refresh_context_after_turn_in(msgs, owner, out)) is True
    ch._LAST_FRAMED_MOMENT_VOLATILE.pop(owner, None)
    blob = msgs[0]["content"]
    assert len(board_reads) == 1, "ORW-409: ONE board read per post-turnIn rebuild (review of #2722); a second engine read would fail here"
    assert audit_briefing(msgs) == []
    assert "Part of the day: early morning" in blob and "Time of day:" not in blob and "it is now morning" not in blob
    assert "Still asleep (1): Role B" in blob


def test_prompt_does_not_grow():
    # a representative night turn: engine context + not-due steer (+ hang-out stop). BASELINE = the same turn assembled by the pre-briefing code.
    board = _board("11:30pm, Day 2", "night", {"next": "nominations", "phase": "morning", "due": False, "tomorrow": True})
    b = build_briefing(board, zero_clocks=True)
    steer = ch._schedule_not_due_steer("hoh-competition", "morning", "nominations", True, briefing=b)
    hang = ch._reconcile_hang_out_steer(ch._hang_out_steer({"stopReason": "event-due", "minutes": 60}), board)
    size = len(_prompt(board, _ctx("late-night", "night"), [hang, steer])[0]["content"])
    assert size <= BASELINE_CHARS, (size, BASELINE_CHARS)


BASELINE_CHARS = 1134  # measured on origin/main before this change: same turn, old blocks


def test_orw437_the_engines_real_part_line_with_a_day_suffix_is_unified():
    """review of #2722: the engine's real line is "- Part of the day: small hours, Day 3 (engine truth)", carrying ", Day N"."""
    board = _board("4:15am, Day 3", "late-night", None)
    ctx = _ctx("late-night", "small hours, Day 3")
    out = unify_part_of_day_lines(ctx, build_briefing(board, zero_clocks=True))
    assert "Time of day:" not in out, "the duplicate Time of day line must go"
    assert "- Part of the day: early morning, Day 3 (engine truth)" in out, out


def test_orw437_the_engines_own_event_due_stop_line_is_reconciled_when_not_due():
    """review of #2688: a real event-due result also carries the engine's `stopLine` ("...the scheduled event is on now."), which the steer quotes."""
    board = _board("2:00pm, Day 2", "afternoon", {"next": "hoh-competition", "phase": "evening", "due": False})
    res = {"stopReason": "event-due", "minutes": 60, "stopLine": "The house is being called together."}
    steer = ch._reconcile_hang_out_steer(ch._hang_out_steer(res), board)
    assert "is on now" not in steer and "calling everyone" not in steer and "being called together" not in steer, steer
    assert "NOT on now" in steer, steer  # ORW-917: the engine line is no longer quoted, so the FE's own not-due line carries it
    due = {**board, "daySchedule": {**board["daySchedule"], "due": True}}
    raw = ch._hang_out_steer(res)
    assert ch._reconcile_hang_out_steer(raw, due) == raw


def test_orw437_game_context_schedule_lines_are_audited_too():
    """review of #2688: the engine's own daySchedule lines ('- IT IS TIME: ... starting NOW', '- COMING UP: ...') contradict a not-yet steer."""
    due = "\n- IT IS TIME: the nominations is starting NOW — production calls the whole house to the living room.\n"
    coming = "\n- COMING UP: the nominations is set for this evening — the house knows it's coming.\n"
    steer_not_yet = "PRODUCTION HASN'T CALLED IT YET - the nominations is scheduled for later today."
    steer_on_now = "PRODUCTION CALLS EVERYONE - it is time for the nominations."
    assert [f["fact"] for f in audit_briefing([{"role": "system", "content": due + steer_not_yet}])] == ["event-due"]
    assert [f["fact"] for f in audit_briefing([{"role": "system", "content": coming + steer_on_now}])] == ["event-due"]
    assert audit_briefing([{"role": "system", "content": coming + steer_not_yet}]) == []
    assert audit_briefing([{"role": "system", "content": due + steer_on_now}]) == []
