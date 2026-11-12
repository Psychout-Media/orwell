"""First-boot DeepSeek endpoint seeding (PO ruling 2026-11-02: DeepSeek's own API is the new-install default).

If ``DEEPSEEK_API_KEY`` is set and the ``model_endpoints`` table is EMPTY, create one shared DeepSeek
endpoint (https://api.deepseek.com) and bind it as the default chat endpoint. Stored through the normal
``ModelEndpoint`` row, so the key rides the existing ``EncryptedText`` path — no new storage.

Never touches an existing endpoint or a saved setting: any existing row (OpenRouter or otherwise) makes
the create a no-op, and only the ``default_endpoint_id`` key is written, and only when it is unset. No
network call is made at boot.

Three guarantees (PR #1935 review):
  * RECOVERABLE — if a prior boot created the endpoint but died before binding it, the next boot
    re-binds it (a lone seeded DeepSeek endpoint + an unset default is an incomplete seed, not a choice).
  * RACE-SAFE — the check→insert→bind runs under an exclusive file lock in the data dir, re-checked
    inside the lock, so two workers on the same first boot cannot create two endpoints.
  * EXISTING INSTALLS KEEP THEIR EFFECTIVE MODELS — ``DEFAULT_SETTINGS`` now says ``deepseek-flash``, so
    an install that already has endpoints but never SAVED a ``default_model``/``utility_model`` (e.g.
    right after an OOBE reset) would silently flip onto a model its provider may not serve. Before
    seeding, :func:`pin_legacy_model_defaults` persists the prior OOB pair for exactly those installs.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from contextlib import contextmanager
from typing import Optional

logger = logging.getLogger(__name__)

DEEPSEEK_BASE_URL = "https://api.deepseek.com"
# Known served ids, cached so the picker is populated without a boot-time probe.
DEEPSEEK_KNOWN_MODELS = ["deepseek-flash", "deepseek-v4-pro"]
# The OOB pair before 2026-11-02 (ADR 0016) — what an existing store with no saved models was running.
LEGACY_DEFAULT_MODEL = "z-ai/glm-4.7"
LEGACY_UTILITY_MODEL = "qwen/qwen3.6-27b"


@contextmanager
def _seed_lock(settings_file: str):
    """Exclusive cross-process lock next to the settings file (no-op where fcntl is unavailable)."""
    try:
        import fcntl
    except ImportError:  # pragma: no cover - non-POSIX
        yield
        return
    lock_path = os.path.join(os.path.dirname(os.path.abspath(settings_file)) or ".", ".deepseek_seed.lock")
    with open(lock_path, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _read_saved(settings_file: str) -> dict:
    try:
        with open(settings_file, "r", encoding="utf-8") as f:
            saved = json.load(f)
        return saved if isinstance(saved, dict) else {}
    except (FileNotFoundError, PermissionError, json.JSONDecodeError):
        return {}


def _write_saved(saved: dict) -> None:
    from core.atomic_io import atomic_write_json
    from src import settings as _s
    atomic_write_json(_s.SETTINGS_FILE, saved, indent=2)
    _s._invalidate_caches()


def _is_deepseek(base_url: Optional[str]) -> bool:
    from src.llm_core import _host_match
    return _host_match(base_url or "", "deepseek.com")


def pin_legacy_model_defaults() -> bool:
    """Persist the pre-2026-11-02 OOB model pair for an EXISTING install that never saved its own.

    Fires only when endpoints already exist, none is a DeepSeek host, and ``default_model`` /
    ``utility_model`` are absent from the saved settings (only the missing keys are written). A fresh
    install (no endpoints) and a DeepSeek install are untouched. Idempotent. Returns True when it wrote.
    """
    from core.database import SessionLocal, ModelEndpoint
    from src import settings as _s
    with _seed_lock(_s.SETTINGS_FILE):
        db = SessionLocal()
        try:
            rows = db.query(ModelEndpoint).all()
            if not rows or any(_is_deepseek(r.base_url) for r in rows):
                return False
        finally:
            db.close()
        saved = _read_saved(_s.SETTINGS_FILE)
        missing = {k: v for k, v in (("default_model", LEGACY_DEFAULT_MODEL),
                                     ("utility_model", LEGACY_UTILITY_MODEL)) if not saved.get(k)}
        if not missing:
            return False
        saved.update(missing)
        _write_saved(saved)
    logger.info("[deepseek-seed] existing install with no saved model selection — pinned its prior "
                "defaults %s (the OOB default is DeepSeek only for new installs)", sorted(missing))
    return True


# ORW-287: ``seed_default_model_fallbacks`` (ORW-144, a DeepSeek -> OpenRouter text fallback) was REMOVED. OpenRouter is for
# images only; a DeepSeek failure surfaces as the outage UX, never a silent paid OpenRouter text call.


def seed_deepseek_endpoint_from_env(environ: Optional[dict] = None) -> Optional[str]:
    """Create (or finish binding) the DeepSeek endpoint on a keyed, endpoint-less first boot.

    Returns the endpoint id when it created or re-bound one, else None."""
    env = os.environ if environ is None else environ
    key = (env.get("DEEPSEEK_API_KEY") or "").strip()
    if not key:
        return None
    from core.database import SessionLocal, ModelEndpoint
    from src import settings as _s
    with _seed_lock(_s.SETTINGS_FILE):
        db = SessionLocal()
        try:
            rows = db.query(ModelEndpoint).all()
            if rows:
                # Recovery: a lone seeded DeepSeek endpoint whose default was never bound.
                only = rows[0] if len(rows) == 1 else None
                if (only is not None and _is_deepseek(only.base_url) and only.owner is None
                        and not (_read_saved(_s.SETTINGS_FILE).get("default_endpoint_id") or "").strip()):
                    _bind_default_endpoint(only.id)
                    logger.info("[deepseek-seed] re-bound the seeded DeepSeek endpoint %s as the default", only.id)
                    return only.id
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
    from src import settings as _s
    saved = _read_saved(_s.SETTINGS_FILE)
    if (saved.get("default_endpoint_id") or "").strip():
        return
    saved["default_endpoint_id"] = ep_id
    _write_saved(saved)
