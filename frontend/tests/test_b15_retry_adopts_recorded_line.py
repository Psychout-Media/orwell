"""B15 fix: a client RETRY (same clientMsgId) adopts the player's already-recorded line instead of appending a second copy; a NEW id still appends. Roles only."""
from core.models import ChatMessage, Session


def _sess():
    return Session(id="s", name="n", endpoint_url="u", model="m")


def test_same_client_msg_id_does_not_append_a_second_user_line():
    s = _sess()
    s.add_message(ChatMessage("user", "hello", metadata={"client_msg_id": "c1", "_db_id": "row1", "_seq": 2}, client_msg_id="c1"))
    retry = ChatMessage("user", "hello", metadata={"client_msg_id": "c1"}, client_msg_id="c1")
    s.add_message(retry)
    assert [m.content for m in s.history] == ["hello"]
    assert s.message_count == 1
    assert retry.metadata.get("_db_id") == "row1" and retry.metadata.get("_seq") == 2, "the retry object adopts the recorded row's ids"


def test_a_new_client_msg_id_still_appends():
    s = _sess()
    s.add_message(ChatMessage("user", "hello", client_msg_id="c1"))
    s.add_message(ChatMessage("user", "hello again", client_msg_id="c2"))
    assert [m.content for m in s.history] == ["hello", "hello again"]


def test_same_text_without_an_id_appends_and_assistant_rows_never_dedupe():
    s = _sess()
    s.add_message(ChatMessage("user", "same"))
    s.add_message(ChatMessage("user", "same"))
    s.add_message(ChatMessage("assistant", "a", client_msg_id="c1"))
    s.add_message(ChatMessage("assistant", "a", client_msg_id="c1"))
    assert [m.role for m in s.history] == ["user", "user", "assistant", "assistant"]


def test_the_id_may_live_only_in_metadata():
    s = _sess()
    s.add_message(ChatMessage("user", "x", metadata={"client_msg_id": "c9"}))
    s.add_message(ChatMessage("user", "x", metadata={"client_msg_id": "c9"}))
    assert len(s.history) == 1
