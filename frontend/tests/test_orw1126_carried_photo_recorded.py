"""ORW-1126 - Ryne's prod casting, 2026-11-28: the account photo carried over to a new season, but the new season's casting file never recorded it. So the CASTING STATUS still listed the photo as
step one, and the producer asked for a photo the player already had ("Still shows the photo slot open on my end"). The casting framing now records a carried-over photo on the engine's
casting file before the prompt is used, and re-reads the prompt, so the status and the on-file note agree. Roles only; no model."""
import asyncio
import importlib

ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")
pt = importlib.import_module("src.orwell_portraits")

ASKS = "GAME CONTEXT:\n- CASTING STATUS: nothing on file yet — a fresh interview.\n- NEXT STEP: their cast photo — what they look like"
DONE = "GAME CONTEXT:\n- CASTING STATUS — already on file (do not re-ask): castPhoto: \"uploaded\"\n- NEXT STEP: their name"


def _frame(monkeypatch, has_photo, known=None):
    calls = []
    state = {"recorded": False}

    async def get_moment_prompt(moment=None, user=None):
        return {"systemPrompt": DONE if state["recorded"] else ASKS}

    async def update_casting(fields=None, user=None):
        calls.append(fields)
        state["recorded"] = True
        return {"known": {"castPhoto": "uploaded"}}

    monkeypatch.setattr(oe, "get_moment_prompt", get_moment_prompt)
    monkeypatch.setattr(oe, "update_casting", update_casting)
    monkeypatch.setattr(pt, "intake_status", lambda user: {"present": False, "finalized": False})
    monkeypatch.setattr(pt, "user_avatar_path", lambda user: ("/x.png" if has_photo else None))
    return calls, state


def test_photo_check_is_wired_before_the_prompt_is_used():
    src = open(ch.__file__, encoding="utf-8").read()
    i = src.index("ORW-1126 (Ryne's prod casting")
    block = src[i:i + 2200]
    assert 'update_casting({"castPhoto": "uploaded"}' in block
    assert "get_moment_prompt" in block  # re-read after recording
    assert "_player_photo_on_file(user)" in block
    assert src.index("ORW-1126 (Ryne's prod casting") < src.index("CASTING_HEADSHOT_ON_FILE_NOTE\n", i)


def test_player_photo_on_file_reads_the_account_photo(monkeypatch):
    _frame(monkeypatch, has_photo=True)
    assert ch._player_photo_on_file("u1126") is True
    _frame(monkeypatch, has_photo=False)
    assert ch._player_photo_on_file("u1126") is False
