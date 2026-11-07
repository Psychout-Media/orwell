"""Chat routes — /api/chat, /api/chat_stream, /api/inject_context, /api/search."""

import asyncio
import json
import os
import time
import logging
from datetime import datetime
from types import SimpleNamespace
from typing import Dict, Any, AsyncGenerator, List, Optional

from fastapi import APIRouter, Request, HTTPException, Form, Query
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from core.models import ChatMessage
from src.request_models import ChatRequest
from src.llm_core import llm_call_async, stream_llm, stream_llm_with_fallback
from src.agent_loop import stream_agent_loop
from src.tool_schemas import ORWELL_GAME_TOOLS
from src import agent_runs
from src import session_events
from src.model_context import estimate_tokens
from src.chat_helpers import coerce_message_and_session
from src.endpoint_resolver import normalize_base as _normalize_base, build_chat_url, resolve_session_headers
from src.session_search import search_session_messages
from src.prompt_security import untrusted_context_message
from core.exceptions import SessionNotFoundError
from src.auth_helpers import get_current_user
from routes.session_routes import _verify_session_owner
from routes.document_helpers import _owner_session_filter
from core.database import SessionLocal, get_session_mode, set_session_mode
from core.database import Session as DBSession, ChatMessage as DBChatMessage
from core.database import Document as DBDocument, ModelEndpoint
from routes.research_routes import _resolve_research_endpoint
from routes.model_routes import _visible_models
from routes.chat_helpers import (
    resolve_session_auth,
    build_chat_context,
    save_assistant_response,
    run_post_response_tasks,
    clean_thinking_for_save,
    save_stopped_partial,
    _enforce_chat_privileges,
    auto_escalation_withhold,
    ensure_turn_recorded,
    publish_game_updated_after_turn,
    GAME_ENGINE_WRITE_TOOLS,
    last_beat_seq,
    discard_last_user_message,
    unmark_session_framed,
    _last_message_ts,
    current_game_moment,
)
from src.action_intents import classify_tool_intent as _classify_tool_intent
from src.tool_policy import build_effective_tool_policy

logger = logging.getLogger(__name__)

# Track active streams for partial-save safety net
_active_streams: Dict[str, dict] = {}
_IMAGE_MODEL_PREFIXES = ("gpt-image", "dall-e", "chatgpt-image")

# Strong refs to fire-and-forget background tasks (e.g. the post-turn recordInteraction
# fallback). asyncio.create_task holds only a WEAK ref, so a task can be garbage-collected
# mid-flight before it completes — silently dropping the work. Retain each task here and
# discard it in a done-callback (the canonical asyncio pattern).
_BG_TASKS: set = set()


def _stream_set(session_id: str, **fields) -> None:
    """Update fields on the active-stream entry for `session_id`, or
    no-op if the entry has already been popped. Using .get() avoids a
    KeyError race between `if x in d` and `d[x]["k"] = v` if a sibling
    finally pops the key in between (which becomes possible the moment
    a coroutine cancellation reaches an inner cleanup before the
    outermost cleanup runs)."""
    rec = _active_streams.get(session_id)
    if rec is None:
        return
    rec.update(fields)


def _session_url_matches_endpoint(session_url: str, endpoint_base: str) -> bool:
    from src.endpoint_resolver import session_url_matches_endpoint
    return session_url_matches_endpoint(session_url, endpoint_base)


# F-TR-1 (perf audit): anti-buffering headers for every token-carrying SSE response. A reverse
# proxy in front of the app (nginx/Caddy/Cloudflare) will, by default, BUFFER a streaming body —
# holding tokens until a chunk threshold is hit, which erases the point of streaming and makes the
# send→first-visible-token wait read as a hang. `X-Accel-Buffering: no` tells nginx (and proxies
# that honor it) never to buffer this response; `Cache-Control: no-cache` keeps any cache from
# holding/replaying it. The persistent session-events SSE already sets exactly this dict — the
# token-stream (`chat_stream`) and resume (`chat_resume`) responses were missing it. Applied to the
# OUTER StreamingResponse of each token stream.
SSE_STREAM_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _sse_error_response(message: str, status: int = 400) -> StreamingResponse:
    """A one-shot SSE stream carrying a single ``event: error`` then ``[DONE]``.

    The streaming chat endpoint must NEVER reject a send with a bare HTTP 4xx: the
    client opens an SSE reader and renders ``event: error`` chunks (the dead-endpoint
    path already relies on this), but a non-200 with a plain body is the fragile
    branch that can leave a sent message looking like it "went into nothing" — no
    visible reason, and the optimistic user bubble has nothing on the server to
    reconcile to. Routing the pre-stream model/endpoint guards through this helper
    guarantees the failure ALWAYS surfaces in the transcript (HTTP 200 + a streamed
    error), exactly like an upstream model failure mid-stream.
    """
    async def _gen() -> AsyncGenerator[str, None]:
        yield f'event: error\ndata: {json.dumps({"error": message, "status": status})}\n\n'
        yield "data: [DONE]\n\n"
    return StreamingResponse(_gen(), media_type="text/event-stream")


def _build_lead_user_event(sess, message, client_msg_id) -> Optional[str]:
    """F1 (concurrent-session consistency — the causal-inversion fix): build the SSE event that SEEDS
    the detached run buffer with the prompting USER turn as its FIRST event, so replay-then-tail
    delivers cause-before-effect to every observer/mirror window.

    The live channel (`agent_runs` run buffer, fanned over the WS `chat` channel and SSE resume)
    carries ONLY the assistant reply; the user turn is not broadcast on it. So a peer window's only
    live signal (`run-started` → resume) mounts the reply holder before the user bubble exists — the
    reply can render before its cause. Leading the buffer with the persisted user message fixes the
    ordering atomically for BOTH transports (the WS ``_sse_to_payload`` turns this into the same
    ``event.d`` body the SSE reader parses).

    Vault-free by construction — the payload is the player's OWN words plus the authoritative
    ``{id, seq}`` and the round-tripped optimistic ``clientMsgId`` (so the settle reconcile adopts the
    live bubble with zero churn, never a duplicate). Reads the just-persisted user row off
    ``sess.history`` (``_persist_message`` stamps ``metadata['_db_id']`` / ``['_seq']`` synchronously).
    Returns ``None`` (⇒ no seed, byte-identical prior behavior) if the user row can't be located."""
    try:
        text = message if isinstance(message, str) else ""
        db_id = None
        seq = None
        cid = client_msg_id
        found = False
        for _m in reversed(getattr(sess, "history", []) or []):
            if getattr(_m, "role", None) != "user":
                continue
            _md = getattr(_m, "metadata", None) or {}
            db_id = _md.get("_db_id")
            seq = _md.get("_seq")
            cid = _md.get("client_msg_id") or client_msg_id
            # Prefer the persisted user text if the raw `message` is empty (e.g. attachment-only sends),
            # but only when it is a plain string (multimodal content is a list — leave the bubble to the
            # settle reconcile, which renders the full row).
            if not text and isinstance(getattr(_m, "content", None), str):
                text = _m.content
            found = True
            break
        # No identifiable persisted user row ⇒ seed NOTHING (an event with no db id / clientMsgId is an
        # unadoptable orphan the settle reconcile would have to rebuild away). None ⇒ prior behavior.
        if not found or (db_id is None and not cid):
            return None
        payload = {
            "type": "user_message",
            "id": db_id,
            "seq": seq,
            "content": text,
            "clientMsgId": cid,
            "role": "user",
        }
        return f"data: {json.dumps(payload)}\n\n"
    except Exception:
        return None


def _clear_orphaned_session_endpoint(sess, owner: str | None = None) -> bool:
    """Clear a session model if its endpoint was deleted from ModelEndpoint.

    F7/DB6: a NULL-owner ("legacy/shared") endpoint that a session points at must NOT be
    treated as removed. The match query used ``owner_filter(include_shared=False)``, so a
    null-owner endpoint never matched → the session was wrongly cleared → an opaque 400 on
    every turn (the endpoint exists and is usable; the orphan-clear just couldn't see it).

    Fix: match own-AND-shared (``include_shared=True``) so a session bound to a shared endpoint
    is recognized as present. This does NOT leak another user's OWNED endpoint — a NULL-owner row
    is shared/legacy and visible to every user by design (mirroring ``_recover_empty_session_model``,
    which already resolves shared endpoints). When the only match is a NULL-owner endpoint, ADOPT it
    for this user (stamp ``owner``) so subsequent owner-scoped resolution finds it cleanly. The
    cross-user isolation mandate is preserved: we never match ``owner == <other user>``.
    """
    if not getattr(sess, "endpoint_url", ""):
        return False
    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
        if owner:
            from src.auth_helpers import owner_filter
            # include_shared=True: own + NULL-owner ONLY (never another user's owned row).
            q = owner_filter(q, ModelEndpoint, owner, include_shared=True)
        endpoints = q.all()
        for ep in endpoints:
            if _session_url_matches_endpoint(sess.endpoint_url or "", ep.base_url or ""):
                # Found a live, usable endpoint — the session is NOT orphaned.
                # Adopt a shared (NULL-owner) endpoint for this user so later owner-scoped
                # lookups resolve it directly. Best-effort; never blocks the turn.
                if owner and getattr(ep, "owner", None) is None:
                    try:
                        ep.owner = owner
                        db.commit()
                        logger.info(
                            "Adopted shared (owner=NULL) endpoint %s for user %s "
                            "(session %s pointed at it)",
                            getattr(ep, "id", "?"), owner, getattr(sess, "id", "?"),
                        )
                    except Exception:
                        db.rollback()
                return False
        db_session = db.query(DBSession).filter(DBSession.id == sess.id).first()
        if db_session:
            db_session.endpoint_url = ""
            db_session.model = ""
            db_session.updated_at = datetime.utcnow()
            db.commit()
        sess.endpoint_url = ""
        sess.model = ""
        sess.headers = {}
        return True
    except Exception:
        db.rollback()
        return False
    finally:
        db.close()


# DB6: how stale a 0-message, no-model casting-shell session must be before the reaper
# touches it. Generous so a freshly-opened tab mid-setup (model not yet bound, no message
# sent) is never deleted out from under the user.
_ORPHAN_SHELL_REAP_MINUTES = 30


def _reap_orphaned_shell_sessions(session_manager, owner: str | None,
                                  older_than_minutes: int = _ORPHAN_SHELL_REAP_MINUTES) -> int:
    """DB6: reap stale, never-used casting-shell sessions.

    Orphaned 0-message shells accumulate when a casting interview is opened (a session row is
    minted) but never used — they pile up forever and clutter the session list. Reap a session
    ONLY when ALL hold:

      * it belongs to ``owner`` (owner-scoped; a NULL-owner session is only reaped in single-user
        mode where ``owner`` is empty — never across users);
      * it has NO messages (``message_count == 0`` AND zero persisted ChatMessage rows — we verify
        the rows so a stale/incorrect counter can't trigger a delete of a real conversation);
      * it has NO model bound (a configured shell, not a chat the user set up to send);
      * it is older than ``older_than_minutes`` (a fresh mid-setup tab is never reaped); AND
      * it is NOT this user's CANONICAL game session — the live game's session is never deleted,
        even if it currently shows 0 messages (a brand-new season before the first beat).

    Best-effort and fail-soft: any error returns the count so far and never breaks the turn.
    Returns the number of sessions reaped.
    """
    from datetime import timedelta
    try:
        canonical = None
        try:
            from src import orwell_game_session
            canonical = orwell_game_session.get_game_session(owner)
        except Exception:
            canonical = None
        cutoff = datetime.utcnow() - timedelta(minutes=max(0, older_than_minutes))
        db = SessionLocal()
        try:
            q = db.query(DBSession).filter(
                DBSession.message_count == 0,
                ((DBSession.model == "") | (DBSession.model == None)),  # noqa: E711
                DBSession.created_at < cutoff,
            )
            # Owner scope. When owner is set, only that user's rows (never NULL-owner shared rows,
            # never another user's). When empty (single-user mode), any row qualifies.
            if owner:
                q = q.filter(DBSession.owner == owner)
            candidates = q.all()
            ids = [c.id for c in candidates]
        finally:
            db.close()
        reaped = 0
        for sid in ids:
            if not sid or sid == canonical:
                continue  # never delete the live game's canonical session
            # Double-check no real messages exist (the counter could be stale).
            mdb = SessionLocal()
            try:
                has_msg = (
                    mdb.query(DBChatMessage.id)
                    .filter(DBChatMessage.session_id == sid)
                    .first()
                    is not None
                )
            finally:
                mdb.close()
            if has_msg:
                continue
            try:
                if session_manager.delete_session(sid):
                    reaped += 1
                    logger.info("Reaped orphaned 0-message shell session %s (owner=%s)", sid, owner)
            except Exception:
                logger.debug("orphan-shell reap of %s skipped", sid, exc_info=True)
        return reaped
    except Exception as e:
        logger.debug("orphan-shell reaper skipped: %s", e)
        return 0


def _endpoint_cache_contains_model(endpoint, model: str) -> bool:
    """Return True when a populated endpoint model cache includes ``model``.

    Empty/malformed caches are treated as unknown rather than a negative match
    so older image endpoints without cached models still work.
    """
    raw = getattr(endpoint, "cached_models", None)
    if not raw:
        return True
    try:
        models = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return True
    if not isinstance(models, list) or not models:
        return True
    wanted = (model or "").strip()
    return wanted in {str(item).strip() for item in models}


def _is_image_generation_session(sess, owner: str | None = None) -> bool:
    """Whether this chat session should bypass text chat and generate images.

    Model-name prefixes are explicit image models. Endpoint type is only used
    when the current session endpoint actually matches that image endpoint, and
    when a populated endpoint model cache includes the selected model. This
    prevents an image endpoint on the same host from misrouting ordinary text
    models into the image-generation path.
    """
    model = (getattr(sess, "model", "") or "").strip()
    if any(model.lower().startswith(prefix) for prefix in _IMAGE_MODEL_PREFIXES):
        return True

    endpoint_url = (getattr(sess, "endpoint_url", "") or "").strip()
    if not endpoint_url:
        return False

    db = SessionLocal()
    try:
        q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
        if owner:
            from src.auth_helpers import owner_filter
            q = owner_filter(q, ModelEndpoint, owner)
        endpoints = q.all()
        for endpoint in endpoints:
            if (getattr(endpoint, "model_type", None) or "llm") != "image":
                continue
            if not _session_url_matches_endpoint(endpoint_url, getattr(endpoint, "base_url", "") or ""):
                continue
            if _endpoint_cache_contains_model(endpoint, model):
                return True
    except Exception:
        return False
    finally:
        db.close()
    return False


def _default_chat_target(owner: str | None) -> tuple[str, str]:
    """The user's configured default (endpoint_id, model) for chat — the same source of truth as
    GET /api/default-chat: per-user prefs first, then the global settings. Best-effort; ('', '') if
    nothing is configured."""
    ep_id = model = ""
    try:
        if owner:
            from routes.prefs_routes import _load_for_user
            prefs = _load_for_user(owner) or {}
            ep_id = (prefs.get("default_endpoint_id") or "").strip()
            model = (prefs.get("default_model") or "").strip()
    except Exception:
        pass
    if not (ep_id or model):
        try:
            from src.settings import load_settings
            s = load_settings() or {}
            ep_id = (s.get("default_endpoint_id") or "").strip()
            model = (s.get("default_model") or "").strip()
        except Exception:
            pass
    return ep_id, model


def _recover_empty_session_model(sess, session_id: str, owner: str | None = None) -> bool:
    """Re-populate sess.model (and endpoint_url) so a model-less session can still send.

    Covers two cases:
      1. Issue #587 — the picker showed a model but the session row never got it written (the
         endpoint the session already points at is matched and its first chat model is used).
      2. The session has NO model AND no endpoint we can match — most often a game/canonical
         session whose model binding was never written, or a stale one. Without recovery the send
         is REFUSED ("No model selected") even though a default IS configured — the "I have a model
         set / picked one, but the game still can't send and nothing reaches the API" bug. We fall
         back to the user's CONFIGURED DEFAULT (default_endpoint_id + default_model), then to the
         first enabled endpoint visible to them, and bind that to the session.

    Also repairs a session whose saved model is a text→image model (it can't hold a conversation).

    Returns True iff sess.model was repaired.
    """
    from src.llm_core import is_image_model
    from src.auth_helpers import owner_filter
    from src.endpoint_resolver import _first_chat_model
    existing = getattr(sess, "model", None)
    if existing and not is_image_model(existing):
        return False
    db = SessionLocal()
    try:
        # 1) Prefer the endpoint the session already points at (URL match) — the user pointed it here.
        ep = None
        if getattr(sess, "endpoint_url", ""):
            q = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
            if owner:
                q = owner_filter(q, ModelEndpoint, owner, include_shared=True)
            for cand in q.all():
                if _session_url_matches_endpoint(sess.endpoint_url or "", cand.base_url or ""):
                    ep = cand
                    break
        # 2) FALLBACK: no model + no matching endpoint. Resolve the configured default, then the first
        #    enabled endpoint visible to the owner (shared included — it's a configured provider).
        preferred_model = ""
        if not ep:
            default_ep_id, preferred_model = _default_chat_target(owner)
            q2 = db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True)
            if owner:
                q2 = owner_filter(q2, ModelEndpoint, owner, include_shared=True)
            if default_ep_id:
                ep = q2.filter(ModelEndpoint.id == default_ep_id).first()
            if not ep:
                ep = q2.first()
        if not ep:
            return False
        try:
            cached = json.loads(ep.cached_models) if isinstance(ep.cached_models, str) else (ep.cached_models or [])
        except Exception:
            cached = []
        try:
            visible = _visible_models(cached, getattr(ep, "hidden_models", None))
        except Exception:
            visible = cached or []
        # Choose the model: the configured default IF the endpoint actually serves it (and it's a chat
        # model) — honoring the user's pick; otherwise the endpoint's first real CHAT model (never an
        # image model — the "responses going to gemini-flash-image" bug). If the endpoint has no cached
        # list yet, trust the configured default (a freshly-added endpoint may be unprobed).
        # A *probed* endpoint (non-empty cached_models) that does NOT serve the configured default must
        # NEVER bind that id — that is the "200 empty / no real completions" footgun (every request
        # dispatches a model the endpoint can't serve). Prefer a served chat model instead, and warn.
        probed = bool(cached)  # cached_models present ⇒ the endpoint was probed
        model = ""
        if preferred_model and not is_image_model(preferred_model) and (preferred_model in (visible or [])):
            model = preferred_model
        if not model and visible:
            _cand = _first_chat_model(visible) or ""
            # `_first_chat_model` falls through to models[0] for an all-image served list — never bind
            # an image model as the chat default (the "responses going to gemini-flash-image" bug).
            model = "" if (_cand and is_image_model(_cand)) else _cand
        if not model and preferred_model and not is_image_model(preferred_model):
            if probed:
                # Probed endpoint that does not serve the configured default and offers no chat model
                # we can substitute — refuse to bind the unserved id (it would dispatch every turn to a
                # model the endpoint rejects, returning a 200-empty / blank turn).
                logger.warning(
                    "bound model not in endpoint served list — refusing to bind configured default %r "
                    "for %s (endpoint %s served=%d models, none usable as chat)",
                    preferred_model, session_id, ep.id, len(visible or []),
                )
                return False
            # Genuinely unprobed endpoint — trust the configured default, but flag that it is unverified
            # (we cannot confirm the endpoint serves it; a later 200-empty would point here).
            logger.warning(
                "binding UNVERIFIED model %r for %s — endpoint %s has no probed model list; "
                "cannot confirm it is served",
                preferred_model, session_id, ep.id,
            )
            model = preferred_model
        if probed and preferred_model and model and model != preferred_model:
            # We substituted a served model because the configured default is not in the served list.
            logger.warning(
                "bound model not in endpoint served list — substituted served chat model %r for "
                "configured default %r (%s, endpoint %s)",
                model, preferred_model, session_id, ep.id,
            )
        if not isinstance(model, str) or not model.strip():
            return False
        model = model.strip()
        new_url = (ep.base_url or getattr(sess, "endpoint_url", "") or "").strip()
        # Persist model + endpoint (BOTH — the fallback may have re-pointed a model-less session at the
        # default endpoint), so the next request / reconnect / reload picks up the same binding.
        db_session = db.query(DBSession).filter(DBSession.id == session_id).first()
        if db_session:
            db_session.model = model
            if new_url:
                db_session.endpoint_url = new_url
            db_session.updated_at = datetime.utcnow()
            db.commit()
        sess.model = model
        if new_url:
            sess.endpoint_url = new_url
        logger.info(
            "Recovered empty session model for %s — bound %r @ %s (endpoint %s)",
            session_id, model, new_url, ep.id,
        )
        return True
    except Exception as e:
        db.rollback()
        logger.warning("Failed to recover empty session model for %s: %s", session_id, e)
        return False
    finally:
        db.close()


def _mirror_model_to_canonical_session(session_manager, per_tab_sess, per_tab_id: str,
                                       canonical_id: str | None) -> None:
    """F2 (lost-model fix): when a FRAMED game/casting turn executes against a CANONICAL session id
    that differs from the per-tab id this window POSTed under, the recovered/bound model lives on the
    per-tab row — but the run is keyed on the canonical id (run_key) and convergence persists there.
    Without mirroring, the model is "written to one identity, read from another": the canonical row
    stays empty, so `_recover_empty_session_model` re-fires every turn ("Recovered empty session
    model" forever) and a later sync_session_metadata against the empty canonical row can blank it.

    Copy the per-tab session's (just-recovered) model + endpoint onto the canonical session — cached
    object AND DB row — so the id the turn actually executes/persists against carries the binding.
    Idempotent, best-effort: never blocks the turn. Only ever ADDS a model to the canonical row (it
    never clears one — the F2 sync guard relies on the same "DB only adds a model" invariant).
    """
    try:
        if not canonical_id or canonical_id == per_tab_id:
            return
        model = (getattr(per_tab_sess, "model", "") or "").strip()
        if not model:
            return
        url = (getattr(per_tab_sess, "endpoint_url", "") or "").strip()
        # Cached object (so this same request and the immediate next read see it without a DB round-trip).
        try:
            canon = session_manager.sessions.get(canonical_id)
        except Exception:
            canon = None
        if canon is not None and not (getattr(canon, "model", "") or "").strip():
            canon.model = model
            if url and not (getattr(canon, "endpoint_url", "") or "").strip():
                canon.endpoint_url = url
        # DB row — only fill an EMPTY canonical model (never stomp a real one).
        db = SessionLocal()
        try:
            row = db.query(DBSession).filter(DBSession.id == canonical_id).first()
            if row is not None and not (row.model or "").strip():
                row.model = model
                if url and not (row.endpoint_url or "").strip():
                    row.endpoint_url = url
                try:
                    row.updated_at = datetime.utcnow()
                except Exception:
                    pass
                db.commit()
                logger.info(
                    "Mirrored model %r onto canonical session %s (from per-tab %s)",
                    model, canonical_id, per_tab_id,
                )
        except Exception:
            db.rollback()
        finally:
            db.close()
    except Exception as e:
        logger.debug("model mirror to canonical session skipped: %s", e)


def _set_user_time_from_request(request: Request) -> None:
    """Copy browser timezone headers into the per-request context.

    This is intentionally ephemeral: it is used only while building prompts
    and running tools for this request. It is not persisted or logged.
    """
    try:
        tz_offset = request.headers.get("x-tz-offset")
        tz_name = request.headers.get("x-tz-name")
        from src.user_time import clear_user_time_context, set_user_tz_name, set_user_tz_offset

        clear_user_time_context()
        if tz_offset is not None:
            set_user_tz_offset(tz_offset)
        if tz_name:
            set_user_tz_name(tz_name)
    except Exception:
        pass


# ── WebSocket Phase-1 turn producer (ADR 0017 / routes/ws_routes.py, protocol §3.5) ─────────────────
#
# The WS `turn` up-frame must stream the SAME narration the HTTP `POST /api/chat_stream` path does. The
# narration pipeline is the `_prepare_chat_stream` closure inside `setup_chat_routes` (extracted from the
# old monolithic `chat_stream` — the HTTP route is now a THIN wrapper over it, byte-identical). To reuse
# it off an HTTP request, the registered WS factory drives that same pipeline through a minimal Request
# SHIM carrying exactly the surface the pipeline touches: the authenticated user (already resolved AND
# owner-guarded by ws_routes before the factory is called), the live app (for the `auth_manager`
# privilege gates), empty headers/cookies, and a form-like view of the `turn` frame's `d`. Nothing forks
# — a WS turn is an ordinary game turn (agent mode, game-build tools), so every request-derived flag the
# shim omits takes its exact HTTP default.


class _PreparedChatTurn:
    """The built-but-not-started narration producer plus the metadata the HTTP tail (ADR 0012 run-keying
    / casting single-flight / subscribe) needs. ``producer`` is the ``_safe_stream`` async-generator
    FUNCTION — call it once to get the SSE-string stream ``agent_runs.start`` drains. A distinct type (not
    a bare tuple) so the wrapper can cleanly tell a prepared turn from an early ``_sse_error_response``."""

    # F1 (concurrent-session consistency): `sess`/`message`/`client_msg_id` carry the framed-turn
    # metadata the HTTP tail needs to seed the ordered lead user-message event (`_build_lead_user_event`).
    # They are populated only where in scope (the prepare step); default None keeps early/other builders safe.
    __slots__ = ("producer", "session", "ctx", "compare_mode", "sess", "message", "client_msg_id")

    def __init__(self, producer, session, ctx, compare_mode, sess=None, message=None, client_msg_id=None):
        self.producer = producer
        self.session = session
        self.ctx = ctx
        self.compare_mode = compare_mode
        self.sess = sess
        self.message = message
        self.client_msg_id = client_msg_id


def _resolve_fastapi_app():
    """The live FastAPI app (for ``app.state.auth_manager``), resolved lazily so the WS request shim
    never needs the socket handle. Imported at call time — long after ``app`` finished importing — so
    there is no circular import."""
    try:
        import app as _app_mod
        return getattr(_app_mod, "app", None)
    except Exception:
        return None


class _WsChatRequest:
    """A minimal Starlette-``Request`` stand-in presenting ONLY the surface the chat_stream pipeline
    reads: ``.state.current_user`` (+ the non-api-token markers ``effective_user`` checks),
    ``.app.state.auth_manager`` (the privilege gates), ``.headers.get`` (content-type + tz), ``.cookies``,
    and the awaitable ``.form()`` / ``.json()``. Everything else is intentionally absent — a WS turn is a
    plain game turn, so the pipeline's request-derived flags all take their HTTP defaults. The user was
    ALREADY resolved and owner-guarded by ws_routes before this shim exists (the pipeline still re-checks
    ownership itself, which passes for the user's own canonical session)."""

    def __init__(self, user: Optional[str], form: dict):
        app = _resolve_fastapi_app()
        if app is None:  # degrade safely: no auth_manager ⇒ the privilege gates simply no-op
            app = SimpleNamespace(state=SimpleNamespace(auth_manager=None))
        self.app = app
        self.state = SimpleNamespace(current_user=user, api_token=False, api_token_owner=None)
        self.headers: dict = {}
        self.cookies: dict = {}
        self._form = form

    async def form(self):
        return self._form

    async def json(self):  # unreachable: the shim never sets an application/json content-type
        raise ValueError("no json body on a WS turn")


def make_ws_turn_stream_factory(prepare_chat_stream):
    """Build the WS ``turn`` producer factory over a chat pipeline ``prepare_chat_stream`` (the
    ``_prepare_chat_stream`` closure ``setup_chat_routes`` owns). A WS ``turn`` up-frame reuses the
    EXACT HTTP narration pipeline so both transports stream identical ``chat`` ``event`` frames (the
    reasoning split rides INSIDE each payload as the ``thinking`` flag — never a separate channel;
    ADR 0015). The producer defers all async prep INTO the returned generator (``build_chat_context``
    persists the user message + fires message-added, then the ``_safe_stream`` tokens flow); ws_routes
    drains it via ``agent_runs.start(canonical, producer, queue=True)`` — the single-writer game-turn
    broadcast. Any prep failure surfaces as a clean ``event: error`` + ``[DONE]`` (the same terminal
    contract ``_safe_stream`` guarantees), never a bare drop. Lifted to module level so it is unit-
    testable against the real shim / producer wiring with only the LLM-backed narration substituted."""

    def _ws_turn_stream_factory(d: dict, canonical: str, user: Optional[str]) -> AsyncGenerator[str, None]:
        atts = d.get("attachments")
        # A form-like view of the ``turn`` frame — only the fields a game turn carries; every other
        # ``chat_stream`` form key is absent, so the pipeline takes its exact HTTP default. ``session``
        # is the ALREADY-resolved canonical id (ws_routes keys the run on the same id), so persistence
        # and the run share one identity — the converged, split-brain-free state (ADR 0012 §3.1).
        form = {
            "message": d.get("message"),
            "session": canonical,
            "mode": (d.get("mode") or "agent"),
            "client_msg_id": d.get("clientMsgId"),
        }
        if isinstance(atts, list) and atts:
            form["attachments"] = json.dumps([str(x) for x in atts])

        async def _producer() -> AsyncGenerator[str, None]:
            try:
                prepared = await prepare_chat_stream(_WsChatRequest(user, form))
            except HTTPException as e:
                yield (f'event: error\ndata: '
                       f'{json.dumps({"error": e.detail, "status": e.status_code, "terminal": True})}\n\n')
                yield "data: [DONE]\n\n"
                return
            except Exception as e:  # noqa: BLE001 — surface, never a bare drop (mirrors _safe_stream)
                logger.exception("[ws] turn producer prep failed (session %s)", canonical)
                yield (f'event: error\ndata: '
                       f'{json.dumps({"error": str(e) or "Turn failed.", "status": 500, "terminal": True})}\n\n')
                yield "data: [DONE]\n\n"
                return
            if isinstance(prepared, _PreparedChatTurn):
                async for chunk in prepared.producer():
                    yield chunk
            else:
                # An early ``_sse_error_response`` (a StreamingResponse of SSE strings) — forward its
                # body verbatim so a WS turn surfaces the same pre-stream guard the HTTP path would.
                async for chunk in prepared.body_iterator:
                    yield chunk

        return _producer()

    return _ws_turn_stream_factory


def setup_chat_routes(
    session_manager,
    chat_handler,
    chat_processor,
    memory_manager,
    research_handler,
    upload_handler,
    memory_vector=None,
    webhook_manager=None,
    skills_manager=None,
) -> APIRouter:
    router = APIRouter(tags=["chat"])

    # ------------------------------------------------------------------ #
    # POST /api/chat (non-streaming)
    # ------------------------------------------------------------------ #
    @router.post("/api/chat", response_model=Dict[str, str])
    async def chat_endpoint(request: Request, chat_request: ChatRequest) -> Dict[str, str]:
        _set_user_time_from_request(request)

        message = chat_request.message
        session = chat_request.session
        att_ids = chat_request.attachments or []
        use_web = chat_request.use_web
        use_research = chat_request.use_research
        time_filter = chat_request.time_filter
        preset_id = chat_request.preset_id

        # Verify the caller owns this session before loading it.
        # Without this, any authenticated user can post into another user's chat.
        _verify_session_owner(request, session)

        try:
            sess = session_manager.get_session(session)
        except KeyError:
            raise HTTPException(404, f"Session '{session}' not found")
        owner = get_current_user(request)
        if _clear_orphaned_session_endpoint(sess, owner=owner):
            raise HTTPException(400, "Selected model endpoint was removed. Pick another model in Settings.")

        # Empty model + live endpoint = setup race (Issue #587). Repair from
        # the endpoint's cached model list before privilege checks, which
        # otherwise see "" and behave inconsistently with the allowlist.
        _recover_empty_session_model(sess, session, owner=owner)
        if not getattr(sess, "model", "").strip():
            raise HTTPException(
                400,
                "No model selected for this chat. Open the model picker and choose one before sending.",
            )

        # Same allowed_models + daily-cap gate as chat_stream (mirror so the
        # non-streaming path can't be used to bypass).
        _enforce_chat_privileges(request, sess)

        tool_policy = build_effective_tool_policy(last_user_message=message)
        allow_tool_preprocessing = not tool_policy.block_all_tool_calls

        # Inline memory command
        memory_response = None
        if not tool_policy.blocks("manage_memory"):
            memory_response = await chat_handler.handle_memory_command(sess, message)
        if memory_response:
            return {"response": memory_response}

        # E25: refuse a game turn BEFORE build_chat_context persists the user message —
        # the old post-context 409 left an orphaned transcript row (duplicated on retry).
        # Engine unreachable / no game ⇒ fall through (framing handles feeds-down honestly).
        _game_409 = (
            "A Big Brother game is in progress: game turns must use the streaming chat "
            "(agent) endpoint so the engine records and decides them."
        )
        try:
            from src import orwell_engine as _oe
            from src.auth_helpers import effective_user as _eff
            _pre_state = await _oe.get_game_state(user=_eff(request))
        except Exception:
            _pre_state = None
        if isinstance(_pre_state, dict) and _pre_state.get("started"):
            raise HTTPException(409, _game_409)

        # Build shared context (preset, preprocess, preface, compact)
        ctx = await build_chat_context(
            sess, request, chat_handler, chat_processor,
            message=message,
            session_id=session,
            preset_id=preset_id,
            att_ids=att_ids,
            use_web=use_web,
            time_filter=time_filter,
            webhook_manager=webhook_manager,
            allow_tool_preprocessing=allow_tool_preprocessing,
        )

        # F3/C14: the sync endpoint has NO tools, so a game turn here would be pure
        # consequence-free imitation (narrated, never recorded). Decline to game-master:
        # game turns go through the streaming agent path the UI uses. (Belt — the E25 hoist
        # above normally refuses first; this covers a game starting between the two reads.)
        #
        # F5 (invariant — verified, intentionally unchanged): this discard is gated on
        # `ctx.game_active`, which is True ONLY when a season is `started` (chat_helpers:2001).
        # A CASTING / OOC turn is pre-game (`started` is False ⇒ game_active False), so it falls
        # THROUGH this branch and is NEVER discarded — and casting runs on the STREAMING agent path,
        # which has no discard at all. So `discard_last_user_message` can only fire for a turn this
        # tool-less sync endpoint genuinely refused (recorded no effect): the precondition holds.
        if ctx.game_active:
            discard_last_user_message(sess)   # E25: never leave the refused turn persisted
            unmark_session_framed(session)    # P2: the refusal must not consume re-entry
            raise HTTPException(409, _game_409)

        # Research injection
        research_blocked_by_policy = (
            tool_policy.blocks("trigger_research")
            or tool_policy.blocks("manage_research")
        )
        if use_research and not research_blocked_by_policy:
            try:
                _r_ep, _r_model, _r_headers = _resolve_research_endpoint(sess)
                research_ctx = await research_handler.call_research_service(
                    message, _r_ep, _r_model, llm_headers=_r_headers
                )
                ctx.messages.insert(
                    len(ctx.preface),
                    untrusted_context_message("research context", research_ctx),
                )
            except Exception as e:
                logger.error(f"Research failed: {e}")

        reply = await llm_call_async(
            sess.endpoint_url,
            sess.model,
            ctx.messages,
            headers=resolve_session_headers(sess),
            temperature=ctx.preset.temperature,
            max_tokens=ctx.preset.max_tokens,
            prompt_type=preset_id,
        )
        _clean_reply, _clean_md = clean_thinking_for_save(reply, {"model": sess.model})
        sess.add_message(ChatMessage("assistant", _clean_reply, metadata=_clean_md))

        from core.database import update_session_last_accessed
        update_session_last_accessed(session)
        session_manager.save_sessions()
        session_events.publish(session, "message-added")

        # Background tasks (memory, webhook, auto-name)
        run_post_response_tasks(
            sess, session_manager, session, message, reply, None,
            ctx.uprefs, memory_manager, memory_vector, webhook_manager,
            character_name=ctx.preset.character_name,
            owner=ctx.user,
            allow_background_extraction=not tool_policy.block_all_tool_calls,
        )

        return {"response": reply}

    # ------------------------------------------------------------------ #
    # The shared narration pipeline behind POST /api/chat_stream. Extracted as
    # a producer builder so the WS `turn` relay (routes/ws_routes.py) reuses it
    # VERBATIM via set_turn_stream_factory (ADR 0017 §3.5). Returns either an
    # early `_sse_error_response` (a StreamingResponse, forwarded as-is) or a
    # `_PreparedChatTurn` bundle; the `chat_stream` route below runs the
    # ADR 0012 run-keying / casting / subscribe TAIL over it. The refactor
    # EXTRACTS — it does not change HTTP behavior.
    # ------------------------------------------------------------------ #
    async def _prepare_chat_stream(request):
        body = None
        try:
            if request.headers.get("content-type", "").startswith("application/json"):
                try:
                    body = await request.json()
                except json.JSONDecodeError as e:
                    raise HTTPException(400, f"Invalid JSON: {e}")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(400, f"Request parsing error: {e}")

        _set_user_time_from_request(request)

        form_data = await request.form()
        message = form_data.get("message")
        session = form_data.get("session")
        attachments = form_data.get("attachments")
        use_web = form_data.get("use_web")
        use_research = form_data.get("use_research")
        time_filter = form_data.get("time_filter")
        preset_id = form_data.get("preset_id")
        allow_bash = form_data.get("allow_bash")
        allow_web_search = form_data.get("allow_web_search")
        use_rag = form_data.get("use_rag")
        search_context = form_data.get("search_context")  # pre-fetched web search results (compare mode)
        # ADR 0008: the FE's optimistic temp id for THIS turn's user bubble — round-tripped onto the
        # persisted user message so the sender can adopt its own bubble to the canonical {id, seq}.
        client_msg_id = form_data.get("client_msg_id")
        compare_mode = str(form_data.get("compare_mode", "")).lower() == "true"
        incognito = str(form_data.get("incognito", "")).lower() == "true"
        # E24/P7: under the game build the "Nobody"/incognito toggle is inert server-side.
        # Reachable via /incognito + a hidden checkbox, it stripped ALL game framing while the
        # in-character transcript rode along — an unframed, unrecorded imitation-play channel
        # (and a memory/persistence bypass). The game is the product; the toggle cannot be.
        if incognito:
            from src.settings import game_build_enabled as _gbe
            if _gbe():
                logger.info("[orwell] incognito requested under the game build — ignored (E24/P7)")
                incognito = False
        plan_mode = str(form_data.get("plan_mode", "")).lower() == "true"
        chat_mode = str(form_data.get("mode", "")).lower()  # 'chat' or 'agent'
        # Workspace: confine the agent's file/shell tools to this folder. Validate
        # it's a real directory; ignore (no confinement) otherwise.
        workspace = (form_data.get("workspace") or "").strip()
        if workspace:
            _ws_real = os.path.realpath(os.path.expanduser(workspace))
            workspace = _ws_real if os.path.isdir(_ws_real) else ""
        # Plan mode is a modifier on agent mode — it only makes sense with tools.
        if plan_mode:
            chat_mode = "agent"
        # An approved plan being EXECUTED: the frontend sends the checklist back
        # on each turn so we can pin it in context. This way a long plan on a
        # weak model survives history truncation — the agent can always re-read
        # the plan. Ignored while still proposing (plan_mode on). Capped so a
        # huge plan can't blow the prompt.
        approved_plan = ""
        if not plan_mode:
            approved_plan = (form_data.get("approved_plan") or "").strip()[:8192]
        # Did the USER explicitly pick agent mode? (vs. us auto-escalating
        # below). Skill extraction should only learn from real agent sessions,
        # not chats we quietly promoted for a notes/calendar intent.
        user_requested_agent = (chat_mode == "agent")
        # Intent auto-escalation: if the user is clearly asking the assistant
        # to create a todo, reminder, or calendar event, promote chat → agent
        # for this turn so the LLM has access to manage_notes / manage_calendar.
        # This is a LIGHT promotion — see the disabled_tools block below, which
        # withholds shell/code/file tools so the model doesn't try to `bash`
        # its way through a plain chat request (and fail, especially with the
        # shell disabled).
        auto_escalated = False
        _tool_intent = _classify_tool_intent(message) if isinstance(message, str) else None
        if chat_mode == "chat" and _tool_intent and _tool_intent.needs_tools:
            chat_mode = "agent"
            auto_escalated = True
            logger.info(
                "chat→agent auto-escalation: category=%s reason=%s",
                _tool_intent.category,
                _tool_intent.reason,
            )
        active_doc_id = form_data.get("active_doc_id", "").strip()
        logger.info(f"[doc-inject] chat_mode={chat_mode}, active_doc_id={active_doc_id!r}")

        try:
            # Attachment-only sends: skip the message-required check when the
            # user has attached one or more files (the attachment IS the action).
            _has_atts = (
                bool(body and isinstance(body.get("attachments"), list) and body["attachments"])
                or bool(form_data.get("attachments"))
            )
            message, session = coerce_message_and_session(
                body, message, session, session_manager, allow_empty=_has_atts,
            )
            # Verify ownership AFTER coerce (which may resolve a default session)
            # but BEFORE loading. Prevents cross-user session hijack.
            _verify_session_owner(request, session)
        except SessionNotFoundError as e:
            return _sse_error_response(str(e), status=404)
        except (ValueError, ValidationError):
            return _sse_error_response("Invalid request parameters")

        # F4 (lost-append race): hold the per-session lock across the WHOLE load→mutate→persist
        # critical section (get_session → build_chat_context, which appends + persists the user
        # message). Without it a concurrent reconcile/poll get_session can REPLACE
        # self.sessions[session] mid-request and orphan the in-flight history.append (the user bubble
        # that "vanishes"). One async loop, one lock per session id — independent sessions never
        # contend; the section has no blocking sync I/O long enough to matter, and every exit path
        # (return / raise) releases via the context manager. Mirrors the engine's per-user enqueue.
        async with session_manager.session_lock(session):
            try:
                sess = session_manager.get_session(session)
            except KeyError:
                return _sse_error_response(f"Session '{session}' not found", status=404)
            owner = get_current_user(request)
            # The model/endpoint guards below decide whether this turn can reach an
            # LLM at all. They MUST surface to the player as a streamed error, never a
            # bare HTTP 4xx: a streaming client renders `event: error` chunks but a
            # plain non-200 is the brittle branch that can read as "the message went
            # into nothing" (no reason shown, and the optimistic user bubble has no
            # server record to reconcile against). So they return through the SSE-error
            # path — HTTP 200 + a single streamed error — exactly like an upstream
            # model failure mid-stream. (The dead-endpoint case already works this way.)
            if _clear_orphaned_session_endpoint(sess, owner=owner):
                return _sse_error_response(
                    "Selected model endpoint was removed. Pick another model in Settings.")
            # Issue #587: picker shows a model from the endpoint cache but
            # s.model never made it onto the DB row (first-send race after
            # endpoint setup, or a previous endpoint delete/recreate). Pull
            # the first cached model off the matching endpoint so the
            # upstream isn't called with model="" (which surfaces as a
            # generic 401/503).
            _recover_empty_session_model(sess, session, owner=owner)
            if not getattr(sess, "model", "").strip():
                return _sse_error_response(
                    "No model selected for this chat. Open the model picker and "
                    "choose one before sending.")

            # ------------------------------------------------------------------ #
            # Privilege gates that must fire BEFORE any LLM work / token spend.
            #   1. allowed_models — reject if session.model isn't in the user's
            #      configured allowlist (empty list = "no restriction").
            #   2. max_messages_per_day — count user-role ChatMessage rows owned
            #      by this user in the last UTC day; 429 if at/over the cap.
            # Admins always have full privileges via get_privileges (returns
            # ADMIN_PRIVILEGES wholesale) so this is a no-op for them.
            _enforce_chat_privileges(request, sess)

            # Ensure session has auth headers
            resolve_session_auth(sess, session, owner=get_current_user(request))

            # Check for research_pending BEFORE mode persist overwrites it
            do_research = str(use_research).lower() == "true"
            if not do_research:
                if get_session_mode(session) == 'research_pending':
                    do_research = True
                    logger.info(f"Session {session} in research_pending — auto-triggering research")

            att_ids = []
            if body and isinstance(body.get("attachments"), list):
                att_ids = [str(x) for x in body["attachments"]]
            elif attachments:
                try:
                    att_ids = [str(x) for x in json.loads(attachments)]
                except Exception:
                    pass

            no_memory = str(form_data.get("no_memory", "")).lower() == "true"
            pre_context_tool_policy = build_effective_tool_policy(
                last_user_message=message,
            )
            allow_tool_preprocessing = not pre_context_tool_policy.block_all_tool_calls

            # Build shared context (stream path uses enhanced_message for context preface)
            ctx = await build_chat_context(
                sess, request, chat_handler, chat_processor,
                message=message,
                session_id=session,
                preset_id=preset_id,
                att_ids=att_ids,
                use_web=use_web,
                use_rag=use_rag,
                time_filter=time_filter,
                incognito=incognito,
                no_memory=no_memory,
                search_context=search_context,
                compare_mode=compare_mode,
                webhook_manager=webhook_manager,
                use_enhanced_message=True,
                # Skills index only ships when the model can actually call
                # manage_skills (agent mode). In plain chat or incognito the
                # index would be useless / unwanted noise.
                agent_mode=(chat_mode == "agent"),
                allow_tool_preprocessing=allow_tool_preprocessing,
                client_msg_id=client_msg_id,  # ADR 0008: round-trip the optimistic temp id
            )

            # F2 (lost-model fix): build_chat_context resolved `canonical_session` (the framed
            # game/casting run key). If the turn executes/persists against a canonical id that differs
            # from the per-tab `session` this window POSTed under, mirror the just-recovered model onto
            # the canonical row so the model is bound on the SAME identity the turn runs against —
            # otherwise the canonical row stays empty and recovery re-fires every turn (the "Recovered
            # empty session model" loop).
            if getattr(ctx, "framed", False):
                _mirror_model_to_canonical_session(
                    session_manager, sess, session, getattr(ctx, "canonical_session", None),
                )

        # DB6: reap stale 0-message, no-model casting-shell sessions (owner-scoped, never the
        # canonical game session). Outside the per-session lock — it only touches OTHER, idle
        # sessions, never the one this turn holds. Best-effort; never blocks the turn.
        try:
            _reap_orphaned_shell_sessions(session_manager, owner)
        except Exception:
            logger.debug("orphan-shell reap pass skipped", exc_info=True)

        # The game IS the main chat: when the Orwell engine is reachable, always run
        # the agent loop so the model can call createCharacter (OOBE), getGameState,
        # and the full weekly-loop surface (advanceGame/submitDecision) instead of
        # falling back to bash/curl exploration. This covers both pre-game OOBE and
        # in-progress play. The game tools are pinned (see pinned_tools below); the
        # auto_escalated withhold below is escalation-reason-aware (A1): on THIS path
        # it must not re-disable tools the admin explicitly opted in.
        # (A later privilege gate still downgrades users who can't use agent mode.)
        game_escalated = False
        if chat_mode == "chat" and (ctx.engine_available or ctx.game_active):
            chat_mode = "agent"
            auto_escalated = True
            game_escalated = True
            logger.info(
                "chat→agent auto-escalation: engine_available=%s game_active=%s",
                ctx.engine_available, ctx.game_active,
            )

        _research_flags = {"do": do_research}  # Mutable container for generator scope

        # Query active document — prefer explicit ID from frontend, fall back to session lookup
        active_doc = None
        _doc_db = SessionLocal()
        try:
            if active_doc_id:
                logger.info(f"[doc-inject] active_doc_id from frontend: {active_doc_id}")
                # Scope to the caller's documents. The session and in-memory
                # fallbacks below are already owner/session-bound; this
                # explicit-id path looked up by id alone, so a user could
                # inject another user's document by passing its id.
                _doc_q = _doc_db.query(DBDocument).filter(DBDocument.id == active_doc_id)
                active_doc = _owner_session_filter(_doc_q, ctx.user).first()
                if active_doc:
                    doc_session = active_doc.session_id
                    doc_owner = getattr(active_doc, "owner", None)
                    if doc_owner and ctx.user and doc_owner != ctx.user:
                        logger.warning(
                            "[doc-inject] ignoring active_doc_id %s owned by another user",
                            active_doc_id,
                        )
                        active_doc = None
                    elif doc_session and doc_session != session:
                        logger.warning(
                            "[doc-inject] ignoring stale active_doc_id %s from session %s while in session %s",
                            active_doc_id,
                            doc_session,
                            session,
                        )
                        active_doc = None
                    else:
                        logger.info(f"[doc-inject] found by ID: title={active_doc.title!r}, lang={active_doc.language!r}, is_active={active_doc.is_active}, content_len={len(active_doc.current_content or '')}")
                else:
                    logger.warning(f"[doc-inject] NOT FOUND by ID {active_doc_id}")
            if not active_doc:
                _session_doc_q = _doc_db.query(DBDocument).filter(
                    DBDocument.session_id == session,
                    DBDocument.is_active == True
                )
                active_doc = _owner_session_filter(_session_doc_q, ctx.user).order_by(DBDocument.updated_at.desc()).first()
                if active_doc:
                    logger.info(f"[doc-inject] found by session fallback: title={active_doc.title!r}")
            # Last resort: the document the agent itself just created/edited
            # (tracked in-memory by the tool layer). This rescues docs that
            # got orphaned from their session (session_id NULL) — otherwise
            # neither lookup above can associate them with this conversation,
            # so the agent never sees what it just wrote. Guarded so we never
            # leak a doc that belongs to a DIFFERENT session.
            if not active_doc:
                try:
                    from src.tool_implementations import get_active_document
                    _mem_id = get_active_document()
                    if _mem_id:
                        _mem_q = _doc_db.query(DBDocument).filter(DBDocument.id == _mem_id)
                        cand = _owner_session_filter(_mem_q, ctx.user).first()
                        if cand and (not cand.session_id or cand.session_id == session):
                            active_doc = cand
                            logger.info(f"[doc-inject] found by in-memory active id: title={active_doc.title!r} (session_id={cand.session_id!r})")
                except Exception as _e:
                    logger.debug(f"[doc-inject] in-memory fallback failed: {_e}")
            if not active_doc:
                logger.info(f"[doc-inject] no active doc for session {session}")
            if active_doc:
                _doc_db.expunge(active_doc)
        except Exception as e:
            logger.warning(f"Failed to query active document: {e}")
        finally:
            _doc_db.close()

        # Build disabled-tools set from frontend toggles + user privileges
        disabled_tools = set()
        if str(allow_bash).lower() != "true":
            disabled_tools.add("bash")
        if str(allow_web_search).lower() != "true":
            disabled_tools.add("web_search")
            disabled_tools.add("web_fetch")

        # Nobody/incognito mode: deny tools that would expose the user's
        # persistent memory, past chats, or other identity-linked data.
        if incognito:
            disabled_tools.update({
                "manage_memory",      # persistent memory store
                "search_chats",       # past chat history
                "manage_skills",      # skill presets tied to user
            })

        # Enforce per-user privileges
        _privs = {}
        _user = ctx.user
        if _user and hasattr(request.app.state, 'auth_manager') and request.app.state.auth_manager:
            _privs = request.app.state.auth_manager.get_privileges(_user)
        if _privs:
            if not _privs.get("can_use_bash", True):
                disabled_tools.update({"bash", "python", "read_file", "write_file"})
            if not _privs.get("can_use_browser", True):
                disabled_tools.add("builtin_browser")
            if not _privs.get("can_use_documents", True):
                disabled_tools.update({"create_document", "edit_document", "update_document", "suggest_document"})
            if not _privs.get("can_generate_images", True):
                disabled_tools.add("generate_image")
            if not _privs.get("can_manage_memory", True):
                disabled_tools.update({"manage_memory", "manage_skills"})
            if not _privs.get("can_use_research", True):
                _research_flags["do"] = False
            if not _privs.get("can_use_agent", True):
                if ctx.game_active:
                    # F3/C14: a game turn must ACT (record/advance via the engine) or it
                    # silently becomes consequence-free narration. Game tools are the game,
                    # not a privilege surface — keep the agent path, collapse the tool set
                    # to the game keep-set only.
                    from src.agent_tools import game_build_disabled_additions
                    disabled_tools.update(game_build_disabled_additions([]))
                else:
                    _effective_mode = 'chat'
                    chat_mode = 'chat'
        # Global admin disabled tools
        from src.settings import get_setting
        _global_disabled = get_setting("disabled_tools", [])
        if _global_disabled and isinstance(_global_disabled, list):
            disabled_tools.update(_global_disabled)

        # Game build (feature 0032): collapse the agent's tool surface to the
        # game keep-set + opted-in optional tools. Single chokepoint feeding the
        # agent loop, so the model never receives a dropped/dead-vertical schema.
        from src.settings import game_build_enabled
        if game_build_enabled():
            from src.agent_tools import game_build_disabled_additions
            disabled_tools.update(
                game_build_disabled_additions(get_setting("game_tools_enabled", []))
            )

        # Light auto-escalation: the user is in chat mode and the turn was promoted to
        # agent mode. The withhold is ESCALATION-REASON-AWARE (A1):
        #   • intent escalation (notes/calendar/email) withholds the heavy "do things on
        #     the computer" tools — the model must not shell out for a chat request;
        #   • the GAME escalation (the default player path) subtracts the admin's explicit
        #     opt-ins (Settings → Agent tools) — the game-build chokepoint above is the
        #     single source of truth for that turn class, and the old unconditional
        #     withhold silently defeated bash/python/read_file/write_file opt-ins on
        #     every chat-originated game turn. builtin_browser stays withheld always.
        if auto_escalated:
            disabled_tools.update(
                auto_escalation_withhold(game_escalated, get_setting("game_tools_enabled", []))
            )

        # Disable document tools in compare sessions — they break the pane UI
        if sess.name and sess.name.startswith("[CMP]"):
            disabled_tools.update({"create_document", "edit_document", "update_document"})

        # Compare mode: disable tools based on compare type
        if compare_mode:
            _compare_strip = {
                "create_document", "edit_document", "update_document",
                "chat_with_model", "create_session", "list_sessions",
                "send_to_session",
                "pipeline", "manage_session", "manage_memory", "list_models",
                "generate_image", "ui_control",
            }
            disabled_tools.update(_compare_strip)
            # In chat mode compare, disable ALL agent tools (no bash, python, file ops)
            if chat_mode == 'chat':
                disabled_tools.update({"bash", "python", "read_file", "write_file", "web_search", "web_fetch", "search_chats", "manage_tasks"})

        # Plan mode: investigate read-only, propose a plan, don't mutate. Block
        # every tool not on the read-only allowlist. (stream_agent_loop enforces
        # this again + drops MCP, so this is belt-and-suspenders.)
        if plan_mode:
            from src.tool_security import plan_mode_disabled_tools
            disabled_tools.update(plan_mode_disabled_tools())

        tool_policy = build_effective_tool_policy(
            disabled_tools=disabled_tools,
            last_user_message=message,
        )
        disabled_tools = tool_policy.all_disabled_names()
        research_blocked_by_policy = bool(
            tool_policy.blocks("trigger_research")
            or tool_policy.blocks("manage_research")
        )
        effective_do_research = bool(
            do_research and _research_flags["do"] and not research_blocked_by_policy
        )

        # Persist session mode after policy/privilege gates so blocked research
        # turns remain ordinary chat/agent streams and saved messages.
        _effective_mode = 'research' if effective_do_research else (chat_mode or 'chat')
        if _effective_mode in ('agent', 'research', 'chat'):
            set_session_mode(session, _effective_mode)

        async def stream_with_save() -> AsyncGenerator[str, None]:
            # _effective_mode is read-only here; closure captures it from
            # the outer scope. (Was `nonlocal` but never reassigned.)
            research_sources = None
            web_sources = ctx.web_sources

            # Register active stream for partial-save safety net
            _active_streams[session] = {"status": "streaming", "partial": "", "query": message, "is_research": effective_do_research, "mode": _effective_mode}

            # Early SSE keepalive (E): flush the connection — commit the 200 + a byte — BEFORE the
            # model's first token, which can be many seconds out on a cold/loaded provider. An
            # intermediary (reverse proxy, tunnel, uvicorn worker idle-recycle) otherwise reaps a
            # held-but-silent SSE connection, dropping the body with no terminal — exactly the
            # transport break the browser misreads as a recoverable error and "recovers" from by
            # puppeteering the composer. A `:`-prefixed comment is ignored by the client reader.
            # (Full robustness still wants a periodic heartbeat + raised proxy idle timeouts.)
            yield ": keepalive\n\n"

            # F-PY-5 (perf audit) — PROGRESS SIGNAL. The heavy pre-stream prep (engine framing +
            # any context compaction, in `build_chat_context`) has already run by the time this
            # producer starts; what remains before the first visible token is the model call, whose
            # first-token latency can be many seconds on a cold/loaded provider. Emit ONE lightweight
            # status frame the instant the producer opens so the client can render "the model is
            # thinking" and distinguish a working turn from a hung one (instead of a bare spinner).
            #
            # FRAME SHAPE (for the FE-JS lane consuming these): a normal `data:` SSE line whose JSON
            # payload is `{"type": "status", "stage": "<stage>"}`. Stages, coarsest→finest:
            #   "preparing"  — request accepted, pre-stream prep beginning (reserved; see note below)
            #   "framing"    — engine framing / context assembly in flight (reserved)
            #   "compacting" — a blocking context compaction is running (reserved)
            #   "thinking"   — prep done, the model call is being made (emitted here)
            # It carries NO reply text and is NOT persisted; it is a transient UI cue. Unknown-`type`
            # frames are ignored by the current client, so this is purely additive and forward-
            # compatible — the FE lane may light a "thinking…" affordance off `stage`.
            #
            # NOTE (deliberate scope): the "preparing"/"framing"/"compacting" stages are documented
            # for the FE vocabulary but NOT emitted server-side here, because this producer only
            # starts AFTER `build_chat_context` (the framing/compaction prep) has completed — the
            # detached-run/run-keying architecture (ADR 0012) resolves the canonical session from the
            # framing result BEFORE the producer is drained, so relocating that prep into the producer
            # (to stream those earlier stages) is out of scope for this change. The real pre-producer
            # wait is instead SHRUNK by the sibling perf fixes: tightened framing-read timeouts
            # (F-PY-4), off-loaded/cached model-context probes (F-PY-3), and non-blocking compaction
            # (F-PY-2). See the commit message for the deferral rationale.
            yield f"data: {json.dumps({'type': 'status', 'stage': 'thinking'})}\n\n"

            if ctx.preprocessed.attachment_meta:
                yield f"data: {json.dumps({'type': 'attachments', 'data': ctx.preprocessed.attachment_meta})}\n\n"

            # Announce any docs auto-created during preprocess (e.g. fillable
            # PDF → editable markdown) so the editor pane switches to them
            # before the model starts streaming.
            for _opened in ctx.auto_opened_docs:
                yield (
                    f'data: {json.dumps({"type": "doc_update", **_opened})}\n\n'
                )

            if ctx.rag_sources:
                yield f"data: {json.dumps({'type': 'rag_sources', 'data': ctx.rag_sources})}\n\n"

            if web_sources:
                yield f"data: {json.dumps({'type': 'web_sources', 'data': web_sources})}\n\n"

            # Emit which memories were injected into context (captured before stream)
            if ctx.used_memories:
                yield f"data: {json.dumps({'type': 'memories_used', 'data': ctx.used_memories})}\n\n"

            # Run research as a background task (survives page refresh)
            if effective_do_research:
                _r_ep, _r_model, _r_headers = _resolve_research_endpoint(sess)
                _auth_keys = list(_r_headers.keys()) if _r_headers else []
                logger.info(f"Research endpoint resolved: model={_r_model}, endpoint={_r_ep}, auth_keys={_auth_keys}, sess_headers_keys={list(sess.headers.keys()) if isinstance(sess.headers, dict) else type(sess.headers)}")

                # Clarification round: only for very short/vague queries on first research message.
                # Skip in compare mode — each pane is a fresh session, so every one would
                # ask clarifying questions and the user would have to answer each pane
                # separately, breaking the parallel comparison.
                _prior_json = research_handler._get_session_json(session)
                _history_len = len(sess.history) if hasattr(sess, 'history') else 0
                _is_first_research = not _prior_json and _history_len <= 2 and not compare_mode

                if _is_first_research:
                    logger.info(f"First research message — asking clarifying questions for: {message[:60]}")
                    yield f'data: {json.dumps({"type": "model_info", "model": sess.model, "suffix": "Research"})}\n\n'
                    # Set DB mode to research_pending so the NEXT message auto-triggers research
                    set_session_mode(session, "research_pending")
                    ctx.messages.insert(0, {"role": "system", "content":
                        "The user wants to start deep web research. Before searching, ask 2-3 brief "
                        "clarifying questions to understand exactly what they want to know. For example: "
                        "what aspects matter most, are they comparing to something, what's their context "
                        "(moving, traveling, curiosity). Be conversational. Keep it short."
                    })
                    _skip_research = True
                else:
                    _skip_research = False

                if not _skip_research:
                    # Phase 2: Start actual research
                    def _on_research_done(_sid, _result, _sources, _findings):
                        """Persist research to DB when background task finishes."""
                        if incognito:
                            return
                        try:
                            _s = session_manager.get_session(_sid)
                            if not _s:
                                logger.warning(f"Session {_sid} expired before research completed")
                                return
                            _md = {"research": True, "model": _s.model}
                            if _sources:
                                _md["research_sources"] = _sources
                            if _findings:
                                _md["research_findings"] = _findings
                            _clean_res, _md = clean_thinking_for_save(_result, _md)
                            _s.add_message(ChatMessage("assistant", _clean_res, metadata=_md))
                            session_manager.save_sessions()
                            logger.info(f"Research result persisted to DB for session {_sid}")
                        except Exception as _e:
                            logger.error(f"Failed to persist research to DB: {_e}")

                    # Check for prior research to continue from
                    _prior_report = ""
                    _prior_findings = None
                    _prior_urls = None
                    _prior_json = research_handler._get_session_json(session)
                    if _prior_json:
                        _prior_report = _prior_json.get("raw_report", "")
                        _prior_findings = _prior_json.get("raw_findings")
                        _src_urls = {s.get("url", "") for s in (_prior_json.get("sources") or []) if s.get("url")}
                        _prior_urls = _src_urls if _src_urls else None
                        if _prior_report:
                            logger.info(f"Continuing research for session {session} with {len(_src_urls)} prior URLs")

                    # Synthesize conversation into a focused research query
                    _research_query = await research_handler.synthesize_query(
                        sess, message, _r_ep, _r_model, _r_headers,
                    )
                    logger.info(f"Research query: {_research_query[:120]}")

                    research_handler.start_research(
                        session, _research_query, _r_ep, _r_model,
                        llm_headers=_r_headers,
                        prior_report=_prior_report,
                        prior_findings=_prior_findings,
                        prior_urls=_prior_urls,
                        on_complete=_on_research_done,
                        owner=_user,
                    )

                    _heartbeat_counter = 0
                    _last_progress = {}
                    _sent_avg = False
                    while True:
                        status = research_handler.get_status(session)
                        if not status or status["status"] != "running":
                            break
                        progress = status.get("progress", {})
                        if progress and progress != _last_progress:
                            _last_progress = progress
                            if not _sent_avg:
                                _sent_avg = True
                                progress = dict(progress)
                                progress["started_at"] = status.get("started_at")
                                avg = status.get("avg_duration")
                                if avg:
                                    progress["avg_duration"] = avg
                            yield f"data: {json.dumps({'type': 'research_progress', 'data': progress})}\n\n"
                            _heartbeat_counter = 0
                        else:
                            _heartbeat_counter += 1
                            yield f": heartbeat {_heartbeat_counter}\n\n"
                        await asyncio.sleep(1.0)

                    research_sources = research_handler.get_sources(session)
                    if research_sources:
                        yield f"data: {json.dumps({'type': 'research_sources', 'data': research_sources})}\n\n"

                    research_findings = research_handler.get_raw_findings(session)
                    if research_findings:
                        yield f"data: {json.dumps({'type': 'research_findings', 'data': research_findings})}\n\n"

                    # Signal frontend to fetch and render the research result
                    yield f"data: {json.dumps({'type': 'research_done', 'data': {'session_id': session}})}\n\n"
                    yield "data: [DONE]\n\n"
                    research_handler.clear_result(session)
                    _stream_set(session, status="done")
                    _active_streams.pop(session, None)
                    return

            messages = ctx.messages

            # Auto-compact notification
            if ctx.was_compacted:
                yield f"data: {json.dumps({'type': 'compacted', 'context_length': ctx.context_length})}\n\n"

            full_response = ""
            # Reasoning ("thinking:true") deltas are kept OUT of the public reply but must
            # still be PERSISTED so the collapsed "Thinking" accordion survives a reload and
            # renders the same in a second browser session. Accumulated separately here and
            # threaded into save_assistant_response / clean_thinking_for_save below; without
            # this, clean-channel reasoning is shown live but lost on reload (cross-session desync).
            full_reasoning = ""
            last_metrics = None
            _owed_anns: list = []  # chyron persistence: owed announcements seen on the stream, stored with the turn even if it is cut short

            # Configured fallback chain for the default chat model. Tried in
            # order if the session's primary model fails before producing
            # output. Resolved once per request.
            try:
                from src.endpoint_resolver import resolve_chat_fallback_candidates
                _fallback_candidates = resolve_chat_fallback_candidates(owner=_user)
            except Exception:
                _fallback_candidates = []

            # Send model name early so the frontend can show it during streaming
            _model_suffix = "Research" if effective_do_research else None
            _model_info = {"type": "model_info", "model": sess.model}
            if _model_suffix:
                _model_info["suffix"] = _model_suffix
            if ctx.preset.character_name:
                _model_info["character_name"] = ctx.preset.character_name
            yield f'data: {json.dumps(_model_info)}\n\n'

            if _is_image_generation_session(sess, owner=_user):
                from src.settings import get_setting
                if tool_policy.blocks("generate_image"):
                    _blocked_msg = tool_policy.reason_for("generate_image")
                    yield f'data: {json.dumps({"delta": _blocked_msg})}\n\n'
                    yield "data: [DONE]\n\n"
                    _active_streams.pop(session, None)
                    return
                if not get_setting("image_gen_enabled", True):
                    yield f'data: {json.dumps({"delta": "Image generation is disabled by the administrator."})}\n\n'
                    yield "data: [DONE]\n\n"
                    _active_streams.pop(session, None)
                    return
                from src.ai_interaction import do_generate_image
                _user_msg = message or ""
                yield f'data: {json.dumps({"type": "tool_start", "tool": "generate_image", "command": _user_msg[:100]})}\n\n'
                yield ": heartbeat\n\n"
                _img_result = await do_generate_image(f"{_user_msg}\n{sess.model}", session, owner=_user)
                _img_output = _img_result.get("results", _img_result.get("error", ""))
                _img_tool_data = {"type": "tool_output", "tool": "generate_image", "command": _user_msg[:100], "output": _img_output, "exit_code": 0 if "error" not in _img_result else 1}
                for _k in ("image_url", "image_id", "image_prompt", "image_model", "image_size", "image_quality"):
                    if _k in _img_result:
                        _img_tool_data[_k] = _img_result[_k]
                yield f'data: {json.dumps(_img_tool_data)}\n\n'
                _desc = _img_result.get("results", _img_result.get("error", "Image generation complete"))
                full_response = _desc
                yield f'data: {json.dumps({"delta": _desc})}\n\n'
                # Save to session history
                if not incognito:
                    _ev = {"round": 1, "tool": "generate_image", "command": _user_msg[:100], "output": _img_output, "exit_code": 0 if "error" not in _img_result else 1}
                    for _ek in ("image_url", "image_id", "image_prompt", "image_model", "image_size", "image_quality"):
                        if _img_result.get(_ek):
                            _ev[_ek] = _img_result[_ek]
                    sess.add_message(ChatMessage("assistant", full_response, metadata={"tool_events": [_ev], "model": sess.model}))
                    session_manager.save_sessions()
                yield f'data: {json.dumps({"type": "metrics", "data": {"total_time": 0}})}\n\n'
                yield "data: [DONE]\n\n"
                _active_streams.pop(session, None)
                return
            elif chat_mode == "chat":
                _chat_start = time.time()
                _answered_by = None  # set if the selected model failed and a fallback answered
                _requested_model = sess.model
                _actual_model = None
                # ADR 0010 #4: the stream's terminal finish_reason. "length" ⇒ the reply was cut off by
                # the output token cap — emit a `truncated` event at [DONE] so the chat-mode UI offers a
                # Continue affordance (the agent-mode path already does this; chat mode bypasses the agent
                # loop, so it must surface the same signal itself). The chat.js handler is mode-agnostic.
                _chat_finish_reason = None
                # ── Chat mode: call stream_llm directly, NO tools, NO document access ──
                try:
                    _chat_candidates = [(sess.endpoint_url, sess.model, resolve_session_headers(sess))] + _fallback_candidates
                    async for chunk in stream_llm_with_fallback(
                        _chat_candidates,
                        messages,
                        temperature=ctx.preset.temperature,
                        # Respect the preset; 0/unset = let the server decide (no
                        # cap), matching agent mode. The old hard 4096 fallback
                        # truncated reasoning models mid-<think> — they'd burn the
                        # whole budget thinking and never emit the answer (seen in
                        # Compare on heavy generation prompts).
                        max_tokens=ctx.preset.max_tokens,
                        prompt_type=preset_id,
                        tools=None,
                    ):
                        if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                            try:
                                data = json.loads(chunk[6:])
                                if "delta" in data:
                                    # Reasoning tokens arrive flagged thinking:true.
                                    # Forward them so the client can show a thinking
                                    # indicator, and accumulate them separately so they
                                    # PERSIST into metadata.thinking (kept out of the reply).
                                    if data.get("thinking"):
                                        full_reasoning += data["delta"]
                                    else:
                                        full_response += data["delta"]
                                        _stream_set(session, partial=full_response)
                                    yield chunk
                                elif data.get("type") == "fallback":
                                    # Selected model failed; a fallback answered.
                                    # Forward the notice and remember the real model.
                                    _answered_by = data.get("answered_by") or _answered_by
                                    _actual_model = _actual_model or _answered_by
                                    data["selected_model"] = data.get("selected_model") or _requested_model
                                    yield chunk
                                elif data.get("type") == "model_actual":
                                    _actual_model = data.get("model") or _actual_model
                                    data["requested_model"] = _requested_model
                                    yield f'data: {json.dumps(data)}\n\n'
                                elif data.get("type") == "usage":
                                    last_metrics = data.get("data", {})
                                    _reported_model = last_metrics.get("model")
                                    last_metrics["requested_model"] = _requested_model
                                    last_metrics["model"] = _reported_model or _actual_model or _answered_by or _requested_model
                                    if ctx.context_length and last_metrics.get("input_tokens"):
                                        pct = min(round((last_metrics["input_tokens"] / ctx.context_length) * 100, 1), 100.0)
                                        last_metrics["context_percent"] = pct
                                        last_metrics["context_length"] = ctx.context_length
                                    # The frontend reads `tokens_per_second`; the raw usage event
                                    # carries the backend's true gen speed as `gen_tps` (llama.cpp
                                    # timings). Map it through so this direct-chat path shows real
                                    # t/s instead of "n/a" → falling back to a bare token count.
                                    if last_metrics.get("gen_tps") and not last_metrics.get("tokens_per_second"):
                                        last_metrics["tokens_per_second"] = last_metrics["gen_tps"]
                                        last_metrics["tps_source"] = "backend"
                                    # Wall-clock response time for the stats popup ("Time").
                                    last_metrics.setdefault("response_time", round(time.time() - _chat_start, 2))
                                    yield f'data: {json.dumps({"type": "metrics", "data": last_metrics})}\n\n'
                                elif data.get("type") == "finish":
                                    # ADR 0010 #4: remember the terminal finish_reason (from stream_llm),
                                    # consumed at [DONE] below. Not forwarded — the UI signal is the
                                    # `truncated` event, mirroring the agent-loop path.
                                    _chat_finish_reason = data.get("reason")
                            except json.JSONDecodeError:
                                yield chunk
                        elif chunk.startswith("event: error"):
                            logger.warning(f"Stream error for {sess.model} on {sess.endpoint_url}: {chunk!r}")
                            yield chunk
                        elif chunk.startswith("event: "):
                            yield chunk
                        elif chunk == "data: [DONE]\n\n":
                            # Generate fallback metrics if LLM didn't send usage
                            if not last_metrics and full_response:
                                _elapsed = time.time() - _chat_start
                                _est_in = estimate_tokens(messages)
                                _est_out = len(full_response) // 4
                                _tps = round(_est_out / _elapsed, 2) if _elapsed > 0 else 0
                                _ctx_pct = min(round((_est_in / ctx.context_length) * 100, 1), 100.0) if ctx.context_length else 0
                                last_metrics = {
                                    "response_time": round(_elapsed, 2),
                                    "input_tokens": _est_in,
                                    "output_tokens": _est_out,
                                    "tokens_per_second": _tps,
                                    "context_percent": _ctx_pct,
                                    "context_length": ctx.context_length,
                                    "model": _actual_model or _answered_by or _requested_model,
                                    "requested_model": _requested_model,
                                    "usage_source": "estimated",
                                }
                                yield f'data: {json.dumps({"type": "metrics", "data": last_metrics})}\n\n'
                            if full_response:
                                # M2-6: the beat's IN-WORLD moment (from this turn's framing state)
                                # stamps the transcript timestamp; None pre-game (casting) ⇒ neutral.
                                _game_moment = current_game_moment(ctx.user) if ctx.game_active else None
                                _saved_id = save_assistant_response(
                                    sess, session_manager, session, full_response, last_metrics,
                                    character_name=ctx.preset.character_name,
                                    web_sources=web_sources,
                                    rag_sources=ctx.rag_sources,
                                    research_sources=research_sources,
                                    used_memories=ctx.used_memories,
                                    do_research=effective_do_research,
                                    incognito=incognito,
                                    reasoning=full_reasoning,
                                    # Vault Wall (casting-leak fix): an OOC pre-game casting
                                    # reply is stamped so the in-game narrator never receives it.
                                    phase=("casting" if (ctx.framed and not ctx.game_active) else None),
                                    game_moment=_game_moment,
                                    # ORW-230: a game turn's think blocks never become the reply
                                    # (the token cap inside a think saves the reasoning as thinking).
                                    game=bool(ctx.framed),
                                )
                                if _saved_id:
                                    # ADR 0012 §2.2/§3.3: carry the SERVER-MINTED message timestamp so
                                    # every window renders the identical time string (the sender no
                                    # longer keeps its own `new Date()`). Read off the just-persisted
                                    # message's metadata; absent ⇒ the client falls back to "now".
                                    # M2-6: `moment` rides along so the LIVE bubble (and mirror windows)
                                    # show the in-world stamp immediately, matching the reload render.
                                    yield f'data: {json.dumps({"type": "message_saved", "id": _saved_id, "ts": _last_message_ts(sess), "moment": _game_moment})}\n\n'
                                run_post_response_tasks(
                                    sess, session_manager, session, message, full_response,
                                    last_metrics, ctx.uprefs, memory_manager, memory_vector, webhook_manager,
                                    incognito=incognito, compare_mode=compare_mode,
                                    character_name=ctx.preset.character_name,
                                    owner=_user,
                                    allow_background_extraction=not tool_policy.block_all_tool_calls,
                                )
                            # ADR 0010 #4: the reply was cut off by the output token cap — surface a
                            # `truncated` event so chat mode shows the same Continue affordance agent mode
                            # already does. Suppressed in Compare (the grid has no single bubble to merge
                            # into) and when there's nothing to continue.
                            if _chat_finish_reason == "length" and full_response and not compare_mode:
                                yield f'data: {json.dumps({"type": "truncated"})}\n\n'
                            _stream_set(session, status="done")
                            yield chunk
                except (asyncio.CancelledError, GeneratorExit):
                    if full_response:
                        logger.info("Client disconnected mid-stream (chat mode) for session %s, saving partial (%d chars)", session, len(full_response))
                        # M2-6: a partial beat is still an in-game beat — stamp the in-world moment so a
                        # disconnect/stopped save reloads with the game moment, not the wall clock (the
                        # exact bug M2-6 removes). Same source + casting gate as the [DONE] save above.
                        # ORW-230: a game turn cut off inside an open <think> saves its reasoning to
                        # metadata.thinking, never as the reply (the one shared disconnect save).
                        _stopped_moment = current_game_moment(ctx.user) if ctx.game_active else None
                        save_stopped_partial(
                            sess, session_manager, full_response,
                            {
                                "stopped": True,
                                "model": _actual_model or _answered_by or _requested_model,
                                "requested_model": _requested_model,
                            },
                            reasoning=full_reasoning,
                            game=bool(ctx.framed),
                            game_moment=_stopped_moment,
                            incognito=incognito,
                        )
                    raise
                finally:
                    _active_streams.pop(session, None)
            else:
                # ── Agent mode: full agent loop with tools ──
                _agent_rounds = 0
                _agent_tool_calls = 0
                _agent_tools_called: List[str] = []  # E22: which tools actually ran this turn
                # 0064 §B/D / F5: snapshot the user's last-seen engine beatSeq BEFORE the turn so the
                # end-of-turn HUD-parity push can tell a committed mutation from a no-op/OOC turn.
                _beat_seq_before = last_beat_seq(ctx.user)
                _answered_by = None  # set if the selected model failed and a fallback answered
                _requested_model = sess.model
                _actual_model = None
                try:
                    from src.settings import get_setting
                    from src.agent_tools import MAX_AGENT_ROUNDS as _DEFAULT_ROUNDS
                    _tool_budget = int(get_setting("agent_max_tool_calls", 0))
                    # Per-message round cap from settings; clamp defensively in
                    # case settings.json was hand-edited to a bad value.
                    try:
                        _max_rounds = int(get_setting("agent_max_rounds", _DEFAULT_ROUNDS) or _DEFAULT_ROUNDS)
                    except (TypeError, ValueError):
                        _max_rounds = _DEFAULT_ROUNDS
                    _max_rounds = max(1, min(_max_rounds, 200))

                    _upstream_dropped = False  # A57c: set when the model connection dropped mid-reply (error_type stream_dropped) - the partial must never be saved as a complete turn
                    async for chunk in stream_agent_loop(
                        sess.endpoint_url,
                        sess.model,
                        messages,
                        headers=resolve_session_headers(sess),
                        temperature=ctx.preset.temperature,
                        max_tokens=ctx.preset.max_tokens,
                        prompt_type=preset_id,
                        max_tool_calls=_tool_budget,
                        max_rounds=_max_rounds,
                        context_length=ctx.context_length,
                        active_document=active_doc,
                        session_id=session,
                        disabled_tools=disabled_tools if disabled_tools else None,
                        tool_policy=tool_policy,
                        owner=_user,
                        pinned_tools=(ORWELL_GAME_TOOLS if ctx.engine_available else None),
                        # P3: substitution keys on FRAMED, not game_active — a pre-game
                        # casting turn gets the minimal casting tool contract instead of
                        # stacking the producer persona on the generic assistant rulebook.
                        game_mode=(
                            "game" if ctx.game_active
                            else ("casting" if (ctx.framed and not ctx.feed_down) else False)
                        ),
                        fallbacks=_fallback_candidates,
                        workspace=workspace or None,
                        plan_mode=plan_mode,
                        approved_plan=approved_plan or None,
                    ):
                        if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                            try:
                                data = json.loads(chunk[6:])
                                if isinstance(data, dict) and "type" not in data and isinstance(data.get("announcements"), list):
                                    _owed_anns.extend(a for a in data["announcements"] if isinstance(a, dict))
                                if "delta" in data:
                                    # Reasoning tokens arrive flagged thinking:true.
                                    # Forward them for the live indicator, accumulate them
                                    # separately so they PERSIST into metadata.thinking
                                    # (kept out of the saved reply, same as chat mode).
                                    if data.get("thinking"):
                                        full_reasoning += data["delta"]
                                    else:
                                        full_response += data["delta"]
                                        _stream_set(session, partial=full_response)
                                    yield chunk
                                elif data.get("type") == "web_sources":
                                    web_sources = data.get("data", [])
                                    yield chunk
                                elif data.get("type") in (
                                    "tool_start", "tool_output", "agent_step",
                                    "doc_stream_open", "doc_stream_delta",
                                    "doc_update", "doc_suggestions", "ui_control",
                                    "rounds_exhausted",
                                    "ask_user",
                                    "plan_update",
                                ):
                                    if data.get("type") == "agent_step":
                                        _agent_rounds = max(_agent_rounds, data.get("round", 1))
                                        # ORW-153: each round's text arrives as its own deltas, so the
                                        # SAVED reply glued rounds together ("...make this official.
                                        # Everything's on file."). The live bubble shows rounds as separate
                                        # segments (#829) and then converges to this saved text, so the
                                        # break belongs here. A text-less (tool-only) round adds nothing.
                                        if full_response and not full_response.endswith(("\n", " ")):
                                            full_response += "\n\n"
                                            _stream_set(session, partial=full_response)
                                    elif data.get("type") == "tool_start":
                                        _agent_tool_calls += 1
                                        if data.get("tool"):
                                            _agent_tools_called.append(str(data["tool"]))
                                    elif (data.get("type") == "tool_output" and ctx.game_active
                                          and data.get("exit_code") == 0
                                          and str(data.get("tool") or "") in GAME_ENGINE_WRITE_TOOLS):
                                        # 0064 §B/D / ship-gate F5: a game-engine write just COMMITTED
                                        # mid-turn — push `game-updated` to peer windows NOW, not only at
                                        # the turn's end. A multi-round turn (a forced advance, then more
                                        # narration) used to leave peers stale for the whole remainder
                                        # (~10-20s) although the sender's own HUD refreshed at this very
                                        # tool result. Vault-free ping, fail-soft; the end-of-turn push stays.
                                        try:
                                            from src import orwell_game_session as _ogs_mid
                                            _ogs_mid.publish_game_updated(ctx.user)
                                        except Exception:
                                            pass
                                    yield chunk
                                elif "announcements" in data and "delta" not in data:
                                    # F-2/F-4 owed chyron: the agent loop emits `{"announcements":[…]}` for a beat the FE
                                    # pre-resolved. This chain had NO branch for it, so the event was silently dropped
                                    # here — before BOTH the SSE and WS legs (A-15 rehearsal 2026-11-03: 0 chyron events).
                                    yield chunk
                                elif data.get("type") == "fallback":
                                    # Selected model failed; a fallback answered.
                                    # Forward the notice and remember the real
                                    # model so metrics reflect it, not the masked
                                    # selected model.
                                    _answered_by = data.get("answered_by") or _answered_by
                                    _actual_model = _actual_model or _answered_by
                                    data["selected_model"] = data.get("selected_model") or _requested_model
                                    yield chunk
                                elif data.get("type") == "model_actual":
                                    _actual_model = data.get("model") or _actual_model
                                    data["requested_model"] = _requested_model
                                    yield f'data: {json.dumps(data)}\n\n'
                                elif data.get("type") == "metrics":
                                    last_metrics = data.get("data", {})
                                    _reported_model = last_metrics.get("model")
                                    last_metrics["requested_model"] = last_metrics.get("requested_model") or _requested_model
                                    last_metrics["model"] = _reported_model or _actual_model or _answered_by or _requested_model
                                    yield f'data: {json.dumps({"type": "metrics", "data": last_metrics})}\n\n'
                                elif data.get("type") == "realign_body":
                                    # S2a in-turn realignment (RC2 / #1664): the mid-stream guard missed
                                    # an ungrounded closed-set claim — EXCISE the phantom sentence(s) from
                                    # the accumulated (persisted) body, never just append a correction
                                    # after the fabrication, then append the deterministic engine-truth
                                    # beat. Closed-set only (ADR 0005 #1); creative prose untouched.
                                    # Fail-open. Note: the raw agent event carries only `beat` and is NOT
                                    # forwarded verbatim — the client gets the corrected `text` below.
                                    # strip_ungrounded_closed_set is FAIL-OPEN and returns
                                    # (cleaned, excised). Gate the append on `excised` — the beat is
                                    # NEVER appended to an unstripped body, so a transient strip failure
                                    # can't persist [fabrication]+[correction] (#1664 follow-up).
                                    _beat = (data.get("beat") or "").strip()
                                    try:
                                        from routes.chat_helpers import strip_ungrounded_closed_set
                                        _excised, _did_excise = await strip_ungrounded_closed_set(
                                            _user, full_response, _agent_tools_called)
                                    except Exception:
                                        _excised, _did_excise = full_response, False
                                    if _did_excise:
                                        _realigned = ((_excised.rstrip() + "\n\n" + _beat).strip()
                                                      if _beat else _excised.strip())
                                        if _realigned and _realigned != full_response:
                                            full_response = _realigned
                                            _stream_set(session, partial=full_response)
                                            yield f'data: {json.dumps({"type": "realign_body", "text": full_response})}\n\n'
                            except json.JSONDecodeError:
                                yield chunk
                        elif chunk.startswith("event: "):
                            if chunk.startswith("event: error") and '"stream_dropped"' in chunk:
                                _upstream_dropped = True
                            yield chunk
                        elif chunk == "data: [DONE]\n\n":
                            # E22: "narrated but never recorded" is enforced in CODE, not
                            # prompt wording — a completed game turn with non-trivial
                            # narration and zero engine writes gets a bounded fallback
                            # recordInteraction so the beat has consequence and memory.
                            if _upstream_dropped:
                                logger.warning("[orwell] upstream dropped mid-reply (stream_dropped): the partial narration is NOT saved as a complete turn and records no consequence fallback user=%s", ctx.user)
                                full_response = ""  # A57c: an interrupted turn leaves no saved narrator message (the client shows the interruption + retry)
                            if ctx.game_active and full_response:
                                # 0064 §B/D / ship-gate F5 (status/gadget half): when THIS turn already
                                # committed a mutation (a game-engine write tool ran, or the beatSeq
                                # advanced via the FE error-correction belts), push `game-updated` NOW
                                # so peer windows reconcile their HUD instantly instead of polling. The
                                # E22/0055 `recordInteraction` fallback fires fire-and-forget below and
                                # mutates AFTER this point, so chain a second push onto its task — only
                                # when it actually recorded (True). Both pushes are mutation-gated +
                                # fail-soft + Vault-free (the SENDER's own HUD already refreshed
                                # client-side; this is the PEER push the chat path was missing).
                                publish_game_updated_after_turn(
                                    ctx.user, _beat_seq_before, _agent_tools_called,
                                )

                                def _push_after_fallback(task, _u=ctx.user):
                                    try:
                                        if task.result():
                                            from src import orwell_game_session
                                            orwell_game_session.publish_game_updated(_u)
                                    except Exception:
                                        pass

                                _rec_task = asyncio.create_task(ensure_turn_recorded(
                                    ctx.user, message, full_response, _agent_tools_called,
                                    beat_seq_before=_beat_seq_before,
                                ))
                                # Retain a strong ref until the task finishes (weak-ref GC guard).
                                _BG_TASKS.add(_rec_task)
                                _rec_task.add_done_callback(_BG_TASKS.discard)
                                _rec_task.add_done_callback(_push_after_fallback)
                            if full_response:
                                # M2-6: the beat's IN-WORLD moment (from this turn's framing state)
                                # stamps the transcript timestamp; None pre-game (casting) ⇒ neutral.
                                _game_moment = current_game_moment(ctx.user) if ctx.game_active else None
                                if _owed_anns:
                                    last_metrics = {**(last_metrics or {}), "announcements": _owed_anns}
                                _saved_id = save_assistant_response(
                                    sess, session_manager, session, full_response, last_metrics,
                                    character_name=ctx.preset.character_name,
                                    web_sources=web_sources,
                                    rag_sources=ctx.rag_sources,
                                    used_memories=ctx.used_memories,
                                    incognito=incognito,
                                    reasoning=full_reasoning,
                                    # Vault Wall (casting-leak fix): an OOC pre-game casting
                                    # reply is stamped so the in-game narrator never receives it.
                                    phase=("casting" if (ctx.framed and not ctx.game_active) else None),
                                    game_moment=_game_moment,
                                    # ORW-230: a game turn's think blocks never become the reply
                                    # (the token cap inside a think saves the reasoning as thinking).
                                    game=bool(ctx.framed),
                                )
                                if _saved_id and ctx.game_active:
                                    # #1728 (B2, PR #1825 fix #2): the SAME row id `dataset.dbId`
                                    # (#1751) stamps client-side also anchors any fold THIS turn
                                    # staged (`_auto_record_scene` via `fold_ledger`) to its real,
                                    # now-persisted row — a no-op if nothing was staged this turn,
                                    # or if the tail already belongs to an older, re-queued turn.
                                    try:
                                        from src import fold_ledger as _fl
                                        _fl.attach_row_anchor(ctx.user, session, _saved_id)
                                    except Exception as _anchor_e:
                                        logger.warning(
                                            f"Fold-ledger row-anchor attach failed session={session}: "
                                            f"{_anchor_e}")
                                if _saved_id:
                                    # ADR 0012 §2.2/§3.3: server-minted timestamp (see the chat-mode
                                    # save above) so all windows render the identical time string.
                                    # M2-6: `moment` rides along for the live/mirror in-world stamp.
                                    yield f'data: {json.dumps({"type": "message_saved", "id": _saved_id, "ts": _last_message_ts(sess), "moment": _game_moment})}\n\n'
                                run_post_response_tasks(
                                    sess, session_manager, session, message, full_response,
                                    last_metrics, ctx.uprefs, memory_manager, memory_vector, webhook_manager,
                                    incognito=incognito, compare_mode=compare_mode,
                                    character_name=ctx.preset.character_name,
                                                            agent_rounds=_agent_rounds,
                                    agent_tool_calls=_agent_tool_calls,
                                    skills_manager=skills_manager,
                                    owner=_user,
                                    extract_skills=user_requested_agent,
                                    allow_background_extraction=not tool_policy.block_all_tool_calls,
                                )
                            _stream_set(session, status="done")
                            yield chunk
                except (asyncio.CancelledError, GeneratorExit):
                    # Client disconnected — save partial response. Wrap
                    # the save in its own try so an exception inside
                    # add_message / save_sessions doesn't mask the
                    # original CancelledError (which prevented the
                    # outer finally from running and left _active_streams
                    # with a stale entry).
                    try:
                        if full_response:
                            logger.info("Client disconnected mid-stream for session %s, saving partial response (%d chars)", session, len(full_response))
                            # M2-6: stamp the in-world moment on a partial/stopped beat too (same source +
                            # casting gate as the [DONE] save), so a disconnect reloads with the game
                            # moment instead of the wall clock. The cards the player was shown survive a
                            # cut-short turn. ORW-230: a game turn cut off inside an open <think> saves its
                            # reasoning to metadata.thinking, never as the reply (the one shared save).
                            _stopped_moment2 = current_game_moment(ctx.user) if ctx.game_active else None
                            save_stopped_partial(
                                sess, session_manager, full_response,
                                {
                                    "stopped": True,
                                    "model": _actual_model or _answered_by or _requested_model,
                                    "requested_model": _requested_model,
                                },
                                reasoning=full_reasoning,
                                game=bool(ctx.framed),
                                game_moment=_stopped_moment2,
                                announcements=_owed_anns,
                                incognito=incognito,
                            )
                    except Exception:
                        logger.exception("Failed to save partial response on disconnect (session %s)", session)
                    raise
                finally:
                    _active_streams.pop(session, None)

        async def _safe_stream() -> AsyncGenerator[str, None]:
            """Wrapper that guarantees _active_streams cleanup AND a typed terminal chunk.

            Every server-reachable failure — an exception out of the generator, or a normal exit
            that never emitted ``[DONE]`` (an empty / half-built stream) — is converted into a clean
            ``event: error`` + ``[DONE]`` on the wire, instead of the response body simply dropping.

            A body that ends with no ``[DONE]`` sentinel is exactly what the browser misreads as a
            recoverable network error (`reader.read()` throws) and then "recovers" from by
            puppeteering the composer with a "stream dropped" retry. Terminating the stream cleanly
            here removes that trigger at the source: the client's in-band error path renders it and
            never enters auto-recovery."""
            saw_done = False
            try:
                async for chunk in stream_with_save():
                    if chunk == "data: [DONE]\n\n":
                        saw_done = True
                    yield chunk
            except (asyncio.CancelledError, GeneratorExit):
                # A genuine client disconnect — the mode-specific excepts already saved the partial.
                # Don't synthesize a terminal: the client is gone, and the detached run lives on.
                raise
            except Exception as e:  # noqa: BLE001 — convert ANY generator failure into a surfaced error
                logger.exception("chat_stream generator failed (session %s)", session)
                if not saw_done:
                    yield (f'event: error\ndata: '
                           f'{json.dumps({"error": str(e) or "Stream failed.", "status": 500, "terminal": True})}\n\n')
                    yield "data: [DONE]\n\n"
                    saw_done = True
            finally:
                _active_streams.pop(session, None)
            if not saw_done:
                # The generator returned without ever emitting [DONE] (an empty/dropped upstream stream).
                # Close the body with a typed terminal so the client never sees a bare transport drop.
                yield (f'event: error\ndata: '
                       f'{json.dumps({"error": "The stream ended without a reply.", "status": 502, "terminal": True})}\n\n')
                yield "data: [DONE]\n\n"

        # _prepare_chat_stream ends here: hand the built producer + the turn metadata the tail needs
        # (session / ctx / compare_mode) back to the caller. The WS `turn` relay reuses `producer` only;
        # the HTTP route below runs the run-keying / casting / subscribe tail.
        return _PreparedChatTurn(_safe_stream, session, ctx, compare_mode,
                                 sess=sess, message=message, client_msg_id=client_msg_id)

    @router.post("/api/chat_stream")
    async def chat_stream(request: Request) -> StreamingResponse:
        # Thin HTTP wrapper over the shared `_prepare_chat_stream` pipeline (unchanged behavior): build
        # the producer, then run the ADR 0012 run-keying / casting single-flight / subscribe tail. An
        # early pre-stream guard returns an `_sse_error_response` (a StreamingResponse) — forward it as-is.
        prepared = await _prepare_chat_stream(request)
        if not isinstance(prepared, _PreparedChatTurn):
            return prepared
        _safe_stream = prepared.producer
        session = prepared.session
        ctx = prepared.ctx
        compare_mode = prepared.compare_mode

        # Compare panes are short-lived, single-shot generations whose sessions
        # exist only to drive that one pane — there's nothing to "resume" and
        # the user expects the pane's Stop button (which aborts the fetch,
        # closing this SSE) to promptly cancel the upstream LLM call. Detaching
        # them would keep burning upstream tokens/compute after the pane is
        # stopped or the comparison is abandoned, and would surface a stale
        # "still streaming" /resume target for a session nobody will revisit.
        #
        # So: stream them directly (no agent_runs wrapping). Starlette cancels
        # the underlying async generator (raising CancelledError/GeneratorExit
        # inside it) as soon as it notices the client disconnected — which the
        # mode-specific except blocks above already handle by saving the
        # partial response exactly once. This stops the upstream call promptly
        # without waiting on the next streamed chunk.
        #
        # Normal chat/agent streams keep the DETACHED behavior below: they
        # survive the client closing the tab / navigating away (true
        # terminal-agent semantics). The SSE response just subscribes (replay
        # buffered output + live); dropping the SSE only removes a subscriber —
        # the run keeps going and saves the assistant message on completion
        # regardless. Reconnect via /api/chat/resume.
        if compare_mode:
            return StreamingResponse(_safe_stream(), media_type="text/event-stream", headers=SSE_STREAM_HEADERS)

        # ADR 0012 §3.1 — key the detached run on the CANONICAL game session for a framed turn, NOT
        # the per-tab session id this window happened to POST under. Two windows on one game (the
        # split-brain the live two-window test caught: A=2 msgs, B=12 — different games) both resolve
        # the SAME canonical id, so they share ONE authoritative `_Run` and mirror its tokens in
        # lockstep (the Messenger mirror). A plain (non-framed) chat keeps keying on its per-tab
        # session — unchanged single-chat behavior. Persistence stays on `session` (the SAFE choice in
        # §3.1's "persistence split" risk row): client-convergence (sessions.js canonical ladder) makes
        # `session == run_key` on a normal in-game load, so the user/assistant turns persist under the
        # canonical id like every other window's. The early `canonical_session` event below is the
        # defensive belt for the rare window that POSTed BEFORE it converged.
        _framed = bool(getattr(ctx, "framed", False))
        run_key = (getattr(ctx, "canonical_session", None) or session) if _framed else session

        # F5 (casting second-session re-run / #1086 family): a CASTING turn (framed but the season is
        # NOT started) must be SINGLE-FLIGHT per run_key — never chain. Casting keys its run on the
        # per-tab `session` (GAP-2-b1), but the FE binds that session as canonical (0064 §C) and a
        # second window CONVERGES its view onto it (sessions.js / onboarding) — so a kickoff cue,
        # stream-drop auto-recover, or just the converged window's own send can POST a SECOND casting
        # turn against the SAME run_key WHILE the first is still streaming. With the game-turn QUEUE
        # policy below (`queue=_framed`) those duplicates do not cancel — they CHAIN, and each chained
        # run is a FRESH producer generation reacting to the same input. The reported bug: opening a 2nd
        # session mid-casting made the producer turn re-run ~4× (the original + the chained duplicates).
        # At-most-once fix: if a casting generation is ALREADY in flight for this run_key, do NOT start
        # another — publish the run-started invitation and SUBSCRIBE the duplicate to the existing run
        # (read-only mirror). The started-game two-window path is untouched: a STARTED game still
        # queue-chains DISTINCT turns (game_active=True skips this guard). Idempotent + fail-soft.
        _casting = _framed and not bool(getattr(ctx, "game_active", False))
        if _casting and agent_runs.is_active(run_key):
            logger.info("[orwell] casting turn for %s already in flight — attaching read-only (at-most-once)", run_key)
            session_events.publish(run_key, "run-started")
            if run_key != session:
                async def _adopt_then_mirror() -> AsyncGenerator[str, None]:
                    yield f'data: {json.dumps({"type": "canonical_session", "id": run_key})}\n\n'
                    async for ev in agent_runs.subscribe(run_key):
                        yield ev
                return StreamingResponse(_adopt_then_mirror(), media_type="text/event-stream", headers=SSE_STREAM_HEADERS)
            return StreamingResponse(agent_runs.subscribe(run_key), media_type="text/event-stream", headers=SSE_STREAM_HEADERS)

        # 0064 Part C (Messenger model): a GAME-framed turn QUEUES behind any in-flight run for the
        # CANONICAL session instead of cancelling it — two devices on the one game chat serialize
        # (one reasoning chain at a time, the live turn is never stomped) and each turn fans out to
        # every window. Plain chats keep cancel-on-double-send. `ctx.framed` covers in-character,
        # casting, and feeds-down turns.
        # F1 (concurrent-session consistency): for a FRAMED turn (the only turns with observer/mirror
        # windows — a plain chat has no peer), lead the run buffer with the persisted USER message so
        # replay-then-tail delivers cause BEFORE effect to every subscriber (WS + SSE). The sender
        # receives this event too and adopts its own optimistic bubble by clientMsgId (never a
        # duplicate); a peer renders the user bubble ahead of the reply. Vault-free (the player's own
        # words); None ⇒ byte-identical prior behavior.
        _lead_event = _build_lead_user_event(
            prepared.sess, prepared.message, prepared.client_msg_id) if _framed else None
        agent_runs.start(run_key, _safe_stream(), queue=_framed, lead_event=_lead_event)
        # Tell every other device viewing the canonical session that a new run started, so they
        # reconcile (load the new user message + attach to the live reply). Keyed on run_key so an
        # idle peer on the canonical game chat is invited to attach to THIS shared run.
        session_events.publish(run_key, "run-started")

        if run_key != session:
            # The loser-of-the-bind window (§2.4): it POSTed under its own per-tab id before
            # converging, but the run lives under the canonical id. Prepend a one-off
            # `canonical_session` event (NOT into the shared replay buffer — it is sender-private) so
            # this window adopts the canonical session client-side (selectSession) and re-attaches its
            # SSE/HUD there. Then fan out the canonical run's buffer like any subscriber. Vault-free
            # (a session id only); idempotent on the client if it already converged.
            # D2: also prepend run-started so the sender learns its run_id directly (not just via
            # sessionSync self-echo), enabling self-resume on mid-stream drop.
            _run_id_val = agent_runs.run_id(run_key)
            async def _adopt_then_subscribe() -> AsyncGenerator[str, None]:
                yield f'data: {json.dumps({"type": "canonical_session", "id": run_key})}\n\n'
                if _run_id_val:
                    yield f'event: run-started\ndata: {json.dumps({"type": "run-started", "runId": _run_id_val})}\n\n'
                async for ev in agent_runs.subscribe(run_key):
                    yield ev
            return StreamingResponse(_adopt_then_subscribe(), media_type="text/event-stream", headers=SSE_STREAM_HEADERS)

        # D2: prepend run-started event so the sender knows its run_id directly from this SSE stream,
        # enabling self-resume on mid-stream drop without waiting for the sessionSync self-echo.
        _run_id_val = agent_runs.run_id(run_key)
        if _run_id_val:
            async def _with_run_start() -> AsyncGenerator[str, None]:
                yield f'event: run-started\ndata: {json.dumps({"type": "run-started", "runId": _run_id_val})}\n\n'
                async for ev in agent_runs.subscribe(run_key):
                    yield ev
            return StreamingResponse(_with_run_start(), media_type="text/event-stream", headers=SSE_STREAM_HEADERS)
        return StreamingResponse(agent_runs.subscribe(run_key), media_type="text/event-stream", headers=SSE_STREAM_HEADERS)

    # ------------------------------------------------------------------ #
    # GET /api/chat/events — persistent per-session SSE for cross-device sync.
    # Every device viewing a session subscribes here; the server broadcasts
    # lightweight "session changed" events (run-started, message-added) so other
    # devices reconcile in real time. Payloads are ids/types only — the client
    # fetches the authoritative state itself.
    # ------------------------------------------------------------------ #
    @router.get("/api/chat/events/{session_id}")
    async def chat_events(request: Request, session_id: str) -> StreamingResponse:
        # W2: same owner guard as every sibling session endpoint — without it any
        # authenticated user could subscribe to another user's activity stream
        # (a metadata side-channel + an unbounded subscriber slot).
        _verify_session_owner(request, session_id)
        return StreamingResponse(
            session_events.subscribe(session_id),
            media_type="text/event-stream",
            headers=SSE_STREAM_HEADERS,
        )

    # ------------------------------------------------------------------ #
    # GET /api/chat/resume — reconnect to a detached run that's still going
    # (e.g. after reopening a session whose agent kept running in the background)
    # ------------------------------------------------------------------ #
    @router.get("/api/chat/resume/{session_id}")
    async def chat_resume(request: Request, session_id: str, from_seq: int = Query(0)) -> StreamingResponse:
        _verify_session_owner(request, session_id)
        # ADR 0012 — allow resuming a run that EXISTS (running OR terminal-but-still-buffered within
        # the evict grace), not only an actively-running one. A short turn finishes before a peer's
        # `run-started`→resume arrives; gating on is_active 404'd the mirroring window and forced it to
        # fall back to a full reload (the cross-tab "render on reload, not live" gap). subscribe()
        # replays the finished run's buffer then ends, so the peer still mirrors the turn's tokens.
        # D2: from_seq cursor so the caller can skip already-consumed events and reattach to the same
        # server-buffered run live instead of re-submitting the truncated tail as a new turn.
        if not agent_runs.has_run(session_id):
            raise HTTPException(404, "No active run for this session")
        return StreamingResponse(agent_runs.subscribe(session_id, from_seq=from_seq), media_type="text/event-stream", headers=SSE_STREAM_HEADERS)

    # ------------------------------------------------------------------ #
    # POST /api/chat/stop — cancel a detached run (Stop button). Closing the SSE
    # no longer stops it (it's detached), so the Stop button must call this.
    # ------------------------------------------------------------------ #
    @router.post("/api/chat/stop/{session_id}")
    async def chat_stop(request: Request, session_id: str) -> Dict[str, Any]:
        _verify_session_owner(request, session_id)
        stopped = agent_runs.stop(session_id)
        return {"stopped": stopped}

    # ------------------------------------------------------------------ #
    # GET /api/chat/stream_status — check if a stream is active for a session
    # ------------------------------------------------------------------ #
    @router.get("/api/chat/stream_status/{session_id}")
    async def chat_stream_status(request: Request, session_id: str) -> Dict[str, Any]:
        _verify_session_owner(request, session_id)
        # A detached run can still be going even if _active_streams was popped;
        # report it as active so the client knows to reconnect via /resume.
        # Read once via .get() to avoid a KeyError race between the membership
        # check and the indexed read if a sibling stream's finally pops the
        # entry in between (same pattern _stream_set already uses).
        rec = _active_streams.get(session_id)
        if rec is None:
            if agent_runs.is_active(session_id):
                return {"status": "streaming", "detached": True}
            # M1-8 (audit A8): "no active stream" is a NORMAL state, not an error — the old 404
            # made every idle-session probe a red console line (masking real failures) for the
            # exact path sessions.js polls each turn. Both client consumers already branch on
            # `status !== 'streaming'`, so the idle payload is drop-in compatible.
            return {"status": "idle"}
        return rec

    # ------------------------------------------------------------------ #
    # POST /api/inject_context
    # ------------------------------------------------------------------ #
    @router.post("/api/inject_context/{session_id}")
    async def inject_context(request: Request, session_id: str, context: str = Form(...)) -> Dict[str, str]:
        _verify_session_owner(request, session_id)
        try:
            sess = session_manager.get_session(session_id)
            msg = untrusted_context_message("injected research context", f"Research Context: {context}")
            sess.add_message(ChatMessage(msg["role"], msg["content"], metadata=msg.get("metadata")))
            session_manager.save_sessions()
            session_events.publish(session_id, "message-added")
            return {"status": "context_injected"}
        except KeyError:
            raise HTTPException(404, "Session not found")

    # ------------------------------------------------------------------ #
    # GET /api/search — search across chat messages
    # ------------------------------------------------------------------ #
    @router.get("/api/search")
    async def search_messages(
        request: Request,
        q: str = Query("", min_length=0),
        limit: int = Query(20, ge=1, le=100),
    ) -> List[Dict[str, Any]]:
        if not q or not q.strip():
            return []

        _user = get_current_user(request)
        return [
            result.to_dict()
            for result in search_session_messages(
                q,
                limit=limit,
                owner=_user,
                restrict_owner=_user is not None,
                include_legacy_owner=False,
            )
        ]

    # ------------------------------------------------------------------ #
    # POST /api/rewrite — lightweight rewrite of last AI message (no tools)
    # ------------------------------------------------------------------ #
    @router.post("/api/rewrite")
    async def rewrite_message(request: Request) -> StreamingResponse:
        """Rewrite the last AI message with an instruction (shorter/simpler/etc).

        Unlike the full chat pipeline, this does NOT run the agent loop or tools.
        It just asks the LLM to rewrite the given text.
        """
        try:
            body = await request.json()
        except Exception:
            raise HTTPException(400, "Invalid JSON")

        session_id = body.get("session_id")
        original_text = body.get("original_text", "")
        instruction = body.get("instruction", "")

        if not session_id or not original_text or not instruction:
            raise HTTPException(400, "session_id, original_text, and instruction are required")

        _verify_session_owner(request, session_id)

        try:
            sess = session_manager.get_session(session_id)
        except (KeyError, SessionNotFoundError):
            raise HTTPException(404, "Session not found")

        messages = [
            {"role": "system", "content": (
                "You are rewriting a previous response. Follow the instruction exactly. "
                "Output ONLY the rewritten text — no preamble, no explanation, no meta-commentary. "
                "Preserve any formatting (markdown, code blocks, lists) from the original."
            )},
            {"role": "user", "content": (
                f"Here is the original response:\n\n{original_text}\n\n"
                f"Instruction: {instruction}"
            )},
        ]

        async def stream_rewrite() -> AsyncGenerator[str, None]:
            full_response = ""
            try:
                async for chunk in stream_llm(
                    sess.endpoint_url,
                    sess.model,
                    messages,
                    headers=resolve_session_headers(sess),
                    temperature=0.7,
                    # 0 = let the server decide (no cap). A hardcoded 4096 made
                    # local reasoning models (Qwen3 / R1) burn the whole budget
                    # inside <think> and emit no rewrite — the bubble just hung
                    # on "Rewriting...". Same fix as the chat max_tokens cap.
                    max_tokens=0,
                    tools=None,
                ):
                    if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                        try:
                            data = json.loads(chunk[6:])
                            if "delta" in data:
                                # Forward the chunk (so the client can show a
                                # thinking indicator) but DON'T fold reasoning
                                # tokens into the saved rewrite — only real
                                # content. reasoning_content arrives flagged
                                # with thinking:true.
                                if not data.get("thinking"):
                                    full_response += data["delta"]
                                yield chunk
                        except json.JSONDecodeError:
                            yield chunk
                    elif chunk.startswith("event: "):
                        yield chunk
                    elif chunk == "data: [DONE]\n\n":
                        # Update the last assistant message in session history.
                        # Strip reasoning-model <think> blocks so the persisted
                        # rewrite is just the rewritten text, not its scratchpad.
                        from src.research_utils import strip_thinking
                        full_response = strip_thinking(full_response).strip() or full_response
                        if full_response:
                            for msg in reversed(sess.history):
                                if (isinstance(msg, ChatMessage) and msg.role == 'assistant') or \
                                   (isinstance(msg, dict) and msg.get('role') == 'assistant'):
                                    if isinstance(msg, ChatMessage):
                                        msg.content = full_response
                                    else:
                                        msg['content'] = full_response
                                    break
                            # Update in DB too
                            db = SessionLocal()
                            try:
                                db_msg = (
                                    db.query(DBChatMessage)
                                    .filter(DBChatMessage.session_id == session_id, DBChatMessage.role == 'assistant')
                                    .order_by(DBChatMessage.timestamp.desc())
                                    .first()
                                )
                                if db_msg:
                                    db_msg.content = full_response
                                    db.commit()
                            except Exception as e:
                                logger.warning("Failed to update rewritten message in DB: %s", e)
                                db.rollback()
                            finally:
                                db.close()
                            session_manager.save_sessions()
                        yield chunk
            except Exception as e:
                logger.error("Rewrite stream error: %s", e)
                yield f'event: error\ndata: {json.dumps({"error": str(e), "status": 500})}\n\n'

        return StreamingResponse(stream_rewrite(), media_type="text/event-stream", headers=SSE_STREAM_HEADERS)

    # ── WebSocket Phase-1 (ADR 0017 §3.5): register the `turn` producer ──────────────────────────
    # Build the factory over THIS closure's `_prepare_chat_stream` and hand it to ws_routes. Dormant
    # behind ORWELL_WS_TRANSPORT (client-gated) — registering it is inert until a socket relays a
    # `turn`; the HTTP path is untouched.
    try:
        from routes.ws_routes import set_turn_stream_factory
        set_turn_stream_factory(make_ws_turn_stream_factory(_prepare_chat_stream))
    except Exception:
        logger.debug("[ws] turn stream factory registration skipped", exc_info=True)

    return router
