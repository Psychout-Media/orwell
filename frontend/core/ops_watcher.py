"""Is the root-side ops watcher really RUNNING, not merely installed?

The ops routes hand a request to a root ``orwell-ops-*.path`` unit by dropping an existence-only flag.
The unit FILE being present proves nothing about whether anything will consume that flag: a ``.path``
unit that is stopped, disabled or failed leaves the flag sitting on disk, and the route used to report
"started" for a request nothing was watching (the flag then fires whenever the unit next starts — for a
reset, at a time nobody chose). So a route may only report success when the unit is installed AND
``systemctl is-active`` says ``active``.
"""

import os
import subprocess


def _systemctl_is_active(unit: str) -> bool:
    """Read-only ``systemctl is-active <unit>`` → True iff it prints ``active``. Never mutates; any
    error (no systemctl, no systemd, timeout) is False — "cannot confirm" must not read as "running"."""
    try:
        proc = subprocess.run(  # noqa: S603,S607 — fixed argv, no shell, unit name from a fixed constant
            ["systemctl", "is-active", unit],
            capture_output=True, text=True, timeout=5, check=False)
        return proc.stdout.strip() == "active"
    except Exception:
        return False


def watcher_active(unit_file: str) -> bool:
    """True iff ``unit_file`` (a ``/etc/systemd/system/<name>.path`` path) exists and that unit is active."""
    if not os.path.isfile(unit_file):
        return False
    return _systemctl_is_active(os.path.basename(unit_file))


def inactive_reason(unit_file: str, action: str) -> str:
    """The operator-facing reason a flag-triggered action cannot be started right now."""
    unit = os.path.basename(unit_file)
    if not os.path.isfile(unit_file):
        return (f"no privileged path to {action} — the root-side flag watcher ({unit}) is not installed.")
    return (f"cannot {action} — the root-side flag watcher ({unit}) is installed but NOT active, so a "
            f"request would sit unprocessed. On the host run: systemctl enable --now {unit} "
            "(or re-run the deploy updater), then retry. Nothing was queued.")
