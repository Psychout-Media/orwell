"""Admin Update + Reset — pull latest + rebuild, THEN reset to OOBE, KEEP the API-key/LLM config.

The operator's combined "freshen the build AND start clean" button — the middle of the three
maintenance controls (Update · Update + Reset · Reset). A single admin-gated endpoint triggers the
FIXED deploy script (``orwell-update-reset.sh``) which COMPOSES the two existing scripts: it runs
the update (pull → rebuild engine → refresh FE deps, restart suppressed) and ONLY IF that succeeds
proceeds to the OOBE reset (wipe to first-run, PRESERVING the LLM / image provider config, never
touching ``data/.env``), ending in the single final restart. Fail-closed: a failed update leaves
the box on its previous build and wipes NOTHING.

This mirrors ``admin_update_routes.py`` / ``admin_reset_routes.py`` exactly (same privilege model,
same flag trigger):

Boundaries / security:
  * Admin-gated by the shared ``require_admin`` contract (a non-admin gets 403), exactly like
    ``admin_update_routes`` / ``admin_reset_routes`` / ``admin_health_routes``.
  * The command is FIXED — there is NO user input in the argv. The script PATH is overridable by
    ``ORWELL_UPDATE_RESET_SCRIPT`` (default ``/opt/orwell/deploy/orwell-update-reset.sh``) purely
    so tests/dev never shell out to a real host path; the web tier never chooses WHAT runs, only
    WHEN.
  * Vault-free: pure operational plumbing — no game state is read or returned.
  * Destructive — the button on the status page demands an explicit type-"RESET" confirmation
    BEFORE it ever posts here; this endpoint additionally re-checks admin on the server.

Privilege model (identical to the other two buttons — see ``admin_update_routes.py``):
  The FE runs inside the E85-hardened ``orwell-frontend.service`` and CANNOT git pull, rebuild,
  stop/restart services, or remove ``/opt`` files on its own. Two supported ways, in priority
  order:

    1. The root-side flag trigger (G19b pattern): the FE drops
       ``data/ops/update-reset-requested`` and the root ``orwell-ops-update-reset.path`` unit runs
       the combined script. Zero privilege held by the web tier; survives the self-restart
       natively. Used automatically when that unit is installed (``data/ops/`` exists) unless
       ``ORWELL_UPDATE_RESET_DIRECT=1`` forces the detached Popen path.
    2. A detached, fixed-argv ``Popen`` fallback (optionally ``sudo -n`` wrapped via
       ``ORWELL_UPDATE_RESET_SUDO=1``) for dev / non-flag installs.
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

# The FIXED combined script path — overridable ONLY so tests/dev don't touch a real host path.
# There is never any user input interpolated into the command; this is the single, complete argv
# source.
DEFAULT_UPDATE_RESET_SCRIPT = "/opt/orwell/deploy/orwell-update-reset.sh"
DEFAULT_UPDATE_RESET_LOG = "/opt/orwell/data/ops-update-reset.log"

# The existence-only flag the root path unit watches (see deploy/systemd/orwell-ops-update-reset.*).
FLAG_NAME = "update-reset-requested"


def _script() -> str:
    return os.environ.get("ORWELL_UPDATE_RESET_SCRIPT") or DEFAULT_UPDATE_RESET_SCRIPT


def _log() -> str:
    return os.environ.get("ORWELL_UPDATE_RESET_LOG") or DEFAULT_UPDATE_RESET_LOG


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


# The root-side path unit that consumes the flag and runs the combined script AS ROOT.
# Its presence is the TRUE signal that dropping a flag does something. Overridable for tests.
_WATCHER_UNIT = "/etc/systemd/system/orwell-ops-update-reset.path"


def _watcher_unit_path() -> str:
    return os.environ.get("ORWELL_UPDATE_RESET_WATCHER_UNIT") or _WATCHER_UNIT


def _watcher_installed() -> bool:
    """True when the root-side path unit is installed AND ACTIVE — the privileged door that runs the
    combined Update + Reset with root (the unit watches ``data/ops/<flag>`` and runs the script as
    root). A stopped/disabled unit would leave the flag unread until it next starts."""
    return watcher_active(_watcher_unit_path())


def _flag_trigger_installed() -> bool:
    """True ONLY when the root-side path watcher unit is actually installed — the lone privileged
    door that genuinely runs the combined Update + Reset as root.

    A bare ``data/ops/`` dir is NOT proof: the installer creates ``data/ops/`` for the UPDATE lane
    on EVERY box, so the old ``or os.path.isdir(_ops_dir())`` clause made a missing watcher look
    'installed' — the flag got written, nothing consumed it, and the button silently no-opped
    ('completes too quickly'). Requiring the unit lets a watcher-less box fall through to a genuine
    privileged path (sudo/direct) or FAIL LOUDLY, instead of pretending the action ran."""
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
    """Drop the existence-only flag the root ``orwell-ops-update-reset.path`` unit watches.
    The content is ignored by the unit; we stamp a timestamp for human log readability only.
    Ensures ``data/ops/`` exists first (so a box that just gained the units works)."""
    _ensure_ops_dir()
    ops = _ops_dir()
    flag = os.path.join(ops, FLAG_NAME)
    with open(flag, "w", encoding="utf-8") as fh:
        fh.write(_dt.datetime.now(timezone.utc).isoformat() + "\n")
    return {"started": True, "via": "flag-trigger", "log": "ops-update-reset.log"}


def _write_failed_status(action: str, reason: str) -> None:
    """FAIL LOUDLY through the ops-progress channel the status page polls: stamp
    ``data/ops/<action>-status.json`` with a terminal FAILED entry so the UI surfaces the error
    instead of a silent no-op. Best-effort — never raises into the request."""
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
    """Launch the FIXED combined script detached (its own session/process group) so restarting
    ``orwell-frontend`` mid-run does not kill it, streaming output to the run log. Returns
    immediately — the caller never awaits completion (the restart would kill the request)."""
    script = _script()
    log_path = _log()
    # No user input in argv. The combined script runs NON-INTERACTIVELY (--yes): the type-"RESET"
    # confirmation already happened in the browser. It is fail-closed (a failed update never wipes).
    # Optionally sudo-wrap for non-root dev.
    argv = ["bash", script, "--yes"]
    if os.environ.get("ORWELL_UPDATE_RESET_SUDO", "").lower() in ("1", "true", "yes"):
        argv = ["sudo", "-n", *argv]
    try:
        os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
    except OSError:
        pass
    log = open(log_path, "ab")
    log.write(
        (f"\n== orwell update + reset · {_dt.datetime.now(timezone.utc).isoformat()} "
         f"({' '.join(shlex.quote(a) for a in argv)}) ==\n").encode("utf-8"))
    log.flush()
    subprocess.Popen(  # noqa: S603 — fixed argv, no shell, no user input
        argv, cwd=os.path.dirname(script) or None,
        stdout=log, stderr=log, stdin=subprocess.DEVNULL,
        start_new_session=True, close_fds=True)
    log.close()
    return {"started": True, "via": "detached", "log": os.path.basename(log_path)}


def setup_admin_update_reset_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin", tags=["admin_update_reset"])

    @router.post("/update-reset")
    async def admin_update_reset(request: Request):
        """Run the combined Update + Reset (pull + rebuild, THEN reset to OOBE, KEEP API keys).

        Admin-only. Returns ``{started: true}`` IMMEDIATELY — never blocks on completion (the run
        restarts this process). Prefers the privilege-safe root flag trigger when installed;
        otherwise launches the fixed script detached (optionally sudo-wrapped).

        Destructive: the status-page button asks for a typed "RESET" and sends it as
        ``{"confirm": "RESET"}``; this endpoint REQUIRES that field server-side (400 without it), and
        re-checks admin (``require_root_ops``) and same-origin regardless of the UI."""
        await guard_root_op(request, confirm=RESET_PHRASE)
        who = None
        try:
            who = effective_user(request)
        except Exception:
            pass
        force_direct = os.environ.get("ORWELL_UPDATE_RESET_DIRECT", "").lower() in ("1", "true", "yes")
        has_sudo = os.environ.get("ORWELL_UPDATE_RESET_SUDO", "").lower() in ("1", "true", "yes")

        # PRIVILEGE FIX (ops-run lane): prefer the root-side flag watcher (G19b) — the only door that
        # runs the combined script with root. Create data/ops/ first so a box that just gained the
        # watcher units works on the very next click.
        flag_error = None   # set when the watcher is active but the trigger flag could not be written
        # off the event loop: the watcher probe shells out to `systemctl is-active` (up to 5 s)
        if await asyncio.to_thread(_flag_trigger_installed) and not force_direct:
            _ensure_ops_dir()
            logger.info("[update-reset] admin '%s' triggered Update + Reset via the root flag trigger", who)
            try:
                return _trigger_via_flag()
            except OSError as e:
                logger.warning("[update-reset] flag trigger failed (%s); evaluating detached run", e)
                flag_error = e

        # The detached Popen runs as the NON-ROOT FE user, which EPERMs / aborts on the run-as-root
        # guard — the silent no-op. Only take it with a genuine privileged path.
        if has_sudo or force_direct:
            logger.info("[update-reset] admin '%s' triggered Update + Reset via detached run of %s",
                        who, _script())
            return _run_detached()

        # FAIL LOUDLY — no privileged path. Surface it through the ops-progress channel the status
        # page polls so the operator sees the error instead of a silent "started" that never runs.
        if flag_error is not None:
            reason = (f"cannot run Update + Reset — the watcher is running but the trigger flag could not be written "
                      f"({flag_error}); nothing was queued.")
        else:
            reason = inactive_reason(_watcher_unit_path(), "run Update + Reset")
        reason += " Sudo is not enabled either (ORWELL_UPDATE_RESET_SUDO=1)."
        logger.error("[update-reset] admin '%s' could NOT start Update + Reset: %s", who, reason)
        _write_failed_status("update-reset", reason)
        return {"started": False, "via": "none", "error": reason}

    return router
