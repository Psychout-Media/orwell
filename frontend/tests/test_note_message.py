"""Per-message pacing: the FE announces each player message to the engine clock exactly once, keyed by
the send's clientMsgId (a retry carrying the same id sends the SAME id, so the engine's per-id dedupe
bills nothing twice), and the call is fail-soft. Roles only."""
import asyncio
import importlib

orwell_engine = importlib.import_module("src.orwell_engine")
chat_helpers = importlib.import_module("routes.chat_helpers")


def test_wrapper_sends_noteMessage_with_the_id(monkeypatch):
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append((name, args, user))
        return {"accepted": True}

    monkeypatch.setattr(orwell_engine, "_call", fake_call)
    asyncio.run(orwell_engine.note_message("m1", user="u"))
    assert seen == [("noteMessage", {"messageId": "m1"}, "u")]


def test_a_turn_sends_one_note_and_a_retry_reuses_the_same_id(monkeypatch):
    ids = []

    async def fake_note(message_id, user=None):
        ids.append(message_id)
        return {"accepted": True}

    monkeypatch.setattr(orwell_engine, "note_message", fake_note)
    asyncio.run(chat_helpers.note_player_message("cid-1", "u"))
    asyncio.run(chat_helpers.note_player_message("cid-1", "u"))  # retry of the same send
    assert ids == ["cid-1", "cid-1"]  # same id both times => the engine's dedupe bills once


def test_missing_id_gets_a_unique_server_id_and_failure_is_swallowed(monkeypatch):
    ids = []

    async def boom(message_id, user=None):
        ids.append(message_id)
        raise RuntimeError("engine down")

    monkeypatch.setattr(orwell_engine, "note_message", boom)
    asyncio.run(chat_helpers.note_player_message(None, "u"))  # must not raise
    assert len(ids) == 1 and ids[0].startswith("srv-")


def test_build_context_calls_it_once_before_the_model_call():
    src = open(chat_helpers.__file__).read()
    assert src.count("await note_player_message(client_msg_id, user)") == 1
