"""ORW-230 review follow-ups — every think-markup shape a GAME turn is saved with keeps the narrator's reasoning
out of the saved reply.

The first ORW-230 pass (`test_orw230_unclosed_think_save.py`) split `<think>` / `<thinking>` blocks whose opener
was bare or carried `time="…"`. The review found shapes that were still saved as the reply:
  * a Gemma thought channel cut off mid-way (`<|channel>thought …` with no `<channel|>`): the markup normaliser
    only converts a CLOSED pair, so the cut-off one reached the reply raw. `<|channel>thought` is an opener and
    `<channel|>` a closer, as the clients read them (`hasUnclosedThinkTag` in markdown.js);
  * an opener with any attribute other than `time=` (`<think type="plan">`). The clients' grammar is
    `<think(?:ing)?(?:\\s+[^>]*)?>`, and the same for `<thought …>`;
  * a nested think, or a second closer after an empty `<think></think>` pair: the split ended the block at the
    first closer and saved the rest as the reply (Greptile P1 on #2286);
  * on a DISCONNECT save only (the turn was cut off), two conservative cases where the end of the reasoning never
    arrived: the text opens with a reasoning label ("Thinking Process:"), or with an empty `<think></think>`
    pair and no second closer. Everything is saved as reasoning and the content is empty;
  * a cut in the middle of a tag left the fragment (`<thi` in the content, `</thi` in the reasoning);
  * the sync `/api/chat` save (it serves casting turns) still split without the game flag.

Roles only: no names.
"""

import os
import uuid

import pytest

from core.models import ChatMessage
from routes import chat_helpers

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_SECRET = "the nominee privately told production they will flip on the HOH"
_NARRATION = "The kitchen goes quiet."


class _Sess:
    """Just enough of a chat session for the save helpers: it collects what is saved."""

    model = "the-model"

    def __init__(self):
        self.history = []

    def add_message(self, message):
        self.history.append(message)


class _SessionManager:
    def save_sessions(self):
        pass


def _stopped(text):
    """The disconnect save of a GAME turn cut off with `text` streamed: (content, metadata), or None if not saved."""
    msg = chat_helpers.save_stopped_partial(_Sess(), _SessionManager(), text, {"stopped": True}, game=True)
    return None if msg is None else (msg.content, msg.metadata)


def _ended(text):
    """The end-of-turn save of a COMPLETED game turn (`save_assistant_response`): (content, metadata)."""
    sess = _Sess()
    chat_helpers.save_assistant_response(sess, _SessionManager(), "orw230-shapes", text, {"model": "the-model"},
                                         game=True, incognito=True)
    return sess.history[-1].content, sess.history[-1].metadata


# ── the Gemma thought channel (MEDIUM) ─────────────────────────────────────────────────────────── #

@pytest.mark.parametrize("text", [
    "<|channel>thought\n" + _SECRET,
    "<|channel>thought" + _SECRET,
    "\n\n  <|channel>thought\n" + _SECRET,
    "<|CHANNEL>thought\n" + _SECRET,
])
def test_a_cut_off_gemma_thought_channel_is_all_reasoning(text):
    info = chat_helpers._split_game_reasoning(text)
    assert info is not None
    assert info["reply"] == ""
    assert _SECRET in info["thinking"]
    assert "channel" not in info["thinking"].lower()


def test_a_gemma_thought_opened_after_earlier_narration_keeps_only_the_narration():
    """Agent rounds are joined into one reply: round 1 narrated, round 2 was cut inside its thought channel."""
    info = chat_helpers._split_game_reasoning(_NARRATION + "\n\n<|channel>thought\n" + _SECRET)
    assert info["reply"] == _NARRATION
    assert _SECRET in info["thinking"]


def test_a_gemma_closer_alone_ends_the_reasoning():
    """The template opened the thought channel, so only `<channel|>` arrived: everything before it was reasoning."""
    info = chat_helpers._split_game_reasoning(_SECRET + "<channel|>" + _NARRATION)
    assert info == {"thinking": _SECRET, "reply": _NARRATION, "time": None}


def test_a_response_channel_closer_is_not_read_as_the_end_of_a_think():
    """`<channel|>` also closes a response channel. That text is the reply; a later cut-off thought is reasoning."""
    info = chat_helpers._split_game_reasoning(
        "<|channel>response\n" + _NARRATION + "<channel|>\n\n<|channel>thought\n" + _SECRET)
    assert info["reply"] == _NARRATION
    assert _SECRET in info["thinking"]


def test_a_second_gemma_round_cut_off_mid_thought_keeps_only_the_narration():
    text = ("<|channel>thought\nplan the beat<channel|><|channel>response\n" + _NARRATION + "<channel|>\n\n"
            "<|channel>thought\n" + _SECRET)
    info = chat_helpers._split_game_reasoning(text)
    assert info["reply"] == _NARRATION
    assert "plan the beat" in info["thinking"]
    assert _SECRET in info["thinking"]


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


def test_a_gemma_turn_stopped_mid_thought_reloads_without_reasoning(sm):
    from core.session_manager import SessionManager
    sid = f"orw230-gemma-{uuid.uuid4().hex[:8]}"
    sm.create_session(sid, "Season", "http://x", "the-model", owner="player")
    sess = sm.get_session(sid)
    sess.add_message(ChatMessage("user", "what is everyone whispering about?", metadata={}))
    chat_helpers.save_stopped_partial(sess, sm, "<|channel>thought\nThe player asks. Note: " + _SECRET,
                                      {"stopped": True}, game=True)
    saved = SessionManager().get_session(sid).history[-1].to_dict()
    assert saved["role"] == "assistant"
    assert _SECRET not in saved["content"]
    assert "channel" not in saved["content"]
    assert _SECRET in saved["metadata"]["thinking"]


# ── an opener with any attributes (LOW) ────────────────────────────────────────────────────────── #

@pytest.mark.parametrize("opener", [
    '<think type="plan">',
    "<thinking mode='narrator'>",
    '<thought type="plan">',
    '<think time="3.2" type="plan">',
    '<think\n  type="plan">',
])
def test_an_opener_with_any_attributes_is_reasoning(opener):
    info = chat_helpers._split_game_reasoning(opener + _SECRET)
    assert info is not None
    assert info["reply"] == ""
    assert _SECRET in info["thinking"]


def test_the_time_attribute_is_read_among_other_attributes():
    assert chat_helpers._split_game_reasoning('<think type="plan" time="1.5">' + _SECRET)["time"] == "1.5"


def test_a_closed_think_with_attributes_splits_cleanly():
    info = chat_helpers._split_game_reasoning('<think type="plan">plan the beat</think>' + _NARRATION)
    assert info == {"thinking": "plan the beat", "reply": _NARRATION, "time": None}


# ── a nested think, and a second closer (Greptile P1 on #2286) ─────────────────────────────────── #

def test_a_nested_think_stays_reasoning_up_to_the_outer_closer():
    info = chat_helpers._split_game_reasoning(
        "<think>outer plan<think>inner plan</think>" + _SECRET + "</think>" + _NARRATION)
    assert info["reply"] == _NARRATION
    assert _SECRET in info["thinking"]
    assert "inner plan" in info["thinking"]
    assert "<think" not in info["thinking"] and "</think" not in info["thinking"]


def test_a_nested_think_cut_off_inside_is_all_reasoning():
    info = chat_helpers._split_game_reasoning("<think>outer plan<think>inner plan</think>" + _SECRET)
    assert info["reply"] == ""
    assert _SECRET in info["thinking"]


def test_a_second_closer_after_an_empty_pair_ends_the_reasoning():
    """The model emitted an empty pair, then reasoned outside the tags until a second `</think>`."""
    text = "<think></think>" + _SECRET + "</think>" + _NARRATION
    assert chat_helpers._split_game_reasoning(text) == {"thinking": _SECRET, "reply": _NARRATION, "time": None}
    content, md = _stopped(text)
    assert content == _NARRATION
    assert md["thinking"] == _SECRET


# ── a disconnect save, conservative (LOW) ──────────────────────────────────────────────────────── #

@pytest.mark.parametrize("label", ["Thinking Process:", "thinking process :", "Thinking:", "  Thinking Process:"])
def test_a_stopped_turn_that_opens_with_a_reasoning_label_saves_no_reply(label):
    content, md = _stopped(label + "\n\n1. The player asks about the nominee.\n\nNote: " + _SECRET + ", so I")
    assert content == ""
    assert _SECRET in md["thinking"]
    assert not md["thinking"].lower().startswith("thinking")


def test_a_stopped_labelled_turn_whose_reasoning_was_closed_keeps_the_narration():
    """An explicit closer ends the labelled reasoning, so narration after it is the reply."""
    content, md = _stopped("Thinking Process:\n\n1. " + _SECRET + "\n</think>\n\n" + _NARRATION)
    assert content == _NARRATION
    assert _SECRET in md["thinking"]


def test_the_label_rule_is_for_a_cut_off_turn_only():
    """A completed turn keeps today's extractor, whose boundary splits a labelled preamble from the narration."""
    content, md = _ended("Thinking Process:\n\n1. Plan the beat.\n\n" + _NARRATION)
    assert content == _NARRATION
    assert md["thinking"] == "1. Plan the beat."


@pytest.mark.parametrize("pair", [
    "<think></think>",
    "<think>\n\n</think>\n\n",
    '<think time="0.1"> </think>',
    "<thinking></thinking>",
    '<thought type="plan"></thought>',
])
def test_a_stopped_turn_after_an_empty_pair_with_no_second_closer_saves_no_reply(pair):
    content, md = _stopped(pair + "The player asks about the nominee. Note: " + _SECRET)
    assert content == ""
    assert _SECRET in md["thinking"]


def test_an_empty_pair_on_a_completed_turn_is_the_ordinary_no_reasoning_shape():
    """A non-thinking turn opens with an empty pair and then narrates. Only a CUT-OFF turn reads the rest as reasoning."""
    content, md = _ended("<think>\n\n</think>\n\n" + _NARRATION)
    assert content == _NARRATION
    assert "thinking" not in md


# ── a cut in the middle of a tag (NIT) ─────────────────────────────────────────────────────────── #

@pytest.mark.parametrize("fragment", [
    "<", "</", "<t", "<thi", "<think", "<thinking", "<thou", "</thought", '<think time="3.', '<think type="pl',
    "<|", "<|chan", "<|channel>", "<|channel>thou", "<chan", "<channel|", "\n\n<thi",
])
def test_a_trailing_partial_tag_is_not_saved_in_the_content(fragment):
    content, _md = _stopped(_NARRATION + fragment)
    assert content == _NARRATION


def test_a_trailing_partial_closer_is_not_saved_in_the_reasoning():
    content, md = _stopped("<think>" + _SECRET + "</thi")
    assert content == ""
    assert md["thinking"] == _SECRET


def test_a_turn_that_hit_the_token_cap_mid_tag_saves_no_fragment():
    content, _md = _ended(_NARRATION + "\n\n<thin")
    assert content == _NARRATION


def test_only_a_tag_prefix_counts_as_a_fragment():
    """Narrowness guard: a trailing `<` that cannot start a think tag is narration, and a non-game save is unchanged."""
    assert _stopped("They whisper. I <3 this house")[0] == "They whisper. I <3 this house"
    assert chat_helpers.clean_thinking_for_save("Half a sentence<thi", {})[0] == "Half a sentence<thi"


# ── the sync /api/chat save (NIT) ──────────────────────────────────────────────────────────────── #

def _sync_chat_handler_src():
    with open(os.path.join(FRONTEND, "routes", "chat_routes.py"), encoding="utf-8") as fh:
        src = fh.read()
    handler = src[src.index("async def chat_endpoint("):]
    return handler[:handler.index("@router.")]


def test_the_sync_chat_save_splits_a_framed_turn_with_the_game_flag():
    handler = _sync_chat_handler_src()
    assert "clean_thinking_for_save(reply" in handler
    call = handler[handler.index("clean_thinking_for_save(reply"):]
    assert "game=bool(ctx.framed)" in call[:200]


def test_the_sync_chat_reply_to_a_framed_turn_is_the_split_narration():
    """The caller is sent what was saved, never the raw reply with its reasoning."""
    handler = _sync_chat_handler_src()
    assert 'return {"response": _clean_reply if ctx.framed else reply}' in handler
