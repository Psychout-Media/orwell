"""Admin "Local HTTPS" routes (feature 0074 / ADR 0014).

The operator console over the on-box TLS terminator (Caddy), the sibling of
``admin_public_deployment_routes`` (which faces the *internet*). Three admin-gated routes let an admin
turn local HTTPS on/off from the UI — no SSH, no hand-edited ``data/.env``, no manual ``caddy``:

  * GET  /api/admin/tls-status      — the live local-TLS posture + caddy state + the CA-root download
    URL + the last apply (NEVER the DNS token).
  * POST /api/admin/tls/apply       — sanitise the proposed host names, then drop the non-secret config
    + the (transient, mode-0600) DNS API token + the existence-only flag the root ops watcher consumes.
  * POST /api/admin/tls/disconnect  — drop the disable flag (back to plain HTTP).

Boundaries / security (identical contract to the public-deployment lane):
  * Admin-gated by the shared ``require_admin`` (non-admin → 403).
  * Privilege-safe: the routes only write side files + an existence-only flag; the actual ``.env``
    upsert + ``caddy`` install/run + Caddyfile + FE restart happen in the root ops script the flag
    triggers (orwell-ops-tls.sh → orwell-https.sh). Fail-closed via ``_write_failed_status`` when no
    watcher is installed.
  * The DNS API token is WRITE-ONLY — accepted on apply, persisted transiently to
    ``data/ops/tls-dns-token`` (mode 0600), consumed + shredded by the root script, and NEVER echoed
    by any GET. Status reports configured-or-not, never the token.
  * Vault-free: pure operational plumbing — no game state is read or returned.

The DATA_DIR / data/ops resolution + the flag mechanism reuse ``admin_update_routes`` verbatim (the
same deploy data tree the public-deployment lane uses), so a missing root watcher fails loudly through
the same ops-progress channel the status page polls.
"""

import asyncio
import datetime as _dt
import json
import os
import shutil
import subprocess
from datetime import timezone

from fastapi import APIRouter, HTTPException, Request

from core.middleware import (
    DEFAULT_LOCAL_TLS_NAMES,
    control_char_fields,
    local_tls_names_from_env,
    require_admin,
    sanitize_tls_names,
    tls_mode_from_env,
)

# Reuse the Update lane's flag plumbing verbatim — the DATA_DIR / data/ops resolution, the
# existence-only flag drop, the watcher-installed probe, and the fail-loud ops-status writer.
from routes.admin_update_routes import (
    _ensure_ops_dir,
    _ops_dir,
    _write_failed_status,
)
from core.admin_guard import guard_root_op
from core.ops_watcher import inactive_reason, watcher_active

# The root path unit that consumes THIS lane's flag — its own unit, not the Update lane's. Overridable
# for tests/dev.
_WATCHER_UNIT = "/etc/systemd/system/orwell-ops-tls.path"


def _watcher_unit_path() -> str:
    return os.environ.get("ORWELL_TLS_WATCHER_UNIT") or _WATCHER_UNIT


def _watcher_ready() -> bool:
    """True iff the TLS path unit is installed AND active (see ``core.ops_watcher``)."""
    return watcher_active(_watcher_unit_path())

_TOKEN_FILE = "tls-dns-token"
_CONFIG_FILE = "tls.json"
_FLAG_FILE = "tls-requested"
_ACTION = "tls"


def _now_iso() -> str:
    return _dt.datetime.now(timezone.utc).isoformat()


def _trigger_tls_flag() -> dict:
    """Drop the existence-only ``tls-requested`` flag the root ops path unit watches. Mirrors
    ``admin_public_deployment_routes._trigger_public_flag``."""
    _ensure_ops_dir()
    flag = os.path.join(_ops_dir(), _FLAG_FILE)
    with open(flag, "w", encoding="utf-8") as fh:
        fh.write(_now_iso() + "\n")
    return {"started": True, "via": "flag-trigger", "log": "ops-tls.log"}


def _read_last_apply() -> dict | None:
    """Read ``data/ops/tls-status.json`` (the root script's progress/result). Never raises."""
    path = os.path.join(_ops_dir(), f"{_ACTION}-status.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _read_apply_config() -> dict | None:
    """Read the non-secret ``data/ops/tls.json`` from the last apply. Tolerates absence / bad JSON.
    Never the token."""
    path = os.path.join(_ops_dir(), _CONFIG_FILE)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _caddy_active() -> bool:
    """Read-only ``systemctl is-active caddy`` → True iff active. Any error (binary absent, not-root,
    no systemd) degrades to False — this NEVER mutates the service."""
    try:
        proc = subprocess.run(  # noqa: S603,S607 — fixed argv, no shell, no user input
            ["systemctl", "is-active", "caddy"],
            capture_output=True, text=True, timeout=5, check=False)
        return proc.stdout.strip() == "active"
    except Exception:
        return False


def _root_ca_present() -> bool:
    """True iff the exported local-CA root is on disk (data/tls/local-ca.crt) — i.e. there is a cert to
    download at /orwell-local-ca.crt. Resolved from the deploy data tree (DATA_DIR override honored)."""
    return os.path.isfile(os.path.join(os.path.dirname(_ops_dir()), "tls", "local-ca.crt"))


def setup_admin_tls_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin", tags=["admin_tls"])

    @router.get("/tls-status")
    async def tls_status(request: Request):
        """The live local-TLS posture + caddy state + last apply. Admin-only, read-only, Vault-free,
        and the DNS token is NEVER returned."""
        require_admin(request)
        env = os.environ
        cfg = _read_apply_config() or {}
        domains = cfg.get("domains") if isinstance(cfg.get("domains"), list) else []
        return {
            "mode": tls_mode_from_env(env),
            "localNames": local_tls_names_from_env(env),
            "domains": [str(d) for d in domains],
            "dnsProvider": (env.get("ORWELL_TLS_DNS_PROVIDER") or "").strip(),
            "dnsConfigured": bool((env.get("ORWELL_TLS_DNS_API_TOKEN") or "").strip()),
            "secureCookies": (env.get("SECURE_COOKIES", "false") or "").strip().lower() == "true",
            "caddy": {
                "installed": shutil.which("caddy") is not None,
                "active": await asyncio.to_thread(_caddy_active),
            },
            "rootCa": {
                "available": _root_ca_present(),
                "downloadUrl": "/orwell-local-ca.crt",
            },
            "lastApply": _read_last_apply(),
        }

    @router.post("/tls/apply")
    async def tls_apply(request: Request):
        """Sanitise the proposed names, then drop the non-secret config + the (optional) mode-0600 DNS
        token + the existence-only flag. Fails closed (400) on no valid host to cover."""
        await guard_root_op(request)
        body = await request.json() if await _has_body(request) else {}
        if not isinstance(body, dict):
            body = {}

        raw_local = body.get("localNames")
        raw_domains = body.get("domains")
        provided_any = bool(raw_local) or bool(raw_domains)

        # Every value below ends up in a side-file a ROOT script reads (names + provider become flags
        # for orwell-https.sh; the token becomes an env value). Reject control characters outright —
        # 400 naming the fields, nothing written — rather than silently trimming them.
        bad = control_char_fields(localNames=raw_local, domains=raw_domains,
                                  dnsProvider=body.get("dnsProvider"), dnsApiToken=body.get("dnsApiToken"))
        if bad:
            raise HTTPException(
                status_code=400,
                detail="Control characters (newlines, tabs, NUL, …) are not allowed in: " + ", ".join(bad))

        local_names = sanitize_tls_names(raw_local)
        domains = sanitize_tls_names(raw_domains)
        dns_provider = "".join(
            c for c in str(body.get("dnsProvider") or "").strip() if c.isalnum() or c in "._-")
        dns_token = body.get("dnsApiToken")

        # A domain block needs a DNS provider + token to get a publicly-trusted cert (DNS-01). Without
        # both, drop the domain (local names still work) rather than write a config that can't issue.
        if domains and not (dns_provider and dns_token):
            domains = []
            dns_provider = ""

        if not local_names and not domains:
            if provided_any:
                # The admin supplied host names but none survived sanitisation (or a public domain
                # carried no DNS token) — fail closed rather than silently covering something else.
                raise HTTPException(
                    status_code=400,
                    detail="No usable host names — check the names (a public domain also needs a "
                           "DNS provider + API token).")
            # A bare enable with no fields → cover the safe defaults (orwell.lan, orwell.local).
            local_names = list(DEFAULT_LOCAL_TLS_NAMES)

        # Nothing is written unless the root watcher is really running: an early return used to leave
        # the DNS token (and config) on disk with nobody to consume or shred them.
        if not _watcher_ready():
            reason = inactive_reason(_watcher_unit_path(), "apply local HTTPS")
            _write_failed_status(_ACTION, reason)
            return {"started": False, "via": "none", "error": reason, "log": "ops-tls.log"}

        _ensure_ops_dir()
        config = {
            "action": "apply",
            "mode": "local",
            "localNames": local_names,
            "domains": domains,
            "dnsProvider": dns_provider,
            "hasToken": bool(dns_token),
            "ts": _now_iso(),
        }
        config_path = os.path.join(_ops_dir(), _CONFIG_FILE)
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump(config, fh)

        # The DNS token is write-only: mode 0600, owned by the FE user, shredded by the root script.
        if dns_token:
            token_path = os.path.join(_ops_dir(), _TOKEN_FILE)
            fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, str(dns_token).encode("utf-8"))
            finally:
                os.close(fd)

        return _trigger_tls_flag()

    @router.post("/tls/disconnect")
    async def tls_disconnect(request: Request):
        """Back to plain HTTP: drop the disable config + the existence-only flag (the root script
        flips ORWELL_TLS_MODE off, disables caddy, restarts the FE)."""
        await guard_root_op(request)
        if not _watcher_ready():
            reason = inactive_reason(_watcher_unit_path(), "disable local HTTPS")
            _write_failed_status(_ACTION, reason)
            return {"started": False, "via": "none", "error": reason, "log": "ops-tls.log"}
        _ensure_ops_dir()
        config_path = os.path.join(_ops_dir(), _CONFIG_FILE)
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump({"action": "disable", "ts": _now_iso()}, fh)
        return _trigger_tls_flag()

    return router


async def _has_body(request: Request) -> bool:
    """True when the request carries a (non-empty) body to parse."""
    try:
        body = await request.body()
        return bool(body)
    except Exception:
        return False
