"""ORW-230 — a game turn that ends inside an open <think> must never save the narrator's private
reasoning as the reply.

A turn can stop while a `<think>` block is still open: the player presses Stop, the connection drops,
or the model hits its token cap inside the think. Both disconnect handlers in `chat_routes` saved the
partial through `clean_thinking_for_save`, which on purpose keeps an unclosed think as the content (so
an ordinary chat bubble is not blank) — and on reload the reasoning showed in the reply bubble. In the
game that reasoning can hold hidden game information (the review probe's row read "privately told
production she will flip").

These gates pin the fix:
  * for a framed game turn, every think block — closed, cut off mid-think, opened after earlier
    narration, or R1-style with only the closing tag — is moved to `metadata.thinking`, and the saved
    content keeps only the narration around it (possibly empty);
  * both disconnect paths save through ONE helper (`save_stopped_partial`), exercised here with each
    path's own arguments against the real SessionManager, then reloaded from the database;
  * the normal end-of-turn save (`save_assistant_response`, the token-cap case) does the same;
  * a non-game chat keeps today's behaviour.

Roles only: no names (the reasoning fixtures name roles, never houseguests).
"""

import os

import pytest

from core.models import ChatMessage
from routes import chat_helpers

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_SECRET = "the nominee privately told production they will flip on the HOH"
_UNCLOSED = "<think>The player asks about the nominee. Note: " + _SECRET + ", so I must not say"


# ── the pure split ──────────────────────────────────────────────────────────────────────────────── #

@pytest.mark.parametrize("text", [
    _UNCLOSED,
    '<think time="3.2">' + _SECRET,
    "<thinking>" + _SECRET,
    "\n\n  <think>\n" + _SECRET,
])
def test_an_unclosed_leading_think_is_all_reasoning(text):
    info = chat_helpers._split_game_reasoning(text)
    assert info is not None
    assert info["reply"] == ""
    assert _SECRET in info["thinking"]
    assert "<think" not in info["thinking"]


def test_the_think_time_attribute_is_kept():
    assert chat_helpers._split_game_reasoning('<think time="3.2">' + _SECRET)["time"] == "3.2"


def test_a_closed_think_with_no_reply_is_all_reasoning():
    info = chat_helpers._split_game_reasoning("<think>" + _SECRET + "</think>\n\n")
    assert info == {"thinking": _SECRET, "reply": "", "time": None}


def test_a_closed_think_with_a_reply_splits_like_today():
    info = chat_helpers._split_game_reasoning("<think>plan the beat</think>The kitchen goes quiet.")
    assert info == {"thinking": "plan the beat", "reply": "The kitchen goes quiet.", "time": None}


def test_a_think_opened_after_earlier_narration_keeps_only_the_narration():
    """Agent rounds are joined into one reply: round 1 narrated, round 2 opened a think and was cut off."""
    info = chat_helpers._split_game_reasoning("The kitchen goes quiet.\n\n<think>" + _SECRET)
    assert info["reply"] == "The kitchen goes quiet."
    assert _SECRET in info["thinking"]


def test_r1_style_reply_with_only_the_closing_tag():
    """The chat template opened the think, so only `</think>` arrived: everything before it was reasoning."""
    info = chat_helpers._split_game_reasoning(_SECRET + "</think>The kitchen goes quiet.")
    assert info["reply"] == "The kitchen goes quiet."
    assert info["thinking"] == _SECRET


def test_no_think_markup_is_left_to_the_existing_extractor():
    assert chat_helpers._split_game_reasoning("The kitchen goes quiet.") is None
    assert chat_helpers._split_game_reasoning("") is None


# ── clean_thinking_for_save (the disconnect save path) ─────────────────────────────────────────── #

def test_game_turn_cut_off_mid_think_saves_no_reasoning_as_content():
    content, md = chat_helpers.clean_thinking_for_save(_UNCLOSED, {"stopped": True}, game=True)
    assert content == ""
    assert _SECRET not in content
    assert _SECRET in md["thinking"]
    assert md["stopped"] is True


def test_non_game_chat_keeps_todays_behaviour():
    """Outside the game an unclosed think stays as the content (so an ordinary bubble is not blank)."""
    content, md = chat_helpers.clean_thinking_for_save(_UNCLOSED, {"stopped": True})
    assert content == _UNCLOSED
    assert "thinking" not in md


def test_the_reasoning_channel_still_fills_in_when_the_think_was_empty():
    content, md = chat_helpers.clean_thinking_for_save("<think>", {}, reasoning="channel plan", game=True)
    assert content == ""
    assert md["thinking"] == "channel plan"


# ── each disconnect path, saved and RELOADED from the database ─────────────────────────────────── #

@pytest.fixture
def sm():
    from core.session_manager import SessionManager
    from core.models import set_session_manager
    import core.models as core_models
    manager = SessionManager()
    prior = getattr(core_models, "_session_manager", None)
    set_session_manager(manager)
    yield manager
    set_session_manager(prior)


def _reload(sid):
    """What a reload serves: a FRESH SessionManager hydrating the session from the database."""
    from core.session_manager import SessionManager
    return [m.to_dict() for m in SessionManager().get_session(sid).history]


def _stopped_md():
    return {"stopped": True, "model": "the-model", "requested_model": "the-model"}


def test_chat_mode_disconnect_mid_think_reloads_without_reasoning(sm):
    sid = "orw230-chat-mode"
    sm.create_session(sid, "Season", "http://x", "the-model", owner="player")
    sess = sm.get_session(sid)
    sess.add_message(ChatMessage("user", "what is everyone whispering about?", metadata={}))
    # the chat-mode handler's arguments: no owed announcements
    chat_helpers.save_stopped_partial(sess, sm, _UNCLOSED, _stopped_md(), reasoning="", game=True,
                                      game_moment="Week 1 · Nominations · Evening")
    saved = _reload(sid)[-1]
    assert saved["role"] == "assistant"
    assert _SECRET not in saved["content"]
    assert "<think" not in saved["content"]
    assert _SECRET in saved["metadata"]["thinking"]
    assert saved["metadata"]["stopped"] is True
    assert saved["metadata"]["game_moment"] == "Week 1 · Nominations · Evening"


def test_agent_mode_disconnect_mid_think_reloads_without_reasoning(sm):
    sid = "orw230-agent-mode"
    sm.create_session(sid, "Season", "http://x", "the-model", owner="player")
    sess = sm.get_session(sid)
    sess.add_message(ChatMessage("user", "I head to the kitchen", metadata={}))
    ann = {"id": "ann:s-1", "kind": "noms", "week": 1, "beatSeq": 3, "headline": "Nominations are set.", "subjects": []}
    # the agent-mode handler's arguments: owed announcements ride along; round 1 narrated, round 2 cut mid-think
    chat_helpers.save_stopped_partial(sess, sm, "The kitchen goes quiet.\n\n<think>" + _SECRET, _stopped_md(),
                                      reasoning="", game=True, game_moment="Week 1 · Nominations · Evening",
                                      announcements=[ann])
    saved = _reload(sid)[-1]
    assert saved["content"] == "The kitchen goes quiet."
    assert _SECRET not in saved["content"]
    assert _SECRET in saved["metadata"]["thinking"]
    assert saved["metadata"]["announcements"] == [ann]


def test_a_game_partial_with_nothing_to_show_is_not_saved(sm):
    sid = "orw230-empty"
    sm.create_session(sid, "Season", "http://x", "the-model", owner="player")
    sess = sm.get_session(sid)
    sess.add_message(ChatMessage("user", "hello?", metadata={}))
    assert chat_helpers.save_stopped_partial(sess, sm, "<think></think>", _stopped_md(), game=True) is None
    assert [m["role"] for m in _reload(sid)] == ["user"]


def test_non_game_disconnect_still_saves_the_partial_as_before(sm):
    sid = "orw230-platform"
    sm.create_session(sid, "Chat", "http://x", "the-model", owner="player")
    sess = sm.get_session(sid)
    sess.add_message(ChatMessage("user", "hi", metadata={}))
    chat_helpers.save_stopped_partial(sess, sm, "Half a sentence", _stopped_md(), game=False)
    assert _reload(sid)[-1]["content"] == "Half a sentence"


# ── the normal end-of-turn save: the model hit its token cap inside the think ──────────────────── #

def test_token_cap_inside_the_think_reloads_without_reasoning(sm):
    sid = "orw230-token-cap"
    sm.create_session(sid, "Season", "http://x", "the-model", owner="player")
    sess = sm.get_session(sid)
    sess.add_message(ChatMessage("user", "who is on the block?", metadata={}))
    chat_helpers.save_assistant_response(sess, sm, sid, _UNCLOSED, {"model": "the-model"}, game=True)
    saved = _reload(sid)[-1]
    assert saved["role"] == "assistant"
    assert _SECRET not in saved["content"]
    assert _SECRET in saved["metadata"]["thinking"]


# ── the wiring: both disconnect handlers and both end-of-turn saves pass the game flag ──────────── #

def _routes_src():
    with open(os.path.join(FRONTEND, "routes", "chat_routes.py"), encoding="utf-8") as fh:
        return fh.read()


def test_both_disconnect_handlers_save_through_the_one_helper_with_the_game_flag():
    src = _routes_src()
    handlers = src.split("except (asyncio.CancelledError, GeneratorExit):")[1:]
    stream_handlers = [h[:2500] for h in handlers if "saving partial" in h[:800]]
    assert len(stream_handlers) == 2, "the chat-mode and agent-mode disconnect handlers"
    for h in stream_handlers:
        assert "save_stopped_partial(" in h
        assert "game=bool(ctx.framed)" in h
        assert "clean_thinking_for_save(" not in h, "no second, drift-prone copy of the save"


def test_both_end_of_turn_saves_pass_the_game_flag():
    src = _routes_src()
    calls = src.split("_saved_id = save_assistant_response(")[1:]
    assert len(calls) == 2
    for c in calls:
        assert "game=bool(ctx.framed)" in c[:1500]
