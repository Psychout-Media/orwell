"""ORW-409 slice 3: the remaining hard-fact blocks (production notice / call, who walked in or left, the post-turnIn morning room) take their facts from the turn's ONE briefing, which is built once per
framed turn. Roles only. "BEFORE" lengths were measured on origin/main by assembling the same scenario with the old call forms (`briefing=None` forms are byte-identical to main)."""
import asyncio
import importlib

import pytest

from routes import chat_helpers as ch
from routes.briefing import Briefing, build_briefing, drop_stale_movement
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


# ---- scenario 1: night, the next event is tomorrow; the notice armed before the final board must not call it imminent -------------------------------------------------------------
def _night_scenario():
    pre = {"next": "nominations", "phase": "night", "due": False, "minutesUntil": 25}              # the schedule when the cue was armed
    final = _board("night", {"next": "nominations", "phase": "morning", "due": False, "tomorrow": True})   # the board the prompt is framed on
    armed = ch._production_warning_steer("nominations", 25, briefing=Briefing.from_schedule(pre))
    return final, armed


def test_night_notice_is_not_imminent_when_the_event_is_tomorrow():
    final, armed = _night_scenario()
    b = build_briefing(final, zero_clocks=True)
    old = _msgs(_ctx("night", "Houseguest A"), armed)
    assert [c["fact"] for c in audit_briefing(old, b)] == ["event-due"], "the unreconciled cue contradicts the briefing"
    new = _msgs(_ctx("night", "Houseguest A"), ch._reconcile_schedule_steer(armed, b))
    assert audit_briefing(new, b) == []
    assert "tomorrow morning" in new[0]["content"] and "GIVES NOTICE" not in new[0]["content"]
    assert len(new[0]["content"]) <= len(old[0]["content"]) <= BEFORE_NIGHT


def test_night_call_for_the_event_still_pending_and_not_due_is_swapped_not_kept():
    final, _ = _night_scenario()
    b = build_briefing(final, zero_clocks=True)
    call = ch._production_call_steer("nominations", briefing=Briefing(next_event="nominations"))
    out = ch._reconcile_schedule_steer(call, b)
    assert "PRODUCTION CALLS EVERYONE" not in out and "NOT on now" in out
    assert audit_briefing(_msgs(_ctx("night", "Houseguest A"), out), b) == []


# ---- scenario 4: an ordinary evening, the event is due now: the call still fires (no regression) -----------------------------------------------------------------------------------
def test_evening_event_due_now_keeps_the_call_steer():
    board = _board("evening", {"next": "veto-competition", "phase": "evening", "due": True, "minutesUntil": 0}, label="7:00pm, Day 2")
    b = build_briefing(board, zero_clocks=True)
    call = ch._production_call_steer("veto-competition", briefing=Briefing.from_schedule(board["daySchedule"]))
    assert call == ch._production_call_steer("veto-competition"), "same words as before for the same event"
    assert ch._reconcile_schedule_steer(call, b) == call
    msgs = _msgs(_ctx("evening", "Houseguest A"), call)
    assert audit_briefing(msgs, b) == []
    assert len(msgs[0]["content"]) <= BEFORE_EVENING


def test_call_for_an_event_the_engine_already_resolved_is_kept():
    # the pre-resolve fired the due event; the final board's NEXT event is a later one that is not due: the call is still true ("this just happened")
    b = build_briefing(_board("evening", {"next": "nominations", "phase": "morning", "due": False, "tomorrow": True}), zero_clocks=True)
    call = ch._production_call_steer("veto-competition")
    assert ch._reconcile_schedule_steer(call, b) == call


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
    fixed = drop_stale_movement(stale[0]["content"], b)
    assert "MOVEMENT IN THE ROOM" not in fixed and "With you: Houseguest A, Houseguest B." in fixed
    assert audit_briefing(_msgs(fixed), b) == []
    assert len(fixed) <= len(stale[0]["content"]) <= BEFORE_MORNING


def test_a_movement_cue_the_final_board_still_supports_is_kept():
    move = _night_move()
    b = build_briefing(_board("evening", None, present=("Houseguest A",)), zero_clocks=True)
    text = _ctx("evening", "Houseguest A") + "\n\n" + move
    assert drop_stale_movement(text, b) == text
    assert drop_stale_movement(text, Briefing()) == text, "no room in the briefing: unchanged"


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
def _frame(monkeypatch, board_seq, user):
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)
    boards = list(board_seq)

    async def status(user=None):
        return {"phase": "social", "pending": None}

    async def no_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return None

    async def state(user=None, **kw):
        return dict(boards.pop(0) if len(boards) > 1 else boards[0])

    async def moment(m, user=None, **_kw):
        return {"systemPrompt": "GAME CONTEXT:" + _ctx("evening", "Houseguest A")}

    monkeypatch.setattr(orwell_engine, "game_status", status)
    monkeypatch.setattr(orwell_engine, "advance_game", no_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", moment)
    preface = []
    _e, active, _f = _run(ch.apply_game_framing(preface, user, False, session_id="s-" + user))
    assert active is True
    return preface


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


# Prompt length BEFORE (origin/main): the same scenario assembled with the pre-change call forms and no reconcile, measured by running it against a checkout of origin/main.
BEFORE_NIGHT = 513    # measured: /tmp checkout of the branch base commit (ff4e89e3), same scenario, old call forms
BEFORE_EVENING = 519
BEFORE_MORNING = 507
