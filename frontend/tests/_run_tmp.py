"""the suite's private run folder (`orwell-run-*`): removal on exit (also on SIGTERM), an opt-out to keep it for debugging, and a guarded sweep of the ones a killed run left behind.

One full run used to strand 2 to 5 GB when it was killed (a timeout, a dropped session, an OOM kill skips atexit), and a dozen agents running tests filled the temp volume. Roles only."""
import os
import shutil
import signal
import stat
import time
from typing import Callable, Optional

PREFIX = "orwell-run-"
KEEP_ENV = "ORWELL_KEEP_TEST_TMP"   # set to 1 to keep this run's folder (debugging)
STALE_AFTER_S = 20 * 60


def keep_requested(env=None) -> bool:
    return (env or os.environ).get(KEEP_ENV, "").strip().lower() in ("1", "true", "yes", "on")


def _in_use(path: str, proc: str = "/proc") -> bool:
    """True when a live process of ANY user we can inspect has `path` as its TMPDIR or sits inside it (cwd). Unreadable entries are skipped (they are other users' processes)."""
    real = os.path.realpath(path)
    try:
        pids = [p for p in os.listdir(proc) if p.isdigit()]
    except OSError:
        return False
    for pid in pids:
        try:
            with open(f"{proc}/{pid}/environ", "rb") as fh:
                for kv in fh.read().split(b"\0"):
                    if kv.startswith((b"TMPDIR=", b"TMP=", b"TEMP=")) and os.path.realpath(kv.split(b"=", 1)[1].decode("utf-8", "replace")) == real:
                        return True
        except OSError:
            pass
        try:
            cwd = os.path.realpath(f"{proc}/{pid}/cwd")
            if cwd == real or cwd.startswith(real + os.sep):
                return True
        except OSError:
            pass
    return False


def sweep_stale(base: str, *, now: Optional[float] = None, max_age_s: float = STALE_AFTER_S, uid: Optional[int] = None,
                keep: Optional[str] = None, in_use: Callable[[str], bool] = _in_use) -> "list[str]":
    """Remove `orwell-run-*` folders directly under `base` that are: a real directory (never a symlink), owned by `uid` (default: this user), older than `max_age_s`, not `keep` (this run's own),
    and not in use by a live process. Returns what was removed. Never raises."""
    removed: "list[str]" = []
    now = time.time() if now is None else now
    uid = os.getuid() if uid is None else uid
    try:
        names = os.listdir(base)
    except OSError:
        return removed
    for name in names:
        if not name.startswith(PREFIX):
            continue
        path = os.path.join(base, name)
        try:
            st = os.lstat(path)
            if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or now - st.st_mtime <= max_age_s:
                continue
            if keep and os.path.realpath(path) == os.path.realpath(keep):
                continue
            if in_use(path):
                continue
            shutil.rmtree(path, ignore_errors=True)
            removed.append(path)
        except OSError:
            continue
    return removed


def remove_run_folder(path: str, env=None) -> bool:
    """Remove this process's own run folder unless the keep switch is set. Returns True when removed."""
    if keep_requested(env):
        return False
    shutil.rmtree(path, ignore_errors=True)
    return True


def install_sigterm_cleanup(path: str) -> None:
    """A SIGTERM (`timeout`, a killed session) ends a Python process WITHOUT running atexit: clean the folder first, then die as before. Only replaces the default handler."""
    try:
        if signal.getsignal(signal.SIGTERM) is not signal.SIG_DFL:
            return

        def _on_term(signum, _frame):
            remove_run_folder(path)
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            os.kill(os.getpid(), signal.SIGTERM)

        signal.signal(signal.SIGTERM, _on_term)
    except (ValueError, OSError):  # not the main thread / no signals: atexit still applies
        pass


def start_heartbeat(path: str, every_s: float = 300.0) -> None:
    """A live run keeps its folder's modification time fresh (a daemon thread), so another run's sweep never mistakes a long quiet stretch for a stranded folder."""
    import threading

    def _beat():
        while True:
            time.sleep(every_s)
            try:
                os.utime(path, None)
            except OSError:
                return

    threading.Thread(target=_beat, name="orwell-run-tmp-heartbeat", daemon=True).start()
