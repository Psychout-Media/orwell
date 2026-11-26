"""ORW-917 (Fable week-1 playtest): the narration carried the engine's stock hang-out lines word for word ("A and B are in a tense exchange.", "A stretch of time passes with
nothing demanding you.", "X comes over to talk to you.") on about 60 turns. The hang-out steer QUOTED the engine's `stopLine` to the narrator ("in your own words: \"...\""), and
the model copied the quote. The stop's facts (who, what kind of stop) already ride the steer's own line, so the engine sentence is no longer quoted; the reply still has to show
the stop (ORW-22). Roles only."""
from routes import chat_helpers as ch

ENGINE_LINES = {
    "observed": ("A and B are in a tense exchange.", {"kind": "argument", "who": ["Role A", "Role B"]}),
    "max-beats": ("A stretch of time passes with nothing demanding you.", {}),
    "npc-approach": ("Role C comes over to talk to you.", {"npc": "Role C"}),
    "pulled": ("Production pulls you aside.", {"by": "production"}),
    "event-due": ("The house is being called together.", {}),
    "bedtime": ("It is getting late; the house is winding down.", {}),
}


def test_the_engine_stop_sentence_is_never_quoted_to_the_narrator_but_the_stop_must_still_show():
    for reason, (line, detail) in ENGINE_LINES.items():
        steer = ch._hang_out_steer({"stopReason": reason, "minutes": 90, "detail": detail, "stopLine": line})
        assert line not in steer, f"{reason}: a quoted stock sentence is copied into the reply word for word"
        assert "shows the player this stop" in steer and "Invent no ceremony" in steer, steer


def test_the_stop_facts_still_ride_the_steer():
    steer = ch._hang_out_steer({"stopReason": "observed", "minutes": 30, "detail": {"kind": "argument", "who": ["Role A", "Role B"]},
                                "stopLine": "Role A and Role B are in a tense exchange."})
    assert "Role A and Role B" in steer and "arguing" in steer
    steer = ch._hang_out_steer({"stopReason": "npc-approach", "minutes": 30, "detail": {"npc": "Role C"}, "stopLine": "Role C comes over to talk to you."})
    assert "Role C comes over to talk to the player" in steer
