"""Vault Wall — casting-interview leak gate (P0 regression gate).

The pre-game CASTING INTERVIEW (feature 0050) is an OOC, producer-level channel — like the
Diary Room, it has NO in-game pathway to any NPC's knowledge. A live playtest showed the
player's private casting answers (strategy, targets, OOC reads) leaking into the in-game
narrator's LLM context, so the houseguests referenced them once the game started. The model
"cannot leak what it never receives": once a season is live, the in-game narration context
must EXCLUDE the casting-interview turns. The player still SEES them in scrollback (one
continuous conversation, per #375) — but the narrator never receives them.

This is the permanent structural gate for that boundary. It fails on the old behavior (the
full transcript, casting turns included, fed to the in-game narrator) and passes on the fix
(casting turns stamped `phase=casting` and excluded once `game_active`).

Roles only — no houseguest/player names. The sentinel is a unique, non-game token so a leak
is unambiguous.
"""

import asyncio
import importlib
import json
import os
import tempfile
import types

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
core_models = importlib.import_module("core.models")
from core.models import Session, ChatMessage  # noqa: E402

# A unique phrase that ONLY ever appears in the player's private casting answers. If it shows
# up in the in-game narrator context, the casting interview leaked.
CASTING_SENTINEL = "ZZ-CASTING-SECRET-target-the-comp-beast-week-one-ZZ"
INGAME_TOKEN = "in-game move the player makes after the doors open"

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ─────────────────────────────────────────────────────────────────────────────
# 1. The filter mechanism — get_context_messages(exclude_phases=...)
#    The in-game narrator context drops casting turns; display/pre-game keeps them.
# ─────────────────────────────────────────────────────────────────────────────

def _seed_session() -> Session:
    """A session whose history mixes the OOC casting interview with live-game turns."""
    return Session(
        id="s", name="n", endpoint_url="u", model="m",
        history=[
            ChatMessage("user", f"my private strategy: {CASTING_SENTINEL}",
                        metadata={"phase": "casting"}),
            ChatMessage("assistant", "producer: love it, welcome to the cast",
                        metadata={"phase": "casting"}),
            ChatMessage("user", INGAME_TOKEN, metadata={}),
            ChatMessage("assistant", "narrator: the houseguests gather", metadata={}),
        ],
    )


def test_in_game_context_excludes_the_casting_interview():
    sess = _seed_session()
    ingame = sess.get_context_messages(exclude_phases={"casting"})
    blob = " ".join(m["content"] for m in ingame)
    # The Vault Wall: the player's private casting answer never reaches the in-game narrator.
    assert CASTING_SENTINEL not in blob, "casting interview leaked into the in-game context"
    # The live play is still present — the fix scopes context, it does not erase the game.
    assert INGAME_TOKEN in blob


def test_pre_game_and_display_paths_keep_the_full_transcript():
    sess = _seed_session()
    # Pre-game / casting turns (no exclusion) and every display/history path see everything —
    # the player always sees their own interview in scrollback.
    full = sess.get_context_messages()
    assert CASTING_SENTINEL in " ".join(m["content"] for m in full)
    assert len(full) == 4
    # The raw history (what the transcript renders) is untouched.
    assert any(CASTING_SENTINEL in m.content for m in sess.history)


def test_default_exclusion_is_off_so_non_game_chats_are_unaffected():
    # No phases ⇒ identical to the legacy behavior (only the slash filter applies).
    sess = _seed_session()
    assert sess.get_context_messages(exclude_phases=None) == sess.get_context_messages()


# ─────────────────────────────────────────────────────────────────────────────
# 2. The boundary wiring — build_chat_context stamps casting turns and, once the
#    game is live, builds the model context WITHOUT them. Drives the REAL function.
# ─────────────────────────────────────────────────────────────────────────────

class _FakePreprocessed:
    def __init__(self, text):
        self.enhanced_message = text
        self.user_content = text
        self.text_for_context = text
        self.youtube_transcripts = []
        self.attachment_meta = []


class _FakeChatHandler:
    def update_session_name_if_needed(self, sess, text):
        pass


class _FakeChatProcessor:
    _last_used_memories = []

    def build_context_preface(self, **kwargs):
        # (preface, rag_sources, web_sources)
        return ([{"role": "system", "content": "GM-FRAME"}], [], [])


_COMPACT_KWARGS: list = []


async def _drive_build_chat_context(monkeypatch, *, started: bool, new_user_text: str, framing=None):
    """Run the REAL build_chat_context against a seeded session, with leaf collaborators
    stubbed and the engine's started-state forced. Returns (ctx, sess)."""
    # No session manager: history + the phase stamp stay in-memory (enough to exercise the
    # real stamp + real exclusion). DB durability is covered separately below.
    monkeypatch.setattr(core_models, "_session_manager", None, raising=False)

    sess = Session(
        id="s2", name="n", endpoint_url="http://x", model="m",
        history=[
            ChatMessage("user", f"private read: {CASTING_SENTINEL}",
                        metadata={"phase": "casting", "_db_id": "a"}),
            ChatMessage("assistant", "producer reply", metadata={"phase": "casting", "_db_id": "b"}),
        ],
    )

    # Force the engine boundary: started=True ⇒ in-game; started=False ⇒ casting.
    async def fake_framing(preface, user, incognito=False, **kwargs):
        return framing or (True, started, False)  # (engine_available, game_active, feed_down)

    monkeypatch.setattr(chat_helpers, "apply_game_framing", fake_framing)
    monkeypatch.setattr(chat_helpers, "extract_preset", lambda ch, pid: chat_helpers.PresetInfo(
        temperature=None, max_tokens=None, system_prompt=None, character_name=None))

    async def fake_preprocess(*a, **k):
        return _FakePreprocessed(new_user_text)

    monkeypatch.setattr(chat_helpers, "preprocess", fake_preprocess)
    monkeypatch.setattr(chat_helpers, "fire_message_event", lambda *a, **k: None)
    monkeypatch.setattr("src.auth_helpers.effective_user", lambda req: "u")
    monkeypatch.setattr(chat_helpers, "load_prefs_for_user", lambda u: {})
    monkeypatch.setattr(chat_helpers, "front_end_context_sources",
                        lambda incognito=False: {"memory": False, "skills": False, "rag": False, "web": False})
    monkeypatch.setattr(chat_helpers, "_normalize_model_id_from_cache", lambda s: None)
    monkeypatch.setattr(chat_helpers, "normalize_model_id", lambda url, model: None)

    async def fake_compact(sess, url, model, messages, headers, owner=None, **kw):
        _COMPACT_KWARGS.append(dict(kw))
        return messages, 8000, False

    monkeypatch.setattr(chat_helpers, "maybe_compact", fake_compact)
    monkeypatch.setattr(chat_helpers, "trim_for_context", lambda messages, ctx_len, **kw: messages)

    ctx = await chat_helpers.build_chat_context(
        sess, request=object(), chat_handler=_FakeChatHandler(),
        chat_processor=_FakeChatProcessor(), message=new_user_text, session_id="s2",
        use_enhanced_message=True,
    )
    return ctx, sess


def test_live_game_turn_strips_casting_from_the_model_context(monkeypatch):
    ctx, sess = _run(_drive_build_chat_context(
        monkeypatch, started=True, new_user_text="I sidle up to the kitchen and chat"))
    assert ctx.game_active is True
    blob = " ".join(
        (m["content"] if isinstance(m["content"], str) else str(m["content"]))
        for m in ctx.messages
    )
    # THE GATE: the in-game narrator's context never carries the casting interview.
    assert CASTING_SENTINEL not in blob, "build_chat_context leaked the casting interview in-game"
    # The new live user turn IS in the model context (play still flows).
    assert "kitchen" in blob


def test_pre_game_turn_stamps_casting_and_keeps_the_interview(monkeypatch):
    ctx, sess = _run(_drive_build_chat_context(
        monkeypatch, started=False, new_user_text="here's how I'd play it"))
    assert ctx.game_active is False
    # The just-added user message is stamped casting (so the NEXT, live turn excludes it).
    assert sess.history[-1].role == "user"
    assert (sess.history[-1].metadata or {}).get("phase") == "casting"
    # Pre-game, the producer still sees the whole interview (the prior casting answers stay).
    blob = " ".join(
        (m["content"] if isinstance(m["content"], str) else str(m["content"]))
        for m in ctx.messages
    )
    assert CASTING_SENTINEL in blob


def test_orw224_game_and_casting_turns_never_persist_compaction(monkeypatch):
    """ORW-224: build_chat_context tells maybe_compact NOT to persist (compaction deletes stored rows) when
    the turn is a live game (game_active) or a framed casting turn; and to persist for a plain chat."""
    _COMPACT_KWARGS.clear()
    _run(_drive_build_chat_context(monkeypatch, started=True, new_user_text="live game turn"))
    assert _COMPACT_KWARGS[-1].get("persist_history") is False, "game_active turn"

    # framed but pre-game (casting): framing returns (engine_available, game_active=False, feed_down) and framed=True
    _COMPACT_KWARGS.clear()
    _run(_drive_build_chat_context(monkeypatch, started=False, new_user_text="casting turn"))
    assert _COMPACT_KWARGS[-1].get("persist_history") is False, "framed casting turn"

    # a plain, unframed chat (no engine): compaction behaves as before
    _COMPACT_KWARGS.clear()
    _run(_drive_build_chat_context(monkeypatch, started=False, new_user_text="plain chat", framing=(False, False, False)))
    assert _COMPACT_KWARGS[-1].get("persist_history") is True, "unframed chat"


def test_orw224b_workspace_build_turn_is_not_stamped_casting_and_can_compact(monkeypatch):
    """ORW-224b: in the workspace build (ORWELL_GAME_BUILD=0) an unframed turn gets NO casting stamp, so the session is
    not treated as a game session by the compaction guard; the game build still stamps casting (test above)."""
    from src.context_compactor import is_game_or_casting_session
    monkeypatch.setenv("ORWELL_GAME_BUILD", "0")
    ctx, sess = _run(_drive_build_chat_context(
        monkeypatch, started=False, new_user_text="plain workspace chat", framing=(False, False, False)))
    assert sess.history[-1].role == "user"
    assert (sess.history[-1].metadata or {}).get("phase") is None
    assert is_game_or_casting_session(sess) is False, "workspace-build chat keeps compaction"


def test_orw224b_game_build_casting_turn_is_still_stamped_and_refused(monkeypatch):
    from src.context_compactor import is_game_or_casting_session
    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    ctx, sess = _run(_drive_build_chat_context(monkeypatch, started=False, new_user_text="casting answer"))
    assert (sess.history[-1].metadata or {}).get("phase") == "casting"
    assert is_game_or_casting_session(sess) is True


# ─────────────────────────────────────────────────────────────────────────────
# 3. The assistant-reply plumbing — save_assistant_response(phase=...) stamps, and
#    both chat-route call sites pass the casting phase when pre-game.
# ─────────────────────────────────────────────────────────────────────────────

def test_save_assistant_response_stamps_the_casting_phase(monkeypatch):
    monkeypatch.setattr(core_models, "_session_manager", None, raising=False)
    sess = Session(id="s3", name="n", endpoint_url="u", model="m", history=[])

    captured = {}

    class _SM:
        def save_sessions(self):
            captured["saved"] = True

    monkeypatch.setattr("core.database.update_session_last_accessed", lambda sid: None)
    chat_helpers.save_assistant_response(
        sess, _SM(), "s3", "producer: you're cast!", None, phase="casting")
    assert sess.history[-1].metadata.get("phase") == "casting"

    # Default: no phase ⇒ an ordinary reply carries no phase marker.
    chat_helpers.save_assistant_response(sess, _SM(), "s3", "ordinary reply", None)
    assert "phase" not in (sess.history[-1].metadata or {})


def test_both_route_save_sites_pass_the_casting_phase():
    """Drift guard: both save_assistant_response call sites in the chat route stamp the
    casting phase for an OOC pre-game reply (so the agent + chat branches both wall it)."""
    with open(os.path.join(FRONTEND, "routes", "chat_routes.py"), encoding="utf-8") as f:
        src = f.read()
    occurrences = src.count(
        'phase=("casting" if (ctx.framed and not ctx.game_active) else None)')
    assert occurrences == 2, f"expected both route save sites to pass the casting phase, got {occurrences}"


def test_build_chat_context_wires_the_in_game_exclusion():
    """Drift guard for the boundary: build_chat_context excludes casting turns once the
    game is live, and stamps the user turn casting pre-game."""
    with open(os.path.join(FRONTEND, "routes", "chat_helpers.py"), encoding="utf-8") as f:
        src = f.read()
    assert '_exclude_phases = {"casting"} if game_active else None' in src
    assert "exclude_phases=_exclude_phases" in src
    assert 'mark_message_phase(_last, "casting")' in src
    # #530: the STRUCTURAL pre-game cut is wired (exclude_pre_game) and the live boundary is stamped.
    assert "exclude_pre_game=bool(game_active)" in src
    assert 'mark_message_phase(_last, "game")' in src


# ─────────────────────────────────────────────────────────────────────────────
# 5. #530 STRUCTURAL — an UNSTAMPED pre-game (casting) turn must STILL be excluded
#    once the game is live, so a missed `casting` stamp at the finalize boundary
#    can never leak the interview to the in-game narrator.
# ─────────────────────────────────────────────────────────────────────────────

def test_unstamped_pre_game_turn_is_still_excluded_structurally():
    # The stamp MISSED on the casting turns (metadata empty). The only durable signal is the
    # live `game` boundary on the first in-game user turn. The structural cut must still drop
    # every pre-game turn before that boundary — the unstamped casting answer included.
    sess = Session(
        id="s5", name="n", endpoint_url="u", model="m",
        history=[
            # UNSTAMPED casting interview (the bug: the phase stamp never landed).
            ChatMessage("user", f"private read: {CASTING_SENTINEL}", metadata={}),
            ChatMessage("assistant", "producer: welcome to the cast", metadata={}),
            # The season went live — this live user turn carries the `game` boundary stamp.
            ChatMessage("user", INGAME_TOKEN, metadata={"phase": "game"}),
            ChatMessage("assistant", "narrator: the houseguests gather", metadata={}),
        ],
    )
    ingame = sess.get_context_messages(exclude_phases={"casting"}, exclude_pre_game=True)
    blob = " ".join(m["content"] for m in ingame)
    assert CASTING_SENTINEL not in blob, "unstamped casting turn leaked into the in-game context"
    # Live play from the boundary onward is intact.
    assert INGAME_TOKEN in blob
    assert "houseguests gather" in blob


def test_pre_game_path_keeps_unstamped_interview_when_not_live():
    # Before the season is live (no `exclude_pre_game`), the full interview is still visible to
    # the producer channel — the cut is scoped to live turns only.
    sess = Session(
        id="s6", name="n", endpoint_url="u", model="m",
        history=[ChatMessage("user", f"private: {CASTING_SENTINEL}", metadata={})],
    )
    full = sess.get_context_messages(exclude_phases=None, exclude_pre_game=False)
    assert CASTING_SENTINEL in " ".join(m["content"] for m in full)


# ─────────────────────────────────────────────────────────────────────────────
# 6. #1312 THE FINALIZE→PREMIERE TRANSITION TURN — the one turn build_chat_context's
#    game_active exclusion cannot cover. apply_game_framing computes game_active at
#    turn-START (False, pre-game), so build_chat_context keeps the casting interview;
#    then createCharacter starts the season MID-TURN and the SAME turn narrates the
#    move-in. The agent loop purges the OOC casting channel the instant the season goes
#    live (_strip_pregame_context), so the premiere continuation is structurally unable
#    to carry a casting disclosure into the houseguests' first impressions.
# ─────────────────────────────────────────────────────────────────────────────

def test_finalize_turn_premiere_context_excludes_casting_after_purge(monkeypatch):
    # Drive the REAL build_chat_context for the FINALIZE turn: game_active is still False
    # (the engine had not started the season when framing ran), so the casting interview is
    # LEGITIMATELY in the built context — the pre-game producer needs it.
    from src.agent_loop import _strip_pregame_context

    ctx, sess = _run(_drive_build_chat_context(
        monkeypatch, started=False, new_user_text="lock me in, put me in the house"))
    assert ctx.game_active is False
    blob_before = " ".join(
        (m["content"] if isinstance(m["content"], str) else str(m["content"]))
        for m in ctx.messages
    )
    # Pre-finalize the interview is present (this is correct — pre-game is OOC producer channel).
    assert CASTING_SENTINEL in blob_before, "sanity: the finalize turn holds the interview pre-purge"

    # createCharacter fires mid-turn and the season goes live. The agent loop purges the OOC
    # casting channel from the working context BEFORE the premiere continuation narrates the
    # move-in. THE GATE: the context that produces the premiere narration carries no casting.
    dropped = _strip_pregame_context(ctx.messages)
    assert dropped >= 1
    blob_after = " ".join(
        (m["content"] if isinstance(m["content"], str) else str(m["content"]))
        for m in ctx.messages
    )
    assert CASTING_SENTINEL not in blob_after, \
        "the finalize→premiere transition leaked the casting interview into the in-game narrator"


def test_strip_pregame_context_scrubs_the_engine_casting_status_disclosure():
    # The SECOND carrier of the disclosures (besides the interview turns): the engine's
    # "CASTING STATUS — already on file: …" block, which echoes the on-file intake — incl. the
    # player's private strategy — into the pre-game SYSTEM preface (momentPrompts.ts). On the
    # same-turn continuation that frame is still messages[0], so the purge must scrub it too.
    from src.agent_loop import _strip_pregame_context

    messages = [
        {"role": "system", "content":
            "You are the show's producer.\n"
            f"- CASTING STATUS — already on file (do not re-ask): privateStrategy: \"{CASTING_SENTINEL}\"\n"
            "- READY TO START: enough is on file to cast a real houseguest."},
        {"role": "assistant", "content": "tool result: the house is cast"},  # createCharacter result — KEPT
        {"role": "system", "content": "Narrate the premiere move-in now."},   # in-game note — KEPT
    ]
    _strip_pregame_context(messages)
    blob = " ".join(m["content"] for m in messages)
    assert CASTING_SENTINEL not in blob, "the CASTING STATUS disclosure leaked into the premiere frame"
    # The premiere still has its in-game material (the season is cast; move-in note stands).
    assert "the house is cast" in blob
    assert "premiere move-in" in blob
    # The producer frame itself survives (only the disclosure line is scrubbed).
    assert "You are the show's producer." in blob


def test_scrub_producer_fields_is_structural_not_string_scanning():
    """A player-entered interview note containing a literal `]` must NOT defeat the scrub. The old
    string-scan stopped at the first `]` (even inside a quoted note), leaving the producer-only tail
    in the retained createCharacter args → premiere leak. The scrub now parses the JSON structurally
    (Greptile P1, #1707), so a `]`/`"` inside a value can't terminate the array early."""
    from src.agent_loop import _scrub_producer_fields

    # `]` inside a quoted note, with a producer-only sentinel AFTER the bracket.
    args = json.dumps({
        "name": "Player",
        "backstory": f"ran a summer camp {CASTING_SENTINEL}",
        "interviewNotes": [f"private ] {CASTING_SENTINEL}", "target is the veteran"],
        "vocation": "teacher",
    })
    out = _scrub_producer_fields(args)
    assert CASTING_SENTINEL not in out, "producer-only tail survived the `]`-in-note scrub"
    assert "interviewNotes" not in out and "backstory" not in out
    # Public facets the model legitimately needs are untouched.
    assert "teacher" in out and "Player" in out

    # A JSON fragment embedded in prose (falls to the string-aware regex) — still no leak.
    frag = f'note {{"interviewNotes":["a ] {CASTING_SENTINEL}","b"],"vocation":"nurse"}} end'
    out2 = _scrub_producer_fields(frag)
    assert CASTING_SENTINEL not in out2 and "nurse" in out2

    # No producer keys ⇒ byte-identical (never mangles normal content).
    clean = '{"vocation":"chef","biography":"likes food"}'
    assert _scrub_producer_fields(clean) == clean


def test_purge_that_removes_every_user_turn_inserts_the_readiness_bridge():
    """2026-07-17 (the finalize-turn 400s): purging every casting-stamped turn also removes
    the player's own finalize line, leaving [system, assistant(tool_calls), tool] — a shape
    some GLM providers (Novita) reject with HTTP 400, so the premiere opener could never be
    model-authored there. The purge must restore a valid conversation shape with the FIXED,
    disclosure-free readiness bridge as the player's voice — and nothing else."""
    from src.agent_loop import _strip_pregame_context, _PREGAME_PURGE_USER_BRIDGE

    messages = [
        {"role": "system", "content": "GM frame"},
        {"role": "user", "content": f"finalize me: {CASTING_SENTINEL}",
         "metadata": {"phase": "casting"}},
        {"role": "assistant", "content": "createCharacter tool_call",
         "tool_calls": [{"id": "c1", "function": {"name": "createCharacter"}}]},
        {"role": "tool", "content": "### createCharacter\nstarted", "tool_call_id": "c1"},
    ]
    dropped = _strip_pregame_context(messages)
    assert dropped == 1
    users = [m for m in messages if m.get("role") == "user"]
    assert len(users) == 1, "the purge must leave exactly one user turn (the bridge)"
    assert users[0]["content"] == _PREGAME_PURGE_USER_BRIDGE
    assert CASTING_SENTINEL not in users[0]["content"]
    # The bridge sits between the system frame and the assistant tool_call — a valid shape.
    roles = [m.get("role") for m in messages]
    assert roles == ["system", "user", "assistant", "tool"]


def test_purge_keeps_a_surviving_live_user_turn_and_adds_no_bridge():
    """A live (non-casting) user turn that survives the purge already gives the provider a
    valid shape — the bridge must NOT be added on top of it."""
    from src.agent_loop import _strip_pregame_context, _PREGAME_PURGE_USER_BRIDGE

    messages = [
        {"role": "system", "content": "GM frame"},
        {"role": "user", "content": f"interview: {CASTING_SENTINEL}",
         "metadata": {"phase": "casting"}},
        {"role": "user", "content": INGAME_TOKEN, "metadata": {"phase": "game"}},
        {"role": "assistant", "content": "createCharacter → house cast"},
    ]
    assert _strip_pregame_context(messages) == 1
    contents = [m["content"] for m in messages if m.get("role") == "user"]
    assert contents == [INGAME_TOKEN]
    assert _PREGAME_PURGE_USER_BRIDGE not in " ".join(contents)


def test_strip_pregame_context_is_idempotent_and_keeps_live_turns():
    from src.agent_loop import _strip_pregame_context

    # ADR 0019: the retained createCharacter tool RESULT now carries the player's producer material
    # (castingCard.story) in the finalize round — the purge KEEPS the result but SCRUBS those fields
    # (it used to keep it verbatim, the #1312 leak this PR closes). The result's non-producer content
    # (the started/house payload) still stands, and the live turn is untouched.
    kept_result = (
        '### createCharacter\n```\n'
        '{"started": true, "player": {"name": "The Player", "archetype": "strategist",'
        f' "castingCard": {{"characterType": "strategist", "story": "{CASTING_SENTINEL}",'
        ' "strengths": {"physical": "solid"}}}}}\n```'
    )
    messages = [
        {"role": "system", "content": "GM frame"},
        {"role": "user", "content": f"interview: {CASTING_SENTINEL}", "metadata": {"phase": "casting"}},
        {"role": "assistant", "content": "producer reply", "metadata": {"phase": "casting"}},
        {"role": "assistant", "content": kept_result},                               # tool result — KEPT but SCRUBBED
        {"role": "user", "content": INGAME_TOKEN, "metadata": {"phase": "game"}},     # live turn — KEPT
    ]
    first = _strip_pregame_context(messages)
    assert first == 2  # both casting turns dropped
    second = _strip_pregame_context(messages)
    assert second == 0  # idempotent — nothing left to drop
    blob = " ".join(m["content"] for m in messages)
    # The producer material is gone from EVERY retained message (interview turns dropped, result scrubbed).
    assert CASTING_SENTINEL not in blob
    # The live turn survives, and the createCharacter result is KEPT (only its producer fields scrubbed).
    assert INGAME_TOKEN in blob
    assert '"started": true' in blob
    assert '"characterType": "strategist"' in blob


# ─────────────────────────────────────────────────────────────────────────────
# 4. DB durability — the phase marker lands on the persisted row, so it survives a
#    reload (future turns reload from DB and still exclude the casting interview).
# ─────────────────────────────────────────────────────────────────────────────

def test_mark_message_phase_persists_to_the_db():
    import json
    from core.session_manager import SessionManager
    from core.models import set_session_manager
    from core import database as db

    sm = SessionManager()
    prior = getattr(core_models, "_session_manager", None)
    # Register as the global so Session.add_message persists through the manager (assigning
    # the DB id that mark_message_phase needs). Restore the prior global afterward.
    set_session_manager(sm)
    try:
        sid = "durable-casting-sess"
        sm.create_session(sid, "durability", "http://x", "m", owner="u")
        sess = sm.get_session(sid)

        msg = ChatMessage("user", f"private: {CASTING_SENTINEL}", metadata={})
        sess.add_message(msg)              # persists the row, assigns _db_id
        sm.mark_message_phase(msg, "casting")

        # Read the row straight from the DB — the phase marker is durable, so a future turn
        # that reloads history still excludes the casting interview.
        s = db.SessionLocal()
        try:
            row = s.query(db.ChatMessage).filter(
                db.ChatMessage.id == msg.metadata["_db_id"]).first()
            assert row is not None
            meta = json.loads(row.meta_data)
            assert meta.get("phase") == "casting"
        finally:
            s.close()
    finally:
        set_session_manager(prior)


# ─────────────────────────────────────────────────────────────────────────────
# 7. ADR 0019 — "context is not knowledge" (mandate #2, enforcement instance #1).
#    The player's PRODUCER-ONLY casting material (backstory/motivation) rides on the
#    engine's Vault-free game VIEW (`player.castingCard.story`/`motivation`), which the
#    engine returns from EVERY view tool (getGameState, createCharacter, advanceGame, …).
#    A live playtest showed a houseguest echo it. The MODEL-facing enforcement point is
#    `tool_execution.format_tool_result` — the ONE seam every tool result crosses into the
#    narrator's context — so the producer fields are redacted there for all tools at once.
#    The PLAYER still gets the reveal (narrated in the finalize round + rendered from the
#    FE's own stored view); the MODEL never receives the raw backstory.
# ─────────────────────────────────────────────────────────────────────────────

# A view that carries the player's producer-only casting material, as EVERY view-returning engine
# tool serializes it. The CASTING_SENTINEL is planted as the backstory so it lands in castingCard.story.
def _view_with_producer_material() -> dict:
    return {
        "started": True,
        "week": 1,
        "phase": "premiere",
        "player": {
            "id": "player",
            "name": "The Player",
            "archetype": "quiet strategist",          # public — KEPT
            "strategyStyle": "under the radar",         # public — KEPT
            "status": "active",
            "castingCard": {
                "characterType": "quiet strategist",    # public — KEPT
                "strategyStyle": "under the radar",      # public — KEPT
                "strengths": {"physical": "solid", "mental": "standout", "social": "scrappy"},  # public — KEPT
                "story": CASTING_SENTINEL,               # PRODUCER-ONLY — must be redacted
                "motivation": "ZZ-MOTIVATION-win-for-my-family-ZZ",  # PRODUCER-ONLY — must be redacted
            },
        },
        "house": [
            {"id": "npc:1", "name": "A Houseguest", "archetype": "social butterfly",
             "background": "runs a bakery"},  # an NPC PUBLIC facet keyed `background` — must NOT be touched
        ],
    }


def test_redact_player_producer_fields_strips_only_producer_material():
    from src.tool_execution import redact_player_producer_fields

    view = _view_with_producer_material()
    redacted = redact_player_producer_fields(view)

    card = redacted["player"]["castingCard"]
    # THE WALL: the producer-only fields are gone from the model-facing view.
    assert "story" not in card
    assert "motivation" not in card
    # The public card + persona survive — the reveal still has its qualitative payoff.
    assert card["characterType"] == "quiet strategist"
    assert card["strengths"]["mental"] == "standout"
    assert redacted["player"]["archetype"] == "quiet strategist"
    # NPC public facets are untouched (the redactor is player-producer-scoped, not a blanket scrub).
    assert redacted["house"][0]["background"] == "runs a bakery"
    # The input is NEVER mutated — the FE's own stored copy stays whole for the player's card render.
    assert view["player"]["castingCard"]["story"] == CASTING_SENTINEL


def test_format_tool_result_redacts_producer_material_from_every_view_tool():
    """The model-facing chokepoint. EVERY engine tool that returns the game view (createCharacter,
    getGameState, advanceGame, submitDecision, runCompetition, …) serializes it into `output`, and
    format_tool_result is the single seam that becomes the narrator's tool-result context — so the
    producer material must never survive it, for ANY of them."""
    from src.tool_execution import format_tool_result

    view_json = json.dumps(_view_with_producer_material(), indent=2)
    for tool in ("createCharacter", "getGameState", "advanceGame", "submitDecision", "runCompetition"):
        formatted = format_tool_result(tool, {"output": view_json, "exit_code": 0})
        assert CASTING_SENTINEL not in formatted, f"{tool} tool result leaked the producer backstory to the model"
        assert "ZZ-MOTIVATION-win-for-my-family-ZZ" not in formatted, f"{tool} leaked the producer motivation"
        # The public state the model DOES need still crosses (the redaction is surgical, not a blackout).
        assert "quiet strategist" in formatted
        assert "premiere" in formatted


def test_format_tool_result_leaves_non_view_output_byte_identical():
    """Fail-open: a normal tool's output (no castingCard) is passed through unchanged — the wall never
    corrupts an ordinary result."""
    from src.tool_execution import format_tool_result

    plain = format_tool_result("bash", {"output": "story motivation backstory — just prose, no view", "exit_code": 0})
    assert "just prose, no view" in plain


def test_finalize_premiere_message_set_carries_no_producer_material_anywhere():
    """The finalize→premiere transition, end to end. The message set that produces the premiere narration
    is: the casting interview turns (phase-stamped), the model's createCharacter tool-call (its ARGS carry
    the raw backstory), and the createCharacter tool RESULT (formatted through the model-facing seam). After
    the season goes live the agent loop purges the pre-game context — the resulting premiere context must
    carry the producer material in NEITHER the transcript NOR the retained createCharacter result/args."""
    from src.agent_loop import _strip_pregame_context
    from src.tool_execution import format_tool_result

    # The createCharacter RESULT as it actually reaches the model — through format_tool_result (redacted).
    result_content = format_tool_result(
        "createCharacter", {"output": json.dumps(_view_with_producer_material(), indent=2), "exit_code": 0})

    messages = [
        {"role": "system", "content": "You are the show's producer. Narrate the premiere."},
        # The casting interview — the player's private answers (phase-stamped; dropped by the purge).
        {"role": "user", "content": f"my backstory: {CASTING_SENTINEL}", "metadata": {"phase": "casting"}},
        {"role": "assistant", "content": "producer: love it", "metadata": {"phase": "casting"}},
        # The model's createCharacter tool CALL — its arguments carry the raw producer material, and this
        # assistant turn is NOT casting-stamped, so it survives the phase purge (scrubbed by ADR 0019).
        {"role": "assistant", "content": None,
         "tool_calls": [{"id": "c1", "type": "function", "function": {
             "name": "createCharacter",
             "arguments": json.dumps({"playerName": "The Player", "backstory": CASTING_SENTINEL,
                                      "motivation": "win it all", "privateStrategy": "flip the house"})}}]},
        # The createCharacter RESULT (redacted at the model seam; the purge scrubs it again, belt-and-suspenders).
        {"role": "tool", "tool_call_id": "c1", "content": result_content},
    ]

    # Sanity: pre-purge, the interview turn + the tool-call args still hold the producer material.
    assert any(CASTING_SENTINEL in (m.get("content") or "") for m in messages)

    dropped = _strip_pregame_context(messages)
    assert dropped == 2  # both casting interview turns purged

    # THE GATE: nothing that produces the premiere narration carries the producer material — not the
    # transcript, not the retained tool result, not the retained tool-call arguments.
    def _text_of(m):
        parts = [m.get("content") or ""]
        for tc in (m.get("tool_calls") or []):
            fn = tc.get("function") or {}
            parts.append(fn.get("arguments") or "")
        return " ".join(parts)

    blob = " ".join(_text_of(m) for m in messages)
    assert CASTING_SENTINEL not in blob, "the finalize→premiere context leaked the player's casting backstory"
    assert "flip the house" not in blob, "the finalize→premiere context leaked the player's private strategy"
    # The season is still cast — the premiere has the public state it needs to narrate the move-in.
    assert "quiet strategist" in blob
