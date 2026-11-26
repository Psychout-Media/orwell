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


# ── ORW-1051: season B starts in the same chat as season A; nothing of A reaches B's narrator, summaries or chapters ──
def test_1051_in_chat_restart_stamps_the_boundary_and_the_next_prompt_has_none_of_season_a(monkeypatch):
    """Real path: season A is played, the confirmed createCharacter restart runs, then B's first live turn is built."""
    from routes import chat_helpers as ch
    loop = asyncio.get_event_loop()
    hist = _old_season_rows() + [ChatMessage("user", "run it back", metadata={"phase": "game", "_db_id": "9"})]
    sess = Session(id="s1051", name="n", endpoint_url="http://x", model="m", history=hist)

    class _Mgr:
        def get_session(self, sid):
            return sess

    from src import orwell_game_session
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda u: "s1051")
    monkeypatch.setattr(g.core_models, "_session_manager", _Mgr(), raising=False)
    assert ch.mark_season_boundary_for_owner("u") is True
    assert (sess.history[-1].metadata or {}).get("season_start") is True
    sess.history.append(ChatMessage("assistant", "season B opens", metadata={"phase": "game"}))
    ctx, _ = loop.run_until_complete(_drive(monkeypatch, sess.history, started=True, text="B first turn"))
    blob = _blob(ctx)
    assert OLD_SEASON not in blob and OLD_CASTING not in blob
    assert "season B opens" in blob and "B first turn" in blob


def test_1051_no_bound_chat_defers_the_boundary_to_the_next_turn(monkeypatch):
    from routes import chat_helpers as ch
    from src import orwell_game_session
    monkeypatch.setattr(orwell_game_session, "get_game_session", lambda u: None)
    assert ch.mark_season_boundary_for_owner("u-pending") is False
    sess = Session(id="s1051b", name="n", endpoint_url="http://x", model="m",
                   history=_old_season_rows() + [ChatMessage("user", "go", metadata={})])
    ch._consume_pending_season_boundary(sess, "u-pending")
    assert (sess.history[-1].metadata or {}).get("season_start") is True
    assert "u-pending" not in ch._PENDING_SEASON_BOUNDARY


def test_1051_day_summary_and_week_chapter_read_only_the_current_season():
    from core.models import current_season_rows
    from src import orwell_day_condense as dc, orwell_week_chapter as wc
    old = [ChatMessage("user", f"{OLD_SEASON} arrives", metadata={"game_day": 1}),
           ChatMessage("assistant", "old narration", metadata={"game_day": 1, "kind": wc.KIND, "week": 1})]
    new = [ChatMessage("user", "new arrives", metadata={"game_day": 1, "season_start": True}),
           ChatMessage("assistant", "new narration", metadata={"game_day": 1})]
    rows = current_season_rows(old + new)
    assert OLD_SEASON not in dc.visible_day_text(rows, 1) and "new narration" in dc.visible_day_text(rows, 1)
    assert OLD_SEASON in dc.visible_day_text(old + new, 1)  # control: the whole chat would have merged them
    assert wc._has_chapter(old + new, 1) is True and wc._has_chapter(rows, 1) is False


def test_1051_old_rows_stay_stored_and_viewable():
    sess = Session(id="s1051c", name="n", endpoint_url="http://x", model="m",
                   history=_old_season_rows() + [ChatMessage("user", "B", metadata={"season_start": True})])
    assert len(sess.history) == 5
    assert OLD_SEASON not in " ".join(str(m["content"]) for m in sess.get_context_messages(current_season_only=True))
    assert OLD_SEASON in " ".join(str(m["content"]) for m in sess.get_context_messages())


def test_1051_recent_seasons_avoid_sets_still_apply_after_the_chat_is_scoped(tmp_path, monkeypatch):
    """The cross-season memory is a ledger of avoid sets (not chat), so scoping the chat leaves it untouched."""
    import importlib
    ledger = importlib.import_module("src.orwell_recent_seasons")
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "l.json")
    ledger.record_season("u", {"names": ["Avoid Name"], "hometowns": ["Avoid Town"]})
    sess = Session(id="s1051d", name="n", endpoint_url="http://x", model="m",
                   history=_old_season_rows() + [ChatMessage("user", "B", metadata={"season_start": True})])
    assert OLD_SEASON not in " ".join(str(m["content"]) for m in sess.get_context_messages(current_season_only=True))
    avoid = ledger.avoid_for("u")
    assert "Avoid Name" in avoid["names"] and "Avoid Town" in avoid["hometowns"]
