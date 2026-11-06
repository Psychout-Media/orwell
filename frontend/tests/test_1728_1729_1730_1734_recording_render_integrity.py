"""Recording + render integrity — kevinhirsch/orwell #1728, #1729, #1730, #1734.

These four issues all center on the FE render-row list and the `_auto_record_scene` hidden-layer
fold, so they land together (splitting would self-conflict):

  #1728 (D1/B2) — a cancelled generation must persist ZERO durable assistant rows (T2), and a
    "Try again" regenerate must SUPERSEDE the prior DB row by id rather than leaving it behind
    while a new one is appended (T3). This file pins the id-keyed truncate resolution
    (`SessionManager.keep_count_before_message`) that makes the supersede exact regardless of
    whether the DOM and the DB row count agree — plus the cancel-path source pin (no more
    `inject_messages` on an empty cancelled turn) — and the defer-fold-to-settle consequence half
    (B2): the hidden-layer fold for a regenerated take must never double-apply nor survive as a
    phantom for content the render log no longer contains.

  #1729 (B1) — `_auto_record_scene` must reject non-diegetic content (an OOC vent, a stream-drop
    machinery fragment) BEFORE folding it into the hidden layer as an "(overheard)" event. (The
    D2 resumable-stream half of #1729 is explicitly OUT OF SCOPE here — noted as a follow-up.)

  #1730 (B3) — the fold's witness set must be the INTERSECTION of the model's proposed `withIds`
    with the engine's own `whereabouts` presence read, not the model's guess alone.

  #1734 (B4) — `withIds` must be normalized to the canonical `npc:<n>` form and validated against
    the living roster; a malformed/unresolvable entry is rejected and logged, never coerced.

Roles only; no names (project testing rule).
"""
import asyncio

import pytest

from src import agent_loop as al


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


_HOUSE = [{"id": "npc:3", "name": "A Houseguest"}, {"id": "npc:5", "name": "Another Houseguest"}]


# ─────────────────────────────────────────────────────────────────────────────
# #1729 (B1) — the non-diegetic content classifier, in isolation.
# ─────────────────────────────────────────────────────────────────────────────

def test_ooc_double_paren_wrap_is_nondiegetic():
    assert al._is_nondiegetic_scene_text("((that was fucking weird, they seemed so combative))")


def test_ooc_prefix_is_nondiegetic():
    assert al._is_nondiegetic_scene_text("ooc: that comp result felt rigged")
    assert al._is_nondiegetic_scene_text("OOC: same, case-insensitive")


def test_stream_drop_machinery_is_nondiegetic():
    assert al._is_nondiegetic_scene_text(
        "The stream dropped before you finished. It ended with:\n\nision. She's got that intense…")


def test_interrupted_continue_machinery_is_nondiegetic():
    assert al._is_nondiegetic_scene_text(
        "Your previous response was interrupted. It ended with:\n\nsomething")


def test_ordinary_in_character_speech_is_diegetic():
    assert not al._is_nondiegetic_scene_text("I told them I'd have their back at the veto meeting.")
    assert not al._is_nondiegetic_scene_text("")
    assert not al._is_nondiegetic_scene_text(None)


# ─────────────────────────────────────────────────────────────────────────────
# #1734 (B4) — withIds normalization/validation, in isolation.
# ─────────────────────────────────────────────────────────────────────────────

_VALID = {"npc:3", "npc:5"}


def test_canonical_ids_pass_through_unchanged():
    ids, rejected = al._normalize_with_ids(["npc:3", "npc:5"], _VALID)
    assert ids == ["npc:3", "npc:5"]
    assert rejected == []


def test_bare_numeric_ints_are_normalized_when_real():
    ids, rejected = al._normalize_with_ids([3, 5], _VALID)
    assert ids == ["npc:3", "npc:5"]
    assert rejected == []


def test_bare_numeric_strings_are_normalized_when_real():
    ids, rejected = al._normalize_with_ids(["3", "5"], _VALID)
    assert ids == ["npc:3", "npc:5"]
    assert rejected == []


def test_unknown_ids_are_rejected_not_coerced():
    # npc:6 is not a living roster member — normalizing "6" to "npc:6" would be a GUESS, not a fact.
    ids, rejected = al._normalize_with_ids(["npc:3", "6", "npc:99", "garbage"], _VALID)
    assert ids == ["npc:3"]
    assert set(rejected) == {"6", "npc:99", "garbage"}


def test_duplicate_ids_are_deduped():
    ids, rejected = al._normalize_with_ids(["npc:3", "npc:3", 3], _VALID)
    assert ids == ["npc:3"]
    assert rejected == []


def test_empty_list_returns_empty_normalized_and_empty_rejected():
    ids, rejected = al._normalize_with_ids([], _VALID)
    assert ids == []
    assert rejected == []


def test_invalid_type_in_list_is_rejected():
    ids, rejected = al._normalize_with_ids(["npc:3", {"id": "npc:5"}, True], _VALID)
    assert ids == ["npc:3"]
    assert rejected == [{"id": "npc:5"}, True]


def test_non_list_withids_is_rejected_wholesale():
    ids, rejected = al._normalize_with_ids("npc:3", _VALID)
    assert ids == []
    assert rejected == ["npc:3"]
    ids2, rejected2 = al._normalize_with_ids(None, _VALID)
    assert ids2 == []
    assert rejected2 == []


# ─────────────────────────────────────────────────────────────────────────────
# `_auto_record_scene` integration — the belt with a stubbed extraction LLM + engine calls.
# ─────────────────────────────────────────────────────────────────────────────

def _drive(monkeypatch, extraction_json, last_user="Let's talk strategy with npc:3",
           narration="They schemed in the backyard for a while.", whereabouts=None,
           whereabouts_raises=False):
    """Run _auto_record_scene with a stubbed extraction LLM, a capturing record_interaction, and a
    stubbed whereabouts read (mirrors the `test_0066_felt_minutes_extraction.py` pattern)."""
    captured = {"llm_called": False, "record_called": False}

    async def fake_llm(*a, **k):
        captured["llm_called"] = True
        return extraction_json

    async def fake_record(content, with_ids=None, kind=None, consequence=None,
                          expected_beat_seq=None, idempotency_key=None, felt_minutes=None, user=None):
        captured["record_called"] = True
        captured["with_ids"] = with_ids
        captured["content"] = content
        return {"recorded": True, "beatSeq": 1}

    async def fake_whereabouts(user=None):
        if whereabouts_raises:
            raise RuntimeError("engine unreachable")
        return whereabouts

    from src import llm_core, orwell_engine as oe
    from routes import chat_helpers
    chat_helpers._LAST_BEAT_SEQ["owner"] = 1
    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    monkeypatch.setattr(oe, "whereabouts", fake_whereabouts)

    ok = _run(al._auto_record_scene(
        narration=narration, last_user=last_user,
        house=_HOUSE, endpoint_url="http://x", model="m", headers={}, owner="owner"))
    return ok, captured


# ---- #1729 (B1): the recorder gate rejects OOC/machinery before ever calling the extraction LLM.

def test_ooc_last_user_is_rejected_without_calling_extraction_llm(monkeypatch):
    ok, cap = _drive(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"x"}',
                     last_user="((that was fucking weird, so combative))")
    assert ok is False
    assert cap["llm_called"] is False, "a rejected OOC turn must never even reach the extraction call"
    assert cap["record_called"] is False


def test_stream_drop_fragment_last_user_is_rejected(monkeypatch):
    ok, cap = _drive(
        monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"x"}',
        last_user="The stream dropped before you finished. It ended with:\n\nision. She's got that…")
    assert ok is False
    assert cap["llm_called"] is False
    assert cap["record_called"] is False


def test_ooc_wrapped_narration_is_also_rejected(monkeypatch):
    # The narrator marks its OWN HUD/producer asides with the identical ((wrap)) convention —
    # a turn that is entirely a producer aside must not fold as a scene either.
    ok, cap = _drive(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"x"}',
                     narration="((the site lagged for a second — go ahead))")
    assert ok is False
    assert cap["record_called"] is False


def test_ordinary_scene_still_records(monkeypatch):
    ok, cap = _drive(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"a real scene"}')
    assert ok is True
    assert cap["record_called"] is True
    assert cap["with_ids"] == ["npc:3"]


# ---- #1729 (B1) / #1599: the reject path is NEVER silent — a RED-eligible health event lands
#      on the overseer ring (the no-silent-fail-soft ruling: even an auto-corrected fault is RED).

def test_ooc_turn_is_skipped_quietly_with_no_health_event(monkeypatch):
    """ORW-207: an OOC player message / an aside-only ((reply)) is the intended OOC format, not a fault. The recorder skips it before the gate and raises no
    soft-fail (it used to raise `recorder:nondiegetic-content-rejected` on every OOC answer). The gate stays the backstop for machinery text (next test)."""
    from src import log_rings as lr
    for kw in ({"last_user": "((that was fucking weird, so combative))"},
               {"narration": "((There are 4 houseguests left: ...))"},
               {"last_user": "ooc: whos left?"}):
        lr.OVERSEER.buf.clear()
        ok, cap = _drive(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"x"}', **kw)
        assert ok is False and cap["llm_called"] is False and cap["record_called"] is False
        kinds = [e.get("kind") for e in lr.OVERSEER.buf]
        assert "recorder:nondiegetic-content-rejected" not in kinds, kw
        assert not [e for e in lr.OVERSEER.buf if e.get("ok") is False], kw


def test_stream_drop_rejection_records_a_red_eligible_overseer_event(monkeypatch):
    from src import log_rings as lr
    lr.OVERSEER.buf.clear()
    ok, cap = _drive(
        monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"x"}',
        last_user="The stream dropped before you finished. It ended with:\n\nision. She's got that…")
    assert ok is False
    events = list(lr.OVERSEER.buf)
    assert events
    ev = events[-1]
    assert ev["overseerLevel"] == "anomaly"
    assert ev["ok"] is False
    assert ev["lever"] == "nondiegetic-gate"


def test_ordinary_scene_does_not_fire_the_nondiegetic_red_event(monkeypatch):
    from src import log_rings as lr
    lr.OVERSEER.buf.clear()
    ok, cap = _drive(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"a real scene"}')
    assert ok is True
    kinds = [e.get("kind") for e in lr.OVERSEER.buf]
    assert "recorder:nondiegetic-content-rejected" not in kinds


# ---- #1730 (B3): the fold witness set is the engine-presence intersection, not the model's guess.

def test_witness_set_drops_offscene_npc_the_model_guessed(monkeypatch):
    # The model proposes BOTH houseguests, but the engine says only npc:3 is actually present —
    # npc:5 must be dropped (no phantom knowledge for a scene they weren't in).
    ok, cap = _drive(
        monkeypatch, '{"withIds":["npc:3","npc:5"],"kind":"bonding","content":"x"}',
        whereabouts={"room": "kitchen", "present": [{"id": "npc:3", "name": "A Houseguest"}]})
    assert ok is True
    assert cap["with_ids"] == ["npc:3"], "an off-scene id the model guessed must be dropped from the fold"


def test_witness_set_all_offscene_yields_no_fold(monkeypatch):
    ok, cap = _drive(
        monkeypatch, '{"withIds":["npc:5"],"kind":"bonding","content":"x"}',
        whereabouts={"room": "kitchen", "present": [{"id": "npc:3", "name": "A Houseguest"}]})
    assert ok is False
    assert cap["record_called"] is False


def test_whereabouts_read_failure_fails_open(monkeypatch):
    # A presence-read hiccup must not zero out the whole 0055 safety net — fall back to the
    # roster-validated proposal unchanged.
    ok, cap = _drive(
        monkeypatch, '{"withIds":["npc:3"],"kind":"bonding","content":"x"}',
        whereabouts_raises=True)
    assert ok is True
    assert cap["with_ids"] == ["npc:3"]


def test_no_whereabouts_present_key_fails_open(monkeypatch):
    # A pre-live-season / non-presence context: whereabouts() returns None entirely (no read at
    # all) — genuinely nothing to filter against, so fail OPEN.
    ok, cap = _drive(
        monkeypatch, '{"withIds":["npc:3"],"kind":"bonding","content":"x"}',
        whereabouts=None)
    assert ok is True
    assert cap["with_ids"] == ["npc:3"]


def test_valid_empty_presence_read_still_applies_the_filter(monkeypatch):
    # CodeRabbit/Greptile review fix — a VALID whereabouts read reporting an EMPTY room
    # ("present": []) is NOT the same as a failed/absent read: the engine is affirmatively
    # telling us nobody else is there. `if present_ids:` (an empty set is falsy) used to treat
    # this identically to a None/failed read and skip the intersection entirely, letting the
    # model's unverified withIds fold as-is — the exact phantom-witness case #1730 closes. A
    # real empty presence read must still zero out an unverified proposal.
    ok, cap = _drive(
        monkeypatch, '{"withIds":["npc:3"],"kind":"bonding","content":"x"}',
        whereabouts={"room": "kitchen", "present": []})
    assert ok is False, "an empty (but VALID) presence read must reject an unverified withIds proposal"
    assert cap["record_called"] is False


# ---- #1734 (B4): a malformed withIds shape from the extraction is normalized/rejected before it
#      ever reaches record_interaction (composes with B3's presence filter above it).

def test_bare_numeric_withids_reach_record_interaction_normalized(monkeypatch):
    ok, cap = _drive(monkeypatch, '{"withIds":[3,5],"kind":"bonding","content":"x"}',
                     whereabouts={"room": "kitchen", "present": [
                         {"id": "npc:3", "name": "A"}, {"id": "npc:5", "name": "B"}]})
    assert ok is True
    assert cap["with_ids"] == ["npc:3", "npc:5"]


def test_malformed_withids_entries_are_dropped_not_coerced(monkeypatch):
    ok, cap = _drive(monkeypatch, '{"withIds":["npc:3","npc:99","garbage"],"kind":"bonding","content":"x"}')
    assert ok is True
    assert cap["with_ids"] == ["npc:3"], "an unresolvable id must be dropped, never guessed at"


def test_wholly_malformed_withids_yields_no_fold(monkeypatch):
    ok, cap = _drive(monkeypatch, '{"withIds":["nowhere","nobody"],"kind":"bonding","content":"x"}')
    assert ok is False
    assert cap["record_called"] is False


# ─────────────────────────────────────────────────────────────────────────────
# #1728 (D1) — id-keyed supersede: the render-log truncate resolution.
# ─────────────────────────────────────────────────────────────────────────────

from core.session_manager import SessionManager
from core.models import ChatMessage
from core import database as db


def _seq_ordered_ids(session_id):
    s = db.SessionLocal()
    try:
        rows = (
            s.query(db.ChatMessage)
            .filter(db.ChatMessage.session_id == session_id)
            .order_by(db.ChatMessage.seq)
            .all()
        )
        return [r.id for r in rows]
    finally:
        s.close()


def test_keep_count_before_message_resolves_from_db_seq_truth():
    sm = SessionManager()
    sid = "d1-keep-count"
    sm.create_session(sid, "n", "http://x", "m", owner="u")
    for i in range(4):
        sm.add_message(sid, ChatMessage("user" if i % 2 == 0 else "assistant", f"m{i}", metadata={}))
    ids = _seq_ordered_ids(sid)
    assert len(ids) == 4

    # Resolve the keep_count that supersedes the LAST message (row index 3) — everything before it.
    kc = sm.keep_count_before_message(sid, ids[3])
    assert kc == 3

    # Resolve the keep_count for the SECOND message (row index 1).
    kc2 = sm.keep_count_before_message(sid, ids[1])
    assert kc2 == 1


def test_keep_count_before_message_unknown_id_returns_none():
    sm = SessionManager()
    sid = "d1-unknown-id"
    sm.create_session(sid, "n", "http://x", "m", owner="u")
    sm.add_message(sid, ChatMessage("user", "m0", metadata={}))
    assert sm.keep_count_before_message(sid, "not-a-real-id") is None


def test_regenerate_supersedes_by_id_leaves_exactly_one_row():
    """The T3 repro, end to end at the SessionManager layer: a regenerate that resolves
    `truncate_from_id` from DB seq truth and then truncates leaves exactly ONE assistant row for
    the turn (the freshly re-generated one), never two near-identical rows."""
    sm = SessionManager()
    sid = "d1-regen-supersede"
    sm.create_session(sid, "n", "http://x", "m", owner="u")
    sm.add_message(sid, ChatMessage("user", "hi", metadata={}))
    sm.add_message(sid, ChatMessage("assistant", "first take (to be discarded)", metadata={}))
    ids = _seq_ordered_ids(sid)
    assert len(ids) == 2
    ai_row_id = ids[1]

    # The regenerate resolves keep_count from the AI row's id (server seq truth), truncates it
    # away, then the "new" turn appends its own fresh assistant row.
    kc = sm.keep_count_before_message(sid, ai_row_id)
    assert kc == 1
    assert sm.truncate_messages(sid, kc) is True
    assert _seq_ordered_ids(sid) == [ids[0]]  # only the user turn survives the truncate

    sm.add_message(sid, ChatMessage("assistant", "second take (kept)", metadata={}))
    final_ids = _seq_ordered_ids(sid)
    assert len(final_ids) == 2, "exactly one assistant row must survive a regenerate — never two"


# ─────────────────────────────────────────────────────────────────────────────
# #1728 (D1/T2) — cancel = discard: source pin (no inject_messages call on an empty cancel).
# ─────────────────────────────────────────────────────────────────────────────

def _read_chat_js():
    import os
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "static", "js", "chat.js")
    with open(path, encoding="utf-8") as f:
        return f.read()


def test_cancelled_bubble_never_persists_an_empty_row():
    js = _read_chat_js()
    fn = js[js.index("function _renderCancelledBubble(holder)"):]
    fn = fn[:fn.index("\n  }\n") + 4]
    assert "inject_messages" not in fn, (
        "a cancelled/empty generation must be DISCARDED, never persisted as an empty "
        "stopped+cancelled assistant row (#1728 T2)"
    )


def test_cancelled_bubble_still_renders_local_indicator():
    js = _read_chat_js()
    fn = js[js.index("function _renderCancelledBubble(holder)"):]
    fn = fn[:fn.index("\n  }\n") + 4]
    assert "[Cancelled by user]" in fn, "the local transient UI feedback must remain"


# ─────────────────────────────────────────────────────────────────────────────
# #1728 (D1/T3) + G4 (2026-07-22 whole-repo gap audit) — EVERY entry point that supersedes a
# persisted row (regenerateFrom / editUserMessage / resendUserMessage) must check the truncate
# response BEFORE mutating the DOM / resubmitting: CodeRabbit/Greptile review fix. fetch() never
# rejects on an HTTP error status, so an unchecked truncate 404 (a stale/missing truncate_from_id)
# used to fall through — the client stripped the DOM rows and fired the regenerate/edit/resend
# ANYWAY, leaving the un-truncated stale DB row behind and reintroducing the "two near-identical
# rows" bug (T3).
#
# G4 found the #1728/#1751 fix had landed on regenerateFrom ONLY — editUserMessage and
# resendUserMessage still carried the unchecked pre-fix shape (a raw DOM-index `keep_count`, an
# un-awaited-for-status `fetch`), exposing them to the identical persisted-row-duplication bug.
# All three now share ONE helper, `_truncateFromMessage` — these tests pin the shared helper's own
# ok-check/throw AND that all three callers actually route through it (never a re-implemented,
# possibly-drifted, inline check).
# ─────────────────────────────────────────────────────────────────────────────

def _read_chat_message_actions_js():
    import os
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "static", "js", "chatMessageActions.js")
    with open(path, encoding="utf-8") as f:
        return f.read()


def _function_body(js, signature):
    """Extract a top-level function's source text starting at `signature`, up to (and including)
    the first line that is a bare closing brace — i.e. the function's own top-level `}`, since
    every NESTED block in this file closes on an indented line (`  });`, `    }`, …), never a
    column-0 `}` alone on its line."""
    fn = js[js.index(signature):]
    return fn[:fn.index("\n}\n") + 3]


def _truncate_from_message_body():
    return _function_body(
        _read_chat_message_actions_js(),
        "async function _truncateFromMessage(apiBase, sessionId, keepCount, anchorElement)",
    )


def _regenerate_from_body():
    return _function_body(_read_chat_message_actions_js(),
                          "export async function regenerateFrom(aiMsgElement)")


def _edit_user_message_body():
    return _function_body(_read_chat_message_actions_js(),
                          "export async function editUserMessage(userMsgElement)")


def _resend_user_message_body():
    return _function_body(_read_chat_message_actions_js(),
                          "export async function resendUserMessage(userMsgElement)")


def test_shared_truncate_helper_checks_response_status_and_throws():
    fn = _truncate_from_message_body()
    assert "res.ok" in fn, (
        "_truncateFromMessage must inspect the truncate response's HTTP status — fetch() does not "
        "reject on a non-2xx response, so an unchecked 404 silently falls through"
    )
    assert "throw new Error" in fn, "a failing truncate must throw so every caller's existing catch handles it"


def test_all_three_supersede_entry_points_use_the_shared_id_keyed_helper():
    """G4: the #1728/#1751 fix must not be able to drift out of lockstep again — pin that
    regenerateFrom, editUserMessage, AND resendUserMessage all route their truncate through the
    one shared, already-tested helper, rather than a bespoke (and possibly half-fixed) fetch."""
    for name, fn in (
        ("regenerateFrom", _regenerate_from_body()),
        ("editUserMessage", _edit_user_message_body()),
        ("resendUserMessage", _resend_user_message_body()),
    ):
        assert "_truncateFromMessage(" in fn, (
            f"{name} must truncate via the shared _truncateFromMessage helper, not a bespoke fetch "
            "(G4: this is exactly how editUserMessage/resendUserMessage drifted out of lockstep "
            "with regenerateFrom's #1728/#1751 fix)"
        )
        # None of the three may hand-roll their own ad-hoc HTTP-status check — that would be the
        # exact triplication (and drift risk) this fix closes.
        assert "res.ok" not in fn and "_truncRes.ok" not in fn, (
            f"{name} must not re-implement the ok-check inline — use the shared helper"
        )


def test_all_three_throw_before_mutating_dom_or_resubmitting():
    """The shared helper throws BEFORE returning on a failed truncate (proven above); this pins
    that each caller's DOM-mutating / resubmit statements come strictly AFTER the awaited
    `_truncateFromMessage(...)` call, so a failed/stale truncate never strips the DOM or fires the
    edit/resend/regenerate."""
    cases = (
        ("regenerateFrom", _regenerate_from_body(),
         ("allMsgs[i].remove()", "aiMsgElement.remove()", "_handleChatSubmit(null, userText)")),
        ("editUserMessage", _edit_user_message_body(),
         ("allMsgs[i].remove()", "_handleChatSubmit(null, newText)")),
        ("resendUserMessage", _resend_user_message_body(),
         ("sibling.remove()", "_handleChatSubmit(null, text)")),
    )
    for name, fn, markers in cases:
        call_at = fn.index("_truncateFromMessage(")
        for marker in markers:
            marker_at = fn.index(marker)
            assert call_at < marker_at, (
                f"{name}: the truncate call must run BEFORE `{marker}` — otherwise a stale/missing "
                f"truncate_from_id (404) leaves the DOM stripped and a duplicate row behind"
            )


# ─────────────────────────────────────────────────────────────────────────────
# #1728 (B2) — defer-fold-to-settle: the consequence half. A cancelled/superseded take's fold must
# never reach the engine, and the surviving take's fold must land exactly once (idempotent under
# retry). See `src/fold_ledger.py` for the full design (incl. the T9-doctrine retract fallback,
# documented but NOT built) and `src/agent_loop.py::_settle_pending_fold`.
#
# Two tiers of tests below:
#   (a) LEDGER-MECHANICS tests via `_drive_staged` — no real DB rows, entries stay UNANCHORED
#       (`row_anchor=None`). This exercises stage/settle/idempotency/re-queue/bound behavior, and
#       (via the fail-safe) the "an unanchored entry is always discarded on truncate" path.
#   (b) ANCHOR-PRECISE tests via a real `SessionManager` + persisted rows, mirroring production's
#       stage → (persist →) `attach_row_anchor` → (truncate →) `discard_pending_fold` sequence —
#       these are what actually prove the PR #1825 second-Greptile-P1 fix (an older-row truncate
#       must discard every LATER anchored fold too, not just the newest).
# ─────────────────────────────────────────────────────────────────────────────

from src import fold_ledger as fl


def setup_function(_fn=None):
    fl.clear_all()


def _drive_staged(monkeypatch, extraction_json, owner="owner", session_id="sess-1",
                   last_user="Let's talk strategy with npc:3",
                   narration="They schemed in the backyard for a while.", whereabouts=None):
    """Like `_drive` above, but with `session_id` supplied — the fold STAGES instead of
    committing (the live per-turn belt call sites always pass `session_id`; only the decoupled
    0081 faithfulness retro-adopt path calls with `session_id=None`, exercised separately).

    Deliberately does NOT attach a row anchor — see the section docstring's tier (a). Tests that
    need anchor-precise discard semantics use the DB-backed helpers below instead."""
    captured = {"llm_called": False, "record_called": False}

    async def fake_llm(*a, **k):
        captured["llm_called"] = True
        return extraction_json

    async def fake_record(content, with_ids=None, kind=None, consequence=None,
                          expected_beat_seq=None, idempotency_key=None, felt_minutes=None, user=None):
        captured["record_called"] = True
        captured["with_ids"] = with_ids
        captured["content"] = content
        captured["idempotency_key"] = idempotency_key
        return {"recorded": True, "beatSeq": 2}

    async def fake_whereabouts(user=None):
        return whereabouts

    from src import llm_core, orwell_engine as oe
    from routes import chat_helpers
    chat_helpers._LAST_BEAT_SEQ[owner] = 1
    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    monkeypatch.setattr(oe, "whereabouts", fake_whereabouts)

    ok = _run(al._auto_record_scene(
        narration=narration, last_user=last_user,
        house=_HOUSE, endpoint_url="http://x", model="m", headers={}, owner=owner,
        session_id=session_id))
    return ok, captured


def test_staged_fold_does_not_commit_immediately(monkeypatch):
    ok, cap = _drive_staged(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"a real scene"}')
    assert ok is True, "staging a validated payload is still the belt FIRING (telemetry contract)"
    assert cap["record_called"] is False, "session_id given ⇒ STAGE, never commit mid-turn (#1728 B2)"
    assert fl.has_pending_fold("owner", "sess-1") is True


def test_settle_commits_the_staged_fold_exactly_once(monkeypatch):
    ok, cap = _drive_staged(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"a real scene"}')
    assert ok is True
    settled = _run(al._settle_pending_fold("owner", "sess-1"))
    assert settled is True
    assert cap["record_called"] is True
    assert cap["with_ids"] == ["npc:3"]
    assert cap["content"] == "a real scene"
    assert fl.has_pending_fold("owner", "sess-1") is False, "settle drains the staged entry"

    # A second settle (nothing left to settle) must be a clean no-op — never a second engine call.
    cap["record_called"] = False
    settled_again = _run(al._settle_pending_fold("owner", "sess-1"))
    assert settled_again is False
    assert cap["record_called"] is False


def test_settle_with_nothing_staged_is_a_no_op():
    settled = _run(al._settle_pending_fold("owner", "no-such-session"))
    assert settled is False


def test_regenerate_discards_an_unanchored_staged_fold_via_the_failsafe(monkeypatch):
    """Tier (a): a fold staged but never anchored (the attach step hadn't run — an unavoidable,
    narrow race window at STAGE time) is discarded on ANY truncate, regardless of `keep_count` —
    the fail-safe (`fold_ledger`'s "deliberately asymmetric" rule). This is a REAL, legitimate
    path (not just a test artifact): see `test_missing_anchor_entry_is_discarded_...` below for
    the DB-backed variant that also proves the warning log fires."""
    ok_a, cap_a = _drive_staged(
        monkeypatch, '{"withIds":["npc:3"],"kind":"bonding","content":"take A content (discarded)"}')
    assert ok_a is True
    assert fl.has_pending_fold("owner", "sess-1") is True

    # "Try again" truncates the row that produced take A's fold — the entry is unanchored, so the
    # fail-safe discards it regardless of the keep_count value.
    discarded = fl.discard_pending_fold("owner", "sess-1", keep_count=0)
    assert discarded == 1
    assert fl.has_pending_fold("owner", "sess-1") is False

    ok_b, cap_b = _drive_staged(
        monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"take B content (kept)"}')
    assert ok_b is True

    settled = _run(al._settle_pending_fold("owner", "sess-1"))
    assert settled is True
    assert cap_b["record_called"] is True, "exactly ONE consequence fold must land for this beat"
    assert cap_b["content"] == "take B content (kept)", (
        "the surviving fold must reflect the SURVIVING take's content — never the superseded "
        "take's (F6 distortion is structurally impossible: the superseded take never folds)")


def test_settle_reuses_the_stage_time_idempotency_key(monkeypatch):
    """AC — re-applying the surviving fold is idempotent: settle carries the SAME key minted at
    stage time (0065 Part B), so a retried settle/engine call can never double-apply."""
    ok, _cap = _drive_staged(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"x"}')
    entry_key = fl._PENDING[("owner", "sess-1")][0]["idempotency_key"]
    _ok2, cap = ok, {}

    async def fake_record(content, with_ids=None, kind=None, consequence=None,
                          expected_beat_seq=None, idempotency_key=None, felt_minutes=None, user=None):
        cap["idempotency_key"] = idempotency_key
        return {"recorded": True, "beatSeq": 3}

    from src import orwell_engine as oe
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    _run(al._settle_pending_fold("owner", "sess-1"))
    assert cap["idempotency_key"] == entry_key


def test_settle_failure_re_queues_the_entry_instead_of_losing_it(monkeypatch):
    """mandate #4 (non-degradation) — a validated fold must never silently evaporate on a
    transient hiccup; it re-queues (at the front) for the next settle opportunity instead."""
    ok, _cap = _drive_staged(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"x"}')
    assert ok is True

    async def boom(*a, **k):
        raise RuntimeError("network blip")

    from src import orwell_engine as oe
    monkeypatch.setattr(oe, "record_interaction", boom)
    settled = _run(al._settle_pending_fold("owner", "sess-1"))
    assert settled is False
    assert fl.has_pending_fold("owner", "sess-1") is True, "a failed settle must re-queue, never drop"
    assert fl.pending_fold_count("owner", "sess-1") == 1


# ── PR #1825 (Greptile P1 #1) — the queue redesign: a single overwriting slot let a transient
# settle-failure re-stage the PRIOR turn's still-unsettled fold, and a NEW turn reaching
# `_auto_record_scene` right after would silently CLOBBER it (mandate #4 evaporation). Fixed by
# making the pending store a bounded FIFO queue: stage appends, settle drains oldest-first and
# stops (never skips) on a failure. ─────────────────────────────────────────────────────────────

def test_settle_failure_then_a_new_turn_stage_settles_both_in_order(monkeypatch):
    """The exact T-Rex repro: turn 1's settle hits a transient error (re-queued), turn 2 also
    stages its own fold — with the old single-slot design this OVERWRITES and silently drops
    turn 1's fold. With the queue, BOTH survive and settle in order on the next successful
    settle, each carrying its OWN idempotency key."""
    ok1, cap1 = _drive_staged(
        monkeypatch, '{"withIds":["npc:3"],"kind":"bonding","content":"turn 1 content"}')
    assert ok1 is True
    key1 = fl._PENDING[("owner", "sess-1")][0]["idempotency_key"]

    async def boom(*a, **k):
        raise RuntimeError("network blip")

    from src import orwell_engine as oe
    monkeypatch.setattr(oe, "record_interaction", boom)
    settled = _run(al._settle_pending_fold("owner", "sess-1"))
    assert settled is False
    assert fl.pending_fold_count("owner", "sess-1") == 1, "turn 1's fold must survive the failure"

    # Turn 2 begins (the settle above already ran fail-open at turn 2's own start) and reaches
    # _auto_record_scene for ITS OWN scene — this must APPEND, never clobber turn 1's re-queued entry.
    ok2, cap2 = _drive_staged(
        monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"turn 2 content"}')
    assert ok2 is True
    assert fl.pending_fold_count("owner", "sess-1") == 2, (
        "staging turn 2's fold must not clobber turn 1's still-unsettled, re-queued fold")
    key2 = fl._PENDING[("owner", "sess-1")][1]["idempotency_key"]
    assert key1 != key2

    # A later, successful settle (turn 3's start) must drain BOTH, oldest first, each with its
    # own preserved idempotency key.
    applied = []

    async def fake_record(content, with_ids=None, kind=None, consequence=None,
                          expected_beat_seq=None, idempotency_key=None, felt_minutes=None, user=None):
        applied.append((content, idempotency_key))
        return {"recorded": True, "beatSeq": 4 + len(applied)}

    monkeypatch.setattr(oe, "record_interaction", fake_record)
    settled_again = _run(al._settle_pending_fold("owner", "sess-1"))
    assert settled_again is True
    assert applied == [("turn 1 content", key1), ("turn 2 content", key2)], (
        "both folds must land, oldest-first, each with its ORIGINAL idempotency key — "
        "neither evaporated nor reordered"
    )
    assert fl.has_pending_fold("owner", "sess-1") is False


def test_pending_queue_bound_drops_the_oldest_entry_with_a_warning(caplog):
    """A pathological repeated-settle-failure loop must not grow the queue without limit — past
    `_MAX_QUEUE_LEN` the OLDEST entry is dropped (a real, bounded loss) with a warning log."""
    import logging
    caplog.set_level(logging.WARNING, logger="src.fold_ledger")
    for i in range(fl._MAX_QUEUE_LEN + 3):
        fl.stage_pending_fold("owner", "sess-1", content=f"entry-{i}", with_ids=["npc:3"],
                              kind="bonding", consequence=None, felt_minutes=None,
                              idempotency_key=f"k{i}")
    assert fl.pending_fold_count("owner", "sess-1") == fl._MAX_QUEUE_LEN
    # The oldest 3 entries (0, 1, 2) must have been dropped — the queue keeps the NEWEST N.
    contents = [e["content"] for e in fl._PENDING[("owner", "sess-1")]]
    assert contents[0] == "entry-3", "the bound must drop the OLDEST entries, keeping the newest"
    assert contents[-1] == f"entry-{fl._MAX_QUEUE_LEN + 2}"
    assert any("dropping the OLDEST staged fold" in r.message for r in caplog.records), (
        "an overflow drop must be logged — it is a real (if bounded) fold loss"
    )


def test_faithfulness_retro_adopt_path_without_session_id_still_commits_immediately(monkeypatch):
    """`session_id=None` (the 0081 faithfulness retro-adopt call site — a background correction
    decoupled from any one streamed turn) keeps the pre-#1728 immediate-commit behavior: there is
    no "next turn" to defer against for it."""
    ok, cap = _drive(monkeypatch, '{"withIds":["npc:3"],"kind":"strategy","content":"x"}')
    assert ok is True
    assert cap["record_called"] is True
    assert fl.has_pending_fold("owner", "sess-1") is False


def test_two_sessions_stage_independently():
    fl.stage_pending_fold("owner", "sess-1", content="a", with_ids=["npc:3"], kind="bonding",
                          consequence=None, felt_minutes=None, idempotency_key="k1")
    fl.stage_pending_fold("owner", "sess-2", content="b", with_ids=["npc:5"], kind="strategy",
                          consequence=None, felt_minutes=None, idempotency_key="k2")
    assert fl.has_pending_fold("owner", "sess-1") is True
    assert fl.has_pending_fold("owner", "sess-2") is True
    assert fl.discard_pending_fold("owner", "sess-1", keep_count=0) == 1
    assert fl.has_pending_fold("owner", "sess-1") is False
    assert fl.has_pending_fold("owner", "sess-2") is True, "discarding one session must not touch another"


def test_discard_returns_zero_when_nothing_was_staged():
    assert fl.discard_pending_fold("owner", "sess-empty", keep_count=0) == 0


# ── PR #1825 (Greptile P1 #2, the mirror-image bug) — a truncate targeting an OLDER assistant
# row removes that row AND every later row (a truncate is never a single-row operation), but a
# tail-only discard left a LATER take's queued fold sitting in the ledger — it would settle later
# as a PHANTOM hidden-layer fold for content the render log no longer contains, reintroducing the
# exact F5 corruption this feature exists to prevent (T-Rex-confirmed). Fixed by anchoring every
# staged entry to the real, persisted row it belongs to (`attach_row_anchor`, called from
# `routes/chat_routes.py` right after the route persists that turn's reply) and discarding by
# ANCHOR, not queue position: `discard_pending_fold` now removes every entry whose anchor sits at
# or past the truncate's `keep_count` cutoff. ───────────────────────────────────────────────────

def _stage_and_persist_turn(monkeypatch, sm, sid, owner, extraction_json, user_text, assistant_text):
    """Mirrors the real production sequence for ONE turn: `_auto_record_scene` stages (mid-
    generation, before the row exists) → the route persists the user+assistant row pair → the
    route attaches the real row's anchor to whatever was just staged (`attach_row_anchor`).
    Returns the persisted assistant row's id."""
    ok, cap = _drive_staged(monkeypatch, extraction_json, owner=owner, session_id=sid,
                            last_user=user_text, narration=assistant_text)
    assert ok is True
    sm.add_message(sid, ChatMessage("user", user_text, metadata={}))
    sm.add_message(sid, ChatMessage("assistant", assistant_text, metadata={}))
    ai_row_id = _seq_ordered_ids(sid)[-1]
    attached = fl.attach_row_anchor(owner, sid, ai_row_id)
    assert attached is True, "attach_row_anchor must anchor the tail entry this turn just staged"
    return ai_row_id


def test_truncate_from_an_older_row_discards_every_later_anchored_fold(monkeypatch):
    """The T-Rex repro, exactly as reported: two queued folds (an older, re-queued-after-failure
    fold + a newer one), truncate from the OLDER row → BOTH discarded, nothing settles."""
    sm = SessionManager()
    sid = "b2-trex-repro"
    sm.create_session(sid, "n", "http://x", "m", owner="owner")

    older_row_id = _stage_and_persist_turn(
        monkeypatch, sm, sid, "owner",
        '{"withIds":["npc:3"],"kind":"bonding","content":"older turn (re-queued)"}',
        "u1", "older turn narration")
    newer_row_id = _stage_and_persist_turn(
        monkeypatch, sm, sid, "owner", '{"withIds":["npc:3"],"kind":"strategy","content":"newer turn"}',
        "u2", "newer turn narration")
    assert fl.pending_fold_count("owner", sid) == 2

    # "Try again"/edit on the OLDER turn — this truncate wipes the older row AND the newer one.
    keep_count = sm.keep_count_before_message(sid, older_row_id)
    discarded = fl.discard_pending_fold("owner", sid, keep_count)
    assert discarded == 2, "a truncate from an OLDER row must discard EVERY later anchored fold too"
    assert fl.has_pending_fold("owner", sid) is False


def test_truncate_from_the_newest_row_only_leaves_the_older_fold_to_settle(monkeypatch):
    """The mirror-image check: truncating from the NEWEST row only must discard ONLY that fold —
    the older, already-anchored fold survives and still settles normally."""
    sm = SessionManager()
    sid = "b2-newest-only"
    sm.create_session(sid, "n", "http://x", "m", owner="owner")

    older_row_id = _stage_and_persist_turn(
        monkeypatch, sm, sid, "owner",
        '{"withIds":["npc:3"],"kind":"bonding","content":"older content (kept)"}',
        "u1", "older turn narration")
    newer_row_id = _stage_and_persist_turn(
        monkeypatch, sm, sid, "owner",
        '{"withIds":["npc:3"],"kind":"strategy","content":"newer content (regenerated away)"}',
        "u2", "newer turn narration")
    assert fl.pending_fold_count("owner", sid) == 2

    keep_count = sm.keep_count_before_message(sid, newer_row_id)
    discarded = fl.discard_pending_fold("owner", sid, keep_count)
    assert discarded == 1
    assert fl.pending_fold_count("owner", sid) == 1
    assert fl._PENDING[("owner", sid)][0]["content"] == "older content (kept)"

    applied = []

    async def fake_record(content, with_ids=None, kind=None, consequence=None,
                          expected_beat_seq=None, idempotency_key=None, felt_minutes=None, user=None):
        applied.append(content)
        return {"recorded": True, "beatSeq": 9}

    from src import orwell_engine as oe
    from routes import chat_helpers
    chat_helpers._LAST_BEAT_SEQ["owner"] = 1
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    settled = _run(al._settle_pending_fold("owner", sid))
    assert settled is True
    assert applied == ["older content (kept)"], (
        "the older, already-accepted fold must survive a truncate targeting a NEWER take, and "
        "actually settle"
    )


def test_missing_anchor_entry_is_discarded_on_truncate_with_a_warning(monkeypatch, caplog):
    """A staged fold whose anchor never got attached (the narrow stage-time race, or a caller that
    forgot the attach step) is discarded on ANY truncate, regardless of `keep_count` — the
    fail-safe. This is the DB-backed variant of
    `test_regenerate_discards_an_unanchored_staged_fold_via_the_failsafe`, additionally proving
    the warning log fires."""
    sm = SessionManager()
    sid = "b2-missing-anchor"
    sm.create_session(sid, "n", "http://x", "m", owner="owner")
    sm.add_message(sid, ChatMessage("user", "u1", metadata={}))
    sm.add_message(sid, ChatMessage("assistant", "a1", metadata={}))

    ok, _cap = _drive_staged(
        monkeypatch, '{"withIds":["npc:3"],"kind":"bonding","content":"x"}',
        session_id=sid, last_user="u1", narration="a1")
    assert ok is True
    assert fl._PENDING[("owner", sid)][0]["row_anchor"] is None, (
        "this test deliberately never calls attach_row_anchor"
    )

    import logging
    caplog.set_level(logging.WARNING, logger="src.fold_ledger")
    keep_count = 999  # even a cutoff that wouldn't otherwise discard anything must still discard this
    discarded = fl.discard_pending_fold("owner", sid, keep_count)
    assert discarded == 1
    assert fl.has_pending_fold("owner", sid) is False
    assert any("missing/unresolved row anchor" in r.message for r in caplog.records), (
        "discarding a never-anchored entry must be logged — it is a real (if bounded) fold loss"
    )


def test_settle_drops_an_anchored_entry_whose_row_no_longer_exists(monkeypatch):
    """Settle's own last-line belt (item 4): a non-truncate deletion path (edit-message /
    delete-messages / merge-last-assistant) can remove a row WITHOUT ever calling
    `discard_pending_fold`. Settle must still refuse to fold it — dropped, never applied, never
    re-queued (there's nothing to retry)."""
    sm = SessionManager()
    sid = "b2-vanished-row"
    sm.create_session(sid, "n", "http://x", "m", owner="owner")

    row_id = _stage_and_persist_turn(
        monkeypatch, sm, sid, "owner", '{"withIds":["npc:3"],"kind":"bonding","content":"x"}',
        "u1", "a1")
    assert fl._PENDING[("owner", sid)][0]["row_anchor"] is not None

    # A non-truncate path removes the row WITHOUT going through discard_pending_fold at all.
    kc = sm.keep_count_before_message(sid, row_id)
    assert sm.truncate_messages(sid, kc) is True
    assert fl.has_pending_fold("owner", sid) is True, "the ledger entry itself is untouched by this"

    async def boom(*a, **k):
        raise AssertionError("must never settle a fold whose anchored row no longer exists")

    from src import orwell_engine as oe
    from routes import chat_helpers
    chat_helpers._LAST_BEAT_SEQ["owner"] = 1
    monkeypatch.setattr(oe, "record_interaction", boom)
    settled = _run(al._settle_pending_fold("owner", sid))
    assert settled is False
    assert fl.has_pending_fold("owner", sid) is False, "the vanished-row entry must be DROPPED, not requeued"


# ── PR #1825 (Greptile P1 #3) — POSITIONAL anchors are unstable under deletion. The fix #2 first
# cut anchored to a `seq`-order POSITION captured once; deleting an EARLIER row shifts every LATER
# row's true position left, but the stored position doesn't move — so a stale `position < count`
# check can read "still there" for a row that is actually gone (a 3-row session, an entry anchored
# at position 1, the row at position 0 deleted → count drops to 2, and `1 < 2` stays true even
# though a DIFFERENT row now sits at position 1). `core/database.py`'s `ChatMessage.id` is a
# `String` UUID (`core/session_manager.py`: `str(uuid.uuid4())` everywhere it's minted) — NOT an
# autoincrement integer — so raw id comparison can't encode order either; the fix removes
# positional arithmetic from the anchor ENTIRELY: `row_anchor` is the row's own immutable id,
# checked by a plain SELECT-by-id at settle time (`entry_exists_at_settle`) and resolved fresh via
# a real `seq` query only at truncate time (`discard_pending_fold`, against the CURRENT row set,
# never a cached one). ─────────────────────────────────────────────────────────────────────────

def test_settle_drops_the_entry_when_the_anchored_row_is_deleted_and_later_rows_shift(monkeypatch):
    """The exact Greptile P1 #3 repro: 3 rows, a fold anchored to the MIDDLE row (position 1).
    That row is deleted via a non-truncate path, leaving the row before AND the row after intact
    — the row after it shifts from position 2 down into position 1. A stale POSITION-based
    existence check would be fooled here (anchor=1, count drops 3->2, `1 < 2` still true) into
    settling the fold against whatever row now occupies position 1 — a DIFFERENT row than the one
    this fold was ever about. The id-based check has no such hole: it SELECTs the deleted row's
    OWN id and finds nothing, regardless of what shifted around it."""
    sm = SessionManager()
    sid = "b2-middle-row-shift"
    sm.create_session(sid, "n", "http://x", "m", owner="owner")

    sm.add_message(sid, ChatMessage("user", "row0 (position 0, kept)", metadata={}))
    sm.add_message(sid, ChatMessage("assistant", "row1 (position 1, will be deleted)", metadata={}))
    sm.add_message(sid, ChatMessage("assistant", "row2 (position 2, shifts to position 1)", metadata={}))
    ids = _seq_ordered_ids(sid)
    assert len(ids) == 3
    middle_row_id = ids[1]

    fl.stage_pending_fold("owner", sid, content="a scene tied to row1", with_ids=["npc:3"],
                          kind="bonding", consequence=None, felt_minutes=None,
                          idempotency_key="k-middle")
    attached = fl.attach_row_anchor("owner", sid, middle_row_id)
    assert attached is True
    assert fl._PENDING[("owner", sid)][0]["row_anchor"] == middle_row_id, (
        "the anchor must be the row's own id, not a derived position"
    )

    # A non-truncate path deletes ONLY the middle row — row0 and row2 remain, row2 shifts down.
    db_session = db.SessionLocal()
    try:
        db_session.query(db.ChatMessage).filter(db.ChatMessage.id == middle_row_id).delete()
        db_session.commit()
    finally:
        db_session.close()
    remaining_ids = _seq_ordered_ids(sid)
    assert remaining_ids == [ids[0], ids[2]], "row0 and row2 must survive; row2 shifts to position 1"

    async def boom(*a, **k):
        raise AssertionError(
            "must never settle a fold whose anchored row was deleted, even though a later row "
            "shifted into its old position")

    from src import orwell_engine as oe
    from routes import chat_helpers
    chat_helpers._LAST_BEAT_SEQ["owner"] = 1
    monkeypatch.setattr(oe, "record_interaction", boom)
    settled = _run(al._settle_pending_fold("owner", sid))
    assert settled is False
    assert fl.has_pending_fold("owner", sid) is False, "the deleted-row entry must be DROPPED, not requeued"


def test_settle_still_applies_an_unanchored_entry_normally():
    """The flip side of the truncate fail-safe: settle treats a MISSING anchor as "no evidence
    either way" and proceeds normally — unlike truncate, settle isn't reacting to an active delete
    event. (Covered functionally by `test_settle_commits_the_staged_fold_exactly_once` above,
    which never attaches an anchor either; this test pins the specific
    `entry_exists_at_settle(..., None)` contract directly.)"""
    assert fl.entry_exists_at_settle("any-session", None) is True


# ── PR #1825 (Greptile P1 #4) — the CUSTODY LEAK. `_backfill_with_cas` self-enqueues a fold onto
# `chat_helpers._DEFERRED_FOLDS` on a DOUBLE stale-beat conflict when called with `defer_fold=True`
# — but that queue is keyed only by owner, carrying no session_id/row_anchor, so a later truncate on
# the anchored session can't see the entry sitting there at all. It drains later (opportunistically,
# on the NEXT unrelated back-fill call for this owner) and folds content the render log no longer
# contains — a phantom fold via a side door the anchor-based truncate/settle checks never see.
# RULING: SINGLE CUSTODY — an anchored fold lives in exactly ONE queue (`fold_ledger`'s own) until
# it commits or is discarded; it must NEVER migrate to `_DEFERRED_FOLDS`. Fixed by calling
# `_backfill_with_cas` with `defer_fold=False` from the settle path specifically (every OTHER
# fold-bearing call site — `_auto_record_deal`/`_auto_confide`/`_auto_expose_secret`/
# `_auto_trade_secret`, and the `session_id=None` faithfulness path — keeps `defer_fold=True`
# unchanged, since THEY have no anchored ledger to fall back on and `_DEFERRED_FOLDS` is their only
# safety net; `test_move_backfill_stale_twice_still_drops_no_defer` in
# `tests/test_0065_backfill_cas.py` already proves `defer_fold=False` cleanly skips the self-enqueue
# for a positional belt — this is the same proven shape, applied to the settle path). ────────────

def _stale_409(now: int):
    from src import orwell_engine as oe
    return oe.EngineToolError(
        f"stale write refused — expected beatSeq is behind the current board (now {now}); re-ground",
        status=409)


def test_settle_double_stale_beat_never_leaks_into_the_deferred_folds_queue(monkeypatch):
    """The T-Rex repro, end to end: stage an anchored fold, force a DOUBLE stale-beat at settle
    (so `_backfill_with_cas` would have self-enqueued under the old `defer_fold=True` call), then
    truncate the row BEFORE any retry drains, then drain BOTH queues — `recordInteraction` must
    never be called for the truncated content, because the entry was discarded by the truncate
    (custody never left the anchored ledger in the first place)."""
    from routes import chat_helpers
    from src import orwell_engine as oe
    chat_helpers._DEFERRED_FOLDS.clear()
    chat_helpers._LAST_BEAT_SEQ["owner"] = 1

    sm = SessionManager()
    sid = "b2-custody-leak"
    sm.create_session(sid, "n", "http://x", "m", owner="owner")

    row_id = _stage_and_persist_turn(
        monkeypatch, sm, sid, "owner",
        '{"withIds":["npc:3"],"kind":"bonding","content":"content that will be truncated away"}',
        "u1", "a1")

    call_count = {"n": 0}

    async def flaky_record(*a, **k):
        call_count["n"] += 1
        raise _stale_409(9 + call_count["n"])  # always stale — the board keeps moving

    async def fake_status(user=None):
        return {"week": 3, "phase": "veto", "pending": None, "veto": {}, "beatSeq": 99}

    async def fake_state(user=None, **kw):
        return {"week": 3, "phase": "veto", "finished": False, "house": [], "beatSeq": 99}

    monkeypatch.setattr(oe, "record_interaction", flaky_record)
    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(oe, "get_game_state", fake_state)

    settled = _run(al._settle_pending_fold("owner", sid))
    assert settled is False
    assert call_count["n"] == 2, "tried once + re-attempted once against the reconciled token, then gave up"

    # SINGLE CUSTODY: the double-stale-beat fold must NEVER have reached the un-anchored deferred
    # queue — that is the exact custody leak this fix closes.
    assert chat_helpers.deferred_fold_count("owner") == 0, (
        "a settle-path fold must never migrate to _DEFERRED_FOLDS — it carries no session_id/"
        "row_anchor there, so a later truncate on this session couldn't see it at all"
    )
    # It must instead be back in the ANCHORED ledger, ready for the next settle to retry.
    assert fl.pending_fold_count("owner", sid) == 1

    # "Try again" (or an edit) truncates the row BEFORE any retry ever drains.
    keep_count = sm.keep_count_before_message(sid, row_id)
    discarded = fl.discard_pending_fold("owner", sid, keep_count)
    assert discarded == 1
    assert fl.has_pending_fold("owner", sid) is False

    # Draining BOTH queues must never fold the truncated content.
    async def boom(*a, **k):
        raise AssertionError(
            "recordInteraction must never be called for content a truncate already discarded")

    monkeypatch.setattr(oe, "record_interaction", boom)
    settled_again = _run(al._settle_pending_fold("owner", sid))
    assert settled_again is False
    _run(chat_helpers._drain_deferred_folds("owner"))  # must be a clean no-op — nothing was ever there


def test_settle_path_never_passes_defer_fold_true():
    """Source pin: EVERY other fold-bearing `_backfill_with_cas` call site in this file passes
    `defer_fold=True` (they have no anchored ledger to fall back on); the settle path is the ONE
    exception, and it must stay that way — a future edit that flips it back to `True` reopens the
    custody leak."""
    src = _read_agent_loop_py()
    fn = src[src.index("async def _settle_pending_fold("):]
    fn = fn[:fn.index("\n# ── Whereabouts cohesion")]
    assert "defer_fold=False" in fn, (
        "the settle path must call _backfill_with_cas with defer_fold=False (PR #1825 fix #4 — "
        "single custody) so a double stale-beat re-queues in the ANCHORED ledger, never the "
        "un-anchored _DEFERRED_FOLDS side door"
    )
    assert "defer_fold=True" not in fn, (
        "defer_fold=True in the settle path would silently reopen the custody-leak bug"
    )


# ── PR #1825 (Greptile P1 #5) — a NEGATIVE `keep_count` (malformed input) let `truncate_messages`
# refuse the delete (returns False, nothing removed) while the OLD code called
# `discard_pending_fold` regardless — every resolved anchor position trivially satisfies
# `pos < negative_number` as false (i.e. reads as "at or past the cutoff"), so the ledger emptied
# while every render row survived: an ACCEPTED turn permanently lost its staged hidden
# consequence on a malformed request (T-Rex-confirmed). Fixed at BOTH layers: (1) the route
# rejects `keep_count < 0` with HTTP 400 before touching anything, and (2) `discard_pending_fold`
# is now called ONLY after `truncate_messages` returns True — the ledger discard is a
# CONSEQUENCE of a truncate that actually happened, never of one merely attempted (covers any
# other False-return path too, not just negative input). ─────────────────────────────────────────

def _truncate_test_client(session_manager, *, token_owner):
    """A TestClient over the real `history_routes` router with middleware-equivalent state
    stamped the way `app.py` stamps a bearer-token caller (mirrors the established
    `_orwell_client` pattern in `tests/test_lane6_turn_integrity.py`)."""
    from fastapi import FastAPI, Request
    from fastapi.testclient import TestClient
    from routes import history_routes

    app = FastAPI()

    @app.middleware("http")
    async def stamp(request: Request, call_next):
        request.state.current_user = token_owner
        request.state.api_token = True
        request.state.api_token_owner = token_owner
        return await call_next(request)

    app.include_router(history_routes.setup_history_routes(session_manager))
    return TestClient(app, raise_server_exceptions=False)


def test_truncate_negative_keep_count_rejected_before_touching_anything(monkeypatch):
    """The repro, end to end over real HTTP: a negative `keep_count` is rejected with 400,
    ZERO rows are deleted, the staged (anchored) fold in the ledger is left completely untouched,
    and it still settles normally afterward — nothing about a malformed request may cost an
    already-accepted turn its hidden consequence."""
    sm = SessionManager()
    sid = "b2-negative-keep-count"
    sm.create_session(sid, "n", "http://x", "m", owner="owner")

    row_id = _stage_and_persist_turn(
        monkeypatch, sm, sid, "owner",
        '{"withIds":["npc:3"],"kind":"bonding","content":"survives the malformed request"}',
        "u1", "a1")
    before_ids = _seq_ordered_ids(sid)
    assert fl.pending_fold_count("owner", sid) == 1

    client = _truncate_test_client(sm, token_owner="owner")
    resp = client.post(f"/api/session/{sid}/truncate", json={"keep_count": -1})
    assert resp.status_code == 400

    assert _seq_ordered_ids(sid) == before_ids, "zero rows may be deleted on a rejected request"
    assert fl.pending_fold_count("owner", sid) == 1, "the ledger entry must be completely untouched"
    assert fl._PENDING[("owner", sid)][0]["row_anchor"] == row_id

    # It must still settle normally afterward — nothing about the malformed request may have
    # corrupted or consumed the entry.
    applied = []

    async def fake_record(content, with_ids=None, kind=None, consequence=None,
                          expected_beat_seq=None, idempotency_key=None, felt_minutes=None, user=None):
        applied.append(content)
        return {"recorded": True, "beatSeq": 9}

    from src import orwell_engine as oe
    from routes import chat_helpers
    chat_helpers._LAST_BEAT_SEQ["owner"] = 1
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    settled = _run(al._settle_pending_fold("owner", sid))
    assert settled is True
    assert applied == ["survives the malformed request"]


def test_truncate_false_return_never_discards_the_ledger(monkeypatch):
    """The ordering guarantee's other half: ANY False return from `truncate_messages` (not just a
    negative `keep_count` — e.g. an internal DB hiccup) must leave the ledger untouched. The
    discard is a consequence of a truncate that happened, never of one merely attempted."""
    sm = SessionManager()
    sid = "b2-false-return-truncate"
    sm.create_session(sid, "n", "http://x", "m", owner="owner")

    row_id = _stage_and_persist_turn(
        monkeypatch, sm, sid, "owner",
        '{"withIds":["npc:3"],"kind":"bonding","content":"survives a failed truncate"}',
        "u1", "a1")
    before_ids = _seq_ordered_ids(sid)

    monkeypatch.setattr(SessionManager, "truncate_messages",
                        lambda self, session_id, keep_count: False)

    client = _truncate_test_client(sm, token_owner="owner")
    resp = client.post(f"/api/session/{sid}/truncate", json={"keep_count": 1})
    assert resp.status_code == 200
    assert resp.json()["truncated"] is False

    assert _seq_ordered_ids(sid) == before_ids
    assert fl.pending_fold_count("owner", sid) == 1, (
        "a False return from truncate_messages must never discard the ledger entry"
    )
    assert fl._PENDING[("owner", sid)][0]["row_anchor"] == row_id


def test_truncate_route_rejects_negative_keep_count_before_calling_truncate_messages():
    """Source pin: the negative-`keep_count` guard must sit textually BEFORE the
    `truncate_messages` call, and the `discard_pending_fold` call must be gated on the result —
    both source-pinned so a future refactor can't silently reorder them back into the bug."""
    src = _read_history_routes_py()
    fn = src[src.index("async def truncate_session("):]
    fn = fn[:fn.index("\n    @router.post(\"/api/session/{session_id}/message\")")]
    guard_at = fn.index("keep_count < 0")
    truncate_call_at = fn.index("session_manager.truncate_messages(session_id, keep_count)")
    assert guard_at < truncate_call_at, (
        "the negative-keep_count guard must run BEFORE truncate_messages is ever called"
    )
    assert "raise HTTPException(400" in fn[guard_at:truncate_call_at], (
        "a negative keep_count must be rejected with HTTP 400, not silently passed through"
    )
    discard_at = fn.index("discard_pending_fold(effective_user(request), session_id, keep_count)")
    if_result_at = fn.rindex("if result:", 0, discard_at)
    assert truncate_call_at < if_result_at < discard_at, (
        "discard_pending_fold must be called ONLY inside `if result:` — the ledger discard is a "
        "CONSEQUENCE of a truncate that actually happened, never of one merely attempted"
    )


# ─────────────────────────────────────────────────────────────────────────────
# #1728 (B2) — the wiring source pins: the truncate route discards by anchor, the agent-mode
# persist path attaches the anchor, and the settle-at-turn-start call sits at the top of the turn
# (before ANY narration is generated) — all source-pinned so a future refactor can't silently
# reorder or drop them.
# ─────────────────────────────────────────────────────────────────────────────

def _read_history_routes_py():
    import os
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "routes", "history_routes.py")
    with open(path, encoding="utf-8") as f:
        return f.read()


def test_truncate_route_discards_staged_folds_by_anchor():
    src = _read_history_routes_py()
    fn = src[src.index("async def truncate_session("):]
    fn = fn[:fn.index("\n    @router.post(\"/api/session/{session_id}/message\")")]
    assert "fold_ledger" in fn and "discard_pending_fold" in fn, (
        "truncate must discard staged folds (#1728 B2) — a superseded take's fold must never "
        "reach the engine"
    )
    assert "discard_pending_fold(effective_user(request), session_id, keep_count)" in fn, (
        "discard_pending_fold must be called WITH keep_count (#1825 fix #2) — a call with only "
        "(owner, session_id) silently reverts to the tail-only discard the second Greptile P1 "
        "closed"
    )


def _read_chat_routes_py():
    import os
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "routes", "chat_routes.py")
    with open(path, encoding="utf-8") as f:
        return f.read()


def test_chat_routes_attaches_the_row_anchor_after_persisting():
    src = _read_chat_routes_py()
    assert "fold_ledger" in src and "attach_row_anchor" in src, (
        "the agent-mode persist path must attach the real row anchor to any fold staged this "
        "turn (#1728 B2, PR #1825 fix #2) — without it, discard_pending_fold can never tell an "
        "older surviving turn's fold from a superseded one, and truncate falls back to "
        "discarding every unanchored entry (a mandate-#4 regression, not a phantom-fold one)"
    )


def _read_agent_loop_py():
    import os
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "src", "agent_loop.py")
    with open(path, encoding="utf-8") as f:
        return f.read()


def test_settle_pending_fold_is_called_before_the_round_loop_starts():
    src = _read_agent_loop_py()
    impl_at = src.index("async def _stream_agent_loop_impl(")
    settle_call_at = src.index("await _settle_pending_fold(owner, session_id)", impl_at)
    round_loop_at = src.index("for round_num in range(1, max_rounds + 1):", impl_at)
    assert settle_call_at < round_loop_at, (
        "the deferred fold must settle BEFORE the new turn generates anything — never mid-stream"
    )


def test_settle_pending_fold_checks_row_existence_before_applying():
    src = _read_agent_loop_py()
    fn = src[src.index("async def _settle_pending_fold("):]
    fn = fn[:fn.index("\n# ── Whereabouts cohesion")]
    assert "entry_exists_at_settle" in fn, (
        "settle must check the anchored row still exists before applying (#1825 fix #2, item 4)"
    )
