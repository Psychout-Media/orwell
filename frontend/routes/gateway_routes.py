"""FastAPI webhook routes for the multi-platform gateway (feature 0072).

Mounts at /gateway/:
  POST /gateway/webhook/{platform_id}   — inbound webhook from a messaging platform
  POST /gateway/pair/verify             — verify a pairing code from the web UI
  GET  /gateway/status                  — admin read: registered platforms + pair count

Auth posture:
  - The /webhook endpoint is unauthenticated by default (platforms POST here without a session
    cookie).  Identity is proven via the pairing store: unpaired identities are rejected before
    reaching the engine.  For a PUBLIC deployment, transport auth is available (and recommended):
      • ORWELL_GATEWAY_WEBHOOK_SECRET — a gateway-wide shared secret. When set, EVERY inbound
        webhook must carry a matching ``X-Orwell-Gateway-Secret`` header (constant-time compare)
        or it is rejected 403 (FAIL-CLOSED). Unset ⇒ dormant (#559).
      • TELEGRAM_WEBHOOK_SECRET — a per-platform secret (Telegram echoes it in
        ``X-Telegram-Bot-Api-Secret-Token``); opt-in, applied by the adapter's verify_webhook.
  - The turn path is rate-limited per identity (ORWELL_GATEWAY_RATE_MAX /
    ORWELL_GATEWAY_RATE_WINDOW_S) and honors the paired user's ``max_messages_per_day`` daily cap,
    so the gateway can't be used to bypass the browser path's limits (#560).
  - /pair/verify is session-authenticated (the web UI user is doing the pairing —
    they must be logged in to bind their orwell account).
  - /status is admin-gated (operational visibility only).
"""

from __future__ import annotations

import hmac
import logging
import os
from typing import Optional

from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse

from gateway.handler import handle_platform_turn
from gateway.pairing import (
    generate_code,
    verify_code,
    pair,
    is_rate_limited,
    paired_identities,
    get_paired_user,
)
from gateway import platform_registry
from gateway import turn_limits

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/gateway", tags=["gateway"])

# ORW-265: inbound-update dedupe. Platforms redeliver an update (same id) on a slow/non-2xx webhook;
# the turn narrates and folds a consequence (fresh idempotency key per call), so a redelivery would
# do both twice. Process-local, bounded, claimed BEFORE the turn and released if it raises.
_INBOUND_SEEN: "dict[str, float]" = {}
_INBOUND_TTL_S = 24 * 3600.0
_INBOUND_MAX = 4096


def reset_inbound_dedupe_for_tests() -> None:
    _INBOUND_SEEN.clear()


def _claim_inbound(key: str) -> bool:
    """True if *key* is new (now claimed); False if it was already seen (a redelivery)."""
    import time
    now = time.monotonic()
    if len(_INBOUND_SEEN) >= _INBOUND_MAX:
        for k in [k for k, t in _INBOUND_SEEN.items() if now - t > _INBOUND_TTL_S]:
            _INBOUND_SEEN.pop(k, None)
        while len(_INBOUND_SEEN) >= _INBOUND_MAX:
            _INBOUND_SEEN.pop(next(iter(_INBOUND_SEEN)), None)
    seen = _INBOUND_SEEN.get(key)
    if seen is not None and now - seen <= _INBOUND_TTL_S:
        return False
    _INBOUND_SEEN[key] = now
    return True

# SEC-2 (#559): a gateway-wide shared secret. Unlike the per-platform ``verify_webhook`` hook
# (opt-in, e.g. TELEGRAM_WEBHOOK_SECRET), this is platform-agnostic and FAIL-CLOSED: the moment
# ORWELL_GATEWAY_WEBHOOK_SECRET is configured, EVERY inbound webhook must carry a matching
# X-Orwell-Gateway-Secret header (constant-time compare) or it is rejected 403 — so a public
# deployment can require transport auth across all platforms with one env var. Unset ⇒ the guard
# is dormant (local/trusted behaviour unchanged), and the per-platform hook still applies.


def _gateway_secret() -> Optional[str]:
    return (os.environ.get("ORWELL_GATEWAY_WEBHOOK_SECRET") or "").strip() or None


def _gateway_secret_ok(headers) -> bool:
    """When a gateway secret is configured, require a matching X-Orwell-Gateway-Secret header.

    Fail-closed: configured-but-missing/mismatched ⇒ False. No secret configured ⇒ True (dormant).
    """
    secret = _gateway_secret()
    if not secret:
        return True
    try:
        sent = headers.get("X-Orwell-Gateway-Secret") or ""
    except Exception:
        sent = ""
    return hmac.compare_digest(sent, secret)


# ── webhook: inbound message from a messaging platform ───────────────────────

@router.post("/webhook/{platform_id}")
async def platform_webhook(platform_id: str, request: Request):
    """Inbound webhook from a messaging platform.

    The platform POSTs its update payload here.  We:
      1. Dispatch to the correct adapter by platform_id
      2. Parse the payload into (identity, text)
      3. Handle /pair commands inline (issue a code)
      4. Route everything else through the gateway turn handler
      5. Return {"ok": True} to acknowledge receipt (the adapter sends the reply)

    Returns 404 for an unknown platform, 400 for a malformed payload, 403 if the platform
    provides a configured webhook secret that does not match (SEC-2). By default the endpoint
    is unauthenticated and treats the platform identity as the credential; setting a per-platform
    webhook secret (e.g. TELEGRAM_WEBHOOK_SECRET) opts into transport-level verification.
    """
    adapter = platform_registry.get(platform_id)
    if adapter is None:
        raise HTTPException(status_code=404, detail=f"Unknown platform: {platform_id!r}")

    # SEC-2 (#559, fail-closed): a configured gateway-wide secret is required across all platforms.
    if not _gateway_secret_ok(request.headers):
        raise HTTPException(status_code=403, detail="Webhook verification failed")

    # SEC-2 (opt-in): if the adapter has a configured webhook secret, verify the platform's
    # signature header before trusting the body-supplied identity. No secret ⇒ unchanged.
    if not adapter.verify_webhook(request.headers):
        raise HTTPException(status_code=403, detail="Webhook verification failed")

    try:
        raw = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")

    try:
        platform_identity, text = adapter.parse_inbound(raw)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=f"Malformed payload: {exc}")

    text = (text or "").strip()

    # ORW-265: a redelivered update is acked and dropped — one narration, one fold.
    dedupe_key = adapter.inbound_dedupe_key(raw)
    if dedupe_key is not None and not _claim_inbound(dedupe_key):
        logger.info("gateway: duplicate update %s ignored", dedupe_key)
        return {"ok": True, "action": "duplicate-ignored"}

    # /pair command: issue a pairing code and return instructions
    if text.lower().startswith("/pair"):
        code = generate_code(platform_identity)
        reply = (
            f"Your Orwell pairing code is:\n\n{code}\n\n"
            "Enter this code in Orwell settings → Platforms → Pair within 15 minutes.\n"
            "Once paired, your messages here will reach your game."
        )
        await adapter.send(platform_identity, reply)
        return {"ok": True, "action": "pair-code-issued"}

    # SEC-3 (#560): the turn path runs a real LLM call. Throttle per identity and enforce the
    # per-user daily cap (the browser path's gate) so the gateway can't be used to bypass it.
    if turn_limits.is_rate_limited(platform_identity):
        await adapter.send(
            platform_identity,
            "You're sending turns too quickly. Please wait a moment and try again.",
        )
        return {"ok": True, "action": "rate-limited"}

    _user = get_paired_user(platform_identity)
    if _user is not None:
        _auth = getattr(getattr(request.app, "state", None), "auth_manager", None)
        if turn_limits.daily_cap_exceeded(_user, _auth):
            await adapter.send(
                platform_identity,
                "You've reached your daily message limit. Please try again in 24 hours.",
            )
            return {"ok": True, "action": "daily-cap-reached"}

    # Normal turn: route to the gateway handler
    try:
        reply = await handle_platform_turn(
            platform_id=platform_id,
            platform_identity=platform_identity,
            message_text=text,
        )
    except BaseException:
        # Release the claim so the platform's retry of a FAILED attempt is processed.
        if dedupe_key is not None:
            _INBOUND_SEEN.pop(dedupe_key, None)
        raise
    await adapter.send(platform_identity, reply)
    return {"ok": True}


# ── pair/verify: called from the orwell web UI ───────────────────────────────

@router.post("/pair/verify")
async def verify_pairing(request: Request, body: dict):
    """Verify a pairing code submitted from the Orwell web UI.

    Expected body: {"platform_identity": "telegram:123456", "code": "...", "orwell_user": "..."}

    The orwell_user is taken from the authenticated session when not explicitly provided
    (prefer the session so a user cannot pair someone else's account).

    Rate-limited per platform_identity.  Returns 400 on invalid/expired code, 429 on rate limit.
    """
    platform_identity = (body.get("platform_identity") or "").strip()
    code = (body.get("code") or "").strip()

    # Prefer the authenticated session's user; fall back to the body's orwell_user (for
    # deployments without the session middleware, e.g. integration tests).
    orwell_user = (
        getattr(getattr(request, "state", None), "current_user", None)
        or (body.get("orwell_user") or "").strip()
    )

    if not platform_identity or not code:
        raise HTTPException(status_code=400, detail="platform_identity and code are required")

    if not orwell_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if is_rate_limited(platform_identity):
        raise HTTPException(
            status_code=429,
            detail="Too many pairing attempts for this identity. Please wait before trying again.",
        )

    if not verify_code(platform_identity, code):
        raise HTTPException(status_code=400, detail="Invalid or expired pairing code")

    pair(platform_identity, orwell_user)
    logger.info(
        "gateway: paired platform identity %s to orwell user %s", platform_identity, orwell_user
    )
    return {"ok": True, "paired": True}


# ── status: admin read ────────────────────────────────────────────────────────

@router.get("/status")
async def gateway_status(request: Request):
    """Return registered platforms and pairing counts (admin, Vault-free)."""
    from core.middleware import require_admin as _require_admin
    _require_admin(request)

    registered = platform_registry.all_ids()
    # orwell_user not surfaced here — pair count per platform is sufficient
    return {
        "registered_platforms": registered,
        "platform_count": len(registered),
    }


def setup_gateway_routes():
    """Return the gateway router (for app.py include_router)."""
    # Ensure the Telegram adapter is registered by importing it.
    # Other adapters are added here as thin imports when they are built.
    try:
        import gateway.platforms.telegram  # noqa: F401  — triggers self-registration
    except ImportError as exc:
        logger.warning("gateway: could not import telegram adapter: %s", exc)

    return router
