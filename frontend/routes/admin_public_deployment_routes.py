"""Admin "Public deployment / Connect to the internet" (feature 0068 / ADR 0007).

The operator console over the 0067 public-exposure floor. Three admin-gated routes let an admin
turn an internet-facing deployment on/off from the UI — no SSH, no hand-edited ``data/.env``, no
manual ``cloudflared``:

  * GET  /api/admin/public-deployment-status   — the live security posture + tunnel/cloudflared
    state + the last apply (NEVER the token).
  * POST /api/admin/public-deployment/apply    — build the proposed public-profile env, VALIDATE
    it at request time with ``assert_public_profile_safe`` (fail closed → 400 + named reason,
    writing NOTHING), then drop the non-secret config + the (transient, mode-0600) connector token
    + the existence-only flag the root ops watcher consumes.
  * POST /api/admin/public-deployment/disconnect — drop the disconnect flag (back to LAN-only).

Boundaries / security:
  * apply / disconnect are gated by ``core.admin_guard.guard_root_op`` (the strict root-op admin gate —
    NOT the blanket auth-off bypass of ``require_admin`` — plus a same-origin check); the read-only
    status route keeps ``require_admin``, like ``admin_update_routes`` / ``admin_ops_status_routes``.
  * Privilege-safe: the routes only write side files + an existence-only flag; the actual ``.env``
    upsert + ``cloudflared`` install/run + FE restart happen in the root ops script the flag triggers
    (modeled on the Update lane). Fail-closed via ``_write_failed_status`` when this lane's watcher is not
    installed AND active (nothing is written then — no token, no config, no flag).
  * The connector token is WRITE-ONLY — accepted on apply, persisted transiently to
    ``data/ops/cloudflared-token`` (mode 0600), consumed + shredded by the root script, and NEVER
    echoed by any GET. Status reports installed/active, never the token.
  * Vault-free: pure operational plumbing — no game state is read or returned.

The DATA_DIR / data/ops resolution is the SAME as ``admin_update_routes`` (the deploy data tree,
NOT frontend/data), and the flag mechanism reuses that module's ``_trigger_via_flag`` /
``_write_failed_status`` helpers (the watcher probe is this module's own ``_watcher_ready``, for ITS
unit, ``orwell-ops-public-deployment.path``) so a missing or stopped root watcher fails loudly
through the same ops-progress channel the status page polls.
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
    allowed_hosts_from_env,
    assert_public_profile_safe,
    control_char_fields,
    require_admin,
)

# Reuse the Update lane's flag plumbing verbatim — the DATA_DIR / data/ops resolution, the
# existence-only flag drop, the watcher-installed probe, and the fail-loud ops-status writer are
# action-agnostic (they take the action name as an argument or derive the dir the same way). This
# keeps the two ops lanes pointed at the IDENTICAL deploy data tree.
from routes.admin_update_routes import (
    _data_dir,
    _ensure_ops_dir,
    _ops_dir,
    _write_failed_status,
)
from core.admin_guard import guard_root_op
from core.ops_watcher import inactive_reason, watcher_active

# The root path unit that consumes THIS lane's flag — its own unit, not the Update lane's (the routes
# used to probe orwell-ops-update.path, so a missing/stopped public-deployment watcher still read as
# "installed"). Overridable for tests/dev.
_WATCHER_UNIT = "/etc/systemd/system/orwell-ops-public-deployment.path"


def _watcher_unit_path() -> str:
    return os.environ.get("ORWELL_PUBLIC_DEPLOYMENT_WATCHER_UNIT") or _WATCHER_UNIT


def _watcher_ready() -> bool:
    """True iff the public-deployment path unit is installed AND active (a flag dropped for a stopped
    watcher would sit unprocessed and fire whenever it next started)."""
    return watcher_active(_watcher_unit_path())

# The connector-token sidecar (mode 0600, owned orwell, shredded by the root script) and the
# non-secret desired-env config the root script reads.
_TOKEN_FILE = "cloudflared-token"
_CONFIG_FILE = "public-deployment.json"
_FLAG_FILE = "public-deployment-requested"
_ACTION = "public-deployment"


def _now_iso() -> str:
    return _dt.datetime.now(timezone.utc).isoformat()


def _env_truthy(value) -> bool:
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def _trigger_public_flag() -> dict:
    """Drop the existence-only ``public-deployment-requested`` flag the root ops path unit watches.

    Mirrors ``admin_update_routes._trigger_via_flag`` for THIS action. The content is ignored by the
    unit; we stamp a timestamp for human log readability only. Ensures ``data/ops/`` exists first."""
    _ensure_ops_dir()
    flag = os.path.join(_ops_dir(), _FLAG_FILE)
    with open(flag, "w", encoding="utf-8") as fh:
        fh.write(_now_iso() + "\n")
    return {"started": True, "via": "flag-trigger", "log": "ops-public-deployment.log"}


def _read_last_apply() -> dict | None:
    """Read ``data/ops/public-deployment-status.json`` (the root script's progress/result), tolerating
    absence / partial writes / bad JSON. Never raises — a poll mid-apply must not 500."""
    path = os.path.join(_ops_dir(), f"{_ACTION}-status.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _read_apply_config() -> dict | None:
    """Read the non-secret ``data/ops/public-deployment.json`` written on the last apply (for the
    stored domain → displayed public URL). Tolerates absence / bad JSON. Never the token."""
    path = os.path.join(_ops_dir(), _CONFIG_FILE)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    return raw if isinstance(raw, dict) else None


def _stored_public_url() -> str | None:
    """The displayed public URL = the admin's typed domain from the last apply (cloudflared
    remotely-managed doesn't expose the hostname locally). None when unknown. NEVER the token."""
    cfg = _read_apply_config()
    if not cfg:
        return None
    domains = cfg.get("domains")
    if isinstance(domains, list) and domains:
        first = str(domains[0]).strip()
        if first:
            return f"https://{first}"
    return None


def _cloudflared_active() -> bool:
    """Read-only ``systemctl is-active cloudflared`` → True iff active. Wrapped so any error (binary
    absent, not-root, no systemd) degrades to False — this NEVER mutates the service."""
    try:
        proc = subprocess.run(  # noqa: S603,S607 — fixed argv, no shell, no user input
            ["systemctl", "is-active", "cloudflared"],
            capture_output=True, text=True, timeout=5, check=False)
        return proc.stdout.strip() == "active"
    except Exception:
        return False


def setup_admin_public_deployment_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin", tags=["admin_public_deployment"])

    @router.get("/public-deployment-status")
    async def public_deployment_status(request: Request):
        """The live public-exposure posture + tunnel state + last apply. Admin-only, read-only,
        Vault-free, and the token is NEVER returned."""
        require_admin(request)
        env = os.environ
        allowed = allowed_hosts_from_env(env)
        return {
            "enabled": _env_truthy(env.get("ORWELL_PUBLIC")),
            "bindHost": env.get("ORWELL_BIND_HOST") or "127.0.0.1",
            "allowedHosts": allowed,
            "secureCookies": (env.get("SECURE_COOKIES", "false") or "").strip().lower() == "true",
            "authEnabled": (env.get("AUTH_ENABLED", "true") or "").strip().lower() != "false",
            "hostPinned": bool(allowed) and allowed != ["*"],
            "tunnel": {
                "installed": shutil.which("cloudflared") is not None,
                "active": await asyncio.to_thread(_cloudflared_active),
                "publicUrl": _stored_public_url(),
            },
            "lastApply": _read_last_apply(),
        }

    @router.post("/public-deployment/apply")
    async def public_deployment_apply(request: Request):
        """Validate the proposed public profile (fail closed → 400, writing NOTHING), then drop the
        non-secret config + the transient mode-0600 connector token + the existence-only flag."""
        await guard_root_op(request)
        body = await request.json() if await _has_body(request) else {}
        if not isinstance(body, dict):
            body = {}
        raw_domains = body.get("domains")
        domains = [str(d).strip() for d in raw_domains if str(d).strip()] \
            if isinstance(raw_domains, list) else []
        allowed_origins = body.get("allowedOrigins")
        tunnel_token = body.get("tunnelToken")

        # Every value below ends up in a side-file a ROOT script reads and writes into data/.env (or
        # hands to cloudflared). A newline would start a new KEY=VALUE line there, so reject control
        # characters outright — 400 naming the fields, nothing written.
        bad = control_char_fields(domains=raw_domains, allowedOrigins=allowed_origins,
                                  tunnelToken=tunnel_token)
        if bad:
            raise HTTPException(
                status_code=400,
                detail="Control characters (newlines, tabs, NUL, …) are not allowed in: " + ", ".join(bad))

        # DEPLOY-2 (B15): validate the box's REAL current ORWELL_BIND_HOST, not an absent key.
        # `proposed` never carried this key before, so assert_public_profile_safe's own
        # `env.get("ORWELL_BIND_HOST") or "127.0.0.1"` fallback always won regardless of what the
        # box was actually bound to — a pre-existing LAN-direct install (the installer's own
        # default is ORWELL_BIND_HOST=0.0.0.0) always validated "safe" here and stayed reachable
        # in plaintext on the public/wildcard interface after "going public". Sample the box's
        # actual current value the same way the status route above does.
        current_bind_host = os.environ.get("ORWELL_BIND_HOST") or "127.0.0.1"

        # The proposed public-profile env (the 0067 floor). ALLOWED_ORIGINS defaults to the first
        # domain's https origin when not given. An empty domains list yields ALLOWED_HOSTS="" → the
        # validator flags the unpinned host and we 400 before writing anything.
        proposed = {
            "ORWELL_PUBLIC": "1",
            "AUTH_ENABLED": "true",
            "LOCALHOST_BYPASS": "false",
            "ALLOWED_HOSTS": ",".join(domains),
            "ALLOWED_ORIGINS": (str(allowed_origins).strip() if allowed_origins
                                else (f"https://{domains[0]}" if domains else "")),
            "SECURE_COOKIES": "true",
            "ORWELL_BIND_HOST": current_bind_host,
        }

        # FAIL CLOSED at request time — never persist an unsafe combo. assert_public_profile_safe
        # raises RuntimeError naming every offending setting; surface it as 400 and WRITE NOTHING
        # (no flag, no config, no token).
        try:
            assert_public_profile_safe(proposed)
        except RuntimeError as e:
            raise HTTPException(status_code=400, detail=str(e))

        # Nothing is written unless the root watcher is really running: an early return used to leave
        # the connector token (and config) on disk with nobody to consume or shred them.
        if not _watcher_ready():
            reason = inactive_reason(_watcher_unit_path(), "apply the public deployment")
            _write_failed_status(_ACTION, reason)
            return {"started": False, "via": "none", "error": reason,
                    "log": "ops-public-deployment.log"}

        # Safe → write the non-secret desired env + the (optional) connector token + the flag.
        _ensure_ops_dir()
        config = {
            "action": "apply",
            "env": {
                "ORWELL_PUBLIC": proposed["ORWELL_PUBLIC"],
                "ALLOWED_HOSTS": proposed["ALLOWED_HOSTS"],
                "ALLOWED_ORIGINS": proposed["ALLOWED_ORIGINS"],
                "SECURE_COOKIES": proposed["SECURE_COOKIES"],
            },
            "domains": domains,
            "hasToken": bool(tunnel_token),
            "ts": _now_iso(),
        }
        config_path = os.path.join(_ops_dir(), _CONFIG_FILE)
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump(config, fh)

        # The connector token is write-only: mode 0600, owned by the FE user, shredded by the root
        # script. Open with O_CREAT|O_TRUNC and the explicit 0600 mode so it is never world/group
        # readable (umask cannot widen it). The raw token is the file's only content.
        if tunnel_token:
            token_path = os.path.join(_ops_dir(), _TOKEN_FILE)
            fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            try:
                os.write(fd, str(tunnel_token).encode("utf-8"))
            finally:
                os.close(fd)

        # Trigger the root ops lane via the existence-only flag (the watcher was verified above).
        return _trigger_public_flag()

    @router.post("/public-deployment/disconnect")
    async def public_deployment_disconnect(request: Request):
        """Back to LAN-only: drop the disconnect config + the existence-only flag (the root script
        flips ORWELL_PUBLIC off, disables cloudflared, restarts the FE)."""
        await guard_root_op(request)
        if not _watcher_ready():
            reason = inactive_reason(_watcher_unit_path(), "disconnect")
            _write_failed_status(_ACTION, reason)
            return {"started": False, "via": "none", "error": reason,
                    "log": "ops-public-deployment.log"}
        _ensure_ops_dir()
        config_path = os.path.join(_ops_dir(), _CONFIG_FILE)
        with open(config_path, "w", encoding="utf-8") as fh:
            json.dump({"action": "disconnect", "ts": _now_iso()}, fh)
        return _trigger_public_flag()

    return router


async def _has_body(request: Request) -> bool:
    """True when the request carries a (non-empty) body to parse. Lets apply accept an absent body
    (→ empty domains → the validator 400s) instead of raising a JSON-decode error."""
    try:
        body = await request.body()
        return bool(body)
    except Exception:
        return False
