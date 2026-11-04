"""Guards for admin routes that trigger ROOT operations (reset / update / TLS / public exposure).

Three independent layers, each fail-closed, applied in this order by :func:`guard_root_op`:

1. :func:`require_root_ops` — who may ask. Modeled on ``middleware.require_vault_reveal``: unlike
   ``require_admin`` it does NOT treat ``AUTH_ENABLED=false`` as "everyone is an admin".
2. :func:`require_same_origin` — where the request came from. The session cookie is only
   ``SameSite=Lax``, so a state-changing request must also prove it was issued by this deployment's
   own pages (``Origin`` / ``Referer`` / ``Sec-Fetch-Site``), not merely carry the cookie.
3. :func:`require_confirmation` — that the caller meant it. Destructive routes need a server-side
   ``confirm`` field in the JSON body (the UI's typed "RESET" is no longer the only check).

Kept out of ``core.middleware`` so the guards do not share an import block with the route modules'
other middleware helpers.
"""

import ipaddress
import json
import os
import secrets
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

from core.middleware import (
    INTERNAL_TOOL_HEADER,
    INTERNAL_TOOL_TOKEN,
    is_trusted_loopback,
)

CONFIRM_FIELD = "confirm"
RESET_PHRASE = "RESET"

# Operator opt-in for a root-op route on an auth-OFF box that is NOT reached by a direct loopback
# connection (e.g. a same-host reverse proxy in front of an auth-off install). Off by default.
ROOT_OPS_NO_AUTH_ENV = "ORWELL_ROOT_OPS_WITHOUT_AUTH"

_DEFAULT_PORTS = {"http": "80", "https": "443"}


def _truthy(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _has_internal_token(request: Request) -> bool:
    try:
        hdr = request.headers.get(INTERNAL_TOOL_HEADER)
        if hdr and secrets.compare_digest(hdr.encode("utf-8"), INTERNAL_TOOL_TOKEN.encode("utf-8")):
            return True
        return getattr(request.state, "current_user", None) == "internal-tool"
    except Exception:
        return False


def _host_is_loopback(request: Request) -> bool:
    """True iff the Host header names a loopback address (``localhost`` / ``127.0.0.0/8`` / ``::1``).

    A DNS-rebinding page is served from an attacker hostname that is re-pointed at 127.0.0.1: the TCP
    peer is loopback and Origin/Host match each other, yet the Host header is the ATTACKER's name. So a
    direct-loopback peer alone is not proof the request came from a page on this machine."""
    raw = (request.headers.get("host") or "").strip().lower()
    if raw.startswith("["):                       # [::1]:8080
        host = raw[1:].split("]", 1)[0]
    else:
        host = raw.rsplit(":", 1)[0] if raw.count(":") == 1 else raw
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def require_root_ops(request: Request) -> None:
    """403 unless the caller may trigger a root operation.

    * the in-process internal-tool token → allowed (a process secret, not attacker-reachable);
    * ``AUTH_ENABLED`` on → a genuine authenticated admin session is required;
    * ``AUTH_ENABLED=false`` (no admin identity exists) → allowed ONLY for a DIRECT loopback
      connection (no proxy/tunnel forwarding headers) whose Host header ALSO names a loopback address
      (DNS-rebinding defence) — the one place auth-off is permitted to run
      (``assert_auth_off_requires_loopback``) — or when the operator set
      ``ORWELL_ROOT_OPS_WITHOUT_AUTH=1`` in data/.env. Anything else is refused.
    """
    if _has_internal_token(request):
        return
    auth_mgr = getattr(request.app.state, "auth_manager", None)
    user = getattr(request.state, "current_user", None)
    if user and auth_mgr is not None and getattr(auth_mgr, "is_configured", False) \
            and auth_mgr.is_admin(user):
        return
    if os.getenv("AUTH_ENABLED", "true").strip().lower() == "false":
        if (is_trusted_loopback(request) and _host_is_loopback(request)) \
                or _truthy(os.getenv(ROOT_OPS_NO_AUTH_ENV)):
            return
        raise HTTPException(
            403,
            "Root operations are unavailable with authentication disabled unless the request comes "
            "directly from this machine. Enable authentication (AUTH_ENABLED=true), use the host "
            f"console, or set {ROOT_OPS_NO_AUTH_ENV}=1 in data/.env if you accept that risk.")
    raise HTTPException(403, "Admin only")


def _origin_authority(value: str):
    """``(scheme, host[:port])`` of an Origin/Referer value with the scheme's default port dropped,
    or None when it is opaque (``null``) or unparseable."""
    try:
        parts = urlsplit((value or "").strip())
        scheme, host = parts.scheme.lower(), (parts.hostname or "").lower()
        if scheme not in ("http", "https") or not host:
            return None
        port = parts.port
    except ValueError:
        return None
    if ":" in host:
        host = f"[{host}]"
    if port is not None and str(port) != _DEFAULT_PORTS[scheme]:
        host = f"{host}:{port}"
    return scheme, host


def _host_authority(value: str, scheme: str) -> str:
    """Normalise a Host / X-Forwarded-Host header the same way as an Origin authority."""
    value = (value or "").split(",")[0].strip().lower()
    default = _DEFAULT_PORTS.get(scheme, "")
    if default and value.endswith(":" + default):
        value = value[: -(len(default) + 1)]
    return value


def _allowed_origin_authorities() -> set:
    out = set()
    for raw in (os.getenv("ALLOWED_ORIGINS", "") or "").split(","):
        auth = _origin_authority(raw)
        if auth:
            out.add(auth)
    return out


def _same_origin(request: Request, origin: str) -> bool:
    auth = _origin_authority(origin)
    if auth is None:
        return False
    scheme, host = auth
    # The host the browser used: the Host header (plain HTTP on a LAN IP) or, behind a proxy that
    # rewrites Host, the forwarded one. A browser cannot forge either.
    for header in ("host", "x-forwarded-host"):
        seen = request.headers.get(header)
        if seen and _host_authority(seen, scheme) == host:
            return True
    return auth in _allowed_origin_authorities()


def require_same_origin(request: Request) -> None:
    """403 when a state-changing request did not come from this deployment's own pages.

    Rule: ``Sec-Fetch-Site: cross-site`` is refused; a present ``Origin`` (else ``Referer``) must name
    this deployment (its Host / X-Forwarded-Host, scheme-agnostic so plain HTTP by LAN IP works and a
    TLS-terminating proxy that rewrites the scheme still matches) or be listed in ``ALLOWED_ORIGINS``.
    No ``Origin`` and no ``Referer`` is a non-browser client (curl, the loopback tool layer), which
    never auto-attaches a victim's cookie, so it is allowed — it still needs the admin gate above.
    """
    if _has_internal_token(request):
        return
    fetch_site = (request.headers.get("sec-fetch-site") or "").strip().lower()
    if fetch_site == "cross-site":
        raise HTTPException(403, "Cross-origin request refused")
    origin = request.headers.get("origin")
    if origin is None:
        referer = request.headers.get("referer")
        if not referer:
            return
        origin = referer
    if not _same_origin(request, origin):
        raise HTTPException(
            403,
            "Cross-origin request refused. If you reach Orwell through a reverse proxy, add its public "
            "address to ALLOWED_ORIGINS (or have the proxy pass the original Host header).")


async def _json_body(request: Request) -> dict:
    try:
        raw = await request.body()
        body = json.loads(raw) if raw else {}
    except (ValueError, UnicodeDecodeError):
        return {}
    return body if isinstance(body, dict) else {}


async def require_confirmation(request: Request, phrase: str = RESET_PHRASE) -> None:
    """400 unless the JSON body carries ``{"confirm": <phrase>}`` (exact match after trimming)."""
    body = await _json_body(request)
    given = body.get(CONFIRM_FIELD)
    # compare UTF-8 bytes: compare_digest raises TypeError on a non-ASCII str, which would be a 500, not a 400
    if not isinstance(given, str) or not secrets.compare_digest(given.strip().encode("utf-8"), phrase.encode("utf-8")):
        raise HTTPException(
            400, f'Confirmation required: send {{"{CONFIRM_FIELD}": "{phrase}"}} to run this action.')


async def guard_root_op(request: Request, *, confirm: str | None = None) -> None:
    """The full guard for a root-operation trigger: who, where from, and (if ``confirm``) intent."""
    require_root_ops(request)
    require_same_origin(request)
    if confirm:
        await require_confirmation(request, confirm)
