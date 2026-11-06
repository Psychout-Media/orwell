"""Admin one-click Update — pull latest → rebuild engine → refresh FE deps → restart both.

The operator's deploy-merged-fixes button. A single admin-gated endpoint runs the FIXED
deploy updater (``orwell-update.sh``) DETACHED and returns immediately — the script restarts
``orwell-frontend`` (this very process) and ``orwell-engine`` mid-flight, so the request would
be killed if it blocked. The button on the admin status page (``/admin/status`` OPS section)
posts here, then polls ``/api/admin/health`` and reloads once the box is back.

Boundaries / security:
  * Admin-gated by the shared ``require_admin`` contract (a non-admin gets 403), exactly like
    ``admin_health_routes`` / ``admin_transcript_routes``.
  * The command is FIXED — there is no user input in the argv. The script PATH is overridable
    by ``ORWELL_UPDATE_SCRIPT`` (default ``/opt/orwell/deploy/orwell-update.sh``) purely so
    tests/dev never shell out to a real host path; the web tier never chooses WHAT runs.
  * Vault-free: this is pure operational plumbing — no game state is read or returned.

Privilege model (see the PR notes + ``deploy/sudoers/orwell-update``):
  The FE runs inside the E85-hardened ``orwell-frontend.service`` (``User=orwell``,
  ``NoNewPrivileges=yes``, empty ``CapabilityBoundingSet=``, ``ProtectSystem=strict``). That
  user CANNOT ``git pull`` into ``/opt/orwell``, write ``/etc/systemd``, or ``systemctl
  restart`` on its own — so a bare ``bash orwell-update.sh`` would EPERM partway through. Two
  supported ways to grant exactly the needed privilege, in priority order:

    1. The root-side flag trigger (G19b): the FE drops ``data/ops/update-requested`` and the
       root ``orwell-ops-update.path`` unit runs the script. Zero privilege held by the web
       tier; survives the self-restart natively. Used automatically when that unit is
       installed (``data/ops/`` exists) unless ``ORWELL_UPDATE_DIRECT=1`` forces the Popen path.
    2. A tightly-scoped sudoers drop-in (``deploy/sudoers/orwell-update``) granting the
       ``orwell`` user NOPASSWD for EXACTLY ``orwell-update.sh`` and nothing else; the detached
       run is then ``sudo -n bash <script>``. Enabled by ``ORWELL_UPDATE_SUDO=1``.

  Either way the button never silently 403s on ``systemctl``: it prefers the flag trigger when
  present, falls back to the (optionally sudo-wrapped) detached Popen otherwise.
"""

import asyncio
import datetime as _dt
import logging
import os
import shlex
import subprocess
from datetime import timezone

from fastapi import APIRouter, Request

from core.admin_guard import guard_root_op
from core.ops_watcher import inactive_reason, watcher_active
from src.auth_helpers import effective_user

logger = logging.getLogger(__name__)

# The FIXED updater path — overridable ONLY so tests/dev don't touch a real host path. There is
# never any user input interpolated into the command; this is the single, complete argv source.
DEFAULT_UPDATE_SCRIPT = "/opt/orwell/deploy/orwell-update.sh"
DEFAULT_UPDATE_LOG = "/opt/orwell/data/update.log"


def _update_script() -> str:
    return os.environ.get("ORWELL_UPDATE_SCRIPT") or DEFAULT_UPDATE_SCRIPT


def _update_log() -> str:
    return os.environ.get("ORWELL_UPDATE_LOG") or DEFAULT_UPDATE_LOG


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


# The root-side path unit that consumes the flag and runs the updater AS ROOT (deploy/systemd).
# Its presence is the TRUE signal that dropping a flag will actually do something. Overridable
# for tests via ORWELL_UPDATE_WATCHER_UNIT.
_WATCHER_UNIT = "/etc/systemd/system/orwell-ops-update.path"


def _watcher_unit_path() -> str:
    return os.environ.get("ORWELL_UPDATE_WATCHER_UNIT") or _WATCHER_UNIT


def _watcher_installed() -> bool:
    """True when the root-side G19b path unit is installed AND ACTIVE — the privileged door that
    actually runs the updater with root (the unit watches ``data/ops/update-requested`` and runs as
    root). A stopped/disabled unit would leave the flag unread, so it must not count."""
    return watcher_active(_watcher_unit_path())


def _flag_trigger_installed() -> bool:
    """True ONLY when the root-side G19b path watcher unit is actually installed — the lone
    privileged door that genuinely runs the updater as root.

    A bare ``data/ops/`` dir is NOT proof: the installer creates ``data/ops/`` on EVERY box, so the
    old ``or os.path.isdir(_ops_dir())`` clause made a missing watcher look 'installed' — the flag
    got written, nothing consumed it, and the update silently no-opped. Requiring the unit lets a
    watcher-less box fall through to a genuine privileged path (sudo/direct) or FAIL LOUDLY."""
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
    """Drop the existence-only flag the root ``orwell-ops-update.path`` unit watches (G19b).
    The content is ignored by the unit; we stamp a timestamp for human log readability only.
    Ensures ``data/ops/`` exists first (so a box that just gained the units works)."""
    _ensure_ops_dir()
    ops = _ops_dir()
    flag = os.path.join(ops, "update-requested")
    with open(flag, "w", encoding="utf-8") as fh:
        fh.write(_dt.datetime.now(timezone.utc).isoformat() + "\n")
    return {"started": True, "via": "flag-trigger", "log": "ops-update.log"}


def _update_active(max_age_s: int = 900) -> bool:
    """True when an update is running or deferred right now: ``data/ops/update-status.json`` says
    ``running`` AND was written within ``max_age_s`` (the deferral loop refreshes it every poll, an update at
    each phase), so a crashed run's stale ``running`` never blocks queuing a new one."""
    import json as _json
    try:
        with open(os.path.join(_ops_dir(), "update-status.json"), "r", encoding="utf-8") as fh:
            st = _json.load(fh)
        if st.get("running") is not True:
            return False
        ts = _dt.datetime.strptime(str(st.get("ts")), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        return (_dt.datetime.now(timezone.utc) - ts).total_seconds() < max_age_s
    except Exception:
        return False


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
    """Launch the FIXED updater detached (its own session/process group) so restarting
    ``orwell-frontend`` mid-run does not kill it, streaming output to the update log. Returns
    immediately — the caller never awaits completion (the restart would kill the request)."""
    script = _update_script()
    log_path = _update_log()
    # No user input in argv. Optionally wrap in `sudo -n` so the sandboxed FE user can clear the
    # privileged steps via the tightly-scoped sudoers drop-in (deploy/sudoers/orwell-update).
    argv = ["bash", script]
    if os.environ.get("ORWELL_UPDATE_SUDO", "").lower() in ("1", "true", "yes"):
        argv = ["sudo", "-n", *argv]
    try:
        os.makedirs(os.path.dirname(log_path) or ".", exist_ok=True)
    except OSError:
        pass
    # Append (never truncate) so the run history survives across updates; the status-page log
    # viewer can tail it. "ab" + a timestamped header per run keeps runs separable.
    log = open(log_path, "ab")
    log.write(
        (f"\n== orwell update · {_dt.datetime.now(timezone.utc).isoformat()} "
         f"({' '.join(shlex.quote(a) for a in argv)}) ==\n").encode("utf-8"))
    log.flush()
    # start_new_session=True detaches into a new session+process-group: when the script
    # `systemctl restart orwell-frontend` kills THIS process, the updater is not in our group
    # and keeps running (it is reparented to init). Fire-and-forget: we do not wait().
    subprocess.Popen(  # noqa: S603 — fixed argv, no shell, no user input
        argv, cwd=os.path.dirname(script) or None,
        stdout=log, stderr=log, stdin=subprocess.DEVNULL,
        start_new_session=True, close_fds=True)
    # The child holds its own dup'd fd; close our handle so we don't leak it across the restart.
    log.close()
    return {"started": True, "via": "detached", "log": os.path.basename(log_path)}


def setup_admin_update_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin", tags=["admin_update"])

    @router.post("/update")
    async def admin_update(request: Request):
        """Run the deploy updater (pull → rebuild engine → refresh FE deps → restart both).

        Admin-only. Returns ``{started: true}`` IMMEDIATELY — never blocks on completion (the
        update restarts this process). Prefers the privilege-safe root flag trigger when
        installed; otherwise launches the fixed script detached (optionally sudo-wrapped)."""
        await guard_root_op(request)
        who = None
        try:
            who = effective_user(request)
        except Exception:
            pass
        force_direct = os.environ.get("ORWELL_UPDATE_DIRECT", "").lower() in ("1", "true", "yes")
        has_sudo = os.environ.get("ORWELL_UPDATE_SUDO", "").lower() in ("1", "true", "yes")

        # PRIVILEGE FIX (ops-run lane): prefer the root-side flag watcher (G19b) — the only door
        # that runs the updater with root. Create data/ops/ first so a box that just gained the
        # watcher units works on the very next click.
        flag_error = None   # set when the watcher is active but the trigger flag could not be written
        # off the event loop: the watcher probe shells out to `systemctl is-active` (up to 5 s)
        if await asyncio.to_thread(_flag_trigger_installed) and not force_direct:
            _ensure_ops_dir()
            logger.info("[update] admin '%s' triggered update via the root flag trigger (G19b)", who)
            try:
                return _trigger_via_flag()
            except OSError as e:
                logger.warning("[update] flag trigger failed (%s); evaluating detached run", e)
                flag_error = e

        # The detached Popen runs the updater as the NON-ROOT FE user — which EPERMs partway through
        # (git pull into /opt, write /etc/systemd, systemctl restart). Only take it with a genuine
        # privileged path: ORWELL_UPDATE_SUDO=1 (the scoped sudoers drop-in) or an explicit
        # ORWELL_UPDATE_DIRECT=1 override (dev / a box the operator vouches is root-able).
        if has_sudo or force_direct:
            logger.info("[update] admin '%s' triggered update via detached run of %s",
                        who, _update_script())
            return _run_detached()

        # FAIL LOUDLY — no privileged path. Surface it through the ops-progress channel the status
        # page polls so the operator sees the error instead of a silent "started" that never runs.
        if flag_error is not None:
            reason = (f"cannot run the update — the watcher is running but the trigger flag could not be written "
                      f"({flag_error}); nothing was queued.")
        else:
            reason = inactive_reason(_watcher_unit_path(), "run the update")
        reason += " Sudo is not enabled either (ORWELL_UPDATE_SUDO=1)."
        logger.error("[update] admin '%s' could NOT start the update: %s", who, reason)
        _write_failed_status("update", reason)
        return {"started": False, "via": "none", "error": reason}

    @router.post("/update/force")
    async def admin_update_force(request: Request):
        """ORW-206: skip the live-game wait. The root updater defers while a player is mid-game; this drops
        the separate existence-only ``update-force-requested`` flag, which the waiting updater consumes and
        then proceeds. If NO update is active it also queues one; if one is already running or deferred it
        writes ONLY the force flag (a second ``update-requested`` would survive the unit's ExecStartPre and run
        a second update + restart). Admin-only, same guard as /update."""
        await guard_root_op(request)
        if not (await asyncio.to_thread(_flag_trigger_installed)):
            return {"started": False, "via": "none",
                    "error": inactive_reason(_watcher_unit_path(), "force the update")}
        _ensure_ops_dir()
        force_flag = os.path.join(_ops_dir(), "update-force-requested")
        try:
            with open(force_flag, "w", encoding="utf-8") as fh:
                fh.write(_dt.datetime.now(timezone.utc).isoformat() + "\n")
        except OSError as e:
            return {"started": False, "via": "none", "error": f"could not write the force flag: {e}"}
        if await asyncio.to_thread(_update_active):
            return {"started": True, "via": "force-flag", "forced": True, "queued": False}
        try:
            return {**_trigger_via_flag(), "forced": True, "queued": True}
        except OSError as e:
            try:
                os.remove(force_flag)       # don't leave a stale force flag for some later update
            except OSError:
                pass
            return {"started": False, "via": "none", "error": f"could not queue the update: {e}"}

    return router
