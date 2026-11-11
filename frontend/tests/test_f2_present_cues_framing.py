"""Audit band D F2 (features 0084 / 0088 / 0096) — the npcVoice carriage cues reach the narrator.

The engine now bakes each PRESENT houseguest's Vault-safe `mood` / `currentRead` / `rivalry` cues into
the per-present-NPC knowledge block of the moment prompt (`renderGameContext`), beside `knows`/`suspects`.
The front-end's job is to carry that engine-built `systemPrompt` into the narrator's context verbatim —
these tests pin that the cue line survives `apply_game_framing` intact (no FE strip/redaction pass drops
it), and that a prompt without cues frames byte-identically. Roles only — generic probe strings.
"""
import asyncio
import importlib

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# Exactly the engine's rendered shape (src/engine/momentPrompts.ts `presentCues`).
_BLOCK_NO_CUES = (
    "GAME CONTEXT:\n"
    "- WHAT EACH HOUSEGUEST IN THE ROOM LEGITIMATELY KNOWS (voice each ONLY from THEIR OWN block —\n"
    "    · Houseguest A:\n"
    "        knows: a witnessed fact"
)
_CUE_LINE = (
    "        now (play as conduct, never state): mood worn but tense; "
    "toward the player guarded (cooling); rivalry simmering"
)
_BLOCK_WITH_CUES = _BLOCK_NO_CUES + "\n" + _CUE_LINE


def _frame(monkeypatch, system_prompt, user, session):
    monkeypatch.setattr("src.settings.game_build_enabled", lambda: True)

    async def fake_status(user=None):
        return {"phase": "hoh-competition", "pending": None}

    async def no_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        return None

    async def fake_state(user=None, **kw):
        return {"started": True, "phase": "hoh-competition", "moment": "hoh-competition"}

    async def fake_moment(moment, user=None, **_kw):
        return {"systemPrompt": system_prompt}

    monkeypatch.setattr(orwell_engine, "game_status", fake_status)
    monkeypatch.setattr(orwell_engine, "advance_game", no_advance)
    monkeypatch.setattr(orwell_engine, "get_game_state", fake_state)
    monkeypatch.setattr(orwell_engine, "get_moment_prompt", fake_moment)
    preface = []
    _engine, game_active, _feed = _run(
        chat_helpers.apply_game_framing(preface, user, False, session_id=session)
    )
    assert game_active is True
    return preface[0]["content"]


def test_narrator_context_renders_present_cues(monkeypatch):
    content = _frame(monkeypatch, _BLOCK_WITH_CUES, "uf2a", "sess-f2a")
    assert _BLOCK_WITH_CUES in content
    # Attributed under the houseguest's own label, after their knows line.
    assert content.index("· Houseguest A:") < content.index(_CUE_LINE)
    for word in ("mood worn but tense", "toward the player guarded (cooling)", "rivalry simmering"):
        assert word in content


def test_no_cues_frames_byte_identically(monkeypatch):
    with_cues = _frame(monkeypatch, _BLOCK_WITH_CUES, "uf2b", "sess-f2b")
    without = _frame(monkeypatch, _BLOCK_NO_CUES, "uf2c", "sess-f2c")
    assert "now (play as conduct" not in without
    assert with_cues.replace("\n" + _CUE_LINE, "", 1) == without
