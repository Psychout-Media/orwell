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


def test_hold_does_not_count_during_entrances_or_toast_and_starts_after_done():
    u = "u-a9-count"
    ch.clear_social_runway(u)
    for st in ("entrances", "toast"):
        for _ in range(ch._PREMIERE_SOCIAL_MESSAGES + 5):
            ch.note_premiere_turn(u, _gs(st))
        assert ch.premiere_entrance_active(u) is True
        assert ch.premiere_is_holding(u) is False, "entrance pacing is the stall-nudge's job, not the hold"
        assert ch._PREMIERE_MSGS.get(ch._runway_key(u)) is None
    ch.note_premiere_turn(u, _gs("done"))
    assert ch.premiere_entrance_active(u) is False
    assert ch.premiere_is_holding(u) is True and ch._PREMIERE_MSGS[ch._runway_key(u)] == 1
    for _ in range(ch._PREMIERE_SOCIAL_MESSAGES - 1):
        ch.note_premiere_turn(u, _gs("done"))
    assert ch.premiere_is_holding(u) is False


def test_leaving_the_premiere_clears_the_entrance_stage():
    u = "u-a9-leave"
    ch.note_premiere_turn(u, _gs("entrances"))
    ch.note_premiere_turn(u, {"started": True, "phase": "hoh-competition"})
    assert ch.premiere_entrance_active(u) is False


def test_nudge_fires_after_the_lull_and_not_mid_exchange():
    # mid-exchange: one non-advancing player message, plain chat -> neither lull nor stale
    assert al._entrance_pacing(1, "tell me more about where you grew up", False, False) == (False, False)
    # the lull: two player messages with no advance
    assert al._entrance_pacing(al._ENTRANCE_LULL_TURNS, "hm ok", False, False) == (True, True)


def test_next_or_watch_cue_advances_immediately():
    for m in ("next", "I'll just watch", "who's next?"):
        assert al._entrance_pacing(0, m, False, False) == (True, True), m


def test_a_production_cue_is_never_a_player_cue():
    assert al._entrance_pacing(0, "(Production cue) next", False, False) == (False, False)


def test_nudge_reuses_the_existing_ladder_not_a_second_mechanism():
    src = (Path(al.__file__)).read_text()
    # the entrance hook only rewrites the existing _is_lull/_stale inputs of the one _want_advance expression
    assert src.count("_want_advance = (") == 1
    assert "_entrance_pacing(" in src and "premiere_entrance_active(owner)" in src
