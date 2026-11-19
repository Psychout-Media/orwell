"""ORW-718: a game reset keeps the chat, so an earlier season's rows sit above the new season's casting interview.
The narrator's context must start at the new season: no earlier season's name may reach the model (a returner
the ENGINE names is not a chat row and is untouched). Roles only; sentinels are non-name tokens."""
import asyncio

import pytest

import test_casting_leak_gate as g
from core.models import ChatMessage, Session

OLD_SEASON = "ZZ-OLD-SEASON-houseguest-ZZ"
OLD_CASTING = "ZZ-OLD-CASTING-name-ZZ"
NEW_CASTING = "ZZ-NEW-CASTING-line-ZZ"


def _old_season_rows():
    return [
        ChatMessage("user", f"casting: {OLD_CASTING}", metadata={"phase": "casting", "_db_id": "1"}),
        ChatMessage("assistant", "producer", metadata={"phase": "casting", "_db_id": "2"}),
        ChatMessage("user", "I walk in", metadata={"phase": "game", "_db_id": "3"}),
        ChatMessage("assistant", f"narration with {OLD_SEASON}", metadata={"_db_id": "4"}),
    ]


async def _drive(monkeypatch, history, *, started, text, framing=None):
    monkeypatch.setattr(g.core_models, "_session_manager", None, raising=False)
    sess = Session(id="s718", name="n", endpoint_url="http://x", model="m", history=history)

    async def fake_framing(preface, user, incognito=False, **kw):
        return framing or (True, started, False)

    monkeypatch.setattr(g.chat_helpers, "apply_game_framing", fake_framing)
    monkeypatch.setattr(g.chat_helpers, "extract_preset", lambda ch, pid: g.chat_helpers.PresetInfo(
        temperature=None, max_tokens=None, system_prompt=None, character_name=None))

    async def fake_pre(*a, **k):
        return g._FakePreprocessed(text)

    monkeypatch.setattr(g.chat_helpers, "preprocess", fake_pre)
    monkeypatch.setattr(g.chat_helpers, "fire_message_event", lambda *a, **k: None)
    monkeypatch.setattr("src.auth_helpers.effective_user", lambda req: "u")
    monkeypatch.setattr(g.chat_helpers, "load_prefs_for_user", lambda u: {})
    monkeypatch.setattr(g.chat_helpers, "front_end_context_sources",
                        lambda incognito=False: {"memory": False, "skills": False, "rag": False, "web": False})
    monkeypatch.setattr(g.chat_helpers, "_normalize_model_id_from_cache", lambda s: None)
    monkeypatch.setattr(g.chat_helpers, "normalize_model_id", lambda url, model: None)

    async def fake_compact(sess, url, model, messages, headers, owner=None, **kw):
        return messages, 8000, False

    monkeypatch.setattr(g.chat_helpers, "maybe_compact", fake_compact)
    monkeypatch.setattr(g.chat_helpers, "trim_for_context", lambda messages, ctx_len, **kw: messages)
    ctx = await g.chat_helpers.build_chat_context(
        sess, request=object(), chat_handler=g._FakeChatHandler(), chat_processor=g._FakeChatProcessor(),
        message=text, session_id="s718", use_enhanced_message=True)
    return ctx, sess


def _blob(ctx):
    return " ".join(m["content"] if isinstance(m["content"], str) else str(m["content"]) for m in ctx.messages)


def test_positive_control_old_season_rows_reach_the_model_without_a_season_start(monkeypatch):
    """The planted sentinel is really in the chat and a plain in-game turn does send it (so the absence below means something)."""
    ctx, _ = asyncio.get_event_loop().run_until_complete(
        _drive(monkeypatch=monkeypatch, history=_old_season_rows(), started=True, text="same season turn"))
    assert OLD_SEASON in _blob(ctx)


def test_new_season_casting_turn_opens_the_season_and_hides_the_old_one(monkeypatch):
    loop = asyncio.get_event_loop()
    # the new season's first casting turn (the engine answered, no season, not feeds-down)
    ctx, sess = loop.run_until_complete(_drive(monkeypatch, _old_season_rows(), started=False, text=f"new casting {NEW_CASTING}"))
    assert (sess.history[-1].metadata or {}).get("season_start") is True
    blob = _blob(ctx)
    assert OLD_SEASON not in blob and OLD_CASTING not in blob
    assert NEW_CASTING in blob
    # the new season goes live: the in-game context still holds none of the old season
    sess.history.append(ChatMessage("assistant", "producer", metadata={"phase": "casting"}))
    ctx2, sess = loop.run_until_complete(_drive(monkeypatch, sess.history, started=True, text="live turn"))
    b2 = _blob(ctx2)
    assert OLD_SEASON not in b2 and OLD_CASTING not in b2 and NEW_CASTING not in b2  # casting stays excluded too
    assert "live turn" in b2


def test_feeds_down_mid_season_never_opens_a_season(monkeypatch):
    ctx, sess = asyncio.get_event_loop().run_until_complete(
        _drive(monkeypatch, _old_season_rows(), started=False, text="blip", framing=(False, False, True)))
    assert not (sess.history[-1].metadata or {}).get("season_start")
    assert OLD_SEASON in _blob(ctx)  # the season's own context is kept through an outage


def test_first_season_casting_is_not_a_season_start(monkeypatch):
    hist = [ChatMessage("user", "hi", metadata={"phase": "casting"}), ChatMessage("assistant", "p", metadata={"phase": "casting"})]
    _, sess = asyncio.get_event_loop().run_until_complete(_drive(monkeypatch, hist, started=False, text="more casting"))
    assert not (sess.history[-1].metadata or {}).get("season_start")


def test_a_second_reset_cuts_at_the_newest_season(monkeypatch):
    hist = _old_season_rows() + [
        ChatMessage("user", "s2 casting", metadata={"phase": "casting", "season_start": True}),
        ChatMessage("user", "s2 play", metadata={"phase": "game"}),
        ChatMessage("assistant", "SECOND-SEASON-NARRATION", metadata={}),
    ]
    ctx, sess = asyncio.get_event_loop().run_until_complete(_drive(monkeypatch, hist, started=False, text="s3 casting"))
    assert (sess.history[-1].metadata or {}).get("season_start") is True
    b = _blob(ctx)
    assert "SECOND-SEASON-NARRATION" not in b and OLD_SEASON not in b
