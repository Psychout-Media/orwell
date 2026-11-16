"""A noteMessage announce that fails is logged at WARNING with its error (it used to be a DEBUG line, so a season whose clock never started left nothing in the log). Still fail-soft. Roles only."""
import asyncio
import logging


def test_a_failed_note_message_is_a_warning_with_the_error_and_never_raises(monkeypatch, caplog):
    from src import orwell_engine
    from routes import chat_helpers

    async def boom(message_id, user=None):
        raise orwell_engine.EngineToolError("turn refused: integrity check", status=409)

    monkeypatch.setattr(orwell_engine, "note_message", boom)
    with caplog.at_level(logging.WARNING):
        asyncio.new_event_loop().run_until_complete(chat_helpers.note_player_message("m1", "role-user"))
    lines = [r.getMessage() for r in caplog.records if "noteMessage failed" in r.getMessage()]
    assert lines and "EngineToolError" in lines[0] and "integrity check" in lines[0]
