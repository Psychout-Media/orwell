"""First-boot DeepSeek endpoint seeding (PO ruling 2026-11-02: DeepSeek's own API is the new-install default).

If ``DEEPSEEK_API_KEY`` is set and the ``model_endpoints`` table is EMPTY, create one shared DeepSeek
endpoint (https://api.deepseek.com) and bind it as the default chat endpoint. Stored through the normal
``ModelEndpoint`` row, so the key rides the existing ``EncryptedText`` path — no new storage.

Never touches an existing endpoint or a saved setting: any existing row (OpenRouter or otherwise) makes
this a no-op, and only the ``default_endpoint_id`` key is written, and only when it is unset. The model
defaults themselves (``deepseek-flash``) come from ``DEFAULT_SETTINGS`` — unsaved, so persisted stores
that carry another model are unaffected. No network call is made at boot.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
# Known served ids, cached so the picker is populated without a boot-time probe.
DEEPSEEK_KNOWN_MODELS = ["deepseek-flash", "deepseek-v4-pro"]


def seed_deepseek_endpoint_from_env(environ: Optional[dict] = None) -> Optional[str]:
    """Create the DeepSeek endpoint on a keyed, endpoint-less first boot. Returns its id, else None."""
    env = os.environ if environ is None else environ
    key = (env.get("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        return None
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        if db.query(ModelEndpoint).count() > 0:
            return None
        ep = ModelEndpoint(
            id=str(uuid.uuid4())[:8],
            name="DeepSeek",
            base_url=DEEPSEEK_BASE_URL,
            api_key=key,
            is_enabled=True,
            model_type="llm",
            endpoint_kind="api",
            cached_models=json.dumps(DEEPSEEK_KNOWN_MODELS),
            pinned_models=json.dumps(["deepseek-flash"]),
            supports_tools=True,
            owner=None,
        )
        db.add(ep)
        db.commit()
        ep_id = ep.id
    finally:
        db.close()
    _bind_default_endpoint(ep_id)
    logger.info("[deepseek-seed] created the DeepSeek endpoint %s from DEEPSEEK_API_KEY (first boot)", ep_id)
    return ep_id


def _bind_default_endpoint(ep_id: str) -> None:
    """Write ONLY ``default_endpoint_id`` into the saved settings, and only when unset."""
    from core.atomic_io import atomic_write_json
    from src import settings as _s
    try:
        with open(_s.SETTINGS_FILE, "r", encoding="utf-8") as f:
            saved = json.load(f)
        if not isinstance(saved, dict):
            saved = {}
    except (FileNotFoundError, PermissionError, json.JSONDecodeError):
        saved = {}
    if (saved.get("default_endpoint_id") or "").strip():
        return
    saved["default_endpoint_id"] = ep_id
    atomic_write_json(_s.SETTINGS_FILE, saved, indent=2)
    _s._invalidate_caches()
