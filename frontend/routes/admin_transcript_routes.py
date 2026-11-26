"""Feature 0053 — admin transcript retrieval (ruling #14, quiet debug access).

Read-ONLY retrieval of any user's chat transcripts for the app administrator
(the 0029 account tier, NOT the game's God Mode). All routes behind the existing
``require_admin`` middleware — same pattern as ``admin_wipe_routes.py`` /
``api_token_routes.py``.

  GET /api/admin/transcripts                       — list sessions across ALL users
  GET /api/admin/transcripts/{session_id}          — full export (json|md)

Boundaries (recorded in the ruling):
  * Transcripts hold player-visible content — the played record the player
    already saw. The LIVE Vault Wall is enforced upstream at the engine's tool
    boundary (never here), so no in-progress hidden state (souls, relationship/
    threat numbers, a running game's off-screen scheming) can ever appear.
  * SANCTIONED EXCEPTION (owner ruling, ADM-NEW-1): a FINISHED game's
    ``seasonRetrospective`` unseal — the engine's one post-season Vault-unseal —
    lands in the transcript as a GM tool node like any other, and the export
    forwards it verbatim. So this is NOT "no Vault risk by construction": it is
    the accepted intersection of ruling #14's operator read-access and a season
    that has ALREADY ENDED. It is content the player already read in their own
    completed game (story, not numbers — no soul/relationship/stat figure
    crosses), and it never breaches the God-Mode-Vault wall for a LIVE game
    (mandate #2) — only a game that is over.
  * They DO include the player's Diary-Room entries (player-level OOC) — an
    accepted operator capability for a self-hosted box; the admin UI copy notes it.
  * READ-ONLY. There is no edit/delete verb on this surface (E93's
    no-rewriting-the-played-record rule applies to admins too).
  * The export carries the agent-thread tool-call nodes (names, args, outputs) —
    what the GM actually called vs. what it narrated is where the debug value lives.

Transcripts live in the front-end's chat store (the ``sessions`` /
``chat_messages`` tables in ``app.db``), so they survive the game-only reset (which
preserves the front-end store) and die with the factory reset (which scrubs it) —
no script change needed; the boundary holds by construction.
"""

import json
import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Response

from core.middleware import require_admin
from core.database import (
    SessionLocal,
    Session as DbSession,
    ChatMessage as DbChatMessage,
)

logger = logging.getLogger(__name__)

# A session is "a game session" when its transcript carries any orwell-engine
# tool-call node — the GM actually drove the game through these. Kept broad
# (write + diary + the read levers the GM leans on) so the marker is honest
# rather than a guess at session.mode.
GAME_ENGINE_TOOL_HINTS = (
    "recordInteraction", "advanceGame", "submitDecision", "diaryRoom",
    "makeDeal", "surfaceInformationTo", "createCharacter", "updateCasting",
    "gameStatus", "getMomentPrompt", "getVisibleState", "whereabouts",
    "socialInitiatives", "finaleView", "seasonRecap",
)

# Pagination guardrails — generous but bounded so a single call can't drag the
# whole store into memory.
DEFAULT_LIMIT = 50
MAX_LIMIT = 500


def _iso(value):
    return value.isoformat() if isinstance(value, datetime) else None


def _parse_since(since: str | None):
    """Parse a since-timestamp filter. Accepts ISO-8601 (with or without a 'Z').
    Returns a naive UTC datetime (the DB stores naive UTC) or None."""
    if not since:
        return None
    raw = since.strip()
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "Invalid 'since' timestamp (expected ISO-8601)")
    if dt.tzinfo is not None:
        dt = dt.astimezone(tz=None).replace(tzinfo=None)
    return dt


def _decode_meta(raw):
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        meta = json.loads(raw)
        return meta if isinstance(meta, dict) else {}
    except (ValueError, TypeError):
        return {}


def _decode_content(raw):
    """Message content is either a plain string or a JSON-encoded list of content
    blocks (multimodal / tool payloads). Return it structured when it's a list so
    tool-call nodes survive into the export verbatim."""
    if not isinstance(raw, str):
        return raw
    stripped = raw.lstrip()
    if stripped[:1] in ("[", "{"):
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw
    return raw


def _is_game_session(messages) -> bool:
    """True when any message in the session references an orwell-engine tool —
    the honest game-session marker."""
    for m in messages:
        if (m.role or "") == "tool":
            return True
        meta = _decode_meta(m.meta_data)
        # native tool_calls live in metadata; the GM's tool name shows up there
        blob = json.dumps(meta) if meta else ""
        content = m.content if isinstance(m.content, str) else ""
        haystack = blob + content
        if any(hint in haystack for hint in GAME_ENGINE_TOOL_HINTS):
            return True
    return False


def _export_message(m) -> dict:
    """One transcript node for the export — role, timestamp, content, and any
    tool-call metadata, ALL preserved (the tool nodes are the debug value)."""
    meta = _decode_meta(m.meta_data)
    node = {
        "id": m.id,
        "role": m.role,
        "timestamp": _iso(m.timestamp),
        "content": _decode_content(m.content),
    }
    if meta:
        node["metadata"] = meta
        # Surface native tool_calls at the top level too so the export reader
        # doesn't have to dig — names, args, outputs ride untouched.
        if isinstance(meta.get("tool_calls"), (list, dict)):
            node["tool_calls"] = meta["tool_calls"]
    return node


def _render_markdown(session_row, owner, nodes) -> str:
    lines = []
    lines.append(f"# Transcript — {session_row.name or session_row.id}")
    lines.append("")
    lines.append(f"- **Session id:** `{session_row.id}`")
    lines.append(f"- **Owner:** {owner or '(unknown)'}")
    lines.append(f"- **Created:** {_iso(session_row.created_at) or ''}")
    lines.append(f"- **Updated:** {_iso(session_row.updated_at) or ''}")
    lines.append(f"- **Messages:** {len(nodes)}")
    lines.append("")
    lines.append("> Includes the player's Diary-Room entries (player-level OOC) and the "
                 "agent-thread tool-call nodes (names, args, outputs).")
    lines.append("")
    lines.append("---")
    for n in nodes:
        lines.append("")
        ts = n.get("timestamp") or ""
        lines.append(f"### {n.get('role', '')} — {ts}")
        content = n.get("content")
        if isinstance(content, str):
            lines.append("")
            lines.append(content)
        elif content is not None:
            lines.append("")
            lines.append("```json")
            lines.append(json.dumps(content, indent=2, ensure_ascii=False))
            lines.append("```")
        tcs = n.get("tool_calls") or (n.get("metadata") or {}).get("tool_calls")
        if tcs:
            lines.append("")
            lines.append("**Tool calls:**")
            lines.append("")
            lines.append("```json")
            lines.append(json.dumps(tcs, indent=2, ensure_ascii=False))
            lines.append("```")
        # ORW-187 (review of #2248): the admin-only full engine results live on metadata.tool_events[].engine_result; the JSON export
        # carried them, the Markdown export did not.
        evs = (n.get("metadata") or {}).get("tool_events") if isinstance(n.get("metadata"), dict) else None
        results = [e for e in (evs if isinstance(evs, list) else []) if isinstance(e, dict) and isinstance(e.get("engine_result"), str) and e.get("engine_result")]
        # ORW-482: calls the front end made itself (the forced casting finalize) live in their own admin-only key, not in tool_events.
        fe_calls = (n.get("metadata") or {}).get("admin_engine_results") if isinstance(n.get("metadata"), dict) else None
        results += [e for e in (fe_calls if isinstance(fe_calls, list) else []) if isinstance(e, dict) and isinstance(e.get("engine_result"), str) and e.get("engine_result")]
        if results:
            lines.append("")
            lines.append("**Engine results (admin only):**")
            for e in results:
                lines.append("")
                lines.append(f"- `{e.get('tool') or '?'}` (round {e.get('round', '?')}{', forced by the front end' if e.get('forced') else ''})")
                lines.append("")
                lines.append("```json")
                lines.append(e["engine_result"].replace("```", "` ` `"))
                lines.append("```")
    lines.append("")
    return "\n".join(lines)


def setup_admin_transcript_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin", tags=["admin_transcripts"])

    @router.get("/transcripts")
    def list_transcripts(
        request: Request,
        user: str | None = None,
        since: str | None = None,
        limit: int = DEFAULT_LIMIT,
        offset: int = 0,
    ):
        require_admin(request)
        since_dt = _parse_since(since)
        try:
            limit = max(1, min(int(limit), MAX_LIMIT))
        except (TypeError, ValueError):
            limit = DEFAULT_LIMIT
        try:
            offset = max(0, int(offset))
        except (TypeError, ValueError):
            offset = 0

        db = SessionLocal()
        try:
            q = db.query(DbSession)
            if user:
                q = q.filter(DbSession.owner == user)
            if since_dt is not None:
                q = q.filter(DbSession.updated_at > since_dt)
            total = q.count()
            rows = (
                q.order_by(DbSession.updated_at.desc())
                .offset(offset)
                .limit(limit)
                .all()
            )

            items = []
            for s in rows:
                msgs = (
                    db.query(DbChatMessage)
                    .filter(DbChatMessage.session_id == s.id)
                    .order_by(DbChatMessage.timestamp)
                    .all()
                )
                items.append({
                    "id": s.id,
                    "owner": s.owner,
                    "title": s.name,
                    "created_at": _iso(s.created_at),
                    "updated_at": _iso(s.updated_at),
                    "message_count": len(msgs),
                    "is_game_session": _is_game_session(msgs),
                })

            return {
                "transcripts": items,
                "total": total,
                "limit": limit,
                "offset": offset,
            }
        finally:
            db.close()

    @router.get("/transcripts/{session_id}")
    def export_transcript(session_id: str, request: Request, format: str = "json"):
        require_admin(request)
        fmt = (format or "json").strip().lower()
        if fmt not in ("json", "md"):
            raise HTTPException(400, "format must be 'json' or 'md'")

        db = SessionLocal()
        try:
            s = db.query(DbSession).filter(DbSession.id == session_id).first()
            if not s:
                raise HTTPException(404, "Transcript not found")
            msgs = (
                db.query(DbChatMessage)
                .filter(DbChatMessage.session_id == session_id)
                .order_by(DbChatMessage.timestamp)
                .all()
            )
            nodes = [_export_message(m) for m in msgs]

            if fmt == "md":
                body = _render_markdown(s, s.owner, nodes)
                return Response(content=body, media_type="text/markdown")

            return {
                "id": s.id,
                "owner": s.owner,
                "title": s.name,
                "created_at": _iso(s.created_at),
                "updated_at": _iso(s.updated_at),
                "is_game_session": _is_game_session(msgs),
                "message_count": len(nodes),
                "messages": nodes,
            }
        finally:
            db.close()

    return router
