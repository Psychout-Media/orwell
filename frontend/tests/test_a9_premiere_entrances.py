"""A9 H2 - premiere entrances pacing belt. While the engine's premiere `entrance.stage` is entrances/toast the message-count hold does NOT count (it starts only
after stage == "done") and the EXISTING stall-nudge ladder treats a lull of _ENTRANCE_LULL_TURNS player messages, or a next/watch cue, as the lull. Flag off (no
`entrance` on the board) => byte-identical behaviour. Roles only."""
import importlib
import re
from pathlib import Path

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")


def _gs(stage=None):
    pr = {"champagneCircle": "gathered"}
    if stage:
        pr["entrance"] = {"stage": stage, "index": 2, "total": 16, "playerPosition": 5, "arrivedNames": ["A"]}
    return {"started": True, "phase": "premiere", "week": 1, "premiere": pr}


def test_flag_off_is_the_old_hold():
    u = "u-a9-off"
    ch.clear_social_runway(u)
    ch.note_premiere_turn(u, _gs())
    assert ch.premiere_entrance_active(u) is False
    assert ch.premiere_is_holding(u) is True


def test_hold_does_not_count_during_entrances_toast_or_after_done():
    u = "u-a9-count"
    ch.clear_social_runway(u)
    for st in ("entrances", "toast"):
        for _ in range(ch._PREMIERE_SOCIAL_MESSAGES + 5):
            ch.note_premiere_turn(u, _gs(st))
        assert ch.premiere_entrance_active(u) is True
        assert ch.premiere_is_holding(u) is False, "entrance pacing is the stall-nudge's job, not the hold"
        assert ch._PREMIERE_MSGS.get(ch._runway_key(u)) is None
    # AMEND (live rerun #2): once the toast is DONE there is no message-count hold at all - the nudge brings the day-break and the engine clock owns the morning.
    for _ in range(3):
        ch.note_premiere_turn(u, _gs("done"))
    assert ch.premiere_entrance_active(u) is False
    assert ch.premiere_is_holding(u) is False and ch._PREMIERE_MSGS.get(ch._runway_key(u)) is None


def test_leaving_the_premiere_clears_the_entrance_stage():
    u = "u-a9-leave"
    ch.note_premiere_turn(u, _gs("entrances"))
    ch.note_premiere_turn(u, {"started": True, "phase": "hoh-competition"})
    assert ch.premiere_entrance_active(u) is False


def test_nudge_fires_after_the_lull_and_not_mid_exchange():
    # mid-exchange: one non-advancing player message, plain chat -> neither lull nor stale
    assert al._entrance_pacing(1, "tell me more about where you grew up", False, False) == (False, False)
    # ORW-148: two (or many) non-advancing player messages are NO LONGER a release signal. The old quiet-lull
    # branch let the stall-L0 belt silently release an arrival mid-conversation and fast-forwarded the premiere
    # in the live 11-06 playtest. Only an explicit cue (next test) releases an arrival.
    assert al._entrance_pacing(al._ENTRANCE_LULL_TURNS, "hm ok", False, False) == (False, False)
    assert al._entrance_pacing(al._ENTRANCE_LULL_TURNS + 5, "hm ok", False, False) == (False, False)


def test_next_or_watch_cue_advances_immediately():
    for m in ("next", "I'll just watch", "who's next?"):
        assert al._entrance_pacing(0, m, False, False) == (True, True), m


def test_a_production_cue_is_never_a_player_cue():
    assert al._entrance_pacing(0, "(Production cue) next", False, False) == (False, False)


def test_nudge_reuses_the_existing_ladder_not_a_second_mechanism():
    src = (Path(al.__file__)).read_text()
    # the entrance hook only rewrites the existing _is_lull/_stale inputs of the one _want_advance expression
    assert src.count("_want_advance = _gates.want_advance(") == 1  # A60: still exactly one expression (now a call)
    assert "_entrance_pacing(" in src and "premiere_entrance_active(owner)" in src


def test_staged_entrance_advances_are_not_capped_as_silent_decoupling():
    """Live finding (A9 check): the F1 anti-stale cap held the nudge's silent advance after 2 consecutive silent advances, so the engine stalled at an arrival while the narrator invented
    the rest. A premiere entrance/toast advance is voiced by the NEXT turn's `justArrived` framing by design, so the streak must not count it (source pin on the guard)."""
    import pathlib
    src = pathlib.Path(__file__).resolve().parents[1].joinpath("src", "agent_loop.py").read_text()
    assert "def _premiere_staged(owner)" in src and "_ch_a9.premiere_entrance_active(owner)" in src
    assert "if not _premiere_staged(owner):" in src


def _board(phase="premiere", due=None, stage=None):
    b = {"phase": phase}
    if due is not None:
        b["daySchedule"] = {"next": "hoh-competition", "phase": "afternoon", "due": due, "minutesUntil": 0 if due else 120}
    if stage:
        b["premiere"] = {"entrance": {"stage": stage}}
    return b


def test_clock_owns_the_premiere_hold_once_the_day_has_started():
    """Live finding (A9 rerun): a hang-out advanced the clock to the HOH comp (due, 0 minutes) but the premiere MESSAGE-COUNT hold (< _PREMIERE_SOCIAL_MESSAGES) kept the comp frozen
    for several turns. With `daySchedule` on the board the schedule - not the count - decides: not due => hold; DUE => release immediately."""
    import importlib
    ch = importlib.import_module("routes.chat_helpers")
    u = "clock-owns-hold"
    ch.clear_social_runway(u)
    # not due: held even though the message count is far below the threshold AND even after many messages
    for _ in range(ch._PREMIERE_SOCIAL_MESSAGES + 5):
        ch.note_premiere_turn(u, _board(due=False))
    assert ch.premiere_is_holding(u) is True
    # due: released at once (count irrelevant)
    ch.note_premiere_turn(u, _board(due=True))
    assert ch.premiere_is_holding(u) is False
    ch.clear_social_runway(u)
    ch.note_premiere_turn(u, _board(due=True))
    assert ch.premiere_is_holding(u) is False, "due on the first message still releases"


def test_no_schedule_keeps_the_message_count_hold():
    import importlib
    ch = importlib.import_module("routes.chat_helpers")
    u = "count-hold"
    ch.clear_social_runway(u)
    ch.note_premiere_turn(u, _board())            # clock off / pre-day-break: the old count
    assert ch.premiere_is_holding(u) is True
    for _ in range(ch._PREMIERE_SOCIAL_MESSAGES):
        ch.note_premiere_turn(u, _board())
    assert ch.premiere_is_holding(u) is False
    ch.clear_social_runway(u)


def test_entrance_stage_still_wins_over_the_clock():
    import importlib
    ch = importlib.import_module("routes.chat_helpers")
    u = "stage-wins"
    ch.clear_social_runway(u)
    ch.note_premiere_turn(u, _board(due=False, stage="entrances"))
    assert ch.premiere_entrance_active(u) is True and ch.premiere_is_holding(u) is False
    ch.clear_social_runway(u)


def test_after_the_toast_there_is_no_message_count_hold_the_clock_morning_follows():
    """Live finding (A9 rerun #2): entrances+toast ARE the premiere; once stage==done the 48-message premiere hold must NOT run (it froze the engine at phase=premiere for 25+
    messages). The nudge brings the day-break, then the engine clock owns the 48-message morning."""
    import importlib
    ch = importlib.import_module("routes.chat_helpers")
    u = "toast-done-no-hold"
    ch.clear_social_runway(u)
    for _ in range(3):
        ch.note_premiere_turn(u, _board(stage="done"))
    assert ch.premiere_is_holding(u) is False
    assert ch._PREMIERE_MSGS.get(ch._runway_key(u)) is None, "no message counting once the toast is done"
    ch.clear_social_runway(u)
