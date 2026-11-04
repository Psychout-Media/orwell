"""Thursday dry-run finding: the engine RECORDS each toast batch, but a chatting player pulled the narrator off the circle so the speeches were never voiced. The pacing ladder now holds the
NEXT batch (bounded) until the current one is voiced; note_premiere_turn remembers who is on the mic. Roles only."""
import importlib

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")


def _board(speakers, stage="toast"):
    return {"phase": "premiere", "premiere": {"entrance": {"stage": stage, "speakers": speakers}}}


def test_note_premiere_turn_remembers_who_is_on_the_mic():
    u = "tv1"
    ch.clear_social_runway(u)
    ch.note_premiere_turn(u, _board([{"name": "The host", "host": True}, {"id": "npc:1", "name": "Salma Whitfield"}, {"id": "player", "name": "P", "isPlayer": True}]))
    assert ch._PREMIERE_TOAST_SPEAKERS[ch._runway_key(u)] == ["host", "Salma Whitfield"], "host marker kept, the player's slot excluded"
    ch.note_premiere_turn(u, _board([], stage="entrances"))
    assert ch._runway_key(u) not in ch._PREMIERE_TOAST_SPEAKERS, "only the toast stage carries a speaker list"
    ch.clear_social_runway(u)


def test_batch_voiced_requires_every_speaker():
    assert al._toast_batch_voiced('Salma lifts her glass. Dawn follows: "To the summer."', ["Salma Whitfield", "Dawn Ellerby"]) is True
    assert al._toast_batch_voiced("Salma lifts her glass and says her piece.", ["Salma Whitfield", "Dawn Ellerby"]) is False
    assert al._toast_batch_voiced("The host's voice comes over the speakers: welcome.", ["host"]) is True
    assert al._toast_batch_voiced("Everyone chats by the window.", ["host"]) is False
    assert al._toast_batch_voiced("anything", []) is True


def test_hold_cap_is_bounded_so_the_toast_can_never_stall():
    assert 1 <= al._TOAST_VOICE_HOLD_CAP <= 3


def test_wiring_present_in_the_pacing_block():
    import pathlib
    src = pathlib.Path(__file__).resolve().parents[1].joinpath("src", "agent_loop.py").read_text()
    assert "not _toast_batch_voiced(full_response, _sp)" in src and "_TOAST_VOICE_HOLDS.get(_bk, 0) < _TOAST_VOICE_HOLD_CAP" in src
