"""ORW-406: a tiny "is a turn in flight?" signal for the updater.

The updater (root) reads <data>/turns-in-flight just before it restarts the services, and waits (bounded)
until it says 0. The file holds one integer: the number of chat streams currently registered. It carries no
game or chat content. Best-effort: a write failure never affects a turn.
"""
import math
import os
import threading
import time
from typing import Any, Dict, Optional

from src.constants import DATA_DIR

SIGNAL_NAME = "turns-in-flight"
HOLD_NAME = "turns-hold"            # ORW-461: written by the updater (root) to say "hold new turns": `until=<epoch seconds>`
HOLD_RETRY_AFTER_MS = 2000
_HOLD_MAX_AHEAD_S = 3600            # a hold stamped further ahead than this is not believed (a corrupt or hostile file must not wedge the game)
_ADMIT_TTL_S = 15.0                 # an admitted turn that never registers (it failed first) stops counting after this long


def signal_path() -> str:
    return os.path.join(os.environ.get("ORWELL_INFLIGHT_DIR") or DATA_DIR, SIGNAL_NAME)


def hold_path() -> str:
    # The ROOT-owned run dir (the updater's own, like deploy/orwell-live-game.sh ORWELL_RUN_DIR), never the data dir: the service user may read the hold but can never write or
    # swap it, so root never writes through a path that user controls.
    return os.path.join(os.environ.get("ORWELL_RUN_DIR") or "/run/orwell", HOLD_NAME)


def hold_until(now: Optional[float] = None) -> Optional[float]:
    """The epoch second the updater's hold lasts until, or None when no hold is in force (no file, unreadable, malformed, expired, or stamped absurdly far ahead)."""
    now = time.time() if now is None else now
    try:
        with open(hold_path(), "r", encoding="utf-8") as fh:
            text = fh.read(256)
    except OSError:
        return None
    for line in text.splitlines():
        if line.startswith("until="):
            try:
                until = float(line[6:].strip())
            except ValueError:
                return None
            if not math.isfinite(until) or until <= now or until - now > _HOLD_MAX_AHEAD_S:
                return None
            return until
    return None


# A turn that passed the hold check is counted as in flight from that moment until its stream registers in the registry below, so there is no gap in which the updater reads
# "0 in flight" while a turn it did not refuse is about to start. Keyed by the turn's clientMsgId.
_admitting: Dict[str, float] = {}
_registry_size = 0
_lock = threading.Lock()


def _total_locked() -> int:
    now = time.monotonic()
    for k in [k for k, t in _admitting.items() if now - t > _ADMIT_TTL_S]:
        del _admitting[k]
    return _registry_size + len(_admitting)


def admit_begin(token: Optional[str]) -> None:
    with _lock:
        _admitting[token or f"anon-{time.monotonic()}"] = time.monotonic()
        total = _total_locked()
    publish_inflight(total)


def admit_end(token: Optional[str]) -> None:
    if not token:
        return
    with _lock:
        had = _admitting.pop(token, None) is not None
        total = _total_locked()
    if had:
        publish_inflight(total)


def check_and_admit(token: Optional[str]) -> Optional[float]:
    """The one admission gate for a new chat turn. Returns the epoch second the hold lasts until when the turn must be REFUSED (nothing has started, so the client may re-send it
    unchanged), or None when it is admitted (and now counted as in flight until its stream registers)."""
    until = hold_until()
    if until is not None:
        return until
    admit_begin(token)
    return None


def publish_inflight(count: int) -> None:
    path = signal_path()
    tmp = f"{path}.tmp{os.getpid()}"
    try:
        with open(tmp, "w") as fh:
            fh.write(f"{int(count)}\n")
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


class InflightRegistry(dict):
    """A dict of active streams that republishes its size whenever a stream is added or removed."""

    def _publish(self) -> None:
        global _registry_size
        with _lock:
            _registry_size = len(self)
            total = _total_locked()
        publish_inflight(total)

    def __setitem__(self, key: Any, value: Any) -> None:
        super().__setitem__(key, value)
        self._publish()

    def __delitem__(self, key: Any) -> None:
        super().__delitem__(key)
        self._publish()

    def pop(self, *args: Any) -> Any:
        had = args[0] in self
        out = super().pop(*args)
        if had:
            self._publish()
        return out

    def clear(self) -> None:
        super().clear()
        self._publish()
