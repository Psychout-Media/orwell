"""Admin Factory Reset (OOBE) — return the whole app to exact first-run state, KEEP API keys.

The operator's "clear everything and start clean" button. A single admin-gated endpoint
triggers the FIXED deploy reset (``orwell-oobe-reset.sh``) which stops both services, wipes
ALL accounts / chats / sessions / memory / MCP configs / uploads / every user setting and
every engine game sandbox, then restarts at OOBE — PRESERVING only the LLM / image provider
config (the keys an operator should never have to re-enter) and never touching ``data/.env``.

This mirrors ``admin_update_routes.py`` exactly (same privilege model, same flag trigger):

Boundaries / security:
  * Gated by ``core.admin_guard.guard_root_op``: an authenticated admin (the strict root-op gate, NOT
    the blanket auth-off bypass of ``require_admin``), a same-origin request, and a server-checked
    ``{"confirm": "RESET"}`` body field.
  * The command is FIXED — there is NO user input in the argv. The script PATH is overridable
    by ``ORWELL_OOBE_RESET_SCRIPT`` (default ``/opt/orwell/deploy/orwell-oobe-reset.sh``)
    purely so tests/dev never shell out to a real host path; the web tier never chooses WHAT
    runs, only WHEN.
  * Vault-free: pure operational plumbing — no game state is read or returned.
  * Destructive — the button on the status page demands an explicit type-"RESET" confirmation
    BEFORE it ever posts here; this endpoint additionally re-checks admin on the server.

Privilege model (identical to the update button — see ``admin_update_routes.py``):
  The FE runs inside the E85-hardened ``orwell-frontend.service`` and CANNOT stop services or
  remove ``/opt`` files on its own. Two supported ways, in priority order:

    1. The root-side flag trigger (G19b pattern): the FE drops
       ``data/ops/factory-reset-requested`` and the root ``orwell-ops-factory-reset.path``
       unit runs the reset. Zero privilege held by the web tier; survives the self-restart
       natively. Used automatically when that unit is installed (``data/ops/`` exists) unless
       ``ORWELL_OOBE_RESET_DIRECT=1`` forces the detached Popen path.
    2. A detached, fixed-argv ``Popen`` fallback (optionally ``sudo -n`` wrapped via
       ``ORWELL_OOBE_RESET_SUDO=1``) for dev / non-flag installs.
"""

import asyncio
import datetime as _dt
import logging
import os
import shlex
import subprocess
from datetime import timezone

from fastapi import APIRouter, Request

from core.admin_guard import RESET_PHRASE, guard_root_op
from core.ops_watcher import inactive_reason, watcher_active
from src.auth_helpers import effective_user

logger = logging.getLogger(__name__)

# The FIXED reset path — overridable ONLY so tests/dev don't touch a real host path. There is
# never any user input interpolated into the command; this is the single, complete argv source.
DEFAULT_RESET_SCRIPT = "/opt/orwell/deploy/orwell-oobe-reset.sh"
DEFAULT_RESET_LOG = "/opt/orwell/data/ops-factory-reset.log"

# The existence-only flag the root path unit watches (see deploy/systemd/orwell-ops-factory-reset.*).
FLAG_NAME = "factory-reset-requested"


def _reset_script() -> str:
    return os.environ.get("ORWELL_OOBE_RESET_SCRIPT") or DEFAULT_RESET_SCRIPT


def _reset_log() -> str:
    return os.environ.get("ORWELL_OOBE_RESET_LOG") or DEFAULT_RESET_LOG


def _data_dir() -> str:
    # The DEPLOY data dir (e.g. /opt/orwell/data): where the root-side systemd ops path units
    # watch data/ops/<flag>, where the installer creates data/ops, and where ops-*.log live. It
    # is the deploy tree — NOT the front-end app-data dir (frontend/data), a DIFFERENT tree only
    # two levels up from here. Resolving to frontend/data was the bug: the FE dropped the trigger
    # flag where no root watcher ever looked, so the button reported success while nothing ran.
    # Three dirnames up (frontend/routes/<file> -> APP_DIR) + /data. DATA_DIR overrides (tests/dev).
    return os.environ.get("DATA_DIR") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data")


def _ops_dir() -> str:
    return os.path.join(_data_dir(), "ops")


# The root-side path unit that consumes the flag and runs the reset AS ROOT (deploy/systemd).
# Its presence is the TRUE signal that dropping a flag will actually do something — without it,
# a flag is written and nothing ever consumes it (the old silent no-op). Overridable for tests.
_WATCHER_UNIT = "/etc/systemd/system/orwell-ops-factory-reset.path"


def _watcher_unit_path() -> str:
    return os.environ.get("ORWELL_OOBE_RESET_WATCHER_UNIT") or _WATCHER_UNIT


def _watcher_installed() -> bool:
    """True when the root-side path unit is installed AND ACTIVE — the only privileged door that
    actually runs the reset with root (the unit watches ``data/ops/<flag>`` and runs the script as
    root). A unit file alone is not enough: a stopped/disabled ``.path`` unit leaves the flag unread
    until it next starts, so "started" would be a lie (and the reset would fire at a time nobody chose)."""
    return watcher_active(_watcher_unit_path())


def _flag_trigger_installed() -> bool:
    """True ONLY when the root-side path watcher unit is actually installed — the lone privileged
    door that genuinely runs the reset as root.

    A bare ``data/ops/`` dir is NOT proof: the installer creates ``data/ops/`` for the UPDATE lane
    on EVERY box, so the old ``or os.path.isdir(_ops_dir())`` clause made a missing reset watcher
    look 'installed' — the flag got written, nothing consumed it, and the button silently no-opped
    ('completes too quickly'). Requiring the unit lets a watcher-less box fall through to a genuine
    privileged path (sudo/direct) or FAIL LOUDLY, instead of pretending the reset ran."""
    return _watcher_installed()


def _ensure_ops_dir() -> bool:
    """Create ``data/ops/`` if missing so the flag can be dropped. Best-effort: returns whether the
    dir exists afterwards (the non-root FE may fail to create it if the parent isn't writable)."""
    ops = _ops_dir()
    try:
        os.makedirs(ops, exist_ok=True)
    except OSError:
        pass
    return os.path.isdir(ops)


def _trigger_via_flag() -> dict:
    """Drop the existence-only flag the root ``orwell-ops-factory-reset.path`` unit watches.
    The content is ignored by the unit; we stamp a timestamp for human log readability only.
    Ensures ``data/ops/`` exists first (so a fresh box / a box that just gained the units works)."""
    _ensure_ops_dir()
    ops = _ops_dir()
    flag = os.path.join(ops, FLAG_NAME)
    with open(flag, "w", encoding="utf-8") as fh:
        fh.write(_dt.datetime.now(timezone.utc).isoformat() + "\n")
    return {"started": True, "via": "flag-trigger", "log": "ops-factory-reset.log"}


def _write_failed_status(action: str, reason: str) -> None:
    """FAIL LOUDLY through the same ops-progress channel the status page polls: stamp
    ``data/ops/<action>-status.json`` with a terminal FAILED entry so the UI surfaces the error
    instead of the old silent "triggered" no-op. Best-effort — never raises into the request."""
    if not _ensure_ops_dir():
        return
    payload = {
        "action": action, "step": 0, "total": 0,
        "message": f"FAILED: {reason}", "running": False, "ok": False,
        "error": reason, "ts": _dt.datetime.now(timezone.utc).isoformat(),
    }
    import json as _json
    path = os.path.join(_ops_dir(), f"{action}-status.json")
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            _json.dump(payload, fh)
        os.replace(tmp, path)
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass


def _run_detached() -> dict:
    """Launch the FIXED reset detached (its own session/process group) so restarting
    ``orwell-frontend`` mid-run does not kill it, streaming output to the reset log. Returns
    immediately — the caller never awaits completion (the restart would kill the request)."""
    script = _reset_script()
    log_path = _reset_log()
    # No user input in argv. The reset runs NON-INTERACTIVELY (--yes): the type-"RESET"
    # confirmation already happened in the browser. Optionally sudo-wrap for non-root dev.
    argv = ["bash", script, "--yes"]
    if os.environ.get("ORWELL_OOBE_RESET_SUDO", "").lower() in ("1", "true", "yes"):
        argv = ["sudo", "-n", *argv]
    try:
        os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
    except OSError:
        pass
    log = open(log_path, "ab")
    log.write(
        (f"\n== orwell OOBE reset · {_dt.datetime.now(timezone.utc).isoformat()} "
         f"({' '.join(shlex.quote(a) for a in argv)}) ==\n").encode("utf-8"))
    log.flush()
    subprocess.Popen(  # noqa: S603 — fixed argv, no shell, no user input
        argv, cwd=os.path.dirname(script) or None,
        stdout=log, stderr=log, stdin=subprocess.DEVNULL,
        start_new_session=True, close_fds=True)
    log.close()
    return {"started": True, "via": "detached", "log": os.path.basename(log_path)}


def setup_admin_reset_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin", tags=["admin_reset"])

    @router.post("/factory-reset")
    async def admin_factory_reset(request: Request):
        """Run the OOBE reset (wipe everything to first-run, KEEP the API-key/LLM config).

        Admin-only. Returns ``{started: true}`` IMMEDIATELY — never blocks on completion (the
        reset restarts this process). Prefers the privilege-safe root flag trigger when
        installed; otherwise launches the fixed script detached (optionally sudo-wrapped).

        Destructive: the status-page button asks for a typed "RESET" and sends it as
        ``{"confirm": "RESET"}``; this endpoint REQUIRES that field server-side (400 without it), and
        re-checks admin (``require_root_ops``) and same-origin regardless of the UI."""
        await guard_root_op(request, confirm=RESET_PHRASE)
        who = None
        try:
            who = effective_user(request)
        except Exception:
            pass
        force_direct = os.environ.get("ORWELL_OOBE_RESET_DIRECT", "").lower() in ("1", "true", "yes")
        has_sudo = os.environ.get("ORWELL_OOBE_RESET_SUDO", "").lower() in ("1", "true", "yes")

        # PRIVILEGE FIX (ops-run lane): the reset MUST run with root. The privilege-safe door is
        # the root-side flag watcher (G19b) — prefer it whenever it is usable, creating data/ops/
        # first so a box that just gained the watcher units (e.g. via the update button) works.
        flag_error = None   # set when the watcher is active but the trigger flag could not be written
        # off the event loop: the watcher probe shells out to `systemctl is-active` (up to 5 s)
        if await asyncio.to_thread(_flag_trigger_installed) and not force_direct:
            _ensure_ops_dir()
            logger.info("[factory-reset] admin '%s' triggered OOBE reset via the root flag trigger", who)
            try:
                return _trigger_via_flag()
            except OSError as e:
                logger.warning("[factory-reset] flag trigger failed (%s); evaluating detached run", e)
                flag_error = e

        # The detached Popen runs the script AS THE NON-ROOT FE USER — which the script's root-guard
        # aborts before scrubbing anything (this was the silent-no-op bug). So only take it when a
        # genuine privileged path exists: ORWELL_OOBE_RESET_SUDO=1 (the scoped sudoers drop-in) or an
        # explicit ORWELL_OOBE_RESET_DIRECT=1 override (dev / a box the operator vouches is root-able).
        if has_sudo or force_direct:
            logger.info("[factory-reset] admin '%s' triggered OOBE reset via detached run of %s",
                        who, _reset_script())
            return _run_detached()

        # FAIL LOUDLY — no privileged path is available. Surface the error through the same
        # ops-progress channel the status page polls, so it is visible instead of a silent no-op.
        if flag_error is not None:
            reason = (f"cannot run the reset — the watcher is running but the trigger flag could not be written "
                      f"({flag_error}); nothing was queued.")
        else:
            reason = inactive_reason(_watcher_unit_path(), "run the reset")
        reason += " Sudo is not enabled either (ORWELL_OOBE_RESET_SUDO=1)."
        logger.error("[factory-reset] admin '%s' could NOT start the OOBE reset: %s", who, reason)
        _write_failed_status("factory-reset", reason)
        return {"started": False, "via": "none", "error": reason}

    return router
