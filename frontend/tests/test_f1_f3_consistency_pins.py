"""Structural pins for the concurrent-session consistency fix (F1/F2/F3) — the source-level legs a
revert would break, gated in `fe-unit` (no browser / engine boot required).

The behavioral proofs live in the browser gates (`test_f1_observer_order_two_window.py`,
`test_f3_drop_after_saved_no_recovery.py`) and the server-half unit test
(`test_f1_lead_user_event_seed.py`); these pins keep the wiring from silently drifting back:

  F1 — the run buffer LEADS with the persisted user turn, and every observer consumer (SSE resume, WS
       splice, the sender's own reader) renders/dedups it, so cause renders before effect.
  F2 — ONE dedup key per role: `clientMsgId` for the user message, run `{id, seq}` for the assistant.
  F3 — drop-recovery keys on the ABSENCE of a COMPLETION signal, not a channel close: a persisted
       `message_saved` / db id / `[DONE]` is authoritative completion and MUST suppress auto-recover.
"""
from __future__ import annotations

import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC = os.path.join(FRONTEND, "static", "js")


def _read(*parts) -> str:
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


# ── F1: the server seeds the run buffer with the leading user-message event ─────────────

def test_agent_runs_start_accepts_and_seeds_lead_event_before_the_drain():
    src = _read("src", "agent_runs.py")
    assert "lead_event: Optional[str] = None" in src, "start() must accept the lead_event seed"
    # The seed is published BEFORE the drain task is created, so it is guaranteed buffer index 0.
    assert "if lead_event:" in src and "_publish(run, lead_event)" in src
    seed_at = src.index("_publish(run, lead_event)")
    task_at = src.index("run.task = asyncio.create_task(_drain(session_id, agen, prev_task))")
    assert seed_at < task_at, "the lead event must be seeded BEFORE the drain task is created"


def test_chat_routes_builds_and_passes_the_lead_event_only_for_framed_turns():
    src = _read("routes", "chat_routes.py")
    assert "def _build_lead_user_event(" in src
    assert '"type": "user_message"' in src
    # Framed-only: a plain chat has no observer, so it does not seed (and the sender never dupes).
    # The framed-turn metadata is threaded through _PreparedChatTurn — `sess`/`message`/`client_msg_id`
    # are NOT in chat_stream's own scope, so the call reads them off `prepared` (a bare `sess`/`message`
    # reference here NameErrors on every framed turn → HTTP 500, the golden-replay break).
    assert "_lead_event = _build_lead_user_event(" in src
    assert "prepared.sess" in src and "prepared.message" in src and "prepared.client_msg_id" in src
    assert "if _framed else None" in src
    assert "agent_runs.start(run_key, _safe_stream(), queue=_framed, lead_event=_lead_event)" in src


# ── F1/F2: the client renderer — dedup-by-role-key, cause-before-effect insertion ───────

def test_chat_js_has_the_observer_user_bubble_renderer_with_dedup_and_ordering():
    src = _read("static", "js", "chat.js")
    assert "export function renderObserverUserMessage(" in src
    # Dedup by clientMsgId (the user's stable key) with the db id as a backstop — ONE key per role.
    assert "data-client-msg-id=" in src
    assert "_isSkippableUserPrompt(content)" in src, "must filter hidden cues exactly like the reconcile"
    # Adopt-not-duplicate: an existing bubble is stamped with {id, seq, clientMsgId}, never re-rendered.
    assert "existing.dataset.clientMsgId = cid" in src
    # Cause-before-effect: the new bubble is placed BEFORE the reply holder (or in seq order).
    assert "box.insertBefore(elx, opts.beforeEl)" in src


def test_sse_resume_and_sender_reader_render_the_leading_user_message():
    src = _read("static", "js", "chat.js")
    # Both the observer resume loop and the sender's own reader dispatch the user_message event through
    # the shared renderer (the sender finds+stamps its optimistic bubble; the observer renders one).
    assert src.count("json.type === 'user_message'") >= 2
    assert "renderObserverUserMessage(json, { beforeEl: holder })" in src              # SSE observer resume
    assert "renderObserverUserMessage(json, { beforeEl: currentHolder || holder })" in src  # sender adopt


def test_ws_splice_renders_the_leading_user_message_before_the_reply_holder():
    src = _read("static", "js", "chatWsSplice.js")
    assert "d.type === 'user_message'" in src
    assert "_renderUserMessage(d, { beforeEl: (_wsRound && _wsRound.holder) || null })" in src
    assert "if (deps.renderUserMessage) _renderUserMessage = deps.renderUserMessage;" in src
    # chat.js injects the concrete renderer into the WS splice.
    chat = _read("static", "js", "chat.js")
    assert "renderUserMessage: renderObserverUserMessage," in chat


# ── F3: drop-recovery gates on server-confirmed completion, not a channel close ──────────

def test_f3_auto_recover_is_gated_on_server_confirmed_completion():
    src = _read("static", "js", "chat.js")
    assert "_serverConfirmedDone" in src, "the F3 completion gate must exist"
    # A [DONE] sentinel, a persisted message_saved, OR a db id already on the holder = authoritative done.
    assert "_isServerConfirmedDone(_streamSawDone, _sawMessageSaved, holder)" in src
    assert "return !!(sawDone || sawSaved || (holder && holder.dataset && holder.dataset.dbId));" in src  # ORW-44 S4c: the gate is a named helper now (unit-tested in test_orw44_s4c_sse_reader_invariants.py)
    # The gate suppresses BOTH auto-recover AND the generic error surface on a confirmed-done close.
    assert "!_requeuedOffline && !_serverConfirmedDone &&" in src


def test_f3_leaves_the_legitimate_truncation_continue_affordances_untouched():
    """The server-driven truncation Continue (finish_reason:"length" / step-limit) and the user-stop
    interrupt Continue must stay — F3 only suppresses the FALSE drop-recovery, never these."""
    src = _read("static", "js", "chat.js")
    assert 'finish_reason' in src or 'finishReason' in src
    # The interrupt Continue prompt (user-stop path) is unchanged.
    assert "Your previous response was interrupted." in src
