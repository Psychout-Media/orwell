"""ORW-178: the premiere's casting-context purge must fail CLOSED. If scrubbing a retained message raises, the message's text and tool-call arguments are blanked (role and shape kept), never kept raw. No model. Roles only."""
import importlib

al = importlib.import_module("src.agent_loop")


def _msgs():
    return [
        {"role": "assistant", "content": "narration with private strategy: PRIVATE-STRATEGY-TEXT", "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "createCharacter", "arguments": '{"backstory":"PRIVATE-BACKSTORY"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": '{"story":"PRIVATE-STORY"}'},
        {"role": "user", "content": "hello"},
    ]


def test_a_scrub_error_blanks_the_message_instead_of_keeping_it_raw(monkeypatch):
    def boom(text):
        raise RuntimeError("scrub failed")
    monkeypatch.setattr(al, "_scrub_producer_fields", boom)
    msgs = _msgs()
    al._strip_pregame_context(msgs)
    blob = repr(msgs)
    assert "PRIVATE" not in blob, blob
    assert [m["role"] for m in msgs] == ["assistant", "tool", "user"]  # shape intact
    assert msgs[0]["tool_calls"][0]["function"]["arguments"] == "{}"
    assert msgs[0]["tool_calls"][0]["id"] == "c1" and msgs[1]["tool_call_id"] == "c1"


def test_normal_scrubbing_is_unchanged(monkeypatch):
    msgs = [{"role": "user", "content": "plain text with no producer fields"}]
    al._strip_pregame_context(msgs)
    assert msgs[0]["content"] == "plain text with no producer fields"
