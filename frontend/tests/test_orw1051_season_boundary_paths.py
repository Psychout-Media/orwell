"""ORW-1051: season B starts in the SAME chat that played season A (prod 9faff772, 11-28). Every prompt-side reader of the chat must start at B.

The in-chat restart tool and the casting turn were already cut (test_orw718_new_season_context). These are the doors left open:
  * a keep-character restart (/next-season keep, /new-game confirm) goes straight to live play: no casting turn ever ran `mark_new_season_start`,
    so A's `game` rows stayed inside the narrator's window;
  * the show brief's last-scene tail, its adopted seen marker and the player-move parser's previous reply read the WHOLE chat;
  * the narrator's `search_chats` returned A's lines out of the full-text index.
Sentinels are non-name tokens; the positive controls show each one really sits in the chat and reaches the reader without the fix."""
import asyncio

import pytest

import test_casting_leak_gate as g
from core.models import ChatMessage, Session

OLD_NARRATION = "ZZ-OLD-SCENE-narration-tail-ZZ"
OLD_USER = "ZZ-OLD-USER-line-ZZ"
OLD_ROOM = "ZZ-OLD-ROOM"


def _season_a():
    return [
        ChatMessage("user", "casting A", metadata={"phase": "casting", "_db_id": "1"}),
        ChatMessage("assistant", "producer A", metadata={"phase": "casting", "_db_id": "2"}),
        ChatMessage("user", f"I walk in {OLD_USER}", metadata={"phase": "game", "_db_id": "3"}),
        ChatMessage("assistant", f"the house hums {OLD_NARRATION}", metadata={"_db_id": "4", "briefSeen": {"v": 1, "room": OLD_ROOM}}),
    ]


async def _drive(monkeypatch, history, *, text, started=True, reset_first=True):
    from src import orwell_engine, orwell_show_brief as sb
    from src import orwell_player_move as pm
    sb._SEEN.pop("u", None)
    sb._STASH.clear()
    monkeypatch.setattr(g.core_models, "_session_manager", None, raising=False)
    sess = Session(id="s1051x", name="n", endpoint_url="http://x", model="m", history=history)
    seen = {"tail": "unset", "prev": "unset"}

    async def fake_framing(preface, user, incognito=False, **kw):
        seen["tail"] = kw.get("last_scene_tail")
        return True, started, False

    async def fake_act_first(message, user, cid, sess=None, previous_reply=None):
        seen["prev"] = previous_reply
        return True

    async def fake_resolve(message, user, cid, previous_reply=None, **k):
        seen["prev"] = previous_reply

    monkeypatch.setattr(g.chat_helpers, "apply_game_framing", fake_framing)
    monkeypatch.setattr(pm, "act_first_before_narrator", fake_act_first)
    monkeypatch.setattr(pm, "resolve_player_move_before_narrator", fake_resolve)
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

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(g.chat_helpers, "maybe_compact", fake_compact)
    monkeypatch.setattr(g.chat_helpers, "trim_for_context", lambda messages, ctx_len, **kw: messages)
    monkeypatch.setattr(g.chat_helpers, "note_player_message", _noop)
    if reset_first:
        orwell_engine._notify_season_reset("u")  # the engine just created season B for this owner (the keep-character door fires exactly this)
    ctx = await g.chat_helpers.build_chat_context(
        sess, request=object(), chat_handler=g._FakeChatHandler(), chat_processor=g._FakeChatProcessor(),
        message=text, session_id="s1051x", use_enhanced_message=True)
    return ctx, sess, seen, sb


def _blob(ctx):
    return " ".join(m["content"] if isinstance(m["content"], str) else str(m["content"]) for m in ctx.messages)


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_control_without_a_reset_season_a_reaches_every_reader(monkeypatch):
    """No season was created: the same chat, same turn. The sentinels reach the window, the scene tail, the parser and the adopted marker."""
    ctx, sess, seen, sb = _run(_drive(monkeypatch, _season_a() + [ChatMessage("user", "same season", metadata={})],
                                      text="same season", reset_first=False))
    assert OLD_NARRATION in _blob(ctx)
    assert OLD_NARRATION in (seen["tail"] or "")
    assert OLD_NARRATION in (seen["prev"] or "")
    assert (sb._SEEN.get("u") or {}).get("room") == OLD_ROOM


def test_keep_character_restart_goes_live_with_nothing_of_season_a(monkeypatch):
    """The engine created season B (keep-character: no casting interview), B's first line is a LIVE turn. The narrator, the show brief and the move parser start at B."""
    hist = _season_a() + [ChatMessage("user", "B first live turn", metadata={"_db_id": "9"})]
    ctx, sess, seen, sb = _run(_drive(monkeypatch, hist, text="B first live turn"))
    assert (sess.history[-1].metadata or {}).get("season_start") is True
    blob = _blob(ctx)
    assert OLD_NARRATION not in blob and OLD_USER not in blob and "casting A" not in blob
    assert "B first live turn" in blob
    assert OLD_NARRATION not in (seen["tail"] or "")
    assert OLD_NARRATION not in (seen["prev"] or "")
    assert (sb._SEEN.get("u") or {}).get("room") != OLD_ROOM


def test_first_season_creation_cuts_nothing(monkeypatch):
    """A season's own creation (the casting finalize) fires the same reset signal; with no earlier season in the chat it opens no boundary."""
    hist = [ChatMessage("user", "casting", metadata={"phase": "casting"}), ChatMessage("assistant", "producer", metadata={"phase": "casting"}),
            ChatMessage("user", "first live turn", metadata={})]
    ctx, sess, seen, sb = _run(_drive(monkeypatch, hist, text="first live turn"))
    assert not (sess.history[-1].metadata or {}).get("season_start")
    assert "producer" in _blob(ctx) or "casting" in _blob(ctx) or "first live turn" in _blob(ctx)
    assert "u" not in g.chat_helpers._PENDING_SEASON_BOUNDARY and "None" not in g.chat_helpers._PENDING_SEASON_BOUNDARY


def test_a_stamped_restart_does_not_open_a_second_season_on_the_next_turn(monkeypatch):
    """The in-chat tool stamps the restart line and the reset signal also fired; B's second line must not become a new season start."""
    from routes import chat_helpers as ch
    hist = _season_a() + [ChatMessage("user", "run it back", metadata={"phase": "game", "season_start": True})]
    ch._remember_season_boundary("u")
    ch._PENDING_SEASON_BOUNDARY.discard("u")  # what mark_season_boundary_for_owner does after stamping
    hist += [ChatMessage("assistant", "B opens", metadata={"phase": "game"}), ChatMessage("user", "B second turn", metadata={"phase": "game"})]
    sess = Session(id="s", name="n", endpoint_url="x", model="m", history=hist)
    ch._consume_pending_season_boundary(sess, "u")
    assert not (sess.history[-1].metadata or {}).get("season_start")


def test_search_chats_never_returns_a_line_from_an_earlier_season(tmp_path):
    from datetime import datetime, timedelta
    import json
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from core import database as d
    from src import session_search as ss
    eng = create_engine(f"sqlite:///{tmp_path/'t.db'}")
    d.Base.metadata.create_all(eng)
    db = sessionmaker(bind=eng)()
    t0 = datetime(2026, 11, 26, 12, 0, 0)

    def row(i, role, content, meta=None):
        return d.ChatMessage(id=f"m{i}", session_id="S", role=role, content=content, timestamp=t0 + timedelta(minutes=i),
                             meta_data=json.dumps(meta) if meta else None)
    rows = [row(1, "user", "old season word zzfind"), row(2, "assistant", "old reply zzfind"),
            row(3, "user", "new season opens", {"season_start": True}), row(4, "assistant", "new reply zzfind")]
    db.add(d.Session(id="S", name="n", endpoint_url="x", model="m"))
    db.commit()
    db.add_all(rows)
    db.commit()

    def res(m):
        return ss.SessionSearchResult(message_id=m.id, session_id="S", session_name="n", role=m.role, content=m.content,
                                      content_snippet=m.content, timestamp=m.timestamp.isoformat(),
                                      context_before=[{"message_id": "m3", "role": "user", "content": "x", "timestamp": rows[2].timestamp.isoformat()},
                                                      {"message_id": "m2", "role": "assistant", "content": "old", "timestamp": rows[1].timestamp.isoformat()}][::-1],
                                      context_after=[])
    out = ss.current_season_only([res(rows[0]), res(rows[1]), res(rows[3])], db=db)
    assert [r.message_id for r in out] == ["m4"]
    assert all(c["message_id"] != "m2" for c in out[0].context_before)
    # a chat with no season start passes through whole
    assert len(ss.current_season_only([ss.SessionSearchResult("z", "OTHER", "n", "user", "c", "c", None, [], [])], db=db)) == 1
