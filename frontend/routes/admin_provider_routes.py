"""Admin provider switch (ORW-199 remainder) — move running game sessions to another endpoint/model.

Each chat session stores its own ``model`` + ``endpoint_url``, so changing the default never moves a
running game. ``POST /api/admin/sessions/switch-provider`` re-points the game sessions in ONE DB
transaction. Boundaries: admin-gated (``require_admin``); NO model/network call; the endpoint must be
enabled and visible to every affected session's owner (own + shared rows only, never another user's);
the API key is never persisted into session headers, returned, or logged (host only).
"""
import logging
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Request

from core.middleware import require_admin

logger = logging.getLogger(__name__)


def provider_host(url: str) -> str:
    """Host (and port) only: no credentials, path, query or fragment."""
    try:
        p = urlparse((url or "").strip())
        if not p.hostname:
            return ""
        return p.hostname + (f":{p.port}" if p.port else "")
    except Exception:
        return ""


def _game_session_ids() -> set:
    from src.orwell_game_session import _load
    return {v for v in (_load() or {}).values() if isinstance(v, str) and v.strip()}


def _visible(ep_owner, sess_owner) -> bool:
    return ep_owner is None or (bool(sess_owner) and ep_owner == sess_owner)


def _set_fields(row, model: str, url: str, headers: dict) -> None:
    row.model = model
    row.endpoint_url = url
    row.headers = headers


def setup_admin_provider_routes(session_manager=None) -> APIRouter:
    router = APIRouter(prefix="/api/admin/sessions", tags=["admin_provider"])

    @router.post("/switch-provider")
    async def switch_provider(request: Request):
        require_admin(request)
        try:
            body = await request.json()
        except Exception:
            body = None
        if not isinstance(body, dict):
            raise HTTPException(400, "JSON object body required")
        endpoint_id = str(body.get("endpoint_id") or "").strip()
        model = str(body.get("model") or "").strip()
        owner = body.get("owner")
        owner = owner.strip() if isinstance(owner, str) and owner.strip() else None
        if not endpoint_id or not model:
            raise HTTPException(400, "endpoint_id and model are required")

        from core.database import SessionLocal, ModelEndpoint, Session as DbSession
        from src.endpoint_resolver import (
            build_chat_url, normalize_base, persistable_session_headers,
            _non_auth_headers, _stored_headers_dict,
        )
        db = SessionLocal()
        try:
            ep = db.query(ModelEndpoint).filter(ModelEndpoint.id == endpoint_id).first()
            if ep is None or not ep.is_enabled:
                raise HTTPException(404, "endpoint not found or disabled")
            url = build_chat_url(normalize_base(ep.base_url or ""))
            ids = _game_session_ids()
            rows = db.query(DbSession).filter(DbSession.id.in_(ids)).all() if ids else []
            rows = [r for r in rows if not r.archived and (not owner or r.owner == owner)]
            for r in rows:
                if not _visible(ep.owner, r.owner):
                    raise HTTPException(403, "endpoint is not visible to the session owner")
            # Computed BEFORE any write; old auth headers are dropped so a previous provider's
            # key can never ride along to the new host.
            plan = [(r, persistable_session_headers(
                url, _non_auth_headers(_stored_headers_dict(r.headers)), r.owner)) for r in rows]
            try:
                for r, hdrs in plan:
                    _set_fields(r, model, url, hdrs)
                db.commit()
            except Exception:
                db.rollback()
                logger.warning("switch-provider failed; rolled back (%d sessions)", len(rows))
                raise HTTPException(500, "switch failed; no sessions were changed")
            hdr_by_id = {r.id: h for r, h in plan}
        finally:
            db.close()

        mem = getattr(session_manager, "sessions", None) or {}
        for sid, hdrs in hdr_by_id.items():
            s = mem.get(sid)
            if s is not None:
                s.model, s.endpoint_url, s.headers = model, url, hdrs
        host = provider_host(url)
        logger.info("switch-provider: %d session(s) -> %s / %s", len(hdr_by_id), host, model)
        return {"updated": len(hdr_by_id), "provider": host, "model": model}

    return router
