"""ORW-409 slice 3: the remaining hard-fact blocks (production notice / call, who walked in or left, the post-turnIn morning room) take their facts from the turn's ONE briefing, which is built once per
framed turn. Roles only. Prompt-length claims compare the reconciled prompt with the SAME scenario built with the steer un-reconciled (no marker armed), never a hard-coded number."""
import asyncio
import importlib

import pytest

from routes import chat_helpers as ch
from routes.briefing import Briefing, build_briefing, drop_movement_cue
from routes.briefing_audit import audit_briefing

orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _ctx(band, with_you, room="kitchen", asleep=""):
    return (f"\n- Week: 2\n- Phase: nominations\n- Part of the day: {band} (engine truth). The house has no clocks.\n"
            f"- WHERE YOU ARE (engine truth):\n    Your room: the {room} (you've been here a moment).\n    With you: {with_you}.\n{asleep}")


def _board(tod, ds, room="kitchen", present=("Houseguest A",), asleep=(), day=2, label="11:30pm, Day 2"):
    return {"started": True, "clockLabel": label, "timeOfDay": tod, "dayNumber": day, "daySchedule": ds, "asleep": [{"name": n} for n in asleep],
            "whereabouts": {"room": room, "present": [{"name": n} for n in present]}}


def _msgs(*blocks):
    return [{"role": "system", "content": "\n\n".join(blocks)}]


# ---- the production notice / call reconcile, driven through the real `apply_game_framing` ---------------------------------------------------------------------------------------------
def _social(ds, tod="evening", day=2, label="7:00pm, Day 2"):
    b = _board(tod, ds, day=day, label=label)
    b.update(phase="social", moment="social", week=1)
    return b


def _armed(user, text, pre_ds, pre_day=2):
    key = ch._runway_key(user)
    ch._arm_schedule_steer(key, text, pre_ds, {"dayNumber": pre_day})


def _framed(monkeypatch, user, steer, pre_ds, final, pre_day=2, marked=True):
    """The framed prompt for `user` with `steer` armed from `pre_ds`; `marked=False` stores the steer WITHOUT its marker (the un-reconciled form the old code produced)."""
    _reset(user)
    if marked:
        _armed(user, steer, pre_ds, pre_day)
    else:
        ch._SCHEDULE_STEER[ch._runway_key(user)] = steer
    return _frame(monkeypatch, [final], user)[0]["content"]


def test_night_notice_is_not_imminent_when_the_event_is_tomorrow(monkeypatch):
    pre = {"next": "nominations", "phase": "morning", "due": False, "tomorrow": True, "minutesUntil": 25}
    final = _social({"next": "nominations", "phase": "morning", "due": False, "tomorrow": True}, tod="night", label="11:30pm, Day 2")
    armed = ch._production_warning_steer("nominations", 25, briefing=Briefing.from_schedule(pre))
    old = _framed(monkeypatch, "u409n1", armed, pre, final, marked=False)
    new = _framed(monkeypatch, "u409n2", armed, pre, final)
    b = ch.turn_briefing("u409n2")
    assert "GIVES NOTICE" in old and "GIVES NOTICE" not in new and "tomorrow morning" in new
    assert [c["fact"] for c in audit_briefing([{"role": "system", "content": old}], b)] == ["event-due"], "the un-reconciled cue contradicts the briefing"
    assert audit_briefing([{"role": "system", "content": new}], b) == []
    assert len(new) <= len(old)


def test_call_for_the_event_still_pending_and_not_due_is_swapped(monkeypatch):
    pre = {"next": "nominations", "phase": "night", "due": True, "minutesUntil": 0}
    final = _social({"next": "nominations", "phase": "night", "due": False}, tod="night", label="11:30pm, Day 2")
    call = ch._production_call_steer("nominations", briefing=Briefing.from_schedule(pre))
    old = _framed(monkeypatch, "u409c1", call, pre, final, marked=False)
    new = _framed(monkeypatch, "u409c2", call, pre, final)
    assert "PRODUCTION CALLS EVERYONE" in old and "PRODUCTION CALLS EVERYONE" not in new and "NOT on now" in new
    assert audit_briefing([{"role": "system", "content": new}], ch.turn_briefing("u409c2")) == []
    assert len(new) <= len(old)


def test_evening_event_due_now_keeps_the_call_steer(monkeypatch):
    pre = {"next": "veto-competition", "phase": "evening", "due": True, "minutesUntil": 0}
    final = _social(pre)
    call = ch._production_call_steer("veto-competition", briefing=Briefing.from_schedule(pre))
    assert call == ch._production_call_steer("veto-competition"), "same words as before for the same event"
    old = _framed(monkeypatch, "u409e1", call, pre, final, marked=False)
    new = _framed(monkeypatch, "u409e2", call, pre, final)
    assert call in new and new == old
    assert audit_briefing([{"role": "system", "content": new}], ch.turn_briefing("u409e2")) == []


def test_a_cue_for_another_occurrence_of_the_same_event_is_kept_at_framing(monkeypatch):
    # armed for the nominations of day 2; the final board's nominations is day 4: not the occurrence the cue was about, so it is not rewritten
    pre = {"next": "nominations", "phase": "night", "due": True}
    final = _social({"next": "nominations", "phase": "morning", "due": False, "tomorrow": True}, day=3)
    call = ch._production_call_steer("nominations", briefing=Briefing.from_schedule(pre))
    assert call in _framed(monkeypatch, "u409o1", call, pre, final, pre_day=2)


def test_a_cue_for_a_different_event_than_the_next_one_is_kept_at_framing(monkeypatch):
    # armed for the veto competition (not marked resolved); the final board's next event is the nominations, same day, not due: not the event the cue was about
    pre = {"next": "veto-competition", "phase": "evening", "due": True}
    final = _social({"next": "nominations", "phase": "night", "due": False})
    call = ch._production_call_steer("veto-competition", briefing=Briefing.from_schedule(pre))
    assert call in _framed(monkeypatch, "u409d1", call, pre, final)


def test_repeated_milestone_after_the_engine_resolved_part_one_keeps_the_call(monkeypatch):
    # the three-part final HOH repeats the `hoh-competition` milestone: part 1 comes due, the call is armed, the pre-resolve advances part 1; the refetched board's next event is
    # `hoh-competition` AGAIN (part 2), not due. Text matching used to swap the call for "hasn't called it yet" while the part-1 competition scene was still in the prompt.
    user = "u409rep"
    _reset(user)
    due = {"started": True, "phase": "hoh-competition", "moment": "hoh-competition", "week": 1, "dayNumber": 4, "timeOfDay": "evening", "clockLabel": "7:00pm, Day 4", "asleep": [],
           "whereabouts": {"room": "backyard", "present": [{"name": "Houseguest A"}]}, "daySchedule": {"next": "hoh-competition", "phase": "evening", "due": True, "minutesUntil": 0}}
    part2 = dict(due, daySchedule={"next": "hoh-competition", "phase": "night", "due": False, "minutesUntil": 90})
    adv = {"event": {"beat": "comp-elimination", "content": "Houseguest A wins part 1 of the final Head of Household"}}
    out = _frame(monkeypatch, [due, part2], user, advance=adv, phase="hoh-competition", player_msg="hello")[0]["content"]
    assert ch.turn_briefing(user).due is False and ch.turn_briefing(user).next_event == "hoh-competition"
    assert "PRODUCTION CALLS EVERYONE" in out and "HASN'T CALLED IT YET" not in out and "THE COMPETITION" in out
    assert ch.turn_schedule_arm(user)["resolved"] is True


def test_a_repeated_milestone_not_resolved_this_turn_is_still_swapped(monkeypatch):
    # same key, same day, nothing resolved: the not-due swap still fires (the marker, not the text, decides)
    pre = {"next": "hoh-competition", "phase": "evening", "due": True}
    final = _social({"next": "hoh-competition", "phase": "night", "due": False})
    call = ch._production_call_steer("hoh-competition", briefing=Briefing.from_schedule(pre))
    assert "NOT on now" in _framed(monkeypatch, "u409rs", call, pre, final)


def test_reconcile_without_a_marker_or_with_a_resolved_marker_never_changes_the_steer():
    b = Briefing(next_event="nominations", due=False, next_day="tomorrow", next_part="morning", day=2)
    call = ch._production_call_steer("nominations")
    assert ch._reconcile_schedule_steer(call, b) == call
    assert ch._reconcile_schedule_steer(call, b, {"event": "nominations", "day": 3, "resolved": True}) == call




def test_notice_and_call_follow_the_briefing_not_the_old_arguments():
    b1 = Briefing(next_event="nominations", minutes_until=12)
    b2 = Briefing(next_event="veto-competition", minutes_until=12)
    zc_off = pytest.importorskip("src.zero_clocks")
    assert "Nominations" in ch._production_warning_steer("eviction", 99, briefing=b1)
    assert "Veto competition" in ch._production_warning_steer("eviction", 99, briefing=b2)
    assert "Veto competition" in ch._production_call_steer("eviction", briefing=b2) and "Eviction" not in ch._production_call_steer("eviction", briefing=b2)
    assert "Eviction night" in ch._production_call_steer("eviction", briefing=Briefing())  # no briefing facts: the old argument (old path)
    assert zc_off is not None


def test_notice_minutes_come_from_the_briefing(monkeypatch):
    monkeypatch.setattr(ch, "_zc_on", lambda: False)
    assert "roughly 12 in-game minutes" in ch._production_warning_steer("nominations", 99, briefing=Briefing(next_event="nominations", minutes_until=12))
    assert "roughly 99 in-game minutes" in ch._production_warning_steer("nominations", 99, briefing=Briefing(next_event="nominations"))


# ---- scenario 2: the morning after a turnIn: the night's movement cue is gone, the morning room is the engine's "With you" ---------------------------------------------------------------
def _night_move():
    prev = {"room": "kitchen", "present": ["Houseguest A", "Houseguest B"]}
    cur = {"room": "kitchen", "present": ["Houseguest A"]}
    return ch._render_presence_movement(prev, cur)          # "Houseguest B has left the kitchen" (computed before the turnIn)


def test_morning_after_turn_in_drops_the_stale_movement_cue():
    move = _night_move()
    assert "Houseguest B has left the kitchen" in move
    morning = _board("morning", None, present=("Houseguest A", "Houseguest B"), label="8:00am, Day 3", day=3)
    b = build_briefing(morning, zero_clocks=True)
    stale = _msgs(_ctx("morning", "Houseguest A, Houseguest B"), move)
    assert any(c["fact"] == "presence" for c in audit_briefing(stale, b)), "the night cue disagrees with the morning room"
    fixed = drop_movement_cue(stale[0]["content"])          # what the turn-in rebuild does
    assert "MOVEMENT IN THE ROOM" not in fixed and "With you: Houseguest A, Houseguest B." in fixed
    assert audit_briefing(_msgs(fixed), b) == []
    assert len(fixed) < len(stale[0]["content"])


def test_movement_after_side_is_the_briefing_not_the_signature():
    prev = {"room": "kitchen", "present": ["Houseguest A", "Houseguest B"]}
    sig_cur = {"room": "kitchen", "present": ["Houseguest A", "Houseguest B"]}       # the old source says nothing moved
    b = Briefing(location="kitchen", present=("Houseguest A",))                        # the briefing says B left
    assert "Houseguest B has left the kitchen" in ch._render_presence_movement(prev, sig_cur, briefing=b)
    sig_moved = {"room": "kitchen", "present": ["Houseguest A"]}                      # change the old source alone: with a briefing it is ignored
    assert ch._render_presence_movement(prev, sig_moved, briefing=Briefing(location="kitchen", present=("Houseguest A", "Houseguest B"))) is None
    assert "left the" in ch._render_presence_movement(prev, sig_moved)                # no briefing: the old path, unchanged


# ---- scenario 3: a houseguest who is asleep is never present-and-talking in any block --------------------------------------------------------------------------------------------------
def test_a_sleeper_never_arrives_or_departs_in_the_movement_cue():
    prev = {"room": "bedroom", "present": ["Houseguest A"]}
    cur = {"room": "bedroom", "present": ["Houseguest A", "Houseguest B"]}
    board = _board("late-night", None, room="bedroom", present=("Houseguest A", "Houseguest B"), asleep=("Houseguest B",), label="4:15am, Day 3")
    b = build_briefing(board, zero_clocks=True)
    old = ch._render_presence_movement(prev, cur)
    assert "Houseguest B has come into the bedroom" in old
    assert ch._render_presence_movement(prev, cur, briefing=b) is None
    asleep = "- Still asleep (1): Houseguest B. They are NOT awake in this scene.\n"
    clean = _msgs(_ctx("early morning", "Houseguest A", room="bedroom", asleep=asleep))
    assert audit_briefing(clean, b) == []
    bad = _msgs(_ctx("early morning", "Houseguest A, Houseguest B", room="bedroom", asleep=asleep), old)
    assert [c["fact"] for c in audit_briefing(bad)].count("asleep") == 1


def test_audit_covers_interruption_room_and_day():
    asleep = "- Still asleep (1): Houseguest B. They are NOT awake.\n"
    intr = "AN INTERRUPTION (engine-decided): Houseguest B steps into the player's conversation - they want a word."
    assert [c["fact"] for c in audit_briefing(_msgs(_ctx("evening", "Houseguest A", asleep=asleep), intr))] == ["asleep"]
    two_rooms = _msgs(_ctx("evening", "Houseguest A"), "    Your room: the garden (you've been here a moment).\n")
    assert [c["fact"] for c in audit_briefing(two_rooms)] == ["player-room"]
    two_days = _msgs("- Clock: 9:00pm, Day 2 (engine truth)", "- Clock: 9:00am, Day 3 (engine truth)")
    assert [c["fact"] for c in audit_briefing(two_days)] == ["day"]
    b = Briefing(location="kitchen", day=3, present=("Houseguest A",))
    assert {c["fact"] for c in audit_briefing(_msgs(_ctx("evening", "Houseguest A"), "- Clock: 9:00pm, Day 2 (engine truth)"), b)} == {"day"}
    assert {c["fact"] for c in audit_briefing(_msgs(_ctx("evening", "Houseguest A", room="garden")), b)} == {"player-room"}


def test_briefing_carries_day_and_minutes_and_awake_present():
    b = build_briefing(_board("evening", {"next": "x", "phase": "night", "due": False, "minutesUntil": 20}, present=("Houseguest A", "Houseguest B"), asleep=("Houseguest B",), day=4), zero_clocks=True)
    assert (b.day, b.minutes_until, b.awake_present) == (4, 20, ("Houseguest A",))
    assert build_briefing({"started": True}, zero_clocks=True).day is None


# ---- the hang-out stop line reads the turn's briefing, not a board of its own ----------------------------------------------------------------------------------------------------------
def test_hang_out_stop_reads_the_passed_briefing():
    raw = ch._hang_out_steer({"stopReason": "event-due", "minutes": 60})
    due_board = _board("afternoon", {"next": "hoh-competition", "phase": "evening", "due": True})
    assert ch._reconcile_hang_out_steer(raw, due_board, briefing=Briefing(due=False)) != raw      # the briefing wins over the board handed in
    assert ch._reconcile_hang_out_steer(raw, due_board, briefing=Briefing(due=True)) == raw


# ---- one briefing per framed turn ---------------------------------------------------------------------------------------------------------------------------------------------------
def _frame(monkeypatch, board_seq, user, advance=None, phase="social", player_msg=None, band=None):
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)
    boards = list(board_seq)

    async def status(user=None):
        return {"phase": phase, "pending": None}

    async def no_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return advance

    async def state(user=None, **kw):
        return dict(boards.pop(0) if len(boards) > 1 else boards[0])

    async def moment(m, user=None, **_kw):
        return {"systemPrompt": "GAME CONTEXT:" + _ctx(band or str(boards[-1].get("timeOfDay") or "evening").replace("-", " "), "Houseguest A")}

    monkeypatch.setattr(orwell_engine, "game_status", status)
    monkeypatch.setattr(orwell_engine, "advance_game", no_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", moment)
    preface = []
    _e, active, _f = _run(ch.apply_game_framing(preface, user, False, session_id="s-" + user, player_msg=player_msg))
    assert active is True
    return preface


def _reset(user):
    ch.clear_social_runway(user)
    ch._TURN_BRIEFING.pop(ch._runway_key(user), None)
    ch._LAST_FRAMED_MOMENT_VOLATILE.pop(user, None)
    ch._COMP_PAUSED.pop(ch._runway_key(user), None)
    ch.event_pause_clear(user)


def test_the_briefing_is_built_once_per_framed_turn(monkeypatch):
    import routes.briefing as rb
    calls = []
    real = rb.build_briefing
    monkeypatch.setattr(rb, "build_briefing", lambda *a, **k: (calls.append(1), real(*a, **k))[1])
    board = _board("evening", {"next": "nominations", "phase": "night", "due": False, "minutesUntil": 25}, label="7:00pm, Day 2")
    board.update(phase="social", moment="social", week=1)
    # a stale armed notice + a hang-out stop are both consumed by this turn: neither builds a briefing of its own
    key = ch._runway_key("u409once")
    ch._SCHEDULE_STEER[key] = ch._production_warning_steer("nominations", 25)
    ch._HANGOUT_STEER[key] = ch._hang_out_steer({"stopReason": "event-due", "minutes": 60})
    preface = _frame(monkeypatch, [board], "u409once")
    assert len(calls) == 1, calls
    assert ch.turn_briefing("u409once") is not None and ch.turn_briefing("u409once").next_event == "nominations"
    assert "GIVES NOTICE" in preface[0]["content"]  # still due soon today: the cue survives
    ch._TURN_BRIEFING.pop(key, None)


def test_arming_the_steers_does_not_build_a_briefing(monkeypatch):
    import routes.briefing as rb
    calls = []
    monkeypatch.setattr(rb, "build_briefing", lambda *a, **k: calls.append(1))
    for k in ("u409arm",):
        ch.clear_social_runway(k); ch._PRODUCTION_HOLD.clear()
    ds = {"next": "veto-competition", "phase": "afternoon", "due": False, "minutesUntil": 20}
    state = {"phase": "veto-competition", "moment": "veto-competition", "week": 1, "started": True, "pending": None, "daySchedule": ds}

    async def status(user=None):
        return {"phase": "veto-competition", "pending": None}

    monkeypatch.setattr(orwell_engine, "game_status", status)
    out = _run(ch._pre_resolve_npc_ceremony("u409arm", state, retry=False, player_msg="hello"))
    assert out.get("moment") == "social" and "GIVES NOTICE" in ch._SCHEDULE_STEER.get(ch._runway_key("u409arm"), "")
    assert calls == []
    ch.clear_social_runway("u409arm")


def test_post_turn_in_rebuild_replaces_the_cached_briefing(monkeypatch):
    from src import agent_loop as al
    owner = "u409turnin"
    night = _ctx("night", "Houseguest A, Houseguest B")
    ch._LAST_FRAMED_MOMENT_VOLATILE[owner] = night
    morning = _board("morning", None, present=("Houseguest A",), asleep=("Houseguest B",), label="8:00am, Day 3", day=3)

    async def fake_mp(moment=None, user=None, timeout=None, brief=None):
        return {"systemPrompt": "GAME CONTEXT:\n- roster" + _ctx("morning", "Houseguest A")}

    async def fake_state(user=None, **kw):
        return morning

    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    move = ch._render_presence_movement({"room": "kitchen", "present": ["Houseguest A"]}, {"room": "kitchen", "present": ["Houseguest A", "Houseguest B"]})
    msgs = [{"role": "system", "content": "GAME CONTEXT:\n- roster" + night + "\n\n" + move + "\n\nTOOLS."}]
    assert _run(al._refresh_context_after_turn_in(msgs, owner, "{}")) is True
    blob = msgs[0]["content"]
    assert "MOVEMENT IN THE ROOM" not in blob and "Still asleep (1): Houseguest B" in blob and blob.endswith("TOOLS.")
    assert ch.turn_briefing(owner).day == 3
    assert audit_briefing(msgs, ch.turn_briefing(owner)) == []
    ch._LAST_FRAMED_MOMENT_VOLATILE.pop(owner, None)
    ch._TURN_BRIEFING.pop(ch._runway_key(owner), None)


# ---- the morning after a turnIn, through the real `_refresh_context_after_turn_in` -----------------------------------------------------------------------------------------------------------
def _morning_refresh(monkeypatch, user, steer, pre_ds, morning, extra="", pre_day=2, resolve=False):
    """Frame a night turn with `steer` armed (real `apply_game_framing`), then run the real turnIn refresh against the `morning` board; returns (messages, system content)."""
    from src import agent_loop as al
    final = _social({"next": pre_ds["next"], "phase": pre_ds.get("phase", "night"), "due": bool(pre_ds.get("due"))}, tod="night", label="11:30pm, Day 2")
    _reset(user)
    _armed(user, steer + ("\n\n" + extra if extra else ""), pre_ds, pre_day)
    if resolve:
        ch._mark_schedule_arm_resolved(ch._runway_key(user))
    msgs = _frame(monkeypatch, [final], user)

    async def fake_mp(moment=None, user=None, timeout=None, brief=None):
        return {"systemPrompt": "GAME CONTEXT:" + _ctx("morning", "Houseguest A", room=morning["whereabouts"]["room"])}

    async def fake_state(user=None, **kw):
        return morning

    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    assert _run(al._refresh_context_after_turn_in(msgs, user, "{}")) is True
    return msgs, msgs[0]["content"]


def _morning(ds, room="kitchen", present=("Houseguest A",)):
    return _board("morning", ds, room=room, present=present, label="8:00am, Day 3", day=3)


def test_turn_in_drops_a_notice_when_another_event_is_next_in_the_morning(monkeypatch):
    pre = {"next": "nominations", "phase": "night", "due": False, "minutesUntil": 25}
    notice = ch._production_warning_steer("nominations", 25, briefing=Briefing.from_schedule(pre))
    morning = _morning({"next": "veto-competition", "phase": "afternoon", "due": False})
    msgs, content = _morning_refresh(monkeypatch, "u409t1", notice, pre, morning)
    assert "GIVES NOTICE" not in content and "HASN'T CALLED" not in content
    assert audit_briefing(msgs, ch.turn_briefing("u409t1")) == []


def test_turn_in_keeps_the_notice_when_the_event_is_due_now_in_the_morning(monkeypatch):
    pre = {"next": "nominations", "phase": "night", "due": False, "minutesUntil": 25}
    notice = ch._production_warning_steer("nominations", 25, briefing=Briefing.from_schedule(pre))
    morning = _morning({"next": "nominations", "phase": "morning", "due": True})
    _msgs_, content = _morning_refresh(monkeypatch, "u409t2", notice, pre, morning)
    assert notice in content and "HASN'T CALLED" not in content


def test_turn_in_never_swaps_a_call_the_engine_resolved_this_turn(monkeypatch):
    pre = {"next": "hoh-competition", "phase": "night", "due": True}
    call = ch._production_call_steer("hoh-competition", briefing=Briefing.from_schedule(pre))
    morning = _morning({"next": "hoh-competition", "phase": "evening", "due": False}, room="kitchen")
    morning["dayNumber"] = 2   # the same day: the repeated milestone is next again
    _msgs_, content = _morning_refresh(monkeypatch, "u409t3", call, pre, morning, resolve=True)
    assert call in content and "HASN'T CALLED" not in content


def test_turn_in_swaps_a_call_for_the_same_pending_occurrence_that_is_not_due(monkeypatch):
    pre = {"next": "nominations", "phase": "morning", "due": True, "tomorrow": True}     # armed for day 3's nominations
    call = ch._production_call_steer("nominations", briefing=Briefing.from_schedule(pre))
    morning = _morning({"next": "nominations", "phase": "afternoon", "due": False})        # day 3, same event, not due
    _msgs_, content = _morning_refresh(monkeypatch, "u409t4", call, pre, morning)
    assert "PRODUCTION CALLS EVERYONE" not in content and "NOT on now" in content


def test_turn_in_keeps_the_other_paragraphs_of_the_steer(monkeypatch):
    pre = {"next": "nominations", "phase": "night", "due": False, "minutesUntil": 25}
    notice = ch._production_warning_steer("nominations", 25, briefing=Briefing.from_schedule(pre))
    morning = _morning({"next": "veto-competition", "phase": "afternoon", "due": False})
    _msgs_, content = _morning_refresh(monkeypatch, "u409t5", notice, pre, morning, extra="THE COMPETITION - a scene steer.")
    assert "GIVES NOTICE" not in content and "THE COMPETITION - a scene steer." in content


def _night_kitchen_cue(user):
    _reset(user)
    cue = ch._render_presence_movement({"room": "kitchen", "present": ["Houseguest A", "Houseguest B"]}, {"room": "kitchen", "present": ["Houseguest A"]})
    return cue


def test_turn_in_drops_a_movement_cue_that_names_last_nights_room(monkeypatch):
    # B left the kitchen at night; the player turns in and wakes in the bedroom where B is not: the people check alone kept the cue
    cue = _night_kitchen_cue("u409m1")
    from src import agent_loop as al
    user = "u409m2"
    _reset(user)
    ch._LAST_FRAMED_MOMENT_VOLATILE[user] = _ctx("night", "Houseguest A")

    async def fake_mp(moment=None, user=None, timeout=None, brief=None):
        return {"systemPrompt": "GAME CONTEXT:" + _ctx("morning", "Houseguest A", room="bedroom")}

    async def fake_state(user=None, **kw):
        return _morning(None, room="bedroom", present=("Houseguest A",))

    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    msgs = [{"role": "system", "content": "GAME CONTEXT:" + _ctx("night", "Houseguest A") + "\n\n" + cue}]
    assert _run(al._refresh_context_after_turn_in(msgs, user, "{}")) is True
    assert "MOVEMENT IN THE ROOM" not in msgs[0]["content"]
    assert audit_briefing(msgs, ch.turn_briefing(user)) == []


def test_turn_in_drops_a_night_arrival_who_is_still_there(monkeypatch):
    # an arrival the morning board still shows is last night's news: the people check kept it, the turn-in rebuild drops it
    cue = ch._render_presence_movement({"room": "kitchen", "present": ["Houseguest A"]}, {"room": "kitchen", "present": ["Houseguest A", "Houseguest B"]})
    assert "Houseguest B has come into the kitchen" in cue
    from src import agent_loop as al
    user = "u409m3"
    _reset(user)
    ch._LAST_FRAMED_MOMENT_VOLATILE[user] = _ctx("night", "Houseguest A")

    async def fake_mp(moment=None, user=None, timeout=None, brief=None):
        return {"systemPrompt": "GAME CONTEXT:" + _ctx("morning", "Houseguest A, Houseguest B")}

    async def fake_state(user=None, **kw):
        return _morning(None, present=("Houseguest A", "Houseguest B"))

    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    msgs = [{"role": "system", "content": "GAME CONTEXT:" + _ctx("night", "Houseguest A") + "\n\n" + cue}]
    assert _run(al._refresh_context_after_turn_in(msgs, user, "{}")) is True
    assert "MOVEMENT IN THE ROOM" not in msgs[0]["content"]


def test_turn_in_failure_leaves_the_content_and_the_cached_briefing_untouched(monkeypatch):
    from src import agent_loop as al
    user = "u409x"
    _reset(user)
    old_b = Briefing(day=1)
    ch.set_turn_briefing(user, old_b)
    ch._LAST_FRAMED_MOMENT_VOLATILE[user] = _ctx("night", "Houseguest A")

    async def fake_mp(moment=None, user=None, timeout=None, brief=None):
        return {"systemPrompt": "GAME CONTEXT:" + _ctx("morning", "Houseguest A")}

    async def fake_state(user=None, **kw):
        return _morning(None)

    def boom(*a, **k):
        raise RuntimeError("reconcile failed")

    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_mp)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(ch, "_reconcile_schedule_steer", boom)
    before = "GAME CONTEXT:" + _ctx("night", "Houseguest A")
    msgs = [{"role": "system", "content": before}]
    assert _run(al._refresh_context_after_turn_in(msgs, user, "{}")) is False
    assert msgs[0]["content"] == before and ch.turn_briefing(user) is old_b


# ---- a houseguest who was here and has gone to bed keeps an exit beat ------------------------------------------------------------------------------------------------------------------
def test_a_houseguest_who_turned_in_keeps_an_exit_beat_and_is_never_present_or_arriving():
    prev = {"room": "kitchen", "present": ["Houseguest A", "Houseguest B"]}
    cur = {"room": "kitchen", "present": ["Houseguest B"]}
    b = Briefing(location="kitchen", present=("Houseguest B",), asleep=("Houseguest A",))
    cue = ch._render_presence_movement(prev, cur, briefing=b)
    assert "Houseguest A has gone to sleep" in cue and "has left" not in cue      # true whether they left the room or fell asleep in it
    assert "come into" not in cue and "show them heading out or arriving" in cue
    msgs = [{"role": "system", "content": _ctx("night", "Houseguest B", asleep="- Still asleep (1): Houseguest A. They are NOT awake.\n") + "\n\n" + cue}]
    assert audit_briefing(msgs, build_briefing(_board("night", None, present=("Houseguest B",), asleep=("Houseguest A",)), zero_clocks=True)) == []


def test_a_sleeper_who_left_alongside_an_awake_leaver_is_split_in_the_cue():
    prev = {"room": "kitchen", "present": ["Houseguest A", "Houseguest B", "Houseguest C"]}
    cue = ch._render_presence_movement(prev, {"room": "kitchen", "present": ["Houseguest C"]}, briefing=Briefing(location="kitchen", present=("Houseguest C",), asleep=("Houseguest A",)))
    assert "Houseguest B has left the kitchen; Houseguest A has gone to sleep." in cue


# ---- the audit compares the engine's "With you" line (awake people only) with the awake set -------------------------------------------------------------------------------------------------
def test_a_correct_prompt_with_a_sleeper_in_the_room_raises_no_presence_report():
    b = Briefing(location="bedroom", present=("Houseguest A", "Houseguest B"), asleep=("Houseguest B",))
    asleep = "- Still asleep (1): Houseguest B. They are NOT awake in this scene.\n"
    assert audit_briefing(_msgs(_ctx("early morning", "Houseguest A (lingering, 3 turns)", room="bedroom", asleep=asleep)), b) == []
    assert [c["fact"] for c in audit_briefing(_msgs(_ctx("early morning", "Houseguest A, Houseguest B", room="bedroom", asleep=asleep)), b)].count("presence") == 1


def test_after_turn_in_a_morning_board_with_no_schedule_drops_last_nights_production_cue():
    """review of #2755: `_reconcile_schedule_steer` returned the steer untouched when the briefing had no schedule (`due is None`), even after a turnIn."""
    cue = "PRODUCTION GIVES NOTICE - the nomination ceremony is about to be called."
    other = "Keep the scene social."
    steer = cue + "\n\n" + other
    arm = {"event": "nominations", "day": 3, "resolved": False}
    b = Briefing(location="kitchen")  # due is None: the morning board has no daySchedule
    assert ch._reconcile_schedule_steer(steer, b, arm, after_turn_in=True) == other
    assert ch._reconcile_schedule_steer(steer, b, arm) == steer  # mid-turn: no schedule facts means unchanged, as before
