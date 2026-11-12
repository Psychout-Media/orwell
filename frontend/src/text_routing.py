"""ORW-287: in the game build every TEXT call goes to the direct DeepSeek API; OpenRouter is for images only.

Ryne's rule: the OpenRouter key is for image playtesting only. A prod log showed the narrator stream going to
openrouter.ai (``deepseek/deepseek-v4.1-flash``) while the utility/background tiers went to api.deepseek.com.
This module is the single place that enforces the rule:

  * :func:`map_openrouter_text_model` — OpenRouter ``deepseek/*`` ids map to the matching direct model.
  * :func:`enforce_text_destination` — the call-time guard the three ``llm_core`` dispatchers run first: an
    OpenRouter text target is re-pointed at the direct DeepSeek endpoint (when one with a key exists) or
    REFUSED (:class:`TextRoutingRefused`) — never a silent paid OpenRouter text call. Image models pass through.
  * :func:`migrate_saved_text_settings` — the startup migration of the saved default/utility selections.

Keys are never read into logs: only endpoint ids, hosts and model ids are ever logged.
"""
from __future__ import annotations

import logging
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

DIRECT_FLASH = "deepseek-flash"
DIRECT_PRO = "deepseek-v4-pro"


class TextRoutingRefused(Exception):
    """A text call to OpenRouter in the game build with no direct DeepSeek endpoint to take it instead."""


def map_openrouter_text_model(model: Optional[str]) -> str:
    """The direct-DeepSeek model for an OpenRouter-style text model id. Unknown / non-DeepSeek ids (the old
    qwen utility, glm narrator) ride the cheap flash model: every text tier is DeepSeek in the game build."""
    m = (model or "").strip().lower()
    if m in (DIRECT_FLASH, DIRECT_PRO):
        return m
    bare = m.split("/", 1)[1] if m.startswith("deepseek/") else m
    if "pro" in bare:
        return DIRECT_PRO
    return DIRECT_FLASH


def _is_openrouter(url: Optional[str]) -> bool:
    from src.llm_core import _host_match
    return _host_match(url or "", "openrouter.ai")


def _is_text_model(model: Optional[str]) -> bool:
    from src.llm_core import is_image_model
    return not is_image_model(model)


def active() -> bool:
    try:
        from src.settings import game_build_enabled
        return bool(game_build_enabled())
    except Exception:  # failsoft-ok: settings unreadable -> treat as inactive (non-game behaviour), never block a call here
        return False


def direct_deepseek_endpoint(owner: Optional[str] = None):
    """(chat_url, headers, endpoint_id) of an enabled, keyed, text DeepSeek endpoint; shared rows first."""
    from core.database import SessionLocal, ModelEndpoint
    from src.endpoint_resolver import build_chat_url, build_headers, normalize_base
    from src.llm_core import _host_match
    db = SessionLocal()
    try:
        rows = [r for r in db.query(ModelEndpoint).filter(ModelEndpoint.is_enabled == True).order_by(ModelEndpoint.created_at).all()  # noqa: E712
                if _host_match(r.base_url or "", "deepseek.com") and (r.api_key or "").strip()
                and (getattr(r, "model_type", None) or "llm") != "image"]
        if owner:
            rows.sort(key=lambda r: 0 if r.owner in (None, "", owner) else 1)
        else:
            rows.sort(key=lambda r: 0 if r.owner in (None, "") else 1)
        if not rows:
            return None
        ep = rows[0]
        base = normalize_base(ep.base_url)
        return build_chat_url(base), build_headers(ep.api_key, base), ep.id
    finally:
        db.close()


def enforce_text_destination(url: str, model: str, headers: Optional[Dict] = None,
                             owner: Optional[str] = None) -> Tuple[str, str, Optional[Dict]]:
    """Game build: re-point an OpenRouter TEXT target at direct DeepSeek, or raise :class:`TextRoutingRefused`."""
    if not active() or not _is_openrouter(url) or not _is_text_model(model):
        return url, model, headers
    target = direct_deepseek_endpoint(owner)
    if target is None:
        logger.error("[text-routing] refused a text call to OpenRouter (model %r): no keyed direct DeepSeek endpoint", model)
        raise TextRoutingRefused("text calls may not use OpenRouter in the game build and no DeepSeek endpoint is configured")
    new_url, new_headers, ep_id = target
    new_model = map_openrouter_text_model(model)
    logger.warning("[text-routing] OpenRouter text target re-pointed to DeepSeek direct (endpoint %s): %r -> %r", ep_id, model, new_model)
    return new_url, new_model, new_headers


def migrate_saved_text_settings() -> bool:
    """Startup: point the saved default/utility selections at the direct DeepSeek endpoint (game build only).

    For each tier (``default``, ``utility``) whose saved endpoint is OpenRouter text, or whose saved model is a
    ``deepseek/*`` id, rewrite endpoint id + model. Also drops OpenRouter text entries from the saved fallback
    chains. Idempotent. Returns True when it wrote."""
    if not active():
        return False
    from core.database import SessionLocal, ModelEndpoint
    from src import settings as _s
    from src.deepseek_seed import _read_saved, _seed_lock, _write_saved
    target = direct_deepseek_endpoint()
    if target is None:
        return False
    ds_id = target[2]
    with _seed_lock(_s.SETTINGS_FILE):
        saved = _read_saved(_s.SETTINGS_FILE)
        db = SessionLocal()
        try:
            or_ids = {r.id for r in db.query(ModelEndpoint).all() if _is_openrouter(r.base_url)}
        finally:
            db.close()
        changed = False
        for prefix in ("default", "utility"):
            ep_key, model_key = f"{prefix}_endpoint_id", f"{prefix}_model"
            ep_val = (saved.get(ep_key) or "").strip()
            model_val = (saved.get(model_key) or "").strip()
            on_or = ep_val in or_ids
            # an unset utility endpoint rides the default endpoint, so only a model id needs mapping there
            if on_or:
                saved[ep_key] = ds_id
                changed = True
            if (on_or or model_val.startswith("deepseek/") or (prefix == "default" and ep_val == "" and model_val and "/" in model_val)) and model_val:
                mapped = map_openrouter_text_model(model_val)
                if mapped != model_val:
                    saved[model_key] = mapped
                    changed = True
        for chain_key in ("default_model_fallbacks", "utility_model_fallbacks"):
            chain = saved.get(chain_key) or []
            kept = [e for e in chain if not (isinstance(e, dict) and e.get("endpoint_id") in or_ids)]
            if len(kept) != len(chain):
                saved[chain_key] = kept
                changed = True
        if changed:
            _write_saved(saved)
    if changed:
        logger.info("[text-routing] migrated saved text selections to the direct DeepSeek endpoint %s (OpenRouter is images only)", ds_id)
    return changed
